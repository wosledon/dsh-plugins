/**
 * 跨会话汇总：读历史会话日志，按 (provider, model) 折叠出总量。
 *
 * 这是唯一必须由宿主做的事：浏览器侧拿不到别的会话的日志
 * （这些服务的方法都不是 `@Remote`）。
 *
 * ## 为什么支持两个来源
 *
 * 实测发现 `ctx.get('sessionQuery')` 在本 profile 里**返回 undefined**——
 * 它是「unified live-preferred session query」抽象，需要一个后端
 * （`dsh-session-query-sqlite`）实现；没有后端时它就不存在。
 * 而 `ctx.sessionPersistence`（append-only 的持久化服务）是**真实挂载**的，
 * 磁盘上那些 `session.v4.jsonl.zstd` 就是它写的。
 *
 * 所以两个都探测，取先可用的那个：
 *   - `sessionQuery`       → listSessions() / readSession(id)
 *   - `sessionPersistence` → list() / open(id,'read') → handle.read() → handle.close()
 *
 * 只认其中一个，就会在"对方不存在"的 profile 上静默失效——跨会话页面永远空着。
 *
 * 代价是 O(会话数 × 事件数)，所以：
 *   - 按创建时间**从新到旧**扫描，最新的先算；
 *   - 有 `scanLimit` 上限，超出时把 `truncated=true` 如实报给界面；
 *   - 单个会话读失败只跳过它并计数，不让一个坏日志毁掉整次扫描。
 */
import { applyAttempt, applyTimeline, emptyFold, emptyTimeline, rowsOf, timelineRows } from './fold.js';
import { SUMMARY_SHAPE } from './constants.js';

/**
 * 时间轴最多保留多少天。
 *
 * **必须 ≥ 客户端默认窗口的长度**（`client.js` 的 `DEFAULT_RANGE_DAYS = 365`）。
 * 原先这里是 90，对应"近三个月"的默认窗口；默认改成一年之后如果不同步抬高，
 * 一年视图里会有 9 个月是空列——**看起来像没有用量，实际是被宿主截掉了**，
 * 属于最糟的一类错误：显示与实际不一致，而且不报错。
 *
 * 366 含闰日，正好覆盖任何一整年。保留**最近**的，与"看近期趋势"的意图一致。
 * 这是可选数据的上限，不影响按模型的汇总（那个不截断）。
 */
export const TIMELINE_MAX_DAYS = 366;

/**
 * 单次会话读取的超时上限。
 *
 * **为什么必须有**：`runScan` 在调用这些 await 之前把 `scanning` 置为 `true`，
 * 而那是个闩锁——`finally` 里的复位只在 await 正常返回或抛错时执行。一旦
 * `open()` / `read()` 永不 resolve，闩锁就永久卡住，之后**每一轮** `sweep()`
 * 都会在 `if (scanning) return false` 处直接返回。
 *
 * 真机后果：一次挂起 = 跨会话汇总永久停止更新，而界面上只是"折线图没了"，
 * 没有任何报错。所以每一次读取都要有界。
 */
export const READ_TIMEOUT_MS = 20_000;

/**
 * 给一个 Promise 加超时。超时抛错（而不是返回空），让调用方按"这个会话读失败"
 * 处理——`buildSummary` 会把它计入 `skipped` 并继续下一个会话。
 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} 超时（${ms}ms）`));
    }, ms);
    if (typeof timer?.unref === 'function') timer.unref();
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * 各来源的适配：把两种 API 形状归一成 `listHeaders` / `readEvents`。
 * `has(source)` 同时充当能力探测——只有方法齐备才认。
 */
export const ADAPTERS = {
  query: {
    label: 'sessionQuery',
    has(source) {
      return typeof source?.listSessions === 'function' && typeof source?.readSession === 'function';
    },
    async listHeaders(source) {
      const records = await withTimeout(source.listSessions(), READ_TIMEOUT_MS, 'listSessions');
      return Array.isArray(records)
        ? records
          .filter((record) => record?.header?.id !== undefined)
          .map((record) => ({ id: record.header.id, createdAt: record.header.createdAt }))
        : [];
    },
    async readEvents(source, id) {
      const snapshot = await withTimeout(source.readSession(id), READ_TIMEOUT_MS, 'readSession');
      return Array.isArray(snapshot?.events) ? snapshot.events : [];
    },
  },
  persistence: {
    label: 'sessionPersistence',
    has(source) {
      return typeof source?.list === 'function' && typeof source?.open === 'function';
    },
    async listHeaders(source) {
      const snapshots = await withTimeout(source.list(), READ_TIMEOUT_MS, 'list');
      return Array.isArray(snapshots)
        ? snapshots
          .filter((snapshot) => snapshot?.header?.id !== undefined)
          .map((snapshot) => ({ id: snapshot.header.id, createdAt: snapshot.header.createdAt }))
        : [];
    },
    async readEvents(source, id) {
      const handle = await withTimeout(source.open(id, 'read'), READ_TIMEOUT_MS, 'open');
      try {
        const result = await withTimeout(handle.read(), READ_TIMEOUT_MS, 'read');
        return Array.isArray(result?.events) ? result.events : [];
      } finally {
        // read 句柄不持有所有权，但必须归还——否则反复扫描会长久攒下句柄。
        // 归还也加超时：一个卡住的 close 同样能拖死整轮扫描。
        if (typeof handle?.close === 'function') {
          try {
            await withTimeout(handle.close(), READ_TIMEOUT_MS, 'close');
          } catch {
            /* 归还失败不该让"已经读到的事件"作废 */
          }
        }
      }
    },
  },
};

/**
 * 探测可用的会话来源。
 *
 * @param {object} ctx Cordis 上下文
 * @returns {{available:boolean, kind?:string, label?:string, source?:object, reason?:string}}
 */
export function probeSessionSource(ctx) {
  const get = typeof ctx?.get === 'function' ? ctx.get.bind(ctx) : null;
  if (get === null) return { available: false, reason: 'ctx.get 不可用' };

  const tried = [];
  for (const [kind, adapter] of Object.entries(ADAPTERS)) {
    let source;
    try {
      source = get(adapter.label);
    } catch {
      source = undefined;
    }
    if (adapter.has(source)) {
      return { available: true, kind, label: adapter.label, source };
    }
    tried.push(adapter.label);
  }
  return { available: false, reason: `找不到可用的会话来源（试过 ${tried.join('、')}）` };
}

/** 从列表项里取创建时间；取不到就当 0（排到最后）。 */
function createdAtOf(entry) {
  return Number.isFinite(entry?.createdAt) ? entry.createdAt : 0;
}

/**
 * 扫描并折叠跨会话用量。
 *
 * @param {object} probe `probeSessionSource()` 的结果
 * @param {object} options `{ limit }`
 * @returns {Promise<object>} 汇总对象（形状与 Config 的 summarySchema 一致）
 */
export async function buildSummary(probe, options = {}) {
  const adapter = probe?.available === true ? ADAPTERS[probe.kind] : undefined;
  if (adapter === undefined) throw new Error(probe?.reason ?? '没有可用的会话来源');
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : 200;

  const headers = await adapter.listHeaders(probe.source);
  // 最新的先扫：截断时留下的是"最近的"，而不是"字典序靠前的"。
  const ordered = headers.slice().sort((left, right) => createdAtOf(right) - createdAtOf(left));
  const window = ordered.slice(0, limit);

  let state = emptyFold();
  let timeline = emptyTimeline();
  let skipped = 0;
  for (const entry of window) {
    try {
      const events = await adapter.readEvents(probe.source, entry.id);
      for (const event of events) {
        state = applyAttempt(state, event);
        // 时间轴按**事件自身的时间**归日，而不是会话的 createdAt —— 会话可能
        // 横跨多天，按 createdAt 会把后几天的用量全算到第一天。
        timeline = applyTimeline(timeline, event);
      }
    } catch {
      // 一个会话的日志坏了/被截断，不该让整次扫描失败。
      skipped += 1;
    }
  }

  return {
    // 形状版本：字段变化时必须与 SUMMARY_SHAPE 一起递增，否则升级后旧数据
    // 会被 TTL 挡住而不重扫（折线图会一直空着）。
    shape: SUMMARY_SHAPE,
    rows: rowsOf(state),
    // 折线图的数据源。缺失时界面必须降级为"不画"，而不是画一条歪的。
    timeline: timelineRows(timeline, TIMELINE_MAX_DAYS),
    scanned: window.length,
    total: ordered.length,
    truncated: ordered.length > window.length,
    skipped,
    source: adapter.label,
    builtAt: Date.now(),
  };
}
