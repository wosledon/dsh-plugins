/**
 * 持久化层：跨会话汇总的唯一落盘位置。
 *
 * ## 为什么不是 `remote.settings`
 *
 * 最初这里用的是 `ctx.settings.mutate(ns, ops, revision)`，但没有写入生效。
 * 原因：`settings` 服务操作的是 **profile patch 层里已有的条目**，而本插件
 * 的行是 bundle 自己的 `cordis.patch.yml` 用 `insert` 提供的——patch 层里
 * 根本没有 `token-usage` 这个条目可改。（姊妹插件的条目能在 patch 层里存在，
 * 是因为它当初被手工写进去过，所以那条路看起来"能用"。）
 *
 * ## 改用 `ctx.configEditor`
 *
 * `configEditor` 是**按 Loader 条目**寻址的：
 *   - `entries()` → 「Active entries with unique profile patch ids」
 *   - `configuration()` → 每个条目的 `{ entry, inherited, override }`
 *   - `edit(entry, change)` → 「Validate, persist, and reconcile a plugin's next
 *     config」，`change` 返回**完整**的 raw config
 *
 * 这正是插件持久化自身配置的正规通道，也不需要自己发明 patch 层寻址。
 * `settings.mutate` 作为后备保留：某些 profile 可能只挂载了其中一方。
 */

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function plainClone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      /* 含不可克隆值时退回 JSON */
    }
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

/** 一次性 warn：只读 profile 下每次写都失败，刷屏没有意义。 */
function makeWarn(ctx) {
  const seen = new Set();
  return (text) => {
    if (seen.has(text)) return;
    seen.add(text);
    try {
      if (typeof ctx?.logger?.warn === 'function') ctx.logger.warn(`[token-usage] ${text}`);
      else console.warn(`[token-usage] ${text}`);
    } catch {
      /* ignore */
    }
  };
}

/** 条目的 patch id：不同 Loader 版本把它放在不同位置，逐个试。 */
export function patchIdOf(entry) {
  if (!isObject(entry)) return undefined;
  for (const candidate of [entry.patchId, entry.options?.id, entry.id, entry.options?.name, entry.name]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

/**
 * 从 `configuration()` 的结果里挑出本插件的条目。
 *
 * 同时比对 patch id 与包名：只认 id 会在行 id 被改时失联，
 * 只认包名会在同名多行时选错。
 */
export function findEntry(configurations, { ns, packageName }) {
  if (!Array.isArray(configurations)) return undefined;
  for (const row of configurations) {
    if (!isObject(row) || !isObject(row.entry)) continue;
    const id = patchIdOf(row.entry);
    const name = typeof row.entry?.options?.name === 'string' ? row.entry.options.name : row.entry?.name;
    if (id === ns || name === packageName) return row;
  }
  return undefined;
}

/**
 * @param {object} ctx Cordis 上下文
 * @param {object} rawConfig Loader 传来的 config
 * @param {{ns:string, packageName:string}} identity
 * @returns {object} store
 */
export function createStore(ctx, rawConfig, identity) {
  const editor = typeof ctx?.get === 'function' ? ctx.get('configEditor') : undefined;
  const settings = typeof ctx?.get === 'function' ? ctx.get('settings') : undefined;
  const warn = makeWarn(ctx);

  const canEdit = isObject(editor) && typeof editor.edit === 'function' && typeof editor.configuration === 'function';
  const canMutate = isObject(settings) && typeof settings.mutate === 'function' && typeof settings.describe === 'function';
  const mode = canEdit ? 'editor' : (canMutate ? 'settings' : 'read-only');

  /** 内存中的 `internal`；`scanLimit` 单独存，因为它是用户的显式配置。 */
  let internal = isObject(rawConfig?.internal) ? plainClone(rawConfig.internal) : {};
  let scanLimit = Number.isFinite(rawConfig?.scanLimit) ? rawConfig.scanLimit : 200;
  let entry = null;

  /**
   * 把「覆盖层 + 继承层」合成当前配置。
   * 读 inherited 是必要的：只读 override 会丢掉 bundle 与 profile 补丁提供的值。
   */
  function absorb(row) {
    if (!isObject(row)) return;
    entry = row.entry;
    const merged = { ...(isObject(row.inherited) ? row.inherited : {}), ...(isObject(row.override) ? row.override : {}) };
    if (isObject(merged.internal)) internal = plainClone(merged.internal);
    if (Number.isFinite(merged.scanLimit)) scanLimit = merged.scanLimit;
  }

  async function refresh() {
    if (mode === 'read-only') return;
    try {
      if (mode === 'editor') {
        const row = findEntry(editor.configuration(), identity);
        if (row === undefined) {
          warn(`configEditor 里找不到条目 ${identity.ns}，汇总将只留在内存`);
          return;
        }
        absorb(row);
        return;
      }
      const entries = await settings.describe();
      const found = Array.isArray(entries)
        ? entries.find((candidate) => candidate?.ns === identity.ns)
        : undefined;
      if (isObject(found)) {
        const source = isObject(found.user) ? found.user : (isObject(found.value) ? found.value : undefined);
        if (isObject(source)) {
          if (isObject(source.internal)) internal = plainClone(source.internal);
          if (Number.isFinite(source.scanLimit)) scanLimit = source.scanLimit;
        }
      }
    } catch (error) {
      warn(`读取配置失败：${message(error)}`);
    }
  }

  /** 把完整 raw config 写回。`edit` 要的是完整值，不是增量。 */
  async function persist() {
    if (mode === 'read-only') return false;
    try {
      if (mode === 'editor') {
        const row = findEntry(editor.configuration(), identity);
        if (row === undefined) return false;
        entry = row.entry;
        const next = {
          ...(isObject(row.inherited) ? row.inherited : {}),
          ...(isObject(row.override) ? row.override : {}),
          scanLimit,
          internal: plainClone(internal),
        };
        await editor.edit(entry, () => next);
        return true;
      }
      const ops = [
        { op: 'set', path: ['scanLimit'], value: scanLimit },
        { op: 'set', path: ['internal'], value: plainClone(internal) },
      ];
      await settings.mutate(identity.ns, ops, undefined);
      return true;
    } catch (error) {
      warn(`写入配置失败：${message(error)}`);
      return false;
    }
  }

  return {
    mode,
    getSummary() {
      return internal.summary;
    },
    getScanLimit() {
      return scanLimit;
    },
    getLastSweep() {
      return internal.lastSweep;
    },
    getRefreshRequestedAt() {
      return Number.isFinite(internal.refreshRequestedAt) ? internal.refreshRequestedAt : null;
    },
    isPersistent() {
      return mode !== 'read-only';
    },
    refresh,
    async setSummary(summary) {
      internal = { ...internal, summary: plainClone(summary) };
      return persist();
    },
    async setLastSweep(record) {
      internal = { ...internal, lastSweep: { at: Date.now(), ok: record?.ok === true, detail: String(record?.detail ?? '') } };
      return persist();
    },
    /**
     * 消费刷新请求：**先清空再返回**上一个值。
     * 反过来会让"清理失败"变成"每轮重复扫描"，空转比重扫一次更糟。
     */
    async takeRefreshRequest() {
      const requestedAt = this.getRefreshRequestedAt();
      if (requestedAt === null) return null;
      internal = { ...internal, refreshRequestedAt: undefined };
      await persist();
      return requestedAt;
    },
  };
}
