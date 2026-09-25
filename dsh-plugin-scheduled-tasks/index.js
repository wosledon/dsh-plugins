/**
 * 「定时任务」——宿主侧。
 *
 * 职责：持久化任务定义、按时间表唤醒大模型执行提示词、记录运行日志，
 * 并向模型暴露一组用于**对话创建/管理任务**的工具与 skill。
 *
 * 装配顺序（每一步都只依赖上一步）：
 *   config → store（Config 读写）→ runner（真正跑大模型）→ scheduler（定时派发）
 *   → api（给工具用的业务面）→ tools/skill 注册 → effect 收尾
 *
 * 本模块不 import 任何 DSH 内部 Client 包；`lib/tools.js` 与 `lib/skill.js`
 * 以工厂函数形式接收宿主能力（见 CONTRACT.md §3），所以整包没有构建步骤。
 */
import { Config, CONFIG_NS, resolveConfig } from './lib/config.js';
import { createStore } from './lib/store.js';
import { createRunner } from './lib/runner.js';
import { createScheduler } from './lib/scheduler.js';
import { describeSchedule, validateSchedule } from './lib/cron.js';
import { ensureNextRun, findTask, newTaskId, normalizeTask } from './lib/model.js';
import { buildCatalog, catalogStale } from './lib/catalog.js';

export { Config };

/**
 * 硬依赖只列**本插件离不开**的服务。
 * `agentLoop` / `skills` / `systemPrompt` 做能力探测：缺了它们插件依然要能加载，
 * 只是对应功能降级（见各处 ?. 判断），否则一个可选服务缺席会让整个插件加载失败。
 */
export const inject = ['settings', 'tools'];

const name = 'dsh-plugin-scheduled-tasks';

/**
 * 已装配过的 ctx 集合。
 *
 * Cordis 对一行 Loader 条目只会调用一次 `apply`，但 HMR、重复装配或测试里的
 * 二次 `apply(ctx)` 都会让**第二个**调度器挂上第二个 interval，而两个实例
 * 互不知道对方的运行表，同一任务会被跑两次。用 ctx 身份做幂等守卫，
 * 让重复装配退化为无害的 no-op。
 */
const applied = new WeakSet();

/**
 * @param {object} ctx 宿主 plugin context
 * @param {unknown} rawConfig Loader 归一化后的 Config
 */
export function apply(ctx, rawConfig) {
  if (ctx !== null && typeof ctx === 'object') {
    if (applied.has(ctx)) {
      warn(ctx, 'apply 已在同一个 context 上执行过，本次装配被忽略（防止重复挂定时器）');
      return;
    }
    applied.add(ctx);
  }

  const config = resolveConfig(rawConfig);
  const store = createStore(ctx, rawConfig);
  const runner = createRunner(ctx, store, {
    workspaceRoot: config.workspaceRoot,
    runTimeoutMs: config.runTimeoutMs,
  });
  const scheduler = createScheduler(ctx, store, runner, config);

  /* ---------------------------------------------------------------- */
  /* 业务面：工具与 skill 通过它操作任务，不直接碰 store              */
  /* ---------------------------------------------------------------- */

  /** 读取任务列表。 */
  function listTasks() {
    return store.getTasks().filter((task) => task !== null && typeof task === 'object');
  }

  /** 落盘任务并返回新列表。 */
  async function persistTasks(tasks) {
    const ok = await store.setTasks(tasks);
    return { ok, tasks };
  }

  /**
   * 创建任务。
   * @param {object} input
   * @returns {Promise<{ok:true,task:object}|{ok:false,code:string,message:string}>}
   */
  async function createTask(input) {
    const now = Date.now();
    const normalized = normalizeTask(input, now);
    if (normalized.error !== undefined) {
      return { ok: false, code: 'invalid_task', message: normalized.error };
    }
    const tasks = listTasks();
    const task = ensureNextRun(normalized.task, now);
    const next = [...tasks, task];
    const stored = await persistTasks(next);
    if (!stored.ok) {
      return {
        ok: false,
        code: 'persist_failed',
        message: '任务已生成但写入设置失败；请检查设置文档是否可写，然后重试',
      };
    }
    return { ok: true, task };
  }

  /**
   * 修改任务。可用 patch 字段：title / prompt / schedule / enabled / skill / tools /
   * workspaceRoot / model。
   *
   * @param {string} id
   * @param {object} patch
   */
  async function updateTask(id, patch) {
    const tasks = listTasks();
    const current = findTask(tasks, id);
    if (current === undefined) {
      return { ok: false, code: 'task_not_found', message: `找不到任务 ${id}` };
    }
    const source = patch !== null && typeof patch === 'object' ? patch : {};
    const merged = {
      ...current,
      ...source,
      id: current.id,
      createdAt: current.createdAt,
    };
    const now = Date.now();
    const normalized = normalizeTask(merged, now, { id: current.id });
    if (normalized.error !== undefined) {
      return { ok: false, code: 'invalid_task', message: normalized.error };
    }
    // 时间表变了就重排下一次触发；只改文案/启停则沿用已有排期。
    const scheduleChanged = JSON.stringify(normalized.task.schedule) !== JSON.stringify(current.schedule);
    let task = normalized.task;
    if (scheduleChanged || normalized.task.enabled !== current.enabled) {
      delete task.nextRunAt;
      task = ensureNextRun(task, now);
    } else if (current.nextRunAt !== undefined) {
      task.nextRunAt = current.nextRunAt;
    }
    const next = tasks.map((item) => (item.id === current.id ? task : item));
    const stored = await persistTasks(next);
    if (!stored.ok) {
      return { ok: false, code: 'persist_failed', message: '写入设置失败，请重试' };
    }
    return { ok: true, task };
  }

  /**
   * 删除任务。日志保留（日志是运行历史，不随任务定义消失）。
   * @param {string} id
   */
  async function deleteTask(id) {
    const tasks = listTasks();
    const current = findTask(tasks, id);
    if (current === undefined) {
      return { ok: false, code: 'task_not_found', message: `找不到任务 ${id}` };
    }
    const next = tasks.filter((item) => item.id !== id);
    const stored = await persistTasks(next);
    if (!stored.ok) {
      return { ok: false, code: 'persist_failed', message: '写入设置失败，请重试' };
    }
    return { ok: true, id };
  }

  /**
   * 立即运行一次任务。
   *
   * 契约：成功返回**运行记录本身**（LogRecord），失败返回 null。
   * 工具层会兼容 `{ok:true, record}` 包装，但这里保持接线清晰。
   *
   * @param {string} id
   * @param {'schedule'|'manual'} [trigger]
   * @returns {Promise<object|null>}
   */
  async function runTask(id, trigger = 'manual') {
    const result = await scheduler.runNow(id);
    return result !== null && result !== undefined && result.ok === true ? result.record : null;
  }

  /** 生成一条新任务 id（工具层需要先校验再创建时用得上）。 */
  function mintTaskId(nowMs = Date.now()) {
    return newTaskId(nowMs);
  }

  /**
   * 宿主侧自述状态。
   *
   * 存在的理由：这个插件有两类"什么都不发生"的静默失败——调度器没在转
   * （任务永不触发）与模型目录没构建（界面选不到模型）。两者从外部看都只是
   * "功能没反应"，而宿主日志不在用户手里。把它通过 already-existing 的
   * `scheduled_task_list` 暴露出来，一句话就能定位。
   */
  function diagnostics() {
    const internal = store.getConfig().internal;
    const catalog = internal.catalog;
    return {
      persistent: store.isPersistent(),
      scheduler: scheduler.stats(),
      catalog: {
        builtAt: Number.isFinite(catalog?.builtAt) ? catalog.builtAt : null,
        providerCount: Array.isArray(catalog?.providers) ? catalog.providers.length : 0,
        modelCount: Array.isArray(catalog?.providers)
          ? catalog.providers.reduce((sum, provider) => sum + (Array.isArray(provider.models) ? provider.models.length : 0), 0)
          : 0,
      },
      llmAvailable: typeof ctx?.get === 'function' ? ctx.get('llm') !== undefined : false,
      taskCount: store.getTasks().length,
      logCount: store.getLog().length,
    };
  }

  const api = {
    listTasks,
    createTask,
    updateTask,
    deleteTask,
    runTask,
    mintTaskId,
    diagnostics,
    describeSchedule,
    validateSchedule,
    getLog(limit) {
      const log = store.getLog();
      const count = Number.isSafeInteger(limit) && limit > 0 ? limit : 50;
      return log.slice(-count).reverse();
    },
    isRunning: (taskId) => scheduler.isRunning(taskId),
    isPersistent: () => store.isPersistent(),
    refresh: () => store.refresh(),
  };

  /* ---------------------------------------------------------------- */
  /* 模型工具与 skill                                                  */
  /* ---------------------------------------------------------------- */

  /** 收尾时记录注册失败，但不让 apply 的返回值/生命周期受影响。 */
  function guarded(label, register) {
    try {
      const disposer = register();
      return typeof disposer === 'function' ? disposer : () => {};
    } catch (error) {
      warn(ctx, `${label} 注册失败：${message(error)}`);
      return () => {};
    }
  }

  // 动态 import 并兜住失败：这两个模块是可选扩展，任何一个缺位都不该让
  // 「定时执行」这个核心能力加载失败。
  void (async () => {
    // 宿主真正的 defineTool 从运行时解析（本插件没有构建步骤，不能静态 import）。
    //
    // 为什么要优先用真的：`defineTool` 不只是转 schema，它还给出参数校验
    // （execute 前 validate 会抛 ToolArgsError）与 result 渲染约定；`lib/tools.js`
    // 内置的等价编译器只保证「形状正确」，没有参数校验。解析不到时退化为内置实现，
    // 工具仍然可用。
    let defineTool;
    let usingBuiltin = true;
    try {
      const hostTools = await import('@deepseek-ai/dsh-tools');
      if (typeof hostTools.defineTool === 'function') {
        defineTool = hostTools.defineTool;
        usingBuiltin = false;
      }
    } catch (error) {
      warn(ctx, `无法解析宿主 defineTool，改用内置等价实现（无参数校验）：${message(error)}`);
    }
    if (usingBuiltin) {
      warn(ctx, '提示：未能拿到宿主 defineTool，工具参数将不做宿主侧校验');
    }

    try {
      const tools = await import('./lib/tools.js');
      if (typeof tools.registerTools === 'function') {
        ctx.effect(() => guarded('模型工具', () => tools.registerTools(ctx, api, { defineTool })), 'scheduled-tasks: tools');
      }
    } catch (error) {
      warn(ctx, `模型工具注册失败：${message(error)}`);
    }
    try {
      const skill = await import('./lib/skill.js');
      if (typeof skill.registerSkill === 'function') {
        ctx.effect(() => guarded('skill', () => skill.registerSkill(ctx, api)), 'scheduled-tasks: skill');
      }
    } catch (error) {
      warn(ctx, `skill 注册失败：${message(error)}`);
    }
  })();

  /* ---------------------------------------------------------------- */
  /* 模型目录：宿主写、界面读                                          */
  /* ---------------------------------------------------------------- */

  /**
   * 模型目录刷新。
   *
   * 客户端拿不到 `llm.listModels`（不是 @Remote），所以由宿主算好写进
   * `internal.catalog`，界面从它本来就要读的 `describe()` 一并取走。
   * 失败只降级（目录留空，界面上就只有"跟随默认模型"可选），绝不影响调度。
   */
  async function refreshCatalog() {
    if (!store.isPersistent()) return;
    try {
      const current = store.getConfig().internal.catalog;
      if (!catalogStale(current)) return;
      const catalog = await buildCatalog(ctx);
      await store.setCatalog(catalog);
    } catch (error) {
      warn(ctx, `刷新模型目录失败：${message(error)}`);
    }
  }

  /* ---------------------------------------------------------------- */
  /* 启动调度                                                          */
  /* ---------------------------------------------------------------- */

  // 定时器与启动流程都由 ctx.effect 收尾，插件卸载后不留野定时器。
  ctx.effect(() => {
    ctx.effect(() => scheduler.start(), 'scheduled-tasks: timer');
    void (async () => {
      try {
        await store.refresh();
        await scheduler.prime();
        // 启动时补一次目录：刚装好插件就该能在界面上选模型，
        // 而不是等 6 分钟。之后由 tick 按 TTL 续期。
        await refreshCatalog();
      } catch (error) {
        warn(ctx, `启动恢复失败：${message(error)}`);
      }
    })();
  }, 'scheduled-tasks: lifecycle');

  // 目录续期挂在 tick 上，比任务检查稀得多（见 lib/catalog.js 的 TTL）。
  ctx.effect(() => scheduler.onTick(() => { void refreshCatalog(); }), 'scheduled-tasks: catalog');
}

function warn(ctx, text) {
  try {
    if (ctx?.logger?.warn !== undefined) ctx.logger.warn(`[scheduled-tasks] ${text}`);
    else console.warn(`[scheduled-tasks] ${text}`);
  } catch {
    /* ignore */
  }
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

/* 运行入口自检用：包名与配置命名空间。 */
export const packageName = name;
export { CONFIG_NS };
