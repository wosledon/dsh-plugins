/**
 * 宿主半。
 *
 * 职责很窄：读配置、注册工具、把纯函数暴露给客户端。
 * 它**不**注册 slot（那是客户端半的事），也**不**建定时器——这个插件没有
 * 后台轮询，连接是用户或模型触发时才建立的。
 *
 * ## 两条来自真机事故的实现约定
 *
 * 1. **启动自述写在任何可能抛错的东西之前。** 此前另一个插件的 `apply()`
 *    一个可观测出口都没有，于是"没被调用 / 抛错了 / 定时器没跑 / 扫描没结束"
 *    四种故障从外面看一模一样，只能靠外部 CPU 采样和姊妹插件对照去猜，
 *    白费了好几轮重启。这里第一件事就写 `lastBoot`。
 * 2. **幂等守卫用 WeakSet。** 同一个 ctx 被重复 apply 时直接跳过——
 *    否则会留下第二套工具注册与第二份状态。
 */
import { Config } from './lib/config.js';
import { CONFIG_NS, PACKAGE_NAME } from './lib/constants.js';
import { createStore } from './lib/store.js';
import { readSshHosts } from './lib/sshhosts.js';
import { buildTools, listRemoteDir } from './lib/tools.js';
import {
  escapeRemotePath,
  formatBytes,
  formatDuration,
  formatExact,
  hostDisplayName,
  hostSummary,
  normaliseHistory,
  normaliseHosts,
  resolveTimeout,
  splitPath,
} from './lib/pure.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** 幂等守卫：模块按解析路径缓存，同一 ctx 不该被 apply 两次。 */
const applied = new WeakSet();

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

const PLUGIN_ID = '@@dsh-plugin-ssh-workspace/host@@';

export function apply(ctx, rawConfig) {
  if (isObject(ctx)) {
    if (applied.has(ctx)) return undefined;
    applied.add(ctx);
  }

  const store = createStore(ctx, rawConfig, { ns: CONFIG_NS, packageName: PACKAGE_NAME });
  const cleanups = [];

  /*
   * **主机只有一个来源：`~/.ssh/config`。**
   *
   * 每次调用都重新读文件（几 KB，代价可忽略）：用户随时可能改 ssh config，
   * 缓存只会带来"改了配置但插件还显示旧的"。`getHosts()` 给工具用，
   * `syncHosts()` 把结果投影到配置里给客户端读（客户端不能读文件）。
   */
  const getHosts = () => readSshHosts().hosts;

  async function syncHosts() {
    const snapshot = readSshHosts();
    await store.setSshHosts(snapshot.hosts, snapshot.warnings, snapshot.path);
  }

  /*
   * 启动自述。fire-and-forget：它自身失败不能拖住装配。
   * `phase: 'enter'` 只证明"apply 被调用了"；`'ready'` 才是"装配走完了"。
   */
  try {
    void store.setLastBoot({ phase: 'enter' });
  } catch {
    /* 自述失败不影响功能 */
  }

  // 把 ssh config 的主机列表投影到配置里：客户端读不到文件，只能这样拿到列表。
  void syncHosts();

  /* ---------------- 工具 ---------------- */

  /*
   * 工具注册。三段都是踩出来的：
   *
   * 1. **`tools` 必须进 `inject`**（见文件底部 `export const inject`）。
   *    Cordis 里 `ctx.get(name)` 是**安全探测**：没有 inject 声明时它返回
   *    `undefined` 而**不抛错**。所以早先写的 `ctx.get('tools')` 一路静默返回
   *    undefined，工具一个都没注册，而 `lastBoot` 里只留下一句
   *    `tools=true`（那只是配置开关的值，不是注册结果）——界面和诊断都看不出
   *    问题。现在 `detail` 写的是**真实注册条数**。
   *
   * 2. **注册放在 `ctx.effect` 里**，由 fiber 拥有清理，与已真机验证的
   *    scheduled-tasks 一致。
   *
   * 3. **优先用宿主真正的 `defineTool`**（动态 import `@deepseek-ai/dsh-tools`，
   *    本插件没有构建步骤、不能静态 import 宿主包）。它不只转 schema，还提供
   *    execute 前的参数校验；拿不到时退化为直接注册原始 spec，工具仍可用。
   */
  const toolsService = (() => {
    try {
      return typeof ctx.get === 'function' ? ctx.get('tools') : undefined;
    } catch {
      return undefined;
    }
  })();

  let registeredTools = 0;
  let toolsNote = '';

  if (store.getConfig().enableTools === false) {
    toolsNote = 'enableTools=false';
  } else if (toolsService === undefined || typeof toolsService.register !== 'function') {
    toolsNote = 'tools 服务不可用';
  } else {
    ctx.effect(() => {
      let disposed = false;
      const disposers = [];
      void (async () => {
        try {
          let defineTool = null;
          try {
            const hostTools = await import('@deepseek-ai/dsh-tools');
            if (typeof hostTools.defineTool === 'function') defineTool = hostTools.defineTool;
          } catch {
            /* 拿不到就用原始 spec */
          }
          const api = {
            getConfig: () => store.getConfig(),
            getHosts,
            pushHistory: (record) => store.pushHistory(record),
          };
          for (const spec of buildTools(api)) {
            let definition = spec;
            if (defineTool !== null) {
              try {
                definition = defineTool(spec);
              } catch (error) {
                toolsNote = `defineTool(${spec.name}) 失败：${messageOf(error)}`;
                continue;
              }
            }
            try {
              const off = toolsService.register(definition);
              if (typeof off === 'function') disposers.push(off);
              registeredTools += 1;
            } catch (error) {
              // 单个工具注册失败不该让其余工具也没了。
              toolsNote = `注册 ${spec.name} 失败：${messageOf(error)}`;
            }
          }
          // 注册结果写进自述：下一次启动就能看出到底成了几个。
          void store.setLastBoot({ phase: 'ready', detail: `tools=${registeredTools}${toolsNote === '' ? '' : ' ' + toolsNote}` });
        } catch (error) {
          toolsNote = messageOf(error);
        }
      })();
      return () => {
        if (disposed) return;
        disposed = true;
        for (let index = disposers.length - 1; index >= 0; index -= 1) {
          try { disposers[index](); } catch { /* 单个清理失败不该阻塞其余 */ }
        }
        disposers.length = 0;
      };
    }, `${PACKAGE_NAME}: tools`);
  }

  /* ---------------- 面板的目录浏览请求 ---------------- */
  /*
   * 客户端（浏览器半）拿不到 `tools` 服务，也没有新增 Remote 命名空间的权限，
   * 所以面板里的「列出目录」只能走 `remote.settings` 这条通用读写通道：
   *
   *   客户端 `settings.mutate` 写入 `internal.request`
   *     → 宿主收到 `settings/document-updated` 事件
   *     → 用与 `ssh_list_dir` **完全相同**的 `listRemoteDir()` 执行
   *     → 把结果写进 `internal.result`
   *     → 客户端按 `id` 配对后渲染
   *
   * **事件驱动，不需要定时器。** 我先查了服务契约：`settings` 的方法列表里没有
   * 任何 `on`/`watch`，所以一度以为只能轮询；但事件目录里有
   *   `settings/document-updated(ns, revision)` —— "One profile entry's form values,
   *   availability, or page policy changed"，正是这里要的钩子。
   *
   * 两处防自激：
   *   1. 只认 `ns === CONFIG_NS`（宿主写 `result` 也会触发本事件）；
   *   2. 用 `servicedRequests` 记住已处理的请求 id，同一个请求不重复执行。
   */
  const servicedRequests = new Set();

  async function serviceRequest() {
    // 请求是客户端写进 profile 的，必须先刷新才能看到（内存快照不会自动更新）。
    await store.refresh();
    const request = store.getRequest();
    if (request === null) return;
    if (servicedRequests.has(request.id)) return;
    servicedRequests.add(request.id);
    // 只留最近若干条，避免长期运行后无限增长（请求 id 是时间戳+随机串，不会重复）。
    if (servicedRequests.size > 64) servicedRequests.clear();

    try {
      const payload = await listRemoteDir(
        { getConfig: () => store.getConfig(), getHosts, pushHistory: (record) => store.pushHistory(record) },
        request.hostId,
        request.path,
      );
      await store.setResult({
        id: request.id,
        ok: payload.ok === true,
        hostId: request.hostId,
        path: payload.path ?? request.path,
        detail: payload.message ?? '',
        count: payload.count ?? 0,
        truncated: payload.truncatedByLimit === true,
        entries: payload.entries ?? [],
      });
    } catch (error) {
      await store.setResult({
        id: request.id,
        ok: false,
        hostId: request.hostId,
        path: request.path,
        detail: messageOf(error),
      });
    }
  }

  if (typeof ctx.on === 'function') {
    ctx.on('settings/document-updated', (ns) => {
      if (String(ns) !== CONFIG_NS) return;
      // 每次客户端交互都顺带重读 ssh config：用户很可能刚改过它。
      // 文件只有几 KB，这个代价换来"改了就能看到"，值得。
      void syncHosts().then(() => serviceRequest());
    });
    // 启动时也服务一次：客户端可能在上一次宿主生命周期里写了请求，
    // 那次事件没人接。
    void serviceRequest();
  }

  /* ---------------- 客户端可用的纯函数 ---------------- */
  /*
   * 客户端 bundle 只能 `require('react')`，拿不到这些实现。通过 globals 暴露，
   * 让两半用**同一份**算法——跨两半各写一份是"界面显示的端口和实际连的端口
   * 不一致"这类 bug 的直接来源。
   */
  if (typeof globalThis !== 'undefined') {
    globalThis.__SSH_WORKSPACE_INTERNALS__ = {
      readConfig(response) {
        if (!isObject(response) || response.ok !== true || !isObject(response.value)) {
          return { found: false, config: {} };
        }
        const view = response.value;
        const list = Array.isArray(view.namespaces) ? view.namespaces : [];
        const entry = list.find((item) => isObject(item) && item.ns === CONFIG_NS);
        if (entry === undefined) return { found: true, config: {} };
        const raw = isObject(entry.user) && Object.keys(entry.user).length > 0 ? entry.user : entry.value;
        return { found: true, config: isObject(raw) ? raw : {} };
      },
      normaliseHosts,
      hostDisplayName,
      hostSummary,
      normaliseHistory,
      formatDuration,
      formatExact,
      formatBytes,
      splitPath,
      escapeRemotePath,
      resolveTimeout,
    };
  }

  /*
   * 装配收尾。
   *
   * 这里**不再**写第二条 `ready`：`ready` 现在由工具注册那段在拿到**真实注册
   * 条数**之后写。早先这里的写的是 `tools=${enableTools !== false}`——那只是配置
   * 开关的值，于是"开关是开的、但一个工具都没注册成功"在诊断里显示成
   * `tools=true`，看起来完全正常。把配置值当成结果上报，正是这类问题最难查的
   * 原因。
   */
  ctx.effect(() => async () => {
    for (let index = cleanups.length - 1; index >= 0; index -= 1) {
      try {
        await cleanups[index]();
      } catch {
        /* 单个清理失败不该阻塞其余 */
      }
    }
    cleanups.length = 0;
  }, `${PACKAGE_NAME}: teardown`);

  return undefined;
}

export { Config };

/*
 * `tools` 必须在这里声明。
 *
 * Cordis 的 `ctx.get(name)` 是**安全探测**：没在 `inject` 里声明该服务时它返回
 * `undefined` 而**不抛错**。所以"用 ctx.get 绕过 inject"这个想法是错的——它不会
 * 报错，只会让你的服务查询一直拿到 undefined（真机实测：工具一个都没注册，
 * 而 `lastBoot` 里只留一句看起来正常的 `tools=true`）。
 *
 * 与已真机验证的 scheduled-tasks 一致（`inject = ['settings', 'tools']`）。
 */
export const inject = ['settings', 'tools'];
