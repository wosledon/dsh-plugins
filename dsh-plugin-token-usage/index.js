/**
 * 「Token 用量」插件 —— 宿主侧。
 *
 * 职责只有两件，都很窄：
 *   1. 注册会话投影 `tokenByModel`（按模型拆分的用量），客户端实时读它；
 *   2. 按客户端请求扫描历史会话日志，折叠出跨会话汇总写进设置，供独立页面读。
 *
 * 之所以跨会话那部分非得在宿主做：`ctx.sessionQuery` 的方法都不是 `@Remote`，
 * 浏览器侧根本调不到别的会话的日志。
 */
import { Config } from './lib/config.js';
import { createStore } from './lib/store.js';
import { tokenByModelUnit } from './lib/projection.js';
import { buildSummary, probeSessionSource } from './lib/summary.js';
import { CONFIG_NS, DEFAULT_SCAN_LIMIT, SUMMARY_SHAPE, SUMMARY_TTL_MS } from './lib/constants.js';

export { Config };

/**
 * `settings` 是硬依赖：跨会话汇总没有别的持久化去处。
 * `sessionProjections` 与 `sessionQuery` 都是**可选**的——缺失时插件必须
 * 仍能加载并降级（少一个功能），而不是整体不激活。
 */
export const inject = ['settings'];

/** 检查周期：消费者是"客户端请求 + 过期"，不需要密。 */
const SWEEP_MS = 60_000;

/**
 * 同一模块被重复 apply（Loader 重载、profile 补丁变更）时的幂等保护。
 *
 * Node 的 ESM 模块缓存按解析路径命中，所以这个 WeakSet 会跨重载存活；
 * 而 Cordis 可能对同一个 ctx 再调一次 apply。没有它就会留下两套定时器。
 */
const applied = new WeakSet();

function warn(ctx, text) {
  try {
    if (typeof ctx?.logger?.warn === 'function') ctx.logger.warn(`[token-usage] ${text}`);
    else console.warn(`[token-usage] ${text}`);
  } catch {
    /* ignore */
  }
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {object} ctx Cordis 上下文
 * @param {object} rawConfig Loader 传来的 config
 */
export function apply(ctx, rawConfig) {
  if (ctx !== null && typeof ctx === 'object') {
    if (applied.has(ctx)) {
      warn(ctx, '同一个 ctx 被重复 apply，已跳过（避免留下第二套定时器）');
      return undefined;
    }
    applied.add(ctx);
  }

  const store = createStore(ctx, rawConfig, { ns: CONFIG_NS, packageName: 'dsh-plugin-token-usage' });
  const cleanups = [];

  /*
   * 启动自述：**第一步就写**，在任何可能抛错的东西之前。
   *
   * 排查真机"数据没来"时，`apply()` 原先一个可观测出口都没有，于是无法区分
   * 「apply 没被调用」「apply 抛错了」「定时器没跑」「扫描还没结束」——只能靠
   * 外部 CPU 采样和姊妹插件对照去猜。这条一写，下次启动就直说。
   * fire-and-forget：它本身失败也不能拖住装配。
   */
  void store.setLastBoot({ phase: 'enter' }).catch(() => {});
  /*
   * 里程碑埋点。真机排查已经花了四轮重启，每轮只能回答一个是/否问题；这一条让
   * **一次**启动就把范围缩到一个点。`trace` 只保留最后到达的那一步，所以看到
   * `timer:created` 却看不到 `timer:tick:1`，就等于"定时器建了但没触发"。
   */
  const trace = (text) => {
    void store.setTrace(text).catch(() => {});
  };
  trace('apply:enter');

  /* 定时器心跳计数（见下方 setInterval）。 */
  let tickCount = 0;

  /* ------------------------------------------------------------------ */
  /* 1. 会话投影：按模型的实时用量                                        */
  /* ------------------------------------------------------------------ */

  let projectionDisposer = null;
  if (typeof ctx.inject === 'function') {
    // 用 ctx.inject 而不是硬 inject：这个 profile 没有会话投影服务时，
    // 插件其余部分（跨会话汇总）仍然要能用。
    ctx.inject(['sessionProjections'], (scoped) => {
      const registry = typeof scoped?.get === 'function' ? scoped.get('sessionProjections') : undefined;
      if (registry === null || typeof registry?.register !== 'function') {
        warn(scoped, 'sessionProjections 不可用，实时按模型用量将缺失');
        return undefined;
      }
      try {
        const off = registry.register(tokenByModelUnit);
        projectionDisposer = off;
        cleanups.push(() => {
          if (typeof off === 'function') off();
        });
        return () => {
          if (typeof off === 'function') off();
        };
      } catch (error) {
        // 注册失败只降级：投影是增强，跨会话汇总才是骨架。
        warn(scoped, `注册 tokenByModel 投影失败：${message(error)}`);
        return undefined;
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* 2. 跨会话汇总                                                        */
  /* ------------------------------------------------------------------ */

  const scanLimit = Number.isFinite(rawConfig?.scanLimit) ? rawConfig.scanLimit : DEFAULT_SCAN_LIMIT;
  let scanning = false;

  /** 扫描一次并把结果落盘。并发保护：扫描是重活，不能叠加。 */
  async function runScan(reason) {
    if (scanning) return false;
    const probe = probeSessionSource(ctx);
    if (!probe.available) {
      // 失败也要落盘：否则界面只会显示"没有数据"，用户无从判断是没用量还是插件坏了。
      await store.setLastSweep({ ok: false, detail: probe.reason });
      warn(ctx, `跳过扫描（${reason}）：${probe.reason}`);
      return false;
    }
    scanning = true;
    try {
      /*
       * 先落一条"扫描已开始"，再去做重活。
       *
       * 真机排查时卡在这个盲点上：扫描从启动起跑了 3 分钟没有任何写入，而
       * `lastSweep` 一直是上一次成功的时间戳——于是"正在扫描"和"根本没跑"
       * 从外面看一模一样。有了这条，卡住的扫描自己会说话。
       */
      await store.setLastSweep({ ok: false, detail: '扫描中…' });
      const limit = Number.isFinite(store.getScanLimit()) ? store.getScanLimit() : scanLimit;
      const summary = await buildSummary(probe, { limit });
      const wrote = await store.setSummary(summary);
      await store.setLastSweep({
        ok: wrote === true,
        detail: wrote === true ? '' : '汇总写入设置失败',
      });
      if (wrote !== true) warn(ctx, '汇总写入设置失败，界面将停留在旧数据');
      return true;
    } catch (error) {
      const detail = message(error);
      await store.setLastSweep({ ok: false, detail });
      warn(ctx, `扫描失败（${reason}）：${detail}`);
      return false;
    } finally {
      scanning = false;
    }
  }

  /**
   * 一轮消费者：先处理客户端请求，再处理"从未扫描过"的冷启动。
   *
   * 导出给自检脚本用：真机上"到底跑没跑扫描"是最难判断的一件事，
   * 有个可直接调用的入口就能离线断言。
   */
  async function sweep() {
    trace('sweep:enter');
    if (!store.isPersistent()) {
      // 只读 profile：不写任何东西，但要留下可诊断的痕迹。
      // 注意：这条分支原先**连 trace 都不写**，于是"只读模式直接返回"与
      // "sweep 根本没被调用"在盘上完全一样——真机排查正是卡在这里。
      trace('sweep:read-only');
      warn(ctx, '设置不可写，跳过扫描');
      return { scanned: false, reason: 'read-only' };
    }
    let requested = null;
    try {
      requested = await store.takeRefreshRequest();
    } catch (error) {
      warn(ctx, `读取刷新请求失败：${message(error)}`);
    }
    if (requested !== null) {
      const done = await runScan('客户端请求');
      return { scanned: done, reason: 'requested' };
    }
    // 冷启动补一次：否则独立页面第一次打开永远是空的。
    const summary = store.getSummary();
    if (summary === undefined || !Number.isFinite(summary?.builtAt)) {
      const done = await runScan('首次填充');
      return { scanned: done, reason: 'cold-start' };
    }
    /*
     * 形状版本不匹配 → 立刻重扫，不受 TTL 约束。
     *
     * 真机踩过：插件升级新增了 `timeline`，但落盘的旧 summary 仍在 5 分钟 TTL 内，
     * 宿主判定"还没过期"而不重扫——折线图空着，看起来像功能坏了，实际只是旧数据
     * 被沿用。有了这一条，升级后的第一次 sweep 就会重扫。
     */
    if (summary.shape !== SUMMARY_SHAPE) {
      const done = await runScan('形状升级');
      return { scanned: done, reason: 'shape-changed' };
    }
    // 按 TTL 自行续期。
    //
    // 不能只依赖"客户端点刷新"：界面的写入走 `remote.settings`，而那条通道在
    // 本插件这类 bundle-insert 行上并不可靠（见 lib/store.js 顶部）。宿主自己
    // 续期后，跨会话数据至少每 5 分钟会自己变新，刷新按钮只是"提前触发"。
    if (Date.now() - summary.builtAt > SUMMARY_TTL_MS) {
      const done = await runScan('TTL 续期');
      return { scanned: done, reason: 'stale' };
    }
    return { scanned: false, reason: 'up-to-date' };
  }

  // 定时器**在 ctx.effect 内**建立。
  //
  // 官方规则是「Register every resource inside `apply` with `ctx.effect` or `ctx.on`
  // and return its cleanup」。把 setInterval 放在 apply 顶层虽然也能靠 teardown
  // 收尾，但一旦它之后、teardown 注册之前抛错，这个定时器就再也没人清了。
  // 放进 effect 后由 fiber 直接拥有，不依赖后续代码是否执行到。
  ctx.effect(() => {
    const timer = setInterval(() => {
      tickCount += 1;
      trace('timer:tick:' + tickCount);
      // 心跳写的是"定时器在转"，与 lastSweep 的"扫描跑过"是两件事：
      // 定时器可能在转而扫描一直失败，也可能两者都没跑。
      //
      // 这里**不能**用 `.catch(() => {})` 吞掉：上一轮真机排查时心跳始终不出现，
      // 而"写失败"和"回调没触发"从外面看一模一样，白白多花了一轮。
      void store.setHeartbeatDirect(tickCount, Date.now()).catch((error) => {
        warn(ctx, `心跳写入失败：${message(error)}`);
      });
      void sweep();
    }, SWEEP_MS);
    /*
     * **不再 unref()。**
     *
     * 原先调了 `timer.unref()`，理由是"定时器只是后台补充，不是常驻理由"。
     * 但真机现象是 5 分钟内 0 次心跳——而 `unref()` 恰好能让定时器在事件循环
     * 上没有其它引用时**不触发**。既然这是一个需要定期续期数据的定时器，
     * 它就应当自己维持进程存活；把"不阻止退出"写进理由，代价是它可能永远不跑。
     */
    trace('timer:created');
    cleanups.push(() => clearInterval(timer));
    return () => clearInterval(timer);
  }, 'token-usage: timer');

  // 启动即刷新一次设置快照，然后跑第一轮 sweep。
  ctx.effect(() => {
    trace('startup:enter');
    void (async () => {
      try {
        await store.refresh();
        trace('startup:refreshed');
        await store.setLastBoot({ phase: 'ready' }).catch(() => {});
        await sweep();
        trace('startup:done');
      } catch (error) {
        // 失败必须留痕：否则界面只是"没数据"，而原因全在宿主里没人看得见。
        trace('startup:failed:' + message(error));
        await store.setLastBoot({ phase: 'failed', detail: message(error) }).catch(() => {});
        warn(ctx, `启动流程失败：${message(error)}`);
      }
    })();
  }, 'token-usage: startup');

  ctx.effect(() => () => {
    for (let index = cleanups.length - 1; index >= 0; index -= 1) {
      try {
        cleanups[index]();
      } catch {
        /* ignore */
      }
    }
    cleanups.length = 0;
    projectionDisposer = null;
  }, 'token-usage: teardown');

  return undefined;
}

/*
 * 测试接缝：把纯函数与折叠状态暴露给自检脚本。Cordis 只读
 * `inject` / `apply` / `name` / `Config`，多余导出会被忽略。
 */
export { tokenByModelUnit };
export * as fold from './lib/fold.js';
export const SUMMARY_TTL = SUMMARY_TTL_MS;
