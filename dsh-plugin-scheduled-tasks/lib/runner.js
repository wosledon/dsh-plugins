/**
 * 执行引擎：到点真正跑一次大模型。
 *
 * 这是本插件与内置 `@deepseek-ai/dsh-schedule` 的本质区别所在——后者只把提醒
 * 文本投递进原会话，本模块则**新开一个独立会话**，把提示词交给一个真实 Agent
 * 跑完整一轮（可带工具、可加载 skill），结束后回收。
 *
 * 三个已核实的原语：
 *   - `ctx.agentLoop.createAgent(ctx, { sessionId, agentOptions, meta })`
 *     → `{ agent, dispose }`；agent 由本插件的 fiber 拥有。
 *   - `agent.followup(input)` —— 投递一条 user 消息并**唤醒**驱动（`agent.inject()`
 *     不会唤醒，所以定时任务必须用 followup）。
 *   - `await agent.whenIdle()` —— 等到当前活动区间真正结束。
 *
 * 每次运行都必须 dispose：Agent 是注册在 live 注册表里的长生命周期对象，
 * 不回收会持续占用会话与订阅。
 */
import { LIMITS } from './constants.js';

/** 轮询等待 whenIdle 的间隔；纯本地调度，不需要更密。 */
const IDLE_POLL_MS = 250;

/**
 * 「驱动是否开工」的宽限期。
 * `followup()` 之后驱动应当立刻被唤醒；超过这个时间仍空闲且没有任何新会话事件，
 * 就认为这一轮没有启动，不再等到运行超时。
 */
const NOT_STARTED_GRACE_MS = 3_000;

/**
 * 组装发给大模型的提示词（唯一实现，见 CONTRACT.md §4）。
 * @param {object} task
 * @returns {string}
 */
export function composePrompt(task) {
  const lines = [
    '你是由「定时任务」插件自动唤醒的执行体，本次运行没有人在实时对话。',
    `任务标题：${task.title}`,
    '任务指令：',
    task.prompt,
  ];
  if (typeof task.skill === 'string' && task.skill !== '') {
    lines.push(`请先调用 skill 工具加载「${task.skill}」技能，并严格按它的说明执行。`);
  }
  lines.push('要求：直接开始执行，不要询问确认；完成后用一段话总结你做了什么、结果如何。');
  return lines.join('\n');
}

/**
 * @param {object} ctx 宿主 plugin context
 * @param {object} store createStore() 的结果
 * @param {{ workspaceRoot?: string }} [options]
 * @returns {{ run: (task: object, trigger: string) => Promise<object> }}
 */
export function createRunner(ctx, store, options = {}) {
  /**
   * 跑一次任务。
   * 任何失败都收敛成一条终态日志记录，绝不抛给调度器——一个任务跑挂了
   * 不能让整个定时器停摆。
   *
   * @param {object} task
   * @param {'schedule'|'manual'} trigger
   * @returns {Promise<object>} 终态 LogRecord
   */
  async function run(task, trigger) {
    const startedAt = Date.now();
    const sessionId = `scheduled-task-${task.id}-${startedAt}`;
    const base = {
      taskId: task.id,
      title: task.title,
      startedAt,
      endedAt: startedAt,
      status: 'error',
      trigger,
      sessionId,
      summary: '',
    };

    const agentLoop = ctx?.get?.('agentLoop');
    if (agentLoop === undefined || agentLoop === null || typeof agentLoop.createAgent !== 'function') {
      return finish(base, {
        error: 'agentLoop 服务不可用，无法执行大模型任务',
      });
    }

    let handle;
    try {
      const createOptions = { sessionId, signal: undefined };
      if (task.model !== undefined && task.model !== null) {
        // 只在真的指定了 provider/model 时才覆盖：缺任何一个都说明「跟随默认模型」，
        // 此时应当让新会话走会话自己的模型选择，而不是塞一个半截配置进去。
        const provider = typeof task.model.provider === 'string' ? task.model.provider : '';
        const model = typeof task.model.model === 'string' ? task.model.model : '';
        const agentOptions = {};
        if (provider !== '') agentOptions.provider = provider;
        if (model !== '') agentOptions.model = model;
        // 推理强度交给宿主校验：写进一个该模型不支持的值时，宿主会在发起请求前
        // 拒绝那次运行，我们这边如实记 error，不预先替宿主判断。
        if (typeof task.model.reasoningEffort === 'string' && task.model.reasoningEffort !== '') {
          agentOptions.reasoningEffort = task.model.reasoningEffort;
        }
        if (Object.keys(agentOptions).length > 0) createOptions.agentOptions = agentOptions;
      }
      const cwd = task.workspaceRoot ?? options.workspaceRoot;
      if (typeof cwd === 'string' && cwd !== '') createOptions.meta = { cwd };

      handle = await agentLoop.createAgent(ctx, createOptions);
    } catch (error) {
      return finish(base, { error: `创建会话失败：${message(error)}` });
    }

    const agent = handle?.agent;
    if (agent === undefined || agent === null) {
      await safeDispose(handle);
      return finish(base, { error: '创建会话失败：没有拿到 agent' });
    }

    try {
      // 可选工具白名单：注册在 agent 自己的 ctx 上，随 agent 一起销毁。
      if (Array.isArray(task.tools) && task.tools.length > 0 && typeof agent.ctx?.tools?.restrict === 'function') {
        const disposer = agent.ctx.tools.restrict({ allow: task.tools });
        if (typeof disposer === 'function') agent.ctx.effect(() => disposer, 'scheduled-tasks: tool allowlist');
      }

      if (typeof agent.followup !== 'function') {
        return finish(base, { error: 'agent 不支持 followup，无法投递提示词' });
      }

      // 先记下投递前的会话长度：后面用它区分「这一轮真的跑了」与「根本没启动」。
      const before = sessionEventCount(agent);
      agent.followup(composePrompt(task));

      const timeout = Number.isFinite(options.runTimeoutMs) && options.runTimeoutMs > 0
        ? options.runTimeoutMs
        : 1_800_000;
      const outcome = await waitForRun(agent, before, timeout);

      const collected = collectResult(agent);
      if (outcome === 'timeout') {
        if (typeof agent.cancel === 'function') {
          try {
            agent.cancel({ kind: 'disposed' });
          } catch {
            /* 取消失败不影响记录 */
          }
        }
        return finish(base, {
          status: 'timeout',
          summary: collected.summary,
          toolCalls: collected.toolCalls,
          error: `运行超过 ${Math.round(timeout / 1000)} 秒仍未结束，已被中止`,
        });
      }

      // `whenIdle()` 只表示「当前没有活动区间」，它在 followup 尚未真正唤醒驱动时
      // 会立刻返回（这正是参考实现警告过的语义）。若会话一条新事件都没有增加，
      // 说明这一轮根本没有跑起来：如实记为 error，绝不能谎报 ok。
      if (outcome === 'empty') {
        return finish(base, {
          status: 'error',
          error: '定时运行没有产生任何会话事件：这一轮没有真正启动。请检查工作区(workspaceRoot)、模型配置与工具可用性。',
        });
      }

      return finish(base, {
        status: 'ok',
        summary: collected.summary,
        toolCalls: collected.toolCalls,
      });
    } catch (error) {
      return finish(base, { error: message(error) });
    } finally {
      await safeDispose(handle);
    }
  }

  /** 把结果写进 store 并返回终态记录。 */
  async function finish(base, patch) {
    const endedAt = Date.now();
    const record = {
      ...base,
      ...patch,
      endedAt,
      summary: clamp(typeof patch.summary === 'string' ? patch.summary : '', LIMITS.summary),
    };
    if (record.error !== undefined) record.error = clamp(String(record.error), LIMITS.error);
    const stored = await store.appendLog(record);
    return stored;
  }

  return { run, composePrompt };
}

/**
 * 等到这一次 followup 真正跑完。
 *
 * 为什么不能只 `await agent.whenIdle()`：`whenIdle()` 的语义是「等到当前活动区间
 * 结束」，而 `followup()` 只是把消息放进 inbox 并请求唤醒——驱动可能还没开始跑，
 * 此时 `whenIdle()` 立刻返回。实测（真机 E2E）这一个竞态会让一次从未启动的运行
 * 被记成 `ok`，会话里只有一行 session 头。
 *
 * 所以这里分两段判定：
 *   1. 先等驱动真的开工（会话事件数增长）；
 *   2. 再等它空闲。
 * 并且用会话事件数是否增长区分「跑完了但没写摘要」与「压根没跑」。
 *
 * @param {object} agent
 * @param {number} before 投递前的事件数
 * @param {number} timeoutMs
 * @returns {Promise<'idle'|'timeout'|'empty'>}
 */
async function waitForRun(agent, before, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  // 阶段 1：等驱动开工。
  // 上限取 min(60s, 超时)，但只要「已经过了宽限期、agent 仍空闲、且会话一条新事件
  // 都没有」就立刻判定为没启动——不需要把整个运行超时耗完才发现。
  const startBudget = Math.min(60_000, Math.max(5_000, timeoutMs));
  const startDeadline = Date.now() + startBudget;
  const graceDeadline = Date.now() + Math.min(NOT_STARTED_GRACE_MS, startBudget);
  let started = sessionEventCount(agent) > before;
  while (!started && Date.now() < startDeadline) {
    await delay(IDLE_POLL_MS);
    started = sessionEventCount(agent) > before || agent.status === 'running';
    if (started) break;
    if (Date.now() >= graceDeadline) return 'empty';
  }
  if (!started) return 'empty';

  // 阶段 2：等这一轮结束。
  for (;;) {
    if (typeof agent.whenIdle === 'function') {
      if (await isSettled(agent.whenIdle())) return 'idle';
    }
    if (Date.now() >= deadline) return 'timeout';
    await delay(IDLE_POLL_MS);
  }
}

/** 该 agent 会话当前的事件数；读不到时返回 0。 */
function sessionEventCount(agent) {
  try {
    const session = agent?.session;
    if (session === undefined || session === null || typeof session.snapshotEvents !== 'function') return 0;
    const events = session.snapshotEvents();
    return Array.isArray(events) ? events.length : 0;
  } catch {
    return 0;
  }
}

/**
 * 判断 promise 是否已经结束。
 *
 * 用一个 0ms 定时器把「已结束」与「还没结束」分开：promise 先 settle 就在这一
 * 微任务轮次里置位 done，否则由定时器后到。定时器一定被清掉，不会泄漏。
 */
function isSettled(promise) {
  let done = false;
  const guard = promise.then(() => { done = true; }, () => { done = true; });
  let timer;
  const tick = new Promise((resolve) => { timer = setTimeout(resolve, 0); });
  return Promise.race([guard.then(() => done), tick.then(() => done)])
    .then((value) => value)
    .finally(() => { clearTimeout(timer); });
}

function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * 从该次运行的会话里取回结果。
 * 会话日志是唯一事实来源，所以读它而不是读任何内存态。
 * 这些读取全部做能力探测：宿主版本变化时降级为「没有摘要」，不影响运行本身。
 *
 * @param {object} agent
 * @returns {{ summary: string, toolCalls: number }}
 */
function collectResult(agent) {
  const result = { summary: '', toolCalls: 0 };
  try {
    const session = agent.session;
    if (session === undefined || session === null || typeof session.snapshotEvents !== 'function') return result;
    const events = session.snapshotEvents();
    if (!Array.isArray(events)) return result;

    for (const event of events) {
      if (event === null || typeof event !== 'object') continue;
      if (event.type === 'tool/result') result.toolCalls += 1;
    }

    const texts = [];
    for (let index = events.length - 1; index >= 0 && texts.length < 3; index -= 1) {
      const event = events[index];
      if (event === null || typeof event !== 'object' || event.type !== 'assistant/message') continue;
      const text = messageText(event.data);
      if (text !== '') texts.unshift(text);
    }
    result.summary = texts.join('\n\n');
  } catch {
    /* 采集失败只丢摘要，不影响运行结论 */
  }
  return result;
}

/** 把 assistant 消息的文本块拼起来。 */
function messageText(data) {
  const message = data !== null && typeof data === 'object' ? data.message : undefined;
  const content = message !== null && typeof message === 'object' ? message.content : undefined;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}

/** 回收 Agent；失败只记录，不冒泡。 */
async function safeDispose(handle) {
  if (handle === undefined || handle === null || typeof handle.dispose !== 'function') return;
  try {
    await handle.dispose();
  } catch {
    /* Agent 已在别处回收 */
  }
}

function clamp(text, limit) {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function message(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
