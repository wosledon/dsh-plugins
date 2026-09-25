/**
 * 依赖无关的常量。
 *
 * 单独成文件是为了让纯函数模块能被离线测试脚本直接 import —— 不牵扯
 * schemastery、zod 或任何 DSH 包，测试脚本零依赖即可运行。
 */

/** 插件 id：Loader 行 id、席位 key、locale 命名空间都用它。 */
export const PLUGIN_ID = 'token-usage';

/** settings 命名空间：等于 Loader 行 id（`ns = entry.options.id`）。 */
export const CONFIG_NS = 'token-usage';

/** 侧边栏面板与主页面共用的席位 id。 */
export const PANEL_ID = 'token-usage';

/**
 * 投影单元 key。
 *
 * 客户端用 `useProjection(TOKEN_BY_MODEL_KEY)` 读它。这不是官方已有的 key，
 * 是本插件自己注册的；官方 `dsh-token-meter` 注册的 `tokenUsage` 只有全会话
 * 总量，没有按模型拆分，所以要自己来。
 */
export const TOKEN_BY_MODEL_KEY = 'tokenByModel';

/** 投影状态版本：字段或折叠语义变化时必须递增，否则旧检查点会被当成新数据。 */
export const PROJECTION_STATE_VERSION = 1;

/** 服务端汇总的默认扫描上限（会话数），避免首次刷新就把历史全读一遍。 */
export const DEFAULT_SCAN_LIMIT = 200;

/** 汇总结果的过期时间：超过这个时长，界面会提示数据已陈旧。 */
export const SUMMARY_TTL_MS = 300_000;

/**
 * 汇总的**形状版本**。改动 `buildSummary()` 的返回字段时必须递增。
 *
 * 没有它就会踩到真实的坑：插件升级后新增了 `timeline`，但落盘的旧 summary
 * 仍在 TTL（5 分钟）内，于是宿主判定"还没过期"而**不重扫**——界面上折线图
 * 空着，用户以为功能坏了，其实只是旧数据被沿用。递增这个版本号会让升级后的
 * 第一次 sweep 立刻重扫，而不是等 TTL。
 */
export const SUMMARY_SHAPE = 2;

/**
 * 同一会话内两条 usage 的归并口径。
 *
 * 与官方 `dsh-token-meter` 的 `tokenUsage` 投影保持一致的四个桶：
 * 未命中缓存的输入、输出、缓存读、缓存写。
 *
 * 刻意**不含** `reasoningTokens`：它通常是 `outputTokens` 的子集，
 * 单独一列既会和官方数字对不上，也容易让人误加成总量。
 */
export const BUCKET_KEYS = Object.freeze([
  'uncachedInputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
]);

/** 中文/英文都用的紧凑数字后缀，避免两处各写一份。 */
export const SCALE_SUFFIXES = Object.freeze([
  { threshold: 1e9, suffix: 'B', divisor: 1e9 },
  { threshold: 1e6, suffix: 'M', divisor: 1e6 },
  { threshold: 1e3, suffix: 'K', divisor: 1e3 },
]);
