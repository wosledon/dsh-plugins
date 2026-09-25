/**
 * 插件 Config（schemastery）。
 *
 * 只有 `internal` 是 `.volatile()`，原因是一条硬规则：
 * `@deepseek-ai/dsh-settings` 的 `describe()` **只投影 `.volatile()` 节点**，
 * 而 `mutate()` 在没有 volatile 字段时直接抛 `has no volatile fields`。
 *
 * 本插件所有需要读回界面的数据（跨会话汇总、刷新请求）都住在 `internal` 里，
 * 所以把 `internal` 整个标成 volatile 即可，不需要别的手段。
 */
import Schema from '@deepseek-ai/schemastery';

/** 四个用量桶。与 lib/fold.js 的口径一致，刻意不含 reasoningTokens。 */
const bucketSchema = Schema.object({
  uncachedInputTokens: Schema.number().default(0),
  outputTokens: Schema.number().default(0),
  cacheReadTokens: Schema.number().default(0),
  cacheWriteTokens: Schema.number().default(0),
});

/** 汇总表的一行：一个 (provider, model) 的用量。 */
const rowSchema = Schema.object({
  key: Schema.string().required(),
  provider: Schema.string().default('unknown'),
  model: Schema.string().default('unknown'),
  buckets: bucketSchema,
  total: Schema.number().default(0),
  attempts: Schema.number().default(0),
});

/**
 * 跨会话汇总。
 *
 * `truncated` 必须留着：扫描有上限，界面得能说清"这不是全部"，
 * 否则用户会把一个被截断的数字当成历史总量。
 */
const summarySchema = Schema.object({
  rows: Schema.array(rowSchema).default([]),
  scanned: Schema.number().default(0),
  total: Schema.number().default(0),
  truncated: Schema.boolean().default(false),
  /**
   * 日志读取失败而被跳过的会话数。
   *
   * 必须在这里声明：`buildSummary()` 会返回它，而 schemastery 对未声明的字段
   * 要么剥离要么拒绝——两者都坏（前者让界面丢字段，后者让整次落盘失败）。
   * 这个字段在真机上一直没被验证过，因为只写过 lastSweep、没写过 summary。
   */
  skipped: Schema.number().default(0),
  /** 实际用了哪个数据源（`sessionQuery` 或 `sessionPersistence`）；诊断用。 */
  source: Schema.string(),
  builtAt: Schema.number(),
});

/** 上一次扫描的自述结果：界面据此说明"为什么没有数据"。 */
const lastSweepSchema = Schema.object({
  at: Schema.number(),
  ok: Schema.boolean().default(false),
  /** 失败原因或跳过原因；成功时为空。 */
  detail: Schema.string(),
});

export const Config = Schema.object({
  /**
   * 一次刷新最多扫描多少个会话（按最新优先）。
   * 读历史日志是 O(会话数 × 事件数)，必须有上限，否则首次刷新会卡住宿主。
   */
  scanLimit: Schema.number().default(200),

  internal: Schema.object({
    summary: summarySchema,
    /** 客户端写入的刷新请求时间戳；宿主取走后清空。 */
    refreshRequestedAt: Schema.number(),
    lastSweep: lastSweepSchema,
  }).volatile(),
});
