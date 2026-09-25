/**
 * 「Token 用量」插件的 client.js 布局/结构自检。
 *
 * 为什么需要它：真机上出过的错位与空白，**任何功能性断言都抓不到**——它们都"渲染成功"。
 * 本脚本把「布局约定」与「渲染契约」变成可断言的结构规则，纯静态分析，不渲染 React：
 *
 *   1. 文件与语法形状（工厂 id / PANEL_ID / CONFIG_NS 与包名口径一致）；
 *   2. CSS 类名与 JSX 引用的闭环（定义未用 = 死代码；引用未定义 = 没有样式）；
 *   3. 颜色只走 --dsw-alias-* 主题令牌（令牌改名只降级外观，不会渲染失败）；
 *   4. 布局约定（不用 break-all、根容器高度归外壳、数字列 tabular-nums、浮层用 absolute）；
 *   5. 文案键完整性（client.js 内的 zh/en 两份对象互不缺不多、无死引用、无死键）；
 *   6. Hook 顺序（所有 hook 必须在首个 return 之前——违反过就是 React #310 + 整个 slot 空白）；
 *   7. 席位注册（sidebar.panellist / main / 会话头部 utilities，且不顶掉官方控件）；
 *   8. 图表语义（把 client.js 用 React 桩跑起来，跑真实的纯函数：折线 Y 轴从 0 起、
 *      环形图分母是 grandTotal、缺 timeline / 单点 / 全零时的降级——这些错了都不报错，
 *      只是画出一张撒谎的图，正则看不见）。
 *
 * 第 8 组是唯一会**执行**被检代码的一组，桩与 verify-contract.mjs 保持一致：
 * 同一份 client.js 被两个脚本用不同的桩跑，会让"这里过那里不过"变成常态。
 *
 * 与定时任务插件的差异：本插件的界面文案不在 locale/*.json 里，而是 client.js 内部的
 * `const zh = {...}` / `const en = {...}`；locale/*.json 只放插件卡片 meta 与给宿主用的键。
 * 因此文案检查分两处做，两处的键集合都要求一致。
 *
 * 用法：node scripts/verify-layout.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const failures = [];
let ok = 0;
function check(label, condition, detail) {
  if (condition) {
    ok += 1;
    console.log('  ok   ' + label);
    return;
  }
  failures.push(label + (detail === undefined ? '' : ' — ' + detail));
  console.log('  FAIL ' + label + (detail === undefined ? '' : ' — ' + detail));
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

/* ---------------- 1. 文件与语法形状 ---------------- */
console.log('');
console.log('[1. 文件与语法形状]');
const clientText = readText(path.join(root, 'client.js'));
check('client.js 存在且可读', clientText !== null, path.join(root, 'client.js'));
const source = clientText === null ? '' : clientText;

const cssMatch = /const CSS = \[([\s\S]*?)\]\.join\(/.exec(source);
check('能定位 CSS 数组（const CSS = [...].join(...)）', cssMatch !== null);
const cssBlock = cssMatch === null ? '' : cssMatch[1];
/** CSS 之后的部分即「JSX 与组件」区，类名引用只可能在这里。 */
const jsxPart = cssMatch === null ? source : source.slice(cssMatch.index + cssMatch[0].length);
check('能定位 CSS 之后的 JSX/组件部分', jsxPart.trim().length > 0);

/** 解析出每个规则的「选择器 -> 声明体」。 */
const rules = new Map();
for (const match of cssBlock.matchAll(/'([^']*\{[^}]*\})'/g)) {
  const rule = match[1];
  const brace = rule.indexOf('{');
  const selector = rule.slice(0, brace);
  const body = rule.slice(brace + 1, rule.lastIndexOf('}'));
  for (const part of selector.split(',')) {
    rules.set(part.trim(), body);
  }
}
check('能解析出 CSS 规则', rules.size > 0, '规则数 ' + rules.size);

check('存在 window.__ModuleLoader__.load(', /window\.__ModuleLoader__\.load\(/.test(source));

const pkg = readJson(path.join(root, 'package.json'));
const factoryId = (/__ModuleLoader__\.load\(\{[\s\S]{0,400}?\bid:\s*'([^']+)'/.exec(source) ?? [])[1] ?? null;
check(
  '工厂 id 与 package.json 的 name 一致',
  factoryId !== null && pkg !== null && factoryId === pkg.name,
  'id=' + factoryId + ' name=' + (pkg === null ? '(读不到 package.json)' : pkg.name),
);

const panelId = (/const PANEL_ID = '([^']+)'/.exec(source) ?? [])[1] ?? null;
const configNs = (/const CONFIG_NS = '([^']+)'/.exec(source) ?? [])[1] ?? null;
check("PANEL_ID 是 'token-usage'", panelId === 'token-usage', String(panelId));
check("CONFIG_NS 是 'token-usage'", configNs === 'token-usage', String(configNs));

/* ---------------- 2. CSS 与 JSX 的类名闭环 ---------------- */
console.log('');
console.log('[2. CSS 与 JSX 的类名闭环]');
const defined = new Set();
for (const selector of rules.keys()) {
  for (const match of selector.matchAll(/\.(stu-[A-Za-z0-9_-]+)/g)) defined.add(match[1]);
}

/** JSX 里实际用到的类名（className: 'a b' 形式，按空格拆开）。 */
const used = new Set();
for (const match of jsxPart.matchAll(/className:\s*'([^']+)'/g)) {
  for (const cls of match[1].split(/\s+/)) if (cls.startsWith('stu-')) used.add(cls);
}

// 动态拼出来的类名（className: `stu-${x}` / className: 'stu-' + kind）无法静态展开，
// 一旦出现就不能断言「定义了却没用」——否则规则会常红，比没有规则更糟。
// 这里只统计并提示，不把它当作「用了没定义」的证据。
const dynamicClassNames = (jsxPart.match(/className:/g) ?? []).length
  - (jsxPart.match(/className:\s*'/g) ?? []).length;
if (dynamicClassNames > 0) {
  console.log('  note 发现 ' + dynamicClassNames + ' 处动态 className；「定义了却没用」一项按宽容原则跳过。');
}
const unused = dynamicClassNames > 0 ? [] : [...defined].filter((cls) => !used.has(cls)).sort();
const undefinedClasses = [...used].filter((cls) => !defined.has(cls)).sort();
console.log('  统计：CSS 定义 ' + defined.size + ' 个 .stu-* 类，JSX 使用 ' + used.size + ' 个。');
check('没有「定义了却从未使用」的类', unused.length === 0, unused.join(', '));
check('没有「用了却没有样式」的类', undefinedClasses.length === 0, undefinedClasses.join(', '));
check('类名统一 stu- 前缀（无 stp- 等其它前缀残留）', !/(^|[^A-Za-z0-9-])stp-/.test(source) && !/\.(?!stu-)[a-z]{3}-[A-Za-z0-9_-]+\{/.test(cssBlock));
check('JSX 里至少用到 30 个 stu-* 类（CSS 没被整体废弃）', used.size >= 30, '实际 ' + used.size);

/* ---------------- 3. 颜色只走主题令牌 ---------------- */
console.log('');
console.log('[3. 颜色只走 --dsw-alias-* 主题令牌]');
const COLOR_PROP = /^(color|background|background-color|border|border-color|border-(top|right|bottom|left)(-color)?|outline|outline-color|box-shadow|fill|stroke|text-shadow)$/;
const RAW_COLOR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;
/**
 * 唯一允许的裸颜色：浮层阴影的 `rgba(0,0,0,.16)`。
 * 阴影没有对应的 --dsw-alias-* 令牌（令牌里没有阴影色），所以这一处只能写字面量；
 * 它必须**只出现在 box-shadow 声明里**，其它任何地方出现裸色都算违规。
 */
const SHADOW_EXCEPTION = /^box-shadow\s*:\s*[\s\S]*rgba\(0,\s*0,\s*0,\s*\.16\)$/;
const rawColorDecls = [];
const rawColorValues = new Set();
const strayVars = new Set();
const nonTokenColor = [];
for (const [selector, body] of rules) {
  for (const declaration of body.split(';')) {
    const text = declaration.trim();
    const colon = text.indexOf(':');
    if (colon < 0) continue;
    const property = text.slice(0, colon).trim();
    const value = text.slice(colon + 1).trim();
    if (RAW_COLOR.test(value)) {
      for (const match of value.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\)/g)) rawColorValues.add(match[0]);
      if (!SHADOW_EXCEPTION.test(text)) rawColorDecls.push(selector + ' { ' + text + ' }');
    }
    for (const match of value.matchAll(/var\((--[A-Za-z0-9-]+)/g)) {
      if (!match[1].startsWith('--dsw-')) strayVars.add(match[1]);
    }
    // 只有「值里确实带颜色」的声明才要求用令牌；border-bottom:0 / border-radius:10px 不含颜色，跳过。
    if (!COLOR_PROP.test(property)) continue;
    if (SHADOW_EXCEPTION.test(text)) continue;
    const hasColorToken = RAW_COLOR.test(value) || value.includes('var(');
    if (!hasColorToken) continue;
    if (value.includes('var(--dsw-alias-')) continue;
    nonTokenColor.push(selector + ' { ' + text + ' }');
  }
}
check(
  '除 box-shadow 的 rgba(0,0,0,.16) 外没有裸颜色字面量',
  rawColorDecls.length === 0,
  rawColorDecls.join(', '),
);
check(
  '唯一允许的裸色值就是 box-shadow 的 rgba(0,0,0,.16)',
  [...rawColorValues].every((value) => /^rgba\(0,\s*0,\s*0,\s*\.16\)$/.test(value)),
  [...rawColorValues].join(', '),
);
check('颜色属性一律使用 var(--dsw-alias-*)', nonTokenColor.length === 0, nonTokenColor.join(', '));
check('所有 var() 都在 --dsw- 命名空间内', strayVars.size === 0, [...strayVars].join(', '));
check(
  '不出现 --dsw- 之外的色彩体系（--ant- / --el- / --arco- / --van- 等）',
  !/--(ant|el|arco|van|td|nut|semi)-/.test(source),
);

/* ---------------- 4. 布局约定 ---------------- */
console.log('');
console.log('[4. 布局约定]');
check('不存在 word-break:break-all（中文会逐字换行）', !/word-break\s*:\s*break-all/.test(source));

const innerRule = rules.get('.stu-inner');
check('根容器 .stu-inner 存在', innerRule !== undefined);
check(
  '根容器不写 height:100%（与外壳滚动容器打架）',
  innerRule !== undefined && !/(^|;)\s*height\s*:\s*100%/.test(innerRule),
  String(innerRule),
);
check('根容器有最大宽度约束 max-width:980px', innerRule !== undefined && /max-width\s*:\s*980px/.test(innerRule), String(innerRule));
check(
  '根容器不自建滚动（overflow:auto/scroll 交给外壳）',
  innerRule !== undefined && !/overflow(-[xy])?\s*:\s*(auto|scroll)/.test(innerRule),
  String(innerRule),
);

const numRule = rules.get('.stu-num');
check(
  '表格数字列 .stu-num 使用 font-variant-numeric:tabular-nums（否则小数位对不齐）',
  numRule !== undefined && /font-variant-numeric\s*:\s*tabular-nums/.test(numRule),
  String(numRule),
);
check(
  '合计列与数字列同用（stu-totalCell 不单独拿走 tabular-nums）',
  /className:\s*'stu-num stu-totalCell'/.test(jsxPart),
);

const popRule = rules.get('.stu-pop');
check('模态/浮层 .stu-pop 存在', popRule !== undefined);
check('浮层用 position:absolute（不脱离侧栏几何）', popRule !== undefined && /position\s*:\s*absolute/.test(popRule), String(popRule));
check('浮层不用 position:fixed', popRule !== undefined && !/position\s*:\s*fixed/.test(popRule), String(popRule));

/* ---------------- 5. 文案键完整性 ---------------- */
console.log('');
console.log('[5. 文案键完整性]');
const zhBlock = /const zh = \{([\s\S]*?)\n    \};/.exec(source);
const enBlock = /const en = \{([\s\S]*?)\n    \};/.exec(source);
check('能定位 client.js 里的 zh 文案表', zhBlock !== null);
check('能定位 client.js 里的 en 文案表', enBlock !== null);
const zhBody = zhBlock === null ? '' : zhBlock[1];
const enBody = enBlock === null ? '' : enBlock[1];
const zhKeys = new Set([...zhBody.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1]));
const enKeys = new Set([...enBody.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1]));
const onlyZh = [...zhKeys].filter((key) => !enKeys.has(key)).sort();
const onlyEn = [...enKeys].filter((key) => !zhKeys.has(key)).sort();
console.log('  统计：client.js zh ' + zhKeys.size + ' 键，en ' + enKeys.size + ' 键。');
check(
  'client.js 的 zh 与 en 键集合完全一致（互相不缺、不多）',
  zhKeys.size > 0 && onlyZh.length === 0 && onlyEn.length === 0,
  'zh 独有: [' + onlyZh.join(', ') + '] en 独有: [' + onlyEn.join(', ') + ']',
);

const zhJson = readJson(path.join(root, 'locale', 'zh.json'));
const enJson = readJson(path.join(root, 'locale', 'en.json'));
check('locale/zh.json 可解析', zhJson !== null);
check('locale/en.json 可解析', enJson !== null);
/** 展平成 a.b.c 路径，两级 locale 文件按路径集合比对。 */
function flattenKeys(value, prefix, out) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    out.add(prefix);
    return out;
  }
  for (const key of Object.keys(value)) flattenKeys(value[key], prefix === '' ? key : prefix + '.' + key, out);
  return out;
}
const zhJsonKeys = flattenKeys(zhJson, '', new Set());
const enJsonKeys = flattenKeys(enJson, '', new Set());
const jsonOnlyZh = [...zhJsonKeys].filter((key) => !enJsonKeys.has(key)).sort();
const jsonOnlyEn = [...enJsonKeys].filter((key) => !zhJsonKeys.has(key)).sort();
console.log('  统计：locale/zh.json ' + zhJsonKeys.size + ' 个键路径（含 meta）。');
check(
  'locale/zh.json 与 locale/en.json 键集合相同',
  zhJsonKeys.size > 0 && jsonOnlyZh.length === 0 && jsonOnlyEn.length === 0,
  'zh 独有: [' + jsonOnlyZh.join(', ') + '] en 独有: [' + jsonOnlyEn.join(', ') + ']',
);
check(
  '两份 locale JSON 都带插件卡片 meta.title / meta.description',
  zhJsonKeys.has('meta.title') && zhJsonKeys.has('meta.description')
    && enJsonKeys.has('meta.title') && enJsonKeys.has('meta.description'),
);

const referenced = new Set([...source.matchAll(/\bt\('([A-Za-z_][A-Za-z0-9_]*)'\)/g)].map((m) => m[1]));
const missingZh = [...referenced].filter((key) => !zhKeys.has(key)).sort();
const missingEn = [...referenced].filter((key) => !enKeys.has(key)).sort();
check('每个 t(\'...\') 引用的键都有中文文案', missingZh.length === 0, missingZh.join(', '));
check('每个 t(\'...\') 引用的键都有英文文案', missingEn.length === 0, missingEn.join(', '));

// 键「被用到」的两种方式：t('key') 直接引用，或在文案表之外作为带引号的字符串字面量出现
// （例如 'status' 这类表驱动文案）。两份文案表本身要先摘掉，否则键名自己的定义会自证成活键。
const codeOutsideLocale = source.replace(zhBody, '').replace(enBody, '');
const isLiteralUsed = (key) => new RegExp("['\"]" + key + "['\"]").test(codeOutsideLocale);
const deadKeys = [...zhKeys].filter((key) => !referenced.has(key) && !isLiteralUsed(key)).sort();

/*
 * 待作者处理的死键清单。
 *
 * 当前为**空**：原先的两个死键（`colAttempts`、`totalRow`）是历史遗留——表格原计划
 * 有「合计」行与「调用次数」列，而调用次数只在浮层里用 attempts 展示、"合计" 由
 * totalCell 表现。作者已按「删键而不是留死键」处理，从 client.js 里删除了它们。
 *
 * 保留这个机制而不是直接删掉：将来再出现死键时，可以先把键放进来以 WARN 形式暴露，
 * 而不是让脚本立刻变红（常红的规则会被忽略，比没有规则更糟）。
 * 一旦清单里的键被接上或删除，下面的「清单仍然准确」会失败来提醒清理。
 */
const PENDING_DEAD_KEYS = [];
const pendingDead = deadKeys.filter((key) => PENDING_DEAD_KEYS.includes(key));
const unexpectedDead = deadKeys.filter((key) => !PENDING_DEAD_KEYS.includes(key));
check('没有定义却从不使用的文案键（不含待处理清单）', unexpectedDead.length === 0, unexpectedDead.join(', '));
check(
  '待处理死键清单仍然准确（清单里的键确实还没被引用）',
  pendingDead.length === PENDING_DEAD_KEYS.length,
  '清单 [' + PENDING_DEAD_KEYS.join(', ') + ']，实际未引用 [' + pendingDead.join(', ') + ']',
);
if (pendingDead.length > 0) {
  console.log('  WARN 以下文案键已定义但从未被引用（真实死键，待作者决定删键或接线）：');
  for (const key of pendingDead) console.log('       - ' + key);
}

/** 把某个键的文案取出来，用于比对中英两份的占位符。 */
function valueOf(body, key) {
  const match = new RegExp('^\\s*' + key + "\\s*:\\s*'((?:[^'\\\\]|\\\\.)*)'", 'm').exec(body);
  return match === null ? null : match[1];
}
const placeholderMismatch = [];
for (const key of zhKeys) {
  const zhText = valueOf(zhBody, key);
  const enText = valueOf(enBody, key);
  if (zhText === null || enText === null) continue;
  const shape = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  if (shape(zhText) !== shape(enText)) placeholderMismatch.push(key + ' (zh:{' + shape(zhText) + '} en:{' + shape(enText) + '})');
}
check('同一键在中英两份文案里的占位符一致', placeholderMismatch.length === 0, placeholderMismatch.join('; '));

/* ---------------- 6. Hook 顺序 ---------------- */
console.log('');
console.log('[6. Hook 顺序：所有 hook 必须在首个 return 之前]');

/** 跳过字符串与注释；返回下一个安全扫描位，未命中噪声时返回 -1。 */
function skipNoise(text, index) {
  const ch = text[index];
  if (ch === '/' && text[index + 1] === '/') {
    const nl = text.indexOf('\n', index);
    return nl < 0 ? text.length : nl;
  }
  if (ch === '/' && text[index + 1] === '*') {
    const end = text.indexOf('*/', index + 2);
    return end < 0 ? text.length : end + 2;
  }
  if (ch === "'" || ch === '"' || ch === '`') {
    let i = index + 1;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i] === ch) return i + 1;
      i += 1;
    }
    return text.length;
  }
  return -1;
}

/** 花括号配对抽出函数体（跳过字符串与注释）。 */
function extractFunctionBody(text, name) {
  const start = text.indexOf('function ' + name + '(');
  if (start < 0) return null;
  const open = text.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const skipped = skipNoise(text, i);
    if (skipped >= 0) { i = skipped - 1; continue; }
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

/** 向前找最近的实义记号（跳空白与块注释）。 */
function lastSignificant(text, index) {
  let i = index - 1;
  while (i >= 0) {
    if (/\s/.test(text[i])) { i -= 1; continue; }
    if (text[i] === '/' && text[i - 1] === '*') {
      const open = text.lastIndexOf('/*', i);
      i = open < 0 ? -1 : open - 1;
      continue;
    }
    break;
  }
  if (i < 0) return { text: null, index: -1 };
  if (text[i] === '>' && text[i - 1] === '=') return { text: '=>', index: i - 1 };
  const word = /[A-Za-z_$][A-Za-z0-9_$]*$/.exec(text.slice(0, i + 1));
  if (word !== null) return { text: word[0], index: i + 1 - word[0].length };
  return { text: text[i], index: i };
}

/** 与 index 处的 ')' 配对的 '(' 位置。 */
function matchingOpenParen(text, closeIndex) {
  let depth = 0;
  for (let i = closeIndex; i >= 0; i -= 1) {
    if (text[i] === ')') depth += 1;
    else if (text[i] === '(') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 扫描函数体，分出「语句层 return」与「嵌套箭头函数（useEffect / useCallback 回调）里的 return」，
 * 同时记录每个 hook 调用的位置与所在花括号层数。
 */
function scanFunctionBody(body) {
  const hooks = [];
  const returns = [];
  const stack = [];
  let i = 0;
  while (i < body.length) {
    const skipped = skipNoise(body, i);
    if (skipped >= 0) { i = skipped; continue; }
    const ch = body[i];
    if (ch === '{') {
      const prev = lastSignificant(body, i);
      let isFunctionBody = false;
      if (prev.text === '=>') isFunctionBody = true;
      else if (prev.text === ')') {
        const open = matchingOpenParen(body, prev.index);
        const head = open < 0 ? { text: null } : lastSignificant(body, open);
        if (head.text !== null && !/^(if|for|while|switch|catch|with)$/.test(head.text)) isFunctionBody = true;
      }
      stack.push(isFunctionBody);
      i += 1;
      continue;
    }
    if (ch === '}') {
      stack.pop();
      i += 1;
      continue;
    }
    const nestedFunction = stack.includes(true);
    if (!nestedFunction) {
      const rest = body.slice(i);
      const hookMatch = /^(?:React\.)?(use[A-Z][A-Za-z0-9]*)\s*\(/.exec(rest);
      if (hookMatch !== null) {
        hooks.push({ name: hookMatch[1], index: i, braceDepth: stack.length });
        i += hookMatch[0].length;
        continue;
      }
      if (/^return\b/.test(rest)) {
        returns.push({ index: i });
        i += 6;
        continue;
      }
    }
    i += 1;
  }
  return { hooks, returns };
}

for (const name of ['SessionMeter', 'UsagePage']) {
  const body = extractFunctionBody(source, name);
  check('能抽出 ' + name + ' 的函数体', body !== null);
  if (body === null) continue;
  const { hooks, returns } = scanFunctionBody(body);
  const firstReturn = returns.length === 0 ? Number.POSITIVE_INFINITY : returns[0].index;
  const lateHooks = hooks.filter((hook) => hook.index > firstReturn).map((hook) => hook.name + '@' + hook.index);
  check(
    name + ' 的 ' + hooks.length + ' 个 hook 全部在首个 return 之前（否则 React #310，slot 变空白）',
    hooks.length > 0 && lateHooks.length === 0,
    '首个 return@' + firstReturn + '，越界 hook: ' + lateHooks.join(', '),
  );
  const conditionalHooks = hooks.filter((hook) => hook.braceDepth > 0).map((hook) => hook.name + '@' + hook.index);
  check(
    name + ' 的 hook 都在语句层无条件调用（不在任何 { } 块内）',
    conditionalHooks.length === 0,
    conditionalHooks.join(', '),
  );
}

const meterBody = extractFunctionBody(source, 'SessionMeter');
const meterScan = meterBody === null ? { hooks: [] } : scanFunctionBody(meterBody);
const lastMeterHook = meterScan.hooks.reduce((max, hook) => Math.max(max, hook.index), -1);
const unsupportedBranch = meterBody === null ? -1 : meterBody.indexOf('if (!hasHook)');
check(
  'SessionMeter 的 if (!hasHook) 降级分支在所有 hook 之后',
  meterBody !== null && unsupportedBranch > lastMeterHook && lastMeterHook >= 0,
  '分支@' + unsupportedBranch + '，末个 hook@' + lastMeterHook,
);

/*
 * 浮层必须渲染四桶分解，而不只是每个模型的总量。
 *
 * 「按模型汇总 token 用量」这件事，只显示总量只做了一半：能看出哪个模型花得多，
 * 看不出花在输入还是输出、缓存命中多少。投影的 wire 数据本来就把每行的 buckets
 * 一起带过来了，漏渲染它属于"数据到了但没用上"——外观上看不出来，只能靠断言守。
 */
check(
  '浮层有四桶分解容器（stu-popBuckets）',
  /className:\s*'stu-popBuckets'/.test(source),
);
check(
  '四桶标签全部在 SessionMeter 里出现（键名以字面量列出）',
  ['bIn', 'bOut', 'bCacheRead', 'bCacheWrite']
    .every((key) => new RegExp("'" + key + "'").test(meterBody ?? '')),
  ['bIn', 'bOut', 'bCacheRead', 'bCacheWrite']
    .filter((key) => !new RegExp("'" + key + "'").test(meterBody ?? '')).join(', '),
);
check(
  '四桶取自 row.buckets 的四个官方字段（不是自己另算）',
  ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
    .every((field) => new RegExp('row\\.buckets\\.' + field).test(meterBody ?? '')),
);
check(
  '四桶每个标签配一个数值单元格（不是只有标题）',
  /stu-popBucketLabel/.test(source) && /stu-popBucketValue/.test(source),
);
check(
  '四桶用 2 列网格（320px 浮层下四项横排会挤到换行、换行后列对不齐）',
  /\.stu-popBuckets\{[^}]*grid-template-columns:repeat\(2,/.test(cssBlock),
);

/*
 * 图表（列表不直观，所以加了横向堆叠条）。
 *
 * 与浮层四桶同属"数据到了但界面没表达"的高危区：图画错不会报错，只会让人读错。
 * 所以几条关键的归一化语义都钉死。
 */
check('页面渲染了图表容器 stu-chart', /className:\s*'stu-chart'/.test(source));
check(
  '图表按四桶分段，每段带 data-bucket（样式与断言都靠它定位）',
  /'data-bucket':\s*segment\.bucket/.test(source) && /className:\s*'stu-seg'/.test(source),
);
check(
  '条长按全局最大总量归一（段宽 = value / max，不是 value / total）',
  /\(segment\.value \/ max\) \* 100/.test(source),
  '若写成 / total 则所有条等长，跨模型比不出大小',
);
check(
  '图表用全部行而不是当前页（总览不该被翻页改变）',
  /body\.push\(renderChart\(rows, t\)\)/.test(source) && !/renderChart\(slice/.test(source),
);
check(
  '值为 0 的桶不画段（否则 min-width 会留下看不见却占位的碎片）',
  /filter\(\(segment\) => segment\.value > 0\)/.test(source),
);
check('每段都直接标出数值（读数不依赖颜色深浅）', /formatExact\(segment\.value\)/.test(source));
check('有图例与色块', /className:\s*'stu-legend'/.test(source) && /className:\s*'stu-swatch'/.test(source));
check(
  '条形有 role=img 与 aria-label（无障碍，不只是一堆 div）',
  /role:\s*'img'/.test(source) && /'aria-label':\s*label/.test(source),
);
check(
  '四段只用品牌色的不同透明度，未硬借 state-* 语义色',
  // 6 处 = .stu-seg 与 .stu-swatch 各三档透明度，加上不打 opacity 的第一档。
  /data-bucket="uncachedInputTokens"\]\{background:var\(--dsw-alias-brand-primary\)\}/.test(cssBlock)
    && (cssBlock.match(/--dsw-alias-brand-primary\);opacity:/g) ?? []).length === 6,
  '实际 ' + (cssBlock.match(/--dsw-alias-brand-primary\);opacity:/g) ?? []).length,
);
check(
  '四段透明度依次递减（保证相邻段可分辨）',
  /opacity:\.74/.test(cssBlock) && /opacity:\.46/.test(cssBlock) && /opacity:\.24/.test(cssBlock),
);

/*
 * 环形图与折线图。
 *
 * 这一组只看**形状**（有没有用对 SVG 元素、有没有走固定坐标系）。归一化数学
 * （Y 轴是否从 0 起、环形图分母是不是 grandTotal、缺 timeline 时是否降级）
 * 在第 8 组用运行时纯函数跑真实输入验证——静态正则看不出算式对不对。
 *
 * 为什么两处都要：形状对了算式错 = 画出一张撒谎的图；算式对了元素错 =
 * 画不出来。两类错误的排查手段完全不同，不该混在一条断言里。
 */
check('渲染了环形图（renderDonut 被调用且进入 body）',
  /const donut = renderDonut\(rows, t\)/.test(source) && /body\.push\(donut\)/.test(source));
check(
  '环形图用 SVG circle + stroke-dasharray / stroke-dashoffset 画分段（手算 path 弧容易在整圈退化）',
  /strokeDasharray:\s*segment\.length \+ ' 100'/.test(source)
    && /strokeDashoffset:\s*-segment\.offset/.test(source)
    && /className:\s*'stu-donutSeg'/.test(source),
);
check(
  '环形图从 12 点方向起画（rotate(-90 …)），否则第一段起点在三点钟方向',
  /transform:\s*'rotate\(-90 ' \+ centre/.test(source),
);
check(
  '环形图段色按模型次序取透明度（不是按数值），超过 4 个循环',
  /const opacity = SEGMENT_OPACITY\[index % SEGMENT_OPACITY\.length\]/.test(source)
    && /const SEGMENT_OPACITY = \[1, 0\.74, 0\.46, 0\.24\]/.test(source),
);
check(
  '环形图圆心显示总量（formatTokens），不是空白',
  /className:\s*'stu-donutTotal'[\s\S]{0,40}formatTokens\(grandTotal\)/.test(source),
);
check(
  '环形图有独立图例（模型名 + 占比 + 数值），不靠颜色读图',
  /className:\s*'stu-donutLegend'/.test(source)
    && /className:\s*'stu-donutName'/.test(source)
    && /className:\s*'stu-donutShare'/.test(source)
    && /className:\s*'stu-donutValue'/.test(source),
);
check('环形图有底圈（占比不满 100% 时露出底色，不假装是满圈）',
  /className:\s*'stu-donutTrack'/.test(source));
check(
  '环形图每个模型有 role=img 的 aria-label（无障碍，不只是彩色弧）',
  /'aria-label':\s*title/.test(source) && /fill\(t\('donutAria'\),\s*\{\s*total:/.test(source),
);

check('渲染了折线图（renderTrend 被调用）', /renderTrend\(trendPoints, t\)/.test(source));
check(
  '折线图用固定 viewBox + preserveAspectRatio="none"（自适应容器宽度，不量 DOM）',
  /viewBox:\s*'0 0 100 30'/.test(source) && /preserveAspectRatio:\s*'none'/.test(source),
);
check(
  '折线用 polyline + 点序列（不是一堆 div）',
  /h\('polyline'/.test(source) && /points:\s*polylinePoints\(geometry\.points\)/.test(source),
);
/*
 * Y 轴从 0 起：`y = 基线 - (value / max) * 跨度`，全零时落在基线上。
 * 这条断言盯着算式本身——把 `value / max` 改成 `(value - min) / (max - min)`
 * 会同时打掉它和第 8 组的行为断言（负向对照 A 用的就是这条）。
 */
check(
  '折线 Y 轴从 0 起（y 里只有 value/max，没有减 min 的项）',
  /y:\s*max > 0 \? TREND_BASE_Y - \(value \/ max\) \* span : TREND_BASE_Y/.test(source)
    && /const span = TREND_BASE_Y/.test(source)
    && !/\bmin\b/.test(extractFunctionBody(source, 'trendGeometry') ?? ''),
  '若改成从 min 起，一条平线会被画成剧烈起伏——图不报错，只是撒谎',
);
check(
  '折线有零刻度基线（线是刻度不是数据，用 border-l1 不用品牌色）',
  /className:\s*'stu-trendBase'/.test(source) && /\.stu-trendBase\{[^}]*--dsw-alias-border-l1/.test(cssBlock),
);
check(
  '折线只标首尾日期（MM-DD），不逐日标（30 天会糊成一团）',
  /const first = shortDay\(list\[0\]\.day\)/.test(source)
    && /const last = shortDay\(list\[list\.length - 1\]\.day\)/.test(source)
    && /className:\s*'stu-trendAxis'/.test(source),
);
check(
  '单点时画圆点而不是零长度折线（单点折线什么都看不见）',
  /geometry\.points\.length === 1/.test(source) && /className:\s*'stu-trendDot'/.test(source),
);
check(
  '每个数据点带 <title>（日期 + 数值；只靠形状读不出具体哪天多少）',
  (source.match(/h\('title',\s*null,/g) ?? []).length >= 3,
  '实际 ' + (source.match(/h\('title',\s*null,/g) ?? []).length + ' 处',
);
check(
  '没有 timeline 时整块折线图不出现（不是画一条空坐标系）',
  /if \(hasTrend\) body\.push\(renderTrend\(trendPoints, t\)\)/.test(source)
    && /timelinePresent:\s*timeline\.length > 0/.test(source),
);
check(
  '图表顺序：环形图 → 折线图 → 按模型构成（从整体到细节）',
  (() => {
    const donut = source.indexOf('body.push(donut)');
    const trend = source.indexOf('body.push(renderTrend(trendPoints, t))');
    const composition = source.indexOf('body.push(renderChart(rows, t))');
    return donut > 0 && trend > donut && composition > trend;
  })(),
);
check(
  '客户端仍然只 require(react)：没有引入任何图表库',
  !/require\(\s*'(?!react')[^']+'\s*\)/.test(source)
    && !/\b(d3|chart\.js|recharts|echarts|apexcharts|plotly|visx|nivo)\b/i.test(source),
);
/*
 * 裸颜色检查要在**剥掉注释之后**做：注释里会合法地出现 `#310`（React 的 hook 顺序
 * 错误码就是四个十六进制字符），把它算成颜色会让这条规则常红——常红的规则会被忽略。
 */
const jsxPartCode = jsxPart.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check(
  'SVG 的图形属性也不写裸颜色（stroke/fill 一律 var(--dsw-alias-*)）',
  !/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(jsxPartCode),
  (jsxPartCode.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)/g) ?? []).join(', '),
);

/* ---------------- 7. 席位注册 ---------------- */
console.log('');
console.log('[7. 席位注册]');
check('注册了 sidebar.panellist', /name:\s*'sidebar\.panellist'/.test(source));
check(
  'panellist 传了 id: PANEL_ID',
  /name:\s*'sidebar\.panellist'[\s\S]{0,120}?id:\s*PANEL_ID/.test(source),
);
check(
  'panellist 传了 order（侧栏顺序稳定）',
  /name:\s*'sidebar\.panellist'[\s\S]{0,160}?order:\s*\d+/.test(source),
);
check(
  'panellist 的 label 走文案 t(\'panelLabel\')',
  /name:\s*'sidebar\.panellist'[\s\S]{0,200}?label:\s*\(\)\s*=>\s*t\('panelLabel'\)/.test(source),
);
check('注册了 main 且 key: PANEL_ID', /name:\s*'main'[\s\S]{0,80}?key:\s*PANEL_ID/.test(source));
check(
  '注册了 conversation.session.header.utilities',
  /name:\s*'conversation\.session\.header\.utilities'/.test(source),
);

const utilReg = /contribute\('conversation\.session\.header\.utilities',\s*\{([\s\S]*?)\}\s*,\s*Meter\)/.exec(source);
check('能定位会话头部席位的注册选项', utilReg !== null);
const utilOptions = utilReg === null ? '' : utilReg[1];
check(
  '会话头部席位是安全追加（replaceRisk 缺省或显式 none）',
  utilOptions.trim().length > 0 && (!/replaceRisk/.test(utilOptions) || /replaceRisk\s*:\s*'none'/.test(utilOptions)),
  utilOptions.trim(),
);
check(
  '没有任何席位声明 replaceRisk: shadows-shipped-ui（本插件不顶掉官方控件）',
  !/replaceRisk\s*:\s*'shadows-shipped-ui'/.test(source),
);
check(
  '会话头部席位带 id 与 order',
  /id:\s*PANEL_ID/.test(utilOptions) && /order:\s*\d+/.test(utilOptions),
  utilOptions.trim(),
);
check('会话头部席位声明 locale 命名空间（宿主据此取文案）', /locale:\s*LOCALE_NS/.test(utilOptions));

/*
 * 席位必须经 `ctx.slots.inject(ownerKey, …)` 注册，**不能**裸调 ctx.slots.register。
 *
 * 真机事故（2026-09-25 启动失败对话框）：
 *   [token-usage] slot panellist failed  Error: slot "sidebar.panellist" is not declared
 * 浏览器 bundle 的执行顺序由 combo 决定，本包可能排在"声明这些 slot 的包"之前；
 * 裸注册此时直接抛错，三个席位全部丢失，而 apply 本身不报错。
 * inject 会把注册推迟到属主声明出现之后，并在它重新出现时重装。
 */
check(
  '三个席位都经 ctx.slots.inject(ownerKey, …) 注册（裸 register 会在 boot 顺序不利时抛错）',
  /const contribute = \(ownerKey, options, Component\)/.test(source)
    && /ctx\.slots\.inject\(ownerKey, function\* \(\) \{/.test(source)
    && /yield ctx\.slots\.register\(options, Component\)/.test(source),
);
{
  // 注释里也提到了 register，所以先剥掉注释再数——否则会把文档当成调用。
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const injectCount = (codeOnly.match(/ctx\.slots\.inject\(/g) ?? []).length;
  const registerCount = (codeOnly.match(/ctx\.slots\.register\(/g) ?? []).length;
  const contributeCalls = (codeOnly.match(/contribute\(/g) ?? []).length;
  // 只有一处 inject（在 contribute 辅助函数里），被 3 个席位调用 —— 这样
  // "每个席位都走 inject" 由构造保证，不可能漏掉其中一个。
  check('恰好 1 处 ctx.slots.inject（在 contribute 辅助函数里复用）', injectCount === 1, '实际 ' + injectCount);
  check(
    'register 只出现在 inject 的 generator 回调里（没有裸调）',
    registerCount === 1 && /ctx\.slots\.inject\(ownerKey, function\* \(\) \{\s*yield ctx\.slots\.register\(options, Component\);/.test(codeOnly),
    'register ' + registerCount + ' 次',
  );
  check('contribute 被调用 3 次（三个席位一个不落）', contributeCalls === 3, '实际 ' + contributeCalls);
}
check(
  '席位注册不再用 try/catch 吞错（吞掉只会让席位静默消失，boot 审计仍会记该 entry 失败）',
  !/slot '\s*\+ label \+ '\s*failed/.test(source),
);

/* ---------------- 8. 图表语义（跑真实的纯函数，不靠正则） ---------------- */
console.log('');
console.log('[8. 图表语义：归一化数学必须对，错了不报错只是撒谎]');

/*
 * 为什么这一组必须真跑代码而不是看源码文本：
 *
 * 图表的三种致命错误——**Y 轴不从 0 起**、**环形图分母写成 max**、
 * **timeline 缺失/单点/全零时的降级**——在界面上全都是"渲染成功的一张图"。
 * 正则能确认"有一段算 y 的代码"，但确认不了那段算式的分母是谁、基线在哪。
 * 所以这里把 client.js 用桩跑起来，从 `__internals` 取纯函数跑真实输入。
 *
 * 桩必须和 verify-contract.mjs 同一套（同一份 client.js 被两个脚本用两种桩跑，
 * 桩不同会让"这里过那里不过"变成常态）：模块顶层只用到 React.createElement，
 * hook 只在组件渲染时调用，而本脚本不渲染组件。
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

let internals = null;
let loadError = null;
{
  let captured = null;
  const previousWindow = globalThis.window;
  globalThis.window = { __ModuleLoader__: { load: (def) => { captured = def; } } };
  try {
    await import(pathToFileURL(path.join(root, 'client.js')).href);
    if (captured === null || typeof captured.factory !== 'function') {
      loadError = new Error('client.js 没有调用 __ModuleLoader__.load({ factory })');
    } else {
      internals = captured.factory((name) => (name === 'react' ? ReactStub : undefined))?.__internals ?? null;
      if (internals === null) loadError = new Error('factory 返回值缺少 __internals 测试接缝');
    }
  } catch (error) {
    loadError = error;
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
}
check(
  'client.js 能在 React 桩下装载并取出 __internals（图表纯函数可验证的前提）',
  internals !== null,
  loadError === null ? '' : (loadError instanceof Error ? loadError.message : String(loadError)),
);

const need = (name) => (internals !== null && typeof internals[name] === 'function' ? internals[name] : null);
const normaliseTimelineFn = need('normaliseTimeline');
const shortDayFn = need('shortDay');
const trendGeometryFn = need('trendGeometry');
const donutSegmentsFn = need('donutSegments');
const polylinePointsFn = need('polylinePoints');

check(
  '__internals 暴露图表纯函数（normaliseTimeline / trendGeometry / donutSegments / shortDay）',
  normaliseTimelineFn !== null && shortDayFn !== null && trendGeometryFn !== null
    && donutSegmentsFn !== null && polylinePointsFn !== null,
);

/* ---- 8.a 折线图：Y 轴必须从 0 起 ---- */
if (trendGeometryFn !== null && shortDayFn !== null && polylinePointsFn !== null) {
  /*
   * 这组数字是刻意挑的：900 / 1000 两条平线，min 接近 max。
   * 从 0 起 → 两个点都贴近零刻度（差 1 个单位），平；从 min 起 → 一个贴顶一个贴底（差 24），
   * 看起来像暴涨十倍。同一份数据，两种画法给人的结论相反，而都不报错。
   */
  const flat = trendGeometryFn([{ total: 900 }, { total: 1000 }]);
  check(
    'Y 轴从 0 起：900 与 1000 在图上高度接近（差 ≤ 3 个单位）',
    Math.abs(flat.points[0].y - flat.points[1].y) <= 3,
    'y=' + flat.points.map((point) => point.y).join(' / '),
  );
  check(
    '最大值落在轴上沿（value === max → y === 0）',
    flat.points[1].y === 0,
    String(flat.points[1].y),
  );

  const zeros = [{ day: '2026-06-01', total: 0 }, { day: '2026-06-02', total: 0 }];
  const zeroGeometry = trendGeometryFn(zeros);
  check('全零时 max 为 0', zeroGeometry.max === 0, String(zeroGeometry.max));
  check(
    '全零时不做除法（不产生 NaN 坐标），所有点落在零刻度上',
    zeroGeometry.points.every((point) => point.y === zeroGeometry.baseY && Number.isFinite(point.y)),
    zeroGeometry.points.map((point) => point.y).join(' / '),
  );
  check(
    '零刻度（baseY）不在坐标系底边上（否则 0 值和基线糊成一条）',
    zeroGeometry.baseY < zeroGeometry.height && zeroGeometry.baseY > 0,
    'baseY=' + zeroGeometry.baseY + ' height=' + zeroGeometry.height,
  );

  const single = trendGeometryFn([{ day: '2026-06-05', total: 42 }]);
  check(
    '单点时 X 居中（x === 50）而不是贴在左沿或被 0 除成 NaN',
    single.points.length === 1 && single.points[0].x === 50 && Number.isFinite(single.points[0].y),
    JSON.stringify(single.points),
  );

  const two = trendGeometryFn([{ day: '2026-06-01', total: 10 }, { day: '2026-06-11', total: 20 }]);
  check(
    'X 用 index 等距（首点 0、末点 100），不按真实日期间隔比例',
    two.points[0].x === 0 && two.points[1].x === 100,
    two.points.map((point) => point.x).join(' / '),
  );
  check(
    '负值 / 非数被当成 0，不产生朝下的点（数据坏了也不画错）',
    trendGeometryFn([{ day: '2026-06-01', total: -5 }, { day: '2026-06-02', total: 'x' }])
      .points.every((point) => point.total === 0 && Number.isFinite(point.y)),
  );
  check('trendGeometry 对非数组输入不抛（降级到空序列）',
    trendGeometryFn(null).points.length === 0 && trendGeometryFn(undefined).max === 0);

  check(
    'polylinePoints 输出 "x,y x,y"（而不是数组字面量被塞进属性）',
    polylinePointsFn([{ x: 0, y: 26 }, { x: 100, y: 0 }]) === '0,26 100,0',
    polylinePointsFn([{ x: 0, y: 26 }, { x: 100, y: 0 }]),
  );

  check(
    'shortDay 手工拆日期字符串（不用 new Date：按 UTC 解析会让趋势整体偏移一天）',
    shortDayFn('2026-06-01') === '06-01' && shortDayFn('2026-6-9') === '06-09',
    shortDayFn('2026-06-01') + ' / ' + shortDayFn('2026-6-9'),
  );
  check('shortDay 对非日期字符串原样返回，不抛', shortDayFn('unknown') === 'unknown');
} else {
  check('折线图纯函数可取（否则 Y 轴从 0 起无法验证）', false);
}

/* ---- 8.b timeline 缺失 / 空 / 坏数据时必须降级 ---- */
if (normaliseTimelineFn !== null) {
  check('timeline 字段不存在时归一为空数组（旧数据不再画折线）',
    normaliseTimelineFn({ rows: [] }).length === 0 && normaliseTimelineFn({}).length === 0);
  check('timeline 是空数组时归一为空数组',
    normaliseTimelineFn({ timeline: [] }).length === 0);
  check('timeline 不是数组时归一为空数组（形状漂移不炸渲染）',
    normaliseTimelineFn({ timeline: { '2026-06-01': 5 } }).length === 0
      && normaliseTimelineFn({ timeline: 'x' }).length === 0
      && normaliseTimelineFn(null).length === 0);
  check('没有 day 的条目被丢掉（而不是画成 "undefined"）',
    normaliseTimelineFn({ timeline: [{ total: 5 }, null, { day: '', total: 5 }] }).length === 0);
  check('坏 total（负 / 非数 / NaN）归一到 0，不让 NaN 进坐标计算',
    normaliseTimelineFn({ timeline: [{ day: '2026-06-01', total: -1 }, { day: '2026-06-02', total: 'x' }] })
      .every((point) => point.total === 0));
  check('单天 timeline 归一后仍是一天（渲染层据此画圆点）',
    normaliseTimelineFn({ timeline: [{ day: '2026-06-01', total: 5 }] }).length === 1);
  check(
    'normaliseTimeline 不重排顺序（宿主按 day 升序给，重排会掩盖宿主侧顺序漂移）',
    normaliseTimelineFn({ timeline: [{ day: '2026-06-03', total: 1 }, { day: '2026-06-01', total: 2 }] })
      .map((point) => point.day).join(',') === '2026-06-03,2026-06-01',
  );
} else {
  check('timeline 归一函数可取（否则缺 timeline 的降级无法验证）', false);
}

/* ---- 8.c 环形图：分母必须是 grandTotal ---- */
if (donutSegmentsFn !== null) {
  /*
   * 这组数字同样刻意：总量 100，但 max 是 60（最大的那个模型）。
   * 用 grandTotal 当分母 → 三段 60/30/10，占比和 = 100%，offset 递增到 90。
   * 用 max 当分母 → 100%/50%/16.7%，和 > 100%，第二段会盖到第一段上
   * （视觉上像"少了一个模型"），而每个数字单看都像对的。
   */
  const rows = [
    { key: 'a', total: 60 },
    { key: 'b', total: 30 },
    { key: 'c', total: 10 },
  ];
  const segments = donutSegmentsFn(rows, 100);
  check('环形图分段数与正数模型数一致（值为 0 的不画）', segments.length === 3, String(segments.length));
  check(
    '环形图占比按 grandTotal（60/100 = 60%，不是 60/60 = 100%）',
    segments.map((segment) => segment.length).join(',') === '60,30,10',
    segments.map((segment) => segment.length).join(','),
  );
  check(
    '环形图各段占比之和恰好 100%（分母写错会立刻超过）',
    Math.abs(segments.reduce((sum, segment) => sum + segment.length, 0) - 100) < 1e-9,
    String(segments.reduce((sum, segment) => sum + segment.length, 0)),
  );
  check(
    '环形图各段 offset 依次递增（dashoffset 用 -offset，段与段不重叠）',
    segments.map((segment) => segment.offset).join(',') === '0,60,90',
    segments.map((segment) => segment.offset).join(','),
  );
  check(
    '环形图段色按模型次序取透明度，超过 4 个循环（两个等量模型不会同色）',
    donutSegmentsFn([{ key: 'a', total: 1 }, { key: 'b', total: 1 }], 2)
      .map((segment) => segment.opacity).join(',') === '1,0.74'
      && donutSegmentsFn(
        Array.from({ length: 5 }, (unusedValue, index) => ({ key: String(index), total: 1 })), 5,
      ).map((segment) => segment.opacity).join(',') === '1,0.74,0.46,0.24,1',
  );

  check('单个模型 100% 时画一段整圈（length === 100）',
    donutSegmentsFn([{ key: 'only', total: 7 }], 7).map((segment) => segment.length).join(',') === '100',
    donutSegmentsFn([{ key: 'only', total: 7 }], 7).map((segment) => segment.length).join(','));
  check('grandTotal 为 0 时不画任何段（空圆环看起来像加载失败）',
    donutSegmentsFn(rows, 0).length === 0 && donutSegmentsFn(rows, NaN).length === 0);
  check('全 0 / 坏数据的行被跳过，不留 0% 的图例项',
    donutSegmentsFn([{ key: 'a', total: 0 }, { key: 'b', total: 10 }, { key: 'c', total: -3 }], 10).length === 1);
  check('donutSegments 对非数组输入不抛（降级到空）',
    donutSegmentsFn(null, 100).length === 0 && donutSegmentsFn(undefined, 100).length === 0);
} else {
  check('环形图纯函数可取（否则占比分母无法验证）', false);
}

/* ---- 8.d 渲染出来的树：降级分支到底有没有接上 ---- */
const renderDonutFn = need('renderDonut');
const renderTrendFn = need('renderTrend');

/**
 * 按 className 在 React 元素树里找节点。
 *
 * 桩把 `h('div', {…}, …)` 变成 `{ type, props, children }`，所以这里能像查 DOM
 * 一样按类名找——**渲染自检必须看渲染结果**：算式对、元素也写对了，但分支接错
 * （例如单点走折线分支画出 `points=""`）在源码正则里看不出来。
 */
function findByClass(node, pattern, out) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) findByClass(item, pattern, out);
    return out;
  }
  const className = typeof node.props?.className === 'string' ? node.props.className : '';
  if (pattern.test(className)) out.push(node);
  findByClass(node.children, pattern, out);
  return out;
}
function hasClass(node, pattern) {
  return findByClass(node, pattern, []).length > 0;
}
function countClass(node, pattern) {
  return findByClass(node, pattern, []).length;
}

/** 与组件里同一个 t：键→中文，用于结构检查时占位符能真的被替换掉。 */
const tFor = (key) => (valueOf(zhBody, key) ?? key);

if (renderDonutFn !== null && renderTrendFn !== null) {
  const pageRows = [
    { key: 'a', provider: 'p1', model: 'm1', total: 60 },
    { key: 'b', provider: 'p2', model: 'm2', total: 30 },
    { key: 'c', provider: 'p3', model: 'm3', total: 10 },
  ];
  const donutTree = renderDonutFn(pageRows, tFor);

  check('环形图渲染出 3 个弧段（与 3 个正数模型一一对应）',
    countClass(donutTree, /stu-donutSeg/) === 3, String(countClass(donutTree, /stu-donutSeg/)));
  check('环形图每段都带 dasharray / dashoffset 属性（缺一个就画不出分段）',
    findByClass(donutTree, /stu-donutSeg/, []).every((node) =>
      typeof node.props.strokeDasharray === 'string' && Number.isFinite(node.props.strokeDashoffset)));
  check(
    '环形图弧段是 <circle>（dasharray 的分段语义只对闭合路径成立）',
    findByClass(donutTree, /stu-donutSeg/, []).every((node) => node.type === 'circle'),
  );
  check('环形图有底圈（占比不满 100% 时露出底色）', hasClass(donutTree, /stu-donutTrack/));
  check('环形图有图例列表与色块（颜色只负责分组，读数靠图例）',
    hasClass(donutTree, /stu-donutLegend/) && countClass(donutTree, /stu-donutSwatch/) === 3);
  check('单个模型时也画出一整圈（length === 100 的弧）',
    (() => {
      const single = findByClass(
        renderDonutFn([{ key: 'only', provider: 'p', model: 'm', total: 5 }], tFor), /stu-donutSeg/, [],
      );
      return single.length === 1 && String(single[0].props.strokeDasharray).startsWith('100 ');
    })());
  check('总量为 0 时不渲染环形图（空圆环看起来像加载失败）',
    !hasClass(renderDonutFn([{ key: 'a', provider: 'p', model: 'm', total: 0 }], tFor), /stu-donutSeg/));

  const manyPoints = [
    { day: '2026-06-01', total: 10 },
    { day: '2026-06-02', total: 30 },
    { day: '2026-06-03', total: 20 },
  ];
  const trendTree = renderTrendFn(manyPoints, tFor);
  check('折线图渲染出 polyline（多点时才有折线）', hasClass(trendTree, /stu-trendLine/));
  check('折线每条数据点都画了圆点与 <title>（悬停能看到具体哪天多少）',
    countClass(trendTree, /stu-trendDot/) === 3
      && findByClass(trendTree, /stu-trendDot/, []).every((node) => (node.children ?? []).some((child) => child?.type === 'title')));
  check('折线图标注首尾日期（只标两个，不逐日标）',
    countClass(trendTree, /stu-trendAxis/) === 1
      && JSON.stringify(findByClass(trendTree, /stu-trendAxis/, [])[0]?.children ?? [])
        .includes('06-01'));
  check('折线图有零刻度基线', hasClass(trendTree, /stu-trendBase/));

  const singleTree = renderTrendFn([{ day: '2026-06-05', total: 42 }], tFor);
  check(
    '单点时画圆点、不画 polyline（零长度折线什么都看不见）',
    countClass(singleTree, /stu-trendDot/) === 1 && !hasClass(singleTree, /stu-trendLine/),
  );
  const zeroTree = renderTrendFn([{ day: '2026-06-01', total: 0 }, { day: '2026-06-02', total: 0 }], tFor);
  check(
    '全是 0 时不画折线也不画点，只留一句空态文案（一条贴基线的线会被读成"一直有量但很小"）',
    !hasClass(zeroTree, /stu-trendLine/) && !hasClass(zeroTree, /stu-trendDot/)
      && hasClass(zeroTree, /stu-trendEmpty/),
  );
  check(
    '空序列不渲染折线图（缺 timeline 时整块不出现，而不是一个空坐标系）',
    renderTrendFn([], tFor) === null && renderTrendFn(null, tFor) === null,
  );
  check(
    '归一化与渲染接得上：没有 timeline 的 summary → 空序列 → 不渲染',
    renderTrendFn(normaliseTimelineFn({ rows: [] }), tFor) === null,
  );
} else {
  check('图表渲染函数可取（否则降级分支有没有接上无法验证）', false);
}

/* ---- 8.e 新增文案键：中英一致、占位符一致、都不含裸含义 ---- */
if (internals !== null && typeof internals.trendGeometry === 'function') {
  // 文案表本身在第 5 组查；这里确认新键是"两处都有且真的被渲染用到"。
  for (const key of ['chartModels', 'chartTrend', 'chartComposition', 'donutAria', 'segmentAria',
    'donutCenter', 'trendEmpty', 'dayRange', 'pointAria']) {
    check(
      '新增文案键 ' + key + ' 在中英两表都存在且被 t(…) 引用',
      new RegExp('^\\s*' + key + '\\s*:', 'm').test(zhBody)
        && new RegExp('^\\s*' + key + '\\s*:', 'm').test(enBody)
        && referenced.has(key),
    );
  }
}

/* ---------------- 汇总 ---------------- */
console.log('');
if (failures.length > 0) {
  console.log('失败 ' + failures.length + ' 项：');
  for (const item of failures) console.log('  - ' + item);
  process.exit(1);
}
console.log('全部通过：' + ok + ' 项布局结构断言（视觉呈现仍需在真实页面确认）。');
