/**
 * Config 定义与常量。
 *
 * Config 是本插件**唯一的持久化状态**：任务定义在 `tasks`，运行日志在 `internal.log`。
 * 客户端通过 `remote.settings.describe()` 读取、`remote.settings.mutate()` 写回；
 * 宿主通过 `lib/store.js` 用同一通道写回。
 *
 * 为什么客户端不用自定义 Remote：DSH 的 `ctx.remote` namespace 是**编译期固定
 * 白名单**，由各官方包在构建期生成 contribution 后 `ctx.remote.$mount()` 装载。
 * 第三方纯 JS 插件没有构建步骤，无法新增 namespace，因此只能复用既有通道。
 * `remote.settings` 是唯一一个「按命名空间整体读写任意 JSON」的既有通道。
 */
import Schema from '@deepseek-ai/schemastery';
import {
  CONFIG_NS,
  LIMITS,
  LOG_LIMIT_DEFAULT,
  MAX_CONCURRENT_DEFAULT,
  RUN_TIMEOUT_DEFAULT,
  TICK_MS_DEFAULT,
} from './constants.js';

// 常量集中定义在无依赖的 constants.js，这里重新导出，保持既有导入路径可用。
export {
  CONFIG_NS,
  LIMITS,
  LOG_LIMIT_DEFAULT,
  MAX_CONCURRENT_DEFAULT,
  RUN_TIMEOUT_DEFAULT,
  TICK_MS_DEFAULT,
};

const scheduleSchema = Schema.union([
  Schema.object({
    kind: Schema.const('every').required(),
    everyMinutes: Schema.number().min(30).max(43_200).required(),
  }),
  Schema.object({
    kind: Schema.const('daily').required(),
    time: Schema.string().required(),
  }),
  Schema.object({
    kind: Schema.const('weekly').required(),
    time: Schema.string().required(),
    weekdays: Schema.array(Schema.number()).required(),
  }),
  Schema.object({
    kind: Schema.const('cron').required(),
    expression: Schema.string().required(),
  }),
  Schema.object({
    kind: Schema.const('once').required(),
    at: Schema.number().required(),
  }),
]);

const taskSchema = Schema.object({
  id: Schema.string().required(),
  title: Schema.string().required(),
  prompt: Schema.string().required(),
  enabled: Schema.boolean().default(true),
  schedule: scheduleSchema.required(),
  skill: Schema.string(),
  tools: Schema.array(Schema.string()),
  workspaceRoot: Schema.string(),
  // model 是可选的；内部字段若写 `.required()`，schemastery 会在 model 缺席时
  // 仍然要求这些子字段，导致校验失败。真正的「必须成对且非空」由
  // model.js 的 validateTask 负责。
  //
  // reasoningEffort 是**该模型自带**的可选强度，来自它自己的 reasoning.efforts；
  // 模型不支持推理时该字段无意义。省略整个 model 表示「跟随会话默认模型」。
  model: Schema.object({
    provider: Schema.string(),
    model: Schema.string(),
    reasoningEffort: Schema.string(),
  }),
  createdAt: Schema.number().required(),
  updatedAt: Schema.number().required(),
  lastRunAt: Schema.number(),
  nextRunAt: Schema.number(),
  lastStatus: Schema.string(),
});

const logSchema = Schema.object({
  seq: Schema.number().required(),
  taskId: Schema.string().required(),
  title: Schema.string().required(),
  startedAt: Schema.number().required(),
  endedAt: Schema.number().required(),
  status: Schema.string().required(),
  trigger: Schema.string().required(),
  sessionId: Schema.string(),
  summary: Schema.string().default(''),
  error: Schema.string(),
  toolCalls: Schema.number(),
});

/**
 * 插件 Config。
 *
 * **`tasks` 与 `internal` 必须声明为 volatile，这是本插件架构的关键一步。**
 * `@deepseek-ai/dsh-settings` 的 `describe()` 只投影 schema 里被
 * `.volatile()` 标记的节点（见其 `volatileForm` / `projectForm`）：普通字段
 * 不会出现在 descriptor 的 `value`/`user` 里，而且没有任何 volatile 字段的条目
 * 会让 `mutate()` 直接抛 "has no volatile fields"。
 *
 * 由于第三方插件无法新增 Remote namespace，`remote.settings` 是本插件
 * 与浏览器半之间**唯一**可用的读写通道，所以这两个节点必须可读写：
 *   - `tasks`     —— 任务定义，界面与模型工具都写它；
 *   - `internal`  —— 宿主自用的运行日志与去重表，界面只读。
 * `workspaceRoot` 等普通字段不在表单里，通过 `cordis.patch.yml` 配置。
 */
export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  tickMs: Schema.number().min(1_000).max(3_600_000).default(TICK_MS_DEFAULT),
  maxConcurrentRuns: Schema.number().min(1).max(16).default(MAX_CONCURRENT_DEFAULT),
  runTimeoutMs: Schema.number().min(1_000).max(86_400_000).default(RUN_TIMEOUT_DEFAULT),
  logLimit: Schema.number().min(1).max(5_000).default(LOG_LIMIT_DEFAULT),
  workspaceRoot: Schema.string(),
  tasks: Schema.array(taskSchema).default([]).volatile(),
  internal: Schema.object({
    log: Schema.array(logSchema).default([]),
    runs: Schema.any().default({}),
    // 「立即运行」请求队列。浏览器半不能创建 Agent，所以它只能把意图写成数据，
    // 由宿主的调度器在下一次 tick 消费（见 lib/scheduler.js drainManualRuns）。
    manualRuns: Schema.array(Schema.object({
      taskId: Schema.string().required(),
      requestedAt: Schema.number().required(),
    })).default([]),
    // 模型目录（只读，界面用来选大模型与推理强度）。
    // 客户端的 `ctx.remote` 拿不到 `llm.listModels`（它不是 @Remote），所以由宿主
    // 算好写在这里，界面从它本来就要读的那次 describe() 一并取走。
    catalog: Schema.object({
      providers: Schema.array(Schema.object({
        id: Schema.string().required(),
        displayName: Schema.string(),
        models: Schema.array(Schema.object({
          id: Schema.string().required(),
          name: Schema.string(),
          description: Schema.string(),
          efforts: Schema.array(Schema.object({ id: Schema.string(), name: Schema.string() })),
          defaultEffort: Schema.string(),
        })),
      })),
      builtAt: Schema.number(),
    }),
  }).default({ log: [], runs: {}, manualRuns: [] }).volatile(),
});

/**
 * 把 schemastery 解析产物还原成普通 JSON 值。
 *
 * `.volatile()` 字段解析后不是数据本身，而是一个带 `get()` / 写入器符号的
 * 访问器对象（schemastery 为了让 volatile 字段无需重挂载即可改写而设计的活引用）。
 * 直接读它会把访问器当成数组/对象用，所以必须先解包——这正是
 * `@deepseek-ai/dsh-settings` 自己的 `plainConfig()` 做的事。
 *
 * 这里用鸭子类型判断而不是 import `isVolatile`：schemastery 的实现细节变了也不会
 * 让归一化跟着崩，最坏情况就是退化成「原样返回」。
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function plainConfig(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function'
    && Object.getOwnPropertySymbols(value).some((symbol) => String(symbol).includes('volatile'))) {
    try {
      return plainConfig(value.get());
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) return value.map(plainConfig);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plainConfig(child)]));
  }
  return value;
}

/**
 * 把 Loader 传来的 Config 归一化成完整形状。
 * 手写而不是信任 Loader 归一化：`apply()` 可能被直接调用（测试、HMR），
 * 也可能收到 volatile 访问器而不是普通值。
 *
 * @param {unknown} raw
 * @returns {{ enabled: boolean, tickMs: number, maxConcurrentRuns: number,
 *            runTimeoutMs: number, logLimit: number, workspaceRoot: string|undefined,
 *            tasks: object[], internal: { log: object[], runs: object } }}
 */
export function resolveConfig(raw) {
  const unwrapped = plainConfig(raw);
  const config = unwrapped !== null && typeof unwrapped === 'object' ? unwrapped : {};
  const internal = config.internal !== null && typeof config.internal === 'object' ? config.internal : {};
  return {
    enabled: config.enabled !== false,
    tickMs: positiveInt(config.tickMs, TICK_MS_DEFAULT),
    maxConcurrentRuns: positiveInt(config.maxConcurrentRuns, MAX_CONCURRENT_DEFAULT),
    runTimeoutMs: positiveInt(config.runTimeoutMs, RUN_TIMEOUT_DEFAULT),
    logLimit: positiveInt(config.logLimit, LOG_LIMIT_DEFAULT),
    workspaceRoot: typeof config.workspaceRoot === 'string' && config.workspaceRoot !== ''
      ? config.workspaceRoot
      : undefined,
    tasks: Array.isArray(config.tasks) ? config.tasks : [],
    internal: {
      log: Array.isArray(internal.log) ? internal.log : [],
      runs: internal.runs !== null && typeof internal.runs === 'object' && !Array.isArray(internal.runs)
        ? internal.runs
        : {},
      manualRuns: Array.isArray(internal.manualRuns) ? internal.manualRuns : [],
      catalog: internal.catalog !== null && typeof internal.catalog === 'object'
        ? internal.catalog
        : undefined,
    },
  };
}

function positiveInt(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
