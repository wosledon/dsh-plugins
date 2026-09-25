/**
 * 纯折叠：把会话事件里的提供方上报用量，按 (provider, model) 归并。
 *
 * 这一层不 import 任何东西（除常量），所以能在零依赖的 Node 下完整测试。
 * 宿主半与自检脚本共用它，保证「脚本测过的」就是「真机跑的」。
 *
 * 数据来源：会话日志的 `assistant/message` 事件。
 *
 *     { type: 'assistant/message', data: {
 *         turn, step,
 *         message: { source: { kind: 'model', provider, model } },
 *         usage?: { inputTokens, outputTokens, totalTokens?,
 *                   cacheReadTokens?, cacheWriteTokens?, reasoningTokens? },
 *     } }
 */
import { BUCKET_KEYS, SCALE_SUFFIXES } from './constants.js';

/**
 * 把一条提供方上报的 usage 归一成四个桶。
 *
 * 缺失字段一律按 0 处理：适配器不报缓存时不能当成"没有缓存"，只能说"未上报"，
 * 所以这里不回填猜测值，只如实记 0。
 *
 * @param {unknown} usage 事件上的 `usage` 字段
 * @returns {{uncachedInputTokens:number,outputTokens:number,cacheReadTokens:number,cacheWriteTokens:number}|null}
 *          不是可用的用量对象时返回 null
 */
export function bucketsOf(usage) {
  if (usage === null || typeof usage !== 'object') return null;
  const input = countOf(usage.inputTokens);
  const output = countOf(usage.outputTokens);
  if (input === null && output === null) return null;
  return {
    uncachedInputTokens: input ?? 0,
    outputTokens: output ?? 0,
    cacheReadTokens: countOf(usage.cacheReadTokens) ?? 0,
    cacheWriteTokens: countOf(usage.cacheWriteTokens) ?? 0,
  };
}

/** 非负整数才认；其它一律 null（"未上报"），不钳成 0 之外的值。 */
function countOf(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

/** 四个桶相加。用于展示的"总 token 数"。 */
export function totalOf(buckets) {
  if (buckets === null || typeof buckets !== 'object') return 0;
  let sum = 0;
  for (const key of BUCKET_KEYS) {
    const value = buckets[key];
    if (Number.isFinite(value) && value > 0) sum += value;
  }
  return sum;
}

/** 全零桶。 */
export function emptyBuckets() {
  return {
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

/** 逐桶相加，返回新对象（不改入参）。 */
export function addBuckets(left, right) {
  const out = emptyBuckets();
  for (const key of BUCKET_KEYS) {
    out[key] = (left?.[key] ?? 0) + (right?.[key] ?? 0);
  }
  return out;
}

/**
 * 从一条会话事件里取出「一次计费尝试」。
 *
 * 只认 `assistant/message`：`assistant/attempt` 只有流记录、没有用量，
 * 用量只在成功结算的 assistant 消息上。一次重试会各留一条 `assistant/message`，
 * 所以按条累加天然等于「计费次数」，与官方 token-meter 的口径一致。
 *
 * @param {unknown} event
 * @returns {{key:string,provider:string,model:string,buckets:object}|null}
 */
export function attemptOf(event) {
  if (event === null || typeof event !== 'object') return null;
  if (event.type !== 'assistant/message') return null;
  const data = event.data;
  if (data === null || typeof data !== 'object') return null;
  const buckets = bucketsOf(data.usage);
  if (buckets === null) return null;
  const identity = modelIdentityOf(data.message);
  return {
    key: identity.key,
    provider: identity.provider,
    model: identity.model,
    buckets,
  };
}

/**
 * 取消息的来源 provider/model。
 *
 * 只认 `source.kind === 'model'`：system-prompt 与工具结果的消息也带 source，
 * 但它们不代表一次模型调用，混进来会把用量记到错误的对象上。
 * 认不出时归到 `unknown` 桶，而不是丢掉——丢掉会让总量和提供方对不上。
 */
export function modelIdentityOf(message) {
  const source = message !== null && typeof message === 'object' ? message.source : undefined;
  if (source !== null && typeof source === 'object' && source.kind === 'model') {
    const provider = textOf(source.provider);
    const model = textOf(source.model);
    if (provider !== null && model !== null) {
      return { provider, model, key: provider + '/' + model };
    }
    if (provider !== null) return { provider, model: 'unknown', key: provider + '/unknown' };
  }
  return { provider: 'unknown', model: 'unknown', key: 'unknown/unknown' };
}

function textOf(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * 空折叠状态。投影单元的 `init()` 直接返回它。
 */
export function emptyFold() {
  return { byModel: {}, attempts: 0, unattributed: 0 };
}

/**
 * 把一次尝试并入折叠状态，返回**新**状态。
 *
 * 纯函数（不改入参、不读时钟）：投影单元要求 `apply` 是纯的，且对不关心的事件
 * 返回同一引用，这样下游才不会因为无变化而重算。
 *
 * @param {object} state
 * @param {unknown} event
 * @returns {object} 新状态；事件与用量无关时返回原引用
 */
export function applyAttempt(state, event) {
  const attempt = attemptOf(event);
  if (attempt === null) return state;
  const base = state !== null && typeof state === 'object' ? state : emptyFold();
  const byModel = { ...(base.byModel ?? {}) };
  const previous = byModel[attempt.key];
  byModel[attempt.key] = {
    provider: attempt.provider,
    model: attempt.model,
    buckets: addBuckets(previous?.buckets, attempt.buckets),
    attempts: (previous?.attempts ?? 0) + 1,
  };
  return {
    byModel,
    attempts: (base.attempts ?? 0) + 1,
    // 归不到具体模型的尝试数：单独计数，界面才能解释"为什么分项之和小于总量"。
    unattributed: (base.unattributed ?? 0) + (attempt.provider === 'unknown' ? 1 : 0),
  };
}

/**
 * 折叠一整串事件。宿主汇总历史会话时用它。
 *
 * @param {Iterable<unknown>} events
 * @returns {object} 折叠状态
 */
export function foldEvents(events) {
  let state = emptyFold();
  for (const event of events) state = applyAttempt(state, event);
  return state;
}

/**
 * 把折叠状态摊平成**按总量降序**的数组。
 *
 * 排序放在这里而不是界面里：宿主与客户端都要同一个顺序，
 * 两处各排一次早晚会不一致。
 *
 * @param {object} state
 * @returns {Array<{key,provider,model,buckets,total,attempts}>}
 */
export function rowsOf(state) {
  const byModel = state !== null && typeof state === 'object' ? state.byModel ?? {} : {};
  const rows = [];
  for (const [key, entry] of Object.entries(byModel)) {
    if (entry === null || typeof entry !== 'object') continue;
    rows.push({
      key,
      provider: String(entry.provider ?? 'unknown'),
      model: String(entry.model ?? 'unknown'),
      buckets: { ...emptyBuckets(), ...(entry.buckets ?? {}) },
      total: totalOf(entry.buckets),
      attempts: Number.isFinite(entry.attempts) ? entry.attempts : 0,
    });
  }
  // 总量相同时按 key 排序，保证顺序稳定（否则同一份数据每次刷新可能换序）。
  rows.sort((left, right) => (right.total - left.total) || left.key.localeCompare(right.key));
  return rows;
}

/**
 * 紧凑格式化 token 数：1234 → "1.2K"。
 *
 * 与官方 ContextMeter 的口径一致（小于 1000 显示原值；千位以上保留一位小数，
 * 但超过 100 时取整，避免 "123.4K" 这种无意义的精度）。
 *
 * @param {number} value
 * @returns {string}
 */
export function formatTokens(value) {
  if (!Number.isFinite(value) || value < 0) return '0';
  const rounded = Math.floor(value);
  for (const { threshold, suffix, divisor } of SCALE_SUFFIXES) {
    if (rounded >= threshold) {
      const scaled = rounded / divisor;
      return (scaled >= 100 ? String(Math.round(scaled)) : String(Math.round(scaled * 10) / 10)) + suffix;
    }
  }
  return String(rounded);
}

/**
 * 完整的千分位格式化，用于明细里需要精确读数的地方。
 *
 * @param {number} value
 * @returns {string}
 */
export function formatExact(value) {
  if (!Number.isFinite(value) || value < 0) return '0';
  return String(Math.floor(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
