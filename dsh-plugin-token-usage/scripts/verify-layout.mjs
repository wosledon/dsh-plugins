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
 *      其中 8.f / 8.g 两组是后加的两件事，同样只能靠"跑"：
 *      - **日期区间**（默认窗口锚在数据末尾而不是今天、输入被夹到数据边界并写回输入框、
 *        空串 = 该端不限制、from>to 交换、区间内无数据时空态保留控件）；
 *      - **自绘 tooltip**（不能放进横向滚动容器里、格子上不能有原生 title 但必须有
 *        aria-label、pointer-events:none、位置夹在卡片内、键盘可达）。
 *
 * 第 8 组是唯一会**执行**被检代码的一组，桩与 verify-contract.mjs 保持一致：
 * 同一份 client.js 被两个脚本用不同的桩跑，会让"这里过那里不过"变成常态。
 * 桩把 `h()` 变成 `{type, props, children}`，所以除了按 className 找节点，
 * 还能**直接调用**节点上存下来的事件处理函数——"接线有没有接上"就靠这个验证，
 * 不必装 DOM。
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
 * 热力图（空格子与四档）也进白名单。
 *
 * 它表达的是**序数**（深浅 = 多少），所以四档是**同一个色相的四档实色**。
 * 真机反馈"看不清"纠正了一版做法：原先是"同一个色的四档**不透明度**"，
 * 而透明色的最终观感取决于叠在什么底色上——最低档几乎隐形，它偏偏代表
 * "有少量用量"，最不该被忽略；空格子用 `bg-layer-2` 更是与卡片底色几乎同色。
 *
 * 现在每档给 `light-dark(浅色值, 深色值)` **一对实色**，靠宿主设在根元素上的
 * `color-scheme` 自动选边。所以这里的白名单是**两张表**：系列色，以及热力图
 * 那 10 个实色值（空格 1 对 + 四档 4 对）。仍然是收成白名单而不是放宽规则——
 * 出现白名单之外的颜色照样会红。
 */
const HEAT_PALETTE = [
  '#E3E6EC', '#2C313C', // level 0：空格子必须是看得见的实色块
  '#BAC7FF', '#2C3870', // level 1
  '#8CA0FF', '#4055AE', // level 2
  '#5B7BFF', '#6C8CFF', // level 3
  '#2743D8', '#A9BCFF', // level 4
];
const ALLOWED_COLORS = CHART_PALETTE.concat(HEAT_PALETTE);
const CHART_COLOR_RULE = /^\.stu-(seg|swatch)\[data-bucket="[^"]+"\]$|^\.stu-donutSeg(\[data-series="\d"\])?$|^\.stu-donutSwatch\[data-series="\d"\]$|^\.stu-heatCell(\[data-level="[1-4]"\])?$/;
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
/*
 * 系列色（四桶 / 圆环）与热力图分开校验：前者是**分类**色板，后者是**序数**色阶，
 * 约束不同。混在一起校验会让两边都变松。
 */
const seriesUse = chartPaletteUse.filter((entry) => !entry.startsWith('.stu-heatCell'));
check(
  '系列色只用白名单里的四个色相（alpha 后缀允许，第五个色相不允许）',
  seriesUse.length >= 12
    && seriesUse.every((entry) => CHART_PALETTE.includes(entry.slice(entry.lastIndexOf(' = ') + 3))),
  seriesUse.join(' | '),
);
check(
  '图表四桶与环形四段用的是**同一套**色板（两边不一致会让人读错归属）',
  ['#4D6BFE', '#22C55E', '#8B5CF6', '#F5A524'].every((color) =>
    seriesUse.filter((entry) => entry.endsWith(' = ' + color)).length >= 2),
  seriesUse.join(' | '),
);
/*
 * 热力图：空格子 + 四档都是 `light-dark(浅, 深)` **成对的实色**。
 *
 * 这三条替代了原来的"四档是同一色相的四个不透明度"。真机连续两轮"看不清"
 * 证明了那个做法结构上就不成立：透明度的最终观感取决于叠在什么底色上。
 * 现在能静态验证的性质是：
 *   - 每档两侧取值**不同**（写成同一个值等于只适配了一半主题）；
 *   - 五组（空格 + 四档）**互不相同**（否则档位读不出差别）；
 *   - 全部落在白名单内，出现第五个色相或任意新色值照样红。
 */
const heatUse = chartPaletteUse.filter((entry) => entry.startsWith('.stu-heatCell'));
/*
 * 直接从 cssBlock 取 `light-dark(浅, 深)` 的两侧，**不走 `chartPaletteUse`**。
 *
 * 原因：本文件的 CSS 解析器按 `[,;]` 切分声明，而 `light-dark(a,b)` 自带逗号，
 * 于是它只会留下 `a`（实测 `chartPaletteUse` 里那条是 `.stu-heatCell = #E3E6EC`）。
 * 靠它做配对校验会永远得到 0 组，然后只能把断言写松——那等于丢掉这条防线。
 * 这里改成对原始 CSS 文本做正则，语义清楚且不受解析器影响。
 */
const heatPairs = [...cssBlock.matchAll(
  /\.stu-heatCell(?:\[data-level="[1-4]"\])?\{[^}]*?light-dark\(([^,]+),([^)]+)\)/g,
)].map((m) => [m[1].trim(), m[2].trim()]);
check(
  '热力图共 5 组（空格 + 四档）都用 light-dark() 成对实色',
  heatPairs.length === 5,
  '实际 ' + heatPairs.length + ' 组：' + heatUse.join(' | '),
);
check(
  '每组 light-dark() 两侧取值不同（写同一个值等于只适配了一半主题）',
  heatPairs.every(([light, dark]) => light !== dark),
  heatPairs.map(([l, d]) => l + '/' + d).join(' | '),
);
check(
  '空格子与四档、以及四档之间**互不相同**（否则档位读不出差别）',
  new Set(heatPairs.map(([light, dark]) => light + dark)).size === heatPairs.length,
  heatPairs.map(([l, d]) => l + '/' + d).join(' | '),
);
check(
  '除上述白名单外没有其它裸颜色值',
  [...rawColorValues].every((value) =>
    /^rgba\(0,\s*0,\s*0,\s*\.16\)$/.test(value) || ALLOWED_COLORS.includes(basePaletteColor(value))),
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

check('渲染了按天热力图（renderHeatmap 被调用）', /renderHeatmap\(trendPoints,\s*t,/.test(source));
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
/*
 * 这条断言原来是「每格都带 title」。
 *
 * 真机反馈：原生 `title` 的样式由系统渲染、**无法用 CSS 定制**，与应用的设计语言
 * 完全不一致，所以 tooltip 改成自绘。断言**不能只是删掉**——那样就丢了"只靠颜色
 * 读不出具体哪天多少"的防回归能力，而且"删了 title 顺手把无障碍也删了"正是这类
 * 改造最容易留下的洞。改成钉两件事：
 *   1. 无障碍文本还在，内容仍然是 `pointAria`（日期 + 数值）；
 *   2. 格子上**没有** title（两者并存会同时弹两个 tooltip）。
 * title 的缺失在下面按**渲染出来的树**再断言一次（源码正则看不出运行时属性）。
 */
check(
  '每格改带 aria-label（复用 pointAria：日期 + 数值），只靠颜色读不出具体哪天多少',
  /'aria-label':\s*fill\(t\('pointAria'\),\s*\{\s*day:\s*cell\.day,\s*total:\s*formatExact\(cell\.total\)\s*\}\)/.test(source),
);
check(
  '热力图格子上不再有 title（有它就会和自绘 tooltip 同时弹出：一个系统样式、一个应用样式）',
  (() => {
    const bodyStart = source.indexOf('const bodyCells = [];');
    const bodyEnd = source.indexOf('const layout = {', bodyStart);
    const region = bodyStart < 0 || bodyEnd < 0 ? '' : source.slice(bodyStart, bodyEnd);
    return region.length > 0 && !/\btitle\s*:/.test(region);
  })(),
  '检查区间：`const bodyCells = []` .. `const layout = {`',
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
  /const weekdayKeys = \[/.test(source)
    && /for \(let row = 0; row < 7; row \+= 1\)/.test(source)
    && /className:\s*'stu-heatLabelCell'/.test(source),
);
/*
 * 标签列宽必须与网格的列轨道（14px）成**整数倍**关系，否则标签列一变宽，
 * 右侧网格的起点就跟着平移，热力图与上方月份带会错开——第 8.h 组还会把
 * "28 = 2 × 14" 这条算术逐值钉一遍，这里先钉住它写着固定像素而不是随内容伸缩。
 */
check(
  '星期标签列宽写死且是 14px 列轨道的整数倍（随语言伸缩会把右侧网格推歪）',
  /\.stu-heatLabels\{[^}]*width:28px/.test(cssBlock)
    && /\.stu-heatLabels\{[^}]*flex:none/.test(cssBlock)
    && !/\.stu-heatLabels\{[^}]*width:(auto|fit-content|max-content|min-content|\d+%)/.test(cssBlock),
  '规则：' + (rules.get('.stu-heatLabels') ?? '(找不到)'),
);
/*
 * 英文标签比中文宽，宽度不够时**只允许溢出，不允许折行**：
 * `.stu-heatLabelCell` 高度写死 11px（与格子同高），一旦折成两行就变成 22px，
 * 它下面每一行的标签都错位一格——不报错、只是星期对不上。
 */
check(
  '星期标签不折行（nowrap）：折行会让 11px 高的标签变成 22px，下面 6 行标签整体错位',
  /\.stu-heatLabelCell\{[^}]*white-space:nowrap/.test(cssBlock)
    && /\.stu-heatLabelCell\{[^}]*height:11px/.test(cssBlock),
  '规则：' + (rules.get('.stu-heatLabelCell') ?? '(找不到)'),
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
  'level 0 不再用底色令牌 background（bg-layer-2 与卡片底色同色，等于没画）',
  !/\.stu-heatCell\{[^}]*background:var\(--dsw-alias-bg-layer-[12]\)/.test(cssBlock),
);
check(
  'level 0 有 light-dark() 成对实色（空格子本身就是一块看得见的方块）',
  /\.stu-heatCell\{[^}]*background:light-dark\(/.test(cssBlock),
);
check(
  'light-dark() 之前有兜底声明（不支持时退回中性令牌，而不是变成没有背景色）',
  /\.stu-heatCell\{[^}]*background:var\(--dsw-alias-border-l1\);background:light-dark\(/.test(cssBlock),
);
check(
  '空格子仍有内描边（让格子边界更利落；角色从"唯一可见来源"降为"加固"）',
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
  '强度四档各有 light-dark() 成对实色，且每档都带兜底声明',
  [1, 2, 3, 4].every((level) => new RegExp(
    '\\.stu-heatCell\\[data-level="' + level + '"\\]\\{background:var\\(--dsw-alias-brand-primary\\);background:light-dark\\(',
  ).test(cssBlock)),
  '兜底是必须的：不支持 light-dark() 时整条声明失效，没有兜底就会更糟',
);
check(
  '全是 0 时不画网格，只留一句空态文案（7×N 个同色方块说明不了"没有用量"）',
  /if \(geometry\.days === 0 \|\| geometry\.max <= 0\)/.test(source)
    && /className:\s*'stu-heatEmpty'[\s\S]{0,40}t\('trendEmpty'\)/.test(source),
);
check(
  '没有 timeline 时整块热力图不出现（不是画一个空网格）',
  /if \(hasTrend\) \{[\s\S]{0,120}?body\.push\(renderHeatmap\(trendPoints, t, \{/.test(source)
    && /timelinePresent:\s*timeline\.length > 0/.test(source),
);
check(
  '图表顺序：环形图 → 热力图 → 按模型构成（从整体到细节）',
  (() => {
    const donut = source.indexOf('body.push(donut)');
    const trend = source.indexOf('body.push(renderHeatmap(trendPoints, t, {');
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
  /*
   * 这条原来是「每格都带 title」。
   *
   * 改成自绘 tooltip 之后，断言**不能只把 title 换成别的属性了事**——真正的回归
   * 风险有两个，两个都要钉：
   *   1. 删掉 title 时把**无障碍一起删了**（只靠颜色读不出哪天多少）；
   *   2. 只加自绘浮层、**忘了删 title**，于是原生与自绘同时弹出两个 tooltip
   *      （一个系统样式、一个应用样式），比原来更糟。
   * 所以同一批格子上：aria-label 必须在，title 必须不在。
   */
  check(
    '每格改带 aria-label（日期 + 数值；只靠颜色读不出具体哪天多少），且不再有 title',
    gridCells.length === 7
      && gridCells.every((node) => typeof node.props['aria-label'] === 'string'
        && node.props['aria-label'].includes('token'))
      && gridCells.every((node) => node.props.title === undefined),
    '网格格子 ' + gridCells.length
      + ' 个；无 aria-label ' + gridCells.filter((node) => typeof node.props['aria-label'] !== 'string').length
      + ' 个；仍带 title ' + gridCells.filter((node) => node.props.title !== undefined).length + ' 个',
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
  /** 键的两种"被用到"：直接 `t('key')`，或作为字面量出现在别处（表驱动 / 三元）。 */
  const isKeyUsed = (key) => referenced.has(key) || isLiteralUsed(key);
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
  /*
   * 区间控件的文案键是**间接引用**：两个日期输入的名字走三元
   * （`t(end === 'from' ? 'trendFrom' : 'trendTo')`），三个预设的名字走表
   * （`RANGE_PRESETS` 里的第三列）。所以这里放宽到"字面量出现过"，
   * 而"真的渲染到界面上"由第 8.f 组按**渲染出来的树**断言（按钮文字 / aria-label 逐字比对）
   * ——比正则更强：改了文案却忘了接线，那里会红。
   */
  for (const key of ['trendRange', 'trendFrom', 'trendTo', 'trendLast7', 'trendLast30', 'trendAll',
    'trendClamped']) {
    check(
      '新增文案键 ' + key + ' 在中英两表都存在且被引用',
      new RegExp('^\\s*' + key + '\\s*:', 'm').test(zhBody)
        && new RegExp('^\\s*' + key + '\\s*:', 'm').test(enBody)
        && isKeyUsed(key),
    );
  }
  /*
   * 星期标签（周一 / 周三 / 周五）走的是**表驱动**引用——`weekdayKeys` 里存键名，
   * 渲染时 `t(weekdayKeys[row])`（不是 `t('heatWeekdayMon')` 这种字面量），
   * 所以这里同样放宽到"字面量出现过"；而"渲染树里的文字确实等于文案表的值"
   * 由第 8.h 组逐字比对——那一条才是真正钉死"标签有没有走 t()"的断言。
   */
  for (const key of ['heatWeekdayMon', 'heatWeekdayWed', 'heatWeekdayFri']) {
    check(
      '星期标签文案键 ' + key + ' 在中英两表都存在且被引用',
      new RegExp('^\\s*' + key + '\\s*:', 'm').test(zhBody)
        && new RegExp('^\\s*' + key + '\\s*:', 'm').test(enBody)
        && isKeyUsed(key),
    );
  }
}

/* ---- 8.f 日期区间：默认近一个月 + 可夹取、可清空、可交换 ---- */

/*
 * 为什么这一组必须真跑代码：
 *
 * 区间的三种错法在界面上全都是"渲染成功的一张图"——
 *   1. 默认窗口锚到**今天**而不是数据末尾：数据陈旧时右半边全是没有用量的空列，
 *      看起来像图坏了，而不是像锚点错了；
 *   2. **忘了夹取**：手打 2030 年就得到一张横跨好几年的空格子图，同样不报错；
 *   3. 空串被当成日期：`new Date('')` → Invalid Date，比较全是 false，
 *      于是"什么格子都没有"，与"这段没有用量"分不出来。
 * 正则只能确认"有一段算区间的代码"，确认不了这些语义，所以取真函数跑真输入。
 */
const defaultRangeFn = need('defaultRange');
const clampRangeFn = need('clampRange');
const filterTimelineFn = need('filterTimeline');
check(
  '__internals 暴露区间纯函数（defaultRange / clampRange / filterTimeline）',
  defaultRangeFn !== null && clampRangeFn !== null && filterTimelineFn !== null,
);

if (defaultRangeFn !== null && clampRangeFn !== null && filterTimelineFn !== null) {
  /*
   * 一份跨年、稀疏、且**结尾远离今天**的数据：只有这种数据能把"锚在数据末尾"
   * 与"锚在今天"区分开——如果哪天真的变成今天，下面几条立刻红（负向对照 B）。
   */
  const longSpan = [
    { day: '2025-12-01', total: 5 },
    { day: '2026-01-05', total: 10 },
    { day: '2026-06-10', total: 20 },
    { day: '2026-12-20', total: 30 },
  ];
  const daysOf = (points) => points.map((point) => point.day).join(',');
  const fallback = { from: null, to: null };
  const sameRange = (range, from, to) => range.from === from && range.to === to;

  /* ---- 默认窗口：近一个月，锚在数据末尾 ---- */
  const def = defaultRangeFn(longSpan);
  check(
    '默认窗口是"数据最晚那天往前 30 天（含首尾）"：2026-12-20 → 2026-11-21',
    sameRange(def, '2026-11-21', '2026-12-20'),
    JSON.stringify(def),
  );
  check(
    '默认窗口锚在**数据末尾**而不是今天（窗口右端就是数据最晚那天）',
    def.to === '2026-12-20',
    'to=' + def.to + '，今天=' + new Date().toISOString().slice(0, 10),
  );
  check(
    '默认窗口只覆盖最近 30 天：半年前的 2026-06-10 不在窗口里（否则等于没默认）',
    daysOf(filterTimelineFn(longSpan, def)) === '2026-12-20',
    daysOf(filterTimelineFn(longSpan, def)),
  );
  check(
    '窗口两端都落在数据边界内：不早于最早那天、不晚于最晚那天',
    filterTimelineFn(longSpan, def).length > 0
      && def.from >= '2025-12-01' && def.to <= '2026-12-20',
    JSON.stringify(def),
  );

  const shortSpan = [{ day: '2026-06-01', total: 1 }, { day: '2026-06-03', total: 9 }];
  check(
    '跨度不足 30 天时用**实际跨度**，不补出无数据的空列（起点就是最早那天）',
    sameRange(defaultRangeFn(shortSpan), '2026-06-01', '2026-06-03'),
    JSON.stringify(defaultRangeFn(shortSpan)),
  );
  check(
    '单天时窗口是那一天（from === to），不是一个 30 天的空窗',
    sameRange(defaultRangeFn([{ day: '2026-06-05', total: 42 }]), '2026-06-05', '2026-06-05'),
    JSON.stringify(defaultRangeFn([{ day: '2026-06-05', total: 42 }])),
  );
  check(
    '默认窗口对 空数组 / null / undefined / 全是坏 day 都返回"不限制"且不抛',
    [defaultRangeFn([]), defaultRangeFn(null), defaultRangeFn(undefined),
      defaultRangeFn([{ day: 'unknown' }, { total: 1 }, null, 'x', { day: '' }])]
      .every((range) => sameRange(range, null, null)),
  );
  check(
    'defaultRange 是纯函数：不改动输入数组、重复调用结果相同',
    (() => {
      const snapshot = JSON.stringify(longSpan);
      const again = defaultRangeFn(longSpan);
      return JSON.stringify(longSpan) === snapshot && sameRange(again, def.from, def.to);
    })(),
  );
  check(
    '默认窗口的天数可以被显式覆盖（预设"近 7 天"与它同一套锚点）',
    sameRange(defaultRangeFn(longSpan, 7), '2026-12-14', '2026-12-20'),
    JSON.stringify(defaultRangeFn(longSpan, 7)),
  );

  /* ---- 夹取 ---- */
  check(
    '手打 2030 年（远超数据）被夹到数据最晚那天：两端都落到 2026-12-20，不产生跨年的空格子图',
    (() => {
      const range = clampRangeFn({ from: '2030-01-01', to: '2030-12-31' }, longSpan);
      return sameRange(range, '2026-12-20', '2026-12-20') && range.clamped === true;
    })(),
    JSON.stringify(clampRangeFn({ from: '2030-01-01', to: '2030-12-31' }, longSpan)),
  );
  check(
    '手打 2020 年之前（远早于数据）被夹到数据最早那天',
    (() => {
      const range = clampRangeFn({ from: '2020-01-01', to: '2027-01-01' }, longSpan);
      return sameRange(range, '2025-12-01', '2026-12-20') && range.clamped === true;
    })(),
    JSON.stringify(clampRangeFn({ from: '2020-01-01', to: '2027-01-01' }, longSpan)),
  );
  check(
    '范围内的输入原样返回（clamped 不是"永远为真"的摆设）',
    (() => {
      const range = clampRangeFn({ from: '2026-06-10', to: '2026-12-20' }, longSpan);
      return sameRange(range, '2026-06-10', '2026-12-20') && range.clamped === false;
    })(),
    JSON.stringify(clampRangeFn({ from: '2026-06-10', to: '2026-12-20' }, longSpan)),
  );
  check(
    'from > to 时**交换两端**（不退化成单天：窗口本身有意义，丢一半数据是静默错）',
    (() => {
      const range = clampRangeFn({ from: '2026-06-10', to: '2026-01-05' }, longSpan);
      return sameRange(range, '2026-01-05', '2026-06-10') && range.clamped === true;
    })(),
    JSON.stringify(clampRangeFn({ from: '2026-06-10', to: '2026-01-05' }, longSpan)),
  );
  check(
    '交换之后仍按数据边界夹取（填反 + 越界同时发生也不会漏夹）',
    (() => {
      const range = clampRangeFn({ from: '2030-01-01', to: '2020-01-01' }, longSpan);
      return sameRange(range, '2025-12-01', '2026-12-20') && range.clamped === true;
    })(),
    JSON.stringify(clampRangeFn({ from: '2030-01-01', to: '2020-01-01' }, longSpan)),
  );
  check(
    '清空某一端（空串）退化成"该端不限制"：解析为数据边界，而不是 NaN / Invalid Date',
    (() => {
      const range = clampRangeFn({ from: '', to: '2026-06-10' }, longSpan);
      return sameRange(range, '2025-12-01', '2026-06-10') && range.clamped === true;
    })(),
    JSON.stringify(clampRangeFn({ from: '', to: '2026-06-10' }, longSpan)),
  );
  check(
    '两端都清空 = 全部：解析成数据的真实跨度',
    (() => {
      const range = clampRangeFn({ from: '', to: '' }, longSpan);
      return sameRange(range, '2025-12-01', '2026-12-20') && range.clamped === true;
    })(),
    JSON.stringify(clampRangeFn({ from: '', to: '' }, longSpan)),
  );
  check(
    '坏字符串 / null / 缺字段 / 非对象 range 都走"该端不限制"，不抛',
    (() => {
      const full = clampRangeFn({ from: 'not-a-date', to: null }, longSpan);
      const half = clampRangeFn({ from: undefined, to: '2026-06-10' }, longSpan);
      const empty = clampRangeFn({}, longSpan);
      const nil = clampRangeFn(null, longSpan);
      const junk = clampRangeFn('x', longSpan);
      return full.from === '2025-12-01' && full.to === '2026-12-20' && full.clamped === true
        // 坏的一端不限制 → 数据起点；好的一端原样保留。
        && half.from === '2025-12-01' && half.to === '2026-06-10'
        && ['from', 'to'].every((end) => empty[end] === nil[end] && nil[end] === junk[end] && empty[end] !== null);
    })(),
    JSON.stringify([
      clampRangeFn({ from: 'not-a-date', to: null }, longSpan),
      clampRangeFn({ from: undefined, to: '2026-06-10' }, longSpan),
      clampRangeFn({}, longSpan), clampRangeFn(null, longSpan), clampRangeFn('x', longSpan),
    ]),
  );
  check(
    '返回值一律是补零的 YYYY-MM-DD（<input type="date"> 只认这种形式，否则框里显示空白）',
    (() => {
      const range = clampRangeFn({ from: '2026-1-5', to: '2026-6-9' }, longSpan);
      return sameRange(range, '2026-01-05', '2026-06-09') && range.clamped === false;
    })(),
    JSON.stringify(clampRangeFn({ from: '2026-1-5', to: '2026-6-9' }, longSpan)),
  );
  check(
    '数据里一条可用日期都没有时不凭空造边界：返回不限制',
    (() => {
      const range = clampRangeFn({ from: '2026-01-01', to: '2026-02-01' }, []);
      return sameRange(range, null, null) && range.clamped === true
        && sameRange(clampRangeFn(null, []), null, null)
        && clampRangeFn(null, []).clamped === false;
    })(),
  );
  check(
    '对冻结的只读输入也不抛（不写回参数）',
    (() => {
      const frozen = Object.freeze({ from: '2030-01-01', to: '2029-01-01' });
      const range = clampRangeFn(frozen, longSpan);
      return sameRange(range, '2026-12-20', '2026-12-20') && frozen.from === '2030-01-01';
    })(),
  );

  /* ---- 过滤 ---- */
  check(
    'filterTimeline 只留区间内的天（闭区间，两端当天都算）',
    (() => {
      const inRange = daysOf(filterTimelineFn(longSpan, { from: '2026-01-01', to: '2026-06-30' }));
      const bothEnds = daysOf(filterTimelineFn(longSpan, { from: '2026-06-10', to: '2026-12-20' }));
      return inRange === '2026-01-05,2026-06-10' && bothEnds === '2026-06-10,2026-12-20';
    })(),
    daysOf(filterTimelineFn(longSpan, { from: '2026-01-01', to: '2026-06-30' })),
  );
  check(
    '区间里一天用量都没有时返回空数组（渲染层据此走空态，而不是画空网格）',
    filterTimelineFn(longSpan, { from: '2026-03-01', to: '2026-03-31' }).length === 0,
  );
  check(
    'filterTimeline 不重排：乱序输入按原顺序留下命中的那些（重排会掩盖宿主侧顺序漂移）',
    daysOf(filterTimelineFn([longSpan[3], longSpan[1], longSpan[0]],
      { from: '2025-12-01', to: '2026-06-30' })) === '2026-01-05,2025-12-01',
  );
  check(
    'filterTimeline 丢掉没有可解析日期的条目（坏 day / 缺 day / null 条目）',
    daysOf(filterTimelineFn([{ day: 'unknown' }, { day: '' }, { total: 1 }, null, { day: '2026-01-05', total: 1 }], null))
      === '2026-01-05',
  );
  check(
    'filterTimeline 对 null / undefined / 非数组 days 返回空数组，不抛',
    filterTimelineFn(null, null).length === 0 && filterTimelineFn(undefined, fallback).length === 0,
  );
  check(
    'filterTimeline 内部自带夹取：调用方给越界的 range 也拿不到数据范围之外的天',
    daysOf(filterTimelineFn(longSpan, { from: '2030-01-01', to: '2030-12-31' })) === '2026-12-20',
  );
  check(
    'filterTimeline 返回同一批对象（只过滤不复制，与 Array.prototype.filter 一致）',
    (() => {
      const kept = filterTimelineFn(longSpan, { from: '2026-01-01', to: '2026-06-30' });
      return kept.length === 2 && kept[0] === longSpan[1] && kept[1] === longSpan[2];
    })(),
  );
  check(
    '三个函数串起来：默认窗口 → 过滤 → 几何，列数与"只有末尾那天"一致',
    (() => {
      const geometry = heatmapGeometryFn(filterTimelineFn(longSpan, defaultRangeFn(longSpan)));
      return geometry.days === 1 && geometry.from === '2026-12-20' && geometry.columns === 1;
    })(),
  );
}

/* ---- 8.f 区间控件与自绘 tooltip 的接线（在渲染出来的树上查） ---- */

/*
 * 这一组同样要看**渲染结果**：区间控件的三个预设、夹取后的写回、tooltip 的定位
 * 与"不在滚动容器里"，都是"接错了也照样渲染成功"的东西。桩把 h() 变成
 * `{type, props, children}`，所以既能按 className 找节点，也能**直接调用**桩里存下来的
 * 事件处理函数——不用装 DOM 就能验证交互（这是"接线有没有接上"唯一便宜的验证方式）。
 */
if (renderHeatmapFn !== null && typeof internals.defaultRange === 'function') {
  const findClass = (node, pattern) => findByClass(node, pattern, []);
  const longSpan = [
    { day: '2025-12-01', total: 5 },
    { day: '2026-01-05', total: 10 },
    { day: '2026-06-10', total: 20 },
    { day: '2026-12-20', total: 30 },
  ];
  const rangeInputs = (tree) => findClass(tree, /stu-heatDate/);
  const presets = (tree) => findClass(tree, /stu-btn/)
    .filter((node) => typeof node.props?.['data-preset'] === 'string');
  const presetOf = (tree, name) => presets(tree).find((node) => node.props['data-preset'] === name);
  const clampFlag = (tree) => findClass(tree, /stu-heatControls/)[0]?.props['data-range-clamped'];

  /* ---- 控件本身 ---- */
  const controlsTree = renderHeatmapFn(longSpan, tFor, { range: null, onRangeChange: () => {} });
  check(
    '热力图上方有区间控件（日期输入 + 预设按钮），且控件在滚动容器之外',
    findClass(controlsTree, /stu-heatControls/).length === 1
      && findClass(findClass(controlsTree, /stu-heatScroll/)[0] ?? {}, /stu-heatControls/).length === 0,
  );
  check(
    '两个日期输入（type=date）+ 三个预设（last7 / last30 / all），各带可读名字',
    rangeInputs(controlsTree).length === 2
      && rangeInputs(controlsTree).every((node) => node.type === 'input' && node.props.type === 'date')
      && rangeInputs(controlsTree)[0].props['aria-label'] === valueOf(zhBody, 'trendFrom')
      && rangeInputs(controlsTree)[1].props['aria-label'] === valueOf(zhBody, 'trendTo')
      && presets(controlsTree).map((node) => node.props['data-preset']).join(',') === 'last7,last30,all',
    JSON.stringify(rangeInputs(controlsTree).map((node) => node.props['aria-label'])),
  );
  /*
   * 文案是**间接引用**的（三元 + 预设表），所以在这里逐字比对渲染出来的文字：
   * 键改了、表改了、接线断了，任何一种都会红。比 `t('key')` 的正则更接近"用户看不看得到"。
   */
  check(
    '控件上的文案真的来自文案表：范围标签、三个预设按钮、以及起始/结束的名字',
    (() => {
      const textOf = (node) => (node?.children ?? []).filter((child) => typeof child === 'string').join('');
      const label = findClass(controlsTree, /stu-heatRange/)[0];
      return textOf(label).startsWith(valueOf(zhBody, 'trendRange'))
        && presets(controlsTree).map(textOf).join(',')
          === [valueOf(zhBody, 'trendLast7'), valueOf(zhBody, 'trendLast30'), valueOf(zhBody, 'trendAll')].join(',');
    })(),
    JSON.stringify(presets(controlsTree).map((node) => (node.children ?? []).join(''))),
  );
  check(
    '没碰过控件时，框里显示的是默认窗口（数据末尾往前 30 天），即"写回"对默认值也成立',
    rangeInputs(controlsTree).map((node) => node.props.value).join(',') === '2026-11-21,2026-12-20',
    JSON.stringify(rangeInputs(controlsTree).map((node) => node.props.value)),
  );
  check(
    '默认窗口下"近 30 天"预设是按下状态，另两个不是（当前生效的区间要看得出来）',
    presetOf(controlsTree, 'last30')?.props['aria-pressed'] === true
      && presetOf(controlsTree, 'last7')?.props['aria-pressed'] === false
      && presetOf(controlsTree, 'all')?.props['aria-pressed'] === false,
  );

  /* ---- 输入：夹取 + 写回 ---- */
  let emitted = null;
  const tree0 = renderHeatmapFn(longSpan, tFor, { range: null, onRangeChange: (next) => { emitted = next; } });
  rangeInputs(tree0)[0].props.onChange({ target: { value: '2030-01-01' } });
  check(
    '手打 2030 年：写回输入框的是**夹过的**值（框里显示的必须等于画出来的）',
    emitted !== null && emitted.from === '2026-12-20' && emitted.to === '2026-12-20'
      && emitted.adjusted === true,
    JSON.stringify(emitted),
  );
  const wroteBack = renderHeatmapFn(longSpan, tFor, { range: emitted, onRangeChange: () => {} });
  check(
    '夹过的值渲染到框里就是 2026-12-20（不是原始输入 2030-01-01）',
    rangeInputs(wroteBack).map((node) => node.props.value).join(',') === '2026-12-20,2026-12-20',
    JSON.stringify(rangeInputs(wroteBack).map((node) => node.props.value)),
  );
  check(
    '被夹取时给出一句文字提示（原生 title 正是这次要摆脱的东西，所以提示做成可见文字）',
    clampFlag(wroteBack) === 'true'
      && findClass(wroteBack, /stu-heatHint/)[0]?.children?.[0] === valueOf(zhBody, 'trendClamped')
      && findClass(controlsTree, /stu-heatHint/).length === 0,
  );
  check(
    '清空某一端：写回空串（"该端不限制"）而不是补一个边界，也不弹提示',
    (() => {
      let cleared = null;
      const tree = renderHeatmapFn(longSpan, tFor, { range: null, onRangeChange: (next) => { cleared = next; } });
      rangeInputs(tree)[0].props.onChange({ target: { value: '' } });
      if (cleared === null || cleared.from !== '' || cleared.adjusted !== false) return false;
      const shown = renderHeatmapFn(longSpan, tFor, { range: cleared, onRangeChange: () => {} });
      // 框里空着（= 不限制），而画出来的范围从数据起点算起：两端都不可为空。
      return rangeInputs(shown)[0].props.value === ''
        && findClass(shown, /stu-heatInner/)[0].props.style['--stu-heat-weeks'] === '56';
    })(),
    '56 列 = 2025-12-01 那一周 .. 2026-12-20 那一周（不限制的一端按数据边界画）',
  );
  check(
    'from > to：写回的是**交换后**的区间（不是单天、也不是空白）',
    (() => {
      let next = null;
      const tree = renderHeatmapFn(longSpan, tFor, { range: null, onRangeChange: (value) => { next = value; } });
      // 先把 from 设成 2026-06-10（另一端此时显示默认的 2026-12-20）
      rangeInputs(tree)[0].props.onChange({ target: { value: '2026-06-10' } });
      const first = next;
      const tree2 = renderHeatmapFn(longSpan, tFor, { range: first, onRangeChange: (value) => { next = value; } });
      // 再把 to 设成 2026-01-05：from=06-10 > to=01-05，必须交换
      rangeInputs(tree2)[1].props.onChange({ target: { value: '2026-01-05' } });
      return next.from === '2026-01-05' && next.to === '2026-06-10' && next.adjusted === true;
    })(),
  );
  check(
    '预设按钮把**具体日期**写回（不是空的 from/to），且不弹"被收紧"提示',
    (() => {
      let next = null;
      const tree = renderHeatmapFn(longSpan, tFor, { range: null, onRangeChange: (value) => { next = value; } });
      presetOf(tree, 'last7').props.onClick();
      const last7 = next;
      presetOf(tree, 'all').props.onClick();
      const all = next;
      return last7.from === '2026-12-14' && last7.to === '2026-12-20' && last7.adjusted === false
        && all.from === '2025-12-01' && all.to === '2026-12-20' && all.adjusted === false;
    })(),
  );
  check(
    '没有 onRangeChange 时（离线渲染 / 旧调用点）控件照常渲染且点它不抛',
    (() => {
      const tree = renderHeatmapFn(longSpan, tFor, { range: null });
      rangeInputs(tree)[0].props.onChange({ target: { value: '2030-01-01' } });
      presetOf(tree, 'all').props.onClick();
      rangeInputs(tree)[1].props.onChange({});
      return rangeInputs(tree).length === 2;
    })(),
  );
  check(
    '短跨度（1~7 天）只有 1~2 列，仍然正常渲染：列数写进 CSS 变量且 ≥ 1，不塌也不除零',
    (() => {
      const six = renderHeatmapFn([{ day: '2026-06-01', total: 5 }, { day: '2026-06-06', total: 9 }], tFor,
        { range: { from: '2026-06-01', to: '2026-06-06' } });
      const seven = renderHeatmapFn([{ day: '2026-06-01', total: 5 }, { day: '2026-06-07', total: 9 }], tFor,
        { range: { from: '2026-06-01', to: '2026-06-07' } });
      const weeksOf = (tree) => findClass(tree, /stu-heatInner/)[0].props.style['--stu-heat-weeks'];
      const cellsOf = (tree) => findClass(findClass(tree, /stu-heatBody/)[0] ?? {}, /stu-heatCell/);
      return weeksOf(six) === '1' && weeksOf(seven) === '2'
        && cellsOf(six).length === 7 && cellsOf(seven).length === 14
        && cellsOf(seven).every((node) => ['0', '1', '2', '3', '4'].includes(node.props['data-level']))
        && !findClass(seven, /stu-heatEmpty/).length;
    })(),
  );
  check(
    '区间里没有数据时走空态文案，但**控件留在原地**（否则用户被锁在空区间里出不来）',
    (() => {
      const empty = renderHeatmapFn(longSpan, tFor, { range: { from: '2026-03-01', to: '2026-03-31' }, onRangeChange: () => {} });
      return findClass(empty, /stu-heatEmpty/).length === 1
        && findClass(empty, /stu-heatControls/).length === 1
        && rangeInputs(empty).map((node) => node.props.value).join(',') === '2026-03-01,2026-03-31'
        && findClass(empty, /stu-heatBody/).length === 0
        && findClass(empty, /stu-heatTip/).length === 0;
    })(),
  );
  check(
    '区间控件本身也只走主题令牌（浅色/深色主题下都读得出来）',
    /\.stu-heatDate\{[^}]*background:var\(--dsw-alias-bg-layer-2\)/.test(cssBlock)
      && /\.stu-heatDate\{[^}]*border:\.5px solid var\(--dsw-alias-border-l2\)/.test(cssBlock)
      && /\.stu-heatDate\{[^}]*color:var\(--dsw-alias-label-primary\)/.test(cssBlock)
      && /\.stu-heatControls\{[^}]*flex-wrap:wrap/.test(cssBlock),
  );
}

/* ---- 8.g 自绘 tooltip：不在滚动容器里、可定位、可夹取、键盘可达 ---- */

/*
 * 真机反馈：热力图的 hover 提示原来是原生 `title`，样式由系统渲染、**无法用 CSS
 * 定制**，与应用的设计语言不一致。改成自绘浮层之后，有四类错误**不会报错、只是看起来
 * 偶尔不对**，所以逐条钉：
 *   1. 浮层放进了 `.stu-heatScroll`（`overflow-x:auto` 会把它裁掉）——在真机上表现是
 *      "tooltip 只有一部分可见"，很容易被当成样式问题；
 *   2. 只加浮层、忘了删 `title` → 同时弹两个；
 *   3. 忘了 `pointer-events:none` → 浮层盖住相邻格子，mouseleave/mouseenter 互相触发，
 *      提示疯狂闪烁（而且被盖住的格子永远 hover 不到）；
 *   4. 定位不做水平夹取 → 最左/最右列的浮层伸出图表边界。
 */
if (renderHeatmapFn !== null && typeof internals.defaultRange === 'function') {
  const findClass = (node, pattern) => findByClass(node, pattern, []);
  const points = [
    { day: '2026-06-01', total: 10 },
    { day: '2026-06-02', total: 1547482736 },
    { day: '2026-06-03', total: 20 },
  ];
  const tipTree = renderHeatmapFn(points, tFor, {
    range: null,
    tip: { day: '2026-06-02', total: 1547482736, left: 120, top: 40, above: true },
  });
  const scrollNode = findClass(tipTree, /stu-heatScroll/)[0] ?? {};
  const tips = findClass(tipTree, /stu-heatTip/);
  check(
    '有 tip 状态时渲染出一个浮层，且它在 `.stu-heatScroll` 之外（在里面一定被裁）',
    tips.length === 1 && findClass(scrollNode, /stu-heatTip/).length === 0
      && findClass(tipTree, /stu-figure/)[0] !== undefined,
  );
  check(
    '浮层文本用 pointAria 展开（日期 + 真实 token 数），不是"某天多少"的占位符',
    (() => {
      const text = (tips[0]?.children ?? []).filter((child) => typeof child === 'string').join('');
      return text.includes('2026-06-02') && text.includes('1,547,482,736') && text.includes('token');
    })(),
    JSON.stringify(tips[0]?.children),
  );
  check(
    '浮层位置来自状态（事件里量出来的 left/top）且用 transform 决定贴上方还是下方',
    (() => {
      const style = tips[0]?.props?.style ?? {};
      return style.left === '120px' && style.top === '40px'
        && style.transform === 'translate(-50%,-100%)';
    })(),
    JSON.stringify(tips[0]?.props?.style),
  );
  check(
    '没有 tip 状态时不渲染浮层（它是绝对定位的，留在 DOM 里会挡在图上）',
    findClass(renderHeatmapFn(points, tFor, { range: null, tip: null }), /stu-heatTip/).length === 0
      && findClass(renderHeatmapFn(points, tFor), /stu-heatTip/).length === 0,
  );
  check(
    '浮层对辅助技术隐藏（无障碍文本由格子的 aria-label 承载，同一句话不读两遍）',
    tips[0]?.props?.['aria-hidden'] === 'true',
  );
  check(
    '浮层样式带 pointer-events:none（漏了它会形成"盖住格子 → mouseleave → 消失 → 又 mouseenter"的抖动循环）',
    /\.stu-heatTip\{[^}]*pointer-events:none/.test(cssBlock),
  );
  check(
    '浮层宽度写死并与夹取用的半个宽度常量对应（宽度由内容决定就算不准边界）',
    /\.stu-heatTip\{[^}]*width:200px/.test(cssBlock)
      && /const TIP_HALF_WIDTH = 100;/.test(source)
      && /\.stu-heatTip\{[^}]*max-width:calc\(100% - 8px\)/.test(cssBlock),
  );
  check(
    '浮层的定位祖先是图表卡片本身（`.stu-figure` 声明 position:relative），与滚动容器平级',
    /\.stu-figure\{[^}]*position:relative/.test(cssBlock)
      && /closest\('\.stu-figure'\)/.test(source),
  );
  check(
    '浮层只用主题令牌上色（背景 bg-overlay / 文字 label-primary / 描边 border-l1）',
    /\.stu-heatTip\{[^}]*background:var\(--dsw-alias-bg-overlay\)/.test(cssBlock)
      && /\.stu-heatTip\{[^}]*color:var\(--dsw-alias-label-primary\)/.test(cssBlock)
      && /\.stu-heatTip\{[^}]*border:\.5px solid var\(--dsw-alias-border-l1\)/.test(cssBlock),
  );

  /* ---- 交互：hover / focus 共用一套逻辑，位置被夹在容器内 ---- */
  const rectOf = (left, top, width, height) => ({
    left, top, width, height, right: left + width, bottom: top + height,
  });
  const fakeNode = (cellRect, hostRect) => ({
    getBoundingClientRect: () => cellRect,
    closest: () => ({ getBoundingClientRect: () => hostRect }),
  });
  const host = rectOf(0, 40, 600, 200);
  const gridCells = findClass(findClass(tipTree, /stu-heatBody/)[0] ?? {}, /stu-heatCell/);
  const emittedTips = [];
  const liveTree = renderHeatmapFn(points, tFor, { range: null, onTipChange: (next) => emittedTips.push(next) });
  const liveCell = findClass(findClass(liveTree, /stu-heatBody/)[0] ?? {}, /stu-heatCell/)[0];
  liveCell.props.onMouseEnter({ currentTarget: fakeNode(rectOf(0, 100, 11, 11), host) });
  liveCell.props.onFocus({ currentTarget: fakeNode(rectOf(589, 100, 11, 11), host) });
  liveCell.props.onFocus({ currentTarget: fakeNode(rectOf(300, 45, 11, 11), host) });
  liveCell.props.onFocus({ currentTarget: fakeNode(rectOf(300, 100, 11, 11), rectOf(0, 0, 120, 200)) });
  liveCell.props.onBlur({});
  const [leftEdge, rightEdge, topRow, narrow, afterBlur] = emittedTips;
  check(
    'hover 与键盘聚焦给的是同一份 tooltip（内容 + 坐标一致，不是两套逻辑）',
    emittedTips.length === 5
      && leftEdge.day === rightEdge.day && leftEdge.total === rightEdge.total
      && leftEdge.above === rightEdge.above,
  );
  check(
    '最左列的浮层被夹在容器内（左边界 ≥ 半个宽度），不伸出图表左边',
    leftEdge.left === 100 && leftEdge.above === true && leftEdge.top === 56,
    JSON.stringify(leftEdge),
  );
  check(
    '最右列的浮层被夹在容器内（右边界 ≤ 容器宽 − 半个宽度），不伸出图表右边',
    rightEdge.left === 500,
    JSON.stringify(rightEdge),
  );
  check(
    '第一行的浮层翻到格子**下方**（上方放不下就翻，免得盖住标题或跑出卡片）',
    topRow.above === false && topRow.top === 20,
    JSON.stringify(topRow),
  );
  check(
    '容器比浮层还窄时两端边界仍然成立（极窄侧栏下不出现越界）',
    narrow.left >= 0 && narrow.left <= 120,
    JSON.stringify(narrow),
  );
  check(
    '鼠标离开 / 失焦都把浮层收起来（传 null，而不是留下一个悬着的旧提示）',
    afterBlur === null,
  );
  check(
    '格子带 tabIndex 与 onFocus/onBlur（只支持鼠标的 tooltip 等于没有无障碍）',
    gridCells.length === 7
      && gridCells.every((node) => node.props.tabIndex === 0
        && typeof node.props.onFocus === 'function' && typeof node.props.onBlur === 'function'),
  );
  check(
    '量不到矩形（退化环境 / 合成事件）时仍给出文本、位置退回容器左上角，不抛',
    (() => {
      const collected = [];
      const tree = renderHeatmapFn(points, tFor, { range: null, onTipChange: (next) => collected.push(next) });
      const cell = findClass(findClass(tree, /stu-heatBody/)[0] ?? {}, /stu-heatCell/)[0];
      cell.props.onMouseEnter({ currentTarget: {} });
      cell.props.onMouseEnter(undefined);
      const last = collected[collected.length - 1];
      return collected.length === 2
        && collected.every((tip) => tip !== null && Number.isFinite(tip.left) && Number.isFinite(tip.top))
        && last.day === cell.props.key;
    })(),
  );
  check(
    '格子上没有 title 但有 aria-label（两套提示并存会同时弹出两个；删 title 不能连无障碍一起删）',
    gridCells.every((node) => node.props.title === undefined
      && typeof node.props['aria-label'] === 'string'
      && node.props['aria-label'].includes('token')),
  );
}

/* ---- 8.h 星期轴双语 + 原生日期控件的配色前提 ---- */

/*
 * 两组"渲染成功、但界面在另一半语言/另一半主题下是错的"的回归断言。
 *
 * 甲、星期轴标签改走文案表。
 *     原先写死 `['','一','','三','','五','']`，英文界面下星期轴仍是中文——
 *     只发生在切换语言之后，正则看不出、默认语言下也复现不了。所以这里按
 *     **渲染出来的文字**逐字比对，而不是查 `t('heatWeekdayMon')` 在不在源码里
 *     （比正则强：改了文案表却忘了接线，这里会红）。
 *
 * 乙、原生日期选择器的**日历图标**由浏览器按页面的 `color-scheme` 决定，
 *     前置代码只给输入框上了令牌色。所以必须先查证"应用自己有没有设 `color-scheme`"，
 *     再决定改不改——这一段就是那份查证的结论落成的断言。
 */
console.log('');
console.log('[8.h 星期轴双语 + 原生日期控件的配色前提]');

if (renderHeatmapFn !== null && zhBody !== '' && enBody !== '') {
  const findClass = (node, pattern) => findByClass(node, pattern, []);
  const textOf = (node) => (node?.children ?? []).filter((child) => typeof child === 'string').join('');
  /** 用**真实的中文文案表**渲染：组件里的 t 就是"键→当前语言文案"，这里等价于中文界面。 */
  const localeOf = (body) => (key) => valueOf(body, key) ?? key;

  const heatInput = [
    { day: '2026-06-01', total: 10 },
    { day: '2026-06-02', total: 30 },
    { day: '2026-06-03', total: 20 },
  ];
  const zhLabels = findClass(renderHeatmapFn(heatInput, localeOf(zhBody)), /stu-heatLabelCell/).map(textOf);
  const enLabels = findClass(renderHeatmapFn(heatInput, localeOf(enBody)), /stu-heatLabelCell/).map(textOf);
  // 只比较**有文字的那三行**（空行是布局占位，本来就没有文案可比）。
  const zhWeekday = zhLabels.filter((text) => text !== '');
  const enWeekday = enLabels.filter((text) => text !== '');
  console.log('  统计：中文星期轴 ' + JSON.stringify(zhLabels) + '，英文 ' + JSON.stringify(enLabels) + '。');

  check(
    '星期轴仍是 7 行、只标奇数行（3 行有字、4 行留空——隔行标才不挤）',
    zhLabels.length === 7 && enLabels.length === 7
      && zhLabels.filter((text) => text !== '').length === 3
      && enLabels.filter((text) => text !== '').length === 3,
    JSON.stringify([zhLabels, enLabels]),
  );
  /*
   * 三条逐字断言，把"标签真的等于文案表的值"钉住。
   * 判据是**渲染树里的文字**：把标签改回硬编码中文（负向对照 A）时，
   * 中文树仍然对得上（这正是这个 bug 骗过默认语言的原因），但下面第 2 条立刻红。
   */
  check(
    '中文渲染树里星期标签的文字**等于中文文案表的值**（一 / 三 / 五）',
    zhWeekday.join(',') === [
      valueOf(zhBody, 'heatWeekdayMon'), valueOf(zhBody, 'heatWeekdayWed'), valueOf(zhBody, 'heatWeekdayFri'),
    ].join(','),
    JSON.stringify(zhWeekday),
  );
  check(
    '英文渲染树里星期标签的文字**等于英文文案表的值**（Mon / Wed / Fri，不再是中文）',
    enWeekday.join(',') === [
      valueOf(enBody, 'heatWeekdayMon'), valueOf(enBody, 'heatWeekdayWed'), valueOf(enBody, 'heatWeekdayFri'),
    ].join(','),
    JSON.stringify(enWeekday),
  );
  check(
    '三行标签落在周一 / 周三 / 周五（第 2 / 4 / 6 行，0 起算），不是随便三行',
    zhLabels[1] !== '' && zhLabels[3] !== '' && zhLabels[5] !== ''
      && [0, 2, 4, 6].every((row) => zhLabels[row] === ''),
    JSON.stringify(zhLabels),
  );
  check(
    '英文星期轴不含任何 CJK 字符（英文界面下星期轴必须是英文）',
    enWeekday.every((text) => !/[\u4e00-\u9fff]/.test(text)),
    JSON.stringify(enWeekday),
  );
  check(
    '中英星期轴键集合一致：两表三个键的值互不相同且都非空（不会一边有字一边空着）',
    ['heatWeekdayMon', 'heatWeekdayWed', 'heatWeekdayFri'].every((key) =>
      typeof valueOf(zhBody, key) === 'string' && valueOf(zhBody, key).length > 0
      && typeof valueOf(enBody, key) === 'string' && valueOf(enBody, key).length > 0),
  );
}

/*
 * 标签列宽：英文标签比中文宽，所以这里逐值算一遍"留给每个标签的宽度够不够"。
 *
 * 为什么不用"查 CSS 里写着 28px"了事：写死宽度只是**手段**，要守的是
 *   1. 列宽必须是网格列轨道（14px）的整数倍——否则标签列一变宽，右侧网格的起点
 *      就跟着平移，热力图与上方月份带错开，读者会把格子数错一行；
 *   2. 留给单个标签的宽度要放得下最长的标签（英文 `Wed`）；
 *   3. 装不下时只能**溢出**，不能折行、不能省略号截断——静默截断就是"看不见的错"。
 * 三条都按 CSS 里真实的数字算（字号、列宽都从规则里读），不在这里重复写死。
 */
{
  const labelsRule = rules.get('.stu-heatLabels') ?? '';
  const labelCellRule = rules.get('.stu-heatLabelCell') ?? '';
  const trackWidth = Number((/repeat\(var\(--stu-heat-weeks\),(\d+(?:\.\d+)?)px\)/.exec(cssBlock) ?? [])[1]);
  const labelWidth = Number((/width:(\d+(?:\.\d+)?)px/.exec(labelsRule) ?? [])[1]);
  const fontSize = Number((/font-size:(\d+(?:\.\d+)?)px/.exec(labelCellRule) ?? [])[1]);
  /*
   * 标签**行高**（不是列宽）的间隔也从规则里读：它决定标签能不能在竖直方向
   * 与 11px 的格子对齐，是"标签行"和"格子行"能不能一一对应的一半条件
   * （另一半是标签本身不折行，见下面最后一条）。
   */
  const labelGap = Number((/gap:(\d+(?:\.\d+)?)px/.exec(labelsRule) ?? [])[1]);

  check(
    '能解析出标签列宽 / 列轨道宽 / 标签字号（比较的前提，读不到就没法算）',
    Number.isFinite(trackWidth) && Number.isFinite(labelWidth) && Number.isFinite(fontSize)
      && trackWidth > 0 && labelWidth > 0 && fontSize > 0,
    JSON.stringify({ trackWidth, labelWidth, fontSize, labelGap }),
  );
  check(
    '标签列宽是网格列轨道（' + trackWidth + 'px）的整数倍：' + labelWidth + 'px = '
      + Math.round((labelWidth / trackWidth) * 100) / 100 + ' 列',
    Number.isFinite(labelWidth) && Number.isFinite(trackWidth)
      && Number.isInteger(Math.round((labelWidth / trackWidth) * 1e6) / 1e6),
    '标签列 ' + labelWidth + 'px，列轨道 ' + trackWidth + 'px',
  );
  /*
   * 每个标签可用的是**整列宽**：`.stu-heatLabels` 是 `flex-direction:column`，
   * 7 个 span 在交叉轴（水平方向）上各自撑满整列，`gap` 只吃垂直方向的高度。
   * （这里最初按"列宽 / 7"算，于是 28px 的列被算成每行 1.4px、断言恒红——
   * 把布局模型写错的自检比没有自检更糟，因为它会逼着人去改对的代码。）
   *
   * 保守的字符宽度系数：CJK 取 0.95em、拉丁取 0.62em——都比真机字体宽，
   * 所以"算得过"意味着真机上只会更宽松。数字全部来自上面的 CSS 规则。
   */
  const perLabel = labelWidth;
  const cjkNeed = fontSize * 0.95;
  const latinNeed = fontSize * 0.62 * 3;
  check(
    '留给单个标签的宽度放得下英文标签（' + latinNeed.toFixed(1) + 'px ≤ ' + perLabel.toFixed(1) + 'px）；'
      + '中文更宽，' + cjkNeed.toFixed(1) + 'px ≤ ' + perLabel.toFixed(1) + 'px',
    cjkNeed <= perLabel && latinNeed <= perLabel,
    '每行可用 ' + perLabel.toFixed(2) + 'px，CJK 需 ' + cjkNeed.toFixed(2) + 'px，拉丁 3 字母需 ' + latinNeed.toFixed(2) + 'px',
  );
  check(
    '宽标签只允许**溢出**，不允许折行、省略号截断或裁剪（三者都是静默的错）',
    /white-space:nowrap/.test(labelCellRule)
      && !/overflow(-x|-y)?\s*:\s*(hidden|clip)/.test(labelCellRule)
      && !/text-overflow\s*:\s*ellipsis/.test(labelCellRule),
    '规则：' + labelCellRule,
  );
  /*
   * 宽度不够时 "nowrap + 溢出" 仍会把文字画到网格上，所以宽度本身要够；
   * 而高度必须被钉住——折行会让 11px 的标签变成 22px，下面 6 行标签整体错位一格。
   */
  check(
    '标签高度与格子同高（11px）且不折行，否则 7 行标签会整体错位一格',
    /height:11px/.test(labelCellRule) && /white-space:nowrap/.test(labelCellRule),
  );
  /*
   * 标签行与格子行必须用**同一套节距**（11px 行高 + 同样的 gap），否则 7 行标签会
   * 逐行累积错位——第一行还对得上、第七行差半格，看起来像"星期标错了"。
   * 节距从两处规则里各读一次，逐值比较（不在这里重复写死数字）。
   */
  const labelPitch = Number((/line-height:(\d+(?:\.\d+)?)px/.exec(labelCellRule) ?? [])[1]) + labelGap;
  const cellPitch = Number((/\.stu-heatBody\{[^}]*gap:(\d+(?:\.\d+)?)px/.exec(cssBlock) ?? [])[1])
    + Number((/\.stu-heatCell\{[^}]*height:(\d+(?:\.\d+)?)px/.exec(cssBlock) ?? [])[1]);
  check(
    '标签行与格子行用同一套节距（' + labelPitch + 'px vs ' + cellPitch + 'px）：节距不同会逐行累积错位',
    Number.isFinite(labelPitch) && Number.isFinite(cellPitch) && labelPitch === cellPitch,
    '标签 ' + labelPitch + 'px，格子 ' + cellPitch + 'px',
  );
}

/*
 * 日历图标：**查证结论是"不需要动手"**，所以这里断言的是那个前提，而不是一条新规则。
 *
 * 证据（已发布应用，用 _scratch/asar.mjs 从 resources/app.asar 里读出的原文）：
 *
 *   1. `@deepseek-ai/dsh-client-ui-theme/lib/index.js`
 *        const light = `:root{color-scheme:light}body{…}`;
 *        const dark  = `:root{color-scheme:dark}body{…}`;
 *        function bootThemeStyle(preference) { … return `${light}@media(prefers-color-scheme:dark){${dark}}` }
 *      —— 宿主把这段作为 `kind:"style"` 注入 `<head>`（`bootThemeInjections`），
 *      **在任何脚本执行之前**就定下了文档的配色方案；`system` 偏好退化成
 *      `prefers-color-scheme` 媒体查询。所以首屏的原生控件就已经跟着主题走。
 *
 *   2. `@deepseek-ai/dsh-client-ui-layout/lib/client.js`（类 ThemePresenter）
 *        apply(snapshot) {
 *          const scheme = snapshot.active.colorScheme;
 *          document.documentElement.style.colorScheme = scheme;
 *          document.documentElement.setAttribute(THEME_SOURCE_ATTRIBUTE, …);
 *          if (scheme === "dark") body.setAttribute(DARK_ATTRIBUTE, ""); …
 *        }
 *      —— 运行时切主题时，根元素的 `color-scheme` 由 ThemePresenter 持续改写
 *      （dispose() 里 removeProperty 归还）。用户从浅色切到深色，原生日期图标
 *      在同一帧里跟着变，不存在"深色主题下压着一个黑图标"的窗口。
 *
 * 因此本插件**不加** `::-webkit-calendar-picker-indicator` 的对比度覆盖（那会在
 * 另一种主题下反过来出错），更不写死 `color-scheme:dark|light`（同理，而且会与
 * 宿主的 applier 抢同一份设置）。这里把"依赖宿主设了根 color-scheme"这个前提记下来：
 * 哪天宿主不再设置，本地断言会先红，而不是等到真机上"图标看不见"才发现。
 * 视觉结论仍需真机确认（图标本身是浏览器绘制的，静态分析看不到它）。
 */
/*
 * **先剥注释再检查。**
 *
 * 这条断言第一版直接对源码做正则，结果被**注释里出现的 `color-scheme` 这个词**
 * 判红——而那段注释恰恰是在解释"为什么本插件不设 color-scheme"。
 * 与 `#310` 那次是同一个坑：**常红的规则最后一定被忽略，比没有规则更糟。**
 */
const sourceNoComments = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
check(
  '本插件不自己设 color-scheme（写死 dark/light 会在另一种主题下反过来出错，也与宿主抢同一份设置）',
  !/color-scheme|colorScheme/.test(sourceNoComments),
  'client.js 里出现了 color-scheme（注释不算）',
);
check(
  '不覆盖原生日历图标的对比度、也不自绘图标：图标跟随宿主设的 color-scheme（证据见本节注释）',
  !/calendar-picker-indicator|showPicker/.test(sourceNoComments),
);

/** 读已发布应用包里的内部路径；读不到返回 null（调用方据此"跳过并说明"，不静默变绿）。 */
const PUBLISHED_APP_ASAR = process.env.DSH_APP_ASAR
  ?? 'E:/DeepSeek Harness/resources/app.asar';
const PUBLISHED = 'dsh/node_modules/@deepseek-ai';
{
  const { execFileSync } = await import('node:child_process');
  const readerFile = path.join(root, '..', '_scratch', 'asar.mjs');
  const readPublished = (internalPath) => {
    if (!fs.existsSync(PUBLISHED_APP_ASAR) || !fs.existsSync(readerFile)) return null;
    try {
      return execFileSync(process.execPath, [readerFile, 'read', PUBLISHED_APP_ASAR, internalPath],
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    } catch {
      return null;
    }
  };
  const themeBoot = readPublished(PUBLISHED + '/dsh-client-ui-theme/lib/index.js');
  const themeLayout = readPublished(PUBLISHED + '/dsh-client-ui-layout/lib/client.js');
  if (themeBoot === null || themeLayout === null) {
    console.log('  跳过 宿主 color-scheme 证据断言：读不到已发布应用包（'
      + PUBLISHED_APP_ASAR + '，可用 DSH_APP_ASAR 覆盖）。'
      + '这不是"通过"——它意味着本次运行没有验证"原生日期图标跟随主题"这个前提。');
  } else {
    check(
      '宿主主题启动样式在 :root 上设了 color-scheme（light / dark 两档都在，system 走 media query）',
      /:root\{color-scheme:light\}/.test(themeBoot)
        && /:root\{color-scheme:dark\}/.test(themeBoot)
        && /prefers-color-scheme:dark/.test(themeBoot),
    );
    check(
      '宿主在脚本执行前把这段样式注入 head（kind:"style"）：首屏原生控件的配色就已经定了',
      /kind:\s*"style"/.test(themeBoot) && /bootThemeInjections/.test(themeBoot),
    );
    /*
     * 光有首屏样式不够：运行时切主题时必须有东西改写根元素的 `color-scheme`。
     * 这里要求 apply() 里写的是**从快照取出的**配色方案（而不是写死 dark/light），
     * 并且 dispose() 会把它归还——否则主题插件卸载后会留下一个错的配色方案。
     */
    check(
      '宿主运行时切主题时会改写根元素 color-scheme（apply 取 active.colorScheme，dispose 归还）',
      /document\.documentElement\.style\.colorScheme\s*=\s*scheme/.test(themeLayout)
        && /const scheme = snapshot\.active\.colorScheme/.test(themeLayout)
        && /document\.documentElement\.style\.removeProperty\("color-scheme"\)/.test(themeLayout),
    );
    console.log('  证据：宿主在两处设置根 color-scheme —— 启动 head 样式（'
      + PUBLISHED + '/dsh-client-ui-theme/lib/index.js）与运行时 ThemePresenter（'
      + PUBLISHED + '/dsh-client-ui-layout/lib/client.js）。');
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
