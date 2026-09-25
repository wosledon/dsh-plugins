/**
 * 配置持久层。
 *
 * 两条通道**按成功回退，而不是按可用性二选一**——这条来自真机教训：
 * `ctx.configEditor` 存在不等于它一定成功（条目可能还没被 patch 层认领、
 * Loader 正在重载、校验拒绝）。早先的写法是"优先用 editor，失败就返回 false"，
 * 于是另一条明明可用的通道从不被尝试。现在两条都试，并把最终落在哪条记下来，
 * 诊断时不必猜。
 *
 *   - `editor`：`ctx.configEditor.edit(entry, change)`，按 Loader entry 寻址。
 *     这是唯一能稳定写到 bundle 自带 `cordis.patch.yml` insert 出来的行的通道。
 *   - `settings`：`remote.settings.mutate(ns, ops)`，只在 editor 不可用时用。
 */
import { MAX_HISTORY } from './constants.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** 深拷贝，且只保留可 JSON 化的值——配置里不该出现函数或循环引用。 */
function plainClone(value) {
  if (Array.isArray(value)) return value.map(plainClone);
  if (isObject(value)) {
    const out = {};
    for (const [key, child] of Object.entries(value)) out[key] = plainClone(child);
    return out;
  }
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (typeof value === 'bigint') return String(value);
  return value;
}

export function createStore(ctx, rawConfig, options) {
  const ns = typeof options?.ns === 'string' ? options.ns : 'ssh-workspace';
  const packageName = typeof options?.packageName === 'string' ? options.packageName : 'dsh-plugin-ssh-workspace';

  let current = isObject(rawConfig) ? plainClone(rawConfig) : {};
  let internal = isObject(current.internal) ? plainClone(current.internal) : {};

  /* ---------------- 通道定位 ---------------- */

  const editorOf = () => {
    try {
      return typeof ctx?.get === 'function' ? ctx.get('configEditor') : undefined;
    } catch {
      return undefined;
    }
  };
  const settingsOf = () => {
    try {
      return typeof ctx?.get === 'function' ? ctx.get('settings') : undefined;
    } catch {
      return undefined;
    }
  };

  /** 在 editor 的两种列表形状里找到本插件的行。 */
  function locateEntry() {
    const editor = editorOf();
    if (editor === undefined || editor === null) return null;
    const candidates = [];
    if (typeof editor.configuration === 'function') {
      try {
        for (const row of editor.configuration() ?? []) {
          if (isObject(row) && isObject(row.entry)) candidates.push({ entry: row.entry, override: row.override, inherited: row.inherited });
        }
      } catch { /* 换 entries() 再试 */ }
    }
    if (candidates.length === 0 && typeof editor.entries === 'function') {
      try {
        for (const entry of editor.entries() ?? []) {
          if (isObject(entry)) candidates.push({ entry, override: undefined, inherited: undefined });
        }
      } catch { /* 两个都拿不到就当作只读 */ }
    }
    for (const row of candidates) {
      if (row.entry?.id === ns || row.entry?.name === packageName) return row;
    }
    return null;
  }

  /* ---------------- 写入 ---------------- */

  async function persistViaEditor() {
    const found = locateEntry();
    if (found === null) throw new Error('configEditor 里找不到本插件的条目');
    const editor = editorOf();
    if (typeof editor?.edit !== 'function') throw new Error('configEditor.edit 不可用');
    await editor.edit(found.entry, (entryCurrent, inherited) => ({
      ...(isObject(inherited) ? inherited : {}),
      ...(isObject(entryCurrent) ? entryCurrent : {}),
      ...current,
      internal: plainClone(internal),
    }));
    return 'editor';
  }

  async function persistViaSettings() {
    const settings = settingsOf();
    if (typeof settings?.mutate !== 'function') throw new Error('remote.settings 不可用');
    await settings.mutate(ns, [
      { op: 'set', path: ['internal'], value: plainClone(internal) },
    ], current.__revision ?? undefined);
    return 'settings';
  }

  let lastChannel = null;

  async function persist() {
    // 只读模式下没有可写通道，静默返回 false——界面会据此显示"只读"。
    if (editorOf() === undefined && settingsOf() === undefined) return false;
    const order = editorOf() !== undefined
      ? [persistViaEditor, persistViaSettings]
      : [persistViaSettings, persistViaEditor];
    let lastError = null;
    for (const attempt of order) {
      try {
        lastChannel = await attempt();
        return true;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /* ---------------- 对外 ---------------- */

  function getConfig() {
    return {
      ...current,
      internal: plainClone(internal),
    };
  }

  /** 从已落盘的配置里刷新内存快照。失败只降级，不抛。 */
  async function refresh() {
    const found = locateEntry();
    if (found === null) return;
    try {
      const raw = isObject(found.override) && Object.keys(found.override).length > 0 ? found.override : found.inherited;
      if (isObject(raw)) {
        current = plainClone(raw);
        internal = isObject(current.internal) ? plainClone(current.internal) : {};
      }
    } catch {
      /* 保持现有快照 */
    }
  }

  /** 追加一条执行记录，并裁剪到上限。 */
  async function pushHistory(record) {
    const list = Array.isArray(internal.history) ? internal.history.slice() : [];
    list.unshift(plainClone(record));
    internal = { ...internal, history: list.slice(0, MAX_HISTORY) };
    try {
      return await persist();
    } catch {
      // 记录写不进去不该让命令执行失败——执行结果本身才是调用方要的。
      return false;
    }
  }

  async function setLastProbe(record) {
    internal = {
      ...internal,
      lastProbe: {
        hostId: String(record?.hostId ?? ''),
        ok: record?.ok === true,
        detail: String(record?.detail ?? ''),
        at: Date.now(),
      },
    };
    try {
      return await persist();
    } catch {
      return false;
    }
  }

  /**
   * 启动自述。
   *
   * **为什么必须有**：此前另一个插件的 `apply()` 一个可观测出口都没有，于是
   * "apply 没被调用 / apply 抛错了 / 定时器没跑 / 扫描没结束"四种故障从外面看
   * 一模一样，只能靠外部 CPU 采样和姊妹插件对照去猜，白费了好几轮重启。
   *
   * `enter` 证明 apply 被调用了；`ready` 证明装配走完了。两者的差值就是
   * "装配中途抛错"的那一段。
   */
  async function setLastBoot(record) {
    internal = {
      ...internal,
      lastBoot: {
        at: Date.now(),
        phase: String(record?.phase ?? ''),
        detail: String(record?.detail ?? ''),
      },
    };
    try {
      return await persist();
    } catch {
      return false;
    }
  }

  /**
   * 读客户端写进来的目录浏览请求。
   *
   * 返回 `null` 表示"没有请求"。返回对象时再比对 `at`，避免对同一个请求重复执行
   * ——`settings/document-updated` 会因为**任何**字段变化而触发（包括宿主自己写
   * `result` 造成的那次），不比对就会自我循环。
   */
  function getRequest() {
    const request = internal.request;
    if (!isObject(request)) return null;
    const id = typeof request.id === 'string' ? request.id.trim() : '';
    const hostId = typeof request.hostId === 'string' ? request.hostId.trim() : '';
    if (id === '' || hostId === '') return null;
    return {
      id,
      hostId,
      path: typeof request.path === 'string' ? request.path : '',
      at: Number.isFinite(request.at) ? request.at : 0,
    };
  }

  /** 写目录浏览结果。客户端按 `id` 与自己的请求配对。 */
  async function setResult(record) {
    internal = {
      ...internal,
      result: {
        id: String(record?.id ?? ''),
        ok: record?.ok === true,
        hostId: String(record?.hostId ?? ''),
        path: String(record?.path ?? ''),
        detail: String(record?.detail ?? ''),
        count: Number.isFinite(record?.count) ? record.count : 0,
        truncated: record?.truncated === true,
        entries: Array.isArray(record?.entries) ? plainClone(record.entries) : [],
        at: Date.now(),
      },
    };
    try {
      return await persist();
    } catch {
      return false;
    }
  }

  return {
    ns,
    packageName,
    refresh,
    persist,
    getConfig,
    getRequest,
    setResult,
    pushHistory,
    setLastProbe,
    setLastBoot,
    isPersistent: () => editorOf() !== undefined || settingsOf() !== undefined,
    lastChannel: () => lastChannel,
  };
}
