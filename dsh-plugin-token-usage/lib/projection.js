/**
 * 会话投影单元：`tokenByModel`。
 *
 * 官方实践规则（`cordis-plugin-development/references/practices.md`）：
 *   「When the Client needs a value derived from a session, declare `wire.view`
 *     on the Host projection. The value reaches the Client already computed;
 *     the Client does not fold session events itself.」
 *
 * 所以按模型拆分的用量在**宿主**算好，通过 `wire.view` 投给客户端，
 * 客户端只 `useProjection('tokenByModel')` 取值，不接触事件流。
 *
 * 为什么不用官方 `dsh-token-meter` 已有的 `tokenUsage`：那个投影只有整个会话的
 * 四个桶合计，没有按模型拆分。本插件需要的正是拆分后的视图。
 */
import { z } from 'zod';
import { PROJECTION_STATE_VERSION, TOKEN_BY_MODEL_KEY } from './constants.js';
import { applyAttempt, emptyFold, emptyBuckets, rowsOf, totalOf } from './fold.js';

const bucketSchema = z.object({
  uncachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
});

const entrySchema = z.object({
  provider: z.string(),
  model: z.string(),
  buckets: bucketSchema,
  attempts: z.number().int().nonnegative(),
});

const stateSchema = z.object({
  byModel: z.record(z.string(), entrySchema),
  attempts: z.number().int().nonnegative(),
  unattributed: z.number().int().nonnegative(),
});

const wireRowSchema = z.object({
  key: z.string(),
  provider: z.string(),
  model: z.string(),
  buckets: bucketSchema,
  total: z.number().int().nonnegative(),
  attempts: z.number().int().nonnegative(),
});

/**
 * 客户端可见的值。
 *
 * `rows` 已按总量降序：排序在纯函数层做，宿主与客户端共用同一个顺序，
 * 免得两处各排一次而后不一致。
 */
const viewSchema = z.object({
  rows: z.array(wireRowSchema),
  totals: bucketSchema,
  total: z.number().int().nonnegative(),
  attempts: z.number().int().nonnegative(),
  unattributed: z.number().int().nonnegative(),
});

/** 由折叠状态汇总出四个桶的总计。 */
function totalsOf(state) {
  const totals = emptyBuckets();
  for (const entry of Object.values(state.byModel ?? {})) {
    const buckets = entry?.buckets;
    if (buckets === null || typeof buckets !== 'object') continue;
    totals.uncachedInputTokens += buckets.uncachedInputTokens ?? 0;
    totals.outputTokens += buckets.outputTokens ?? 0;
    totals.cacheReadTokens += buckets.cacheReadTokens ?? 0;
    totals.cacheWriteTokens += buckets.cacheWriteTokens ?? 0;
  }
  return totals;
}

/**
 * 投影单元定义，直接交给 `ctx.sessionProjections.register(...)`。
 *
 * `apply` 是纯的且对无关事件返回同一引用——投影层靠引用相等抑制下游重算，
 * 所以这里绝不 clone 状态。
 */
export const tokenByModelUnit = {
  key: TOKEN_BY_MODEL_KEY,
  stateVersion: PROJECTION_STATE_VERSION,
  stateSchema,
  init: () => emptyFold(),
  apply: (state, event) => applyAttempt(state, event),
  wire: {
    viewSchema,
    view: (state) => {
      const safe = state !== null && typeof state === 'object' ? state : emptyFold();
      const totals = totalsOf(safe);
      return {
        rows: rowsOf(safe),
        totals,
        total: totalOf(totals),
        attempts: safe.attempts ?? 0,
        unattributed: safe.unattributed ?? 0,
      };
    },
  },
};
