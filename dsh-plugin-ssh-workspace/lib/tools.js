/**
 * 面向 Agent 的工具集。
 *
 * 这是"让 Agent 的工作区变远程"的**实际落点**：Agent 通过这组工具在远端执行命令、
 * 列目录、读文件。走工具而不是替换 `fs`/`shell` 服务，是因为后者要第三方插件
 * 在足够高的作用域覆盖 base 实现——那条路没有验证过，赌它的代价是整套功能不可用。
 *
 * ## 安全边界（README 里也要原样说明）
 *
 * `ssh_exec` 让模型在远程主机上跑**任意命令**。这是本插件存在的目的，但也意味着
 * 一旦配置了主机，模型就拥有了那台机器上该用户的全部权限。三道收窄：
 *
 *   1. **必须显式指定 `hostId`** —— 工具不可能自己"发现"或连到没配过的主机。
 *   2. **只支持私钥认证，插件不存任何口令** —— 密钥留在用户自己的 `~/.ssh`。
 *   3. **`enableTools: false` 可整组关掉** —— 只想用面板不想让模型碰远端时，
 *      把这个开关关掉即可，工具会整体不注册。
 *
 * 没有做命令白名单：那会给"跑个 grep 都要先加白名单"的日常使用制造摩擦，
 * 而真正的边界是"配了哪些主机、用哪个身份"，那已经由 hostId + 私钥决定了。
 */
import { buildSshArgs, catCommand, findCommand, formatDuration, hostDisplayName, hostSummary, normaliseHosts, parseFindOutput, resolveTimeout, escapeRemotePath } from './pure.js';
import { probeHost, runSsh } from './exec.js';
import { MAX_LIST_ENTRIES } from './constants.js';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** 失败结果。所有工具统一返回 `{ ok, code?, message?, ... }`。 */
function fail(code, message) {
  return { ok: false, code, message };
}

/**
 * 输出 schema（**value schema DSL，不是 JSON Schema**）。所有工具共用。
 *
 * 两处必须按 DSL 写，写错会被 `defineTool` 直接拒绝，**一个工具都注册不上**：
 *
 *   1. **`required` 是节点级布尔标志，不是顶层数组。** 写成 JSON Schema 的
 *      `required: ['ok']` 会抛
 *      `unsupported JSON schema: schema.required is not supported by the value schema DSL`。
 *      真机实测：5 个工具全部失败，`internal.lastBoot.detail` 写着 `tools=0`。
 *   2. 带上 `additionalProperties: true`，与已真机验证的 scheduled-tasks 一致。
 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  description: '工具结果：失败时 { ok:false, code, message }，成功时附带数据。',
  properties: {
    ok: { type: 'boolean', required: true, description: '调用是否成功。' },
    code: { type: 'string', description: '失败原因代码（仅失败时）。' },
    message: { type: 'string', description: '面向模型/用户的说明（仅失败时）。' },
  },
};

/**
 * 工具结果的内容渲染。
 *
 * **必须返回内容块数组，不能返回字符串。** 一度写成
 * `(value) => JSON.stringify(value)`，工具能注册、能被调用，但宿主拿到返回值后
 * 会对它调 `.some`，于是每一次调用都失败在 `content.some is not a function`——
 * 报错发生在渲染层，和工具逻辑本身毫无关系，很难往这个方向想。
 *
 * 形状与已真机验证的 scheduled-tasks 一致：`[{ type: 'text', text }]`，
 * 且第一个参数是**调用参数**（这里用不到，保留占位以匹配签名）。
 */
function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value ?? null, null, 2) }];
}

/**
 * 参数 schema（author DSL：属性名 -> 节点）。
 *
 * `hostId` 一律 `required: true`：让模型必须先在 `ssh_hosts` 里查过再用，
 * 而不是凭猜测传一个主机名。
 */
const HOST_ID = { type: 'string', required: true, description: '目标主机 id，先用 ssh_hosts 取得，不要凭猜测填写。' };
const PATH_PARAM = { type: 'string', required: true, description: '远端绝对路径（或相对当前目录的路径）。' };

/** 把 hostId 解析成归一化后的主机；找不到就给失败结果。 */
function resolveHost(hosts, hostId) {
  if (typeof hostId !== 'string' || hostId.trim() === '') {
    return { error: fail('BAD_HOST_ID', 'hostId 不能为空：请先用 ssh_hosts 列出已配置的主机。') };
  }
  const list = normaliseHosts(hosts);
  const host = list.find((item) => item.id === hostId.trim());
  if (host === undefined) {
    return { error: fail('UNKNOWN_HOST', `找不到主机「${hostId}」。已配置的主机 id 可用 ssh_hosts 取得（当前 ${list.length} 台）。`) };
  }
  return { host };
}

/** 结果里附上"是哪台主机、跑了多久"，便于模型复述。 */
function decorate(result, host, remoteCommand) {
  return {
    ...result,
    host: hostDisplayName(host),
    endpoint: hostSummary(host),
    ...(remoteCommand === undefined ? {} : { command: remoteCommand }),
    durationMs: result.durationMs,
    duration: formatDuration(result.durationMs),
  };
}

/* ------------------------------------------------------------------ */
/* 各工具的实现                                                        */
/* ------------------------------------------------------------------ */

function runHosts(api) {
  const hosts = normaliseHosts(api.getConfig().hosts);
  return {
    ok: true,
    count: hosts.length,
    hosts: hosts.map((host) => ({
      id: host.id,
      name: hostDisplayName(host),
      endpoint: hostSummary(host),
      user: host.user,
      host: host.host,
      port: host.port,
      identityFile: host.identityFile,
      tags: host.tags,
      note: host.note,
    })),
    message: hosts.length === 0
      // 文案里的方位必须与实际界面一致。原先写的是"「Token 用量」旁边的 SSH 面板"
      // ——那是从另一个插件抄骨架时留下的，指向一个不存在的位置。
      ? '还没有配置任何远程主机。请打开侧边栏的「SSH 远程工作区」面板添加一台主机（填主机名、用户与私钥路径）。'
      : `已配置 ${hosts.length} 台远程主机。用 ssh_exec 在指定主机上执行命令。`,
  };
}

async function runExec(api, input) {
  const found = resolveHost(api.getConfig().hosts, input.hostId);
  if (found.error !== undefined) return found.error;
  const command = typeof input.command === 'string' ? input.command.trim() : '';
  if (command === '') return fail('EMPTY_COMMAND', 'command 不能为空。');
  const timeoutMs = resolveTimeout(
    Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs : api.getConfig().timeoutMs,
  );
  const args = buildSshArgs({
    host: found.host,
    remoteCommand: command,
    connectTimeoutMs: Math.min(timeoutMs, 10_000),
  });
  const result = await runSsh(args, { timeoutMs });
  const record = {
    id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    hostId: found.host.id,
    command,
    at: Date.now(),
    ok: result.ok,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    truncated: result.truncated,
    bytes: result.bytes,
    detail: result.detail || result.stderr.trim().slice(0, 500),
  };
  await api.pushHistory(record);
  const payload = decorate({
    ok: result.ok,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    truncated: result.truncated,
    bytes: result.bytes,
  }, found.host, command);
  if (!result.ok) {
    payload.code = result.exitCode === null ? 'SSH_FAILED' : 'NONZERO_EXIT';
    payload.message = result.detail !== '' ? result.detail : `远端命令退出码 ${String(result.exitCode)}`;
    if (result.stderr.trim() !== '') payload.message += `；stderr：${result.stderr.trim().slice(0, 500)}`;
  }
  return payload;
}

/**
 * 列一个远程目录。
 *
 * **导出**是刻意的：面板的「列出」按钮由宿主半的请求服务处理，而那条路径必须与
 * `ssh_list_dir` 工具**完全相同**——两处各写一份，迟早会出现"工具列得出来、
 * 面板列不出来"这种只在一边复现的问题。
 *
 * 返回不带 `decorate` 的原始结果，调用方按需补主机信息（工具要，面板的 UI 也
 * 能自己从 hosts 里取）。
 */
export async function listRemoteDir(api, hostId, rawPath) {
  const found = resolveHost(api.getConfig().hosts, hostId);
  if (found.error !== undefined) return { ...found.error, hostId };
  const path = typeof rawPath === 'string' ? rawPath.trim() : '';
  if (path === '') return { ...fail('EMPTY_PATH', 'path 不能为空。'), hostId };
  const config = api.getConfig();
  const timeoutMs = resolveTimeout(config.timeoutMs);
  const configured = Number.isFinite(config.maxListEntries) ? config.maxListEntries : MAX_LIST_ENTRIES;
  const limit = Math.max(1, Math.min(MAX_LIST_ENTRIES, Math.floor(configured)));
  const args = buildSshArgs({ host: found.host, remoteCommand: findCommand(path), connectTimeoutMs: 10_000 });
  const result = await runSsh(args, { timeoutMs });
  if (!result.ok) {
    return {
      ok: false,
      code: result.exitCode === null ? 'SSH_FAILED' : 'NONZERO_EXIT',
      message: `列目录失败：${result.detail !== '' ? result.detail : result.stderr.trim().slice(0, 500)}`,
      hostId: found.host.id,
      path,
    };
  }
  const entries = parseFindOutput(result.stdout, limit);
  return {
    ok: true,
    hostId: found.host.id,
    path,
    count: entries.length,
    truncatedByLimit: result.truncated || entries.length >= limit,
    entries,
  };
}

async function runListDir(api, input) {
  const payload = await listRemoteDir(api, input.hostId, input.path);
  if (payload.ok !== true) return payload;
  const found = resolveHost(api.getConfig().hosts, input.hostId);
  return found.error !== undefined ? payload : decorate(payload, found.host);
}

async function runReadFile(api, input) {
  const found = resolveHost(api.getConfig().hosts, input.hostId);
  if (found.error !== undefined) return found.error;
  const path = typeof input.path === 'string' ? input.path.trim() : '';
  if (path === '') return fail('EMPTY_PATH', 'path 不能为空。');
  const timeoutMs = resolveTimeout(api.getConfig().timeoutMs);
  const args = buildSshArgs({
    host: found.host,
    remoteCommand: catCommand(path),
    connectTimeoutMs: 10_000,
  });
  const result = await runSsh(args, { timeoutMs });
  if (!result.ok) {
    return decorate({
      ok: false,
      code: result.exitCode === null ? 'SSH_FAILED' : 'NONZERO_EXIT',
      message: `读文件失败：${result.detail !== '' ? result.detail : result.stderr.trim().slice(0, 500)}`,
    }, found.host);
  }
  return decorate({
    ok: true,
    path,
    content: result.stdout,
    bytes: result.bytes,
    truncated: result.truncated,
  }, found.host);
}

async function runProbe(api, input) {
  const found = resolveHost(api.getConfig().hosts, input.hostId);
  if (found.error !== undefined) return found.error;
  const timeoutMs = resolveTimeout(api.getConfig().timeoutMs);
  const args = buildSshArgs({ host: found.host, connectTimeoutMs: Math.min(timeoutMs, 15_000) });
  const result = await probeHost(args, timeoutMs);
  const detail = result.ok ? '' : (result.detail !== '' ? result.detail : result.stderr.trim().slice(0, 500));
  return decorate({
    ok: result.ok,
    /*
     * 用条件展开而不是 `code: result.ok ? undefined : 'SSH_FAILED'`。
     *
     * 工具结果会先过 `snapshotToolValue()` 做**无损 JSON 快照**，显式的
     * `undefined` 字段在那个过程里的下场取决于实现（是靠 JSON 序列化丢掉，
     * 还是被判成"非无损 JSON"抛错）。没必要赌这一下——不带这个键就没有问题。
     */
    ...(result.ok ? {} : { code: 'SSH_FAILED' }),
    message: result.ok ? `${hostDisplayName(found.host)} 连通正常` : detail,
    durationMs: result.durationMs,
    duration: formatDuration(result.durationMs),
  }, found.host);
}

/** 把 shell 用的单引号转义也暴露给界面（文件浏览拼路径时要用）。 */
export { escapeRemotePath };

/* ------------------------------------------------------------------ */
/* 工具定义                                                            */
/* ------------------------------------------------------------------ */

const LIST_DESCRIPTION = '列出已配置的远程主机。任何远端操作前都必须先调用它取得 hostId——不要凭猜测填主机名。';

export function buildTools(api) {
  const specs = [
    {
      name: 'ssh_hosts',
      description: LIST_DESCRIPTION,
      parameters: {},
      execute: () => runHosts(api),
    },
    {
      name: 'ssh_exec',
      description: '在指定远程主机上执行一条 shell 命令并返回 stdout/stderr/退出码。这是让 Agent 真正在远端工作的主要入口，因此它能执行任意命令——只对已显式配置的主机有效。',
      parameters: {
        hostId: HOST_ID,
        command: { type: 'string', required: true, description: '要执行的 shell 命令（会在远端的登录 shell 里跑）。' },
        timeoutMs: { type: 'number', description: '可选：本次执行的墙钟上限（毫秒），默认取插件配置的 timeoutMs。' },
      },
      execute: (args) => runExec(api, isRecord(args) ? args : {}),
    },
    {
      name: 'ssh_list_dir',
      description: '列出远程主机上的一个目录（路径/类型/大小/改动时间）。远端需要 GNU find 的 -printf。',
      parameters: { hostId: HOST_ID, path: PATH_PARAM },
      execute: (args) => runListDir(api, isRecord(args) ? args : {}),
    },
    {
      name: 'ssh_read_file',
      description: '读取远程主机上的一个文本文件内容。二进制文件不要用它（会把内容当成 UTF-8 损坏）。',
      parameters: { hostId: HOST_ID, path: PATH_PARAM },
      execute: (args) => runReadFile(api, isRecord(args) ? args : {}),
    },
    {
      name: 'ssh_probe',
      description: '探测一台远程主机是否连通、密钥是否可用。排查"连不上"时先用它，它的报错比 ssh_exec 更直接。',
      parameters: { hostId: HOST_ID },
      execute: (args) => runProbe(api, isRecord(args) ? args : {}),
    },
  ];

  return specs.map((spec) => ({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    execute: async (args) => {
      try {
        return await spec.execute(args);
      } catch (error) {
        // 工具**不能**把异常抛给 Agent：那会让整轮工具调用失败，
        // 而这里绝大多数异常只是"某台主机没配好"这种可恢复情况。
        return fail('INTERNAL', `插件内部错误：${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }));
}
