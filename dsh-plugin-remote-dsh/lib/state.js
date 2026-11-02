/**
 * 插件自己的小型状态文件。
 *
 * 只保存“用户添加的远端”和“插件启动过的远端实例”；SSH 配置里的主机每次从
 * `~/.ssh/config` 重新读取，不复制进来，避免配置漂移。
 *
 * 路径：`$DSH_HOME/remote-dsh/state.json`。写入使用临时文件 + rename，避免
 * DSH 进程在写一半时退出留下损坏 JSON。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function emptyState() {
  return {
    settings: { mode: 'npx', spec: 'latest', registry: 'https://registry.npmmirror.com' },
    manualHosts: [],
    instances: {},
  };
}

export function defaultStatePath(home) {
  return path.join(home, 'remote-dsh', 'state.json');
}

export function createStateStore(file) {
  let state = emptyState();
  let loaded = false;
  let queue = Promise.resolve();

  async function load() {
    if (loaded) return state;
    try {
      const text = await readFile(file, 'utf8');
      const parsed = JSON.parse(text);
      state = {
        settings: {
          mode: parsed?.settings?.mode === 'global' ? 'global' : 'npx',
          spec: typeof parsed?.settings?.spec === 'string' && parsed.settings.spec !== ''
            ? parsed.settings.spec
            : 'latest',
          registry: typeof parsed?.settings?.registry === 'string'
            ? parsed.settings.registry
            : 'https://registry.npmmirror.com',
        },
        manualHosts: Array.isArray(parsed?.manualHosts) ? parsed.manualHosts.filter(isObject) : [],
        instances: isObject(parsed?.instances) ? parsed.instances : {},
      };
    } catch {
      state = emptyState();
    }
    loaded = true;
    return state;
  }

  function get() {
    return state;
  }

  async function save() {
    queue = queue.then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const temporary = file + '.tmp-' + process.pid;
      await writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
      await rename(temporary, file);
    });
    return queue;
  }

  async function update(mutate) {
    await load();
    const result = mutate(state);
    await save();
    return result;
  }

  return { load, get, save, update };
}

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 生成一个稳定的手动主机 id。 */
export function manualHostId(seed) {
  const base = String(seed ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return 'manual-' + (base === '' ? Date.now().toString(36) : base + '-' + Date.now().toString(36));
}

/** 校验并规范化用户提交的手动主机。 */
export function normalizeManualHost(input) {
  if (!isObject(input)) return { error: 'invalid host' };
  const sshTarget = typeof input.sshTarget === 'string' ? input.sshTarget.trim() : '';
  if (sshTarget === '' || /[\s\r\n]/.test(sshTarget)) return { error: 'invalid ssh target' };
  const label = typeof input.label === 'string' && input.label.trim() !== '' ? input.label.trim() : sshTarget;
  const port = input.port === undefined || input.port === null || input.port === ''
    ? undefined
    : Number(input.port);
  if (port !== undefined && (!Number.isInteger(port) || port <= 0 || port > 65535)) {
    return { error: 'invalid ssh port' };
  }
  const remotePort = input.remotePort === undefined || input.remotePort === null || input.remotePort === ''
    ? undefined
    : Number(input.remotePort);
  if (remotePort !== undefined && (!Number.isInteger(remotePort) || remotePort < 1024 || remotePort > 65535)) {
    return { error: 'invalid remote port' };
  }
  return {
    host: {
      id: typeof input.id === 'string' && input.id !== '' ? input.id : undefined,
      label,
      sshTarget,
      port,
      identityFile: typeof input.identityFile === 'string' && input.identityFile.trim() !== '' ? input.identityFile.trim() : undefined,
      proxyJump: typeof input.proxyJump === 'string' && input.proxyJump.trim() !== '' ? input.proxyJump.trim() : undefined,
      remotePort,
    },
  };
}

/** 合并 ssh-config 主机与手动主机；手动主机同 id 时覆盖。 */
export function mergeHosts(sshHosts, manualHosts) {
  const byId = new Map();
  for (const host of sshHosts) {
    if (isObject(host) && typeof host.id === 'string') byId.set(host.id, host);
  }
  for (const host of manualHosts) {
    if (isObject(host) && typeof host.id === 'string') byId.set(host.id, host);
  }
  return [...byId.values()].sort((left, right) => String(left.label).localeCompare(String(right.label)));
}
