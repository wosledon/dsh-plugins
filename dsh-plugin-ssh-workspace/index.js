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
import { buildTools } from './lib/tools.js';
import {
  escapeRemotePath,
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
   * 启动自述。fire-and-forget：它自身失败不能拖住装配。
   * `phase: 'enter'` 只证明"apply 被调用了"；`'ready'` 才是"装配走完了"。
   */
  try {
    void store.setLastBoot({ phase: 'enter' });
  } catch {
    /* 自述失败不影响功能 */
  }

  /* ---------------- 工具 ---------------- */

  /*
   * 用 `ctx.get('tools')` 而**不是** `ctx.tools`。
   *
   * Cordis 规则：访问服务**属性**必须先在自己的 `inject` 里声明该服务，否则抛
   * `cannot get property "tools" without inject`。而这条错误发生在 apply 期间，
   * 后果是**整行激活失败**（真机实测：`1 entry did not activate`）——正是
   * "应用起不来"那条路，且诊断里只留一行，界面上看不出是插件的问题。
   *
   * `ctx.get()` 是查询语义，不需要预先声明，因此也能优雅处理"这个 profile 没有
   * tools 服务"的情况：插件其余部分照常工作，而不是整个不激活。
   */
  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined;
  if (store.getConfig().enableTools !== false && tools !== undefined && typeof tools.register === 'function') {
    try {
      const api = {
        getConfig: () => store.getConfig(),
        pushHistory: (record) => store.pushHistory(record),
      };
      for (const spec of buildTools(api)) {
        try {
          const off = tools.register(spec);
          if (typeof off === 'function') cleanups.push(off);
        } catch (error) {
          // 单个工具注册失败不该让其余工具也没了。
          ctx.emit?.('plugin/error', { plugin: PLUGIN_ID, message: `注册工具 ${spec.name} 失败：${messageOf(error)}` });
        }
      }
    } catch (error) {
      ctx.emit?.('plugin/error', { plugin: PLUGIN_ID, message: `构建工具集失败：${messageOf(error)}` });
    }
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
      splitPath,
      escapeRemotePath,
      resolveTimeout,
    };
  }

  /* ---------------- 装配收尾 ---------------- */

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

  try {
    void store.setLastBoot({
      phase: 'ready',
      detail: `tools=${store.getConfig().enableTools !== false}`,
    });
  } catch {
    /* 自述失败不影响功能 */
  }

  return undefined;
}

export { Config };
export const inject = ['settings'];
