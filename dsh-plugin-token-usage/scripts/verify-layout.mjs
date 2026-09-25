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
 *   7. 席位注册（sidebar.panellist / main / 会话头部 utilities，且不顶掉官方控件）。
 *
 * 与定时任务插件的差异：本插件的界面文案不在 locale/*.json 里，而是 client.js 内部的
 * `const zh = {...}` / `const en = {...}`；locale/*.json 只放插件卡片 meta 与给宿主用的键。
 * 因此文案检查分两处做，两处的键集合都要求一致。
 *
 * 用法：node scripts/verify-layout.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const utilReg = /tryRegister\('sessionUtilities',\s*\{([\s\S]*?)\}\s*,\s*Meter\)/.exec(source);
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
check(
  '三个席位各自 tryRegister（任一失败不拖垮另外两个）',
  (source.match(/tryRegister\(/g) ?? []).length === 3
    && /const tryRegister = \(label, options, Component\)/.test(source)
    && /typeof ctx\.slots\?\.register !== 'function'/.test(source),
);

/* ---------------- 汇总 ---------------- */
console.log('');
if (failures.length > 0) {
  console.log('失败 ' + failures.length + ' 项：');
  for (const item of failures) console.log('  - ' + item);
  process.exit(1);
}
console.log('全部通过：' + ok + ' 项布局结构断言（视觉呈现仍需在真实页面确认）。');
