#!/usr/bin/env node
/**
 * verify-contract.mjs — 「Token 用量」插件的**装配形状**自检（零第三方依赖）。
 *
 * 这不是行为测试，也不模拟 React 渲染。它只回答一个问题：
 * 「插件两侧的装配形状，和契约里写死的那些形状，是不是同一件事？」
 *
 * 覆盖 10 组：
 *   [1] 清单与行 id 一致（package.json / cordis.patch.yml / constants 三方同 id）
 *   [2] 客户端与宿主侧的常量一致（PANEL_ID / CONFIG_NS / PROJECTION_KEY）
 *   [3] 【重点】两份 formatTokens / formatExact 实现逐值一致（真跑客户端半比对）
 *   [4] 四桶口径与官方一致（刻意不含 reasoningTokens）
 *   [5] 投影单元定义形状（静态解析 lib/projection.js：它 import zod，零依赖下不可 import）
 *   [6] 持久化通道的选择契约（configEditor 优先 / 完整 raw config / 先清空再返回）
 *   [7] 宿主侧的装配形状（硬 inject=settings / 可选 sessionProjections / unref 定时器）
 *   [8] lib/config.js 的 volatile 硬规则
 *   [9] 扫描的诚实性契约（新→旧、scanLimit、truncated、单个坏日志只 skipped+=1）
 *   [10] 文案键只在客户端（zh/en 键集合一致、LOCALE_NS 独立命名空间）
 *
 * 事实来源分两类：
 *   - **真 import**：lib/constants.js、lib/fold.js、lib/store.js、lib/summary.js 都是零依赖的，
 *     直接调用它们的纯函数做断言（比读源码强）；
 *   - **静态解析**：lib/config.js（import schemastery）与 lib/projection.js（import zod）
 *     在零依赖的 Node 里解析不到，只能读源码断言形状 —— 这是本脚本存在的理由之一。
 *
 * client.js 用 `window.__ModuleLoader__` 桩跑起来，从 `__internals` 里取出浏览器侧自己的
 * formatTokens / formatExact，与 lib/fold.js 的那份逐个数字比对。重复实现无法避免
 * （浏览器 bundle 只拿到 `require`），但「重复且被验证」与「重复且会漂移」是两回事。
 *
 * 用法：node scripts/verify-contract.mjs
 * 退出码：0 = 全部通过；1 = 有断言失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/* ------------------------------------------------------------------ */
/* 最小 harness（与 scripts/test-fold.mjs、verify-layout.mjs 同一风格）  */
/* ------------------------------------------------------------------ */

let ok = 0;
const failures = [];
const groups = new Map();
let sectionName = '(未分组)';

function section(name) {
  sectionName = name;
  if (!groups.has(name)) groups.set(name, { total: 0, failed: 0 });
  console.log('');
  console.log('[ ' + name + ' ]');
}

function check(label, condition, detail) {
  const group = groups.get(sectionName) ?? { total: 0, failed: 0 };
  groups.set(sectionName, group);
  group.total += 1;
  if (condition) {
    ok += 1;
    console.log('  ok   ' + label);
    return true;
  }
  group.failed += 1;
  const line = label + (detail === undefined ? '' : ' — ' + detail);
  failures.push(sectionName + ' :: ' + line);
  console.log('  FAIL ' + line);
  return false;
}

/** 详情用的短格式化：NaN/Infinity/函数都能读。 */
function fmt(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'function') return '[function ' + (value.name || 'anonymous') + ']';
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return '[' + value.map(fmt).join(', ') + ']';
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readJson(file) {
  const text = readText(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 去掉注释：避免「注释里写了形状」被当成「代码满足形状」。 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** 「值相等」比较器：任一实现缺失/抛错一律判否（不许 undefined === undefined 假通过）。 */
function sameResult(left, right, value) {
  if (typeof left !== 'function' || typeof right !== 'function') return false;
  try {
    return left(value) === right(value);
  } catch {
    return false;
  }
}

function safeCall(fn, value) {
  if (typeof fn !== 'function') return '<没有实现>';
  try {
    return fn(value);
  } catch (error) {
    return '<抛错:' + (error instanceof Error ? error.message : String(error)) + '>';
  }
}

/**
 * 从 `marker` **之后**的第一个 `{` 起做花括号配对，返回括号内的源码。
 * 用于把「单元定义 / wire / view / persist / internal」等块单独摘出来断言，
 * 免得一个字段名在文件别处出现就让断言假通过。
 *
 * 只从 marker 末尾开始找花括号，并先跳过其后新开的圆括号 —— 否则形参默认值里的
 * `= {}`（例如 `buildSummary(query, options = {})`）会被当成函数体。
 */
function blockAfter(source, marker) {
  const at = source.indexOf(marker);
  if (at < 0) return null;
  let parens = 0;
  let open = -1;
  for (let i = at + marker.length; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i += 1;
      while (i < source.length && source[i] !== ch) {
        if (source[i] === '\\') i += 1;
        i += 1;
      }
      continue;
    }
    if (ch === '(') parens += 1;
    else if (ch === ')') parens -= 1;
    else if (ch === '{' && parens <= 0) {
      open = i;
      break;
    }
  }
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i += 1;
      while (i < source.length && source[i] !== ch) {
        if (source[i] === '\\') i += 1;
        i += 1;
      }
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return null;
}

/** 块里是否有某个对象键（同时接受 `k: v` 与 ES6 简写 `k,`）。 */
function hasField(block, name) {
  return block !== null && new RegExp('[{,\\s]' + name + '\\s*[,:}]').test(block);
}

/** 取出 `callee(...)` 的顶层实参列表（用于「createStore 是不是三参调用」）。 */
function callArgs(source, callee) {
  const at = source.indexOf(callee + '(');
  if (at < 0) return null;
  const open = at + callee.length;
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0 && ch === ')') {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return null;
  const args = [];
  let level = 0;
  let current = '';
  for (const ch of source.slice(open + 1, end)) {
    if ('([{'.includes(ch)) level += 1;
    else if (')]}'.includes(ch)) level -= 1;
    if (ch === ',' && level === 0) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) args.push(current.trim());
  return args;
}

/** 极简 YAML 扫描：只认「id 开一行，后续键值填进该行」。 */
function parsePatchRows(text) {
  const rows = [];
  let row = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '');
    const match = /^\s*(?:-\s*)?([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (match === null) continue;
    const key = match[1];
    const value = match[2].trim().replace(/^['"]|['"]$/g, '');
    if (key === 'id') {
      row = { id: value };
      rows.push(row);
    } else if (row !== null && value !== '') {
      row[key] = value;
    }
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* 客户端桩：把 client.js 真的跑起来，取出 __internals                   */
/* ------------------------------------------------------------------ */

const clientFile = path.join(root, 'client.js');
const clientSource = readText(clientFile);

/**
 * react 桩：模块顶层只用到 React.createElement（`const h = React.createElement`），
 * hook 只在组件被渲染时才调用，而本脚本不渲染组件。给全是为了将来加渲染自检时不用改桩。
 */
const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol.for('react.fragment'),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: (factory) => (typeof factory === 'function' ? factory() : undefined),
  useCallback: (callback) => callback,
  useRef: (value) => ({ current: value === undefined ? null : value }),
};

let clientInternals = null;
let clientFactoryId = null;
let clientLoadError = null;

if (clientSource === null) {
  clientLoadError = new Error('client.js 不存在或不可读');
} else {
  let captured = null;
  const previousWindow = globalThis.window;
  globalThis.window = { __ModuleLoader__: { load: (def) => { captured = def; } } };
  try {
    // 经典脚本语义：文件没有 import/export，作为无绑定 ESM 求值即可执行顶层语句。
    await import(pathToFileURL(clientFile).href);
    if (captured === null) {
      clientLoadError = new Error('client.js 没有调用 window.__ModuleLoader__.load');
    } else if (typeof captured.factory !== 'function') {
      clientLoadError = new Error('__ModuleLoader__.load 的 def.factory 不是函数');
    } else {
      clientFactoryId = captured.id;
      const out = captured.factory((name) => (name === 'react' ? ReactStub : undefined));
      clientInternals = out?.__internals ?? null;
      if (clientInternals === null) {
        clientLoadError = new Error('factory 返回值缺少 __internals 测试接缝');
      }
    }
  } catch (error) {
    clientLoadError = error;
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
}

console.log('verify-contract.mjs — 装配形状自检（零第三方依赖）');
console.log('插件根目录：' + root);
console.log('运行时：node ' + process.version);
console.log(
  '客户端桩：' + (clientLoadError === null
    ? '已装载 factory(' + fmt(clientFactoryId) + ') 并取出 __internals'
    : '装载失败 — ' + (clientLoadError instanceof Error ? clientLoadError.message : String(clientLoadError))),
);

const clientCode = clientSource === null ? '' : stripComments(clientSource);

/* ------------------------------------------------------------------ */
/* 1. 清单与行 id 一致                                                   */
/* ------------------------------------------------------------------ */

section('1. 清单与行 id 一致');

const pkg = readJson(path.join(root, 'package.json'));
check('package.json 存在且是合法 JSON', pkg !== null, path.join(root, 'package.json'));
check('name = dsh-plugin-token-usage', pkg?.name === 'dsh-plugin-token-usage', fmt(pkg?.name));
check('version 是非空语义化版本串', typeof pkg?.version === 'string' && /^\d+\.\d+\.\d+/.test(pkg.version), fmt(pkg?.version));
check('private = true', pkg?.private === true, fmt(pkg?.private));
check('license = MIT', pkg?.license === 'MIT', fmt(pkg?.license));
check('type = module（ESM）', pkg?.type === 'module', fmt(pkg?.type));

check("exports['.'] = ./index.js", pkg?.exports?.['.'] === './index.js', fmt(pkg?.exports?.['.']));
check("exports['./client'] = ./client.js", pkg?.exports?.['./client'] === './client.js', fmt(pkg?.exports?.['./client']));
check("exports['./package.json'] 存在", pkg?.exports?.['./package.json'] === './package.json', fmt(pkg?.exports?.['./package.json']));
check("exports['./locale/*.json'] 存在", pkg?.exports?.['./locale/*.json'] === './locale/*.json', fmt(pkg?.exports?.['./locale/*.json']));

const REQUIRED_FILES = [
  'index.js',
  'client.js',
  'lib/**/*.js',
  'scripts/**/*.mjs',
  'cordis.patch.yml',
  'icon.svg',
  'locale/*.json',
  'README.md',
  'README.zh.md',
  'CONTRACT.md',
];
const declaredFiles = Array.isArray(pkg?.files) ? pkg.files : [];
for (const entry of REQUIRED_FILES) {
  check('files 覆盖 ' + entry, declaredFiles.includes(entry), 'files = ' + fmt(declaredFiles));
}

// 只提示不判负：`files` 里声明的交付物未必都已落盘（npm 打包时缺失项会被忽略）。
const missingDeclared = declaredFiles.filter((entry) => !entry.includes('*') && !fs.existsSync(path.join(root, entry)));
if (missingDeclared.length > 0) {
  console.log('  note files 里声明但磁盘上还不存在的交付物：' + missingDeclared.join(', '));
}

check('dsh.bundle.patch = ./cordis.patch.yml', pkg?.dsh?.bundle?.patch === './cordis.patch.yml', fmt(pkg?.dsh?.bundle));
check("dsh.client.platform = 'web'", pkg?.dsh?.client?.platform === 'web', fmt(pkg?.dsh?.client));

const patchSource = readText(path.join(root, 'cordis.patch.yml'));
check('cordis.patch.yml 存在', patchSource !== null, path.join(root, 'cordis.patch.yml'));
const patchRows = patchSource === null ? [] : parsePatchRows(patchSource);
const insertCount = patchSource === null ? 0 : (stripComments(patchSource).match(/^\s*-\s*insert:\s*$/gm) ?? []).length;
check('补丁里恰好一个 insert 段', insertCount === 1, '实际 ' + insertCount);
check('insert 恰好插入一行', patchRows.length === 1, fmt(patchRows));
const insertRow = patchRows[0] ?? {};
check("插入行 id = 'token-usage'", insertRow.id === 'token-usage', fmt(insertRow.id));
check('插入行 name = package.json 的 name', insertRow.name === pkg?.name, fmt(insertRow.name) + ' vs ' + fmt(pkg?.name));

const constantsFile = path.join(root, 'lib', 'constants.js');
const constantsCode = readText(constantsFile);
check('lib/constants.js 可读', constantsCode !== null, constantsFile);
const constantsStripped = constantsCode === null ? '' : stripComments(constantsCode);
const pickConst = (name) => {
  const match = new RegExp('export const ' + name + "\\s*=\\s*'([^']*)'").exec(constantsStripped);
  return match === null ? null : match[1];
};
const CONFIG_NS = pickConst('CONFIG_NS');
const PANEL_ID = pickConst('PANEL_ID');
const TOKEN_BY_MODEL_KEY = pickConst('TOKEN_BY_MODEL_KEY');
const PLUGIN_ID = pickConst('PLUGIN_ID');
check('lib/constants.js 解析出 CONFIG_NS', CONFIG_NS !== null, fmt(CONFIG_NS));
check('lib/constants.js 解析出 PANEL_ID', PANEL_ID !== null, fmt(PANEL_ID));
check('lib/constants.js 解析出 TOKEN_BY_MODEL_KEY', TOKEN_BY_MODEL_KEY !== null, fmt(TOKEN_BY_MODEL_KEY));

// 三方 id 一致：Loader 行 id（settings ns）/ CONFIG_NS / PANEL_ID。
check('行 id === CONFIG_NS', insertRow.id === CONFIG_NS, fmt(insertRow.id) + ' vs ' + fmt(CONFIG_NS));
check('行 id === PANEL_ID', insertRow.id === PANEL_ID, fmt(insertRow.id) + ' vs ' + fmt(PANEL_ID));
check('行 id === PLUGIN_ID', insertRow.id === PLUGIN_ID, fmt(insertRow.id) + ' vs ' + fmt(PLUGIN_ID));
check('CONFIG_NS === PANEL_ID（席位 id 与 settings ns 同一个 id）', CONFIG_NS === PANEL_ID, fmt(CONFIG_NS) + ' vs ' + fmt(PANEL_ID));

/* ------------------------------------------------------------------ */
/* 2. 客户端与宿主侧的常量一致                                           */
/* ------------------------------------------------------------------ */

section('2. 客户端与宿主侧常量一致');

check('client.js 可读', clientSource !== null, clientFile);
const pickClientConst = (name) => {
  const match = new RegExp('const ' + name + "\\s*=\\s*'([^']*)'").exec(clientCode);
  return match === null ? null : match[1];
};
const clientPanelId = pickClientConst('PANEL_ID');
const clientConfigNs = pickClientConst('CONFIG_NS');
const clientProjectionKey = pickClientConst('PROJECTION_KEY');
check('client.js 解析出 PANEL_ID', clientPanelId !== null, fmt(clientPanelId));
check('client.js 解析出 CONFIG_NS', clientConfigNs !== null, fmt(clientConfigNs));
check('client.js 解析出 PROJECTION_KEY', clientProjectionKey !== null, fmt(clientProjectionKey));

check('两边 PANEL_ID 相同', clientPanelId !== null && clientPanelId === PANEL_ID, fmt(clientPanelId) + ' vs ' + fmt(PANEL_ID));
check('两边 CONFIG_NS 相同', clientConfigNs !== null && clientConfigNs === CONFIG_NS, fmt(clientConfigNs) + ' vs ' + fmt(CONFIG_NS));
check(
  'client.js 的 PROJECTION_KEY === lib/constants.js 的 TOKEN_BY_MODEL_KEY',
  clientProjectionKey !== null && clientProjectionKey === TOKEN_BY_MODEL_KEY,
  fmt(clientProjectionKey) + ' vs ' + fmt(TOKEN_BY_MODEL_KEY),
);

// 浏览器侧内部自洽：同一个席位 id 既要给 sidebar.panellist，也要给 main。
check(
  "sidebar.panellist 的 id 是 PANEL_ID",
  /name:\s*'sidebar\.panellist'[\s\S]{0,160}?id:\s*PANEL_ID/.test(clientCode),
);
check("main 的 key 是 PANEL_ID", /name:\s*'main'[\s\S]{0,80}?key:\s*PANEL_ID/.test(clientCode));
check(
  '会话头部席位 id 也是 PANEL_ID',
  /name:\s*'conversation\.session\.header\.utilities'[\s\S]{0,160}?id:\s*PANEL_ID/.test(clientCode),
);

// 运行时交叉核对：以 client.js 真跑出来的 __internals 为准，而不是只看源码文本。
if (clientInternals === null) {
  check(
    '运行时 __internals 可取（否则浏览器侧常量无法交叉核对）',
    false,
    clientLoadError instanceof Error ? clientLoadError.message : String(clientLoadError),
  );
} else {
  check('运行时 __internals.panelId === PANEL_ID', clientInternals.panelId === PANEL_ID, fmt(clientInternals.panelId));
  check('运行时 __internals.configNs === CONFIG_NS', clientInternals.configNs === CONFIG_NS, fmt(clientInternals.configNs));
  check(
    '运行时 __internals.projectionKey === TOKEN_BY_MODEL_KEY',
    clientInternals.projectionKey === TOKEN_BY_MODEL_KEY,
    fmt(clientInternals.projectionKey),
  );
}

/* ------------------------------------------------------------------ */
/* 3. 【重点】两份 formatTokens 逐值一致                                 */
/* ------------------------------------------------------------------ */

section('3. 两份 formatTokens / formatExact 逐值一致');

const hostFold = await import(pathToFileURL(path.join(root, 'lib', 'fold.js')).href);
const hostFormatTokens = hostFold.formatTokens;
const hostFormatExact = hostFold.formatExact;
const clientFormatTokens = clientInternals === null ? undefined : clientInternals.formatTokens;
const clientFormatExact = clientInternals === null ? undefined : clientInternals.formatExact;

/*
 * 负向对照（脚本内自带的「对照组」）：两份实现必须先被真的取到。
 * 如果某一方是 undefined，逐值比对会因为两边都是 undefined 而全部假通过 ——
 * 所以这里先断言「都是函数」，再断言「机制本身能识别差异」。
 */
check('lib/fold.js 导出 formatTokens（函数）', typeof hostFormatTokens === 'function', fmt(hostFormatTokens));
check('client.js __internals.formatTokens 已取到（函数）', typeof clientFormatTokens === 'function', fmt(clientFormatTokens));
check('lib/fold.js 导出 formatExact（函数）', typeof hostFormatExact === 'function', fmt(hostFormatExact));
check('client.js __internals.formatExact 已取到（函数）', typeof clientFormatExact === 'function', fmt(clientFormatExact));
check(
  '比对机制自检：故意不同的实现会被判为不一致',
  sameResult(() => 'X', hostFormatTokens, 1234) === false && sameResult(() => 'X', hostFormatExact, 1234) === false,
);
check('比对机制自检：同一实现与自己比对判为一致', sameResult(hostFormatTokens, hostFormatTokens, 1234) === true);

const TOKEN_CASES = [
  ['0', 0],
  ['1', 1],
  ['999', 999],
  ['1000', 1000],
  ['1023', 1023],
  ['1234', 1234],
  ['9999', 9999],
  ['12345', 12345],
  ['100000', 100000],
  ['123456', 123456],
  ['999999', 999999],
  ['1000000', 1000000],
  ['1234567', 1234567],
  ['12345678', 12345678],
  ['1000000000', 1000000000],
  ['1234567890', 1234567890],
  ['-1（负向边界）', -1],
  ['NaN（非数字边界）', NaN],
  ['Infinity（无穷边界）', Infinity],
];
for (const [label, value] of TOKEN_CASES) {
  const hostValue = safeCall(hostFormatTokens, value);
  const clientValue = safeCall(clientFormatTokens, value);
  check(
    'formatTokens(' + label + ') 两份实现一致',
    sameResult(hostFormatTokens, clientFormatTokens, value),
    '宿主 ' + fmt(hostValue) + ' vs 客户端 ' + fmt(clientValue),
  );
}

const EXACT_CASES = [
  ['0', 0],
  ['999', 999],
  ['1000', 1000],
  ['1234567', 1234567],
];
for (const [label, value] of EXACT_CASES) {
  const hostValue = safeCall(hostFormatExact, value);
  const clientValue = safeCall(clientFormatExact, value);
  check(
    'formatExact(' + label + ') 两份实现一致',
    sameResult(hostFormatExact, clientFormatExact, value),
    '宿主 ' + fmt(hostValue) + ' vs 客户端 ' + fmt(clientValue),
  );
}

// 顺带：浏览器侧同样重复了一份 totalOf，口径也不能漂。
const clientTotalOf = clientInternals === null ? undefined : clientInternals.totalOf;
const TOTAL_CASES = [
  ['四桶齐备', { uncachedInputTokens: 1000, outputTokens: 250, cacheReadTokens: 800, cacheWriteTokens: 40 }],
  ['缺缓存字段', { uncachedInputTokens: 7, outputTokens: 3 }],
  ['含 reasoningTokens（不得计入）', { uncachedInputTokens: 1, outputTokens: 2, reasoningTokens: 999 }],
  ['负数与 NaN 不计', { uncachedInputTokens: -5, outputTokens: NaN, cacheReadTokens: 4 }],
];
for (const [label, buckets] of TOTAL_CASES) {
  check(
    'totalOf(' + label + ') 两份实现一致',
    typeof clientTotalOf === 'function' && clientTotalOf(buckets) === hostFold.totalOf(buckets),
    '宿主 ' + fmt(hostFold.totalOf(buckets)) + ' vs 客户端 ' + fmt(typeof clientTotalOf === 'function' ? clientTotalOf(buckets) : undefined),
  );
}

/* ------------------------------------------------------------------ */
/* 4. 四桶口径与官方一致                                                 */
/* ------------------------------------------------------------------ */

section('4. 四桶口径与官方一致');

const constants = await import(pathToFileURL(constantsFile).href);
const BUCKET_KEYS = constants.BUCKET_KEYS;
const EXPECTED_BUCKETS = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
check(
  'BUCKET_KEYS 恰好是官方四个桶（顺序与内容都要对）',
  Array.isArray(BUCKET_KEYS) && BUCKET_KEYS.join(',') === EXPECTED_BUCKETS.join(','),
  fmt(BUCKET_KEYS),
);
check('BUCKET_KEYS 被冻结（防止运行时被改写）', Object.isFrozen(BUCKET_KEYS));
/*
 * 刻意**不含** reasoningTokens：
 * 它通常是 outputTokens 的子集，单独一列既会和官方 token-meter 的数字对不上，
 * 也容易让人把它再加进总量（重复计数）。所以这里断言它不在桶里。
 */
check('BUCKET_KEYS 里没有 reasoningTokens（它是 outputTokens 的子集，单列会重复计数）', !BUCKET_KEYS.includes('reasoningTokens'));

const twoBuckets = hostFold.bucketsOf({ inputTokens: 1, outputTokens: 2 });
check(
  'bucketsOf({inputTokens:1,outputTokens:2}) 输出恰好四个键（且顺序与 BUCKET_KEYS 一致）',
  twoBuckets !== null && Object.keys(twoBuckets).join(',') === EXPECTED_BUCKETS.join(','),
  fmt(twoBuckets === null ? null : Object.keys(twoBuckets)),
);
check('bucketsOf 的输出不含 reasoningTokens', twoBuckets !== null && !('reasoningTokens' in twoBuckets));

// lib/projection.js import zod：零依赖脚本不能 import，只能静态解析 wire.view 的输出形状。
const projectionCode = stripComments(readText(path.join(root, 'lib', 'projection.js')) ?? '');
const projectionUnitBlock = blockAfter(projectionCode, 'export const tokenByModelUnit =');
const projectionWireBlock = projectionUnitBlock === null ? null : blockAfter(projectionUnitBlock, 'wire:');
const projectionViewBlock = projectionWireBlock === null ? null : blockAfter(projectionWireBlock, 'view:');
check('静态解析出 lib/projection.js 的 wire.view 块', projectionViewBlock !== null);
for (const field of ['rows', 'totals', 'total', 'attempts', 'unattributed']) {
  check('wire.view 输出形状含 ' + field, hasField(projectionViewBlock, field));
}

/* ------------------------------------------------------------------ */
/* 5. 投影单元定义形状（静态解析 lib/projection.js）                      */
/* ------------------------------------------------------------------ */

section('5. 投影单元定义形状（静态解析 lib/projection.js）');

check('projection.js 可读', readText(path.join(root, 'lib', 'projection.js')) !== null);
check('定义导出 tokenByModelUnit', /export const tokenByModelUnit\s*=\s*\{/.test(projectionCode));
check('有 key: TOKEN_BY_MODEL_KEY', /key:\s*TOKEN_BY_MODEL_KEY/.test(projectionCode));
check('有 stateVersion: PROJECTION_STATE_VERSION', /stateVersion:\s*PROJECTION_STATE_VERSION/.test(projectionCode));
check('有 stateSchema', /stateSchema,/.test(projectionCode));
check('有 init', /init:\s*\(\)\s*=>/.test(projectionCode));
check('有 apply', /apply:\s*\(state, event\)\s*=>/.test(projectionCode));
check('有 wire', /wire:\s*\{/.test(projectionCode));
check('wire 里有 viewSchema', projectionWireBlock !== null && /viewSchema,/.test(projectionWireBlock));
check('wire 里有 view', projectionWireBlock !== null && /view:\s*\(/.test(projectionWireBlock));
check('init 返回 emptyFold()（byModel/attempts/unattributed 三字段的来源）', /init:\s*\(\)\s*=>\s*emptyFold\(\)/.test(projectionCode));
check(
  'apply 是纯转发：apply: (state, event) => applyAttempt(state, event)',
  /apply:\s*\(state,\s*event\)\s*=>\s*applyAttempt\(state,\s*event\)/.test(projectionCode),
);
check(
  'projection.js 只从 ./fold.js 与 ./constants.js 取依赖（不自己算数）',
  /import \{[^}]*applyAttempt[^}]*\} from '\.\/fold\.js'/.test(projectionCode)
    && /from '\.\/constants\.js'/.test(projectionCode),
);

/* ------------------------------------------------------------------ */
/* 6. 持久化通道的选择契约                                               */
/* ------------------------------------------------------------------ */

section('6. 持久化通道的选择契约（lib/store.js）');

const storeFile = path.join(root, 'lib', 'store.js');
const storeSource = readText(storeFile);
const storeCode = stripComments(storeSource ?? '');
check('lib/store.js 可读', storeSource !== null, storeFile);

// 三态：editor 优先于 settings，最后才是 read-only。
check("存在 'editor' 态", /'editor'/.test(storeCode));
check("存在 'settings' 态", /'settings'/.test(storeCode));
check("存在 'read-only' 态", /'read-only'/.test(storeCode));
check(
  "mode = canEdit ? 'editor' : (canMutate ? 'settings' : 'read-only')",
  /const mode = canEdit \? 'editor' : \(canMutate \? 'settings' : 'read-only'\);/.test(storeCode),
);
const canEditAt = storeCode.indexOf('const canEdit');
const canMutateAt = storeCode.indexOf('const canMutate');
check(
  'canEdit 的判断先于 canMutate（configEditor 优先）',
  canEditAt >= 0 && canMutateAt >= 0 && canEditAt < canMutateAt,
  'canEdit@' + canEditAt + ' canMutate@' + canMutateAt,
);

check('导出 patchIdOf', /export function patchIdOf\(/.test(storeCode));
check('导出 findEntry', /export function findEntry\(/.test(storeCode));
check('findEntry 同时比对 id 与包名', /if \(id === ns \|\| name === packageName\) return row;/.test(storeCode));
check('createStore 形参是 (ctx, rawConfig, identity) 三参', /export function createStore\(ctx, rawConfig, identity\)/.test(storeCode));

const absorbBlock = blockAfter(storeCode, 'function absorb(row)');
check('absorb 同时合并 inherited 与 override', absorbBlock !== null && /row\.inherited/.test(absorbBlock) && /row\.override/.test(absorbBlock));
check(
  'absorb 的合并顺序是「先 inherited 后 override」（覆盖层优先）',
  absorbBlock !== null && absorbBlock.indexOf('row.inherited') < absorbBlock.indexOf('row.override'),
);

/*
 * persist 被拆成两条通道各自一个函数，再由 persist() 按**成功**回退。
 *
 * 原先的写法是 `if (mode === 'editor') { … ; return false }`——一旦编辑器通道
 * 失败就直接放弃，另一条明明可用的通道从不尝试。所以断言也分两层：
 * 每条通道自己的职责（§6a）与"失败要退到另一条"（§6b）。
 */
const editorPersistBlock = blockAfter(storeCode, 'async function persistViaEditor()');
check(
  'persistViaEditor() 调 editor.edit 且回调接收 (current, inherited)',
  editorPersistBlock !== null && /await editor\.edit\(entry, \(current, inherited\) =>/.test(editorPersistBlock),
);
check(
  'persistViaEditor() 传回的是完整 raw config：显式带 scanLimit',
  editorPersistBlock !== null && /[{,\s]scanLimit,/.test(editorPersistBlock),
);
check(
  'persistViaEditor() 传回的是完整 raw config：显式带 internal',
  editorPersistBlock !== null && /internal:\s*plainClone\(internal\)/.test(editorPersistBlock),
);
check(
  'persistViaEditor() 的 next 也摊开了 inherited 与 override（不丢 bundle/补丁提供的值）',
  editorPersistBlock !== null && /isObject\(inherited\)/.test(editorPersistBlock) && /isObject\(current\)/.test(editorPersistBlock),
);
check(
  'locateEntry 找不到条目时 persistViaEditor 抛错（好让 persist 退到另一条通道）',
  editorPersistBlock !== null && /throw new Error/.test(editorPersistBlock),
);

// locateEntry 必须两个来源都试：configuration() 只保证覆盖 active entries，
// entries() 是更原始的兜底。只依赖其中一个，一旦对方收录口径与假设不符，
// 就会静默找不到条目、整条通道失效。
const locateBlock = blockAfter(storeCode, 'function locateEntry()');
check('locateEntry() 可解析', locateBlock !== null);
check('locateEntry() 先用 configuration()', locateBlock !== null && /editor\.configuration\(\)/.test(locateBlock));
check('locateEntry() 再用 entries() 兜底', locateBlock !== null && /editor\.entries\(\)/.test(locateBlock));
check(
  'locateEntry() 两条来源都按 id 或包名匹配',
  locateBlock !== null && /patchIdOf\(candidate\)/.test(locateBlock) && /identity\.packageName/.test(locateBlock),
);
check('locateEntry() 都不命中时返回 null（而非抛错）', locateBlock !== null && /return null;/.test(locateBlock));

const settingsPersistBlock = blockAfter(storeCode, 'async function persistViaSettings()');
check('persistViaSettings() 调 mutate', settingsPersistBlock !== null && /settings\.mutate\(/.test(settingsPersistBlock));
check(
  'persistViaSettings() 的 ops 覆盖 scanLimit 与 internal 两条路径',
  settingsPersistBlock !== null && /path: \['scanLimit'\]/.test(settingsPersistBlock) && /path: \['internal'\]/.test(settingsPersistBlock),
);

/*
 * `persist` 现在拆成两层：`persistOnce()` 是"两条通道逐个试"的本体，
 * `persist()` 只是把它串成一条链（并发写会互相覆盖，见 store.js 里的说明）。
 * 所以下面这些断言都改成检查本体，另外单加一条守住串行化本身。
 */
const persistBlock = blockAfter(storeCode, 'async function persistOnce()');
check('persistOnce() 函数体可解析', persistBlock !== null);
check(
  'persist() 把写入串行化（并发读-改-写会互相覆盖：先写的可能赢，后写的被丢掉）',
  /let writeTail = Promise\.resolve\(\)/.test(storeCode)
    && /const next = writeTail\.then\(persistOnce, persistOnce\)/.test(storeCode)
    && /writeTail = next\.then\(/.test(storeCode),
);
// 关键不变式：两条通道都在候选列表里，且是"逐个试、失败继续"的循环。
check(
  'persist() 把两条通道都列为候选（不是按可用性二选一）',
  persistBlock !== null && /persistViaEditor/.test(persistBlock) && /persistViaSettings/.test(persistBlock),
);
check(
  'persist() 逐个尝试并在失败时继续（for + try/catch，不在 catch 里 return false）',
  persistBlock !== null && /for \(const \[channel, attempt\] of attempts\)/.test(persistBlock)
    && /catch \(error\) \{[\s\S]{0,160}?lastError/.test(persistBlock)
    && !/catch \(error\) \{[\s\S]{0,160}?return false;[\s\S]{0,40}?\n\s*\}\s*\n\s*return true/.test(persistBlock),
);
check(
  'persist() 两条都失败才返回 false，并给出合并后的失败原因',
  persistBlock !== null && /两条通道都试过/.test(persistBlock) && /return false/.test(persistBlock),
);
check(
  'persist() 记录实际成功的通道（lastChannel，诊断"到底是谁写进去的"）',
  persistBlock !== null && /lastChannel = channel/.test(persistBlock),
);

const takeBlock = blockAfter(storeCode, 'async takeRefreshRequest()');
const clearAt = takeBlock === null ? -1 : takeBlock.indexOf('refreshRequestedAt: undefined');
const returnAt = takeBlock === null ? -1 : takeBlock.indexOf('return requestedAt');
check('takeRefreshRequest() 先清空再返回', clearAt >= 0 && returnAt >= 0 && clearAt < returnAt, '清空@' + clearAt + ' 返回@' + returnAt);
check('takeRefreshRequest() 清空后立即 persist()', takeBlock !== null && takeBlock.indexOf('await persist()') < returnAt && takeBlock.indexOf('await persist()') >= 0);

// index.js 必须传第三个 { ns, packageName } 参数：旧的两参调用要彻底消失。
const indexFile = path.join(root, 'index.js');
const indexSource = readText(indexFile);
const indexCode = stripComments(indexSource ?? '');
const storeArgs = callArgs(indexCode, 'createStore');
check('index.js 里能定位 createStore 调用', storeArgs !== null, fmt(storeArgs));
check(
  'createStore 不是两参调用（必须传第三个 { ns, packageName }）',
  storeArgs !== null && storeArgs.length === 3,
  '实参 ' + (storeArgs === null ? '(找不到)' : storeArgs.length) + ' 个：' + fmt(storeArgs),
);
check(
  'createStore 第三个实参带 ns 与 packageName',
  storeArgs !== null && storeArgs.length === 3 && /\bns:/.test(storeArgs[2]) && /packageName:/.test(storeArgs[2]),
  storeArgs === null ? undefined : fmt(storeArgs[2]),
);
check(
  'packageName 就是本包名（不是硬编码的旧名字）',
  storeArgs !== null && storeArgs.length === 3 && storeArgs[2].includes("'" + pkg?.name + "'"),
  storeArgs === null ? undefined : fmt(storeArgs[2]),
);

// —— 真调用：patchIdOf / findEntry 是纯函数，零依赖下可直接跑 ——
const store = await import(pathToFileURL(storeFile).href);
const identity = { ns: CONFIG_NS, packageName: 'dsh-plugin-token-usage' };

check("patchIdOf 取 patchId", store.patchIdOf({ patchId: 'a' }) === 'a');
check('patchIdOf 取 options.id', store.patchIdOf({ options: { id: 'b' } }) === 'b');
check('patchIdOf 取 id', store.patchIdOf({ id: 'c' }) === 'c');
check('patchIdOf 取 options.name', store.patchIdOf({ options: { name: 'd' } }) === 'd');
check('patchIdOf 取 name', store.patchIdOf({ name: 'e' }) === 'e');
check('patchIdOf 对非对象返回 undefined', store.patchIdOf(null) === undefined && store.patchIdOf({}) === undefined);

const rowById = { entry: { patchId: CONFIG_NS, options: { name: 'other-pkg' } }, inherited: {}, override: {} };
const rowByName = { entry: { patchId: 'other-id', options: { name: identity.packageName } }, inherited: {}, override: {} };
const rowOther = { entry: { patchId: 'other-id', options: { name: 'other-pkg' } }, inherited: {}, override: {} };
check('findEntry 按 id 命中', store.findEntry([rowOther, rowById], identity) === rowById);
check('findEntry 按包名命中（行 id 被改也不失联）', store.findEntry([rowOther, rowByName], identity) === rowByName);
check('findEntry 都不匹配时返回 undefined', store.findEntry([rowOther], identity) === undefined);
check('findEntry 对非数组返回 undefined', store.findEntry(null, identity) === undefined);
check('findEntry 跳过 entry 不是对象的行', store.findEntry([{ entry: null }, rowById], identity) === rowById);

// —— 真调用：三态选择 + 优先级 ——
const editorStub = { edit() {}, configuration() { return []; } };
const settingsStub = { mutate() {}, describe() {} };
const storeOf = (services, config = {}) => store.createStore({ get: (name) => services[name] }, config, identity);
check('无任何服务 → read-only', storeOf({}).mode === 'read-only', storeOf({}).mode);
check('只有 settings → settings 态', storeOf({ settings: settingsStub }).mode === 'settings', storeOf({ settings: settingsStub }).mode);
check('只有 configEditor → editor 态', storeOf({ configEditor: editorStub }).mode === 'editor', storeOf({ configEditor: editorStub }).mode);
check(
  '两个都在 → 优先 configEditor（editor 态）',
  storeOf({ configEditor: editorStub, settings: settingsStub }).mode === 'editor',
  storeOf({ configEditor: editorStub, settings: settingsStub }).mode,
);
check('read-only 时 isPersistent() 为 false', storeOf({}).isPersistent() === false);
check('editor 时 isPersistent() 为 true', storeOf({ configEditor: editorStub }).isPersistent() === true);

// —— 真调用：configEditor 失败时必须退到 settings ——
//
// 这是"按成功回退"的核心保证。原先的写法按**可用性**二选一：只要 configEditor
// 存在就走它，一旦它失败就直接放弃，另一条明明可用的通道从不尝试。
{
  const fallbackMutations = [];
  const failingEditor = {
    configuration: () => [{
      entry: { patchId: CONFIG_NS, options: { name: identity.packageName } },
      inherited: {},
      override: {},
    }],
    edit: async () => { throw new Error('loader busy'); },
  };
  const fallbackSettings = {
    describe: async () => [],
    mutate: async (ns, ops) => { fallbackMutations.push({ ns, ops }); },
  };
  const fallbackStore = store.createStore(
    { get: (name) => ({ configEditor: failingEditor, settings: fallbackSettings })[name] },
    { internal: {} },
    identity,
  );
  const wrote = await fallbackStore.setSummary({ rows: [], scanned: 2, total: 2, truncated: false, skipped: 0, builtAt: 55 });
  check('configEditor 抛错时 persist 仍成功（退到 settings）', wrote === true, String(wrote));
  check('回退后 settings.mutate 确实被调用', fallbackMutations.length === 1, '实际 ' + fallbackMutations.length);
  check('回退写入用 identity.ns 寻址', fallbackMutations[0]?.ns === CONFIG_NS, fmt(fallbackMutations[0]?.ns));
  check('lastChannel 报告实际成功的通道是 settings', fallbackStore.lastChannel() === 'settings', fmt(fallbackStore.lastChannel()));
}

// —— 两条都失败时才真的失败 ——
{
  const deadEditor = {
    configuration: () => [{
      entry: { patchId: CONFIG_NS, options: { name: identity.packageName } },
      inherited: {},
      override: {},
    }],
    edit: async () => { throw new Error('editor dead'); },
  };
  const deadSettings = {
    describe: async () => [],
    mutate: async () => { throw new Error('settings dead'); },
  };
  const deadStore = store.createStore(
    { get: (name) => ({ configEditor: deadEditor, settings: deadSettings })[name] },
    { internal: {} },
    identity,
  );
  const wrote = await deadStore.setSummary({ rows: [], scanned: 0, total: 0, truncated: false, skipped: 0, builtAt: 1 });
  check('两条通道都失败时 setSummary 返回 false（不谎报成功）', wrote === false, String(wrote));
  check('两条都失败时 lastChannel 仍是 null', deadStore.lastChannel() === null, fmt(deadStore.lastChannel()));
}

// —— 真调用：refresh/persist 走 editor 通道，且写回完整 raw config ——
const edits = [];
const configurations = [{
  entry: { patchId: CONFIG_NS, options: { name: identity.packageName } },
  inherited: { scanLimit: 200, internal: { summary: null, keptFromBundle: 'yes' } },
  override: { scanLimit: 50 },
}];
const editorChannel = {
  configuration: () => configurations,
  edit: async (entry, change) => { edits.push({ entry, next: change() }); },
};
const editorStore = store.createStore({ get: (name) => (name === 'configEditor' ? editorChannel : undefined) }, { internal: {} }, identity);
await editorStore.refresh();
check('absorb 采纳 override 的 scanLimit', editorStore.getScanLimit() === 50, String(editorStore.getScanLimit()));
await editorStore.setSummary({ rows: [], scanned: 1, total: 1, truncated: false, skipped: 0, builtAt: 123 });
check('editor 通道被调用一次 editor.edit', edits.length === 1, '实际 ' + edits.length);
const written = edits[0]?.next;
check('写回值含 scanLimit（完整 raw config，不是增量）', written !== undefined && Object.prototype.hasOwnProperty.call(written, 'scanLimit'), fmt(written));
check('写回值含 internal（完整 raw config，不是增量）', written !== undefined && Object.prototype.hasOwnProperty.call(written, 'internal'), fmt(written));
check(
  '写回值保留了 inherited 里 bundle 提供的字段（只读 override 不会丢值）',
  written !== undefined && written.internal?.keptFromBundle === 'yes',
  fmt(written === undefined ? undefined : written.internal),
);
check('写回值带上了本次 summary', written !== undefined && written.internal?.summary?.builtAt === 123, fmt(written === undefined ? undefined : written.internal?.summary));
check(
  '写回值的顶层键恰好是 scanLimit 与 internal',
  written !== undefined && Object.keys(written).sort().join(',') === 'internal,scanLimit',
  written === undefined ? undefined : fmt(Object.keys(written)),
);

// —— 真调用：只有 settings 时的后备通道，ops 形状 ——
const mutations = [];
const settingsOnly = {
  configEditor: undefined,
  settings: {
    describe: async () => [],
    mutate: async (ns, ops, revision) => { mutations.push({ ns, ops, revision }); },
  },
};
const settingsStore = store.createStore({ get: (name) => settingsOnly[name] }, { internal: {} }, identity);
await settingsStore.setSummary({ rows: [], scanned: 0, total: 0, truncated: false, skipped: 0, builtAt: 7 });
check('settings 通道写入一次 mutate', mutations.length === 1, '实际 ' + mutations.length);
check('mutate 用 identity.ns 寻址', mutations[0]?.ns === CONFIG_NS, fmt(mutations[0]?.ns));
check(
  'mutate 的 ops 覆盖 scanLimit 与 internal 两条路径',
  mutations[0]?.ops?.map((op) => op.path.join('.')).join(',') === 'scanLimit,internal',
  fmt(mutations[0]?.ops?.map((op) => op.path.join('.'))),
);

// —— 真调用：takeRefreshRequest 先清空再返回 ——
const refreshStore = store.createStore({ get: () => undefined }, { internal: { refreshRequestedAt: 1712345678901 } }, identity);
check('read-only 下仍能读到待刷新的时间戳', refreshStore.getRefreshRequestedAt() === 1712345678901, fmt(refreshStore.getRefreshRequestedAt()));
const taken = await refreshStore.takeRefreshRequest();
check('takeRefreshRequest 返回上一个时间戳', taken === 1712345678901, fmt(taken));
check('takeRefreshRequest 返回后内部值已清空（第二次为空）', refreshStore.getRefreshRequestedAt() === null, fmt(refreshStore.getRefreshRequestedAt()));
check('再次 takeRefreshRequest 返回 null（不会重复扫描）', (await refreshStore.takeRefreshRequest()) === null);

/* ------------------------------------------------------------------ */
/* 7. 宿主侧的装配形状                                                   */
/* ------------------------------------------------------------------ */

section('7. 宿主侧的装配形状（index.js）');

check('index.js 可读', indexSource !== null, indexFile);
const injectMatch = /export const inject = \[([^\]]*)\]/.exec(indexCode);
const injectList = injectMatch === null
  ? []
  : [...injectMatch[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((match) => match[1] ?? match[2]);
check("export const inject = ['settings']（settings 是硬依赖）", injectList.length === 1 && injectList[0] === 'settings', fmt(injectList));
check(
  'sessionProjections 不在硬 inject（它是可选服务）',
  !injectList.includes('sessionProjections') && !/export const inject = \[[^\]]*sessionProjections/.test(indexCode),
  fmt(injectList),
);
check("Config 从 './lib/config.js' 引入", /import \{ Config \} from '\.\/lib\/config\.js'/.test(indexCode));
check('export { Config } 再导出', /export \{ Config \}/.test(indexCode));
check('导出 apply 函数', /export function apply\(ctx, rawConfig\)/.test(indexCode));

check('有 applied WeakSet 幂等保护', /const applied = new WeakSet\(\)/.test(indexCode));
check('apply 开头即查 applied.has(ctx)', /applied\.has\(ctx\)/.test(indexCode));
check('命中幂等保护后直接 return（同一 ctx 不再装配第二套定时器）', /if \(applied\.has\(ctx\)\) \{[\s\S]{0,240}?return/.test(indexCode));
check('装配前 applied.add(ctx)', /applied\.add\(ctx\)/.test(indexCode));

check("用 ctx.inject(['sessionProjections'], ...) 注册投影", /ctx\.inject\(\['sessionProjections'\]/.test(indexCode));
const injectBlock = blockAfter(indexCode, "ctx.inject(['sessionProjections']");
check('投影注册整体包在 try/catch 里（注册失败只降级）', injectBlock !== null && /try \{/.test(injectBlock) && /catch \(error\)/.test(injectBlock));
check('catch 里 warn 而不是 throw', injectBlock !== null && /catch \(error\) \{[\s\S]*?warn\(/.test(injectBlock) && !/\bthrow\b/.test(injectBlock));
check('注册失败时给出可诊断的 warn 文案', injectBlock !== null && /注册 tokenByModel 投影失败/.test(injectBlock));

check('用 setInterval 起后台轮询', /const timer = setInterval\(/.test(indexCode));
/*
 * 断言原先写的是"定时器必须 unref()（不阻止进程退出）"。**这条被真机推翻了**：
 * 5 分钟里心跳 0 次，而 `unref()` 恰好能让定时器在事件循环上没有其它引用时不触发。
 * 一个负责定期续期数据的定时器就应当自己维持进程存活——把"不阻止退出"当成理由，
 * 代价是它可能永远不跑。所以规则反过来：**禁止 unref**。
 */
check(
  '定时器**不得** unref()（真机上 unref 的定时器 5 分钟 0 次触发）',
  !/timer\.unref\(\)/.test(indexCode) && !/\.unref\(\)/.test(indexCode),
);
check('定时器创建时留里程碑（区分"没建"与"建了没触发"）', /trace\('timer:created'\)/.test(indexCode));
check('定时器每次触发都留里程碑与心跳', /trace\('timer:tick:' \+ tickCount\)/.test(indexCode) && /setHeartbeat\(tickCount, Date\.now\(\)\)/.test(indexCode));
check('定时器清理（clearInterval）登记进 cleanups', /cleanups\.push\(\(\) => clearInterval\(timer\)\)/.test(indexCode));
check('有用 ctx.effect 注册生命周期（>= 2 处）', (indexCode.match(/ctx\.effect\(/g) ?? []).length >= 2, '实际 ' + (indexCode.match(/ctx\.effect\(/g) ?? []).length);
check(
  '启动流程（refresh + sweep）在 ctx.effect 内',
  /ctx\.effect\(\(\) => \{[\s\S]{0,400}?store\.refresh\(\)[\s\S]{0,200}?sweep\(\)/.test(indexCode),
);
check(
  'teardown 在 ctx.effect 内倒序执行并清空 cleanups（所有资源的收尾点）',
  /ctx\.effect\(\(\) => \(\) => \{[\s\S]*?cleanups\[index\]\(\);[\s\S]*?cleanups\.length = 0;/.test(indexCode),
);
check('teardown effect 带标签', /'token-usage: teardown'/.test(indexCode));

check('导出测试接缝 tokenByModelUnit', /export \{ tokenByModelUnit \}/.test(indexCode));
check("导出测试接缝 fold（export * as fold from './lib/fold.js'）", /export \* as fold from '\.\/lib\/fold\.js'/.test(indexCode));

/* ------------------------------------------------------------------ */
/* 8. lib/config.js 的 volatile 硬规则                                   */
/* ------------------------------------------------------------------ */

section('8. lib/config.js 的 volatile 硬规则（静态解析）');

const configSource = readText(path.join(root, 'lib', 'config.js'));
const configCode = stripComments(configSource ?? '');
check('lib/config.js 可读', configSource !== null, path.join(root, 'lib', 'config.js'));
check("使用 schemastery（import Schema from '@deepseek-ai/schemastery'）", /import Schema from '@deepseek-ai\/schemastery'/.test(configCode));
check('导出 Config', /export const Config = Schema\.object\(\{/.test(configCode));

/*
 * 硬规则：settings 的 describe() 只投影 .volatile() 节点，mutate() 在没有 volatile
 * 字段时直接抛 `has no volatile fields`。本插件所有要读回界面的数据都住在 internal 下，
 * 所以 internal 必须整个标 volatile。
 */
check('internal 节点带 .volatile()', /internal:\s*Schema\.object\(\{[\s\S]*?\}\)\.volatile\(\)/.test(configCode));
const internalBlock = blockAfter(configCode, 'internal: Schema.object(');
check('静态解析出 internal 块', internalBlock !== null);
for (const field of ['summary', 'refreshRequestedAt', 'lastSweep']) {
  check('internal 下有 ' + field + ' 字段', internalBlock !== null && new RegExp('\\b' + field + '\\s*:').test(internalBlock));
}
check('顶层有 scanLimit 且默认 200', /scanLimit:\s*Schema\.number\(\)\.default\(200\)/.test(configCode));

/*
 * summary 的每个字段都必须在 Config 里声明。
 *
 * 真机教训：`buildSummary()` 返回 `skipped`，但 `summarySchema` 当初没声明它。
 * schemastery 对未声明字段要么剥离要么拒绝——两者都坏：前者让界面丢字段，
 * 后者让整次落盘失败。这个错配一直没暴露，因为真机上只写过 lastSweep、
 * 从没成功写过 summary。
 */
{
  // 不能用 blockAfter：对象字面量嵌在 `Schema.object({ … })` 的括号里，
  // 而 blockAfter 只接受 `parens <= 0` 处的 `{`，会跳过它。
  const grab = (name) => {
    const m = new RegExp('const ' + name + " = Schema\\.object\\(\\{([\\s\\S]*?)\\n\\}\\);").exec(configCode);
    return m === null ? null : m[1];
  };
  const summarySchemaBlock = grab('summarySchema');
  const bucketSchemaBlock = grab('bucketSchema');
  const returnedFields = ['rows', 'timeline', 'scanned', 'total', 'truncated', 'skipped', 'builtAt', 'source'];
  const undeclared = returnedFields.filter(
    (field) => summarySchemaBlock === null || !new RegExp('\\b' + field + '\\s*:').test(summarySchemaBlock),
  );
  check('summarySchema 声明了 buildSummary 返回的全部字段', undeclared.length === 0, '缺: ' + undeclared.join(', '));
  check(
    '每行的 buckets 四个桶都在 bucketSchema 里（否则落盘时会丢）',
    bucketSchemaBlock !== null
      && ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].every(
        (key) => new RegExp('\\b' + key + '\\s*:').test(bucketSchemaBlock),
      ),
    bucketSchemaBlock === null ? '没找到 bucketSchema' : bucketSchemaBlock.trim().slice(0, 60),
  );
}

/* ------------------------------------------------------------------ */
/* 9. 扫描的诚实性契约                                                   */
/* ------------------------------------------------------------------ */

section('9. 扫描的诚实性契约（lib/summary.js）');

const summaryFile = path.join(root, 'lib', 'summary.js');
const summarySource = readText(summaryFile);
const summaryCode = stripComments(summarySource ?? '');
check('lib/summary.js 可读', summarySource !== null, summaryFile);

const buildBlock = blockAfter(summaryCode, 'export async function buildSummary(probe, options = {})');
check('静态解析出 buildSummary 函数体', buildBlock !== null);
for (const field of ['rows', 'scanned', 'total', 'truncated', 'skipped', 'builtAt']) {
  check('buildSummary 返回含 ' + field, hasField(buildBlock, field));
}
check(
  '按创建时间从新到旧排序：createdAtOf(right) - createdAtOf(left)',
  /createdAtOf\(right\) - createdAtOf\(left\)/.test(summaryCode),
);
check('有 scanLimit 截断（slice(0, limit)）', /ordered\.slice\(0, limit\)/.test(summaryCode));
check('truncated = ordered.length > window.length（如实报告被截断）', /truncated:\s*ordered\.length > window\.length/.test(summaryCode));
// 注意：`buildSummary` 在**来源不可用**时确实会 throw（那是守卫，不是失败）。
// 这里要断言的是「单个会话读失败不许毁掉整次扫描」，所以只看那个 catch 块。
{
  const readCatch = /catch \{([\s\S]{0,200}?)\}/.exec(summaryCode);
  check(
    '单个会话读失败的 catch 里只 skipped += 1、不重新抛出',
    /skipped \+= 1/.test(summaryCode) && readCatch !== null && !/throw/.test(readCatch[1]),
    readCatch === null ? '没找到 catch 块' : readCatch[1].trim().slice(0, 60),
  );
}
check(
  'probeSessionSource 对缺失来源返回 { available: false, reason }',
  /return \{ available: false, reason:/.test(summaryCode),
);

/*
 * 双来源契约（真机教训）。
 *
 * 实测 `ctx.get('sessionQuery')` 在本 profile 返回 undefined —— 它是需要一个
 * 后端实现的抽象，没有后端时不存在。而 `ctx.sessionPersistence` 是真实挂载的。
 * 只认其中一个的写法会让跨会话页面在那个 profile 上永远空着，且不报错。
 */
check('定义了来源适配表 ADAPTERS', /export const ADAPTERS = \{/.test(summaryCode));
check('适配表含 query 与 persistence 两个来源', /\bquery:\s*\{/.test(summaryCode) && /\bpersistence:\s*\{/.test(summaryCode));
{
  // marker 不能带结尾的 `{`：blockAfter 找的是 marker 之后的第一个 `{`，
  // 否则它会把内层 `query: {` 当成对象体，只看到一半。
  const adaptersBlock = blockAfter(summaryCode, 'export const ADAPTERS =');
  const hasCount = (adaptersBlock?.match(/has\(source\)/g) ?? []).length;
  check('每个来源自带能力探测 has(source)', hasCount === 2, '实际 ' + hasCount);
}
/*
 * 这些断言原先匹配的是裸 await（`await source.list()`）。现在每次调用都包了
 * `withTimeout(...)`，所以模式跟着改——**语义没变**（仍然调同一个 API），
 * 变的是"它有界"。顺带新增一条：**每个来源调用都必须过 withTimeout**，
 * 因为无界的 await 会永久卡住 runScan 的 scanning 闩锁，之后所有扫描静默停摆。
 */
check('persistence 用 list() 枚举', /withTimeout\(source\.list\(\),/.test(summaryCode));
check('persistence 用 open(id, \'read\') 打开', /withTimeout\(source\.open\(id, 'read'\),/.test(summaryCode));
check('persistence 读取后必须 close 归还句柄（否则反复扫描会攒句柄）', /finally \{[\s\S]{0,260}?handle\.close\(\)/.test(summaryCode));
check('query 用 listSessions()/readSession()', /withTimeout\(source\.listSessions\(\),/.test(summaryCode) && /withTimeout\(source\.readSession\(id\),/.test(summaryCode));
check(
  '每一个来源调用都有超时（无界的 await 会永久卡住扫描闩锁，之后所有扫描静默停摆）',
  [
    /withTimeout\(source\.list\(\),/,
    /withTimeout\(source\.open\(id, 'read'\),/,
    /withTimeout\(handle\.read\(\),/,
    /withTimeout\(source\.listSessions\(\),/,
    /withTimeout\(source\.readSession\(id\),/,
  ].every((pattern) => pattern.test(summaryCode))
    // 裸 await 一个来源方法 = 遗漏了超时。
    && !/await source\.(list|open|listSessions|readSession)\(/.test(summaryCode)
    && !/await handle\.read\(\)/.test(summaryCode),
);
check('close 也加了超时（一个卡住的 close 同样能拖死整轮扫描）', /withTimeout\(handle\.close\(\),/.test(summaryCode));
check('probeSessionSource 逐个试来源并返回先可用的那个', /for \(const \[kind, adapter\] of Object\.entries\(ADAPTERS\)\)/.test(summaryCode));
check('都不行时 reason 列出试过哪些来源（便于诊断）', /试过 \$\{tried\.join/.test(summaryCode));
check('summary 带 source 字段（记录实际用了哪个来源）', /source:\s*adapter\.label/.test(summaryCode));

// —— 真调用：summary.js 零依赖，行为可以直接验 ——
const summary = await import(pathToFileURL(summaryFile).href);

check('probeSessionSource 对空 ctx 返回 unavailable', summary.probeSessionSource({}).available === false);
check('probeSessionSource 的 reason 是非空字符串', typeof summary.probeSessionSource({}).reason === 'string' && summary.probeSessionSource({}).reason.length > 0);
check(
  'probeSessionSource 对缺方法的服务不误认（只有 list、没有 open）',
  summary.probeSessionSource({ get: () => ({ sessionPersistence: { list() {} } }) }).available === false,
);
const realQuery = { listSessions() {}, readSession() {} };
const realPersistence = { list() {}, open() {} };
check('probeSessionSource 只有 query 时用它', (() => {
  const probe = summary.probeSessionSource({ get: (name) => (name === 'sessionQuery' ? realQuery : undefined) });
  return probe.available === true && probe.kind === 'query' && probe.source === realQuery;
})());
check('probeSessionSource 只有 persistence 时用它（真机就是这个情形）', (() => {
  const probe = summary.probeSessionSource({ get: (name) => (name === 'sessionPersistence' ? realPersistence : undefined) });
  return probe.available === true && probe.kind === 'persistence' && probe.source === realPersistence;
})());
check('probeSessionSource 两个都在时优先 query', (() => {
  const probe = summary.probeSessionSource({ get: (name) => (name === 'sessionQuery' ? realQuery : realPersistence) });
  return probe.available === true && probe.kind === 'query';
})());

const sessionList = [
  { header: { id: 'old', createdAt: 100 } },
  { header: { id: 'new', createdAt: 300 } },
  { header: { id: 'mid', createdAt: 200 } },
];
const readOrder = [];
const eventsFor = (id) => [{
  type: 'assistant/message',
  data: {
    message: { role: 'assistant', source: { kind: 'model', provider: 'p', model: id } },
    usage: { inputTokens: 10, outputTokens: 5 },
  },
}];
const queryStub = {
  listSessions: async () => sessionList,
  readSession: async (id) => {
    readOrder.push(id);
    if (id === 'mid') throw new Error('坏日志');
    return { events: eventsFor(id) };
  },
};
const queryProbe = { available: true, kind: 'query', label: 'sessionQuery', source: queryStub };

const limited = await summary.buildSummary(queryProbe, { limit: 2 });
check('按新→旧取窗口（先读最新两个）', readOrder.join(',') === 'new,mid', readOrder.join(','));
check('scanned = 窗口内会话数', limited.scanned === 2, fmt(limited.scanned));
check('total = 全部候选会话数', limited.total === 3, fmt(limited.total));
check('truncated = true（被 scanLimit 截断时如实报告）', limited.truncated === true, fmt(limited.truncated));
check('坏日志只让 skipped +1，扫描继续', limited.skipped === 1, fmt(limited.skipped));
check('好会话照样折叠出用量', limited.rows.length === 1 && limited.rows[0].key === 'p/new' && limited.rows[0].total === 15, fmt(limited.rows));
check('builtAt 是数字时间戳', Number.isFinite(limited.builtAt), fmt(limited.builtAt));
check('summary.source 记录了实际来源', limited.source === 'sessionQuery', fmt(limited.source));

const full = await summary.buildSummary(queryProbe, { limit: 10 });
check('未截断时 truncated = false', full.truncated === false, fmt(full.truncated));
check('未截断时 scanned = total = 3', full.scanned === 3 && full.total === 3, fmt([full.scanned, full.total]));
check('limit 非法时回落到默认值（不返回空表）', (await summary.buildSummary(queryProbe, { limit: -1 })).scanned === 3);

// —— persistence 通道必须产出与 query 通道相同的汇总 ——
{
  const persistenceOrder = [];
  const closed = [];
  let handlesOpened = 0;
  const persistenceStub = {
    list: async () => sessionList,
    open: async (id) => {
      persistenceOrder.push(id);
      // `mid` 的 open 本身抛错 —— 它根本没产出句柄，所以没有句柄需要归还。
      if (id === 'mid') throw new Error('坏日志');
      handlesOpened += 1;
      return {
        read: async () => ({ events: eventsFor(id) }),
        close: async () => { closed.push(id); },
      };
    },
  };
  const persistenceProbe = { available: true, kind: 'persistence', label: 'sessionPersistence', source: persistenceStub };
  const viaPersistence = await summary.buildSummary(persistenceProbe, { limit: 10 });
  // 允许范围内：new 与 old 成功（各自一行），mid 失败被跳过。
  check('persistence 通道折叠出与 query 通道相同的行数与 key',
    viaPersistence.rows.length === full.rows.length
      && viaPersistence.rows.map((row) => row.key).join(',') === full.rows.map((row) => row.key).join(','),
    fmt([viaPersistence.rows.map((r) => r.key), full.rows.map((r) => r.key)]));
  check('persistence 通道 total 与 query 通道一致', viaPersistence.total === full.total, fmt([viaPersistence.total, full.total]));
  check('persistence 通道也按新→旧扫描', persistenceOrder.join(',') === 'new,mid,old', persistenceOrder.join(','));
  check('persistence 通道坏日志同样只 skipped +1', viaPersistence.skipped === 1, fmt(viaPersistence.skipped));
  check('persistence 通道 source 记的是 sessionPersistence', viaPersistence.source === 'sessionPersistence', fmt(viaPersistence.source));
  check('每个成功打开的句柄都被 close 归还（一个不漏）', closed.length === handlesOpened && handlesOpened === 2, closed.length + '/' + handlesOpened);
  check('open 直接失败时没有句柄可归还，不误记 close', !closed.includes('mid'), fmt(closed));
}

check('probe 不可用时 buildSummary 抛错而不是返回空表', await (async () => {
  try {
    await summary.buildSummary({ available: false, reason: 'nope' }, {});
    return false;
  } catch (error) {
    return String(error.message).includes('nope');
  }
})());

/* ------------------------------------------------------------------ */
/* 10. 文案键只在客户端                                                  */
/* ------------------------------------------------------------------ */

section('10. 文案键只在客户端');

const zhBlock = /const zh = \{([\s\S]*?)\n {4}\};/.exec(clientSource ?? '');
const enBlock = /const en = \{([\s\S]*?)\n {4}\};/.exec(clientSource ?? '');
check('能定位 client.js 内联的 zh 文案表', zhBlock !== null);
check('能定位 client.js 内联的 en 文案表', enBlock !== null);
const zhKeys = new Set([...(zhBlock === null ? '' : zhBlock[1]).matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1]));
const enKeys = new Set([...(enBlock === null ? '' : enBlock[1]).matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1]));
const onlyZh = [...zhKeys].filter((key) => !enKeys.has(key)).sort();
const onlyEn = [...enKeys].filter((key) => !zhKeys.has(key)).sort();
check('client.js 的 zh 键集合非空', zhKeys.size > 0, '实际 ' + zhKeys.size);
check('zh 与 en 键集合完全一致（互相不缺不多）', zhKeys.size > 0 && onlyZh.length === 0 && onlyEn.length === 0, 'zh 独有 [' + onlyZh.join(', ') + '] en 独有 [' + onlyEn.join(', ') + ']');

const clientLocaleNs = pickClientConst('LOCALE_NS');
check("client.js 出现 const LOCALE_NS = 'plugin.token-usage'", clientLocaleNs === 'plugin.token-usage', fmt(clientLocaleNs));
check('LOCALE_NS 走 plugin.* 前缀（不占宿主命名空间）', typeof clientLocaleNs === 'string' && clientLocaleNs.startsWith('plugin.'));
check(
  'LOCALE_NS 与行 id / CONFIG_NS / PANEL_ID 都不同（命名空间不冲突）',
  clientLocaleNs !== CONFIG_NS && clientLocaleNs !== PANEL_ID && clientLocaleNs !== pkg?.name,
  fmt([clientLocaleNs, CONFIG_NS, PANEL_ID, pkg?.name]),
);
check(
  'client.js 用 ctx.locale.register(LOCALE_NS, { zh, en }) 注册内联文案',
  /ctx\.locale\.register\(LOCALE_NS, \{ zh, en \}\)/.test(clientCode),
);
check(
  '会话头部席位声明 locale: LOCALE_NS（宿主据此取文案）',
  /locale:\s*LOCALE_NS/.test(clientCode),
);

// 内联键只在 client.js：locale/*.json 是可嵌套的宿主文案，两者键空间不得混用。
const zhJson = readJson(path.join(root, 'locale', 'zh.json'));
const enJson = readJson(path.join(root, 'locale', 'en.json'));
check('locale/zh.json 可解析', zhJson !== null);
check('locale/en.json 可解析', enJson !== null);
function flattenKeys(value, prefix, out) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    out.add(prefix);
    return out;
  }
  for (const key of Object.keys(value)) flattenKeys(value[key], prefix === '' ? key : prefix + '.' + key, out);
  return out;
}
const localePaths = new Set([...flattenKeys(zhJson, '', new Set()), ...flattenKeys(enJson, '', new Set())]);
const collided = [...zhKeys].filter((key) => localePaths.has(key)).sort();
check(
  '内联文案键不是 locale/*.json 的路径（两套键空间不重叠）',
  collided.length === 0,
  collided.join(', '),
);

/* ------------------------------------------------------------------ */
section('11. 跨两侧的端到端契约：宿主写出的形状，浏览器侧必须读得出来');
/* ------------------------------------------------------------------ */

/*
 * 这是本脚本里唯一真正跨两侧的断言，也是最有价值的一条。
 *
 * 数据流是：宿主折叠 → 写进插件配置的 `internal.summary` → settings 服务把它
 * 投影给客户端 → 浏览器侧用 readSummary() 取回。中间任何一处嵌套层级、字段名
 * 或大小写不一致，界面上都只是"没有数据"，不会报错——这是最难查的一类契约漂移。
 *
 * 做法：用**宿主真实的 store** 写一次（编辑器桩捕获它实际提交的完整 raw config），
 * 再把那份 config 按 settings.describe() 的返回形状包起来，交给**浏览器侧真实的**
 * readSummary/normaliseRows 去读，比对两端得到同一组数字。
 */
if (clientInternals !== null && typeof clientInternals.readSummary === 'function') {
  // 用真实的折叠输出，而不是手搓的行——这样字段名漂移也会被抓到。
  const liveState = hostFold.foldEvents([
    { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model', provider: 'stepfun', model: 'step-5-preview' } }, stream: [], usage: { inputTokens: 900, outputTokens: 100, cacheReadTokens: 50 } } },
    { type: 'assistant/message', data: { turn: 1, step: 2, message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' } }, stream: [], usage: { inputTokens: 100, outputTokens: 20 } } },
  ]);
  const hostRows = hostFold.rowsOf(liveState);
  const summary = {
    rows: hostRows,
    scanned: 7,
    total: 9,
    truncated: true,
    skipped: 1,
    builtAt: 1_700_000_000_000,
  };

  const captured = [];
  const captureEditor = {
    configuration: () => [{
      entry: { patchId: CONFIG_NS, options: { name: identity.packageName } },
      inherited: { scanLimit: 200, internal: {} },
      override: {},
    }],
    edit: async (entry, change) => { captured.push(change({}, { scanLimit: 200, internal: {} })); },
  };
  const hostStore = store.createStore(
    { get: (name) => (name === 'configEditor' ? captureEditor : undefined) },
    { internal: {} },
    identity,
  );
  const wrote = await hostStore.setSummary(summary);
  check('宿主侧 setSummary 成功（编辑器通道）', wrote === true, String(wrote));
  check('捕获到一次完整 raw config 提交', captured.length === 1, '实际 ' + captured.length);

  const submitted = captured[0] ?? {};
  /*
   * `describe()` 返回的是**信封**，不是数组：
   *   { ok: true, value: { revision, writable, namespaces: [...] } }
   * 条目在 `value.namespaces` 里，`internal` 在条目的 `value` 层。
   *
   * 这里最初写成裸数组 `[{ ns, value }]`，于是**客户端实现和这条测试一起**
   * 建立在错误假设上：真机上页面永远空（`Array.isArray` 判否直接返回 null），
   * 而这条测试却"通过"了。现在按真机形状来测，形状写错它就会红。
   */
  const describeShape = {
    ok: true,
    value: {
      revision: 1,
      writable: true,
      namespaces: [{ ns: CONFIG_NS, revision: 1, value: submitted }],
    },
  };
  const readBack = clientInternals.readSummary(describeShape);
  check('浏览器侧从宿主写出的 config 里读到了 summary', readBack.summary !== null, fmt(readBack.summary));
  check('浏览器侧报告该 profile 可持久化', readBack.persistent === true);
  check('读回的 scanned/total/truncated 与写入一致',
    readBack.summary?.scanned === 7 && readBack.summary?.total === 9 && readBack.summary?.truncated === true,
    fmt(readBack.summary));
  check('读回的 builtAt 与写入一致', readBack.summary?.builtAt === summary.builtAt, fmt(readBack.summary?.builtAt));

  const clientRows = clientInternals.normaliseRows(readBack.summary);
  check('浏览器侧归一出的行数与宿主一致', clientRows.length === hostRows.length, clientRows.length + ' vs ' + hostRows.length);
  check('浏览器侧归一出的顺序与宿主一致（都是按总量降序）',
    clientRows.map((row) => row.key).join(',') === hostRows.map((row) => row.key).join(','),
    clientRows.map((row) => row.key).join(','));
  check('两端算出的每行 total 完全一致',
    JSON.stringify(clientRows.map((row) => row.total)) === JSON.stringify(hostRows.map((row) => row.total)),
    JSON.stringify(clientRows.map((row) => row.total)));
  check('两端算出的桶值完全一致',
    JSON.stringify(clientRows.map((row) => row.buckets)) === JSON.stringify(hostRows.map((row) => row.buckets)));

  // 负向对照 1：summary 放错层级。
  const misplaced = {
    ok: true,
    value: { revision: 1, namespaces: [{ ns: CONFIG_NS, revision: 1, value: { summary }, user: { summary } }] },
  };
  check('负向对照：summary 放错层级时浏览器侧读不到（证明上一组不是假通过）',
    clientInternals.readSummary(misplaced).summary === null);
  // 负向对照 2：退回裸数组（我最初的错误假设）也必须读不到。真机返回的是信封，
  // 这条就是当初让"页面永远空却测试全绿"的那个形状。
  check('负向对照：describe() 返回裸数组时读不到（真机返回的是信封）',
    clientInternals.readSummary([{ ns: CONFIG_NS, value: submitted }]).summary === null);
  // 负向对照 3：Remote 失败信封。
  check('负向对照：ok !== true 时读不到',
    clientInternals.readSummary({ ok: false, value: describeShape.value }).summary === null);
  // 边界：命名空间存在但没有本插件的条目 —— 应视为"可持久化但无数据"，
  // 而不是"不可持久化"（后者会把刷新按钮禁掉）。
  const others = { ok: true, value: { revision: 1, namespaces: [{ ns: 'other', value: {} }] } };
  check('没有本插件条目时 persistent 仍为 true（刷新按钮不该被禁）',
    clientInternals.readSummary(others).persistent === true && clientInternals.readSummary(others).summary === null);

  // 浏览器侧的紧凑格式化对宿主真实数值的呈现。
  // 总量 = (900+100+50) + (100+20) = 1170 → 1170/1000 = 1.17 → "1.2K"。
  const grand = hostRows.reduce((sum, row) => sum + row.total, 0);
  check('浏览器侧能格式化宿主真实总量（1170 → 1.2K）',
    clientInternals.formatTokens(grand) === '1.2K', clientInternals.formatTokens(grand));
} else {
  check('浏览器侧暴露 readSummary（跨半契约可验证）', false, 'clientInternals.readSummary 缺失');
}

/* ------------------------------------------------------------------ */
/* 汇总                                                                */
/* ------------------------------------------------------------------ */

console.log('');
console.log('='.repeat(64));
let totalChecks = 0;
for (const [name, group] of groups) {
  totalChecks += group.total;
  console.log('  ' + name + '：' + group.total + ' 项' + (group.failed === 0 ? '' : '（失败 ' + group.failed + '）'));
}
console.log('');

if (failures.length > 0) {
  console.log('通过 ' + ok + ' 项，失败 ' + failures.length + ' 项：');
  for (const item of failures) console.log('  - ' + item);
  process.exit(1);
}
console.log('全部通过：' + ok + ' 项装配形状断言 / 共 ' + totalChecks + ' 项（行为与视觉仍需在真机确认）。');
process.exit(0);
