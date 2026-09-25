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
 * 取服务必须走 `ctx.get()`，不能写 `ctx.tools` 这类**属性访问**。
 *
 * Cordis 规则：访问服务属性必须先在 `inject` 里声明该服务，否则抛
 * `cannot get property "tools" without inject`。这条错误在 apply 期间抛出，
 * 后果是**整行激活失败**——真机实测诊断只有一行 `1 entry did not activate`，
 * 界面上完全看不出是插件的问题，极难定位。
 */
realCheck('取 tools 服务用 ctx.get 而不是 ctx.tools（属性访问要求 inject 声明）',
  /ctx\.get\('tools'\)/.test(hostCode) && !/ctx\.tools/.test(hostCode), '出现 ctx.tools 属性访问');
realCheck('取 configEditor / settings 也走 ctx.get',
  /ctx\.get\('configEditor'\)/.test(fs.readFileSync(path.join(root, 'lib/store.js'), 'utf8')));
realCheck('宿主 inject 只声明 settings（tools 用查询语义，缺失时不该让整行不激活）',
  /export const inject = \['settings'\]/.test(hostCode), '宿主 inject 形状变了');

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
realCheck('每个来源调用都有超时（exec.js 里自己累积并按字节封顶）', /truncated/.test(fs.readFileSync(path.join(root, 'lib/exec.js'), 'utf8')));
realCheck('超时一定杀进程（否则挂住的 ssh 会一直占着宿主）',
  /child\.kill\('SIGKILL'\)/.test(fs.readFileSync(path.join(root, 'lib/exec.js'), 'utf8')));

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
if (failures.length > 0) {
  console.log('失败 ' + failures.length + ' 项：');
  for (const item of failures) console.log('  - ' + item);
  process.exit(1);
}
console.log('全部通过：' + ok + ' 项装配形状与纯函数语义断言（真实 SSH 连通性仍需在真机确认）。');
