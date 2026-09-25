/**
 * 跨会话汇总：读历史会话日志，按 (provider, model) 折叠出总量。
 *
 * 这是唯一必须由宿主做的事：浏览器半拿不到别的会话的日志
 * （`ctx.sessionQuery` 的方法都不是 `@Remote`）。
 *
 * 代价是 O(会话数 × 事件数)，所以：
 *   - 按创建时间**从新到旧**扫描，最新的先算；
 *   - 有 `scanLimit` 上限，超出时把 `truncated=true` 如实报给界面，
 *     而不是悄悄少算几个会话；
 *   - 单个会话读失败只跳过它并计数，不让一个坏日志毁掉整次扫描。
 */
import { applyAttempt, emptyFold, rowsOf } from './fold.js';

/**
 * @param {object} ctx Cordis 上下文（用来取 sessionQuery）
 * @returns {{available:boolean, reason?:string, query?:object}}
 */
export function probeSessionQuery(ctx) {
  const query = typeof ctx?.get === 'function' ? ctx.get('sessionQuery') : undefined;
  if (query === null || typeof query !== 'object') {
    return { available: false, reason: 'sessionQuery 服务不可用' };
  }
  if (typeof query.listSessions !== 'function' || typeof query.readSession !== 'function') {
    return { available: false, reason: 'sessionQuery 缺少 listSessions/readSession' };
  }
  return { available: true, query };
}

/** 从会话记录里取创建时间；取不到就当 0（排到最后）。 */
function createdAtOf(record) {
  const value = record?.header?.createdAt;
  return Number.isFinite(value) ? value : 0;
}

/**
 * 扫描并折叠跨会话用量。
 *
 * @param {object} query `ctx.sessionQuery`
 * @param {object} options `{ limit }`
 * @returns {Promise<object>} 汇总对象（形状与 Config 的 summarySchema 一致）
 */
export async function buildSummary(query, options = {}) {
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : 200;

  const records = await query.listSessions();
  const list = Array.isArray(records) ? records.filter((record) => record?.header?.id !== undefined) : [];
  // 最新的先扫：截断时留下的是"最近的"，而不是"字典序靠前的"。
  const ordered = list.slice().sort((left, right) => createdAtOf(right) - createdAtOf(left));
  const window = ordered.slice(0, limit);

  let state = emptyFold();
  let skipped = 0;
  for (const record of window) {
    try {
      const snapshot = await query.readSession(record.header.id);
      const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
      for (const event of events) state = applyAttempt(state, event);
    } catch {
      // 一个会话的日志坏了/被截断，不该让整次扫描失败。
      skipped += 1;
    }
  }

  return {
    rows: rowsOf(state),
    scanned: window.length,
    total: ordered.length,
    truncated: ordered.length > window.length,
    skipped,
    builtAt: Date.now(),
  };
}
