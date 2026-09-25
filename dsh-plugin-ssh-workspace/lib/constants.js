/**
 * `dsh-plugin-ssh-workspace` 的常量。
 *
 * 这一层零依赖、零副作用，只放字面量与上限。宿主半与客户端半都从这里取，
 * 避免两处各写一份魔法数字（跨两半的常量漂移是"界面显示的端口和实际连的端口
 * 不一致"这类 bug 的直接来源）。
 */

/** 配置命名空间。 */
export const CONFIG_NS = 'ssh-workspace';

/** 包名，用于诊断日志前缀。 */
export const PACKAGE_NAME = 'dsh-plugin-ssh-workspace';

/** 单次远程执行的默认墙钟上限（毫秒）。 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** 单次远程执行的强制上限：超过它一定是有东西挂住了，不能无限等。 */
export const MAX_TIMEOUT_MS = 300_000;

/** 输出最多回传多少字节。 */
export const MAX_OUTPUT_BYTES = 512 * 1024;

/** 主机数上限：这是给人用的面板，不是批量运维平台。 */
export const MAX_HOSTS = 64;

/** 一条命令结果在配置里最多保留多少条历史。 */
export const MAX_HISTORY = 40;

/** 远端文件浏览单次列出的条目上限。 */
export const MAX_LIST_ENTRIES = 500;

/**
 * 服务端指纹策略。
 *
 * `accept-new` 是关键：首次连接一台新主机时**不弹交互确认**（BatchMode 下
 * 也弹不出来，只会失败），但主机密钥一旦变化仍然会拒绝——后者才是真正要防的
 * 中间人风险。设成 `no` 会把首次连接全判失败，设成 `yes` 会连密钥变更也不问。
 */
export const HOST_KEY_POLICY = 'accept-new';

/**
 * `find -printf` 的格式串。
 *
 * 只用一个 `find` 调用就取到路径/类型/大小/改动时间，避免 N 次往返。
 *
 * **路径放在最前**不是随意的：文件名里合法地可以含制表符，若把数值字段放前面，
 * 分隔就会被文件名里的 tab 打乱。路径在前时，只要取记录里**最后三个**字段当
 * 类型/大小/时间，剩下的部分拼回来就是完整路径——多退少补都成立。
 * 记录用 NUL 终止，所以文件名里含换行也没关系。
 *
 * **已知限制**：`-printf` 是 GNU findutils 的扩展，BSD/macOS 的 find 没有。
 * 远端找不到时会给一条明确错误，由界面显示，而不是静默返回空列表。
 */
export const FIND_PRINTF = '%p\\t%y\\t%s\\t%T@\\0';
