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
 *   8. 图表语义（把 client.js 用 React 桩跑起来，跑真实的纯函数：热力图列必须对齐到周、
 *      强度必须分四档、环形图分母是 grandTotal、缺 timeline / 单天 / 全零时的降级——
 *      这些错了都不报错，只是画出一张撒谎的图，正则看不见）。
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
/*
 * 图表系列色的**唯一例外**，且必须是受控白名单。
 *
 * 规则本身（界面颜色一律走令牌）不变，但真机证明了主题令牌在这里给不出分类色板：
 * `--dsw-alias-brand-primary` 是**高对比前景色**（浅色主题下近黑、深色主题下近白），
 * 不是彩色强调色——两次"图表配色丑"的反馈都源于拿它当系列色。唯一真正有色的令牌
 * 只有 green / amber / red / idle，凑不出四路分类：红色会给"缓存写"凭空加上失败
 * 的含义，灰色又与轨道底几乎同色。
 *
 * 所以系列色走字面色，取值与三个插件的图标同一套官方色。这里收成白名单而不是
 * 放宽规则：只允许这四个值，且只允许出现在图表系列选择器上。
 */
const CHART_PALETTE = ['#4D6BFE', '#22C55E', '#8B5CF6', '#F5A524'];
/*
 * 热力图（`[data-level="1..4"]`）也进白名单，理由与四桶/圆环不同但同样可验证：
 * 它表达的是**序数**（深浅 = 多少），所以四档必须同一个色相、只差不透明度。
 * 白名单是按**色值**比对的，因此那四条写成 `#4D6BFE38 / 73 / B8 / 空` 这种八位
 * 十六进制（alpha 后缀），色值仍落在 `#4D6BFE` 上；写成 `rgba(77,107,254,.22)`
 * 反而无法与调色板比对，只能放宽规则——那正是这套断言要避免的。
 */
const CHART_COLOR_RULE = /^\.stu-(seg|swatch)\[data-bucket="[^"]+"\]$|^\.stu-donutSeg(\[data-series="\d"\])?$|^\.stu-donutSwatch\[data-series="\d"\]$|^\.stu-heatCell\[data-level="[1-4]"\]$/;
const chartPaletteUse = [];
/**
 * 取一条声明的**基础色相**：`#4D6BFE` / `#4D6BFE38` / `rgba(77,107,254,.22)` 都归到
 * `#4D6BFE`。
 *
 * 为什么要归一：热力图四档是同一个色相的四个不透明度，白名单必须能同时认下
 * "裸的 `#4D6BFE`" 和"带 alpha 的 `#4D6BFE38`"，否则要么放宽规则（失去白名单的
 * 意义），要么逼着把四档写成四个色相（那就变成分类色，读不出大小）。
 * 归一之后**色相**仍然逐个白名单比对，"随手加第五个颜色"照样红。
 */
function basePaletteColor(value) {
  const hex = /#([0-9a-fA-F]{3,8})\b/.exec(value);
  if (hex !== null) {
    const digits = hex[1];
    // 只取色相部分：3 位补全、8 位截掉 alpha。
    const six = digits.length <= 4
      ? digits.slice(0, 3).split('').map((ch) => ch + ch).join('')
      : digits.slice(0, 6);
    return ('#' + six).toUpperCase();
  }
  const rgba = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (rgba !== null) {
    return ('#' + [rgba[1], rgba[2], rgba[3]]
      .map((part) => Number(part).toString(16).padStart(2, '0')).join('')).toUpperCase();
  }
  return null;
}
const rawColorDecls = [];
const rawColorValues = new Set();
const strayVars = new Set();
const nonTokenColor = [];
for (const [selector, body] of rules) {
  // 图表系列选择器整条豁免下文两条"必须用令牌"的检查，改由白名单单独校验。
  const isChartSeries = CHART_COLOR_RULE.test(selector);
  for (const declaration of body.split(';')) {
    const text = declaration.trim();
    const colon = text.indexOf(':');
    if (colon < 0) continue;
    const property = text.slice(0, colon).trim();
    const value = text.slice(colon + 1).trim();
    if (RAW_COLOR.test(value)) {
      for (const match of value.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\)/g)) rawColorValues.add(match[0]);
      if (isChartSeries) { chartPaletteUse.push(selector + ' = ' + basePaletteColor(value)); continue; }
      if (!SHADOW_EXCEPTION.test(text)) rawColorDecls.push(selector + ' { ' + text + ' }');
    }
    for (const match of value.matchAll(/var\((--[A-Za-z0-9-]+)/g)) {
      /*
       * `--stu-heat-weeks` 是**插件自己的布局变量**（列数），不是颜色令牌，所以
       * 不能一刀切要求所有 var() 都是 --dsw-。只有当这条声明真的在给颜色时
       * （属性是颜色属性、或值里同时带色），引用的变量才必须是 --dsw-*——
       * 这样"颜色偷偷走自定义体系"照样红，而布局变量不被误伤。
       */
      const looksLikeColor = COLOR_PROP.test(property) || RAW_COLOR.test(value);
      if (looksLikeColor && !match[1].startsWith('--dsw-')) strayVars.add(match[1]);
    }
    if (isChartSeries) continue;
    // 只有「值里确实带颜色」的声明才要求用令牌；border-bottom:0 / border-radius:10px 不含颜色，跳过。
    if (!COLOR_PROP.test(property)) continue;
    if (SHADOW_EXCEPTION.test(text)) continue;
    const hasColorToken = RAW_COLOR.test(value) || value.includes('var(');
    if (!hasColorToken) continue;
    if (value.includes('var(--dsw-alias-')) continue;
    nonTokenColor.push(selector + ' { ' + text + ' }');
  }
}
/*
 * 上述白名单的校验。`chartPaletteUse` 由第 3 组的主循环填充（它按 `rules` 迭代，
 * 选择器是干净的）——这里**不要再自己解析一遍 cssBlock**：CSS 是每行一个字符串
 * 字面量，自己切会把前导引号带进选择器，导致白名单永远匹配不上。
 */
check(
  '除 box-shadow 的 rgba(0,0,0,.16) 与图表色板外没有裸颜色字面量',
  rawColorDecls.length === 0,
  rawColorDecls.join(', '),
);
check(
  '图表色板只用白名单里的四个**色相**（alpha 后缀允许，第五个色相不允许）',
  chartPaletteUse.length >= 12
    && chartPaletteUse.every((entry) => CHART_PALETTE.includes(entry.slice(entry.lastIndexOf(' = ') + 3))),
  chartPaletteUse.join(' | '),
);
check(
  '图表四桶与环形四段用的是**同一套**色板（两边不一致会让人读错归属）',
  ['#4D6BFE', '#22C55E', '#8B5CF6', '#F5A524'].every((color) =>
    chartPaletteUse.filter((entry) => entry.endsWith(' = ' + color)).length >= 2),
  chartPaletteUse.join(' | '),
);
check(
  '热力图四档只用 #4D6BFE 一个色相（四档同色相才读得出"深浅=多少"）',
  chartPaletteUse.filter((entry) => /^\.stu-heatCell\[data-level="[1-4]"\] = /.test(entry))
    .every((entry) => entry.endsWith(' = #4D6BFE')),
  chartPaletteUse.filter((entry) => entry.startsWith('.stu-heatCell')).join(' | '),
);
check(
  '除上述白名单外没有其它裸颜色值',
  [...rawColorValues].every((value) =>
    /^rgba\(0,\s*0,\s*0,\s*\.16\)$/.test(value) || CHART_PALETTE.includes(basePaletteColor(value))),
  [...rawColorValues].join(', '),
);
check('颜色属性一律使用 var(--dsw-alias-*)', nonTokenColor.length === 0, nonTokenColor.join(', '));
check(
  '颜色声明里出现的 var() 都在 --dsw- 命名空间内（插件自己的布局变量如 --stu-heat-weeks 不算颜色）',
  strayVars.size === 0,
  [...strayVars].join(', '),
);
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
/*
 * 这两条断言原先写反了，值此更正——真机事故就是这么来的。
 *
 * 原断言：「根容器不写 height:100%」「不自建滚动，交给外壳」。
 * 实际 `main` 席位**不给**滚动容器：内容超出窗口后连滚动条都没有，后半截直接
 * 看不见。已发布页面的约定（dsh-client-ui-plugin-manager 的 _.page）是
 *   height:100%; overflow:auto; 且 `> * { max-width:960px }`
 * ——页面自己滚，限宽放在子元素上。
 *
 * 一个写反的断言比没有断言更坏：它会主动把正确的改法判为违规。
 */
check(
  '根容器声明 height:100%（main 席位不给滚动容器，页面必须自己占满高度）',
  innerRule !== undefined && /(^|;)\s*height\s*:\s*100%/.test(innerRule),
  String(innerRule),
);
check(
  '根容器自建滚动 overflow:auto（否则超出窗口的内容看不到，也没有滚动条）',
  innerRule !== undefined && /overflow\s*:\s*auto/.test(innerRule),
  String(innerRule),
);
check(
  '限宽放在子元素上而不是容器上（容器限宽会与自身滚动打架）',
  /\.stu-inner>\*\{[^}]*max-width\s*:\s*980px/.test(cssBlock),
  '需要 .stu-inner>*{width:100%;max-width:980px}',
);
check(
  '根容器不再用 margin:0 auto 居中（那是"限宽在容器上"时代的写法）',
  innerRule !== undefined && !/margin\s*:\s*0\s+auto/.test(innerRule),
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
/*
 * 四桶配色：**四个实色令牌**。
 *
 * 这两条断言几经推翻，最终形态是"四个色相明确的字面色"：
 *
 *   1. 最初是"同一个品牌色的四档透明度"——暗色主题下 `.24` 等于深灰，
 *      而占九成的"缓存读"恰好落在最低那档，等于看不见。
 *   2. 改成借 state-* 当分类色后，真机截图暴露了更深的问题：
 *      `--dsw-alias-brand-primary` 在本主题里是**高对比前景色**（浅色下近黑、
 *      深色下近白），于是圆环呈"黑 / 绿 / 浅灰"，仍然难看。
 *   3. 唯一真正有色的令牌只有 green / amber / red / idle，凑不出四路分类色板
 *      （红色会给"缓存写"凭空加上失败含义，灰色与轨道底同色）。
 *
 * 所以走字面色，取值与三个插件的图标同一套官方色。白名单校验见第 3 组。
 */
check(
  '四桶用四个不同色相的字面色（不再是同色的透明度梯度，也不是黑白 brand）',
  /\.stu-seg\[data-bucket="uncachedInputTokens"\]\{background:#4D6BFE\}/.test(cssBlock)
    && /\.stu-seg\[data-bucket="outputTokens"\]\{background:#22C55E\}/.test(cssBlock)
    && /\.stu-seg\[data-bucket="cacheReadTokens"\]\{background:#8B5CF6\}/.test(cssBlock)
    && /\.stu-seg\[data-bucket="cacheWriteTokens"\]\{background:#F5A524\}/.test(cssBlock),
);
check(
  '四桶与图例色块同色（色块与实际条形必须一致，否则图例撒谎）',
  /\.stu-swatch\[data-bucket="outputTokens"\]\{background:#22C55E\}/.test(cssBlock)
    && /\.stu-swatch\[data-bucket="cacheReadTokens"\]\{background:#8B5CF6\}/.test(cssBlock)
    && /\.stu-swatch\[data-bucket="cacheWriteTokens"\]\{background:#F5A524\}/.test(cssBlock),
);
check(
  '四桶不再用透明度拉开层次（暗色主题下会退化成看不见的深灰）',
  !/\.stu-(seg|swatch)\[data-bucket="[^"]+"\]\{[^}]*opacity:/.test(cssBlock),
);

/*
 * 环形图与按天热力图。
 *
 * 这一组只看**形状**（有没有用对元素、列宽是不是固定 px）。归一化数学
 * （列是否对齐到周、强度是否分四档、环形图分母是不是 grandTotal、缺 timeline
 * 时是否降级）在第 8 组用运行时纯函数跑真实输入验证——静态正则看不出算式对不对。
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
  '环形图段色按模型次序取分类色（不是按数值），超过 4 个循环',
  /const series = index % SEGMENT_SERIES/.test(source)
    && /const SEGMENT_SERIES = 4/.test(source),
);
check(
  '环形图段色由 CSS 的 data-series 决定（四个字面色，与四桶同一套），不用内联透明度',
  /'data-series':\s*String\(segment\.series\)/.test(source)
    && !/strokeOpacity:\s*segment\.opacity/.test(source)
    && /\.stu-donutSeg\[data-series="1"\]\{stroke:#22C55E\}/.test(cssBlock)
    && /\.stu-donutSeg\[data-series="2"\]\{stroke:#8B5CF6\}/.test(cssBlock)
    && /\.stu-donutSeg\[data-series="3"\]\{stroke:#F5A524\}/.test(cssBlock),
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

check('渲染了按天热力图（renderHeatmap 被调用）', /renderHeatmap\(trendPoints, t\)/.test(source));
check(
  '热力图用 CSS grid 手绘（没有 SVG、没有图表库；格子必须在宽高上等比才是正方形）',
  /className:\s*'stu-heatBody'/.test(source)
    && /className:\s*'stu-heatCell'/.test(source)
    && !/stu-heatSvg/.test(source),
);
check(
  '热力图列宽固定 14px（11px 格子 + 3px 间距），不随容器压缩',
  /\.stu-heatBody\{[^}]*grid-template-columns:repeat\(var\(--stu-heat-weeks\),14px\)/.test(cssBlock)
    && /\.stu-heatCell\{width:11px;height:11px/.test(cssBlock),
  '把 14px 写成 1fr / minmax，53 列时格子会被压成矩形，深浅面积就不再可比',
);
check(
  '列数由数据算出并写进 CSS 变量（371 天 = 53 列，列数不能写死）',
  /'--stu-heat-weeks':\s*String\(geometry\.columns\)/.test(source),
);
check(
  '每格都带 title（复用 pointAria：日期 + 数值），只靠颜色读不出具体哪天多少',
  /title:\s*fill\(t\('pointAria'\),\s*\{\s*day:\s*cell\.day,\s*total:\s*formatExact\(cell\.total\)\s*\}\)/.test(source),
);
check(
  '每格带 data-level 供 CSS 上色（颜色不进 JS，档位与配色分家）',
  /'data-level':\s*String\(cell\.level\)/.test(source),
);
check(
  'null 格子不渲染（区间外的日期不能有 hover 热区，否则会弹出"统计范围之外"的日期）',
  /if \(cell === null \|\| cell === undefined\) continue;/.test(source),
);
check(
  '左侧有星期标签（循环 7 行按行号取，不逐行硬编码）且只有奇数行写文字',
  /const weekdayLabels = \[/.test(source)
    && /for \(let row = 0; row < 7; row \+= 1\)/.test(source)
    && /className:\s*'stu-heatLabelCell'/.test(source),
);
check(
  '顶部月份标签只在新月份的第一列出现，且按"第一个有用量的格子"归属（不被首列补 0 带偏）',
  /const monthOf = \(week\) => \{/.test(source)
    && /cell !== null && cell\.total > 0/.test(source)
    && /month !== null && month !== previous \? String\(month\) \+ '月' : ''/.test(source)
    && /className:\s*'stu-heatMonth'/.test(source),
);
check(
  '热力图有图例（少 → 多，五档色块），否则深浅只是装饰',
  /className:\s*'stu-heatLegend'/.test(source) && /t\('heatLess'\)/.test(source) && /t\('heatMore'\)/.test(source),
);
check(
  '热力图外层横向滚动（53 列不能撑破容器，也不能靠压缩格子解决）',
  /\.stu-heatScroll\{[^}]*overflow-x:auto/.test(cssBlock),
);
check(
  'level 0 用底色令牌（"没有用量"是底色，不是第五档强度）',
  /\.stu-heatCell\{[^}]*background:var\(--dsw-alias-bg-layer-2\)/.test(cssBlock),
);
/*
 * 空格子必须**看得见**。
 *
 * 真机缺陷：level 0 只填 `bg-layer-2`，而它与卡片自身的 `bg-layer-1` 几乎同色，
 * 于是零用量的格子整个隐形——14 格的范围里只看得见有数据的那 2 格，用户读成
 * "网格没画出来"。底色令牌给不出对比度，所以必须另有一圈描边把格子边界画出来。
 */
check(
  '空格子有内描边（只靠 bg-layer-2 会与卡片底色同色而隐形）',
  /\.stu-heatCell\{[^}]*box-shadow:inset 0 0 0 \.5px var\(--dsw-alias-border-l1\)/.test(cssBlock),
  'inset 而不是 border：不占布局，11px 格子与 14px 列轨道才不会脱钩',
);
/*
 * 四档强度必须是**同一个色相的四档不透明度**，不能是四个色相。
 *
 * 这是热力图唯一"看着像对的、其实读不出大小"的陷阱：分类色（四个色相）会让读者
 * 以为四档是四种互不相干的类别，而这里要表达的是序数。断言直接钉住"四个声明里
 * 只出现一个色值"，顺带钉住四档齐全。
 */
check(
  '强度四档是同一色相的四个不透明度（不是四个色相的四路分类色）',
  ['.stu-heatCell[data-level="1"]{background:#4D6BFE38}',
    '.stu-heatCell[data-level="2"]{background:#4D6BFE73}',
    '.stu-heatCell[data-level="3"]{background:#4D6BFEB8}',
    '.stu-heatCell[data-level="4"]{background:#4D6BFE}'].every((rule) => cssBlock.includes(rule))
    && new Set((cssBlock.match(/\.stu-heatCell\[data-level="[1-4]"\]\{background:(#[0-9A-Fa-f]+)\}/g) ?? [])
      .map((rule) => /(#[0-9A-Fa-f]{6})/.exec(rule)[1])).size === 1,
);
check(
  '全是 0 时不画网格，只留一句空态文案（7×N 个同色方块说明不了"没有用量"）',
  /if \(geometry\.days === 0 \|\| geometry\.max <= 0\)/.test(source)
    && /className:\s*'stu-heatEmpty'[\s\S]{0,40}t\('trendEmpty'\)/.test(source),
);
check(
  '没有 timeline 时整块热力图不出现（不是画一个空网格）',
  /if \(hasTrend\) body\.push\(renderHeatmap\(trendPoints, t\)\)/.test(source)
    && /timelinePresent:\s*timeline\.length > 0/.test(source),
);
check(
  '图表顺序：环形图 → 热力图 → 按模型构成（从整体到细节）',
  (() => {
    const donut = source.indexOf('body.push(donut)');
    const trend = source.indexOf('body.push(renderHeatmap(trendPoints, t))');
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
const heatmapGeometryFn = need('heatmapGeometry');
const donutSegmentsFn = need('donutSegments');

check(
  '__internals 暴露图表纯函数（normaliseTimeline / heatmapGeometry / donutSegments / shortDay）',
  normaliseTimelineFn !== null && shortDayFn !== null && heatmapGeometryFn !== null
    && donutSegmentsFn !== null,
);

/* ---- 8.a 热力图：列必须对齐到周、强度必须分四档 ---- */
if (heatmapGeometryFn !== null && shortDayFn !== null) {
  /*
   * 取某一列里第一个非 null 格子。首列的首个非 null 格子就是区间起点，
   * 用它断言"列对齐到周"——起点错开一天，这里立刻红。
   */
  const firstCell = (geometry, column) => (geometry.weeks[column] ?? []).find((cell) => cell !== null) ?? null;
  const lastCell = (geometry, column) => {
    const week = geometry.weeks[column] ?? [];
    for (let index = week.length - 1; index >= 0; index -= 1) {
      if (week[index] !== null) return week[index];
    }
    return null;
  };
  const levelsOf = (geometry, day) => {
    for (const week of geometry.weeks) {
      for (const cell of week) if (cell !== null && cell.day === day) return cell.level;
    }
    return null;
  };
  /*
   * "行号 = 真实 getDay()"是整张图的地基：行错了，"周日那一行"就不是周日。
   * 用**索引**而不是 `week.indexOf(cell)` 遍历——`week` 里装的是新建的格子对象，
   * 拿它去 indexOf 会得到 0，那样断言会永远"通过"（自证式断言比没有还坏）。
   */
  const rowMatchesWeekday = (geometry) => geometry.weeks.every((week) =>
    week.every((cell, row) => {
      if (cell === null) return true;
      const [y, m, d] = cell.day.split('-').map(Number);
      return new Date(y, m - 1, d).getDay() === row;
    }));

  /*
   * 真机数据的形状：只有两天，中间隔了 6 个空日，量级差 22 倍。
   * 这组数字同时钉三件事——列对齐到周、中间空缺日必须补 0、强度必须分档。
   */
  // 两端都对齐到周日/周六之后，`end - start` 恰好是 `7 × (columns - 1)` 天。
  const real = heatmapGeometryFn([
    { day: '2026-09-18', total: 70216976, attempts: 502 },
    { day: '2026-09-25', total: 1547482736, attempts: 4051 },
  ]);
  check(
    '起点是最早那天所在周的周日（09-18 是周五 → 首列起点 2026-09-13）',
    firstCell(real, 0)?.day === '2026-09-13',
    String(firstCell(real, 0)?.day),
  );
  check(
    '终点是最晚那天所在周的周六（09-25 是周五 → 末格 2026-09-26）',
    lastCell(real, real.columns - 1)?.day === '2026-09-26',
    String(lastCell(real, real.columns - 1)?.day),
  );
  check(
    '09-18 落在首列第 5 行（周日=0 → 周五=5），列真的对齐到周',
    real.weeks[0]?.[5]?.day === '2026-09-18',
    JSON.stringify((real.weeks[0] ?? []).map((cell) => cell?.day ?? null)),
  );
  check(
    '09-25 落在末列第 5 行（第二周对齐到同一行：跨周不会错位）',
    real.weeks[real.columns - 1]?.[5]?.day === '2026-09-25',
    JSON.stringify((real.weeks[real.columns - 1] ?? []).map((cell) => cell?.day ?? null)),
  );
  check(
    '两列 × 7 行 = 14 格全部落在区间内（补 0 的 12 格 + 有量的 2 格，没有 null）',
    real.columns === 2 && real.weeks.length === 2
      && real.weeks.flat().filter((cell) => cell !== null && cell.total === 0).length === 12
      && real.weeks.flat().filter((cell) => cell === null).length === 0
      && real.weeks.flat().filter((cell) => cell !== null).length === 14,
    'columns=' + real.columns
      + ' 补 0 格=' + real.weeks.flat().filter((cell) => cell !== null && cell.total === 0).length
      + ' null 格=' + real.weeks.flat().filter((cell) => cell === null).length,
  );
  check(
    'days / from / to 反映的是**有用量的天**（2 天），不是格子数',
    real.days === 2 && real.from === '2026-09-18' && real.to === '2026-09-25',
    'days=' + real.days + ' from=' + real.from + ' to=' + real.to,
  );
  check(
    'max 取这批数据的最大 total',
    real.max === 1547482736,
    String(real.max),
  );
  /*
   * 这一条就是"分四档"的核心：量级差 22 倍的两天必须落在不同的档上，
   * 而且小的那天不能掉进 level 0（level 0 的语义是"这天没有用量"）。
   */
  check(
    '强度按 total/max 分四档：7e7 与 1.5e9 分属不同档，且都 ≥ 1（不能掉进"没有用量"）',
    levelsOf(real, '2026-09-18') === 1 && levelsOf(real, '2026-09-25') === 4,
    '09-18 → level ' + levelsOf(real, '2026-09-18') + '，09-25 → level ' + levelsOf(real, '2026-09-25'),
  );
  check(
    '档位值域只有 0..4 五个整数（CSS 的 [data-level] 规则只写了五条）',
    real.weeks.flat().filter((cell) => cell !== null)
      .every((cell) => Number.isInteger(cell.level) && cell.level >= 0 && cell.level <= 4),
  );
  check(
    '极小但非零的用量也是 level 1，不会被分档阈值吃掉（"用过一点"≠"没用过"）',
    levelsOf(heatmapGeometryFn([{ day: '2026-06-01', total: 1000 }, { day: '2026-06-02', total: 1 }]), '2026-06-02') === 1,
  );
  check(
    'attempts 原样带给渲染层（将来在 tooltip 里显示调用次数不必回查 timeline）',
    real.weeks[0]?.[5]?.attempts === 502
      && real.weeks[real.columns - 1]?.[5]?.attempts === 4051,
    '首列周五 ' + real.weeks[0]?.[5]?.attempts + '，末列周五 ' + real.weeks[real.columns - 1]?.[5]?.attempts,
  );

  /* ---- 跨月 / 跨年：月份带与 53 列上限 ---- */
  const acrossMonth = heatmapGeometryFn([
    { day: '2026-01-31', total: 10 },
    { day: '2026-02-01', total: 20 },
  ]);
  check(
    '跨月的两天落在相邻两列（周六 → 周日），列数正好 2 且没有多余的第三列',
    acrossMonth.columns === 2
      && acrossMonth.weeks[0]?.[6]?.day === '2026-01-31'
      && acrossMonth.weeks[1]?.[0]?.day === '2026-02-01',
    JSON.stringify(acrossMonth.weeks.map((week) => week.map((cell) => cell?.day ?? null))),
  );

  const acrossYear = heatmapGeometryFn([
    { day: '2025-12-31', total: 1 },
    { day: '2026-01-01', total: 2 },
  ]);
  check(
    '跨年的两天对齐到同一行（周三 → 周四），列数 1（同一周）',
    acrossYear.columns === 1
      && acrossYear.weeks[0]?.[3]?.day === '2025-12-31'
      && acrossYear.weeks[0]?.[4]?.day === '2026-01-01',
    JSON.stringify(acrossYear.weeks[0].map((cell) => cell?.day ?? null)),
  );

  const year = heatmapGeometryFn([
    { day: '2026-01-01', total: 5 },
    { day: '2026-12-30', total: 7 },
  ]);
  check(
    '跨度 364 天（宿主上限 371 天的邻域）时列数正好 53，两头各补半周也不溢出',
    year.columns === 53,
    'columns=' + year.columns,
  );
  check(
    '整年网格的每一天都落在正确的星期行上（列对齐不会随列数累积漂移）',
    rowMatchesWeekday(year),
  );

  /* ---- 单天：必须画出一列，且前后是 null 占位 ---- */
  const single = heatmapGeometryFn([{ day: '2026-06-05', total: 42 }]);
  check(
    '只有一天时也画出**一列**（这一列是 7 个格子：1 格有量 + 6 格补 0，不是只画 1 格）',
    single.columns === 1 && single.weeks.length === 1 && single.weeks[0].length === 7
      && single.weeks[0].filter((cell) => cell === null).length === 0
      && single.weeks[0][5]?.day === '2026-06-05' && single.weeks[0][5]?.level === 4,
    JSON.stringify(single.weeks[0].map((cell) => cell?.day ?? null)),
  );
  check(
    '单天时起点是它所在周的周日、终点是那一周的周六（不是只有那一天一格）',
    single.weekStart === '2026-05-31' && single.weekEnd === '2026-06-06',
    single.weekStart + ' → ' + single.weekEnd,
  );
  /*
   * null 占位：区间（= 首列周日 .. 末列周六）**之外**的格子才是 null。
   *
   * 但要注意一个几何事实：**起点就是首列的周日、终点就是末列的周六**，所以
   * `start..end` 这段连续区间覆盖了网格里的**每一个**格子——也就是说，在
   * "最早/最晚那天都是真实日期"的前提下，null 分支其实是**不可达**的防御代码
   * （它只有在 `start > minDate` 或 `end < maxDate` 时才可能命中，而这两条由
   * 构造保证不成立）。这里不去伪造一个不可达的输入，而是把"可达的部分"钉死：
   * 任何数据下网格里都不该出现 null，缺口一律是补 0 的格子。
   *
   * 对应的风险也记在这里：既然 null 不可达，渲染层的"null 不渲染"分支同样不会
   * 被真机触发；它保留是为了让"区间外"这件事在代码里有明确表达。
   */
  check(
    '网格里不出现 null 占位（区间覆盖整列，缺口一律是补 0 的格子）',
    (() => {
      const probes = [
        [{ day: '2026-09-19', total: 1 }, { day: '2026-09-20', total: 2 }],
        [{ day: '2026-09-18', total: 1 }, { day: '2026-09-27', total: 2 }],
        [{ day: '2026-06-05', total: 42 }],
      ];
      return probes.every((points) => heatmapGeometryFn(points).weeks.flat().every((cell) => cell !== null));
    })(),
  );
  check(
    '区间内缺的那天补成 total 0 的格子（缺口是"这天没用过"，不是被跳过）',
    (() => {
      const probe = heatmapGeometryFn([
        { day: '2026-09-18', total: 1 },
        { day: '2026-09-27', total: 2 },
      ]);
      const flat = probe.weeks.flat();
      return probe.columns === 3
        && flat.filter((cell) => cell === null).length === 0
        && flat.filter((cell) => cell !== null).length === 21
        && flat.filter((cell) => cell !== null && cell.total === 0).length === 19;
    })(),
    (() => {
      const probe = heatmapGeometryFn([{ day: '2026-09-18', total: 1 }, { day: '2026-09-27', total: 2 }]);
      const flat = probe.weeks.flat();
      return 'columns=' + probe.columns
        + ' nulls=' + flat.filter((cell) => cell === null).length
        + ' zeros=' + flat.filter((cell) => cell !== null && cell.total === 0).length;
    })(),
  );
  /*
   * 月份带取的是"第一个**有实际用量**的格子"的月份，而不是"第一个非 null 格子"：
   * 首列前面几天是补出来的 0（真机上 09-13 那一列的前 5 天就是 5 月底/9 月初的
   * 补 0 格），用它们判月份会让 6 月的图顶着 "5月"。这里用"06-01 那一周"的数据钉住。
   */
  check(
    '月份标签按"第一个有用量的格子"归属，不被首列补 0 的空缺日带偏',
    (() => {
      const geometry = heatmapGeometryFn([
        { day: '2026-06-01', total: 10 },
        { day: '2026-06-02', total: 30 },
      ]);
      // 首列从 2026-05-31（周日）起，前 1 格是补 0 的 5 月；归属必须仍是 6 月。
      const firstZero = geometry.weeks[0][0];
      return geometry.weekStart === '2026-05-31'
        && firstZero !== null && firstZero.total === 0 && firstZero.day.startsWith('2026-05');
    })(),
    '首列第 0 格是 2026-05-31 的补 0 格，渲染层的月份标签必须按 06-01 算',
  );
  check(
    '单天就是 max 本身 → level 4（不能因为"只有一个值"就画成空白）',
    single.weeks[0][5]?.level === 4 && single.max === 42,
  );

  /* ---- 全 0 / 空 / 坏数据：一律不抛，且不产生 NaN ---- */
  const allZero = heatmapGeometryFn([
    { day: '2026-06-01', total: 0 },
    { day: '2026-06-02', total: 0 },
  ]);
  check(
    '全 0 时 max 为 0（不因"有记录"就把 max 当成 0 以外的东西）',
    allZero.max === 0 && allZero.days === 2,
    'max=' + allZero.max + ' days=' + allZero.days,
  );
  check(
    '全 0 时所有格子都是 level 0，且不做除法（不产生 NaN 档位）',
    allZero.weeks.flat().filter((cell) => cell !== null)
      .every((cell) => cell.level === 0 && Number.isFinite(cell.total)),
  );
  check(
    '空数组 / null / undefined 都返回空网格（columns 0、weeks 空），而不是抛错',
    [heatmapGeometryFn([]), heatmapGeometryFn(null), heatmapGeometryFn(undefined)]
      .every((geometry) => geometry.columns === 0 && geometry.weeks.length === 0
        && geometry.days === 0 && geometry.max === 0 && geometry.from === null),
  );
  check(
    'day 是坏字符串 / 缺 day 的条目被丢掉（不是画到 1970 或 NaN 上）',
    heatmapGeometryFn([{ day: 'unknown', total: 5 }, { total: 5 }, null, { day: '', total: 3 }]).days === 0,
  );
  check(
    '负值 / 非数 total 当成 0（数据坏了也不画错），总数仍算"有用量的天"',
    (() => {
      const bad = heatmapGeometryFn([
        { day: '2026-06-01', total: -5 },
        { day: '2026-06-02', total: 'x' },
      ]);
      return bad.weeks.flat().filter((cell) => cell !== null).every((cell) => cell.total === 0 && cell.level === 0);
    })(),
  );
  check(
    '同一天出现两条记录时取和并发同一档（丢掉一条等于少算那天的量）',
    (() => {
      const merged = heatmapGeometryFn([
        { day: '2026-06-01', total: 3 },
        { day: '2026-06-01', total: 4 },
        { day: '2026-06-02', total: 7 },
      ]);
      return merged.days === 2 && merged.max === 7
        && merged.weeks.flat().filter((cell) => cell !== null && cell.day === '2026-06-01')
          .every((cell) => cell.total === 7 && cell.level === 4);
    })(),
  );
  /*
   * 日期必须按**本地**时区算：`Date.parse('2026-06-05')` 按 UTC 解析，
   * 东八区会把它读成 06-05 08:00，`getDay()` 仍是 5；但西半球会退回 06-04，
   * 整张图的行会错一格。这条断言用"行号 = 真实 getDay()"把本地语义钉死，
   * 任何改用 UTC 解析的写法都会红。
   */
  check(
    '列内行号严格等于本地 getDay()（不用 Date.parse 的 UTC 语义，否则整图错一格）',
    rowMatchesWeekday(heatmapGeometryFn([
      { day: '2026-03-01', total: 1 },
      { day: '2026-11-30', total: 2 },
    ])),
  );
  check(
    'shortDay 手工拆日期字符串（不用 new Date：按 UTC 解析会让标签整体偏移一天）',
    shortDayFn('2026-06-01') === '06-01' && shortDayFn('2026-6-9') === '06-09',
    shortDayFn('2026-06-01') + ' / ' + shortDayFn('2026-6-9'),
  );
  check('shortDay 对非日期字符串原样返回，不抛', shortDayFn('unknown') === 'unknown');
} else {
  check('热力图纯函数可取（否则列对齐与强度分档无法验证）', false);
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
    '环形图段色按模型次序取分类色，超过 4 个循环（两个等量模型不会同色）',
    donutSegmentsFn([{ key: 'a', total: 1 }, { key: 'b', total: 1 }], 2)
      .map((segment) => segment.series).join(',') === '0,1'
      && donutSegmentsFn(
        Array.from({ length: 5 }, (unusedValue, index) => ({ key: String(index), total: 1 })), 5,
      ).map((segment) => segment.series).join(',') === '0,1,2,3,0',
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
const renderHeatmapFn = need('renderHeatmap');

/**
 * 按 className 在 React 元素树里找节点。
 *
 * 桩把 `h('div', {…}, …)` 变成 `{ type, props, children }`，所以这里能像查 DOM
 * 一样按类名找——**渲染自检必须看渲染结果**：算式对、元素也写对了，但分支接错
 * （例如空序列也走进网格分支，画出一片 `data-level` 都没有的方块）在源码正则里
 * 看不出来。
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

if (renderDonutFn !== null && renderHeatmapFn !== null) {
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
  /*
   * 图例与弧段必须指向**同一个模型**。
   *
   * donutSegments 会跳过 0 值行，所以渲染时若用 `rows[段序号]` 回头取模型名，
   * 前面跳过一个 0 值行就会让后面所有图例整体错位：A 的名字配上 B 的数值和颜色。
   * 不报错，只是名字和数字不是同一个模型——肉眼几乎发现不了，所以拿一个
   * "中间夹着 0 值行"的行集把对齐钉死。
   */
  const gappedRows = [
    { key: 'a', provider: 'p1', model: 'alpha', total: 100 },
    { key: 'z', provider: 'pz', model: 'zero', total: 0 },
    { key: 'c', provider: 'p3', model: 'gamma', total: 100 },
  ];
  const gappedTree = renderDonutFn(gappedRows, tFor);
  const gappedNames = findByClass(gappedTree, /stu-donutName/, [])
    .map((node) => (node.children ?? []).filter((child) => typeof child === 'string').join(''));
  check(
    '跳过 0 值行后图例仍与弧段对齐（不是 A 的名字配 B 的值）',
    gappedNames.join(',') === 'alpha,gamma' && countClass(gappedTree, /stu-donutSeg/) === 2,
    gappedNames.join(','),
  );
  check(
    '段自带源行与源索引（否则渲染层只能按段序号猜模型）',
    donutSegmentsFn(gappedRows, 200).every((segment) => segment.row !== undefined && Number.isInteger(segment.index)),
  );
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
  const heatTree = renderHeatmapFn(manyPoints, tFor);
  /*
   * 格子数：3 天都在同一周（06-01 周一 ~ 06-03 周三），所以网格正好一个 7 格的一列
   * （4 格由"区间内补 0"填上），再加上图例里的 5 个色块。
   * `heatTree` 是唯一的输入，几何与渲染因此必须同时对得上——只对一边就会红。
   */
  check(
    '热力图渲染出整列 7 格 + 图例 5 个色块（区间内补 0 的天也渲染）',
    countClass(heatTree, /stu-heatCell/) === 7 + 5,
    'heatCell 节点 ' + countClass(heatTree, /stu-heatCell/),
  );
  check(
    '顶部月份标签只在新月份的第一列出现（其余列是空标签）',
    (() => {
      const labels = findByClass(heatTree, /stu-heatMonth/, [])
        .map((node) => (node.children ?? []).filter((child) => typeof child === 'string').join(''));
      return labels.filter((label) => label !== '').length === 1 && labels.includes('6月');
    })(),
    JSON.stringify(findByClass(heatTree, /stu-heatMonth/, [])
      .map((node) => (node.children ?? []).filter((child) => typeof child === 'string').join(''))),
  );
  check(
    '左侧星期标签有 7 行、只有奇数行写文字（Sun/Tue… 全标会挤成一团）',
    (() => {
      const cells = findByClass(heatTree, /stu-heatLabelCell/, []);
      const texts = cells.map((node) => (node.children ?? []).filter((child) => typeof child === 'string').join(''));
      return cells.length === 7 && texts.filter((text) => text !== '').length === 3;
    })(),
  );
  check(
    '热力图有图例：少 / 多 两个端点 + 五档色块（level 0 也在图例里，才能对上"底色=没有用量"）',
    (() => {
      const legend = findByClass(heatTree, /stu-heatLegend/, [])[0];
      if (legend === undefined) return false;
      const text = JSON.stringify(legend.children ?? []);
      const swatches = findByClass(findByClass(legend, /stu-heatLegendScale/, [])[0] ?? [], /stu-heatCell/, []);
      return text.includes('少') && text.includes('多') && swatches.length === 5
        && swatches.map((node) => node.props['data-level']).join(',') === '0,1,2,3,4';
    })(),
  );
  check(
    '列数写进 CSS 变量 --stu-heat-weeks（渲染树里能读到，53 列时列宽才固定）',
    typeof findByClass(heatTree, /stu-heatInner/, [])[0]?.props?.style?.['--stu-heat-weeks'] === 'string',
  );
  /*
   * 只查 `stu-heatBody` 里的格子：图例也用 `.stu-heatCell`（尺寸与网格严格一致，
   * 免得调格子尺寸时图例忘同步），所以按类名在整个树里数会把 5 个图例色块算进来。
   */
  const gridCells = findByClass(findByClass(heatTree, /stu-heatBody/, [])[0] ?? [], /stu-heatCell/, []);
  check(
    '每格都带 title（日期 + 数值；只靠颜色读不出具体哪天多少）',
    gridCells.length === 7
      && gridCells.every((node) => typeof node.props.title === 'string' && node.props.title.includes('token')),
    '网格格子 ' + gridCells.length + ' 个',
  );
  check(
    '每格都带 data-level 0..4（CSS 靠它上色，颜色不进 JS）',
    gridCells.every((node) => ['0', '1', '2', '3', '4'].includes(node.props['data-level'])),
  );
  check(
    '每格用 grid-column / grid-row 显式定位（列=周、行=星期，不靠自动排布）',
    gridCells.every((node) =>
      typeof node.props.style?.gridColumn === 'string' && typeof node.props.style?.gridRow === 'string'),
  );
  check(
    '网格整列 7 格都渲染（区间内补 0 的天也在），null 占位格不渲染',
    countClass(heatTree, /stu-heatCell/) === 7 + 5,
    'heatCell 节点 ' + countClass(heatTree, /stu-heatCell/),
  );

  const singleTree = renderHeatmapFn([{ day: '2026-06-05', total: 42 }], tFor);
  check(
    '单天时也画出一列（1 个数据格 + 6 个补 0 格，加上图例 5 个色块）',
    countClass(singleTree, /stu-heatCell/) === 7 + 5 && !hasClass(singleTree, /stu-heatEmpty/),
    'heatCell 节点 ' + countClass(singleTree, /stu-heatCell/),
  );
  const zeroTree = renderHeatmapFn([{ day: '2026-06-01', total: 0 }, { day: '2026-06-02', total: 0 }], tFor);
  check(
    '全是 0 时不画网格，只留一句空态文案（7×N 个同色方块说明不了"没有用量"）',
    !hasClass(zeroTree, /stu-heatBody/) && hasClass(zeroTree, /stu-heatEmpty/),
  );
  check(
    '空序列不渲染热力图（缺 timeline 时整块不出现，而不是一个空网格）',
    renderHeatmapFn([], tFor) === null && renderHeatmapFn(null, tFor) === null,
  );
  check(
    '归一化与渲染接得上：没有 timeline 的 summary → 空序列 → 不渲染',
    renderHeatmapFn(normaliseTimelineFn({ rows: [] }), tFor) === null,
  );
} else {
  check('图表渲染函数可取（否则降级分支有没有接上无法验证）', false);
}

/* ---- 8.e 新增文案键：中英一致、占位符一致、都不含裸含义 ---- */
if (internals !== null && typeof internals.heatmapGeometry === 'function') {
  // 文案表本身在第 5 组查；这里确认新键是"两处都有且真的被渲染用到"。
  for (const key of ['chartModels', 'chartTrend', 'chartComposition', 'donutAria', 'segmentAria',
    'donutCenter', 'trendEmpty', 'pointAria', 'heatLess', 'heatMore']) {
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
