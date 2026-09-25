/**
 * Config 读写层。
 *
 * Config 是本插件唯一的持久化状态，写回通道是 `ctx.settings.mutate(ns, ops, revision)`。
 * 每次写都必须带上**刚读到的 revision**：设置文档是乐观并发控制的，带旧 revision
 * 的写入会被拒绝（这正是我们想要的——界面和宿主同时改任务时不会互相覆盖）。
 *
 * 这里有两个必须小心的不变式，都是踩过坑之后写下来的：
 *
 * 1. **本地先改、再写盘**。`appendLog` 之类的方法先把新值合进内存快照，再落盘。
 *    而落盘前可能需要 `refresh()` 拿最新 revision——如果 `refresh()` 直接用磁盘
 *    快照整体替换内存态，就会把「还没来得及写出去的本地改动」冲掉（症状：
 *    刚 append 的日志在 `getLog()` 里消失，随后 `updateLog` 用空数组覆盖磁盘）。
 *    解法是 `pending` 覆盖层：refresh 之后重新把它贴回内存态。
 *
 * 2. **不持有设置文档的活引用**。某些实现让 `describe()` 返回文档内部对象，
 *    后续 `mutate(..., ['internal','log'], …)` 会就地改那棵树；直接持有引用会让
 *    内存快照在别人写盘时被悄悄改掉。所以读进来一律深拷贝。
 */
import { CONFIG_NS, LOG_LIMIT_DEFAULT, resolveConfig } from './config.js';

/**
 * @param {object} ctx 宿主 plugin context
 * @param {unknown} rawConfig Loader 传入的 config
 * @returns {object} store
 */
export function createStore(ctx, rawConfig) {
  /** 内存中的权威快照。 */
  let config = resolveConfig(rawConfig);
  /** 下次写回要用的 revision；undefined 表示尚未读过。 */
  let revision;
  /** settings 服务缺失时进入内存态。 */
  let readOnly = false;
  /** 下一个日志序号。 */
  let logSeq = maxSeq(config.internal.log);

  /**
   * 尚未确认落盘的本地改动，键是 `JSON.stringify(path)`。
   * `refresh()` 之后按插入顺序重新应用，保证本地意图不被磁盘快照冲掉。
   */
  const pending = new Map();

  const settings = ctx !== null && typeof ctx === 'object' ? ctx.get?.('settings') : undefined;
  if (settings === undefined || settings === null) {
    readOnly = true;
    warn('设置服务不可用，本插件的任务与日志只存在于内存中，重启后会丢失');
  }

  function warn(message) {
    try {
      if (ctx?.logger?.warn !== undefined) ctx.logger.warn(`[scheduled-tasks] ${message}`);
      else console.warn(`[scheduled-tasks] ${message}`);
    } catch {
      /* 日志失败绝不影响主流程 */
    }
  }

  function maxSeq(log) {
    let max = 0;
    for (const row of log) {
      if (Number.isFinite(row?.seq) && row.seq > max) max = row.seq;
    }
    return max;
  }

  /** 把一份普通值写进配置树。 */
  function writePath(path, value) {
    const next = { ...config };
    let node = next;
    for (let index = 0; index < path.length - 1; index += 1) {
      const key = path[index];
      node[key] = { ...(node[key] !== null && typeof node[key] === 'object' ? node[key] : {}) };
      node = node[key];
    }
    node[path[path.length - 1]] = value;
    config = next;
  }

  /** 把 pending 里的本地改动重新贴回内存快照。 */
  function reapplyPending() {
    for (const [pathKey, value] of pending) {
      writePath(JSON.parse(pathKey), value);
    }
  }

  /** 读一次设置文档，刷新内存快照与 revision（保留未落盘的本地改动）。 */
  async function refresh() {
    if (readOnly) return false;
    let descriptors;
    try {
      descriptors = await settings.describe();
    } catch (error) {
      warn(`读取设置失败：${message(error)}`);
      return false;
    }
    if (!Array.isArray(descriptors)) return false;
    const entry = descriptors.find((item) => item !== null && typeof item === 'object' && item.ns === CONFIG_NS);
    if (entry === undefined) {
      // 本插件的行还没进设置目录（例如刚插入、尚未 apply）：保持内存态。
      warn('设置目录中没有本插件条目，暂时使用内存态');
      return false;
    }
    if (Number.isFinite(entry.revision)) revision = entry.revision;

    const raw = entry.user !== null && typeof entry.user === 'object' ? entry.user : entry.value;
    const source = plainClone(raw);
    if (source !== null && typeof source === 'object') {
      config = resolveConfig({ ...config, ...source });
      reapplyPending();
      logSeq = Math.max(logSeq, maxSeq(config.internal.log));
    }
    return true;
  }

  /**
   * 写回若干路径。
   * @param {Array<{ path: string[], value: unknown }>} patches
   * @returns {Promise<boolean>} 是否成功落盘
   */
  async function persist(patches) {
    if (patches.length === 0) return true;
    if (readOnly) return false;

    // 登记本地改动：从现在起内存快照的这部分以本地为准。
    for (const patch of patches) pending.set(JSON.stringify(patch.path), patch.value);
    const ops = patches.map((patch) => ({ op: 'set', path: patch.path, value: patch.value }));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (revision === undefined) {
        await refresh();
        // refresh 会重放 pending，这里重新按最新内存值构造 ops，避免写回旧值。
        for (let index = 0; index < patches.length; index += 1) {
          ops[index] = { op: 'set', path: patches[index].path, value: pending.get(JSON.stringify(patches[index].path)) };
        }
      }
      try {
        await settings.mutate(CONFIG_NS, ops, revision);
        // 成功后 revision 推进；这些本地改动已经落盘，不再是 pending。
        for (const patch of patches) pending.delete(JSON.stringify(patch.path));
        revision = undefined;
        return true;
      } catch (error) {
        revision = undefined;
        if (attempt === 0) {
          warn(`写入设置失败，将重读 revision 后重试：${message(error)}`);
          continue;
        }
        warn(`写入设置失败：${message(error)}`);
        // 写失败：本地改动留在 pending，下次 refresh 仍以本地为准。
        return false;
      }
    }
    return false;
  }

  return {
    /** 当前配置快照（浅拷贝顶层，防外部改内存态）。 */
    getConfig() {
      return { ...config, tasks: [...config.tasks], internal: { ...config.internal } };
    },
    /**
     * 当前任务列表。
     * 返回内部数组引用以避免每次取列表都复制；调用方只读，改前先自行复制。
     */
    getTasks() {
      return config.tasks;
    },
    getLog() {
      return config.internal.log;
    },
    getRuns() {
      return config.internal.runs;
    },
    isPersistent() {
      return readOnly !== true;
    },
    refresh,

    /** 替换任务列表并写回。 */
    async setTasks(tasks) {
      config = { ...config, tasks };
      return persist([{ path: ['tasks'], value: tasks }]);
    },

    /** 追加一条日志，返回写入的记录（含 seq）。 */
    async appendLog(record) {
      logSeq += 1;
      const entry = { ...record, seq: logSeq };
      const limit = Number.isFinite(config.logLimit) ? Math.max(1, config.logLimit) : LOG_LIMIT_DEFAULT;
      const log = [...config.internal.log, entry].slice(-limit);
      config = { ...config, internal: { ...config.internal, log } };
      await persist([{ path: ['internal', 'log'], value: log }]);
      return entry;
    },

    /** 原地更新一条日志（用于把 running 改成终态）。 */
    async updateLog(seq, patch) {
      const log = config.internal.log.map((row) => (row.seq === seq ? { ...row, ...patch } : row));
      config = { ...config, internal: { ...config.internal, log } };
      await persist([{ path: ['internal', 'log'], value: log }]);
      return log.find((row) => row.seq === seq);
    },

    /** 记录/清除运行中去重状态。 */
    async setRunState(taskId, state) {
      const runs = { ...config.internal.runs };
      if (state === null) delete runs[taskId];
      else runs[taskId] = state;
      config = { ...config, internal: { ...config.internal, runs } };
      await persist([{ path: ['internal', 'runs'], value: runs }]);
    },

    /**
     * 写回「立即运行」请求队列。
     * 宿主消费后清空；浏览器侧只写这个字段，不碰 tasks（两者互不覆盖）。
     */
    async setManualRuns(requests) {
      const manualRuns = Array.isArray(requests) ? requests : [];
      config = { ...config, internal: { ...config.internal, manualRuns } };
      await persist([{ path: ['internal', 'manualRuns'], value: manualRuns }]);
    },

    /**
     * 写回模型目录（界面选模型用）。
     * 由宿主独占：界面只读，所以不存在写入竞争。
     */
    async setCatalog(catalog) {
      const value = catalog !== null && typeof catalog === 'object' ? catalog : { providers: [], builtAt: Date.now() };
      config = { ...config, internal: { ...config.internal, catalog: value } };
      return persist([{ path: ['internal', 'catalog'], value: plainClone(value) }]);
    },
  };
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 深拷贝一份普通 JSON 值。
 *
 * 用 `structuredClone`（Node 17+ 内建）而不是 JSON 往返：它能保留 `undefined`
 * 与循环引用语义，对配置这种纯 JSON 结构也更快。宿主环境没有它时退回 JSON 往返。
 */
function plainClone(value) {
  if (value === null || typeof value !== 'object') return value;
  try {
    return structuredClone(value);
  } catch {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return value;
    }
  }
}
