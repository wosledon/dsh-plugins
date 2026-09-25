/**
 * 配置 schema。
 *
 * 形状用 schemastery 声明，两条来自真机教训：
 *
 * 1. **`buildSummary` 返回的每个字段都必须在这里声明。** schemastery 对未声明
 *    字段会剥离或拒绝，于是"代码算出来了但界面拿不到"，且不报错。
 * 2. **不要把 `default([])` 当成兜底。** 实测：schemastery **不会**为
 *    `.volatile()` 节点里缺失的嵌套数组填充默认值，旧数据会如实是 `undefined`。
 *    客户端必须容忍字段缺失，而不是假设它一定是空数组。
 */
import { Schema } from '@deepseek-ai/schemastery';
import {
  CONFIG_NS,
  DEFAULT_TIMEOUT_MS,
  MAX_HISTORY,
  MAX_HOSTS,
  MAX_LIST_ENTRIES,
  MAX_TIMEOUT_MS,
} from './constants.js';

/** 一台远程主机。 */
const hostSchema = Schema.object({
  /** 稳定 id，命令与界面都引用它。新建时由宿主生成。 */
  id: Schema.string().required(),
  /** 给人看的名字，缺省时用 `user@host`。 */
  label: Schema.string(),
  /** 主机名或 IP。 */
  host: Schema.string().required(),
  /** 端口。 */
  port: Schema.number().default(22),
  /** 登录用户；缺省时用本机当前用户名。 */
  user: Schema.string(),
  /**
   * 私钥文件路径（绝对路径或 `~` 开头）。
   *
   * **只支持私钥，不存密码。** 密码要么得落盘（credentials 服务），要么得在
   * BatchMode 下交互输入——而后者在非交互场景根本不可行。所以这里只收路径，
   * 密钥本身留在 `~/.ssh` 里，插件不接触内容。
   */
  identityFile: Schema.string(),
  /** 额外 `-o` 选项，每行一条；给高级用法留口子，不胀大 schema。 */
  sshOptions: Schema.array(Schema.string()).default([]),
  /** 备注。 */
  note: Schema.string(),
  /** 排序用的标签，界面用来分组。 */
  tags: Schema.array(Schema.string()).default([]),
});

/** 一条远端命令的执行记录（放在 `internal` 里，属于易变的运行态而非配置）。 */
const recordSchema = Schema.object({
  id: Schema.string().required(),
  hostId: Schema.string().required(),
  command: Schema.string().required(),
  /** 毫秒时间戳。 */
  at: Schema.number().required(),
  ok: Schema.boolean().default(false),
  exitCode: Schema.number(),
  durationMs: Schema.number(),
  /** 被截断时置位，让界面能说清"这不是全部输出"。 */
  truncated: Schema.boolean().default(false),
  bytes: Schema.number().default(0),
  /** 失败原因或空。 */
  detail: Schema.string(),
});

export const Config = Schema.object({
  /** 远程主机列表。 */
  hosts: Schema.array(hostSchema).default([]),
  /** 单次执行的墙钟上限，超过即中止。 */
  timeoutMs: Schema.number().default(DEFAULT_TIMEOUT_MS),
  /** 目录浏览时最多回传多少条。 */
  maxListEntries: Schema.number().default(MAX_LIST_ENTRIES),
  /**
   * 是否把面向 Agent 的工具注册出去。
   *
   * 关掉后面板仍可用（自己连、自己跑命令），但模型碰不到远端。
   * 这是"只想让它当一个面板"时的安全阀，也便于在不确定的 profile 里先只验 UI。
   */
  enableTools: Schema.boolean().default(true),
  /**
   * 运行态。用 `.volatile()` 标记：它每次运行都变，不该进配置 diff，
   * 而且界面只需要读解析后的值。
   */
  internal: Schema.object({
    /** 最近的执行记录，新的在前，上限 MAX_HISTORY 条。 */
    history: Schema.array(recordSchema).default([]),
    /** 最近一次连通性探测的结果。 */
    lastProbe: Schema.object({
      hostId: Schema.string(),
      ok: Schema.boolean().default(false),
      detail: Schema.string(),
      at: Schema.number(),
    }),
    /**
     * 启动自述。`enter` = apply 被调用，`ready` = 装配完成，`failed` = 抛错。
     * 存在理由见 lib/store.js 的 setLastBoot——没有它，宿主半一旦不出数据，
     * 从外面完全看不出是哪种故障。
     */
    lastBoot: Schema.object({
      at: Schema.number(),
      phase: Schema.string(),
      detail: Schema.string(),
    }),
  }).volatile(),
});

export const HOST_LIMIT = MAX_HOSTS;
export { CONFIG_NS };
export const HISTORY_LIMIT = MAX_HISTORY;
export const TIMEOUT_LIMIT = { default: DEFAULT_TIMEOUT_MS, max: MAX_TIMEOUT_MS };
