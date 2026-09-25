/**
 * 无依赖常量。
 *
 * 单独成文件的原因：`lib/model.js`、`lib/cron.js` 这些纯逻辑必须是**可独立
 * 测试**的，不能因为 `lib/config.js` 需要 `@deepseek-ai/schemastery`
 * （只有 DSH 运行时能解析它）而连带把纯函数测试也拖死。
 */

/** 本插件 Loader 行 id，同时也是设置命名空间（客户端 mutate 用的 ns）。 */
export const CONFIG_NS = 'scheduled-tasks';

/** 运行日志环形缓冲的默认条数上限。 */
export const LOG_LIMIT_DEFAULT = 200;
/** 默认轮询间隔（毫秒）。cron 最小粒度是分钟，30s 足够且开销小。 */
export const TICK_MS_DEFAULT = 30_000;
/** 默认同时运行的任务数上限。 */
export const MAX_CONCURRENT_DEFAULT = 2;
/** 默认单次运行超时（毫秒），30 分钟。 */
export const RUN_TIMEOUT_DEFAULT = 1_800_000;

/** 单个字段的长度上限，与 CONTRACT.md §2 一致。 */
export const LIMITS = {
  title: 120,
  prompt: 20_000,
  summary: 4_000,
  error: 1_000,
};
