/**
 * 远端 DSH 实例管理。
 *
 * 两种官方启动方式共用同一条 `dsh web` 路径：
 *   - npx（默认）：`npx -y @deepseek-ai/dsh@latest web --host 127.0.0.1 --port P --no-open`
 *   - global：远端已有全局 `dsh` 时，`dsh web --host 127.0.0.1 --port P --no-open`
 *
 * 远端只绑 loopback；本地用 `ssh -N -L P:127.0.0.1:P` 建同端口隧道，再从
 * `dsh web: <url>` 日志里取 token，改写成 `http://127.0.0.1:P/?token=…` 交给侧栏。
 *
 * 进程生命周期：远端用 `setsid`/`nohup` 后台化，存 PID 与日志路径；停止时先杀
 * 进程组（setsid 情况下），再清理本地隧道。状态只保存在 `remote-dsh/state.json`。
 */

import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import net from 'node:net';

import {
  buildRemoteArgs,
  buildTunnelArgs,
  compareVersions,
  extractWebUrl,
  parseProbe,
  parseSshG,
  readSshConfigAliases,
  shellQuote,
} from './ssh-config.js';
import { isObject, manualHostId, mergeHosts, normalizeManualHost } from './state.js';

const execFileAsync = promisify(execFileCallback);

const DEFAULT_PORT = 3080;
const START_TIMEOUT_MS = 180_000;
const INSTALL_TIMEOUT_MS = 600_000;
const PROBE_TIMEOUT_MS = 20_000;
const MAX_OUTPUT = 8 * 1024 * 1024;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validatePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('port must be an integer between 1024 and 65535');
  }
  return port;
}

function validateSpec(value) {
  const spec = typeof value === 'string' && value.trim() !== '' ? value.trim() : 'latest';
  if (!/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(spec)) {
    throw new Error('invalid dsh version spec');
  }
  return spec;
}

function validateRegistry(value) {
  if (value === undefined || value === null || value === '') return '';
  const registry = String(value).trim();
  if (!/^https?:\/\/\S+$/.test(registry) || /\s/.test(registry)) {
    throw new Error('invalid npm registry URL');
  }
  return registry.replace(/\/+$/, '');
}

function sshFailure(error) {
  const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
  const stdout = typeof error?.stdout === 'string' ? error.stdout.trim() : '';
  const detail = stderr !== '' ? stderr : stdout !== '' ? stdout : error?.message ?? String(error);
  return detail;
}

export function createRemoteManager(options) {
  const stateStore = options.stateStore;
  const sshConfigPath = options.sshConfigPath;
  const home = options.home;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const execFile = options.execFile ?? execFileAsync;
  const spawnImpl = options.spawn ?? spawn;
  const isLocalPortFree = typeof options.localPortFree === 'function' ? options.localPortFree : localPortFree;

  /** @type {Map<string, import('node:child_process').ChildProcess>} */
  const tunnels = new Map();

  async function run(host, script, timeoutMs = PROBE_TIMEOUT_MS, shell = 'bash') {
    const args = buildRemoteArgs(host, script, shell);
    try {
      const result = await execFile('ssh', args, {
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT,
        windowsHide: true,
      });
      return String(result.stdout ?? '');
    } catch (error) {
      const detail = sshFailure(error);
      // 远端没有 bash 时，脚本尚未执行，换 sh 重试是安全的。
      if (shell === 'bash' && /bash: (command )?not found/i.test(detail)) {
        return run(host, script, timeoutMs, 'sh');
      }
      throw new Error(detail);
    }
  }

  async function loadHosts() {
    const state = await stateStore.load();
    const found = await readSshConfigAliases({ file: sshConfigPath, home });
    const sshHosts = [];
    const configErrors = [...found.errors];
    for (const alias of found.aliases) {
      let effective = { hostname: '', user: '', port: 22, identityFile: '', proxyJump: '' };
      let error;
      try {
        const result = await execFile('ssh', ['-G', alias], { timeout: 5000, windowsHide: true });
        effective = parseSshG(String(result.stdout ?? ''));
      } catch (failure) {
        error = sshFailure(failure);
        configErrors.push(`${alias}: ${error}`);
      }
      sshHosts.push({
        id: alias,
        label: alias,
        source: 'ssh-config',
        sshTarget: alias,
        hostname: effective.hostname || alias,
        user: effective.user || '',
        port: effective.port || 22,
        identityFile: effective.identityFile || '',
        proxyJump: effective.proxyJump || '',
        ...(error === undefined ? {} : { error }),
      });
    }

    const manualHosts = state.manualHosts.map((host) => ({ ...host, source: 'manual' }));
    const hosts = mergeHosts(sshHosts, manualHosts).map((host) => {
      const instance = state.instances[host.id];
      return {
        ...host,
        defaultPort: host.remotePort ?? instance?.remotePort ?? DEFAULT_PORT,
        ...(isObject(instance) ? { instance } : {}),
      };
    });
    return { hosts, configErrors, settings: state.settings };
  }

  async function findHost(id) {
    const { hosts } = await loadHosts();
    const host = hosts.find((candidate) => candidate.id === id);
    if (host === undefined) throw new Error(`unknown host: ${id}`);
    return host;
  }

  async function probe(host) {
    const script = [
      'echo "os=$(uname -s 2>/dev/null || echo unknown)"',
      'echo "node=$(command -v node 2>/dev/null || true)"',
      'echo "npm=$(command -v npm 2>/dev/null || true)"',
      'echo "npx=$(command -v npx 2>/dev/null || true)"',
      'echo "nodeVersion=$(node -v 2>/dev/null || true)"',
      'PREFIX=$(npm prefix -g 2>/dev/null || true)',
      'echo "npmPrefix=$PREFIX"',
      'echo "npmRegistry=$(npm config get registry 2>/dev/null || true)"',
      'DSH=$(command -v dsh 2>/dev/null || true)',
      'if [ -z "$DSH" ] && [ -n "$PREFIX" ] && [ -x "$PREFIX/bin/dsh" ]; then DSH="$PREFIX/bin/dsh"; fi',
      'if [ -z "$DSH" ] && [ -x "$HOME/.npm-global/bin/dsh" ]; then DSH="$HOME/.npm-global/bin/dsh"; fi',
      'echo "dsh=$DSH"',
      'if [ -n "$DSH" ]; then echo "version=$("$DSH" --version 2>/dev/null || true)"; else echo "version="; fi',
    ].join('\n');
    const text = await run(host, script, PROBE_TIMEOUT_MS);
    const data = parseProbe(text);
    return {
      platform: data.os ?? '',
      node: data.node ?? '',
      npm: data.npm ?? '',
      npx: data.npx ?? '',
      dsh: data.dsh ?? '',
      version: data.version ?? '',
      npmPrefix: data.npmPrefix ?? '',
      npmRegistry: data.npmRegistry ?? '',
      canInstall: (data.npm ?? '') !== '',
      canNpx: (data.npx ?? '') !== '',
      installed: (data.dsh ?? '') !== '',
    };
  }

  async function install(host, specInput, registryInput) {
    const spec = validateSpec(specInput);
    const registry = validateRegistry(registryInput);
    const pkg = '@deepseek-ai/dsh@' + spec;
    const registryFlag = registry === '' ? '' : ' --registry ' + shellQuote(registry);
    const script = [
      'set -e',
      'if ! command -v npm >/dev/null 2>&1; then echo "npm not found" >&2; exit 127; fi',
      'PREFIX="$HOME/.npm-global"',
      'mkdir -p "$PREFIX"',
      'npm install -g --prefix "$PREFIX" ' + shellQuote(pkg) + registryFlag
        + ' --fetch-retries=0 --fetch-timeout=30000 --no-audit --no-fund',
      'DSH="$PREFIX/bin/dsh"',
      'if [ ! -x "$DSH" ]; then DSH=$(command -v dsh 2>/dev/null || true); fi',
      'echo "npmPrefix=$PREFIX"',
      'echo "dsh=$DSH"',
      'if [ -n "$DSH" ]; then echo "version=$("$DSH" --version 2>/dev/null || true)"; else echo "version="; fi',
    ].join('\n');
    const output = await run(host, script, INSTALL_TIMEOUT_MS);
    const data = parseProbe(output);
    return {
      spec,
      registry,
      version: data.version ?? '',
      dsh: data.dsh ?? '',
      npmPrefix: data.npmPrefix ?? '',
      output: output.length > 8000 ? output.slice(-8000) : output,
    };
  }

  async function localPortFree(port) {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close(() => resolve(true));
      });
      server.listen(port, '127.0.0.1');
    });
  }

  async function waitForLocalPort(port) {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const ok = await new Promise((resolve) => {
        const socket = net.connect({ port, host: '127.0.0.1' });
        socket.once('connect', () => {
          socket.destroy();
          resolve(true);
        });
        socket.once('error', () => {
          socket.destroy();
          resolve(false);
        });
      });
      if (ok) return true;
      await delay(250);
    }
    return false;
  }

  async function startTunnel(host, port) {
    const existing = tunnels.get(host.id);
    if (existing !== undefined && existing.exitCode === null) return;
    if (!(await isLocalPortFree(port))) {
      throw new Error(`local port ${port} is already in use`);
    }
    const child = spawnImpl('ssh', buildTunnelArgs(host, port), {
      stdio: 'ignore',
      windowsHide: true,
    });
    tunnels.set(host.id, child);
    child.once('exit', () => {
      if (tunnels.get(host.id) === child) tunnels.delete(host.id);
    });
    child.once('error', (error) => {
      log('remote-dsh: local tunnel failed', error);
    });
    const ready = await waitForLocalPort(port);
    if (!ready) {
      child.kill('SIGTERM');
      tunnels.delete(host.id);
      throw new Error(`SSH tunnel to ${host.label} did not open on local port ${port}`);
    }
  }

  async function pidAlive(host, pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      const text = await run(host, `kill -0 ${pid} 2>/dev/null && echo yes || echo no`, 10_000);
      return text.trim().endsWith('yes');
    } catch {
      return false;
    }
  }

  async function readLog(host, logPath, lines = 200) {
    const safeLines = Math.max(1, Math.min(2000, Math.floor(Number(lines) || 200)));
    return run(host, `tail -n ${safeLines} ${shellQuote(logPath)}`, 20_000);
  }

  /**
   * 查询远端端口占用情况。`ss`/`lsof` 只能看到当前用户自己的进程；
   * 看不到 PID 时仍报告 inUse，只是不能自动结束它。
   */
  async function remotePortState(host, port) {
    const script = [
      'PORT=' + String(port),
      'if command -v ss >/dev/null 2>&1; then',
      '  LINE=$(ss -ltnp "sport = :$PORT" 2>/dev/null | tail -n +2 | head -1)',
      '  if [ -n "$LINE" ]; then',
      '    echo "inUse=yes"',
      '    echo "pid=$(printf "%s" "$LINE" | sed -n "s/.*pid=\\([0-9][0-9]*\\).*/\\1/p")"',
      '  else echo "inUse=no"; fi',
      'elif command -v lsof >/dev/null 2>&1; then',
      '  LINE=$(lsof -nP -iTCP:$PORT -sTCP:LISTEN 2>/dev/null | tail -n +2 | head -1)',
      '  if [ -n "$LINE" ]; then echo "inUse=yes"; echo "pid=$(printf "%s" "$LINE" | awk "{print \\$2}")"; else echo "inUse=no"; fi',
      'else',
      '  echo "inUse=unknown"',
      'fi',
    ].join('\n');
    let data;
    try {
      data = parseProbe(await run(host, script, 15_000));
    } catch {
      return { inUse: false, unknown: true, pid: undefined, command: '', isDsh: false };
    }
    const inUse = data.inUse === 'yes';
    const pidNumber = Number(data.pid);
    const pid = Number.isInteger(pidNumber) && pidNumber > 0 ? pidNumber : undefined;
    let command = '';
    if (pid !== undefined) {
      try {
        command = (await run(host, `ps -p ${pid} -o args=`, 10_000)).trim();
      } catch {
        command = '';
      }
    }
    const isDsh = /(^|[/\s])dsh(\s|$)/.test(command) && /\bweb\b/.test(command);
    return { inUse, unknown: data.inUse === 'unknown', pid, command, isDsh };
  }

  async function terminatePid(host, pid) {
    await run(host, `kill -TERM ${pid} 2>/dev/null || true`, 10_000);
    await delay(1000);
    try {
      await run(host, `kill -KILL ${pid} 2>/dev/null || true`, 10_000);
    } catch {
      /* already gone */
    }
    await delay(300);
  }

  async function killRemotePid(host, pid) {
    if (!Number.isInteger(pid) || pid <= 0) return;
    const script = [
      'PID=' + String(pid),
      'if kill -0 "$PID" 2>/dev/null; then',
      '  kill -TERM -"$PID" 2>/dev/null || kill -TERM "$PID" 2>/dev/null || true',
      '  sleep 1',
      '  kill -KILL -"$PID" 2>/dev/null || kill -KILL "$PID" 2>/dev/null || true',
      'fi',
      'echo stopped',
    ].join('\n');
    try {
      await run(host, script, 20_000);
    } catch (error) {
      log('remote-dsh: remote stop failed', error);
    }
  }

  /**
   * Keep remote and local on the same port so the DSH token URL is opened under
   * the authority the remote server bound. If only the local side is occupied
   * (another remote's tunnel, for example), move both sides to the next free pair.
   */
  async function chooseStartPort(host, requested) {
    const requestedRemote = await remotePortState(host, requested);
    if (requestedRemote.inUse) return { port: requested, remoteState: requestedRemote };
    if (await isLocalPortFree(requested)) {
      return { port: requested, remoteState: requestedRemote };
    }
    for (let candidate = requested + 1; candidate <= requested + 20 && candidate <= 65535; candidate += 1) {
      if (!(await isLocalPortFree(candidate))) continue;
      const remote = await remotePortState(host, candidate);
      if (!remote.inUse) return { port: candidate, remoteState: remote };
    }
    const error = new Error(`local port ${requested} is already in use and no free local/remote port was found`);
    error.code = 'PORT_IN_USE';
    throw error;
  }

  async function start(host, options = {}) {
    const requestedPort = validatePort(options.port ?? host.defaultPort ?? DEFAULT_PORT);
    let port = requestedPort;
    const state = await stateStore.load();
    const mode = options.mode === 'global' || options.mode === 'npx' ? options.mode : state.settings.mode;
    const spec = validateSpec(options.spec ?? state.settings.spec);
    const registry = validateRegistry(options.registry ?? state.settings.registry);
    const previous = state.instances[host.id];

    if (isObject(previous) && Number.isInteger(previous.remotePort) && await pidAlive(host, previous.pid)) {
      const previousPort = validatePort(previous.remotePort);
      await startTunnel(host, previousPort);
      return { instance: previous, reused: true, requestedPort, portAdjusted: previousPort !== requestedPort };
    }

    const info = await probe(host);
    const selection = await chooseStartPort(host, port);
    port = selection.port;
    let command;
    if (mode === 'npx') {
      if (!info.npx) throw new Error('npx not found on the remote host; install Node/npm or switch to global mode');
      if (!info.npm) throw new Error('npm not found on the remote host; npx needs npm');
      const pkg = '@deepseek-ai/dsh@' + spec;
      const registryFlag = registry === '' ? '' : ' --registry ' + shellQuote(registry);
      // 先确认 registry 上真的有这个包，避免 npx 在错误的 .npmrc 上重试几分钟。
      await run(host, [
        shellQuote(info.npm), 'view', shellQuote(pkg), 'version' + registryFlag,
        '--fetch-retries=0', '--fetch-timeout=15000',
      ].join(' '), 30_000);
      const registryEnv = registry === '' ? '' : 'env npm_config_registry=' + shellQuote(registry) + ' ';
      command = registryEnv + [shellQuote(info.npx), '-y', shellQuote(pkg), 'web',
        '--host', '127.0.0.1', '--port', String(port), '--no-open'].join(' ');
    } else {
      const dshPath = info.dsh || (info.npmPrefix ? info.npmPrefix.replace(/\/+$/, '') + '/bin/dsh' : '');
      if (dshPath === '') throw new Error('dsh not found on the remote host; install it in global mode first');
      command = [shellQuote(dshPath), 'web', '--host', '127.0.0.1', '--port', String(port), '--no-open'].join(' ');
    }

    const remotePort = selection.remoteState ?? await remotePortState(host, port);
    if (remotePort.inUse) {
      if (options.force === true && remotePort.isDsh && Number.isInteger(remotePort.pid)) {
        await terminatePid(host, remotePort.pid);
        const after = await remotePortState(host, port);
        if (after.inUse) {
          const error = new Error(`remote port ${port} is still in use after stopping pid ${remotePort.pid}`);
          error.code = 'PORT_IN_USE';
          error.details = after;
          throw error;
        }
      } else {
        const detail = remotePort.pid === undefined
          ? 'another process'
          : `pid ${remotePort.pid}${remotePort.command === '' ? '' : ': ' + remotePort.command}`;
        const error = new Error(`remote port ${port} is already in use (${detail})`);
        error.code = 'PORT_IN_USE';
        error.details = remotePort;
        throw error;
      }
    }

    const logPath = `$HOME/.dsh-remote/web-${port}.log`;
    const script = [
      'set -e',
      'mkdir -p "$HOME/.dsh-remote"',
      'LOG="' + logPath + '"',
      ': > "$LOG"',
      'if command -v setsid >/dev/null 2>&1; then',
      `  setsid ${command} >> "$LOG" 2>&1 < /dev/null &`,
      'else',
      `  nohup ${command} >> "$LOG" 2>&1 < /dev/null &`,
      'fi',
      'echo "pid=$!"',
      'printf "log=%s\\n" "$LOG"',
    ].join('\n');

    const started = await run(host, script, 30_000);
    const data = parseProbe(started);
    const pid = Number(data.pid);
    const remoteLog = data.log || logPath.replace('$HOME', '~');
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('could not determine the remote dsh web pid');

    try {
      let url = '';
      let tail = '';
      const deadline = Date.now() + START_TIMEOUT_MS;
      while (Date.now() < deadline) {
        try {
          tail = await readLog(host, remoteLog, 300);
        } catch (error) {
          tail = String(error);
        }
        url = extractWebUrl(tail);
        if (url !== '') break;
        if (!(await pidAlive(host, pid))) break;
        await delay(1000);
      }
      if (url === '') {
        throw new Error(`dsh web did not print a URL; see ${remoteLog}\n${tail.slice(-1500)}`);
      }

      let localUrl;
      try {
        const parsed = new URL(url);
        const token = parsed.searchParams.get('token');
        localUrl = 'http://127.0.0.1:' + port + '/' + (token === null ? '' : '?token=' + encodeURIComponent(token));
      } catch {
        localUrl = url;
      }

      await startTunnel(host, port);
      const instance = {
        remotePort: port,
        localPort: port,
        pid,
        url: localUrl,
        remoteUrl: url,
        logPath: remoteLog,
        mode,
        spec,
        registry,
        startedAt: Date.now(),
      };
      await stateStore.update((current) => {
        current.instances[host.id] = instance;
      });
      return { instance, reused: false, requestedPort, portAdjusted: port !== requestedPort };
    } catch (error) {
      // 启动失败时不要让远端留下一个无人管理的 dsh web。
      const tunnel = tunnels.get(host.id);
      if (tunnel !== undefined) {
        try { tunnel.kill('SIGTERM'); } catch { /* ignore */ }
        tunnels.delete(host.id);
      }
      await killRemotePid(host, pid);
      throw error;
    }
  }

  async function open(host) {
    const state = await stateStore.load();
    const instance = state.instances[host.id];
    if (!isObject(instance)) throw new Error('this remote is not running; start it first');
    if (!(await pidAlive(host, instance.pid))) {
      await stateStore.update((current) => {
        delete current.instances[host.id];
      });
      throw new Error('the remote dsh web process is no longer running; start it again');
    }
    await startTunnel(host, instance.localPort ?? instance.remotePort);
    return { url: instance.url };
  }

  async function stop(host) {
    const state = await stateStore.load();
    const instance = state.instances[host.id];
    const tunnel = tunnels.get(host.id);
    if (tunnel !== undefined) {
      try {
        tunnel.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      tunnels.delete(host.id);
    }
    if (isObject(instance) && Number.isInteger(instance.pid) && instance.pid > 0) {
      await killRemotePid(host, instance.pid);
    }
    if (isObject(instance)) {
      await stateStore.update((current) => {
        delete current.instances[host.id];
      });
    }
    return { stopped: true };
  }

  async function logs(host, lines) {
    const state = await stateStore.load();
    const instance = state.instances[host.id];
    if (!isObject(instance) || typeof instance.logPath !== 'string') {
      throw new Error('no log for this remote yet');
    }
    return { log: await readLog(host, instance.logPath, lines) };
  }

  async function addManualHost(input) {
    const normalized = normalizeManualHost(input);
    if (normalized.error !== undefined) throw new Error(normalized.error);
    const host = { ...normalized.host, id: normalized.host.id ?? manualHostId(normalized.host.label || normalized.host.sshTarget) };
    await stateStore.update((current) => {
      const index = current.manualHosts.findIndex((candidate) => candidate.id === host.id);
      if (index === -1) current.manualHosts.push(host);
      else current.manualHosts[index] = { ...current.manualHosts[index], ...host };
    });
    return host;
  }

  async function removeManualHost(id) {
    const { hosts } = await loadHosts();
    const host = hosts.find((candidate) => candidate.id === id);
    if (host === undefined) throw new Error(`unknown host: ${id}`);
    if (host.source !== 'manual') throw new Error('ssh-config hosts cannot be removed here');
    await stop(host);
    await stateStore.update((current) => {
      current.manualHosts = current.manualHosts.filter((candidate) => candidate.id !== id);
    });
    return { removed: true };
  }

  async function setSettings(patch) {
    const mode = patch?.mode === 'global' || patch?.mode === 'npx' ? patch.mode : undefined;
    const spec = patch?.spec === undefined ? undefined : validateSpec(patch.spec);
    const registry = patch?.registry === undefined ? undefined : validateRegistry(patch.registry);
    await stateStore.update((current) => {
      if (mode !== undefined) current.settings.mode = mode;
      if (spec !== undefined) current.settings.spec = spec;
      if (registry !== undefined) current.settings.registry = registry;
    });
    return (await stateStore.load()).settings;
  }

  function dispose() {
    for (const child of tunnels.values()) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
    tunnels.clear();
  }

  return {
    loadHosts,
    findHost,
    probe,
    install,
    start,
    open,
    stop,
    logs,
    addManualHost,
    removeManualHost,
    setSettings,
    dispose,
  };
}
