/**
 * client.js 布局结构自检。
 *
 * 为什么需要它：真机截图发现的错位（日志行的徽标与时间戳被推到最右、卡片套卡片、
 * 分段选择器换行后圆角被切）**任何功能性断言都抓不到**——它们都"渲染成功"。
 * 本脚本把「布局约定」变成可断言的结构规则，纯静态分析，不渲染 React：
 *
 *   1. CSS 类名与 JSX 引用的闭环（定义未用 = 死代码；引用未定义 = 没有样式）；
 *   2. 承载文本的类不得同时带 `flex:1`（否则被复用到别的行时会顶开兄弟元素）；
 *   3. 行内布局必须用 grid 显式分列，不用「flex + flex:1 + spacer」；
 *   4. 日志行必须是三列网格（状态 | 内容 | 时间），内容列带 minmax(0,1fr) 才不会被顶走；
 *   5. 不得对中文长文案用 `word-break:break-all`（会逐字换行）；
 *   6. 根容器不得声明 `height:100%`（与外壳滚动容器打架）。
 *
 * 用法：node scripts/verify-layout.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = fs.readFileSync(path.join(root, 'client.js'), 'utf8');

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

/* ---------------- 切分：CSS 块 / JSX 部分 ---------------- */
const cssMatch = /const CSS = \[([\s\S]*?)\]\.join\(''\);/.exec(source);
check('能定位 CSS 块', cssMatch !== null);
const cssBlock = cssMatch === null ? '' : cssMatch[1];
const jsxPart = source.slice(source.indexOf("].join('');"));

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

const defined = new Set();
for (const selector of rules.keys()) {
  for (const match of selector.matchAll(/\.(stp-[A-Za-z0-9_-]+)/g)) defined.add(match[1]);
}

/** JSX 里实际用到的类名（className: '...' 与 'a b' 形式）。 */
const used = new Set();
for (const match of jsxPart.matchAll(/className:\s*'([^']+)'/g)) {
  for (const cls of match[1].split(/\s+/)) if (cls.startsWith('stp-')) used.add(cls);
}

console.log('');
console.log('[1. CSS 与 JSX 的类名闭环]');
const unused = [...defined].filter((cls) => !used.has(cls)).sort();
const undefinedClasses = [...used].filter((cls) => !defined.has(cls)).sort();
check('没有「定义了却从未使用」的类', unused.length === 0, unused.join(', '));
check('没有「用了却没有样式」的类', undefinedClasses.length === 0, undefinedClasses.join(', '));

/* ---------------- 2. flex:1 误用 ---------------- */
console.log('');
console.log('[2. 承载文本的类不得带 flex:1]');
const flexOne = [];
for (const [selector, body] of rules) {
  if (!/flex\s*:\s*1/.test(body)) continue;
  // 允许：显式声明的布局容器（headText / spacer 一类）
  if (/(headText|spacer)/.test(selector)) continue;
  if (/item|list|row|card|title/i.test(selector)) flexOne.push(selector);
}
check('没有把 flex:1 放在行/标题类上', flexOne.length === 0, flexOne.join(', '));

/* ---------------- 3. 行内用 grid 显式分列 ---------------- */
console.log('');
console.log('[3. 行内布局使用 grid 显式分列]');
const logRow = rules.get('.stp-logRow');
check('日志行是 grid', logRow !== undefined && /display\s*:\s*grid/.test(logRow), String(logRow));
check(
  '日志行是三列且内容列 minmax(0,1fr)',
  logRow !== undefined
    && /grid-template-columns\s*:\s*auto\s+minmax\(0,\s*1fr\)\s+auto/.test(logRow),
  String(logRow),
);
const itemGrid = rules.get('.stp-itemGrid');
check('任务行是两列 grid', itemGrid !== undefined && /display\s*:\s*grid/.test(itemGrid), String(itemGrid));
check(
  '任务行左列 minmax(0,1fr)、右列 auto',
  itemGrid !== undefined && /grid-template-columns\s*:\s*minmax\(0,\s*1fr\)\s+auto/.test(itemGrid),
  String(itemGrid),
);
check(
  '日志行的主体是 logBody 而不是复用标题类',
  /className:\s*'stp-logRow'/.test(jsxPart) && /className:\s*'stp-logBody'/.test(jsxPart),
);

/* ---------------- 4. 排版：不用 break-all ---------------- */
console.log('');
console.log('[4. 中文长文案不使用 break-all]');
const breakAll = [];
for (const [selector, body] of rules) {
  if (/word-break\s*:\s*break-all/.test(body) && !/mono|logSub/.test(selector)) breakAll.push(selector);
}
check('长文案类没有 word-break:break-all', breakAll.length === 0, breakAll.join(', '));

/* ---------------- 5. 根容器不声明 height:100% ---------------- */
console.log('');
console.log('[5. 根容器高度归外壳]');
const rootRule = rules.get('.stp-root');
check('根容器存在', rootRule !== undefined);
// 用 (^|;) 锚定属性名，避免把 min-height:100% 误判成 height:100%。
check(
  '根容器不写 height:100%',
  rootRule !== undefined && !/(^|;)\s*height\s*:\s*100%/.test(rootRule),
  String(rootRule),
);
check('根容器不自建滚动', rootRule !== undefined && !/overflow\s*:\s*auto/.test(rootRule), String(rootRule));
check('根容器有最大宽度约束', /const CSS[\s\S]*max-width:\s*980px/.test(source));

/* ---------------- 6. 组件结构 ---------------- */
console.log('');
console.log('[6. 组件结构约定]');
check('页面内容包在 stp-inner 里', /className:\s*'stp-inner'/.test(jsxPart));
check('头部操作区独立成组（不再是标题行里散落按钮）', /className:\s*'stp-headActions'/.test(jsxPart));
check('时间类型选择器用原生 select（不用会换行的按钮组）', /'select',[\s\S]{0,400}className:\s*'stp-select'/.test(jsxPart));
check('不再存在 stp-seg 按钮组', !/stp-seg/.test(jsxPart) && !rules.has('.stp-seg'));
check('任务区有分区标题', /t\('tasksTitle'\)/.test(jsxPart));
check('存在空状态样式', rules.has('.stp-empty'));

console.log('');
console.log('[6b. 表单排版：显式行分组]');
// 表单字段必须按语义行分组、每行显式声明列数。用 auto-fit 网格时字段数随
// schedule 类型变化，会把「启用」复选框摊成独立格子、右侧留大片空白
// （真机截图里的排版问题就是它）。
check('表单用 stp-formRows 分行', /className:\s*'stp-formRows'/.test(jsxPart));
check('每行显式声明列数 data-cols', /className:\s*'stp-formRow'/.test(jsxPart) && /'data-cols':\s*String\(cols\)/.test(source));
check('不再用 auto-fit 的 formGrid', !/stp-formGrid/.test(jsxPart) && !rules.has('.stp-formGrid'));
check('「触发时间」与它的取值同一行', /row\('r-sched', 2, \[kindCell, valueCell\]\)/.test(source));
check('供应商与模型同一行', /row\('r-model', 2, \[providerCell, modelCell\]\)/.test(source));
check('推理强度独居一行', /row\('r-effort', 1,/.test(source));
check('「启用」是独立开关控件而不是字段网格的一格', /className:\s*'stp-check'/.test(jsxPart) && rules.has('.stp-check'));
check('「启用」被放进操作行而不是字段行', /stp-formActions[\s\S]{0,200}stp-check/.test(source) === false && /const enabledCell/.test(source));

console.log('');
console.log('[7. 信息架构：配置与流水分开]');
// 任务列表是配置（条数相对稳定），运行日志是流水（持续增长）。
// 两者必须在不同的 tab 里各自分页，否则流水会把配置挤下去。
check('存在页内 tab', /className:\s*'stp-tabs'/.test(jsxPart) && rules.has('.stp-tabs'));
check('tab 有正确的无障碍语义', /role:\s*'tablist'/.test(jsxPart) && /role:\s*'tab'/.test(jsxPart) && /'aria-selected':\s*tab === /.test(jsxPart));
check('切 tab 用状态驱动', /setTab\('tasks'\)/.test(jsxPart) && /setTab\('logs'\)/.test(jsxPart));
check('任务区只在 tasks tab 渲染', /if \(tab === 'tasks'\) children\.push/.test(jsxPart));
check('日志区只在 logs tab 渲染', /if \(tab === 'logs'\) \{/.test(jsxPart));
check('日志按 taskId 归组（供任务展开区用）', /logByTask/.test(jsxPart));
check('每个任务有运行记录入口', /t\('runHistory'\)/.test(jsxPart));
check('展开区用 stp-history 包裹', /className:\s*'stp-history'/.test(jsxPart));
check('同时只展开一个任务的记录', /expandedTask/.test(jsxPart) && /setExpandedTask\(expanded \? null : task\.id\)/.test(jsxPart));
check('展开状态可被 aria-expanded 暴露', /'aria-expanded':\s*expanded/.test(jsxPart));
check('日志行仍由共用的 renderLogRow 渲染（不复制粘贴）', /function renderLogRow/.test(source) && /renderLogRow\(row, index, t\)/.test(jsxPart));

console.log('');
console.log('[8. 分页]');
check('每页条数是常量 PAGE_SIZE', /const PAGE_SIZE = \d+/.test(source) && /PAGE_SIZE/.test(jsxPart));
check('任务与日志各自分页', /setTaskPage/.test(jsxPart) && /setLogPage/.test(jsxPart));
check('分页条是共用渲染函数', /function renderPager/.test(source) && /renderPager\(\{/.test(jsxPart));
check('只有一页时不渲染分页条', /if \(spec\.pageCount <= 1\) return null/.test(source));
check('分页条有范围说明', /t\('pagerInfo'\)/.test(jsxPart));
check('上/下一页在边界禁用', /disabled: spec\.page <= 0/.test(source) && /disabled: spec\.page \+ 1 >= spec\.pageCount/.test(source));
check('数据变化后分页游标被夹回合法范围', /setTaskPage\(\(current\) =>/.test(jsxPart) && /setLogPage\(\(current\) =>/.test(jsxPart));
check('任务列表按页切片而不是全量渲染', /state\.tasks\.slice\(safeTaskPage \* PAGE_SIZE/.test(jsxPart));
check('日志列表按页切片而不是全量渲染', /sortedLog\.slice\(safeLogPage \* PAGE_SIZE/.test(jsxPart));

console.log('');
console.log('[9. 文案键完整性]');
// 缺定义的键会直接把 key 名渲染到界面上（`t('runHistory')` → 显示 "runHistory"），
// 这类问题在改布局时很容易漏，纯文本就能查。
const zhBlock = /const zh = \{([\s\S]*?)\n    \};/.exec(source);
const enBlock = /const en = \{([\s\S]*?)\n    \};/.exec(source);
check('能定位 zh 文案表', zhBlock !== null);
check('能定位 en 文案表', enBlock !== null);
const zhKeys = new Set([...(zhBlock === null ? '' : zhBlock[1]).matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1]));
const enKeys = new Set([...(enBlock === null ? '' : enBlock[1]).matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1]));
const referenced = new Set([...source.matchAll(/\bt\('([A-Za-z_][A-Za-z0-9_]*)'\)/g)].map((m) => m[1]));

const missingZh = [...referenced].filter((key) => !zhKeys.has(key)).sort();
const missingEn = [...referenced].filter((key) => !enKeys.has(key)).sort();
check('每个用到的键都有中文文案', missingZh.length === 0, missingZh.join(', '));
check('每个用到的键都有英文文案', missingEn.length === 0, missingEn.join(', '));
check('中英文键集合一致', zhKeys.size === enKeys.size
  && [...zhKeys].every((key) => enKeys.has(key)), `zh=${zhKeys.size} en=${enKeys.size}`);
// 动态使用的键不会被 t('literal') 匹配到：
//   t(statusKey(...))            → status*
//   t(WEEKDAY_KEYS[day])         → weekday*
//   t(kindKey) / kinds 表里的键   → kind*
//   t(entry.key) 之类的表驱动文案  → 表单校验、触发方式
// 这里按前缀把它们排除，只报真正没人引用的键——否则规则会一直红着，
// 大家就会开始忽略它，比没有规则更糟。
const DYNAMIC_PREFIXES = ['status', 'weekday', 'kind', 'err', 'trigger'];
const deadKeys = [...zhKeys]
  .filter((key) => key !== 'panelLabel' && !referenced.has(key))
  .filter((key) => !DYNAMIC_PREFIXES.some((prefix) => key.startsWith(prefix)))
  .sort();
check('没有定义却从不使用的文案键', deadKeys.length === 0, deadKeys.join(', '));

console.log('');
console.log('[10. 席位注册必须经 ctx.slots.inject]');
/*
 * 这条守着一个真实事故（2026-09-25）：裸调 `ctx.slots.register` 在 boot 时抛
 *
 *   Error: slot "sidebar.panellist" is not declared
 *   （a parent entry's children table must declare it）
 *
 * 浏览器 bundle 的执行顺序由 combo 决定，本包可能排在"声明这些 slot 的那些包"
 * 之前。错误从 `ctx.effect` 的回调里抛出 → Cordis 把该 effect 记为失败 →
 * 整个 entry 被判为未激活 → 用户看到启动失败对话框：
 *
 *   web boot: 1 entry did not activate
 *   dsh-plugin-scheduled-tasks: failed
 *
 * 修法是官方 practices.md 的写法：`ctx.slots.inject(ownerKey, () => ctx.slots.register(...))`
 * —— 把注册推迟到属主声明出现之后，并在它重新出现时重装。
 */
{
  // 注释里也提到了 register，先剥掉注释再数，否则会把文档当成调用。
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const injectCount = (codeOnly.match(/ctx\.slots\.inject\(/g) ?? []).length;
  const registerCount = (codeOnly.match(/ctx\.slots\.register\(/g) ?? []).length;
  const contributeCalls = (codeOnly.match(/contribute\(/g) ?? []).length;
  check('恰好 1 处 ctx.slots.inject（在 contribute 辅助函数里复用）', injectCount === 1, '实际 ' + injectCount);
  check(
    'register 只出现在 inject 的 generator 回调里（没有裸调）',
    registerCount === 1
      && /ctx\.slots\.inject\(ownerKey, function\* \(\) \{\s*yield ctx\.slots\.register\(options, Component\);/.test(codeOnly),
    'register ' + registerCount + ' 次',
  );
  check('contribute 被调用 2 次（两个席位一个不落）', contributeCalls === 2, '实际 ' + contributeCalls);
  check(
    '两个席位仍然分别指向 sidebar.panellist 与 main',
    /contribute\('sidebar\.panellist',/.test(codeOnly) && /contribute\('main',/.test(codeOnly),
  );
}

console.log('');
console.log('[11. 主题色：只允许令牌，禁止硬编码颜色]');
/*
 * 真机事故：主按钮原本是
 *   background:var(--dsw-alias-brand-primary); color:#fff
 * 主题里**没有**「与 brand 对照的前景色」令牌（Theme.listTokens 只有 bg/border/
 * brand/label/state 几族），而 brand-primary 在暗色主题下本身是浅色——白字压上去
 * 直接看不见。
 *
 * 这类改动"能跑、浅色下好看、切到暗色才瞎"，没有任何功能测试会发现它。
 * 所以规则是硬的：颜色一律走 --dsw-alias-*。
 */
{
  // 先剥注释：注释里会引用旧代码（`color:#fff`）或 issue 号（`#310`），
  // 不剥会变成常红的误报，而常红的规则最后一定被忽略。
  const cssRaw = (rules.size === 0 ? '' : [...rules.keys()].join('\n'));
  const cssOnly = source
    .slice(source.indexOf('const CSS = ['), source.indexOf("].join('" + "')"))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const hex = [...cssOnly.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
  check('CSS 里没有十六进制颜色', hex.length === 0, hex.join(', '));
  const rgb = [...cssOnly.matchAll(/rgba?\(/g)].map((m) => m[0]);
  check('CSS 里没有 rgb()/rgba() 颜色', rgb.length === 0, String(rgb.length));
  const primary = /\.stp-btn\[data-primary="true"\]\{([^}]*)\}/.exec(cssOnly);
  check('主按钮规则存在', primary !== null);
  check(
    '主按钮只用 brand 令牌描边与上色，不填色（填色就需要一个不存在的对照色令牌）',
    primary !== null
      && /color:var\(--dsw-alias-brand-primary\)/.test(primary[1])
      && /border-color:var\(--dsw-alias-brand-primary\)/.test(primary[1])
      && /background:transparent/.test(primary[1]),
    primary === null ? '未找到' : primary[1],
  );
}

console.log('');
if (failures.length > 0) {
  console.log('失败 ' + failures.length + ' 项：');
  for (const item of failures) console.log('  - ' + item);
  process.exit(1);
}
console.log('全部通过：' + ok + ' 项布局结构断言（视觉呈现仍需在真实页面确认）。');
