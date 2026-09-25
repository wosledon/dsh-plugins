/**
 * 调度器：定时发现到期任务并派发执行。
 *
 * 设计取舍：
 *   - 一个 `tickMs` 定时器做轮询，而不是给每个任务各挂一个定时器。任务数量、
 *     下次触发时间都由配置决定，轮询只有一个需要生命周期管理的东西，
 *     插件卸载时一定不会留下野定时器。
 *   - 重叠保护有三层：tick 级（上一次 tick 未结束就跳过）、任务级（
 *     `internal.runs` 里存在该任务即跳过）、并发级（同时运行数不超过
 *     `maxConcurrentRuns`）。定时任务最常见的故障就是「上一轮还没跑完下一轮
 *     又起来了」，这三层合起来把它挡住。
 *   - 单个任务失败绝不冒泡：每个任务被单独 await 并兜住异常。
 */
import { advanceTask, ensureNextRun, findTask, isTaskDue } from './model.js';

/**
 * @param {object} ctx 宿主 plugin context
 * @param {object} store createStore() 的结果
 * @param {object} runner createRunner() 的结果
 * @param {object} config resolveConfig() 的结果
 * @returns {object} scheduler
 */
export function createScheduler(ctx, store, runner, config) {
  /** 正在执行的任务 id 集合（内存态，重启后由 internal.runs 恢复语义）。 */
  const running = new Set();
  let ticking = false;
  let stopped = false;
  /**
   * tick 计数、最后一次 tick 时间与最后的错误。
   *
   * 这三个值存在的理由：调度器在「什么都不发生」时是最难诊断的部件——
   * 定时器没挂上、被提前 clear、tick 抛错，外部看到的都是同一件事：
   * 「任务不触发」。暴露计数就能一眼区分它们，不必去翻宿主日志。
   */
  let tickCount = 0;
  let lastTickAt = 0;
  let lastTickError = null;

  function warn(message) {
    try {
      if (ctx?.logger?.warn !== undefined) ctx.logger.warn(`[scheduled-tasks] ${message}`);
      else console.warn(`[scheduled-tasks] ${message}`);
    } catch {
      /* ignore */
    }
  }

  /** 启动时补齐 nextRunAt，让界面立刻能看到下次运行时间。 */
  async function prime() {
    const now = Date.now();
    const tasks = store.getTasks();
    let changed = false;
    const next = tasks.map((task) => {
      const primed = ensureNextRun(task, now);
      if (primed !== task) changed = true;
      return primed;
    });
    if (changed) await store.setTasks(next);

    // 恢复「上次进程退出时正在运行」的任务：日志里仍是 running 的条目说明
    // 上次被硬中断，把它们标成 error，否则界面会永远显示"运行中"。
    const log = store.getLog();
    const stuck = log.filter((row) => row.status === 'running');
    if (stuck.length > 0) {
      for (const row of stuck) {
        await store.updateLog(row.seq, {
          status: 'error',
          endedAt: Date.now(),
          error: '宿主在上一次运行结束前退出，本次运行状态未知',
        });
      }
      if (store.isPersistent()) {
        // 运行表同样清空，避免这些任务被永久跳过。
        const runs = store.getRuns();
        for (const taskId of Object.keys(runs)) await store.setRunState(taskId, null);
      }
    }
  }

  /**
   * 消费「立即运行」请求队列。
   *
   * 浏览器半不能创建 Agent，所以界面点「立即运行」时只能把意图写成
   * `internal.manualRuns` 里的一条请求；宿主在下一次 tick 把它变成真正的运行。
   * 过期请求（超过 5 分钟）直接丢弃：它多半来自已经结束的界面会话，
   * 隔了很久突然跑一次对用户是惊吓而不是功能。
   */
  async function drainManualRuns() {
    if (stopped) return;
    const requests = store.getConfig().internal.manualRuns;
    if (!Array.isArray(requests) || requests.length === 0) return;

    const now = Date.now();
    const fresh = requests.filter((item) => (
      item !== null && typeof item === 'object'
      && typeof item.taskId === 'string'
      && Number.isFinite(item.requestedAt)
      && now - item.requestedAt < 300_000
    ));

    // 先清空队列再执行：避免运行期间界面又读到旧请求而重复触发。
    await store.setManualRuns([]);

    for (const request of fresh) {
      const task = findTask(store.getTasks(), request.taskId);
      if (task === undefined) {
        warn(`立即运行请求指向不存在的任务 ${request.taskId}，已忽略`);
        continue;
      }
      if (running.has(task.id) || store.getRuns()[task.id] !== undefined) {
        warn(`任务「${task.title}」已在运行，忽略重复的立即运行请求`);
        continue;
      }
      if (running.size >= Math.max(1, config.maxConcurrentRuns)) {
        warn('并发已达上限，立即运行请求顺延到下一次检查');
        await store.setManualRuns([request]);
        break;
      }
      await execute(task, 'manual', { started: [], skipped: [] });
    }
  }

  /**
   * 检查一次：找出到期任务并执行。
   * @returns {Promise<{ started: string[], skipped: string[] }>}
   */
  async function tick() {
    const outcome = { started: [], skipped: [] };
    if (stopped || ticking) return outcome;
    if (config.enabled !== true) return outcome;
    ticking = true;
    tickCount += 1;
    lastTickAt = Date.now();
    try {
      // 附加回调与任务检查同周期触发，但互相隔离：
      // 目录续期失败不该让任务检查落空，反之也一样。
      if (tickHooks.length > 0) {
        for (const hook of tickHooks.slice()) {
          try {
            hook();
          } catch (error) {
            warn(`tick 附加回调失败：${message(error)}`);
          }
        }
      }

      // 手动请求优先级高于定时：用户刚刚点了按钮，不希望等到下一个排期。
      await drainManualRuns();

      const now = Date.now();
      const tasks = store.getTasks();
      const due = [];
      const healed = [];
      for (const task of tasks) {
        if (task === null || typeof task !== 'object') continue;
        // 兜底排期：任何 enabled 却没有 nextRunAt 的周期任务都在这里补一次。
        //
        // 为什么必须有：`isTaskDue` 只看 `nextRunAt`，而 `nextRunAt` 原本只在
        // `prime()`（进程启动时）与运行结束后写入。如果一份任务定义是别处写进来的
        // （界面新建、手工编辑设置文档、上一次写入被中断），它在**本次进程内**就会
        // 永远缺 `nextRunAt`，从而永远不触发——静默失效比报错难查得多。
        // 这里让每个 tick 都自愈，代价只是一次数组扫描。
        if (task.enabled === true && !Number.isFinite(task.nextRunAt)) {
          const primed = ensureNextRun(task, now);
          if (Number.isFinite(primed.nextRunAt)) healed.push(primed);
          continue;
        }
        if (running.has(task.id)) {
          outcome.skipped.push(task.id);
          continue;
        }
        // 先用运行表判定（跨会话去重），再判到期。
        if (store.getRuns()[task.id] !== undefined) {
          outcome.skipped.push(task.id);
          continue;
        }
        if (isTaskDue(task, now)) due.push(task);
      }

      if (healed.length === 0 && due.length === 0) return outcome;

      // 补好的排期先落盘，下一次 tick 就会按新时间判定。它们**不在本次**触发：
      // 刚补出的时间点本来就在未来，立刻跑一次是不对的。
      if (healed.length > 0) {
        const byId = new Map(healed.map((task) => [task.id, task]));
        await store.setTasks(tasks.map((task) => byId.get(task.id) ?? task));
      }

      const capacity = Math.max(1, config.maxConcurrentRuns);
      const batch = due.slice(0, Math.max(0, capacity - running.size));
      for (const task of due.slice(batch.length)) outcome.skipped.push(task.id);

      // 并发派发；每个任务自己兜住异常。
      await Promise.all(batch.map((task) => execute(task, 'schedule', outcome)));
    } catch (error) {
      lastTickError = message(error);
      warn(`调度检查失败：${lastTickError}`);
    } finally {
      ticking = false;
    }
    return outcome;
  }

  /** 调度器自述状态：用于诊断「任务为什么不触发」。 */
  function stats() {
    return {
      tickMs: config.tickMs,
      tickCount,
      lastTickAt: lastTickAt === 0 ? null : lastTickAt,
      lastTickError,
      stopped,
      runningTaskIds: [...running],
    };
  }

  /**
   * 执行一个任务并把结果写回任务定义。
   * @param {object} task
   * @param {'schedule'|'manual'} trigger
   * @param {{ started?: string[] }} [outcome]
   */
  async function execute(task, trigger, outcome) {
    const startedAt = Date.now();
    running.add(task.id);
    if (outcome !== undefined) outcome.started.push(task.id);
    // 先落运行表：即使进程在运行中被杀掉，重启后也能从日志发现异常。
    await store.setRunState(task.id, { seq: 0, startedAt, trigger });

    let status = 'error';
    try {
      const record = await runner.run(task, trigger);
      status = typeof record?.status === 'string' ? record.status : 'error';
    } catch (error) {
      // runner 自身已经兜了异常；这里只是最后一道防线。
      warn(`任务 ${task.id} 执行失败：${message(error)}`);
      status = 'error';
    } finally {
      running.delete(task.id);
      await store.setRunState(task.id, null);
    }

    try {
      const current = findTask(store.getTasks(), task.id);
      if (current !== undefined) {
        const advanced = advanceTask(current, { nowMs: Date.now(), status });
        const tasks = store.getTasks().map((item) => (item.id === advanced.id ? advanced : item));
        await store.setTasks(tasks);
      }
    } catch (error) {
      warn(`回写任务 ${task.id} 状态失败：${message(error)}`);
    }
  }

  /** 每次 tick 的额外回调（宿主用来给模型目录续期之类）。 */
  const tickHooks = [];

  return {
    prime,
    /** 注册一个「每次 tick 都跑」的回调；返回注销函数。 */
    onTick(hook) {
      if (typeof hook !== 'function') return () => {};
      tickHooks.push(hook);
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        const at = tickHooks.indexOf(hook);
        if (at !== -1) tickHooks.splice(at, 1);
      };
    },

    /**
     * 启动轮询定时器。
     * @returns {() => void} 清理函数（必须接进 ctx.effect）
     */
    start() {
      const timer = setInterval(() => { void tick(); }, Math.max(1_000, config.tickMs));
      // Node 的 interval 会阻止进程退出；unref 让宿主退出不受影响。
      if (typeof timer?.unref === 'function') timer.unref();
      return () => {
        stopped = true;
        clearInterval(timer);
      };
    },

    tick,

    /**
     * 立即运行一个任务。
     *
     * 两条路径：
     *   - 宿主内部调用（模型工具 `scheduled_task_run`）直接执行；
     *   - 界面调用走 `internal.manualRuns` 队列，由下一次 tick 消费。
     * 这里暴露的是前者。
     *
     * @param {string} taskId
     * @returns {Promise<{ ok: true, record: object } | { ok: false, code: string, message: string }>}
     */
    async runNow(taskId) {
      const task = findTask(store.getTasks(), taskId);
      if (task === undefined) return { ok: false, code: 'task_not_found', message: `找不到任务 ${taskId}` };
      if (running.has(task.id) || store.getRuns()[task.id] !== undefined) {
        return { ok: false, code: 'already_running', message: `任务「${task.title}」正在运行中` };
      }
      const outcome = { started: [], skipped: [] };
      await execute(task, 'manual', outcome);
      const record = store.getLog().filter((row) => row.taskId === taskId).at(-1);
      if (record === undefined) {
        return { ok: false, code: 'run_failed', message: '运行没有产生日志记录' };
      }
      return { ok: true, record };
    },

    isRunning(taskId) {
      return running.has(taskId);
    },

    stats,
  };
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
