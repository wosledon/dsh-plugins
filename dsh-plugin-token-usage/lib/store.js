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
  /** 最近一次成功落盘走的通道；诊断用（"到底是谁写进去的"）。 */
  let lastChannel = null;

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

  /**
   * 找到本插件的 Loader 条目。
   *
   * 两个来源都试：`configuration()` 直接给出 `{ entry, inherited, override }`，
   * 但它只保证覆盖"active entries"；`entries()` 返回裸 `Entry[]`，更原始也更稳。
   * 只依赖其中一个，一旦对方的收录口径与我假设的不同，就会静默找不到条目、
   * 进而整条通道失效。
   */
  function locateEntry() {
    if (typeof editor.configuration === 'function') {
      const row = findEntry(editor.configuration(), identity);
      if (row !== undefined && isObject(row.entry)) return row.entry;
    }
    if (typeof editor.entries === 'function') {
      const list = editor.entries();
      if (Array.isArray(list)) {
        for (const candidate of list) {
          const id = patchIdOf(candidate);
          const name = isObject(candidate?.options) ? candidate.options.name : candidate?.name;
          if (id === identity.ns || name === identity.packageName) return candidate;
        }
      }
    }
    return null;
  }

  /**
   * `configEditor` 路径：按 Loader 条目寻址，回写完整 raw config。
   *
   * 回写值取自 `edit` 的 `change(current, inherited)` 回调参数，而不是自己去读
   * `configuration()` —— 那正是 `edit` 的设计用法，也顺带避开了"读到的层"与
   * "写回的层"不一致的窗口（`edit` 内部会检测写入期间的条目替换）。
   */
  async function persistViaEditor() {
    const found = locateEntry();
    if (found === null) throw new Error(`configEditor 里找不到条目 ${identity.ns}`);
    entry = found;
    await editor.edit(entry, (current, inherited) => ({
      ...(isObject(inherited) ? inherited : {}),
      ...(isObject(current) ? current : {}),
      scanLimit,
      internal: plainClone(internal),
    }));
  }

  /** `settings` 路径：按命名空间 + 路径增量写。 */
  async function persistViaSettings() {
    const ops = [
      { op: 'set', path: ['scanLimit'], value: scanLimit },
      { op: 'set', path: ['internal'], value: plainClone(internal) },
    ];
    await settings.mutate(identity.ns, ops, undefined);
  }

  /**
   * 落盘。**按成功回退，而不是按可用性二选一。**
   *
   * `mode` 只表示"优先用谁"：`configEditor` 存在不等于它一定成功（条目可能还没
   * 被 patch 层认领、Loader 正在重载、校验拒绝）。早先的写法是 `if (mode === 'editor')`
   * 里失败就 `return false`——于是另一条通道明明可用却从不尝试。
   * 现在两条都试，并把最终落在哪条记进 `lastChannel`，诊断时不必猜。
   */
  /**
   * 单次写入的超时上限。
   *
   * **真机验证过的必要性**：`trace` 停在 `startup:refreshed`，之后连 `sweep:enter`
   * 都没落盘——说明 `editor.edit()` 有一次调用**永不 settle**。而写入是串成一条链
   * 的，于是那一次卡住把**之后所有写入**（扫描结果、心跳、里程碑）全部堵死。
   *
   * 没有界就没有"失败"，只有"永远等下去"——而"永远等下去"在链式写入里等于全局停摆。
   * 有了它，卡住的写入会超时抛错、走另一条通道、并让链继续前进。
   */
  const WRITE_TIMEOUT_MS = 5_000;

  function withWriteTimeout(promise, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} 写入超时（${WRITE_TIMEOUT_MS}ms）`)), WRITE_TIMEOUT_MS);
      Promise.resolve(promise).then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); },
      );
    });
  }

  async function persistOnce() {
    if (mode === 'read-only') return false;
    const attempts = mode === 'editor'
      ? [['editor', persistViaEditor], ['settings', canMutate ? persistViaSettings : null]]
      : [['settings', persistViaSettings], ['editor', canEdit ? persistViaEditor : null]];
    let lastError = null;
    for (const [channel, attempt] of attempts) {
      if (attempt === null) continue;
      try {
        await withWriteTimeout(attempt(), channel);
        if (lastChannel !== channel) lastChannel = channel;
        return true;
      } catch (error) {
        lastError = `${channel}: ${message(error)}`;
      }
    }
    warn(`写入配置失败（两条通道都试过）：${lastError ?? '无可用通道'}`);
    return false;
  }

  /*
   * 写入串行化。
   *
   * **这是真机暴露出来的缺陷**：每次 `persist()` 都把自己那份 `internal` 快照
   * 交给 `editor.edit()`（读-改-写）。并发写时后一次读到的 `current` 不含前一次
   * 刚写的东西，于是先发起的写在落盘时把后发起的覆盖掉——**后写未必赢，先写可能
   * 赢**。现象正是一次性的 `lastBoot` 留下来了，而每次心跳反复写的 `heartbeat`
   * 从没出现过。
   *
   * 串成一条链后，每次写入都基于"上一次写完之后"的状态，读-改-写不再交错。
   * 链路用 `.catch` 吞掉失败以免一个错误断掉整条链——每次调用拿到的仍是它自己
   * 那次的结果。
   */
  let writeTail = Promise.resolve();
  function persist() {
    const next = writeTail.then(persistOnce, persistOnce);
    writeTail = next.then(() => {}, () => {});
    return next;
  }

  /**
   * **绕过队列**的诊断写入。
   *
   * 上一轮真机教训：`trace` 停在 `startup:refreshed`，而它之后的 `sweep:enter`
   * 迟迟不出现——因为队列堵住时，诊断写入也一起被堵住，于是"我用来观测堵塞的
   * 工具本身被堵塞吃掉了"。诊断必须走在数据前面，不能被它所诊断的东西挡住。
   *
   * 因此直接调用 `persistOnce()`，不进 `writeTail` 链。它仍然有超时兜底。
   */
  function persistDiagnostic() {
    return persistOnce();
  }

  return {
    mode,
    /** 最近一次成功落盘走的通道（'editor' | 'settings' | null）。 */
    lastChannel() {
      return lastChannel;
    },
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
     * 宿主半的启动自述。
     *
     * `apply()` 原先没有任何可观测出口——没数据时无法区分"没被调用 / 抛错了 /
     * 定时器没跑 / 扫描没结束"。这条记录让下一次启动直接给出答案。
     */
    async setLastBoot(record) {
      internal = { ...internal, lastBoot: { at: Date.now(), phase: String(record?.phase ?? ''), detail: String(record?.detail ?? '') } };
      return persist();
    },
    /**
     * 定时器心跳。证明"宿主半确实活着且在转"，与 `lastSweep`（证明"扫描跑过"）
     * 是两件事：定时器可能在转而扫描一直失败，也可能两者都没跑。
     */
    async setHeartbeat(ticks, lastTickAt) {
      internal = { ...internal, heartbeat: { ticks, lastTickAt } };
      return persist();
    },
    /**
     * 里程碑：只保留"最后到达的那一步"。见 `lib/config.js` 里 `traceSchema` 的
     * 说明——一次启动就能定位停在哪，而不是每轮重启只回答一个是/否问题。
     *
     * **绕过写入队列**（见 `persistDiagnostic` 的说明）：队列堵住时诊断必须还能落盘，
     * 否则观测工具会被被观测的故障一起吃掉。
     */
    async setTrace(text) {
      internal = { ...internal, trace: String(text) };
      return persistDiagnostic();
    },
    /** 定时器心跳，同样绕过队列（它也是诊断，且要能证明"定时器在转"）。 */
    async setHeartbeatDirect(ticks, lastTickAt) {
      internal = { ...internal, heartbeat: { ticks, lastTickAt } };
      return persistDiagnostic();
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
