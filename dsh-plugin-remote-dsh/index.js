/**
 * 宿主侧：给「远程 DSH 主机」菜单提供本地 API。
 *
 * 读取 `~/.ssh/config` 与插件自己的状态文件不需要后台轮询；所有 SSH 操作都由
 * 设置页上的按钮触发。状态文件在 `$DSH_HOME/remote-dsh/state.json`，只保存手动
 * 添加的主机和启动过的实例，不复制 ssh 配置。
 */

import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

import { createRemoteManager } from './lib/remote.js';
import { createApi } from './lib/server.js';
import { createStateStore } from './lib/state.js';

export function apply(ctx) {
  const home = process.env.DSH_HOME && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : path.join(homedir(), '.dsh');
  const stateStore = createStateStore(path.join(home, 'remote-dsh', 'state.json'));
  const token = randomBytes(24).toString('hex');

  const manager = createRemoteManager({
    stateStore,
    sshConfigPath: path.join(homedir(), '.ssh', 'config'),
    home: homedir(),
    log(message, error) {
      try {
        const logger = ctx.logger;
        if (logger !== undefined && logger !== null && typeof logger.warn === 'function') {
          logger.warn(message, error);
        }
      } catch {
        /* keep quiet when the logger is unavailable */
      }
    },
  });

  ctx.effect(() => () => manager.dispose(), 'remote-dsh: stop local tunnels');

  const api = createApi({ manager, token });
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'prefix',
        path: api.prefix,
        handler: api.handler,
      }),
      'remote-dsh: api route',
    );
  });
}
