#!/usr/bin/env node
/**
 * verify-contract.mjs — 装配形状自检（CONTRACT.md §6，零第三方依赖）。
 *
 * 覆盖 §6 的五条：
 *   1. manifest 合法（dsh.bundle.patch / dsh.client.platform==='web' / exports['./client']）；
 *   2. client.js 以包名为 id 注册工厂，apply 只注册 sidebar.panellist 与 main 两个 slot；
 *   3. 宿主 index.js 导出 apply / inject，apply() 幂等、返回清理函数、重复 apply 不重复注册定时器；
 *   4. client.js 与 lib/tools.js、lib/skill.js 不含 @deepseek-ai/* 运行时 import；
 *   5. nextScheduleTime 对 5 种 schedule 的边界（跨日、跨周、cron 步长）。
 *
 * 刻意不做的事：不模拟 React 渲染、不做 DOM/视觉断言。视觉效果只能在真实页面确认。
 * 另外：宿主模块会 import 安装期才有的依赖（例如 @deepseek-ai/schemastery），
 * 这里用 Node 的 resolve hook 把「解析不到的裸包」替换成惰性 stub，
 * 只为了让 index.js / lib/*.js 能在仓库里被真正 import 并调用 apply()。
 *
 * 用法：node scripts/verify-contract.mjs
 * 退出码：0 = 全部通过；1 = 有断言失败；2 = 有文件缺失或无法加载。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const realSetTimeout = globalThis.setTimeout.bind(globalThis);

/* ------------------------------------------------------------------ */
/* 最小 harness                                                        */
/* ------------------------------------------------------------------ */

let passed = 0;
const failures = [];
const missing = [];
let sectionName = '(root)';

function section(name) {
  sectionName = name;
  console.log('\n[' + name + ']');
}

function ok(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log('  ok   ' + label);
    return true;
  }
  const line = label + (detail === undefined ? '' : ' — ' + detail);
  failures.push(sectionName + ' :: ' + line);
  console.log('  FAIL ' + line);
  return false;
}

function fmt(value) {
  if (value instanceof Date) return 'Date(' + value.toISOString() + ')';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'function') return '[function ' + (value.name || 'anonymous') + ']';
  if (value === undefined) return 'undefined';
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

function readText(file) {
  if (!fs.existsSync(file)) {
    missing.push(file);
    return undefined;
  }
  return fs.readFileSync(file, 'utf8');
}

const has = (file) => fs.existsSync(file);

/* ------------------------------------------------------------------ */
/* 外部依赖 stub：让仓库里的宿主模块也能被 import                        */
/* ------------------------------------------------------------------ */

const STUB_SOURCE = [
  'const chain = new Proxy(function stub() {}, {',
  '  get(target, prop) {',
  "    if (prop === 'then') return undefined;",
  "    if (prop === 'toJSON') return () => '[stub]';",
  "    if (prop === 'inspect') return () => '[stub]';",
  '    if (prop === Symbol.toPrimitive) return () => "[stub]";',
  "    if (prop === Symbol.toStringTag) return 'Stub';",
  "    if (prop === Symbol.for('nodejs.util.inspect.custom')) return () => '[stub]';",
  "    if (prop === '__esModule') return true;",
  '    return chain;',
  '  },',
  '  apply() { return chain; },',
  '  construct() { return chain; },',
  '  has() { return true; },',
  '});',
  'export default chain;',
  'export const Schema = chain, z = chain, Service = chain, Context = chain, Logger = chain,',
  '  Timer = chain, Registry = chain, Plugin = chain, defineTool = chain, Tool = chain,',
  '  defineSkill = chain, Skill = chain, Settings = chain, Remote = chain, Slots = chain,',
  '  Tools = chain, Skills = chain, SystemPrompt = chain, AgentLoop = chain, Agent = chain,',
  '  Workspace = chain, Loader = chain, EventEmitter = chain, is = chain, use = chain,',
  '  compose = chain, hyphenate = chain, dispose = chain, fork = chain, Inject = chain,',
  '  Provide = chain, Effect = chain, EffectScope = chain;',
].join('\n');

const stubUrl = 'data:text/javascript;base64,' + Buffer.from(STUB_SOURCE, 'utf8').toString('base64');
const stubbedSpecifiers = new Set();

const isStubbable = (specifier) => !(
  specifier.startsWith('.') ||
  specifier.startsWith('/') ||
  specifier.startsWith('#') ||
  specifier.startsWith('node:') ||
  specifier.startsWith('file:') ||
  specifier.startsWith('data:') ||
  specifier.startsWith('http:') ||
  specifier.startsWith('https:')
);

let hooksInstalled = false;
try {
  const nodeModule = await import('node:module');
  if (typeof nodeModule.registerHooks === 'function') {
    nodeModule.registerHooks({
      resolve(specifier, context, nextResolve) {
        try {
          return nextResolve(specifier, context);
        } catch (error) {
          if (isStubbable(specifier)) {
            stubbedSpecifiers.add(specifier);
            return { url: stubUrl, shortCircuit: true, format: 'module' };
          }
          throw error;
        }
      },
    });
    hooksInstalled = true;
  }
} catch {
  hooksInstalled = false;
}

async function importFile(file) {
  try {
    return { module: await import(pathToFileURL(file).href) };
  } catch (error) {
    return { error };
  }
}

console.log('verify-contract.mjs — CONTRACT.md §6 装配形状自检');
console.log('插件根目录：' + root);
console.log('运行时：node ' + process.version);

section('harness 自检');
ok('resolver hook 可用（module.registerHooks）', hooksInstalled, 'Node 过旧；宿主模块的外部依赖桩不可用');
if (hooksInstalled) {
  let probeOk = false;
  try {
    await import('@deepseek-ai/schemastery');
    probeOk = true;
  } catch {
    probeOk = false;
  }
  ok('解析不到的裸包会被替换为惰性 stub', probeOk, '探针 import 失败，宿主模块可能无法 import');
}

/* ------------------------------------------------------------------ */
/* 1. manifest                                                         */
/* ------------------------------------------------------------------ */

section('1. manifest（package.json）');
const pkgFile = path.join(root, 'package.json');
const pkgText = readText(pkgFile);
let pkg;
if (pkgText === undefined) {
  ok('package.json 存在', false, pkgFile);
} else {
  try {
    pkg = JSON.parse(pkgText);
  } catch (error) {
    ok('package.json 是合法 JSON', false, error.message);
  }
}

if (pkg !== undefined) {
  ok('name = dsh-plugin-scheduled-tasks', pkg.name === 'dsh-plugin-scheduled-tasks', fmt(pkg.name));
  ok('type = module（ESM）', pkg.type === 'module', fmt(pkg.type));
  ok('dsh.bundle.patch 指向 ./cordis.patch.yml', pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch === './cordis.patch.yml', fmt(pkg.dsh && pkg.dsh.bundle));
  ok('dsh.client.platform = web', pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform === 'web', fmt(pkg.dsh && pkg.dsh.client));
  ok('exports["./client"] = ./client.js', pkg.exports && pkg.exports['./client'] === './client.js', fmt(pkg.exports && pkg.exports['./client']));
  ok('exports["."] = ./index.js', pkg.exports && pkg.exports['.'] === './index.js', fmt(pkg.exports && pkg.exports['.']));

  /* ---------------- 补丁层 ---------------- */
  section('1b. cordis.patch.yml');
  const patchFile = path.join(root, 'cordis.patch.yml');
  const patchText = readText(patchFile);
  if (patchText === undefined) {
    ok('cordis.patch.yml 存在', false, patchFile);
  } else {
    const insertCount = (patchText.match(/^\s*-\s*insert:\s*$/gm) || []).length;
    ok('恰好一个 insert 段', insertCount === 1, '实际 ' + insertCount);

    const entries = [];
    let row = null;
    for (const rawLine of patchText.split(/\r?\n/)) {
      const line = rawLine.replace(/#.*$/, '');
      const match = /^\s*(?:-\s*)?([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
      if (match === null) continue;
      const key = match[1];
      const value = match[2].trim().replace(/^['"]|['"]$/g, '');
      if (key === 'id') {
        row = { id: value };
        entries.push(row);
      } else if (row !== null && value !== '') {
        row[key] = value;
      }
    }
    ok('插入行数量为 1', entries.length === 1, '实际 ' + entries.length + '：' + fmt(entries));
    const insertedRow = entries[0] || {};
    ok('插入行 id 非空', typeof insertedRow.id === 'string' && insertedRow.id.length > 0, fmt(insertedRow.id));
    ok('插入行 name = 包名', insertedRow.name === pkg.name, fmt(insertedRow.name));

    const configFile = path.join(root, 'lib', 'config.js');
    if (!has(configFile)) {
      missing.push(configFile);
      console.log('  skip lib/config.js 缺失，跳过 CONFIG_NS 与补丁行 id 的一致性检查');
    } else {
      const loaded = await importFile(configFile);
      if (loaded.error !== undefined) {
        ok('lib/config.js 可加载', false, loaded.error.message);
      } else {
        const configNs = loaded.module.CONFIG_NS;
        ok('lib/config.js 导出 CONFIG_NS 字符串', typeof configNs === 'string' && configNs.length > 0, fmt(configNs));
        ok('CONFIG_NS = 补丁插入行 id（客户端 mutate 的 ns）', configNs === insertedRow.id, fmt(configNs) + ' vs ' + fmt(insertedRow.id));
        ok('lib/config.js 导出 Config schema', loaded.module.Config !== undefined, fmt(loaded.module.Config));
        ok('lib/config.js 导出 LOG_LIMIT_DEFAULT', typeof loaded.module.LOG_LIMIT_DEFAULT === 'number', fmt(loaded.module.LOG_LIMIT_DEFAULT));
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 2. client.js                                                        */
/* ------------------------------------------------------------------ */

section('2. client.js 注册形状（CONTRACT §5）');
// 默认校验仓库根目录的 client.js；DSH_VERIFY_CLIENT 仅作为 harness 自检接缝
// （用契约形状的替身文件验证本段断言本身可用），不参与正常验收。
const clientFile = process.env.DSH_VERIFY_CLIENT !== undefined && process.env.DSH_VERIFY_CLIENT !== ''
  ? path.resolve(process.env.DSH_VERIFY_CLIENT)
  : path.join(root, 'client.js');
const clientSource = readText(clientFile);
if (clientSource === undefined) {
  console.log('  skip client.js 缺失，跳过浏览器半的注册形状检查');
} else {
  let entry;
  const reactBase = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    cloneElement: (element, props) => ({ ...(element || {}), props: { ...((element || {}).props || {}), ...(props || {}) } }),
    Fragment: Symbol.for('react.fragment'),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useMemo: (factory) => (typeof factory === 'function' ? factory() : undefined),
    useCallback: (callback) => callback,
    useRef: (value) => ({ current: value }),
    useContext: () => undefined,
    useReducer: (reducer, initial) => [initial, () => {}],
    useId: () => 'stub-id',
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
    useTransition: () => [false, (callback) => { if (typeof callback === 'function') callback(); }],
    memo: (component) => component,
    forwardRef: (component) => component,
    createContext: (value) => ({ Provider: 'Provider', Consumer: 'Consumer', _currentValue: value }),
    Children: { map: () => [], toArray: () => [], count: () => 0, only: (child) => child },
  };
  const reactStub = new Proxy(reactBase, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'then') return undefined;
      if (prop === '__esModule') return true;
      if (typeof prop === 'string' && /^[A-Z]/.test(prop)) return function StubComponent() { return null; };
      return function stubFunction() { return undefined; };
    },
  });
  const makeElement = () => ({
    dataset: {},
    style: {},
    textContent: '',
    appendChild: () => {},
    setAttribute: () => {},
    remove: () => {},
    removeChild: () => {},
    addEventListener: () => {},
  });
  const documentStub = {
    head: { appendChild: () => {} },
    body: { appendChild: () => {}, removeChild: () => {} },
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    createElement: makeElement,
    createTextNode: () => ({}),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const windowStub = {
    __ModuleLoader__: { load: (value) => { entry = value; } },
    addEventListener: () => {},
    removeEventListener: () => {},
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    location: { href: 'http://localhost/' },
  };
  const requireStub = (specifier) => {
    if (specifier === 'react') return reactStub;
    throw new Error('client.js 只能 require("react")，却被要求 require("' + specifier + '")');
  };

  let evalError;
  try {
    // 用经典脚本语义求值：浏览器模块加载器直接执行该文件，不用 ESM 链接。
    new Function('window', 'document', 'console', 'require', clientSource)(windowStub, documentStub, console, requireStub);
  } catch (error) {
    evalError = error;
  }

  if (evalError !== undefined) {
    ok('client.js 可被经典脚本求值（无 import/export、无语法错误）', false, evalError.message);
  } else {
    ok('client.js 调用 window.__ModuleLoader__.load', entry !== undefined);
    ok('工厂 id = 包名', pkg !== undefined && entry && entry.id === pkg.name, fmt(entry && entry.id));
    ok('factory 是函数', entry !== undefined && typeof entry.factory === 'function');

    let plugin;
    let factoryError;
    try {
      plugin = entry.factory(requireStub);
    } catch (error) {
      factoryError = error;
    }
    if (factoryError !== undefined) {
      ok('factory(require) 不抛错', false, factoryError.message);
    } else {
      ok('插件对象有 apply 函数', plugin && typeof plugin.apply === 'function');
      ok('inject 是数组', Array.isArray(plugin && plugin.inject), fmt(plugin && plugin.inject));
      const inject = (plugin && plugin.inject) || [];
      for (const name of ['slots', 'locale', 'remote', 'remote.settings']) {
        ok('inject 声明 ' + name, inject.includes(name), fmt(inject));
      }

      const clientRecord = { slots: [], effects: [], locales: [], binds: [], mutations: [] };
      const clientDisposer = () => {};
      const clientCtx = {
        effect: (callback) => { const disposer = callback(); clientRecord.effects.push(typeof disposer === 'function' ? disposer : clientDisposer); return clientDisposer; },
        on: () => clientDisposer,
        locale: {
          register: (namespace, messages) => { clientRecord.locales.push({ namespace, messages }); return clientDisposer; },
          bind: (namespace) => { clientRecord.binds.push(namespace); return (key) => String(key); },
        },
        remote: {
          $on: () => clientDisposer,
          settings: {
            describe: async () => ({ ok: true, value: { revision: 1, writable: true, namespaces: [{ ns: 'scheduled-tasks', revision: 1, value: {} }] } }),
            mutate: async (namespace, ops, revision) => { clientRecord.mutations.push({ namespace, ops, revision }); return { ok: true, value: {} }; },
          },
        },
        slots: {
          /*
           * 回调是 **generator**（与已发布的 dsh-client-ui-sidebar-right 一致），
           * 所以必须迭代它才会执行 `yield ctx.slots.register(...)` —— 只调
           * `callback()` 拿到一个未启动的 generator，body 一行都不会跑，
           * 于是"没注册任何 slot"的假失败。
           */
          inject: (key, callback) => {
            const effect = callback();
            if (effect !== null && typeof effect === 'object' && typeof effect.next === 'function') {
              for (let step = effect.next(); step.done !== true; step = effect.next()) {
                // 每次 next() 执行一个 yield，注册就在其中发生。
              }
              return clientDisposer;
            }
            return typeof effect === 'function' ? effect : clientDisposer;
          },
          register: (options, component) => { clientRecord.slots.push({ options, component }); return clientDisposer; },
        },
      };

      let applyError;
      let cleanup = null;
      try {
        cleanup = plugin.apply(clientCtx);
      } catch (error) {
        applyError = error;
      }
      await new Promise((resolve) => realSetTimeout(resolve, 20));

      if (applyError !== undefined) {
        ok('client apply(ctx) 不抛错', false, applyError.message);
      } else {
        ok('client apply(ctx) 不抛错', true);
        const names = clientRecord.slots.map((item) => item.options && item.options.name);
        ok('apply 恰好注册 2 个 slot', clientRecord.slots.length === 2, '实际 ' + clientRecord.slots.length + '：' + fmt(names));
        ok('注册的 slot 恰为 sidebar.panellist 与 main', names.length === 2 && names.includes('sidebar.panellist') && names.includes('main'), fmt(names));
        const panel = clientRecord.slots.find((item) => item.options && item.options.name === 'sidebar.panellist');
        const main = clientRecord.slots.find((item) => item.options && item.options.name === 'main');
        ok('panellist 的 id = scheduled-tasks（PANEL_ID）', panel !== undefined && panel.options.id === 'scheduled-tasks', fmt(panel && panel.options));
        ok('panellist 的 order 是数字', panel !== undefined && typeof panel.options.order === 'number', fmt(panel && panel.options.order));
        ok('panellist 提供 label（字符串或函数）', panel !== undefined && (typeof panel.options.label === 'string' || typeof panel.options.label === 'function'), fmt(panel && panel.options.label));
        ok('main 的 key = scheduled-tasks', main !== undefined && main.options.key === 'scheduled-tasks', fmt(main && main.options));
        ok('两个 slot 都带组件函数', clientRecord.slots.every((item) => typeof item.component === 'function'));
        ok('样式/副作用经 ctx.effect 建立', clientRecord.effects.length >= 1, '实际 ' + clientRecord.effects.length);
        ok('locale.register 被调用', clientRecord.locales.length >= 1 && typeof clientRecord.locales[0].namespace === 'string', fmt(clientRecord.locales.map((item) => item.namespace)));
        ok('locale.bind 被调用', clientRecord.binds.length >= 1, fmt(clientRecord.binds));
        ok('locale 文案含 zh 与 en', clientRecord.locales.length >= 1 && clientRecord.locales[0].messages && clientRecord.locales[0].messages.zh !== undefined && clientRecord.locales[0].messages.en !== undefined, fmt(Object.keys((clientRecord.locales[0] || {}).messages || {})));

        if (typeof cleanup === 'function') {
          let cleanupError;
          try { cleanup(); } catch (error) { cleanupError = error; }
          ok('apply 返回的清理函数可调用', cleanupError === undefined, cleanupError && cleanupError.message);
        } else {
          console.log('  info client apply 未返回清理函数 —— 契约 §3：资源经 ctx.effect 收尾，apply 无需返回值');
        }
        let effectsError;
        for (const disposer of clientRecord.effects) {
          try { disposer(); } catch (error) { effectsError = error; }
        }
        ok('effect 清理函数可调用', effectsError === undefined, effectsError && effectsError.message);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 5. 纯函数边界（§6.5）                                                */
/* ------------------------------------------------------------------ */

section('5. nextScheduleTime 五种 schedule 边界（§6.5）');
const cronFile = path.join(root, 'lib', 'cron.js');
if (!has(cronFile)) {
  missing.push(cronFile);
  console.log('  skip lib/cron.js 缺失，跳过纯函数边界检查');
} else {
  const loaded = await importFile(cronFile);
  if (loaded.error !== undefined) {
    ok('lib/cron.js 可加载', false, loaded.error.message);
  } else {
    const { nextScheduleTime } = loaded.module;
    if (typeof nextScheduleTime !== 'function') {
      ok('lib/cron.js 导出 nextScheduleTime', false, fmt(nextScheduleTime));
    } else {
      const at = (year, month, day, hh = 0, mm = 0) => new Date(year, month - 1, day, hh, mm, 0, 0).getTime();
      const cases = [
        ['every', { kind: 'every', everyMinutes: 30 }, at(2026, 1, 5, 10, 0), at(2026, 1, 5, 10, 30)],
        ['daily 跨日', { kind: 'daily', time: '09:00' }, at(2026, 1, 5, 10, 0), at(2026, 1, 6, 9, 0)],
        ['daily 当天', { kind: 'daily', time: '09:00' }, at(2026, 1, 5, 8, 0), at(2026, 1, 5, 9, 0)],
        ['weekly 跨周', { kind: 'weekly', time: '09:00', weekdays: [1] }, at(2026, 1, 5, 12, 0), at(2026, 1, 12, 9, 0)],
        ['weekly 本周', { kind: 'weekly', time: '08:00', weekdays: [3] }, at(2026, 1, 5, 12, 0), at(2026, 1, 7, 8, 0)],
        ['cron 步长', { kind: 'cron', expression: '*/15 * * * *' }, at(2026, 1, 5, 10, 7), at(2026, 1, 5, 10, 15)],
        ['cron 跨日', { kind: 'cron', expression: '0 9 * * 1-5' }, at(2026, 1, 5, 10, 0), at(2026, 1, 6, 9, 0)],
        ['once 未来', { kind: 'once', at: at(2026, 1, 5, 11, 0) }, at(2026, 1, 5, 10, 0), at(2026, 1, 5, 11, 0)],
        ['once 过去', { kind: 'once', at: at(2026, 1, 5, 9, 0) }, at(2026, 1, 5, 10, 0), null],
      ];
      for (const [label, schedule, from, expected] of cases) {
        let actual;
        let error;
        try { actual = nextScheduleTime(schedule, from); } catch (caught) { error = caught; }
        if (error !== undefined) {
          ok('nextScheduleTime ' + label, false, error.message);
        } else {
          ok('nextScheduleTime ' + label, Object.is(actual, expected), '期望 ' + fmt(new Date(expected)) + '，实际 ' + fmt(actual === null ? null : new Date(actual)));
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 3. index.js 宿主半                                                   */
/* ------------------------------------------------------------------ */

section('3. index.js 宿主半（§6.3/§6.4）');
const indexFile = path.join(root, 'index.js');
const REQUIRED_LIB = ['config.js', 'cron.js', 'model.js', 'store.js', 'runner.js', 'scheduler.js', 'tools.js', 'skill.js'];
for (const name of REQUIRED_LIB) {
  const file = path.join(root, 'lib', name);
  if (!has(file)) missing.push(file);
}
if (!has(indexFile)) {
  missing.push(indexFile);
  console.log('  skip index.js 缺失，跳过宿主 apply 装配检查');
} else {
  const loaded = await importFile(indexFile);
  if (loaded.error !== undefined) {
    ok('index.js 可加载（含 lib/*.js 相对依赖）', false, loaded.error.message);
  } else {
    const host = loaded.module;
    ok('index.js 可加载（含 lib/*.js 相对依赖）', true);
    const apply = typeof host.apply === 'function' ? host.apply : (host.default && typeof host.default.apply === 'function' ? host.default.apply : undefined);
    ok('导出 apply 函数', typeof apply === 'function', fmt(host.apply));
    ok('导出 inject', host.inject !== undefined, fmt(host.inject));
    if (Array.isArray(host.inject)) {
      ok('inject 为非空数组', host.inject.length >= 1, fmt(host.inject));
    } else if (host.inject !== undefined) {
      ok('inject 为对象（Cordis 也接受对象形式）', typeof host.inject === 'object', fmt(host.inject));
    }
    if (stubbedSpecifiers.size > 0) {
      console.log('  info 以下裸包在仓库里解析不到，已用惰性 stub 顶替：' + [...stubbedSpecifiers].join(', '));
    }

    if (typeof apply === 'function') {
      /* ---- 定时器 stub：统计 apply 注册了几次 interval ---- */
      const realTimers = {
        setInterval: globalThis.setInterval,
        setTimeout: globalThis.setTimeout,
        clearInterval: globalThis.clearInterval,
        clearTimeout: globalThis.clearTimeout,
      };
      const timerCalls = { intervals: [], timeouts: [] };
      const makeFakeTimer = () => ({
        unref() { return this; },
        ref() { return this; },
        close() {},
        [Symbol.toPrimitive]() { return 0; },
      });
      globalThis.setInterval = (callback, ms) => { timerCalls.intervals.push(ms); return makeFakeTimer(); };
      globalThis.setTimeout = (callback, ms) => { timerCalls.timeouts.push(ms); return makeFakeTimer(); };
      globalThis.clearInterval = () => {};
      globalThis.clearTimeout = () => {};

      const defaultConfig = {
        enabled: true,
        tickMs: 30000,
        maxConcurrentRuns: 2,
        runTimeoutMs: 1800000,
        logLimit: 200,
        workspaceRoot: null,
        tasks: [],
        internal: { log: [], runs: {} },
      };

      const makeHostCtx = (record) => {
        const disposer = () => {};
        const settings = {
          describe: async () => ({
            ok: true,
            value: {
              revision: 1,
              writable: true,
              namespaces: [{ ns: 'scheduled-tasks', revision: 1, value: defaultConfig }],
              entries: [{ ns: 'scheduled-tasks', revision: 1 }],
            },
          }),
          mutate: async (namespace, ops, revision) => { record.mutations.push({ namespace, ops, revision }); return { ok: true, value: {} }; },
        };
        const ctx = {
          config: defaultConfig,
          logger: {
            info() {},
            warn(...args) { record.warnings.push(args.map(String).join(' ')); },
            error(...args) { record.warnings.push(args.map(String).join(' ')); },
            debug() {},
          },
          log: { info() {}, warn() {}, error() {}, debug() {} },
          get(name) { return ctx[name] !== undefined ? ctx[name] : disposer; },
          set() {}, provide() {}, plugin() {}, schema() {},
          effect(callback) { const value = callback(); const cleanup = typeof value === 'function' ? value : disposer; record.effects.push(cleanup); return disposer; },
          on(name, callback) { record.listeners.push({ name, callback }); return disposer; },
          once(name, callback) { record.listeners.push({ name, callback }); return disposer; },
          emit() {}, parallel: async () => [],
          setTimeout(callback, ms) { record.timeouts.push(ms); return makeFakeTimer(); },
          setInterval(callback, ms) { record.intervals.push(ms); return makeFakeTimer(); },
          clearTimeout: () => {}, clearInterval: () => {},
          tools: { register(tool) { record.tools.push(tool); return disposer; }, get: () => undefined, list: () => [] },
          skills: { register(skill) { record.skills.push(skill); return disposer; }, get: () => undefined, list: () => [] },
          slots: { register(options, component) { record.slots.push({ options, component }); return disposer; }, inject: (key, callback) => { const value = callback(); return typeof value === 'function' ? value : disposer; } },
          settings,
          remote: { settings, $on: () => disposer },
          locale: { register: () => disposer, bind: () => (key) => String(key) },
          systemPrompt: { register: () => disposer, section: () => disposer, get: () => undefined },
          agentLoop: {
            createAgent: async () => ({
              agent: { followup: async () => {}, ctx: { on: () => disposer, emit: () => {} } },
              dispose: () => {},
            }),
          },
          agents: { create: async () => ({ followup: async () => {} }), get: () => undefined },
          workspace: { resolve: () => undefined, get: () => undefined },
        };
        return ctx;
      };

      const records = [];
      const makeRecord = () => {
        const entry = { effects: [], listeners: [], tools: [], skills: [], slots: [], intervals: [], timeouts: [], mutations: [], warnings: [] };
        records.push(entry);
        return entry;
      };
      // 契约 §3：测试里被 stub 掉的 ctx.setInterval 与真 globalThis.setInterval 都要算数。
      const countIntervals = () => timerCalls.intervals.length
        + records.reduce((sum, entry) => sum + entry.intervals.length, 0);

      const recordA = makeRecord();
      const ctxA = makeHostCtx(recordA);
      const before1 = countIntervals();
      let applyError;
      let cleanupResult = null;
      try {
        const value = apply(ctxA, defaultConfig);
        cleanupResult = value && typeof value.then === 'function' ? await value : value;
      } catch (error) {
        applyError = error;
      }
      const after1 = countIntervals();
      const effectsA1 = recordA.effects.length;

      if (applyError !== undefined) {
        ok('apply(ctx, config) 不抛错', false, applyError.stack || applyError.message);
      } else {
        ok('apply(ctx, config) 不抛错', true);
        ok(
          'apply 返回 undefined（契约 §3：资源交给 ctx.effect，不经返回值交给 Loader）',
          cleanupResult === undefined,
          'apply 返回 ' + fmt(cleanupResult),
        );
        ok(
          'ctxA 装配新增恰好 1 个 interval（调度器已启动）',
          after1 - before1 === 1,
          '新增 ' + (after1 - before1) + ' 次；ms = ' + fmt(timerCalls.intervals.concat(recordA.intervals)),
        );
        ok('apply 用 ctx.effect 注册生命周期（>= 1 个）', effectsA1 >= 1, '实际 ' + effectsA1);

        /* ---- 同一个 ctx 再来一次：幂等 no-op ---- */
        const warningsBefore = recordA.warnings.length;
        let secondError;
        try { apply(ctxA, defaultConfig); } catch (error) { secondError = error; }
        const after2 = countIntervals();
        ok('同一 ctx 二次 apply 不抛错', secondError === undefined, secondError && secondError.message);
        ok(
          '同一 ctx 二次 apply 不重复注册定时器（契约 §3 幂等守卫）',
          secondError === undefined && after2 === after1,
          '第一次后 ' + after1 + ' 次 → 二次后 ' + after2 + ' 次（多注册 ' + (after2 - after1) + ' 次）',
        );
        ok(
          '同一 ctx 二次 apply 不重复注册 effect',
          recordA.effects.length === effectsA1,
          '第一次后 ' + effectsA1 + ' 个 → 二次后 ' + recordA.effects.length + ' 个',
        );
        ok('同一 ctx 二次 apply 有告警日志', recordA.warnings.length > warningsBefore, fmt(recordA.warnings));

        /* ---- 不同 ctx：各自独立装配 ---- */
        const recordB = makeRecord();
        const ctxB = makeHostCtx(recordB);
        const before3 = countIntervals();
        let thirdError;
        try { apply(ctxB, defaultConfig); } catch (error) { thirdError = error; }
        const after3 = countIntervals();
        ok(
          '不同 ctx 各自独立装配（新增 1 个 interval）',
          thirdError === undefined && after3 - before3 === 1,
          '新增 ' + (after3 - before3) + ' 次' + (thirdError === undefined ? '' : '；抛错 ' + thirdError.message),
        );

        let effectError;
        for (const entry of records) {
          for (const disposer of entry.effects) {
            if (typeof disposer !== 'function') continue;
            try { disposer(); } catch (error) { effectError = error; }
          }
        }
        ok('全部 ctx.effect 清理函数可调用', effectError === undefined, effectError && effectError.message);
      }

      globalThis.setInterval = realTimers.setInterval;
      globalThis.setTimeout = realTimers.setTimeout;
      globalThis.clearInterval = realTimers.clearInterval;
      globalThis.clearTimeout = realTimers.clearTimeout;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 4. 禁止的运行时 import                                                */
/* ------------------------------------------------------------------ */

section('4. 禁止 @deepseek-ai/* 运行时 import（§5、§3 tools/skill）');
const FORBIDDEN_FILES = ['client.js', path.join('lib', 'tools.js'), path.join('lib', 'skill.js')];
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

for (const relative of FORBIDDEN_FILES) {
  const file = path.join(root, relative);
  const source = readText(file);
  if (source === undefined) {
    console.log('  skip ' + relative + ' 缺失，跳过 import 扫描');
    continue;
  }
  const stripped = stripComments(source);
  const hit = /\bfrom\s*['"]@deepseek-ai\//.test(stripped) ||
    /\bimport\s*['"]@deepseek-ai\//.test(stripped) ||
    /\bimport\s*\(\s*['"]@deepseek-ai\//.test(stripped) ||
    /\brequire\s*\(\s*['"]@deepseek-ai\//.test(stripped);
  ok(relative + ' 无 @deepseek-ai/* 运行时 import', !hit, hit ? '发现 @deepseek-ai/* import/require 语句' : undefined);
}

/* ------------------------------------------------------------------ */
/* 汇总                                                                */
/* ------------------------------------------------------------------ */

console.log('\n' + '='.repeat(64));
const uniqueMissing = [...new Set(missing)];
if (uniqueMissing.length > 0) {
  console.log('缺失 / 无法加载（尚未就位的交付物）：');
  for (const file of uniqueMissing) console.log('  - ' + file);
  console.log('已通过 ' + passed + ' 项，失败 ' + failures.length + ' 项；上述文件到位后重跑本脚本。');
  process.exit(2);
}
if (failures.length > 0) {
  console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项：');
  for (const item of failures) console.log('  - ' + item);
  process.exit(1);
}
console.log('全部通过：' + passed + ' 项装配形状断言（视觉效果仍需在真实页面确认）。');
process.exit(0);
