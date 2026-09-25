/**
 * 自检：装配形状 + 纯函数语义。
 *
 * 零第三方依赖（只测 `lib/pure.js` 与两个半的静态结构），直接
 * `node scripts/verify-contract.mjs` 即可运行。
 *
 * 分两类断言，都盯"错了不会抛错、只会静默做错事"的地方：
 *   - **纯函数语义**：端口归一化、SSH 参数顺序、路径转义、find 解析
 *   - **装配契约**：客户端半的结构（slot 形式、滚动根、模块包装）
 *
 * 后者尤其重要：这三条各对应一次真实事故——裸 `ctx.slots.register` 会让
 * 应用起不来；主页面不自建滚动会让内容看不见；缺 `__ModuleLoader__.load`
 * 会让整个客户端半根本不加载。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildSshArgs,
  catCommand,
  escapeRemotePath,
  findCommand,
  formatDuration,
  formatExact,
  hostDisplayName,
  hostSummary,
  normaliseHistory,
  normaliseHosts,
  normalisePort,
  parseFindOutput,
  resolveTimeout,
  splitPath,
} from '../lib/pure.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const check = (label, condition, detail) => {
  if (condition) {
    console.log('  ok   ' + label);
    return;
  }
  failures.push(label + (detail === undefined ? '' : ' — ' + detail));
  console.log('  FAIL ' + label + (detail === undefined ? '' : ' — ' + detail));
};
const failures = [];
let ok = 0;
const realCheck = (label, condition, detail) => {
  if (condition) ok += 1;
  check(label, condition, detail);
};

const source = fs.readFileSync(path.join(root, 'client.js'), 'utf8');
const hostSource = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const toolsSource = fs.readFileSync(path.join(root, 'lib/tools.js'), 'utf8');

/**
 * 剥掉注释再做结构断言。
 *
 * 必须剥：注释里会**合法地**引用被禁的写法来解释为什么禁它（比如
 * "不要写成 `const x = useEffect(...)`"），不剥就会把说明文字判成违规。
 * 常红的规则最后一定被忽略，那比没有规则更糟——这条教训在另一个插件上
 * 已经付过一次代价。
 */
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const code = stripComments(source);
const hostCode = stripComments(hostSource);

/* ------------------------------------------------------------------ */
console.log('[1. 主机归一化与端口]');

const hosts = normaliseHosts([
  { host: 'a.com', port: 22, user: 'u' },
  { host: '', port: 22 },
  { host: 'b.com', port: 2222, user: 'v' },
  null,
  { host: 'c.com', user: 'w' },
]);
realCheck('坏行被丢弃（空 host / null）', hosts.length === 3, String(hosts.length));
realCheck('id 按原始索引补全且稳定', hosts.map((h) => h.id).join(',') === 'host-0,host-2,host-4', hosts.map((h) => h.id).join(','));
realCheck('缺省端口补 22', hosts[2].port === 22, String(hosts[2].port));
realCheck('normaliseHosts(undefined) 返回空数组', normaliseHosts(undefined).length === 0);

/*
 * 端口：**超范围按未设置处理，不钳位**。
 *
 * 这条有真实来历：最初写成 `Math.min(65535, Math.max(1, port))`，于是 99999
 * 变成 65535——一个用户从没填过的端口，插件却会拿着它去连。比"回落默认值"
 * 和"直接报错"都更难查。
 */
realCheck('端口超上限回落 22（不钳到 65535）', normalisePort(99999) === 22, String(normalisePort(99999)));
realCheck('端口为 0 回落 22', normalisePort(0) === 22, String(normalisePort(0)));
realCheck('端口为负回落 22', normalisePort(-1) === 22, String(normalisePort(-1)));
realCheck('端口为 NaN 回落 22', normalisePort(NaN) === 22, String(normalisePort(NaN)));
realCheck('端口为 undefined 回落 22', normalisePort(undefined) === 22, String(normalisePort(undefined)));
realCheck('合法端口原样保留', normalisePort(2222) === 2222, String(normalisePort(2222)));
realCheck('小数端口向下取整', normalisePort(22.9) === 22, String(normalisePort(22.9)));

/* ------------------------------------------------------------------ */
console.log('');
console.log('[2. 展示名与摘要]');

realCheck('label 优先于 user@host', hostDisplayName({ host: 'x', label: 'L', user: 'u' }) === 'L');
realCheck('无 label 时用 user@host', hostDisplayName({ host: 'x', user: 'u' }) === 'u@x');
realCheck('无 user 时只用 host', hostDisplayName({ host: 'x' }) === 'x');
realCheck('摘要省略默认端口 22', hostSummary({ host: 'x', user: 'u' }) === 'u@x', hostSummary({ host: 'x', user: 'u' }));
realCheck('摘要保留非默认端口', hostSummary({ host: 'x', user: 'u', port: 2222 }) === 'u@x:2222', hostSummary({ host: 'x', user: 'u', port: 2222 }));

/* ------------------------------------------------------------------ */
console.log('');
console.log('[3. SSH 参数顺序（硬约束）]');

const args = buildSshArgs({ host: { host: 'a.com', port: 2222, user: 'u', identityFile: '~/.ssh/id_ed25519' }, remoteCommand: 'ls -la', connectTimeoutMs: 10000 });
realCheck('BatchMode=yes 在（永不弹交互口令）', args.includes('BatchMode=yes'));
realCheck('StrictHostKeyChecking 用 accept-new', args.includes('StrictHostKeyChecking=accept-new'));
realCheck('ConnectTimeout 由毫秒换算成秒', args.includes('ConnectTimeout=10'), args.find((a) => a.startsWith('ConnectTimeout')) ?? '缺失');
realCheck('-p 在目标之前', args.indexOf('-p') < args.indexOf('u@a.com'));
realCheck('-i 在目标之前', args.indexOf('-i') < args.indexOf('u@a.com'));
realCheck('远端命令排在最后', args[args.length - 1] === 'ls -la', args[args.length - 1]);
realCheck('默认端口不加 -p', !buildSshArgs({ host: { host: 'x', user: 'u' }, remoteCommand: 'true' }).includes('-p'));
realCheck('空命令不占位（否则 ssh 会去读 stdin）',
  buildSshArgs({ host: { host: 'x', user: 'u' } }).length === buildSshArgs({ host: { host: 'x', user: 'u' }, remoteCommand: '' }).length);
realCheck('额外 -o 选项逐个展开',
  buildSshArgs({ host: { host: 'x', sshOptions: ['Compression=yes', 'ServerAliveInterval=30'] } }).join(' ').includes('Compression=yes'));
realCheck('空字符串选项被跳过',
  !buildSshArgs({ host: { host: 'x', sshOptions: ['', '  '] } }).join(' ').includes('-o ' + ' '));

/* ------------------------------------------------------------------ */
console.log('');
console.log('[4. 路径转义与命令注入]');

realCheck('普通路径加单引号', escapeRemotePath('/var/log') === "'/var/log'", escapeRemotePath('/var/log'));
realCheck('空路径也返回合法引号对', escapeRemotePath('') === "''", escapeRemotePath(''));
realCheck('内嵌单引号被正确断开重开', escapeRemotePath("a'b") === "'a'\\''b'", escapeRemotePath("a'b"));

/**
 * 一个最小的 POSIX 单引号反转义器。
 *
 * 用它做**行为**断言，而不是数引号个数或用正则猜——早先那版用
 * `/'\s*;/` 去判断"分号有没有露在引号外"，结果把**正确**的转义判成了失败：
 * 合法转义 `'...'\''...'` 里的单引号个数本来就是奇数，靠计数根本判不出来。
 * 真正要证的只有一件事：转义后能被 shell 原样解回。
 */
function posixUnquote(text) {
  let out = '';
  let index = 0;
  while (index < text.length) {
    if (text[index] === "'") {
      index += 1;
      while (index < text.length && text[index] !== "'") { out += text[index]; index += 1; }
      index += 1;
    } else if (text.startsWith("\\'", index)) {
      out += "'";
      index += 2;
    } else {
      out += text[index];
      index += 1;
    }
  }
  return out;
}

const evil = "/tmp/a'; rm -rf /; echo '";
realCheck('恶意路径转义后能被 shell 原样解回（注入防护的行为证明）',
  posixUnquote(escapeRemotePath(evil)) === evil, posixUnquote(escapeRemotePath(evil)));
realCheck('普通路径同样可往返', posixUnquote(escapeRemotePath('/var/log/x.txt')) === '/var/log/x.txt');
realCheck('换行与反斜杠不会破坏转义', posixUnquote(escapeRemotePath('a\nb\\c')) === 'a\nb\\c');
realCheck('cat 用 -- 终止选项解析（- 开头的路径不会被当成参数）', catCommand('-weird').startsWith('cat -- '), catCommand('-weird'));

/* ------------------------------------------------------------------ */
console.log('');
console.log('[5. find 输出解析]');

const findOut = '/a/b\tf\t123\t1700000000.5\0/a\td\t9\t1700000001.0\0/c.txt\tf\t7\t1700000002.0\0';
const rows = parseFindOutput(findOut, 50);
realCheck('解析出全部记录', rows.length === 3, String(rows.length));
realCheck('目录排在前（顺序固定，否则每次刷新都重排）', rows[0].directory === true && rows[0].name === 'a');
realCheck('同类型内按名称升序', rows[1].name === 'b' && rows[2].name === 'c.txt', rows.map((r) => r.name).join(','));
realCheck('大小解析正确', rows[1].size === 123, String(rows[1].size));
realCheck('mtime 由秒换算成毫秒', rows[1].mtimeMs === 1700000000500, String(rows[1].mtimeMs));
realCheck('name 从 path 切出', rows[2].name === 'c.txt', rows[2].name);
/*
 * 路径里含制表符：字段顺序**必须**是路径在最前，只取末三字段当类型/大小/时间，
 * 剩下的拼回来才是完整路径。把数值字段放前面就会被文件名里的 tab 打乱。
 */
const tabbed = parseFindOutput('/we\tird\tf\t1\t1700000000.0\0', 50);
realCheck('含 tab 的路径完整保留（证明字段顺序是路径在前）', tabbed[0]?.path === '/we\tird', JSON.stringify(tabbed[0]?.path));
realCheck('limit 生效', parseFindOutput(findOut, 1).length === 1);
realCheck('空输入返回空数组', parseFindOutput('', 10).length === 0 && parseFindOutput(undefined, 10).length === 0);
realCheck('字段不足的记录被跳过而不是抛错', parseFindOutput('/only-a-path\0', 10).length === 0);

/* ------------------------------------------------------------------ */
console.log('');
console.log('[6. 执行记录与格式化]');

realCheck('history undefined 返回空数组（schemastery 不会填默认值）', normaliseHistory(undefined).length === 0);
realCheck('history 非数组返回空数组', normaliseHistory('nope').length === 0);
const hist = normaliseHistory([
  { id: 'a', command: 'x', at: 100, ok: true },
  { id: 'b', command: 'y', at: 300, ok: false },
  { command: '', at: 400 },
], 10);
realCheck('无 command 的记录被丢弃', hist.length === 2, String(hist.length));
realCheck('按时间倒序（新的在前）', hist[0].id === 'b' && hist[1].id === 'a', hist.map((h) => h.id).join(','));
realCheck('limit 生效', normaliseHistory([{ command: 'x', at: 1 }, { command: 'y', at: 2 }], 1).length === 1);

realCheck('时长 ms 档', formatDuration(0) === '0ms' && formatDuration(900) === '900ms', formatDuration(900));
realCheck('时长 s 档', formatDuration(2500) === '2.50s', formatDuration(2500));
realCheck('时长分档补零', formatDuration(65000) === '1m05s', formatDuration(65000));
realCheck('时长非法值给占位符而不是 NaN', formatDuration(undefined) === '—' && formatDuration(-1) === '—');
realCheck('千分位', formatExact(1234567) === '1,234,567', formatExact(1234567));

realCheck('splitPath 常规', JSON.stringify(splitPath('/a/b/c')) === '{"dir":"/a/b","entry":"c"}');
realCheck('splitPath 根目录', JSON.stringify(splitPath('/')) === '{"dir":"/","entry":""}');
realCheck('splitPath 无分隔符', JSON.stringify(splitPath('x')) === '{"dir":".","entry":"x"}');

/*
 * 超时：`execFile`/`spawn` 的 timeout=0 表示**不超时**，那正好是最危险的值，
 * 所以 0/负数必须回落到默认值而不是原样透传。
 */
realCheck('timeout 0 回落到默认（0 在 spawn 里表示永不超时）', resolveTimeout(0) === 30000, String(resolveTimeout(0)));
realCheck('timeout 负数回落', resolveTimeout(-5) === 30000, String(resolveTimeout(-5)));
realCheck('timeout 超上限封顶（一个"想等更久"的配置不该能挂住宿主）', resolveTimeout(999999999) === 300000, String(resolveTimeout(999999999)));
realCheck('timeout 合法值原样', resolveTimeout(5000) === 5000, String(resolveTimeout(5000)));

/* ------------------------------------------------------------------ */
console.log('');
console.log('[7. 客户端半的装配契约（每条对应一次真实事故）]');

realCheck('有 __ModuleLoader__.load 包装（否则客户端半根本不加载）',
  /window\.__ModuleLoader__\.load\(\{/.test(source), '缺少模块包装');
realCheck('模块 id 与包名一致', /id:\s*'dsh-plugin-ssh-workspace'/.test(source));
realCheck('工厂只 require react', /factory\(require\)/.test(source) && (source.match(/require\(/g) ?? []).length === 1, '工厂里出现了额外的 require');
realCheck('用 React.createElement，不手搓 element 对象',
  /const h = React\.createElement/.test(code) && !/\$\$typeof/.test(code));
realCheck('slot 走 ctx.slots.inject', /ctx\.slots\.inject\(/.test(code));
realCheck('注入回调是 generator 形式（箭头函数返回 disposer 不是契约形状）',
  /ctx\.slots\.inject\([^)]*,\s*function\s*\*/.test(code));
/*
 * `ctx.slots.register` **只能出现在 `slots.inject` 的回调里**。
 * 裸调（在 apply 顶层直接 register）会在 boot 时抛 `slot "x" is not declared`
 * ——bundle 的执行顺序由 combo 决定，可能排在声明这些 slot 的包之前——
 * 那会让 entry 激活失败、应用直接起不来。这里断言的是"每一次 register 都有
 * 对应的 inject"，而不是"不许出现 register"。
 */
const registerCount = (code.match(/ctx\.slots\.register\(/g) ?? []).length;
const injectCount = (code.match(/ctx\.slots\.inject\(/g) ?? []).length;
realCheck('每次 ctx.slots.register 都在 ctx.slots.inject 的回调里（数量匹配）',
  registerCount === 1 && injectCount === 1, `register=${registerCount} inject=${injectCount}`);
realCheck('register 紧跟在 inject 的 generator 回调内（同一处）',
  /ctx\.slots\.inject\([^)]*,\s*function\s*\*[^)]*\)\s*\{\s*yield\s+ctx\.slots\.register\(/.test(code));
realCheck('注册了两个席位', (code.match(/^\s*contribute\(/gm) ?? []).length === 2, String((code.match(/^\s*contribute\(/gm) ?? []).length));
realCheck('席位名正确', code.includes("'sidebar.panellist'") && code.includes("'main'"));

/*
 * options 的**字段名**必须逐个对上。
 *
 * 真机事故：我原先写的是 `{ key, order, icon, title, onClick }`，结果侧边栏那一格
 * 永远不出现，而控制台里没有一行报错。正确形状是：
 *   - `name`  必须是席位名本身（两个席位都要给）；
 *   - 侧边栏用 **`id`**，主页面用 **`key`**——**不是同一个字段**；
 *   - 标题是 **`label: () => string`**（函数），不是 `title: string`。
 * 这几条纯靠字段名，写错了没有任何运行时反馈，所以必须断言。
 */
realCheck('sidebar.panellist 的 options 带 name',
  /contribute\('sidebar\.panellist',\s*\{[^}]*name:\s*'sidebar\.panellist'/.test(code));
realCheck('sidebar.panellist 用 id（不是 key）',
  /contribute\('sidebar\.panellist',\s*\{[^}]*\bid:\s*PANEL_ID/.test(code)
    && !/contribute\('sidebar\.panellist',\s*\{[^}]*\bkey:/.test(code), '侧边栏误用了 key');
realCheck('sidebar.panellist 的标题是 label 函数（不是 title 字符串）',
  /contribute\('sidebar\.panellist',\s*\{[^}]*label:\s*\(\)\s*=>/.test(code)
    && !/contribute\('sidebar\.panellist',\s*\{[^}]*\btitle:/.test(code), '侧边栏误用了 title');
realCheck('main 的 options 带 name 与 key',
  /contribute\('main',\s*\{\s*name:\s*'main',\s*key:\s*PANEL_ID\s*\}/.test(code));
realCheck('席位注册在 ctx.effect 里（注册与清理归 fiber 所有）',
  /ctx\.effect\(\(\) => \{[\s\S]*?contribute\('sidebar\.panellist'[\s\S]*?\}, 'ssh-workspace: slots'\)/.test(code));

realCheck('主页面根容器自建滚动（main 席位不给滚动容器）',
  /\.ssh-inner\{[^}]*height:100%/.test(code) && /\.ssh-inner\{[^}]*overflow:auto/.test(code));
realCheck('限宽在子元素上而不是滚动根上', /\.ssh-inner>\*\{[^}]*max-width/.test(code));
realCheck('根容器不用 margin:0 auto（那是"限宽在容器上"时代的写法）', !/\.ssh-inner\{[^}]*margin:0 auto/.test(code));

realCheck('工具入参键名是 arguments 而不是 args（照抄 dsh-tools 的调用形状）',
  /arguments:\s*\{/.test(code) && !/execute\(\{\s*name:[^}]*\bargs:/.test(code));
realCheck('调用工具时带上 callId', /callId:/.test(code));
realCheck('从 ctx.get(tools) 取工具服务', /ctx\.get\('tools'\)/.test(code));

realCheck('CSS 里没有裸 hex 颜色（令牌之外只允许 artwork 与阴影例外）',
  !/#[0-9a-fA-F]{3,8}\b/.test(code), '出现十六进制颜色');
realCheck('CSS 里没有 rgb()/rgba()', !/rgba?\(/.test(code));
realCheck('主按钮用描边式而不是填色+白字（主题没有与品牌色对照的前景色令牌）',
  /\.ssh-btn\[data-primary="true"\]\{[^}]*background:transparent/.test(code));
realCheck('长文本一律 ellipsis，不用 break-all', /text-overflow:ellipsis/.test(code) && !/word-break:break-all/.test(code));
realCheck('组件内 hook 都在语句层（不写成 const x = useEffect(...)）', !/const\s+\w+\s*=\s*useEffect\(/.test(code));
realCheck('文案中英两表都定义且键一致', (() => {
  const zh = code.slice(code.indexOf('const zh = {'), code.indexOf('const en = {'));
  const en = code.slice(code.indexOf('const en = {'), code.indexOf('const isObject ='));
  const keys = (block) => (block.match(/^\s{6}(\w+):/gm) ?? []).map((line) => line.trim().replace(':', ''));
  const left = keys(zh).sort().join(',');
  const right = keys(en).sort().join(',');
  return left !== '' && left === right;
})());

/*
 * 客户端半的 `inject` 与宿主半不是一回事。
 *
 * 一度写成 `['settings']`（宿主侧的形状），而客户端要访问 `ctx.slots`、
 * `ctx.locale`、`ctx.remote.settings` 三个服务**属性**——少声明一个就抛
 * `cannot get property "x" without inject`，整个客户端半不激活，
 * 界面上表现为"插件装了但毫无迹象"。
 */
realCheck('客户端 inject 声明了 slots', /inject:\s*\[[^\]]*'slots'/.test(code));
realCheck('客户端 inject 声明了 locale', /inject:\s*\[[^\]]*'locale'/.test(code));
realCheck('客户端 inject 声明了 remote 与 remote.settings',
  /inject:\s*\[[^\]]*'remote'/.test(code) && /inject:\s*\[[^\]]*'remote\.settings'/.test(code));
realCheck('客户端 inject 不是宿主侧的 settings 形状',
  !/inject:\s*\['settings'\]/.test(code), "客户端 inject 误用了 ['settings']");

/* ------------------------------------------------------------------ */
console.log('');
console.log('[8. 宿主半的装配契约]');

realCheck('导出 apply', /export function apply\(/.test(hostSource));
realCheck('导出 inject', /export const inject\s*=/.test(hostSource));
realCheck('导出 Config（Loader 需要它投影 schema）', /export \{ Config \}/.test(hostSource));
realCheck('有幂等守卫（避免同一 ctx 留下第二套工具注册）', /new WeakSet\(\)/.test(hostSource));
realCheck('宿主半不注册 slot（那是客户端半的事）', !/ctx\.slots/.test(hostCode));
realCheck('宿主半不建定时器（本插件没有后台轮询）', !/setInterval/.test(hostCode));

/*
 * `tools` **必须**进 inject。
 *
 * 这条断言原先写反了：我当时以为可以用 `ctx.get('tools')` 绕过 inject 声明，
 * 于是断言"宿主 inject 只声明 settings"。错的。Cordis 的 `ctx.get(name)` 是
 * **安全探测**——没声明该服务时它返回 undefined 而**不抛错**，所以"绕过"的真实
 * 后果是工具一个都没注册，而 `lastBoot` 里只留下一句看起来正常的 `tools=true`
 * （那只是配置开关的值，不是注册结果）。
 *
 * 一个写反的断言比没有断言更坏：它会主动把正确的改法判为违规。
 */
realCheck('宿主 inject 声明了 tools（ctx.get 未声明时返回 undefined 而不报错）',
  /export const inject = \['settings', 'tools'\]/.test(hostCode), '宿主 inject 形状不对');
realCheck('宿主 inject 声明了 settings', /export const inject = \[[^\]]*'settings'/.test(hostCode));
realCheck('工具注册在 ctx.effect 里（由 fiber 拥有清理，与 scheduled-tasks 一致）',
  /ctx\.effect\(\(\) => \{[\s\S]*?\}, `\$\{PACKAGE_NAME\}: tools`\)/.test(hostCode)
    && /toolsService\.register\(/.test(hostCode), '注册没有放进 ctx.effect');
realCheck('自述写的是真实注册条数，不是配置开关的值',
  /detail:\s*`tools=\$\{registeredTools\}/.test(hostCode), '把配置值当结果上报了');
realCheck('优先解析宿主 defineTool（它带参数校验），拿不到才退化',
  /await import\('@deepseek-ai\/dsh-tools'\)/.test(hostCode) && /defineTool/.test(hostCode));
realCheck('取 configEditor / settings 也走 ctx.get',
  /ctx\.get\('configEditor'\)/.test(fs.readFileSync(path.join(root, 'lib/store.js'), 'utf8')));
/*
 * 启动自述必须在**注册工具之前**写。
 *
 * 比的是调用点 `buildTools(api)` 而不是标识符 `buildTools`——后者在顶部的
 * import 语句里就先出现过一次，拿它比会把"写得够早"判成"写得太晚"
 * （这条断言最初就是这么误报的）。
 */
const enterAt = hostCode.indexOf("phase: 'enter'");
const buildToolsCallAt = hostCode.indexOf('buildTools(api)');
realCheck('能定位到启动自述与工具构建两个位置',
  enterAt >= 0 && buildToolsCallAt >= 0, `enter=${enterAt} buildTools=${buildToolsCallAt}`);
realCheck('启动自述在注册工具之前写（四类故障才区分得开）',
  enterAt >= 0 && buildToolsCallAt >= 0 && enterAt < buildToolsCallAt, `enter=${enterAt} buildTools=${buildToolsCallAt}`);
realCheck('装配完成后再写 ready', hostCode.indexOf("phase: 'ready'") > buildToolsCallAt);
realCheck('用 ctx.effect 注册清理', /ctx\.effect\(/.test(hostCode));

realCheck('工具名清单完整', ['ssh_hosts', 'ssh_exec', 'ssh_list_dir', 'ssh_read_file', 'ssh_probe']
  .every((name) => toolsSource.includes(`name: '${name}'`)));
realCheck('hostId 在所有远端工具里都是必填', (toolsSource.match(/hostId: HOST_ID/g) ?? []).length === 4, String((toolsSource.match(/hostId: HOST_ID/g) ?? []).length));
realCheck('工具内部异常被兜成失败结果而不是抛给 Agent', /fail\('INTERNAL'/.test(toolsSource));

/*
 * `required` 在 value schema DSL 里是**节点级布尔标志**，不是 JSON Schema 的
 * 顶层数组。写成 `required: ['ok']` 会被 `defineTool` 拒绝：
 *   unsupported JSON schema: schema.required is not supported by the value schema DSL
 * 真机实测后果是 5 个工具全部注册失败（`tools=0`）。这条错误**只在真机注册时
 * 才暴露**——语法检查和纯函数测试都看不见它。
 *
 * 检查前**必须先剥注释**：上面这段说明本身就要写出那个错误写法，不剥的话
 * 规则会对着自己的解释文字判违规（这条断言第一次跑就是这么红的）。
 */
const toolsCode = stripComments(toolsSource);
const configSource = fs.readFileSync(path.join(root, 'lib/config.js'), 'utf8');
realCheck('value schema DSL 里不出现 JSON Schema 的 required 数组',
  !/\brequired:\s*\[/.test(toolsCode), '出现 required: [...] 数组形式');
realCheck('输出 schema 带 additionalProperties（与已验证的 scheduled-tasks 一致）',
  /additionalProperties:\s*true/.test(toolsCode));
realCheck('参数用节点级 required: true',
  /HOST_ID = \{ type: 'string', required: true/.test(toolsCode));

/*
 * `render` 必须返回**内容块数组**。
 *
 * 真机实测：写成 `(value) => JSON.stringify(value)` 时工具能注册、能被调用，
 * 但每次调用都失败在 `content.some is not a function`——宿主对返回值调 `.some`，
 * 而字符串没有这个方法。报错发生在渲染层，与工具逻辑无关，很难往这个方向想。
 * 正确形状与 scheduled-tasks 一致：`[{ type: 'text', text }]`。
 */
realCheck('render 返回内容块数组而不是字符串',
  /function renderJson\([^)]*\)\s*\{\s*return \[\{ type: 'text'/.test(toolsCode), 'render 形状不对');
realCheck('render 的第一个参数是调用参数（签名要匹配）',
  /function renderJson\(_args, value\)/.test(toolsCode));
realCheck('每个来源调用都有超时（exec.js 里自己累积并按字节封顶）', /truncated/.test(fs.readFileSync(path.join(root, 'lib/exec.js'), 'utf8')));
realCheck('超时一定杀进程（否则挂住的 ssh 会一直占着宿主）',
  /child\.kill\('SIGKILL'\)/.test(fs.readFileSync(path.join(root, 'lib/exec.js'), 'utf8')));

/* ------------------------------------------------------------------ */
console.log('');
console.log('[10. 面板的目录浏览通道（客户端→宿主）]');

/*
 * 客户端拿不到 `tools`，也不能新增 Remote 命名空间，所以面板的「列出目录」
 * 只能走 `remote.settings` 这条通用读写通道。**关键是不能退化成轮询**：
 *   `settings` 的方法列表里没有 on/watch，看起来只能定时器轮询；
 *   但事件目录里有 `settings/document-updated(ns, revision)`，那才是正确的钩子。
 * 这里断言宿主用的是事件而不是定时器——定时器会让"插件永远在跑"成为事实，
 * 而这个插件本来没有任何后台工作。
 */
realCheck('宿主监听 settings/document-updated 事件（而不是建定时器）',
  /ctx\.on\('settings\/document-updated'/.test(hostCode));
realCheck('宿主仍然没有定时器（事件驱动，不是轮询）', !/setInterval/.test(hostCode));
realCheck('事件处理里按命名空间过滤（宿主写 result 也会触发同一事件）',
  /String\(ns\) !== CONFIG_NS/.test(hostCode));
realCheck('已处理的请求记在集合里，避免自我循环',
  /servicedRequests\.has\(request\.id\)/.test(hostCode) && /servicedRequests\.add\(request\.id\)/.test(hostCode));
realCheck('处理前先 refresh（请求是客户端写进 profile 的，内存快照不会自动更新）',
  /await store\.refresh\(\);\s*\n\s*const request = store\.getRequest\(\)/.test(hostCode));

/*
 * 面板与工具必须走**同一份**列目录实现。两处各写一份，迟早出现"工具列得出来、
 * 面板列不出来"这种只在一边复现的问题。
 */
realCheck('列目录逻辑被抽成导出函数供两处共用',
  /export async function listRemoteDir\(/.test(toolsCode)
    && /listRemoteDir\(/.test(hostCode));
realCheck('ssh_list_dir 工具复用同一个函数',
  /async function runListDir\(api, input\) \{[\s\S]{0,120}?listRemoteDir\(/.test(toolsCode));

realCheck('客户端写入 internal.request（设置即通道）',
  /path: \['internal', 'request'\]/.test(code));
realCheck('客户端的等待是**有界**的（不是常驻轮询）',
  /Date\.now\(\) \+ 20_000/.test(code) && /await new Promise\(\(resolve\) => setTimeout\(resolve, 400\)\)/.test(code));
realCheck('结果按 id 配对（避免把上一次的结果当成本次）', /result\.id === id/.test(code));
realCheck('配置 schema 声明了 request 与 result（未声明字段会被剥离）',
  /request: Schema\.object\(\{/.test(configSource) && /result: Schema\.object\(\{/.test(configSource));
realCheck('目录项 schema 声明完整（path/name/directory/kind/size/mtimeMs）',
  ['path', 'name', 'directory', 'kind', 'size', 'mtimeMs'].every((field) => new RegExp(`${field}: Schema\\.`).test(configSource)));

/* ------------------------------------------------------------------ */
console.log('');
console.log('[9. Config schema（需要 schemastery 垫片）]');

/*
 * schemastery 通过 `node_modules/@deepseek-ai/schemastery` 的 junction 指向
 * `_scratch/pkgs/schemastery`（`_scratch` 与 `node_modules` 都在 .gitignore 里）。
 * 干净克隆下没有这个垫片，所以这一组**允许缺失**并明确报出来——把"没测"说成
 * "通过"比不测更坏。
 */
let SchemaModule = null;
try {
  SchemaModule = await import('../lib/config.js');
} catch (error) {
  console.log('  跳过 — 找不到 schemastery 垫片：' + (error instanceof Error ? error.message.split('\n')[0] : String(error)));
}

if (SchemaModule !== null) {
  const { Config } = SchemaModule;
  const accepts = (input) => {
    try { Config(input); return true; } catch { return false; }
  };
  realCheck('空配置可解析（Loader 首次投影 schema 时就是空对象）', accepts({}));
  realCheck('未声明字段不抛错', accepts({ hosts: [], 未知字段: 1 }));
  /*
   * 放宽 `hosts[].id` / `hosts[].host` 的 required，是这条断言守的东西：
   * 一度写成 required，于是一份手改过、少个 id 的配置会让**整段** Config
   * 校验失败——而校验失败发生在 Loader 载入阶段，后果是这一行激活不了、
   * 可能连应用都起不来，远重于"少了一台主机"。
   *
   * 分工应当是：**schema 接受归一化器能修的东西，由归一化器修补或丢弃坏行。**
   */
  realCheck('缺 id 的主机不导致整段配置校验失败（交给 normaliseHosts 补）',
    accepts({ hosts: [{ host: 'a.com' }] }));
  realCheck('缺 host 的主机不导致整段配置校验失败（交给 normaliseHosts 丢弃）',
    accepts({ hosts: [{ id: 'x' }] }));
  realCheck('超界 timeoutMs 不导致校验失败（由 resolveTimeout 收敛）', accepts({ timeoutMs: 999999999 }));
  realCheck('完整配置可解析', accepts({
    hosts: [{ id: 'h1', host: 'a.com', port: 2222, user: 'u', identityFile: '~/.ssh/k', tags: ['p'] }],
    enableTools: false,
    internal: { history: [], lastBoot: { at: 1, phase: 'ready', detail: '' } },
  }));
  // 类型错误仍然该拒：数组写成字符串是真正的畸形输入，不该被悄悄容忍。
  realCheck('hosts 不是数组时仍然拒绝（类型错误不该被吞）', accepts({ hosts: 'nope' }) === false);

  const source9 = fs.readFileSync(path.join(root, 'lib/config.js'), 'utf8');
  realCheck('schemastery 用默认导出导入（命名导入会在导入期抛 SyntaxError，应用起不来）',
    /^import Schema from '@deepseek-ai\/schemastery';/m.test(source9));
  realCheck('internal 是 volatile（describe() 只投影 volatile 节点）', /\.volatile\(\)/.test(source9));
}

/* ------------------------------------------------------------------ */
console.log('');
console.log('[11. ssh config 解析（主机的唯一来源）]');

/*
 * 主机列表从 `~/.ssh/config` 读，不在插件里再维护一份——ssh config 已经是权威
 * 副本，重填一份只会产生"面板写的和 ssh 实际连的不一致"。
 *
 * 这一组盯的是**匹配语义**，因为写错的后果比"列错主机"严重得多：曾经把"没有
 * 具体名字的块"一律当默认值，于是 `Host *.internal` 的 User 被套到所有主机上
 * ——真机含义是**用错误的用户去登录**。
 */
{
  const { parseSshConfig, configHostsToHosts } = await import('../lib/sshconfig.js');
  const sample = [
    'Host *',
    '  ServerAliveInterval 60',
    '  User defaultuser',
    '  IdentityFile ~/.ssh/id_ed25519',
    '',
    'Host dev',
    '  HostName 10.0.0.5',
    '  User deploy',
    '  Port 2222',
    '',
    'Host prod web2   # 一台机器两个别名',
    '  HostName prod.example.com',
    '  IdentityFile ~/.ssh/prod_key',
    '',
    'Host *.internal',
    '  User ops',
    '',
    'Host db.internal',
    '  HostName 10.0.0.9',
  ].join('\n');
  const parsed = parseSshConfig(sample);
  const byAlias = (alias) => parsed.hosts.find((host) => host.alias === alias);

  realCheck('只有具体名字的块产出主机（通配块不产出）', parsed.hosts.length === 4, parsed.hosts.map((h) => h.alias).join(','));
  realCheck('Host * 作为默认值被合并', byAlias('prod')?.user === 'defaultuser', byAlias('prod')?.user);
  realCheck('具体块的 User 覆盖默认值', byAlias('dev')?.user === 'deploy', byAlias('dev')?.user);
  realCheck('具体块的 Port 覆盖默认值', byAlias('dev')?.port === 2222, String(byAlias('dev')?.port));
  realCheck('具体块未写的项继承默认值', byAlias('dev')?.identityFile === '~/.ssh/id_ed25519', byAlias('dev')?.identityFile);
  realCheck('一行多个别名各成一条', byAlias('prod') !== undefined && byAlias('web2')?.host === 'prod.example.com');
  /*
   * 这条是那个真实 bug 的回归：`Host *.internal` 只该影响匹配它的主机。
   * 写错时 prod 会拿到 ops（错误的登录用户），而不是 defaultuser。
   */
  realCheck('非全局通配块不污染其它主机（Host *.internal 的 User 不该给 prod）',
    byAlias('prod')?.user === 'defaultuser' && byAlias('web2')?.user === 'defaultuser',
    `prod=${byAlias('prod')?.user} web2=${byAlias('web2')?.user}`);
  realCheck('通配块对匹配它的主机生效，且覆盖默认值',
    byAlias('db.internal')?.user === 'ops', byAlias('db.internal')?.user);
  realCheck('行尾注释被去掉（别名不被注释污染）', byAlias('web2') !== undefined);
  realCheck('Include 被警告而不是静默忽略',
    parseSshConfig('Include ~/.ssh/conf.d/*\nHost a\n HostName a.com').warnings.length === 1);
  realCheck('空输入/坏输入不抛错',
    parseSshConfig('').hosts.length === 0 && parseSshConfig(null).hosts.length === 0);
  realCheck('坏端口回落 22', parseSshConfig('Host a\n Port nope').hosts[0].port === 22);
  realCheck('Key=value 与 Key value 两种写法都支持',
    parseSshConfig('Host a\n HostName=x.com\n Port=2200').hosts[0].host === 'x.com');
  realCheck('归一化后字段与工具侧一致',
    configHostsToHosts(parsed.hosts).every((host) => typeof host.id === 'string' && typeof host.host === 'string' && Number.isFinite(host.port)));
  realCheck('宿主从 ssh config 取主机（不再读手填的 hosts）',
    /const getHosts = \(\) => readSshHosts\(\)\.hosts/.test(hostCode)
      && !/getConfig\(\)\.hosts/.test(toolsCode));
  realCheck('ssh config 不存在时不报错，而是给一条说明',
    /code === 'ENOENT'/.test(fs.readFileSync(path.join(root, 'lib/sshhosts.js'), 'utf8')));
}

console.log('');
if (failures.length > 0) {
  console.log('失败 ' + failures.length + ' 项：');
  for (const item of failures) console.log('  - ' + item);
  process.exit(1);
}
console.log('全部通过：' + ok + ' 项装配形状与纯函数语义断言（真实 SSH 连通性仍需在真机确认）。');
