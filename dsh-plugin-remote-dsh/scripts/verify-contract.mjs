/**
 * 远程 DSH 插件的自检（零第三方依赖）。
 *
 * 覆盖：
 *   - `~/.ssh/config` 解析、`ssh -G` 输出解析、ssh 参数构造；
 *   - `dsh web` 日志 URL 提取、探活输出解析、手动主机规范化/合并；
 *   - 状态文件读写；
 *   - 本地 API 的 token 鉴权与路由；
 *   - 浏览器半的样式契约。
 *
 * 不连接真实 SSH 主机；实时安装/启动由用户在设置页触发。
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import {
  buildRemoteArgs,
  buildSshArgs,
  buildTunnelArgs,
  extractWebUrl,
  parseProbe,
  parseSshG,
  readSshConfigAliases,
  shellQuote,
} from '../lib/ssh-config.js';
import { createStateStore, manualHostId, mergeHosts, normalizeManualHost } from '../lib/state.js';
import { createRemoteManager } from '../lib/remote.js';
import { createApi } from '../lib/server.js';

let checks = 0;
function ok(value, message) {
  assert.ok(value, message);
  checks += 1;
}
function equal(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks += 1;
}

/* ------------------------------------------------------------------ */
/* 1. ssh 配置与参数                                                   */
/* ------------------------------------------------------------------ */

equal(shellQuote("a'b"), "'a'\\''b'", 'single quotes are escaped for POSIX sh');
equal(shellQuote('plain'), "'plain'", 'plain values are single quoted');

const temp = await mkdtemp(path.join(tmpdir(), 'remote-dsh-'));
try {
  const sshDir = path.join(temp, '.ssh');
  await mkdir(path.join(sshDir, 'conf.d'), { recursive: true });
  await writeFile(path.join(sshDir, 'config'), [
    'Host alpha beta',
    '  HostName alpha.example',
    '  User alice',
    '  Port 2222',
    '',
    'Host *',
    '  User root',
    '',
    'Include conf.d/*',
    '',
  ].join('\n'), 'utf8');
  await writeFile(path.join(sshDir, 'conf.d', 'extra'), 'Host gamma\n  HostName gamma.example\n', 'utf8');

  const found = await readSshConfigAliases({ file: path.join(sshDir, 'config'), home: temp });
  equal(found.aliases, ['alpha', 'beta', 'gamma'], 'Host aliases are read, wildcards skipped, Include expanded');
  equal(found.errors, [], 'no ssh config read errors');

  const effective = parseSshG([
    'hostname alpha.example',
    'user alice',
    'port 2222',
    'identityfile ~/.ssh/id_ed25519',
    'proxyjump jump.example',
  ].join('\n'));
  equal(effective.hostname, 'alpha.example', 'ssh -G hostname is parsed');
  equal(effective.port, 2222, 'ssh -G port is parsed as a number');
  equal(effective.identityFile, '~/.ssh/id_ed25519', 'ssh -G identityfile is parsed');
  equal(effective.proxyJump, 'jump.example', 'ssh -G proxyjump is parsed');

  const aliasHost = { source: 'ssh-config', sshTarget: 'alpha' };
  equal(buildSshArgs(aliasHost), ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'alpha'], 'ssh-config hosts only pass the alias and non-interactive options');
  const manualHost = { sshTarget: 'deploy@example.com', port: 2200, identityFile: '~/.ssh/key', proxyJump: 'jump' };
  const manualArgs = buildSshArgs(manualHost);
  ok(manualArgs.includes('-p') && manualArgs.includes('2200'), 'manual hosts keep the SSH port');
  ok(manualArgs.includes('-i') && manualArgs.includes('-J'), 'manual hosts keep identity and jump options');
  equal(manualArgs[manualArgs.length - 1], 'deploy@example.com', 'the target is the final argument');

  const remoteArgs = buildRemoteArgs(aliasHost, 'echo hi');
  equal(remoteArgs.slice(-4), ['--', 'bash', '-lc', "'echo hi'"], 'remote scripts are shell-quoted as one bash -lc argument');
  const tunnelArgs = buildTunnelArgs(aliasHost, 3080);
  ok(tunnelArgs.includes('-N') && tunnelArgs.includes('-L'), 'the tunnel uses -N and -L');
  ok(tunnelArgs.includes('3080:127.0.0.1:3080'), 'the tunnel forwards the same port');
  equal(tunnelArgs[tunnelArgs.length - 1], 'alpha', 'the tunnel target is last');
  const jumpTunnel = buildTunnelArgs(manualHost, 3080);
  ok(jumpTunnel.includes('-J') && jumpTunnel.includes('jump'), 'manual-host tunnels keep their ProxyJump');
} finally {
  await rm(temp, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
/* 2. 日志、探活与主机模型                                             */
/* ------------------------------------------------------------------ */

equal(
  extractWebUrl('noise\ndsh web: http://127.0.0.1:3080/?token=abc123\nmore'),
  'http://127.0.0.1:3080/?token=abc123',
  'the tokenized dsh web URL is extracted from the log',
);
equal(extractWebUrl('dsh web: https://example.com/x'), 'https://example.com/x', 'https URLs are accepted');
equal(extractWebUrl('nothing'), '', 'a log without the URL yields an empty string');

const probe = parseProbe('os=Linux\nnode=/usr/bin/node\nnpx=\ndsh=/usr/local/bin/dsh\nversion=0.2.1-rc.5\n');
equal(probe.os, 'Linux', 'probe platform is parsed');
equal(probe.dsh, '/usr/local/bin/dsh', 'probe dsh path is parsed');
equal(probe.version, '0.2.1-rc.5', 'probe version is parsed');

const valid = normalizeManualHost({
  label: 'Build box',
  sshTarget: 'deploy@10.0.0.5',
  port: 2200,
  identityFile: ' ~/.ssh/deploy ',
  proxyJump: 'jump',
  remotePort: 3080,
});
ok(valid.error === undefined, 'a valid manual host is accepted');
equal(valid.host.label, 'Build box', 'manual label is trimmed');
equal(valid.host.port, 2200, 'manual SSH port is numeric');
equal(valid.host.remotePort, 3080, 'manual remote port is numeric');
ok(valid.host.identityFile === '~/.ssh/deploy', 'manual identity file is trimmed');
equal(normalizeManualHost({ sshTarget: 'bad host' }).error, 'invalid ssh target', 'spaces in the target are refused');
equal(normalizeManualHost({ sshTarget: 'h', port: 70000 }).error, 'invalid ssh port', 'out-of-range SSH ports are refused');
equal(normalizeManualHost({ sshTarget: 'h', remotePort: 80 }).error, 'invalid remote port', 'remote ports below 1024 are refused');

const merged = mergeHosts(
  [{ id: 'alpha', label: 'alpha', source: 'ssh-config' }],
  [{ id: 'alpha', label: 'override', source: 'manual' }, { id: 'beta', label: 'beta', source: 'manual' }],
);
equal(merged.length, 2, 'manual hosts merge with ssh-config hosts');
equal(merged.find((host) => host.id === 'alpha').label, 'override', 'a manual host with the same id wins');
ok(manualHostId('Build box').startsWith('manual-build-box-'), 'manual ids are stable and readable');

const storeFile = path.join(temp, 'state', 'state.json');
const store = createStateStore(storeFile);
const initial = await store.load();
equal(initial.settings.mode, 'npx', 'the default start mode is npx');
equal(initial.settings.registry, 'https://registry.npmmirror.com', 'the default npm registry is npmmirror');
equal(initial.manualHosts, [], 'the default state has no manual hosts');
await store.update((state) => {
  state.settings.mode = 'global';
  state.manualHosts.push({ id: 'manual-x', label: 'x', sshTarget: 'x' });
});
const reloaded = createStateStore(storeFile);
const loaded = await reloaded.load();
equal(loaded.settings.mode, 'global', 'settings persist');
equal(loaded.manualHosts.length, 1, 'manual hosts persist');
const text = await readFile(storeFile, 'utf8');
ok(text.includes('manual-x'), 'the state file is JSON on disk');

/* ------------------------------------------------------------------ */
/* 2.5 管理器（假 SSH）                                                */
/* ------------------------------------------------------------------ */

const managerTemp = await mkdtemp(path.join(tmpdir(), 'remote-dsh-manager-'));
try {
  const sshDir = path.join(managerTemp, '.ssh');
  await mkdir(sshDir, { recursive: true });
  await writeFile(path.join(sshDir, 'config'), 'Host alpha\n  HostName alpha.example\n  User alice\n  Port 2222\n', 'utf8');

  const fakeExecFile = async (command, args) => {
    if (command === 'ssh' && args[0] === '-G') {
      return { stdout: 'hostname alpha.example\nuser alice\nport 2222\n' };
    }
    const script = Array.isArray(args) ? String(args[args.length - 1] ?? '') : '';
    if (script.includes('uname -s')) {
      return {
        stdout: [
          'os=Linux',
          'node=/usr/bin/node',
          'npm=/usr/bin/npm',
          'npx=/usr/bin/npx',
          'nodeVersion=v24.0.0',
          'npmPrefix=/usr/local',
          'dsh=',
          'version=',
        ].join('\n'),
      };
    }
    if (script.includes('npm install -g')) {
      return { stdout: 'npmPrefix=/usr/local\ndsh=/usr/local/bin/dsh\nversion=0.2.1-rc.5\n' };
    }
    const portMatch = /--port (\\d+)/.exec(script);
    const port = portMatch === null ? 3080 : Number(portMatch[1]);
    if (script.includes('setsid') || script.includes('nohup')) {
      return { stdout: `pid=4242\nlog=/home/user/.dsh-remote/web-${port}.log\n` };
    }
    if (script.includes('tail -n')) {
      return { stdout: `dsh web: http://127.0.0.1:${port}/?token=test-token\n` };
    }
    if (script.includes('kill -0') && script.includes('echo yes')) return { stdout: 'yes\n' };
    if (script.includes('kill -0')) return { stdout: 'stopped\n' };
    return { stdout: '' };
  };

  const managerStore = createStateStore(path.join(managerTemp, 'remote-dsh', 'state.json'));
  const manager = createRemoteManager({
    stateStore: managerStore,
    sshConfigPath: path.join(sshDir, 'config'),
    home: managerTemp,
    execFile: fakeExecFile,
    spawn: () => ({ once() {}, kill() {}, exitCode: 1 }),
  });
  const listed = await manager.loadHosts();
  equal(listed.hosts.length, 1, 'the manager lists ssh-config hosts');
  equal(listed.hosts[0].hostname, 'alpha.example', 'ssh -G is joined to the alias');
  equal(listed.hosts[0].user, 'alice', 'the effective user is exposed');

  const probed = await manager.probe(listed.hosts[0]);
  equal(probed.platform, 'Linux', 'probe parses the remote platform');
  equal(probed.npx, '/usr/bin/npx', 'probe detects npx for the default mode');
  equal(probed.canInstall, true, 'probe detects npm for global mode');

  const installed = await manager.install(listed.hosts[0], 'latest', 'https://registry.npmmirror.com');
  equal(installed.version, '0.2.1-rc.5', 'global install parses the resulting version');
  equal(installed.dsh, '/usr/local/bin/dsh', 'global install resolves the dsh binary');
  equal(installed.registry, 'https://registry.npmmirror.com', 'the registry override is recorded');

  await manager.setSettings({ mode: 'global' });
  equal((await managerStore.load()).settings.mode, 'global', 'the mode is persisted');

  const added = await manager.addManualHost({ label: 'Manual', sshTarget: 'manual@example.com' });
  ok(typeof added.id === 'string' && added.id.startsWith('manual-'), 'manual hosts receive an id');
  equal((await manager.loadHosts()).hosts.length, 2, 'manual hosts merge into the list');

  const freePort = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
  const spawnFake = () => {
    const server = net.createServer((socket) => socket.end());
    server.listen(freePort, '127.0.0.1');
    return {
      once() {},
      kill() { server.close(); },
      exitCode: null,
    };
  };
  const startManager = createRemoteManager({
    stateStore: managerStore,
    sshConfigPath: path.join(sshDir, 'config'),
    home: managerTemp,
    execFile: fakeExecFile,
    spawn: spawnFake,
  });
  const host = (await startManager.loadHosts()).hosts[0];
  const started = await startManager.start(host, { port: freePort, mode: 'npx' });
  equal(started.instance.pid, 4242, 'start records the remote pid');
  equal(
    started.instance.url,
    `http://127.0.0.1:${freePort}/?token=test-token`,
    'the printed URL is rewritten to the local tunnel',
  );
  const opened = await startManager.open(host);
  equal(opened.url, started.instance.url, 'open ensures the tunnel and returns the same URL');
  const stopped = await startManager.stop(host);
  equal(stopped.stopped, true, 'stop reports success');
  equal((await managerStore.load()).instances[host.id], undefined, 'stop clears the stored instance');

  const busyExecFile = async (command, args) => {
    if (command === 'ssh' && args[0] === '-G') {
      return { stdout: 'hostname alpha.example\nuser alice\nport 2222\n' };
    }
    const script = Array.isArray(args) ? String(args[args.length - 1] ?? '') : '';
    if (script.includes('uname -s')) {
      return { stdout: 'os=Linux\nnpm=/usr/bin/npm\nnpx=/usr/bin/npx\nnpmPrefix=/usr/local\n' };
    }
    if (script.includes('ss -ltnp')) {
      return { stdout: 'inUse=yes\npid=777\n' };
    }
    if (script.includes('ps -p 777')) {
      return { stdout: 'node /home/x/.npm/_npx/x/.bin/dsh web --host 127.0.0.1 --port 3080 --no-open\n' };
    }
    return { stdout: '' };
  };
  const busyManager = createRemoteManager({
    stateStore: createStateStore(path.join(managerTemp, 'remote-dsh', 'busy-state.json')),
    sshConfigPath: path.join(sshDir, 'config'),
    home: managerTemp,
    execFile: busyExecFile,
    spawn: () => ({ once() {}, kill() {}, exitCode: 1 }),
  });
  const busyHost = (await busyManager.loadHosts()).hosts[0];
  let portError;
  try {
    await busyManager.start(busyHost, { port: 3080 });
  } catch (error) {
    portError = error;
  }
  equal(portError?.code, 'PORT_IN_USE', 'an occupied remote port returns a structured PORT_IN_USE error');
  ok(String(portError?.message).includes('pid 777'), 'the port error names the owning pid');
} finally {
  await rm(managerTemp, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
/* 3. API                                                              */
/* ------------------------------------------------------------------ */

function mockResponse() {
  return {
    status: 0,
    body: '',
    writeHead(status) { this.status = status; },
    end(body) { this.body = body ?? ''; },
  };
}

function mockRequest(method, url, body, headers = {}) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]);
  stream.method = method;
  stream.url = url;
  stream.headers = headers;
  return stream;
}

const calls = [];
const manager = {
  async loadHosts() {
    calls.push('hosts');
    return { hosts: [{ id: 'alpha', label: 'alpha' }], configErrors: [], settings: { mode: 'npx', spec: 'latest' } };
  },
  async setSettings(patch) { return { mode: patch.mode ?? 'npx', spec: 'latest' }; },
  async addManualHost(host) { return { id: 'manual-1', ...host }; },
  async removeManualHost(id) { return { removed: id }; },
  async findHost(id) { return { id, label: id, sshTarget: id, source: 'ssh-config' }; },
  async probe(host) { return { platform: 'Linux', dsh: '/usr/bin/dsh', version: '0.2.1', installed: true }; },
  async install(host) { return { version: '0.2.1' }; },
  async start(host, options) { return { instance: { remotePort: options.port, url: 'http://127.0.0.1:3080/?token=x' } }; },
  async stop() { return { stopped: true }; },
  async open() { return { url: 'http://127.0.0.1:3080/?token=x' }; },
  async logs() { return { log: 'tail' }; },
};

const api = createApi({ manager, token: 'secret-token' });
ok(api.prefix === '/plugin-remote-dsh', 'the webServer prefix has no trailing slash, so prefix matching works');

{
  const res = mockResponse();
  await api.handler(mockRequest('GET', '/plugin-remote-dsh/api/bootstrap'), res);
  equal(res.status, 200, 'bootstrap is public');
  equal(JSON.parse(res.body).token, 'secret-token', 'bootstrap returns the local token');
}

{
  const res = mockResponse();
  await api.handler(mockRequest('GET', '/plugin-remote-dsh/api/hosts'), res);
  equal(res.status, 401, 'hosts require the local token');
}

{
  const res = mockResponse();
  await api.handler(mockRequest('GET', '/plugin-remote-dsh/api/hosts', undefined, { 'x-remote-dsh-token': 'secret-token' }), res);
  equal(res.status, 200, 'an authorized hosts call succeeds');
  equal(JSON.parse(res.body).hosts[0].id, 'alpha', 'the hosts payload is returned');
}

{
  const res = mockResponse();
  await api.handler(mockRequest('POST', '/plugin-remote-dsh/api/start', { id: 'alpha', port: 3080 }, { 'x-remote-dsh-token': 'secret-token' }), res);
  equal(res.status, 200, 'start returns 200');
  equal(JSON.parse(res.body).instance.remotePort, 3080, 'start returns the instance');
}

{
  const res = mockResponse();
  await api.handler(mockRequest('POST', '/plugin-remote-dsh/api/start', { id: 'alpha' }), res);
  equal(res.status, 401, 'start also requires the token');
}

{
  const res = mockResponse();
  await api.handler(mockRequest('POST', '/plugin-remote-dsh/api/probe', { id: 'alpha' }, { 'x-remote-dsh-token': 'secret-token' }), res);
  equal(res.status, 200, 'probe returns 200');
  equal(JSON.parse(res.body).probe.platform, 'Linux', 'probe payload is returned');
}

{
  const res = mockResponse();
  await api.handler(mockRequest('GET', '/plugin-remote-dsh/api/nope', undefined, { 'x-remote-dsh-token': 'secret-token' }), res);
  equal(res.status, 404, 'unknown API routes return 404');
}

/* ------------------------------------------------------------------ */
/* 4. 浏览器半                                                         */
/* ------------------------------------------------------------------ */

let definition;
globalThis.window = { __ModuleLoader__: { load(value) { definition = value; } } };
await import(pathToFileURL(path.resolve(import.meta.dirname, '..', 'client.js')).href + '?verify=1');
ok(definition !== undefined && definition.id === 'dsh-plugin-remote-dsh', 'client bundle registers under the package name');
const client = definition.factory((name) => {
  if (name !== 'react') throw new Error('unexpected require ' + name);
  return {
    createElement() {},
    useState() {},
    useCallback() {},
    useEffect() {},
    useMemo() {},
  };
});
ok(Array.isArray(client.inject) && client.inject.includes('slots'), 'client declares the slots dependency');
ok(client.inject.includes('sidebarRight'), 'client injects the right-Sidebar service for openTab');
ok(client.inject.includes('sidebarRightTabs'), 'client injects the right-Sidebar tab registry for the launcher');
const css = client.__internals.CSS;
ok(typeof css === 'string' && css.includes('.rdsh-root'), 'client stylesheet is present');
ok(css.includes('border:.5px solid var(--dsw-alias-border-l3)'), 'buttons use the host secondary border');
ok(!css.includes('button-contrast-fill') && !css.includes('button-primary-fill'), 'the page has no dark filled button variant');
ok(css.includes('.rdsh-btn:focus-visible'), 'buttons expose a focus-visible ring');
ok(css.includes('height:100%') && css.includes('overflow:auto'), 'the main page scrolls itself');

await rm(temp, { recursive: true, force: true });
console.log('verify-contract: ' + checks + ' assertions passed');
