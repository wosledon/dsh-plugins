/**
 * client.js 渲染自检——真正执行组件并驱动重渲染。
 *
 * 为什么需要它（都是真实踩过的坑）：
 *   1. 「进去之后空白」= 组件在渲染期抛异常。纯静态检查与「apply 不抛」都抓不到，
 *      因为异常发生在**渲染**阶段，而且 slot entry 崩溃不会让 apply 失败。
 *   2. 早先的 stub 把 ctx.locale.bind 写成恒等函数，于是界面文案渲染出来是
 *      
ewTask/	itle 这种 key 名——**文案根本没有被验证**。本脚本真的注册并绑定
 *      中文文案表，断言看到的是「新建任务」而不是 
ewTask。
 *   3. 只渲染「初始 loading 态」也会漏掉问题：数据到位后的那条渲染路径
 *      （任务行、tab、日志、表单）才是真正的风险面。这里驱动
 *      「初始 → effect(load) → 重渲染」并逐个交互。
 *
 * 它自己实现了一个极小的 React 运行时（useState 具备真实状态与重渲染、
 * useEffect 可手动触发），所以不需要第三方依赖，也不需要浏览器或 jsdom。
 *
 * 用法：node scripts/verify-render.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 相对**脚本自身**解析，这样从任何工作目录调用都能找到 client.js。
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = fs.readFileSync(path.join(root, 'client.js'), 'utf8');

/* ---------------- 迷你 React ---------------- */
function createRuntime() {
  let currentInstance = null;
  const instanceStack = [];

  const React = {
    createElement(type, props, ...children) {
      return { type, props: props === null || props === undefined ? {} : props, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true) };
    },
    useState(initial) {
      const inst = currentInstance;
      const index = inst.hookIndex;
      inst.hookIndex += 1;
      if (inst.hooks.length <= index) {
        inst.hooks[index] = typeof initial === 'function' ? initial() : initial;
      }
      const setter = (next) => {
        const value = typeof next === 'function' ? next(inst.hooks[index]) : next;
        if (Object.is(value, inst.hooks[index])) return;
        inst.hooks[index] = value;
        scheduleRender();
      };
      return [inst.hooks[index], setter];
    },
    useEffect(fn) {
      const inst = currentInstance;
      const index = inst.hookIndex;
      inst.hookIndex += 1;
      inst.effects.push(fn);
    },
    useCallback(fn) { currentInstance.hookIndex += 1; return fn; },
    useMemo(fn) { currentInstance.hookIndex += 1; return fn(); },
    useRef(v) { currentInstance.hookIndex += 1; return { current: v }; },
  };

  let scheduled = false;
  let renderTarget = null;
  function scheduleRender() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; if (renderTarget !== null) renderTarget(); });
  }

  /** 渲染一个函数组件，返回可读的 DOM 树。 */
  function render(Component, props) {
    const inst = { hooks: [], hookIndex: 0, effects: [] };
    instanceStack.push(inst);
    currentInstance = inst;
    let out;
    try {
      out = Component(props);
    } finally {
      instanceStack.pop();
      currentInstance = instanceStack.length > 0 ? instanceStack[instanceStack.length - 1] : null;
    }
    return { tree: out, inst };
  }

  /** 用调用方持有的实例渲染（重渲染时复用 hooks）。 */
  function renderWith(Component, props, inst) {
    instanceStack.push(inst);
    currentInstance = inst;
    let out;
    try {
      out = Component(props);
    } finally {
      instanceStack.pop();
      currentInstance = instanceStack.length > 0 ? instanceStack[instanceStack.length - 1] : null;
    }
    return out;
  }

  return { React, render, renderWith, setRenderTarget: (fn) => { renderTarget = fn; } };
}

/* ---------------- 环境 ---------------- */
const runtime = createRuntime();
const React = runtime.React;

let entry;
const registered = [];
const effects = [];
const warnings = [];
const errors = [];

const windowStub = { __ModuleLoader__: { load(e) { entry = e; } }, confirm: () => true };
const documentStub = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  head: { appendChild: () => {} },
};
const requireStub = (spec) => {
  if (spec === 'react') return React;
  throw new Error('unexpected require: ' + spec);
};

new Function('window', 'document', 'console', 'require', src)(
  windowStub,
  documentStub,
  { ...console, warn: (...a) => { warnings.push(a.join(' ')); }, error: (...a) => { errors.push(a.join(' ')); } },
  requireStub,
);

const plugin = entry.factory(requireStub);

const NOW = 1790400000000;
// 真实语义：tasks 在用户层；internal（日志/运行表/手动队列）由宿主写入，
// 出现在**解析后的 value** 里。客户端按契约从 entry.value 读 internal。
const USER_TASKS = [
  { id: 't1', title: '每日总结', prompt: '总结昨天的提交', enabled: true, schedule: { kind: 'daily', time: '09:00' }, createdAt: 1, updatedAt: 1, nextRunAt: NOW + 3600000, lastRunAt: NOW - 60000, lastStatus: 'ok' },
  { id: 't2', title: '停用的任务', prompt: 'x', enabled: false, schedule: { kind: 'cron', expression: '0 4 * * *' }, createdAt: 1, updatedAt: 1, lastStatus: 'error' },
];
const INTERNAL = {
  log: [
    { seq: 3, taskId: 't1', title: '每日总结', startedAt: NOW - 1000, endedAt: NOW, status: 'ok', trigger: 'manual', summary: '完成', toolCalls: 3, sessionId: 'sched-3' },
    { seq: 2, taskId: 't2', title: '停用的任务', startedAt: NOW - 60000, endedAt: NOW - 50000, status: 'error', trigger: 'schedule', summary: '', error: 'boom', sessionId: 'sched-2' },
    { seq: 1, taskId: 't1', title: '每日总结', startedAt: NOW - 120000, endedAt: NOW - 110000, status: 'timeout', trigger: 'schedule', summary: '', error: 'too slow', sessionId: 'sched-1' },
  ],
  runs: { t1: { seq: 0, startedAt: NOW, trigger: 'manual' } },
  manualRuns: [],
};

const descriptor = {
  ns: 'scheduled-tasks',
  revision: 3,
  applies: 'live',
  writable: true,
  // 用户层：只有用户/界面写的任务；internal 不在这一层
  user: { tasks: USER_TASKS },
  // 解析后的有效配置：任务（默认值已合入）+ 宿主写入的 internal
  value: {
    enabled: true,
    tickMs: 30000,
    maxConcurrentRuns: 2,
    runTimeoutMs: 1800000,
    logLimit: 200,
    tasks: USER_TASKS,
    internal: INTERNAL,
  },
};

const registeredLocale = new Map();
const ctx = {
  get: () => undefined,
  effect: (fn) => { const d = fn(); effects.push(d); return () => {}; },
  on: () => () => {},
  logger: { warn: (...a) => warnings.push(a.join(' ')) },
  remote: {
    settings: {
      describe: async () => ({ ok: true, value: { writable: true, namespaces: [descriptor] } }),
      mutate: async () => ({ ok: true, value: {} }),
    },
  },
  locale: {
    // 记录注册的文案表，让 bind 真的返回中文——否则渲染出来全是 key 名，
    // 测试看到的文案与真实界面不一致，断言就是自欺欺人。
    register: (ns, dicts) => { registeredLocale.set(ns, dicts); return () => {}; },
    bind: (ns) => {
      const dicts = registeredLocale.get(ns) ?? {};
      const zh = dicts.zh ?? {};
      return (key) => (zh[key] === undefined ? key : zh[key]);
    },
  },
  slots: {
    register: (opts, comp) => { registered.push({ opts, comp }); return () => {}; },
    /*
     * 回调是 generator（与已发布的 dsh-client-ui-sidebar-right 一致）：必须迭代，
     * `yield` 里的注册才会执行。只调 cb() 拿到的是未启动的 generator。
     */
    inject: (key, cb) => {
      const effect = cb();
      if (effect !== null && typeof effect === 'object' && typeof effect.next === 'function') {
        for (let step = effect.next(); step.done !== true; step = effect.next()) {
          // 每次 next() 执行一个 yield。
        }
      }
      return () => {};
    },
  },
};

plugin.apply(ctx);

const main = registered.find((r) => r.opts.name === 'main');
if (main === undefined) { console.log('FAIL: main slot 未注册'); process.exit(1); }
// main.comp 会被重新解析（每次 plugin.apply 都会产出新的组件函数），
// 所以这里不缓存，而是每次从当前 registered 里找。
const resolveMain = () => registered.find((r) => r.opts.name === 'main') ?? main;

/** 把虚拟树压成可搜索的字符串，便于断言结构。 */
function flatten(node, depth = 0, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (Array.isArray(node)) { for (const child of node) flatten(child, depth, out); return out; }
  if (typeof node === 'string' || typeof node === 'number') { out.push({ text: String(node), depth }); return out; }
  const cls = node.props === undefined ? undefined : node.props.className;
  const clsText = Array.isArray(cls) ? cls.join(' ') : (typeof cls === 'string' ? cls : '');
  out.push({ tag: node.type, cls: clsText, depth, props: node.props });
  for (const child of node.children ?? []) flatten(child, depth + 1, out);
  return out;
}

function renderMain() {
  const { tree, inst } = runtime.render(main.comp, {});
  return { nodes: flatten(tree), inst, tree };
}

/**
 * 持久化组件实例：每次重渲染复用同一份 hooks，这样 setState 才会真的驱动更新。
 * 同时把「最新一次渲染结果」记录下来供断言使用。
 */
let liveInstance = { hooks: [], hookIndex: 0, effects: [] };
let lastView = null;

function renderInto() {
  liveInstance.hookIndex = 0;
  liveInstance.effects = liveInstance.effects ?? [];
  const inst = liveInstance;
  let tree;
  const prevCurrent = null;
  // runtime.render 会新建实例；这里改为直接复用 liveInstance
  tree = runtime.renderWith(resolveMain().comp, {}, inst);
  lastView = { nodes: flatten(tree), inst, tree };
  return lastView;
}

const view = () => lastView;

/** 挂载：渲染 → 跑 effects（load）→ 等异步完成 → 再渲染。 */
async function mount() {
  renderInto();
  const pending = liveInstance.effects.splice(0);
  for (const fn of pending) fn();
  await new Promise((r) => setTimeout(r, 40));
  renderInto();
  // load() 里可能还有第二层 setState；再稳定一轮
  const more = liveInstance.effects.splice(0);
  for (const fn of more) fn();
  await new Promise((r) => setTimeout(r, 40));
  renderInto();
  return view();
}

/** 触发一个按钮点击：调 onClick → 等状态与异步落地 → 重渲染。 */
async function click(node) {
  node.props.onClick();
  await new Promise((r) => setTimeout(r, 25));
  renderInto();
  return view();
}

/** 在扁平化结果里，找「后代文本包含 target」的第一个指定类名元素。 */
function findByText(nodes, cls, target) {
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    if (node.cls !== cls) continue;
    const depth = node.depth;
    for (let j = i + 1; j < nodes.length; j += 1) {
      if (nodes[j].depth <= depth) break;
      if (nodes[j].text !== undefined && nodes[j].text.includes(target)) return node;
    }
  }
  return undefined;
}

/** 判断一个元素的**后代文本**里是否含 target（比 findByText 的兄弟扫描可靠）。 */
function hasTextInside(nodes, node, target) {
  const depth = node.depth;
  const at = Math.max(0, nodes.indexOf(node));
  for (let j = at + 1; j < nodes.length; j += 1) {
    if (nodes[j].depth <= depth) break;
    if (nodes[j].text !== undefined && nodes[j].text.includes(target)) return true;
  }
  return false;
}

const problems = [];
const ok = (label, cond, detail) => {
  if (cond) console.log('  ok   ' + label);
  else { problems.push(label + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + label + (detail ? ' — ' + detail : '')); }
};

console.log('=== 1. 初始渲染（loading 路径） ===');
try {
  const first = renderInto();
  ok('初始渲染不抛异常', true);
  ok('初始渲染不是空树', first.nodes.length > 0, `nodes=${first.nodes.length}`);
  ok('初始渲染在加载路径（未渲染任务内容）', !first.nodes.some((n) => n.cls === 'stp-tab'), '不该已有 tab');
} catch (e) { ok('初始渲染不抛异常', false, e.stack); }

console.log('');
console.log('=== 2. effect(load) 之后重渲染（有数据路径） ===');
try {
  const dataView = await mount();
  ok('数据到位后渲染不抛异常', true);
  const text = dataView.nodes.filter((n) => n.text !== undefined).map((n) => n.text).join(' ');
  ok('不再停留在加载中', !text.includes('加载中'), text.slice(0, 120));
  ok('渲染出任务标题', text.includes('每日总结'), text.slice(0, 200));
  ok('渲染出停用任务', text.includes('停用的任务'));
  ok('渲染出 tab', dataView.nodes.some((n) => n.cls === 'stp-tab'), '未找到 stp-tab');
  ok('tab 有两个', dataView.nodes.filter((n) => n.cls === 'stp-tab').length === 2, String(dataView.nodes.filter((n) => n.cls === 'stp-tab').length));
  ok('渲染出任务行', dataView.nodes.some((n) => n.cls === 'stp-item'));
  ok('任务行有运行记录入口', dataView.nodes.some((n) => n.cls === 'stp-linkBtn'));
  ok('未展开时不渲染历史区', !dataView.nodes.some((n) => n.cls === 'stp-history'));
  ok('任务只有 2 条，不渲染分页条', !dataView.nodes.some((n) => n.cls === 'stp-pager'), '不该出现分页条');
  ok('没有 stp-empty 空状态（有数据）', !dataView.nodes.some((n) => n.cls === 'stp-empty'));
  ok('加载过程没有 console.error', errors.length === 0, errors.join(' | '));
} catch (e) { ok('数据到位后渲染不抛异常', false, e.stack); }

console.log('');
console.log('=== 3. 切到日志 tab ===');
try {
  const tabButtons = view().nodes.filter((n) => n.cls === 'stp-tab');
  const logView = await click(tabButtons[1]);
  ok('切 tab 后渲染不抛异常', true);
  ok('日志 tab 被选中', logView.nodes.filter((n) => n.cls === 'stp-tab')[1].props['aria-selected'] === true);
  ok('渲染出日志行', logView.nodes.some((n) => n.cls === 'stp-logRow'), '未找到日志行');
  ok('日志行是 3 行', logView.nodes.filter((n) => n.cls === 'stp-logRow').length === 3, String(logView.nodes.filter((n) => n.cls === 'stp-logRow').length));
  ok('日志 tab 不再显示任务行', !logView.nodes.some((n) => n.cls === 'stp-linkBtn'));
} catch (e) { ok('切 tab 后渲染不抛异常', false, e.stack); }

console.log('');
console.log('=== 4. 展开某任务的运行记录 ===');
try {
  const tasksView = await click(view().nodes.filter((n) => n.cls === 'stp-tab')[0]);
  const toggle = tasksView.nodes.find((n) => n.cls === 'stp-linkBtn');
  ok('找到运行记录入口', toggle !== undefined);
  const expanded = await click(toggle);
  ok('展开后渲染不抛异常', true);
  ok('出现历史区', expanded.nodes.some((n) => n.cls === 'stp-history'));
  const rows = expanded.nodes.filter((n) => n.cls === 'stp-logRow');
  ok('历史区只列该任务自己的记录（t1 有 2 条）', rows.length === 2, String(rows.length));
} catch (e) { ok('展开后渲染不抛异常', false, e.stack); }

console.log('');
console.log('=== 5. 打开新建表单（含原生 select 与星期按钮） ===');
try {
  const tasksView = view();
  const newBtn = findByText(tasksView.nodes, 'stp-btn', '新建任务');
  ok('头部有「新建任务」按钮', newBtn !== undefined);
  const formView = await click(newBtn);
  ok('打开表单不抛异常', true);
  ok('出现表单容器', formView.nodes.some((n) => n.cls === 'stp-form'), '未找到 stp-form');
  ok('时间类型是原生 select', formView.nodes.some((n) => n.tag === 'select' && n.cls === 'stp-select'));
  ok('select 有 5 个 schedule 选项 + 1 个「跟随默认模型」', formView.nodes.filter((n) => n.tag === 'option').length === 6, String(formView.nodes.filter((n) => n.tag === 'option').length));
  ok('模型下拉第一项是「跟随默认模型」', formView.nodes.some(
    (n) => n.tag === 'option' && n.props.value === 'default' && hasTextInside(formView.nodes, n, '跟随默认模型'),
  ));
  ok('表单有标题输入框', formView.nodes.some((n) => n.tag === 'input' && n.cls === 'stp-input'));
  ok('表单有提示词文本域', formView.nodes.some((n) => n.tag === 'textarea'));
  ok('表单有取消/创建按钮', formView.nodes.filter((n) => n.cls === 'stp-btn').length >= 2);
} catch (e) { ok('打开表单不抛异常', false, e.stack); }

console.log('');
console.log('=== 6. 周模式：星期按钮 ===');
try {
  const formView = view();
  // 第二个 select 才是「触发时间」：第一个是大模型供应商下拉。
  const select = formView.nodes.filter((n) => n.tag === 'select')[1];
  select.props.onChange({ target: { value: 'weekly' } });
  await new Promise((r) => setTimeout(r, 25));
  const weekly = renderInto();
  ok('切到周模式不抛异常', true);
  ok('出现 7 个星期按钮', weekly.nodes.filter((n) => n.cls === 'stp-day').length === 7, String(weekly.nodes.filter((n) => n.cls === 'stp-day').length));
  ok('出现时间输入', weekly.nodes.some((n) => n.tag === 'input' && n.props.type === 'time'));
} catch (e) { ok('切到周模式不抛异常', false, e.stack); }

console.log('');
console.log('=== 7. 加载失败时的降级（不应白屏） ===');
try {
  const failing = {
    ...ctx,
    remote: { settings: { describe: async () => { throw new Error('network down'); }, mutate: async () => ({ ok: true }) } },
  };
  // 用新的 ctx 装配第二个实例（WeakMap 幂等守卫按 ctx 身份区分）
  registered.length = 0;
  plugin.apply(failing);
  const mainSlot = registered.find((r) => r.opts.name === 'main');
  ok('失败实例也注册了 main slot', mainSlot !== undefined);
  liveInstance = { hooks: [], hookIndex: 0, effects: [] };
  lastView = null;
  renderInto();
  const pending = liveInstance.effects.splice(0);
  for (const fn of pending) fn();
  await new Promise((r) => setTimeout(r, 40));
  renderInto();
  const errorView = view();
  ok('describe 抛错时不抛到渲染层', true);
  ok('降级渲染非空树（不是白屏）', errorView.nodes.length > 0, `nodes=${errorView.nodes.length}`);
  const errorText = errorView.nodes.filter((n) => n.text !== undefined).map((n) => n.text).join(' ');
  ok('显示了错误/标题文案而不是空白', errorText.includes('读取设置失败') || errorText.includes('定时任务'), errorText.slice(0, 200));
} catch (e) { ok('describe 抛错时不抛到渲染层', false, e.stack); }

console.log('');
console.log('§ Hook 顺序（early return 之后不得再调用 hook）');
// 真实故障：把 useEffect 写在 `if (state.status === 'inert') return ...` 之后，
// 首帧少调一个 hook、数据到位后多调一个 → React error #310
// （Rendered more hooks than during the previous render）→ slot entry 崩溃 → 主界面空白。
// 静态检查与「apply 不抛」都发现不了，所以在这里显式守住。
{
  const start = src.indexOf('function TasksPage');
  const end = src.indexOf('return { PanelIcon, TasksPage }');
  const body = start === -1 || end === -1 ? '' : src.slice(start, end);
  ok('能定位 TasksPage 实现', body.length > 0);

  // 组件顶部到第一个 early return 之间的部分
  const earlyReturnMatch = /(^|\n)\s*if \(state\.status === '(inert|loading|unavailable)'\)/.exec(body);
  ok('能定位 early return', earlyReturnMatch !== null);
  if (earlyReturnMatch !== null) {
    const beforeReturn = body.slice(0, earlyReturnMatch.index);
    const afterReturn = body.slice(earlyReturnMatch.index);
    const hookBefore = (beforeReturn.match(/React\.use[A-Za-z]+\(/g) ?? []).length;
    // early return 之后的「渲染主干」里不允许再出现 hook 调用
    const hooksAfterReturn = (afterReturn.match(/React\.use[A-Za-z]+\(/g) ?? []).length;
    ok(
      'early return 之前已调用所有 hook，之后不再调用',
      hooksAfterReturn === 0,
      `early return 之前 ${hookBefore} 个，之后仍有 ${hooksAfterReturn} 个`,
    );
    ok(
      '组件确实在顶部声明了 hook（useState/useEffect）',
      hooksAfterReturn === 0 && hookBefore >= 8,
      `before=${hookBefore}`,
    );
  }
}

console.log('');
console.log('=== 8. 模型选择器（含推理强度级联） ===');
try {
  const withCatalog = {
    ...descriptor,
    user: { tasks: USER_TASKS },
    value: {
      enabled: true,
      tickMs: 30000,
      maxConcurrentRuns: 2,
      runTimeoutMs: 1800000,
      logLimit: 200,
      tasks: USER_TASKS,
      internal: {
        ...INTERNAL,
        catalog: {
          providers: [
            {
              id: 'deepseek-official',
              displayName: 'DeepSeek 官方',
              models: [
                { id: 'deepseek-chat', name: 'deepseek-chat', efforts: [] },
                {
                  id: 'deepseek-reasoner',
                  name: 'deepseek-reasoner',
                  efforts: [
                    { id: 'low', name: 'low' },
                    { id: 'high', name: 'high' },
                    { id: 'xhigh', name: 'xhigh' },
                  ],
                  defaultEffort: 'high',
                },
              ],
            },
            { id: 'stepfun', displayName: '阶跃星辰', models: [{ id: 'step-3.7-flash', name: 'step-3.7-flash', efforts: [] }] },
          ],
          builtAt: Date.now(),
        },
      },
    },
  };
  registered.length = 0;
  const ctxWithCatalog = {
    ...ctx,
    remote: {
      settings: {
        describe: async () => ({ ok: true, value: { writable: true, namespaces: [withCatalog] } }),
        mutate: async () => ({ ok: true }),
      },
    },
  };
  plugin.apply(ctxWithCatalog);
  liveInstance = { hooks: [], hookIndex: 0, effects: [] };
  lastView = null;
  await mount();

  // 打开表单，选一个支持推理的模型，验证级联
  const newBtn = findByText(view().nodes, 'stp-btn', '新建任务');
  const formView = await click(newBtn);
  // 用「选项里含跟随默认模型」精确定位供应商下拉，避免和 schedule 下拉混淆。
  const providerSelect = (() => {
    for (const node of formView.nodes) {
      if (node.tag !== 'select') continue;
      const options = [];
      const depth = node.depth;
      for (let j = formView.nodes.indexOf(node) + 1; j < formView.nodes.length; j += 1) {
        if (formView.nodes[j].depth <= depth) break;
        if (formView.nodes[j].tag === 'option') options.push(formView.nodes[j]);
      }
      if (options.some((option) => option.props.value === 'default')) return node;
    }
    return undefined;
  })();
  ok('表单有供应商下拉', providerSelect !== undefined);
  if (providerSelect === undefined) throw new Error('no provider select');
  providerSelect.props.onChange({ target: { value: 'deepseek-official' } });
  await new Promise((r) => setTimeout(r, 25));
  const picked = renderInto();
  const optionValues = picked.nodes.filter((n) => n.tag === 'option').map((n) => n.props.value);
  ok('选供应商后出现模型选项', optionValues.includes('deepseek-chat'), optionValues.join('|'));
  // 模型下拉的 value 此时还是空串（等用户挑具体模型），所以按「含哪些选项」定位。
  const modelSelect = (() => {
    for (const node of picked.nodes) {
      if (node.tag !== 'select') continue;
      const depth = node.depth;
      const at = picked.nodes.indexOf(node);
      const options = [];
      for (let j = at + 1; j < picked.nodes.length; j += 1) {
        if (picked.nodes[j].depth <= depth) break;
        if (picked.nodes[j].tag === 'option') options.push(picked.nodes[j].props.value);
      }
      if (options.includes('deepseek-chat')) return node;
    }
    return undefined;
  })();
  if (modelSelect === undefined) throw new Error('no model select: ' + optionValues.join('|'));
  modelSelect.props.onChange({ target: { value: 'deepseek-reasoner' } });
  await new Promise((r) => setTimeout(r, 25));
  renderInto();
  const withEffort = view();
  const texts = withEffort.nodes.filter((n) => n.text !== undefined).map((n) => n.text);
  const optionsNow = withEffort.nodes.filter((n) => n.tag === 'option').map((n) => n.props.value);
  ok('该模型支持推理 → 出现「推理强度」标签', texts.includes('推理强度'), texts.slice(0, 40).join('|'));
  ok('推理强度首项是「模型默认」', optionsNow.includes(''), optionsNow.join('|'));
  ok('列出该模型的 3 个强度', optionsNow.includes('low') && optionsNow.includes('high') && optionsNow.includes('xhigh'), optionsNow.join('|'));

  // 换到不支持推理的模型时，强度下拉必须重新收起（否则会残留一组非法组合）
  modelSelect.props.onChange({ target: { value: 'deepseek-chat' } });
  await new Promise((r) => setTimeout(r, 25));
  renderInto();
  ok(
    '切到不支持推理的模型后强度下拉收起',
    findByText(view().nodes, 'span', '推理强度') === undefined,
  );
} catch (e) { ok('模型选择器不抛异常', false, e.stack); }

console.log('');
console.log('=== 9. 编辑模式 ===');
try {
  registered.length = 0;
  plugin.apply(ctx);
  liveInstance = { hooks: [], hookIndex: 0, effects: [] };
  lastView = null;
  const tasksView = await mount();
  const editBtn = findByText(tasksView.nodes, 'stp-btn', '编辑');
  ok('任务行有「编辑」按钮', editBtn !== undefined);
  const edited = await click(editBtn);
  ok('打开编辑不抛异常', true);
  ok('出现表单容器', edited.nodes.some((n) => n.cls === 'stp-form'));
  ok('表单标题是「编辑任务」', edited.nodes.some((n) => n.text !== undefined && n.text.includes('编辑任务')));
  const titleInput = edited.nodes.find((n) => n.tag === 'input' && n.cls === 'stp-input' && n.props.value === '每日总结');
  ok('标题被回填', titleInput !== undefined);
  ok('主按钮是「保存」而不是「创建」', findByText(edited.nodes, 'stp-btn', '保存') !== undefined);

  const cancelBtn = findByText(edited.nodes, 'stp-btn', '取消');
  cancelBtn.props.onClick();
  await new Promise((r) => setTimeout(r, 20));
  renderInto();
  ok('取消编辑后回到列表', !view().nodes.some((n) => n.cls === 'stp-form'));
} catch (e) { ok('编辑模式不抛异常', false, e.stack); }

console.log('');
if (problems.length > 0) {
  console.log('失败 ' + problems.length + ' 项：');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
console.log('全部通过：client.js 在真实数据下可正常渲染。');
