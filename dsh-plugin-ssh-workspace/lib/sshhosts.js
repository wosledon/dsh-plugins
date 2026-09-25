/**
 * 读取本机的 `~/.ssh/config` 并解析成主机列表。
 *
 * 这是**唯一的主机来源**：不在插件里再维护一份主机配置。理由见 lib/sshconfig.js
 * ——重复一份权威数据只会产生"面板里写的和 ssh 实际连的不一致"。
 *
 * 每次调用都重新读文件：ssh config 很小（几 KB），而用户随时可能改它；
 * 缓存带来的"改了配置但插件还显示旧的"比一次文件读取代价大得多。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { configHostsToHosts, parseSshConfig } from './sshconfig.js';

/** 默认配置文件路径：`~/.ssh/config`。 */
export function defaultConfigPath() {
  try {
    return path.join(os.homedir(), '.ssh', 'config');
  } catch {
    return '';
  }
}

/**
 * 读并解析。
 *
 * 文件不存在是**正常情况**（很多人只用命令行 `ssh user@host`，从不写 config），
 * 所以返回空列表 + 一条说明，而不是抛错——抛错会让"还没配 ssh config"看起来
 * 像插件坏了。
 */
export function readSshHosts(configPath) {
  const file = typeof configPath === 'string' && configPath !== '' ? configPath : defaultConfigPath();
  if (file === '') return { hosts: [], warnings: ['无法确定 ~/.ssh/config 的位置。'], path: '' };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (code === 'ENOENT') {
      return {
        hosts: [],
        warnings: [`没有找到 ${file}。可以在里面用 Host 声明常用主机，本插件会自动读出来。`],
        path: file,
      };
    }
    return {
      hosts: [],
      warnings: [`读取 ${file} 失败：${error instanceof Error ? error.message : String(error)}`],
      path: file,
    };
  }
  const parsed = parseSshConfig(text);
  return { hosts: configHostsToHosts(parsed.hosts), warnings: parsed.warnings, path: file };
}
