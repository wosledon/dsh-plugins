/**
 * 宿主半的**文件日志**：绕开配置写入链路。
 *
 * 为什么需要它（真机教训）：
 *
 * 前面几轮的诊断（`lastBoot` / `heartbeat` / `trace`）都写在 `config.internal`
 * 里，走的是 `configEditor.edit()` 那条通道。而真机上失败**恰恰就在那条通道**——
 * `trace` 永远停在 `startup:refreshed`，之后连"绕过队列"的诊断写入也不落盘。
 *
 * 于是形成了一个自指的困局：**用一个坏掉的机制去观测这个机制坏在哪。** 每加一层
 * 观测就多一层同通道的失败，几轮下来只证明"写入不成功"，却看不到写入为什么不成功。
 *
 * 这个模块用 `appendFileSync` 直接写文件：同步、不经过 Cordis、不经过
 * configEditor、不经过 settings。它几乎不可能失败（失败也会抛在调用点而不是被吞掉），
 * 因此能把"配置写入卡在哪一步"之外的事实固定下来。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 日志路径：`~/.dsh/token-usage-trace.log`。
 *
 * 刻意放在 profile 的 `node_modules` 之外——插件目录可能在重装时被整体替换，
 * 而这份日志正是用来诊断重装/重启前后发生了什么的，不能被一起清掉。
 */
const LOG_PATH = path.join(os.homedir(), '.dsh', 'token-usage-trace.log');

/** 单次运行内避免日志无限增长：超过这个字节数就不再写。 */
const MAX_BYTES = 512 * 1024;

let disabled = false;

/**
 * 同步追加一行。
 *
 * **绝不抛错**：诊断代码把宿主搞崩是最糟的结果——那会让"插件坏了"变成"应用起不来"，
 * 而这两件事的排查代价差一个数量级。失败就静默停用自己。
 *
 * @param {string} text
 * @returns {boolean} 是否写入成功
 */
export function traceLine(text) {
  if (disabled) return false;
  try {
    try {
      if (fs.statSync(LOG_PATH).size > MAX_BYTES) {
        fs.writeFileSync(LOG_PATH, '');
      }
    } catch {
      /* 文件还不存在——正常 */
    }
    fs.appendFileSync(LOG_PATH, new Date().toISOString() + '  ' + String(text) + '\n');
    return true;
  } catch {
    // 例如目录不可写。停用自己，而不是每次调用都重试并可能抛错。
    disabled = true;
    return false;
  }
}

/** 供诊断消息里显示"日志写到哪了"。 */
export function tracePath() {
  return LOG_PATH;
}
