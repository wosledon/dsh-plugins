/**
 * 配置 schema。
 *
 * 形状用 schemastery 声明，三条来自真机教训：
 *
 * 1. **返回给界面的每个字段都必须在这里声明。** schemastery 对未声明字段会剥离
 *    或拒绝，于是"代码算出来了但界面拿不到"，且不报错。
 * 2. **不要把 `default([])` 当成兜底。** 实测：schemastery **不会**为
 *    `.volatile()` 节点里缺失的嵌套数组填充默认值，旧数据会如实是 `undefined`。
 *    客户端必须容忍字段缺失，而不是假设它一定是空数组。
 * 3. **导入必须用默认导出** `import Schema from '@deepseek-ai/schemastery'`。
 *    这个包没有 `Schema` 命名导出，写成 `import { Schema }` 会在**导入期**抛
 *    `does not provide an export named 'Schema'`——那是模块求值阶段就失败，
 *    后果是 entry 激活不了、应用起不来，而不是某块功能坏掉。
 */
import Schema from '@deepseek-ai/schemastery';
import {
  CONFIG_NS,
  DEFAULT_TIMEOUT_MS,
  MAX_HISTORY,
  MAX_HOSTS,
  MAX_LIST_ENTRIES,
  MAX_TIMEOUT_MS,
} from './constants.js';

/**
 * 一台远程主机。
 *
 * **`id` 与 `host` 刻意不是 `required()`。** 一度写成 required，代价是：
 * 一份被手改过、某台主机少个 `id` 的配置会让**整段 Config 校验失败**——
 * 而配置校验失败发生在 Loader 载入阶段，后果是这一行激活不了、可能连应用
 * 都起不来，远重于"少了一台主机"。
 *
 * 正确分工是：**schema 接受归一化器能修的东西，由归一化器去修补或丢弃坏行。**
 * `normaliseHosts()` 本来就会补 id、丢弃没有 host 的行，所以这里放宽即可。
 */
const hostSchema = Schema.object({
  /** 稳定 id，命令与界面都引用它。缺失时由 `normaliseHosts()` 按索引补。 */
  id: Schema.string(),
  /** 给人看的名字，缺省时用 `user@host`。 */
  label: Schema.string(),
  /** 主机名或 IP。缺失时该行会被 `normaliseHosts()` 丢弃。 */
  host: Schema.string(),
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

/** 一个远端目录项（`internal.result.entries` 的元素）。 */
const entrySchema = Schema.object({
  path: Schema.string(),
  name: Schema.string(),
  directory: Schema.boolean().default(false),
  /** GNU find 的 `%y`：d/f/l/… */
  kind: Schema.string(),
  size: Schema.number().default(0),
  mtimeMs: Schema.number().default(0),
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
    /**
     * 客户端写入的目录浏览请求。
     *
     * 客户端（浏览器半）拿不到 `tools` 服务，也没有新增 Remote 命名空间的权限，
     * 所以「列目录」这件事只能走 `remote.settings` 这条通用读写通道：
     * 客户端把请求写进来 → 宿主收到 `settings/document-updated` 事件 →
     * 用与 `ssh_list_dir` **完全相同**的代码路径执行 → 结果写进 `result`。
     *
     * 事件驱动而非轮询：宿主侧不需要定时器（见 index.js 的说明）。
     */
    request: Schema.object({
      id: Schema.string(),
      hostId: Schema.string(),
      path: Schema.string(),
      at: Schema.number(),
    }),
    /** 上面那次请求的结果。客户端按 `id` 与自己的请求配对。 */
    result: Schema.object({
      id: Schema.string(),
      ok: Schema.boolean().default(false),
      hostId: Schema.string(),
      path: Schema.string(),
      detail: Schema.string(),
      count: Schema.number().default(0),
      truncated: Schema.boolean().default(false),
      entries: Schema.array(entrySchema).default([]),
      at: Schema.number(),
    }),
    /**
     * 从 `~/.ssh/config` 读出来的主机列表。
     *
     * 宿主写、客户端读：客户端不能读文件，所以主机列表必须由宿主投影过来。
     * 这里**不复用上面的 `hosts`**——那是早期"手填主机"设计的遗留字段，现在
     * 主机只来自 ssh config；分成两个字段是为了让"来源是 ssh config"这件事
     * 在配置里也是显式的。
     */
    sshHosts: Schema.array(Schema.object({
      id: Schema.string(),
      alias: Schema.string(),
      host: Schema.string(),
      user: Schema.string(),
      port: Schema.number().default(22),
      identityFile: Schema.string(),
      note: Schema.string(),
    })).default([]),
    /** ssh config 的读取说明（文件不存在、Include 未展开等）。 */
    sshWarnings: Schema.array(Schema.string()).default([]),
    /** 实际读取的配置文件路径，便于用户核对。 */
    sshConfigPath: Schema.string(),
    /**
     * 客户端请求"重读 ssh config"的时间戳。
     *
     * 客户端读不到文件，只能用写一个会变的值来触发 `settings/document-updated`，
     * 宿主在那次事件里重读配置。写一个时间戳而不是布尔开关，是因为同一个值写
     * 两次不会产生事件——时间戳每次不同，重读才一定会发生。
     */
    hostsRequestedAt: Schema.number(),
  }).volatile(),
});

export const HOST_LIMIT = MAX_HOSTS;
export { CONFIG_NS };
export const HISTORY_LIMIT = MAX_HISTORY;
export const TIMEOUT_LIMIT = { default: DEFAULT_TIMEOUT_MS, max: MAX_TIMEOUT_MS };
