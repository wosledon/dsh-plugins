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

/**
 * 时间轴最多保留多少天。
 *
 * 会话历史可能有几年；把上千个点塞进折线图既画不清也没意义。保留**最近**的，
 * 与"看近期趋势"的意图一致。这是可选数据的上限，不影响按模型的汇总（那个不截断）。
 */
export const TIMELINE_MAX_DAYS = 90;

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
      const records = await source.listSessions();
      return Array.isArray(records)
        ? records
          .filter((record) => record?.header?.id !== undefined)
          .map((record) => ({ id: record.header.id, createdAt: record.header.createdAt }))
        : [];
    },
    async readEvents(source, id) {
      const snapshot = await source.readSession(id);
      return Array.isArray(snapshot?.events) ? snapshot.events : [];
    },
  },
  persistence: {
    label: 'sessionPersistence',
    has(source) {
      return typeof source?.list === 'function' && typeof source?.open === 'function';
    },
    async listHeaders(source) {
      const snapshots = await source.list();
      return Array.isArray(snapshots)
        ? snapshots
          .filter((snapshot) => snapshot?.header?.id !== undefined)
          .map((snapshot) => ({ id: snapshot.header.id, createdAt: snapshot.header.createdAt }))
        : [];
    },
    async readEvents(source, id) {
      const handle = await source.open(id, 'read');
      try {
        const result = await handle.read();
        return Array.isArray(result?.events) ? result.events : [];
      } finally {
        // read 句柄不持有所有权，但必须归还——否则反复扫描会长久攒下句柄。
        if (typeof handle?.close === 'function') await handle.close();
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
