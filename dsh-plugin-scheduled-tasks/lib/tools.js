/**
 * lib/tools.js — 「对话创建任务」的模型工具注册（宿主半）。
 *
 * 约束（见 CONTRACT.md §3）：
 * - 纯 JS，**不 import 任何 @deepseek-ai/***；宿主能力由 index.js 注入。
 * - 注册 5 个工具：scheduled_task_create / _list / _update / _delete / _run。
 * - 工具结果一律渲染成 JSON 文本；失败返回 { ok:false, code, message }，绝不抛异常。
 * - 每个注册的清理函数都接进 ctx.effect(..., label)，保证卸载时注销。
 *
 * 关于 defineTool：
 *   `helpers.defineTool` 由 index.js 传入宿主真实现（@deepseek-ai/dsh-tools）。
 *   `parameters` 使用该实现的 author DSL：属性名 -> 节点；节点用
 *   `required: true` 标记必填，object 节点必须显式给出 `additionalProperties`，
 *   oneOf 节点不得同时声明 `type`，oneOf 分支不得声明 `required`。
 *   helpers.defineTool 缺失时退化为本文件内置的等价编译器（compileParameters），
 *   因此本模块可以脱离宿主单独加载与自测。
 *
 * @module dsh-plugin-scheduled-tasks/lib/tools
 */

/** 工具名（顺序即注册顺序）。 */
export const TOOL_NAMES = Object.freeze([
  'scheduled_task_create',
  'scheduled_task_list',
  'scheduled_task_update',
  'scheduled_task_delete',
  'scheduled_task_run',
]);

const SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'object', 'array', 'json']);
const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples'];
const SECTION_NAME = 'plugin:scheduled-tasks';

const SCHEMA_REFERENCE = 'schedule 判别式对象形状：'
  + '{kind:"every",everyMinutes:30..43200} | {kind:"daily",time:"HH:mm"} | '
  + '{kind:"weekly",time:"HH:mm",weekdays:[1..7]}（周一=1） | {kind:"cron",expression:"五段 Vixie"} | '
  + '{kind:"once",at:epochMs}。';

const CREATE_DESCRIPTION = [
  '创建一个定时任务：到达触发时间后，本插件会自动唤醒大模型，按 prompt 无人值守地执行一次。',
  '当用户说出「每天早上 9 点帮我总结昨天的 git 提交」「每周一 10:00 汇总上周工单」「每隔 2 小时检查一次构建状态」'
  + '这类"时间 + 要做什么"的需求时，使用本工具。',
  '行为约定：必须先用自然语言向用户复述并确认触发时间与任务内容（例如"确认一下：每天 09:00，内容是总结前一天的 git 提交，对吗？"），'
  + '用户确认后再调用本工具；不要替用户猜测或擅自决定时间与内容。',
  SCHEMA_REFERENCE,
  'prompt 必须是自包含、可无人值守执行的指令：运行时不与用户实时对话，无法反问，所以要把仓库/范围/输出要求写清楚。',
].join(' ');

const LIST_DESCRIPTION = '列出当前已配置的全部定时任务（含 id、标题、可读的触发时间、下次运行时间、上次运行结果）。'
  + '在更新/删除/立即运行之前，先用本工具拿到准确的 id。';

const UPDATE_DESCRIPTION = '修改一个已存在的定时任务：只传需要改的字段，未传字段保持不变。'
  + '改标题/提示词/触发时间/启停开关/所属 skill 等都用本工具。必须先通过 scheduled_task_list 取得准确 id；'
  + '如果改动涉及时间或内容语义，先向用户确认再改。' + SCHEMA_REFERENCE;

const DELETE_DESCRIPTION = '删除一个定时任务（不可恢复）。先用 scheduled_task_list 确认 id 与标题，'
  + '删除前应向用户复述要删除的任务标题。';

const RUN_DESCRIPTION = '立即手动执行一次指定任务（不影响它的定时计划）。'
  + '用于用户说"现在就试跑一次"的场景；本工具会等待这次运行结束并返回运行状态与结果摘要。';

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function jsonText(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return JSON.stringify({ ok: false, code: 'SERIALIZE_ERROR', message: '工具结果无法序列化为 JSON。' });
  }
}

function errorMessage(error) {
  if (error instanceof Error && typeof error.message === 'string' && error.message.length > 0) return error.message;
  if (typeof error === 'string' && error.length > 0) return error;
  return String(error);
}

function warn(message) {
  try {
    console.warn(`[scheduled-tasks] ${message}`);
  } catch {
    /* console 被占用时静默 */
  }
}

function preview(value, limit) {
  if (typeof value !== 'string') return null;
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/** 失败结果：永远是数据，不是异常。 */
function fail(code, message) {
  return { ok: false, code, message };
}

/** 把一次工具执行包起来：任何异常都转成 ok:false 结果。 */
async function guard(run) {
  try {
    const result = await run();
    return isRecord(result) && typeof result.ok === 'boolean' ? result : fail('INTERNAL_ERROR', '工具返回了非法结果。');
  } catch (error) {
    return fail('INTERNAL_ERROR', errorMessage(error));
  }
}

/** 安全取服务：优先 ctx.get(name)（Cordis 安全探测），否则回落到 ctx[name]。 */
function serviceOn(ctx, name) {
  if (ctx === null || ctx === undefined) return undefined;
  try {
    if (typeof ctx.get === 'function') {
      const viaGet = ctx.get(name);
      if (viaGet !== undefined && viaGet !== null) return viaGet;
    }
  } catch {
    /* 探测失败则继续回落 */
  }
  try {
    const direct = ctx[name];
    if (direct !== undefined && direct !== null) return direct;
  } catch {
    /* Cordis 上下文中未注入的服务可能抛错，忽略 */
  }
  return undefined;
}

/** 取一次定义在宿主提示词里的排序位；拿不到就退到一个靠后的固定值。 */
function resolveSectionOrder(systemPrompt) {
  const candidates = ['TOOL_SCHEDULED_TASKS', 'TOOL_RALPH', 'TOOLS'];
  for (let index = 0; index < candidates.length; index += 1) {
    try {
      const order = systemPrompt.getSectionOrder(candidates[index]);
      if (typeof order === 'number' && Number.isFinite(order)) return order + index;
    } catch {
      /* 该名字不在中央注册表里 */
    }
  }
  return 1000;
}

/** 调用 describeSchedule，失败不致命。 */
function describe(api, schedule) {
  if (api === undefined || api === null || typeof api.describeSchedule !== 'function') return null;
  try {
    const text = api.describeSchedule(schedule);
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* author DSL -> JSON Schema（helpers.defineTool 缺失时的等价退化实现）  */
/* ------------------------------------------------------------------ */

/**
 * 编译一个 value schema 节点（不处理"是否必填"，必填由属性映射层处理）。
 * @param {unknown} node author DSL 节点
 * @param {string} path 诊断路径
 * @returns {Record<string, unknown>} 收敛到受支持子集的 JSON Schema 节点
 */
function compileValueSchema(node, path) {
  if (!isRecord(node)) throw new Error(`${path} 必须是对象`);
  const out = {};
  for (const key of ANNOTATION_KEYS) {
    if (Object.hasOwn(node, key)) out[key] = node[key];
  }
  if (Object.hasOwn(node, 'oneOf')) {
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) throw new Error(`${path}.oneOf 至少需要两个分支`);
    out.oneOf = node.oneOf.map((branch, index) => compileValueSchema(branch, `${path}.oneOf[${index}]`));
    return out;
  }
  const type = Object.hasOwn(node, 'type') ? node.type : 'json';
  if (type === 'json') return out;
  if (!SCHEMA_TYPES.has(type)) throw new Error(`${path}.type 非法：${String(type)}`);
  out.type = type;
  if (type === 'object') {
    out.additionalProperties = node.additionalProperties === true;
    const properties = {};
    const required = [];
    const entries = isRecord(node.properties) ? node.properties : {};
    for (const [name, child] of Object.entries(entries)) {
      properties[name] = compileValueSchema(child, `${path}.${name}`);
      if (isRecord(child) && child.required === true) required.push(name);
    }
    out.properties = properties;
    if (required.length > 0) out.required = required;
  } else if (type === 'array') {
    if (Object.hasOwn(node, 'items')) out.items = compileValueSchema(node.items, `${path}.items`);
  } else {
    if (Object.hasOwn(node, 'enum')) out.enum = Array.from(node.enum);
    if (Object.hasOwn(node, 'const')) out.const = node.const;
  }
  return out;
}

/**
 * 把一个隐式属性映射（工具 parameters 的 author DSL）编译成 object 根 JSON Schema。
 * @param {Record<string, unknown>} spec 属性名 -> 节点
 * @returns {Record<string, unknown>}
 */
export function compileParameters(spec) {
  if (!isRecord(spec)) throw new Error('parameters 必须是属性映射对象');
  const properties = {};
  const required = [];
  for (const [name, node] of Object.entries(spec)) {
    properties[name] = compileValueSchema(node, `parameters.${name}`);
    if (isRecord(node) && node.required === true) required.push(name);
  }
  const schema = { type: 'object', properties, additionalProperties: true };
  if (required.length > 0) schema.required = required;
  return schema;
}

/** helpers.defineTool 缺失时的退化实现：结构与宿主 defineTool 的产物一致。 */
function localDefineTool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: compileParameters(options.parameters),
    output: {
      schema: compileValueSchema(options.output.schema, 'schema'),
      render: options.output.render,
    },
    execute: options.execute,
    ...(options.presentCall === undefined ? {} : { presentCall: options.presentCall }),
    ...(options.presentResult === undefined ? {} : { presentResult: options.presentResult }),
  };
}

function resolveDefineTool(helpers) {
  if (isRecord(helpers) && typeof helpers.defineTool === 'function') return helpers.defineTool;
  return localDefineTool;
}

/* ------------------------------------------------------------------ */
/* 参数 DSL                                                            */
/* ------------------------------------------------------------------ */

/** 5 种 schedule 形状；每次取用都深拷贝，避免同一子对象被同一份 schema 引用两次。 */
const SCHEDULE_BRANCHES = [
  {
    type: 'object',
    additionalProperties: false,
    description: 'every：固定间隔，每 everyMinutes 分钟触发一次。',
    properties: {
      kind: { type: 'string', enum: ['every'], required: true, description: '固定间隔判别值，必须是 "every"。' },
      everyMinutes: { type: 'number', required: true, description: '间隔分钟数，最小 30，最大 43200（30 天）。' },
    },
  },
  {
    type: 'object',
    additionalProperties: false,
    description: 'daily：每天本地时间 time 触发一次。',
    properties: {
      kind: { type: 'string', enum: ['daily'], required: true, description: '按天判别值，必须是 "daily"。' },
      time: { type: 'string', required: true, description: '本地时间 "HH:mm"（24 小时制，两位数字，例如 "09:00"、"21:30"）。' },
    },
  },
  {
    type: 'object',
    additionalProperties: false,
    description: 'weekly：每周指定星期的本地时间 time 触发。',
    properties: {
      kind: { type: 'string', enum: ['weekly'], required: true, description: '按周判别值，必须是 "weekly"。' },
      time: { type: 'string', required: true, description: '本地时间 "HH:mm"（24 小时制，例如 "10:00"）。' },
      weekdays: {
        type: 'array',
        required: true,
        description: '星期数组，1..7（周一=1，周日=7），升序去重，例如 [1,3,5]。',
        items: { type: 'integer', description: '一个星期几，取值 1..7。' },
      },
    },
  },
  {
    type: 'object',
    additionalProperties: false,
    description: 'cron：标准五段 Vixie cron 表达式，按宿主本地时区求下一次触发。',
    properties: {
      kind: { type: 'string', enum: ['cron'], required: true, description: 'cron 判别值，必须是 "cron"。' },
      expression: {
        type: 'string',
        required: true,
        description: '五段表达式 "minute hour day-of-month month day-of-week"；每段支持 *、单值、a-b、*/n、a-b/n、逗号列表；'
          + 'dow 中 0 和 7 都表示周日。不接受 L/W/#、英文月份/星期名、@daily 之类的宏、六段表达式。',
      },
    },
  },
  {
    type: 'object',
    additionalProperties: false,
    description: 'once：在指定时间点触发一次，触发后自动停用。',
    properties: {
      kind: { type: 'string', enum: ['once'], required: true, description: '一次性判别值，必须是 "once"。' },
      at: { type: 'number', required: true, description: '触发时刻的 epoch 毫秒数（必须晚于当前时间）。' },
    },
  },
];

function scheduleParameter(required) {
  return {
    ...(required ? { required: true } : {}),
    description: `触发时间。${SCHEMA_REFERENCE} 按 kind 只提供对应形状的字段。`,
    oneOf: cloneJson(SCHEDULE_BRANCHES),
  };
}

const TASK_FIELD_PARAMETERS = {
  title: { type: 'string', description: '任务标题，1..120 字符，用于列表与日志展示。' },
  prompt: { type: 'string', description: '发给大模型的完整提示词，1..20000 字符；必须自包含、可无人值守执行。' },
  skill: { type: 'string', description: '可选：运行前要求模型加载的 skill 名（kebab-case，例如 "git-summary"）。' },
  enabled: { type: 'boolean', description: '可选：是否启用。省略时默认 true；设为 false 只保存不触发。' },
  workspaceRoot: { type: 'string', description: '可选：该次运行的 cwd（绝对路径）。省略则用插件配置的默认工作区。' },
  tools: {
    type: 'array',
    description: '可选：限制该次运行可用的工具白名单（工具名数组）。省略表示不限制。',
    items: { type: 'string', description: '工具名。' },
  },
  model: {
    type: 'object',
    additionalProperties: false,
    description: '可选：覆盖该次运行使用的模型。',
    properties: {
      provider: { type: 'string', required: true, description: '供应商标识。' },
      model: { type: 'string', required: true, description: '模型名。' },
      reasoningEffort: {
        type: 'string',
        description: '可选：推理强度，必须是该模型自己声明的 effort id（例如 "minimal"/"low"/"high"）。省略表示用该模型的默认强度；模型不支持推理时忽略。',
      },
    },
  },
};

function createParameters() {
  return {
    title: { ...TASK_FIELD_PARAMETERS.title, required: true },
    prompt: { ...TASK_FIELD_PARAMETERS.prompt, required: true },
    schedule: scheduleParameter(true),
    skill: cloneJson(TASK_FIELD_PARAMETERS.skill),
    enabled: cloneJson(TASK_FIELD_PARAMETERS.enabled),
    workspaceRoot: cloneJson(TASK_FIELD_PARAMETERS.workspaceRoot),
    tools: cloneJson(TASK_FIELD_PARAMETERS.tools),
    model: cloneJson(TASK_FIELD_PARAMETERS.model),
  };
}

function updateParameters() {
  return {
    id: { type: 'string', required: true, description: '要修改的任务 id（先用 scheduled_task_list 取得）。' },
    title: cloneJson(TASK_FIELD_PARAMETERS.title),
    prompt: cloneJson(TASK_FIELD_PARAMETERS.prompt),
    schedule: scheduleParameter(false),
    skill: cloneJson(TASK_FIELD_PARAMETERS.skill),
    enabled: cloneJson(TASK_FIELD_PARAMETERS.enabled),
    workspaceRoot: cloneJson(TASK_FIELD_PARAMETERS.workspaceRoot),
    tools: cloneJson(TASK_FIELD_PARAMETERS.tools),
    model: cloneJson(TASK_FIELD_PARAMETERS.model),
  };
}

function idParameters(description) {
  return { id: { type: 'string', required: true, description } };
}

/** 输出 schema：所有工具都返回 { ok, code?, message?, ... }。 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  description: '工具结果：失败时 { ok:false, code, message }，成功时附任务/日志数据。',
  properties: {
    ok: { type: 'boolean', required: true, description: '调用是否被接受。' },
    code: { type: 'string', description: '失败原因代码（仅失败时）。' },
    message: { type: 'string', description: '面向模型/用户的失败说明（仅失败时）。' },
  },
};

/* ------------------------------------------------------------------ */
/* 工具行为                                                            */
/* ------------------------------------------------------------------ */

const CREATE_FIELDS = ['title', 'prompt', 'schedule', 'skill', 'enabled', 'workspaceRoot', 'tools', 'model'];
const UPDATE_FIELDS = ['title', 'prompt', 'schedule', 'skill', 'enabled', 'workspaceRoot', 'tools', 'model'];

function pick(args, fields) {
  const input = {};
  for (const field of fields) {
    if (Object.hasOwn(args, field) && args[field] !== undefined) input[field] = args[field];
  }
  return input;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * 本地预检 schedule 形状（只做"字段是否存在/类型/取值域"级别的检查，
 * 下一次触发时间的计算与 cron 方言校验仍由宿主 api 负责，避免两处口径漂移）。
 * @param {unknown} schedule
 * @returns {string|null} 错误信息，合法则 null
 */
function validateScheduleShape(schedule) {
  if (!isRecord(schedule)) return 'schedule 必须是对象。';
  switch (schedule.kind) {
    case 'every': {
      const minutes = schedule.everyMinutes;
      if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return 'every 需要数值型 everyMinutes。';
      if (minutes < 30 || minutes > 43200) return 'everyMinutes 必须在 30..43200 之间。';
      return null;
    }
    case 'daily': {
      if (typeof schedule.time !== 'string' || !HHMM.test(schedule.time)) return 'daily 需要 "HH:mm" 形式的 time（例如 "09:00"）。';
      return null;
    }
    case 'weekly': {
      if (typeof schedule.time !== 'string' || !HHMM.test(schedule.time)) return 'weekly 需要 "HH:mm" 形式的 time（例如 "10:00"）。';
      const days = schedule.weekdays;
      if (!Array.isArray(days) || days.length === 0) return 'weekly 需要非空的 weekdays 数组（1..7，周一=1）。';
      for (const day of days) {
        if (!Number.isInteger(day) || day < 1 || day > 7) return 'weekdays 只能包含 1..7 的整数（周一=1，周日=7）。';
      }
      return null;
    }
    case 'cron': {
      if (typeof schedule.expression !== 'string' || schedule.expression.trim().length === 0) {
        return 'cron 需要非空字符串 expression（五段 Vixie 表达式）。';
      }
      return null;
    }
    case 'once': {
      const at = schedule.at;
      if (typeof at !== 'number' || !Number.isFinite(at)) return 'once 需要数值型 at（epoch 毫秒）。';
      return null;
    }
    default:
      return 'schedule.kind 必须是 every/daily/weekly/cron/once 之一。';
  }
}

function failFrom(api, result) {
  const code = typeof result.code === 'string' && result.code.length > 0 ? result.code : 'UNKNOWN';
  const message = typeof result.message === 'string' && result.message.length > 0 ? result.message : '定时任务服务拒绝了这次调用。';
  return fail(code, message);
}

/** api 缺失时返回失败结果，否则返回 null（表示可用）。 */
function requireApi(api) {
  if (api !== null && api !== undefined && (typeof api === 'object' || typeof api === 'function')) return null;
  return fail('API_UNAVAILABLE', '定时任务服务未装配，无法操作任务。');
}

function summarizeTask(api, task) {
  const t = isRecord(task) ? task : {};
  const model = isRecord(t.model) ? t.model : null;
  return {
    id: t.id ?? null,
    title: t.title ?? null,
    enabled: t.enabled !== false,
    schedule: t.schedule ?? null,
    scheduleText: describe(api, t.schedule),
    skill: t.skill ?? null,
    nextRunAt: t.nextRunAt ?? null,
    lastRunAt: t.lastRunAt ?? null,
    lastStatus: t.lastStatus ?? null,
    promptPreview: preview(t.prompt, 200),
    // 模型覆盖：没配就是 null，模型侧据此知道「这个任务跟随默认模型」。
    model: model === null
      ? null
      : {
        provider: typeof model.provider === 'string' ? model.provider : null,
        model: typeof model.model === 'string' ? model.model : null,
        reasoningEffort: typeof model.reasoningEffort === 'string' ? model.reasoningEffort : null,
      },
  };
}

async function runCreate(api, args) {
  const missing = requireApi(api);
  if (missing !== null) return missing;
  const input = pick(args, CREATE_FIELDS);
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (title.length === 0) return fail('INVALID_TITLE', 'title 不能为空。');
  if (title.length > 120) return fail('INVALID_TITLE', 'title 最长 120 字符。');
  if (prompt.length === 0) return fail('INVALID_PROMPT', 'prompt 不能为空。');
  const scheduleError = validateScheduleShape(input.schedule);
  if (scheduleError !== null) return fail('INVALID_SCHEDULE', `${scheduleError} ${SCHEMA_REFERENCE}`);
  input.title = title;
  input.prompt = prompt;
  // api 可能是同步或异步实现（Lead 的 index.js 走 Config 写回，是 async），
  // 统一 await：await 非 Promise 值原样返回，两种实现都能工作。
  const result = await api.createTask(input);
  if (!isRecord(result) || result.ok !== true) return failFrom(api, isRecord(result) ? result : {});
  return {
    ok: true,
    task: summarizeTask(api, result.task),
    message: `已创建定时任务「${title}」，触发时间：${describe(api, result.task?.schedule) ?? '已设置'}。`,
  };
}

async function runList(api) {
  const missing = requireApi(api);
  if (missing !== null) return missing;
  const tasks = await api.listTasks();
  const list = Array.isArray(tasks) ? tasks : [];
  // 附上宿主自述状态：调度器有没有在转、模型目录建没建起来。
  // 这两件事失败时都表现为"功能没反应"，没有这个字段就只能去翻宿主日志。
  const host = typeof api.diagnostics === 'function' ? safeDiagnostics(api) : undefined;
  return {
    ok: true,
    count: list.length,
    tasks: list.map((task) => summarizeTask(api, task)),
    ...(host === undefined ? {} : { host }),
  };
}

/** 诊断信息是辅助性的：拿不到就不给，绝不因为它让 list 失败。 */
function safeDiagnostics(api) {
  try {
    const value = api.diagnostics();
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function runUpdate(api, args) {
  const missing = requireApi(api);
  if (missing !== null) return missing;
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (id.length === 0) return fail('INVALID_ID', 'id 不能为空。');
  const patch = pick(args, UPDATE_FIELDS);
  if (Object.keys(patch).length === 0) {
    return fail('EMPTY_PATCH', '没有需要修改的字段：请至少提供 title/prompt/schedule/skill/enabled 之一。');
  }
  if (typeof patch.title === 'string') {
    patch.title = patch.title.trim();
    if (patch.title.length === 0) return fail('INVALID_TITLE', 'title 不能为空。');
  }
  if (typeof patch.prompt === 'string') {
    patch.prompt = patch.prompt.trim();
    if (patch.prompt.length === 0) return fail('INVALID_PROMPT', 'prompt 不能为空。');
  }
  if (Object.hasOwn(patch, 'schedule')) {
    const scheduleError = validateScheduleShape(patch.schedule);
    if (scheduleError !== null) return fail('INVALID_SCHEDULE', `${scheduleError} ${SCHEMA_REFERENCE}`);
  }
  const result = await api.updateTask(id, patch);
  if (!isRecord(result) || result.ok !== true) return failFrom(api, isRecord(result) ? result : {});
  return {
    ok: true,
    task: summarizeTask(api, result.task),
    message: `已更新任务 ${id}，触发时间：${describe(api, result.task?.schedule) ?? '已设置'}。`,
  };
}

async function runDelete(api, args) {
  const missing = requireApi(api);
  if (missing !== null) return missing;
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (id.length === 0) return fail('INVALID_ID', 'id 不能为空。');
  const result = await api.deleteTask(id);
  if (!isRecord(result) || result.ok !== true) return failFrom(api, isRecord(result) ? result : {});
  return { ok: true, id: typeof result.id === 'string' ? result.id : id, message: `已删除定时任务 ${id}。` };
}

async function runNow(api, args) {
  const missing = requireApi(api);
  if (missing !== null) return missing;
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (id.length === 0) return fail('INVALID_ID', 'id 不能为空。');
  // api.runTask 的契约是返回**运行记录本身**（LogRecord），失败时返回 null 或
  // {ok:false}；为兼容宿主内部包装成 {ok:true, record} 的实现，这里统一解包一层。
  const returned = await api.runTask(id, 'manual');
  const record = unwrapRunResult(returned);
  if (!isRecord(record)) return fail('RUN_NO_RESULT', `任务 ${id} 立即运行没有返回运行记录。`);
  const status = typeof record.status === 'string' ? record.status : 'unknown';
  return {
    ok: true,
    taskId: typeof record.taskId === 'string' ? record.taskId : id,
    trigger: typeof record.trigger === 'string' ? record.trigger : 'manual',
    status,
    summary: typeof record.summary === 'string' ? record.summary : '',
    ...(typeof record.error === 'string' && record.error.length > 0 ? { error: record.error } : {}),
    ...(typeof record.sessionId === 'string' ? { sessionId: record.sessionId } : {}),
    startedAt: record.startedAt ?? null,
    endedAt: record.endedAt ?? null,
    ...(typeof record.toolCalls === 'number' ? { toolCalls: record.toolCalls } : {}),
    message: status === 'ok' ? `任务 ${id} 已立即运行并成功结束。` : `任务 ${id} 已立即运行，结束状态：${status}。`,
  };
}

/**
 * 从 `api.runTask` 的返回值里取出运行记录。
 * 接受裸记录、`{ ok: true, record }` 包装、以及 `{ ok: false, message }` 失败结果。
 * @param {unknown} value
 * @returns {object|null}
 */
function unwrapRunResult(value) {
  if (!isRecord(value)) return null;
  if (isRecord(value.record)) return value.record;
  if (value.ok === false) return null;
  return value;
}

/* ------------------------------------------------------------------ */
/* 展示（presentCall / presentResult）                                  */
/* ------------------------------------------------------------------ */

function callPresenter(toolName) {
  return (args) => {
    const a = isRecord(args) ? args : {};
    const label = typeof a.title === 'string' && a.title.length > 0
      ? a.title
      : (typeof a.id === 'string' && a.id.length > 0 ? a.id : '');
    return {
      card: 'generic',
      title: label.length > 0 ? `${toolName}: ${label}` : toolName,
      rawInput: a.title ?? a.id ?? undefined,
    };
  };
}

function resultPresenter() {
  return { card: 'generic' };
}

function renderJson(_args, value) {
  return [{ type: 'text', text: jsonText(value) }];
}

/* ------------------------------------------------------------------ */
/* 组装                                                                */
/* ------------------------------------------------------------------ */

/**
 * 构造 5 个工具的规格（纯数据 + 执行函数），便于测试与复用。
 * @param {object} api 宿主能力（见 CONTRACT.md task-2 描述）
 * @returns {Array<{name: string, description: string, parameters: object, execute: Function, presentCall: Function, presentResult: Function}>}
 */
export function createToolSpecs(api) {
  return [
    {
      name: 'scheduled_task_create',
      description: CREATE_DESCRIPTION,
      parameters: createParameters(),
      execute: (args) => guard(() => runCreate(api, isRecord(args) ? args : {})),
      presentCall: callPresenter('scheduled_task_create'),
      presentResult: resultPresenter,
    },
    {
      name: 'scheduled_task_list',
      description: LIST_DESCRIPTION,
      parameters: {},
      execute: () => guard(() => runList(api)),
      presentCall: callPresenter('scheduled_task_list'),
      presentResult: resultPresenter,
    },
    {
      name: 'scheduled_task_update',
      description: UPDATE_DESCRIPTION,
      parameters: updateParameters(),
      execute: (args) => guard(() => runUpdate(api, isRecord(args) ? args : {})),
      presentCall: callPresenter('scheduled_task_update'),
      presentResult: resultPresenter,
    },
    {
      name: 'scheduled_task_delete',
      description: DELETE_DESCRIPTION,
      parameters: idParameters('要删除的任务 id（先用 scheduled_task_list 取得）。'),
      execute: (args) => guard(() => runDelete(api, isRecord(args) ? args : {})),
      presentCall: callPresenter('scheduled_task_delete'),
      presentResult: resultPresenter,
    },
    {
      name: 'scheduled_task_run',
      description: RUN_DESCRIPTION,
      parameters: idParameters('要立即运行的任务 id（先用 scheduled_task_list 取得）。'),
      execute: (args) => guard(() => runNow(api, isRecord(args) ? args : {})),
      presentCall: callPresenter('scheduled_task_run'),
      presentResult: resultPresenter,
    },
  ];
}

const PROMPT_SECTION_TEXT = [
  '「定时任务」插件已装配：scheduled_task_create / scheduled_task_list / scheduled_task_update / '
  + 'scheduled_task_delete / scheduled_task_run 用于把用户的自然语言需求落成定时任务。',
  '当用户表达"在某个时间自动做某件事"（例如"每天早上 9 点帮我总结昨天的 git 提交"）时：'
  + '先用自己的话向用户复述触发时间与任务内容并请求确认，用户确认后再调用 scheduled_task_create；'
  + '不要在没有确认时间与内容的情况下直接创建。',
  'prompt 要写成自包含、可无人值守执行的指令（运行时不与用户对话，无法反问）。',
  '需要修改或删除任务前，先用 scheduled_task_list 取到准确 id。',
].join(' ');

/** 注册提示词段落；systemPrompt 缺失或注册失败都只是跳过。 */
function registerPromptSection(ctx, systemPrompt) {
  if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') {
    warn('ctx.systemPrompt 不可用，跳过工具使用提示词段落。');
    return undefined;
  }
  try {
    return systemPrompt.section({
      name: SECTION_NAME,
      order: resolveSectionOrder(systemPrompt),
      text: PROMPT_SECTION_TEXT,
    });
  } catch (error) {
    warn(`注册提示词段落失败：${errorMessage(error)}`);
    return undefined;
  }
}

/** 把清理函数接到 ctx.effect；没有 effect 就只记录警告。 */
function attachCleanup(ctx, cleanup, label) {
  if (typeof cleanup !== 'function') return;
  if (typeof ctx.effect !== 'function') {
    warn(`ctx.effect 不可用，无法登记清理函数：${label}`);
    return;
  }
  try {
    ctx.effect(() => cleanup, label);
  } catch (error) {
    warn(`ctx.effect 登记失败（${label}）：${errorMessage(error)}`);
  }
}

/**
 * 注册 5 个 scheduled_task_* 工具。
 * @param {object} ctx 宿主上下文（需要 ctx.tools.register，可选 ctx.effect / ctx.systemPrompt）
 * @param {object} api 宿主能力：listTasks/createTask/updateTask/deleteTask/runTask/describeSchedule
 * @param {{defineTool?: Function}} [helpers] 宿主实现注入；缺省时用内置等价实现
 * @returns {() => void} 注销全部注册的清理函数（幂等）
 */
export function registerTools(ctx, api, helpers) {
  const disposers = [];
  const tools = serviceOn(ctx, 'tools');
  if (tools === undefined || typeof tools.register !== 'function') {
    warn('ctx.tools 不可用，未注册任何 scheduled_task_* 工具。');
    return () => {};
  }
  const defineTool = resolveDefineTool(helpers);
  for (const spec of createToolSpecs(api)) {
    let definition;
    try {
      definition = defineTool({
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        output: { schema: cloneJson(OUTPUT_SCHEMA), render: renderJson },
        execute: spec.execute,
        presentCall: spec.presentCall,
        presentResult: spec.presentResult,
      });
    } catch (error) {
      warn(`定义工具 ${spec.name} 失败：${errorMessage(error)}`);
      continue;
    }
    let registered;
    try {
      registered = tools.register(definition);
    } catch (error) {
      warn(`注册工具 ${spec.name} 失败：${errorMessage(error)}`);
      continue;
    }
    if (typeof registered === 'function') disposers.push(registered);
    attachCleanup(ctx, registered, `scheduled-tasks:tool:${spec.name}`);
  }
  attachCleanup(ctx, registerPromptSection(ctx, serviceOn(ctx, 'systemPrompt')), 'scheduled-tasks:prompt-section');

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const dispose of disposers) {
      try {
        dispose();
      } catch (error) {
        warn(`注销工具失败：${errorMessage(error)}`);
      }
    }
  };
}
