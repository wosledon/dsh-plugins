/**
 * 远端执行层：通过系统 `ssh` 二进制跑命令。
 *
 * **为什么用 `spawn('ssh')` 而不是 npm 的 `ssh2`**：
 *   1. 不引入第三方依赖——安装一个带原生模块的包会显著提高装不进 profile 的
 *      风险，而这个插件已经因为别的依赖问题付出过代价。
 *   2. 复用用户机器上已有的 `~/.ssh`、`ssh-agent`、`known_hosts`，密钥永不进
 *      本插件的任何存储。这与"只支持私钥认证"的选择直接对应。
 *   3. `ssh` 自己处理密钥交换与加密，本插件不需要（也不该）实现 SSH 协议。
 *
 * **为什么用 `spawn` 而不是 `execFile`**：`execFile` 的 `maxBuffer` 一旦超限会
 * 直接以 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` 失败，于是"输出很长"会被报成
 * "执行失败"，界面也无法告诉用户是被截断了。这里自己累积并按字节封顶，
 * 超限只置 `truncated`，命令本身的结果仍然如实返回。
 */
import { spawn } from 'node:child_process';
import { MAX_OUTPUT_BYTES } from './constants.js';

/**
 * 累积一个流，按字节封顶，并记录是否被截断。
 *
 * 故意**只有一个** `data` 监听：早先的实现里同时挂了 `collect()` 的和另一个
 * `on('data')`，同一块 chunk 会被两个 handler 各收一份——虽然结果恰好对，
 * 但这类重复监听迟早会变成"输出被写了两遍"的真实 bug。
 */
function collect(stream) {
  const state = { text: '', total: 0, truncated: false };
  stream.on('data', (chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    state.total += buffer.length;
    if (state.total > MAX_OUTPUT_BYTES) {
      state.truncated = true;
      return;
    }
    state.text += buffer.toString('utf8');
  });
  return state;
}

/**
 * 跑一条远端命令。
 *
 * 永远 resolve，不 reject：调用方（工具、界面）需要的是结果对象，
 * 让它去 catch 只会把"连不上"这种正常结果写成未处理异常。
 */
export function runSsh(args, options) {
  const timeoutMs = Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 30_000;
  const started = Date.now();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('ssh', args, {
        // Windows 下不弹控制台窗口；否则每次执行都会闪一下黑框。
        windowsHide: true,
        // 不覆盖 env：SSH_AUTH_SOCK 等必须原样透传，否则 agent 转发失效。
      });
    } catch (error) {
      resolve({
        ok: false,
        stdout: '',
        stderr: '',
        exitCode: null,
        durationMs: Date.now() - started,
        bytes: 0,
        truncated: false,
        detail: `无法启动 ssh：${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }

    const out = collect(child.stdout);
    const err = collect(child.stderr);
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve({
        stdout: out.text,
        stderr: err.text,
        exitCode: null,
        durationMs: Date.now() - started,
        bytes: out.total + err.total,
        truncated: out.truncated || err.truncated,
        ...result,
      });
    };

    child.on('error', (error) => {
      // ENOENT = 这台机器上根本没装 ssh 客户端。这条必须原样带到界面上，
      // 否则用户看到的是"执行失败"而完全没有方向。
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      finish({
        ok: false,
        detail: code === 'ENOENT'
          ? '找不到 ssh 客户端：请先安装 OpenSSH 客户端并确认它在 PATH 中'
          : `ssh 启动失败：${error instanceof Error ? error.message : String(error)}`,
      });
    });

    child.on('close', (code, signal) => {
      finish({
        ok: code === 0,
        exitCode: typeof code === 'number' ? code : null,
        detail: signal !== null && signal !== undefined ? `远端进程被信号 ${String(signal)} 终止` : '',
      });
    });

    // 超时**必须**杀进程：否则一个挂住的 ssh 会一直占着宿主，且持有它的那一轮
    // 流程的 finally 永远到不了（这个坑在另一个插件上真实发生过）。
    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已经退了 */ }
      finish({
        ok: false,
        detail: `执行超过 ${Math.round(timeoutMs / 1000)}s，已中止`,
      });
    }, timeoutMs);
    if (typeof timer?.unref === 'function') timer.unref();
  });
}

/**
 * 探通一台主机。
 *
 * 调用方传入的 `args` **不能**包含远端命令——这里会自己追加 `true`。
 * 混用会让 `[...args, 'true']` 变成"先跑你给的命令再跑 true"，探通就失去
 * "最快失败"的意义了。
 */
export function probeHost(args, timeoutMs) {
  return runSsh([...args, 'true'], { timeoutMs });
}

/** 检查 ssh 客户端是否可用（跑 `ssh -V`，零副作用、零网络）。 */
export function checkSshClient() {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('ssh', ['-V'], { windowsHide: true });
    } catch {
      resolve({ available: false, version: '', detail: '无法启动 ssh' });
      return;
    }
    let text = '';
    const onData = (chunk) => { text += chunk.toString('utf8'); };
    // `ssh -V` 往 **stderr** 写版本号（ssh 的历史行为）。只读 stdout 会永远拿到
    // 空字符串，然后把"可用"误判成"不可用"。
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', () => resolve({ available: false, version: '', detail: '找不到 ssh 客户端' }));
    child.on('close', (code) => resolve({
      available: code === 0,
      version: text.trim().split('\n')[0] ?? '',
      detail: code === 0 ? '' : 'ssh -V 返回非零',
    }));
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已经退了 */ }
    }, 5000);
    if (typeof timer?.unref === 'function') timer.unref();
  });
}
