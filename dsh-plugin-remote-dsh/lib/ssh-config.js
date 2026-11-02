/**
 * SSH 主机发现与远端命令执行。
 *
 * 主机列表直接来自 `~/.ssh/config`：先解析 `Host` 与 `Include` 得到别名，再对每个
 * 别名执行 `ssh -G <alias>`，由 OpenSSH 自己展开 HostName / User / Port /
 * IdentityFile / ProxyJump。这样不重复实现 ssh_config 的匹配语义，也不会把
 * `Host *` 的默认值误当成一台主机。
 *
 * 远端命令统一走 `ssh <target> -- bash -lc <script>`，脚本由本模块生成；动态值
 * 只来自端口、版本 spec、日志路径，全部经过 POSIX 单引号转义。
 */

import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/** POSIX 单引号转义；结果可以安全嵌进 sh 脚本。 */
export function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

export function expandHome(value, home = homedir()) {
  if (typeof value !== 'string' || value === '') return value;
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(home, value.slice(2));
  return value;
}

/** 把含 `*`/`?` 的 Include 路径展开成文件列表。 */
async function expandInclude(pattern, baseDir, home) {
  const expanded = expandHome(pattern, home);
  const absolute = path.isAbsolute(expanded) ? expanded : path.join(baseDir, expanded);
  if (!/[*?]/.test(absolute)) return [absolute];
  const dir = path.dirname(absolute);
  const base = path.basename(absolute);
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const source = base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  const matcher = new RegExp('^' + source + '$');
  return names.filter((name) => matcher.test(name)).map((name) => path.join(dir, name)).sort();
}

/**
 * 读取 ssh 配置文件，返回 `Host` 别名（不含通配模式）。
 *
 * @param {object} options
 * @param {string} options.file      主配置路径。
 * @param {string} [options.home]    家目录，用于 `~` 展开。
 * @returns {Promise<{aliases: string[], errors: string[]}>}
 */
export async function readSshConfigAliases(options) {
  const file = options.file;
  const home = options.home ?? homedir();
  const aliases = new Set();
  const errors = [];
  const visited = new Set();

  async function visit(current, depth) {
    if (depth > 8 || visited.has(current)) return;
    visited.add(current);
    let text;
    try {
      text = await readFile(current, 'utf8');
    } catch (error) {
      if (current === file) errors.push(`cannot read ${current}: ${error.message}`);
      return;
    }
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line === '' || line.startsWith('#')) continue;
      const match = /^([A-Za-z]+)\s+(.*)$/.exec(line);
      if (match === null) continue;
      const keyword = match[1].toLowerCase();
      if (keyword === 'host') {
        for (const token of match[2].split(/\s+/)) {
          if (token === '' || /[*?!]/.test(token)) continue;
          aliases.add(token);
        }
        continue;
      }
      if (keyword === 'include') {
        for (const token of match[2].split(/\s+/)) {
          if (token === '') continue;
          for (const included of await expandInclude(token, path.dirname(current), home)) {
            if (existsSync(included)) await visit(included, depth + 1);
          }
        }
      }
    }
  }

  await visit(file, 0);
  return { aliases: [...aliases].sort(), errors };
}

/** 解析 `ssh -G` 的输出。 */
export function parseSshG(text) {
  const result = { hostname: '', user: '', port: 22, identityFile: '', proxyJump: '' };
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    const space = line.indexOf(' ');
    if (space === -1) continue;
    const key = line.slice(0, space).toLowerCase();
    const value = line.slice(space + 1).trim();
    if (key === 'hostname' && value !== '') result.hostname = value;
    else if (key === 'user' && value !== '') result.user = value;
    else if (key === 'port' && /^\d+$/.test(value)) result.port = Number(value);
    else if (key === 'proxyjump' && value !== '' && value !== 'none') result.proxyJump = value;
    else if (key === 'identityfile' && value !== '' && result.identityFile === '') result.identityFile = value;
  }
  return result;
}

/** 构造 `ssh` 的选项与目标；`source: 'ssh-config'` 时只传别名，其余走 ssh 配置。 */
export function buildSshPrefixArgs(host) {
  const target = typeof host.sshTarget === 'string' ? host.sshTarget.trim() : '';
  if (target === '') throw new Error('host has no ssh target');
  const prefix = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
  if (host.source !== 'ssh-config') {
    if (Number.isInteger(host.port) && host.port > 0 && host.port !== 22) prefix.push('-p', String(host.port));
    if (typeof host.identityFile === 'string' && host.identityFile !== '') prefix.push('-i', expandHome(host.identityFile));
    if (typeof host.proxyJump === 'string' && host.proxyJump !== '') prefix.push('-J', host.proxyJump);
  }
  return { prefix, target };
}

/** 完整的 `ssh` 参数（选项在前，目标在后）。 */
export function buildSshArgs(host) {
  const { prefix, target } = buildSshPrefixArgs(host);
  return [...prefix, target];
}

/** 远端命令：`ssh <options> <target> -- bash -lc '<script>'`。 */
export function buildRemoteArgs(host, script, shell = 'bash') {
  const { prefix, target } = buildSshPrefixArgs(host);
  // OpenSSH joins the remote command argv with spaces. Without quoting the whole
  // script, `bash -lc` receives only its first token as the command and the rest
  // as positional arguments (npm then prints its usage instead of running).
  return [...prefix, target, '--', shell, '-lc', shellQuote(script)];
}

/** 本地转发参数：把本地 `<port>` 转发到远端 loopback 的同一个端口。 */
export function buildTunnelArgs(host, port) {
  const { prefix, target } = buildSshPrefixArgs(host);
  return [...prefix, '-N', '-L', `${port}:127.0.0.1:${port}`, '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', target];
}

/** 从 dsh web 的日志里取出带 token 的 URL。 */
export function extractWebUrl(text) {
  const match = /dsh web:\s*(https?:\/\/\S+)/i.exec(String(text));
  if (match === null) return '';
  return match[1].replace(/[),.;]+$/, '');
}

/** 解析探活脚本的 key=value 输出。 */
export function parseProbe(text) {
  const result = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    result[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return result;
}

/** 版本比较：只比较数字段，返回 -1/0/1；用于判断是否需要升级。 */
export function compareVersions(left, right) {
  const parse = (value) => String(value)
    .replace(/^v/, '')
    .split('-')[0]
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
