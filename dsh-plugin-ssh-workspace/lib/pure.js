/**
 * 纯函数层：不碰网络、不碰进程，只做数据变换。
 *
 * 这一层是插件最该被信任的部分——宿主半与客户端半都用它算数，也是自检脚本
 * 唯一能离线跑的部分。凡是"算错了不会抛错、只是显示错"的逻辑都放这里，
 * 并用断言钉住。
 */
import { DEFAULT_TIMEOUT_MS, FIND_PRINTF, HOST_KEY_POLICY, MAX_HISTORY, MAX_TIMEOUT_MS } from './constants.js';

/** 对象判空（排除 null 与数组）。 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 把任意值收敛成非空字符串；不可用时返回 null。 */
function textOf(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** 把任意值收敛成有限数；不可用时返回 null。 */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * 归一化主机列表。
 *
 * 坏行**丢弃而不是报错**：一份被手改花的配置不该让整个面板打不开。
 * `id` 缺失时按索引补一个稳定的——界面与工具都靠 id 引用主机，
 * id 漂移会让"刚编辑的那台"在下次读取时变成另一台。
 */
export function normaliseHosts(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (let index = 0; index < list.length; index += 1) {
    const raw = list[index];
    if (!isObject(raw)) continue;
    const host = textOf(raw.host);
    if (host === null) continue;
    out.push({
      id: textOf(raw.id) ?? `host-${index}`,
      label: textOf(raw.label) ?? '',
      host,
      port: Math.min(65535, Math.max(1, Math.floor(numberOr(raw.port, 22)))),
      user: textOf(raw.user) ?? '',
      identityFile: textOf(raw.identityFile) ?? '',
      sshOptions: Array.isArray(raw.sshOptions)
        ? raw.sshOptions.filter((item) => textOf(item) !== null).map((item) => item.trim())
        : [],
      note: textOf(raw.note) ?? '',
      tags: Array.isArray(raw.tags)
        ? raw.tags.filter((item) => textOf(item) !== null).map((item) => item.trim())
        : [],
    });
  }
  return out;
}

/** 展示名：`label` 优先，否则 `user@host`，再否则 `host`。 */
export function hostDisplayName(host) {
  if (!isObject(host)) return '';
  const label = textOf(host.label);
  if (label !== null) return label;
  const user = textOf(host.user);
  const at = textOf(host.host);
  if (user !== null && at !== null) return `${user}@${at}`;
  return at ?? '';
}

/** 连接摘要：`user@host:port`。端口为 22 时省略，减少噪音。 */
export function hostSummary(host) {
  if (!isObject(host)) return '';
  const at = textOf(host.host) ?? '';
  const user = textOf(host.user);
  const left = user === null ? at : `${user}@${at}`;
  const port = numberOr(host.port, 22);
  return port === 22 ? left : `${left}:${port}`;
}

/** `user@host`，缺省用户时退回 `host`。 */
function destinationOf(host) {
  const at = textOf(host?.host) ?? '';
  const user = textOf(host?.user);
  return user === null ? at : `${user}@${at}`;
}

/**
 * POSIX shell 的单引号转义。
 *
 * 单引号内无法再出现单引号，标准做法是 `'\''`：结束当前引号、写一个转义单引号、
 * 重新开引号。远端路径是用户输入的，不转义就等于把命令注入敞开着。
 */
export function escapeRemotePath(path) {
  const text = typeof path === 'string' ? path : '';
  if (text === '') return "''";
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * 组装 `ssh` 的 argv。
 *
 * 顺序是硬约束：所有 `-o` / `-p` / `-i` 必须在 `user@host` **之前**，
 * 放在目标之后会被 ssh 当成要执行的命令的一部分。
 *
 * `BatchMode=yes` 是为了**永不弹交互**：没有可用密钥时直接失败并带错误返回，
 * 而不是挂在那儿等一个永远不会来的口令（那会让宿主线程卡死）。
 */
export function buildSshArgs(input) {
  const host = isObject(input?.host) ? input.host : {};
  const args = [
    '-o', 'BatchMode=yes',
    // 连接阶段的超时单独设，且通常远小于整条命令的超时——连不上要快速失败。
    '-o', `ConnectTimeout=${Math.max(1, Math.round(numberOr(input?.connectTimeoutMs, 10000) / 1000))}`,
    '-o', `StrictHostKeyChecking=${HOST_KEY_POLICY}`,
  ];
  const port = Math.floor(numberOr(host.port, 22));
  if (port !== 22) args.push('-p', String(port));
  const identityFile = textOf(host.identityFile);
  if (identityFile !== null) args.push('-i', identityFile);
  const extra = Array.isArray(host.sshOptions) ? host.sshOptions : [];
  for (const option of extra) {
    const text = textOf(option);
    if (text === null) continue;
    args.push('-o', text);
  }
  args.push(destinationOf(host));
  const remote = typeof input?.remoteCommand === 'string' ? input.remoteCommand : '';
  // 空命令是合法的（探通用 `true`），但绝不为空字符串占位——ssh 会读 stdin。
  if (remote !== '') args.push(remote);
  return args;
}

/** 列目录的远端命令。 */
export function findCommand(directory) {
  // 格式串走 constants 里的 FIND_PRINTF，不在这里重写一份——那份旁边写着
  // "路径必须放最前"的理由，复制一份就等于把理由丢在半路上。
  return `find ${escapeRemotePath(directory)} -maxdepth 1 -mindepth 1 -printf '${FIND_PRINTF}'`;
}

/** 读文件的远端命令。 */
export function catCommand(path) {
  return `cat -- ${escapeRemotePath(path)}`;
}

/**
 * 解析 `find -printf` 的输出。
 *
 * 取每条记录的**最后三个**字段当类型/大小/时间，其余拼回路径——这样路径里
 * 含制表符也不会把分隔打乱（见 constants.js 里 FIND_PRINTF 的说明）。
 * 解析失败的条目**跳过而不是抛错**：一两个特殊文件不该让整个列表消失。
 */
export function parseFindOutput(text, limit) {
  if (typeof text !== 'string' || text === '') return [];
  const cap = numberOr(limit, 200);
  const out = [];
  for (const record of text.split('\0')) {
    if (record === '') continue;
    const parts = record.split('\t');
    if (parts.length < 4) continue;
    const path = parts.slice(0, parts.length - 3).join('\t');
    const kind = parts[parts.length - 3];
    const size = Number(parts[parts.length - 2]);
    const mtime = Number(parts[parts.length - 1]) * 1000;
    if (path === '') continue;
    out.push({
      path,
      name: path.slice(path.lastIndexOf('/') + 1),
      // GNU find 的 %y：d=目录 f=普通文件 b/c=设备 l=链接 p=FIFO s=socket -=未知
      directory: kind === 'd',
      kind,
      size: Number.isFinite(size) ? size : 0,
      mtimeMs: Number.isFinite(mtime) ? mtime : 0,
    });
    if (out.length >= cap) break;
  }
  // 目录在前、名称升序：固定顺序才不会每次刷新都重排。
  out.sort((left, right) => {
    if (left.directory !== right.directory) return left.directory ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
  return out;
}

/** 归一化执行记录：容忍 `undefined`，新的在前，最多 `limit` 条。 */
export function normaliseHistory(list, limit) {
  if (!Array.isArray(list)) return [];
  const cap = numberOr(limit, MAX_HISTORY);
  const out = [];
  for (const raw of list) {
    if (!isObject(raw)) continue;
    const command = textOf(raw.command);
    if (command === null) continue;
    out.push({
      id: textOf(raw.id) ?? `run-${out.length}`,
      hostId: textOf(raw.hostId) ?? '',
      command,
      at: numberOr(raw.at, 0),
      ok: raw.ok === true,
      exitCode: typeof raw.exitCode === 'number' && Number.isFinite(raw.exitCode) ? raw.exitCode : null,
      durationMs: typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs) ? raw.durationMs : null,
      truncated: raw.truncated === true,
      bytes: numberOr(raw.bytes, 0),
      detail: textOf(raw.detail) ?? '',
    });
  }
  out.sort((left, right) => right.at - left.at);
  return out.slice(0, Math.max(1, cap));
}

/** 人类可读时长。 */
export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

/** 千分位。 */
export function formatExact(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '0';
  return String(Math.floor(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 把路径切成目录与末段；相对路径与尾部分隔符都不炸。 */
export function splitPath(path) {
  const text = typeof path === 'string' ? path : '';
  const slash = text.lastIndexOf('/');
  if (slash < 0) return { dir: '.', entry: text };
  if (slash === 0) return { dir: '/', entry: text.slice(1) };
  return { dir: text.slice(0, slash), entry: text.slice(slash + 1) };
}

/**
 * 收敛超时值。
 *
 * 上界是硬闸：一个"想等更久"的配置不该能把宿主挂住。0 或负数回落到默认值，
 * 因为 execFile 的 timeout=0 表示"不超时"——那正好是最危险的那个值。
 */
export function resolveTimeout(value) {
  const raw = numberOr(value, DEFAULT_TIMEOUT_MS);
  if (raw <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.floor(raw), MAX_TIMEOUT_MS);
}
