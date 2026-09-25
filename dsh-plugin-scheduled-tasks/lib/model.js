/**
 * 任务数据模型（纯函数，不碰 I/O，可单测）。
 *
 * 所有入口都必须过 `normalizeTask` / `validateTask`，这样界面、模型工具、
 * 恢复 Config 三条路径得到的是同一套校验，不会出现「界面上能存进去、
 * 调度器跑不起来」的偏差。
 */
import { nextScheduleTime, validateSchedule } from './cron.js';
import { LIMITS } from './constants.js';

/** 允许的终态与进行态。 */
export const STATUSES = ['running', 'ok', 'error', 'timeout', 'skipped'];

/**
 * 生成任务 id：`t` + base36 时间戳 + 8 位 base36 随机。
 *
 * 后缀取 8 位而不是 4 位：4 位只有 36^4 ≈ 1.7e6 种组合，同一毫秒内批量创建
 * 就会撞（生日问题在约 1300 个同毫秒 id 时就过半）。8 位给出 36^8 ≈ 2.8e12，
 * 配合毫秒时间戳在实践中不可能重复；`random` 仍可注入以便测试确定性。
 *
 * @param {number} nowMs
 * @param {() => number} [random]
 * @returns {string}
 */
export function newTaskId(nowMs, random = Math.random) {
  const stamp = Math.max(0, Math.floor(nowMs)).toString(36);
  let suffix = '';
  // `random()` 可能返回 0（注入固定值时尤其常见），而 `(0).toString(36)` 是单字符
  // "0"，`slice(2)` 会是空串——直接拼接会死循环。这里对空块补一个字符保证推进，
  // 并给循环一个硬上界兜底。
  for (let attempt = 0; suffix.length < 8 && attempt < 32; attempt += 1) {
    const chunk = random().toString(36).slice(2);
    suffix += chunk === '' ? '0' : chunk;
  }
  return `t${stamp}${suffix.slice(0, 8).padEnd(8, '0')}`;
}

/**
 * 校验一个**已归一化**的任务。
 * @param {object} task
 * @returns {string|null} 错误信息或 null
 */
export function validateTask(task) {
  if (task === null || typeof task !== 'object') return 'task 必须是对象';
  if (typeof task.id !== 'string' || task.id === '') return 'id 不能为空';
  const title = typeof task.title === 'string' ? task.title : '';
  if (title.trim() === '') return '标题不能为空';
  if (title.length > LIMITS.title) return `标题不能超过 ${LIMITS.title} 个字符`;
  if (title !== title.trim()) return '标题不能有首尾空白';
  const prompt = typeof task.prompt === 'string' ? task.prompt : '';
  if (prompt.trim() === '') return '提示词不能为空';
  if (prompt.length > LIMITS.prompt) return `提示词不能超过 ${LIMITS.prompt} 个字符`;
  if (typeof task.enabled !== 'boolean') return 'enabled 必须是布尔值';
  const scheduleError = validateSchedule(task.schedule);
  if (scheduleError !== null) return scheduleError;
  if (task.skill !== undefined && (typeof task.skill !== 'string' || task.skill.trim() === '')) {
    return 'skill 必须是非空字符串';
  }
  if (task.tools !== undefined && !Array.isArray(task.tools)) return 'tools 必须是字符串数组';
  if (task.workspaceRoot !== undefined && typeof task.workspaceRoot !== 'string') {
    return 'workspaceRoot 必须是字符串';
  }
  if (task.model !== undefined) {
    if (task.model === null || typeof task.model !== 'object') return 'model 必须是对象';
    if (typeof task.model.provider !== 'string' || task.model.provider === '') return 'model.provider 不能为空';
    if (typeof task.model.model !== 'string' || task.model.model === '') return 'model.model 不能为空';
    // 推理强度可省略（不表示"默认强度"之外的含义：省略时用该模型自己的默认值）。
    if (task.model.reasoningEffort !== undefined
      && (typeof task.model.reasoningEffort !== 'string' || task.model.reasoningEffort === '')) {
      return 'model.reasoningEffort 必须是非空字符串';
    }
  }
  return null;
}

/**
 * 把外部输入归一化成合法任务。
 *
 * @param {object} input 界面或模型工具传来的原始对象；已存在的任务也走这里。
 * @param {number} nowMs
 * @param {{ id?: string, random?: () => number }} [options]
 * @returns {{ task: object } | { error: string }}
 */
export function normalizeTask(input, nowMs, options = {}) {
  if (input === null || typeof input !== 'object') return { error: 'task 必须是对象' };

  // 超长字段一律**拒绝**而不是静默截断：用户写了一屏的提示词结果被砍掉一半，
  // 比他当场看到"太长了"要糟糕得多。
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (title === '') return { error: '标题不能为空' };
  if (title.length > LIMITS.title) return { error: `标题不能超过 ${LIMITS.title} 个字符` };

  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (prompt === '') return { error: '提示词不能为空' };
  if (prompt.length > LIMITS.prompt) return { error: `提示词不能超过 ${LIMITS.prompt} 个字符` };

  const schedule = normalizeSchedule(input.schedule);
  if (schedule === null) return { error: 'schedule 非法' };
  const scheduleError = validateSchedule(schedule);
  if (scheduleError !== null) return { error: scheduleError };

  const id = typeof options.id === 'string' && options.id !== ''
    ? options.id
    : (typeof input.id === 'string' && input.id !== '' ? input.id : newTaskId(nowMs, options.random));

  const createdAt = Number.isFinite(input.createdAt) && input.createdAt > 0 ? input.createdAt : nowMs;

  const task = {
    id,
    title,
    prompt,
    enabled: input.enabled !== false,
    schedule,
    createdAt,
    updatedAt: nowMs,
  };

  if (typeof input.skill === 'string' && input.skill.trim() !== '') {
    task.skill = input.skill.trim();
  }
  if (Array.isArray(input.tools)) {
    const tools = [...new Set(input.tools.filter((item) => typeof item === 'string' && item !== ''))];
    if (tools.length > 0) task.tools = tools;
  }
  if (typeof input.workspaceRoot === 'string' && input.workspaceRoot.trim() !== '') {
    task.workspaceRoot = input.workspaceRoot.trim();
  }
  // 模型覆盖：**必须成对给出**，否则拒绝。
  // 这里不能"缺一个就整个丢掉"——那样 `{provider:'p'}` 会静默变成「跟随默认模型」，
  // 用户以为选了 p、实际跑的是默认模型。宁可当场报错，也不要语义悄悄改变。
  if (input.model !== undefined && input.model !== null) {
    if (typeof input.model !== 'object' || Array.isArray(input.model)) {
      return { error: 'model 必须是对象' };
    }
    const provider = typeof input.model.provider === 'string' ? input.model.provider.trim() : '';
    const model = typeof input.model.model === 'string' ? input.model.model.trim() : '';
    if (provider === '' || model === '') {
      return { error: 'model.provider 与 model.model 必须同时填写；想跟随默认模型请省略整个 model' };
    }
    task.model = { provider, model };
    const effort = input.model.reasoningEffort;
    if (effort !== undefined) {
      if (typeof effort !== 'string') return { error: 'model.reasoningEffort 必须是字符串' };
      // 空白不写字段（= 用该模型自己的默认强度），非空白写进去。
      if (effort.trim() !== '') task.model.reasoningEffort = effort.trim();
    }
  }
  if (Number.isFinite(input.lastRunAt) && input.lastRunAt > 0) task.lastRunAt = input.lastRunAt;
  if (Number.isFinite(input.nextRunAt) && input.nextRunAt > 0) task.nextRunAt = input.nextRunAt;
  if (typeof input.lastStatus === 'string' && STATUSES.includes(input.lastStatus)) {
    task.lastStatus = input.lastStatus;
  }

  const error = validateTask(task);
  if (error !== null) return { error };
  return { task };
}

/** 归一化 schedule 到规范形状；无法识别的形状返回 null。 */
export function normalizeSchedule(schedule) {
  if (schedule === null || typeof schedule !== 'object') return null;
  switch (schedule.kind) {
    case 'every': {
      const minutes = Number(schedule.everyMinutes);
      if (!Number.isSafeInteger(minutes)) return null;
      return { kind: 'every', everyMinutes: minutes };
    }
    case 'daily': {
      if (typeof schedule.time !== 'string') return null;
      return { kind: 'daily', time: schedule.time.trim() };
    }
    case 'weekly': {
      if (typeof schedule.time !== 'string' || !Array.isArray(schedule.weekdays)) return null;
      const weekdays = [...new Set(
        schedule.weekdays.filter((day) => Number.isSafeInteger(day) && day >= 1 && day <= 7),
      )].sort((left, right) => left - right);
      return { kind: 'weekly', time: schedule.time.trim(), weekdays };
    }
    case 'cron': {
      if (typeof schedule.expression !== 'string') return null;
      return { kind: 'cron', expression: schedule.expression.trim() };
    }
    case 'once': {
      const at = Number(schedule.at);
      if (!Number.isFinite(at)) return null;
      return { kind: 'once', at };
    }
    default:
      return null;
  }
}

/**
 * 按 id 找任务。
 * @param {object[]} tasks
 * @param {string} id
 * @returns {object|undefined}
 */
export function findTask(tasks, id) {
  if (!Array.isArray(tasks)) return undefined;
  return tasks.find((task) => task !== null && typeof task === 'object' && task.id === id);
}

/**
 * 判断任务此刻是否应当触发。
 *
 * 判定只看 `nextRunAt`：它是「已排定的下一次触发时刻」，由创建时与每次运行后的
 * `advanceTask` / 启动时的 `ensureNextRun` 写入。没有 `nextRunAt` 的任务**按定义
 * 就没有排定时刻**（例如设置文档被手工清空过），因此不触发——这是安全方向：
 * 宁可等 `prime()` 把排期补上，也不要把一个刚创建的任务当成"已到期"而立刻跑一次。
 *
 * `once` 是唯一按自身时间表判定的类型，因为它没有周期性 nextRunAt 可依赖。
 *
 * @param {object} task
 * @param {number} nowMs
 * @returns {boolean}
 */
export function isTaskDue(task, nowMs) {
  if (task === null || typeof task !== 'object' || task.enabled !== true) return false;
  if (task.schedule !== null && typeof task.schedule === 'object' && task.schedule.kind === 'once') {
    const at = Number(task.schedule.at);
    return Number.isFinite(at) && at <= nowMs;
  }
  if (!Number.isFinite(task.nextRunAt)) return false;
  return task.nextRunAt <= nowMs;
}

/**
 * 运行结束后推进任务：写 lastRunAt / lastStatus / nextRunAt。
 * 纯函数，返回新对象；`once` 任务自动停用。
 *
 * @param {object} task
 * @param {{ nowMs: number, status: string }} outcome
 * @returns {object} 新任务对象（原对象不被修改）
 */
export function advanceTask(task, outcome) {
  const { nowMs, status } = outcome;
  const next = { ...task, lastRunAt: nowMs, updatedAt: nowMs, lastStatus: status };

  if (task.schedule !== null && typeof task.schedule === 'object' && task.schedule.kind === 'once') {
    // 一次性任务只跑一次：失去下一次触发时间并停用。
    delete next.nextRunAt;
    next.enabled = false;
    return next;
  }

  const computed = nextScheduleTime(task.schedule, nowMs);
  if (computed === null) {
    delete next.nextRunAt;
    if (status === 'ok' || status === 'error' || status === 'timeout') next.enabled = false;
    return next;
  }
  next.nextRunAt = computed;
  return next;
}

/**
 * 为任务补上 `nextRunAt`（创建时、启用时、启动恢复时调用）。
 * 已有且仍在未来的 `nextRunAt` 保持不变，避免每次启动都重排。
 *
 * @param {object} task
 * @param {number} nowMs
 * @returns {object} 新任务对象
 */
export function ensureNextRun(task, nowMs) {
  if (task.enabled !== true) return task;
  if (Number.isFinite(task.nextRunAt) && task.nextRunAt > nowMs) return task;
  const computed = nextScheduleTime(task.schedule, nowMs);
  const next = { ...task };
  if (computed === null) delete next.nextRunAt;
  else next.nextRunAt = computed;
  return next;
}
