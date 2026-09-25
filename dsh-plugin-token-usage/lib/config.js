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

/** 时间轴的一天：折线图的一个数据点。 */
const daySchema = Schema.object({
  day: Schema.string().required(),
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
  /**
   * 形状版本。缺失（旧数据）或与代码里的 `SUMMARY_SHAPE` 不一致时，
   * 宿主会立刻重扫而不是等 TTL——插件升级后新增字段能马上生效。
   */
  shape: Schema.number(),
  rows: Schema.array(rowSchema).default([]),
  /**
   * 折线图的数据源，按本地日期升序。
   *
   * 老数据没有这个字段，所以**不能** required；界面在它缺失或为空时
   * 必须降级为"不画折线"，而不是画一条歪的。
   */
  timeline: Schema.array(daySchema).default([]),
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

/**
 * 宿主半的自述心跳。
 *
 * 存在的理由是一次真实的排查困境：`apply()` 当时**没有任何可观测出口**——
 * 数据没落盘时，无法区分"apply 没被调用"、"apply 抛错了"、"定时器没跑"、
 * 还是"扫描还没结束"。只能靠外部进程 CPU 采样与姊妹插件对照去猜。
 *
 * 这两条记录让下一次重启直接给出答案：
 *   - `lastBoot`：apply 是否进入、是否抛错、抛了什么；
 *   - `heartbeat`：定时器是否在转（tick 计数 + 最后一次时间）。
 */
const lastBootSchema = Schema.object({
  at: Schema.number(),
  /** 'enter' = apply 已进入；'ready' = 装配完成；'failed' = 抛错。 */
  phase: Schema.string(),
  detail: Schema.string(),
});

const heartbeatSchema = Schema.object({
  ticks: Schema.number().default(0),
  lastTickAt: Schema.number(),
});

/**
 * 宿主半的**里程碑字符串**：只保留"最后到达的那一步"。
 *
 * 为什么是一个字符串而不是一堆布尔：真机排查已经花了四轮重启，每轮只能回答一个
 * 是/否问题。一条"最后到达哪一步"的记录能在**一次**启动里把范围缩到一个点——
 * 是 `timer:created` 之后就没动静（定时器建了但没触发），还是连 `apply:enter`
 * 都没有（apply 根本没被调用）。
 *
 * 取值形如 `startup:refreshed`、`timer:tick:3`、`scan:built`。
 */
const traceSchema = Schema.string();

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
    lastBoot: lastBootSchema,
    heartbeat: heartbeatSchema,
    trace: traceSchema,
  }).volatile(),
});
