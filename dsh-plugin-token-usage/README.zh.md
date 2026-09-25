[English](README.md) | 中文

# dsh-plugin-token-usage

**展示提供方上报的真实 token 用量，按 `(provider, model)` 归并**：会话头部有一个实时指示器
显示你所在的这个会话，另有一个独立页面把**跨会话**的总量加起来。所有数字都来自提供方
适配器真实上报的内容 —— **不做任何估算，也不算费用**。

内置的 `@deepseek-ai/dsh-token-meter` 已经注册了一个名为 `tokenUsage` 的会话投影，
它用的四个桶与本插件相同：

> 它承载的是**整个会话**的合计，所以能回答"这个会话用了多少 token"，
> 但回答不了"其中模型 A 占多少、模型 B 占多少"。

本插件补的正是这一段：宿主把按模型的拆分算好一次，作为 `wire.view` 投给浏览器；
跨会话表格则靠宿主做一次**有上限**的扫描得出，浏览器侧自己算不出来。

## 它做什么

- **会话内实时指示器**：会话头部工具区（`conversation.session.header.utilities`，
  id `token-usage`，order 40）的一个席位。它显示本次会话的总 token 数，点开浮层看
  按模型拆分的明细 —— 每个模型的总量、占比条、调用次数，以及**四个桶**
  （输入、输出、缓存读、缓存写）。投影本来就把每行的桶一起带过来了；只渲染总量
  只能回答"哪个模型花得多"，回答不了"花在输入还是输出、其中多少命中了缓存"。
  会话内还没有上报用量时，指示器**什么都不渲染**，而不是在头部留一个空角标。
- **独立页面**：侧边栏面板图标（`sidebar.panellist`，id `token-usage`，order 30）
  加主区域页面（`main`，同一个 key）。这个页面是**跨会话**的按模型表格 ——
  模型、输入、输出、缓存读、缓存写、合计、占比 —— 按总量降序排列，
  **每页 20 行**，带一个「刷新」按钮。表格上方还有两张图：按模型占比的环形图，
  以及**按天的贡献热力图**（一列 = 一周，一行 = 一个星期几，越深 = 那天 token 越多）。
  左侧星期轴只标隔行的三行（周一 / 周三 / 周五），文案走 `t()`，**英文界面下是
  `Mon` / `Wed` / `Fri`**（英文比中文宽，标签列宽因此写死为网格列轨道 14px 的整数倍
  28px，这样右侧网格的起点不随语言平移）。
  热力图默认只画**数据末尾往前 365 天（一整年）** —— 锚点是**数据里最晚的那一天，不是今天**：
  这份 timeline 是历史扫描的产物，可能已经陈旧，用今天当锚点只会画出一片没有用量的空列。
  窗口**不按数据起点收缩**：窗口里**每一天都占一个格子**（没数据的补 0），所以数据只有
  两天时画出来的仍然是整整 365 天（53 列 371 格），而不是孤零零两列。空格子表达的是
  **"这天没有用量"** —— 那正是热力图要传达的信息（哪天断过），不是谎报；窗口必须由
  "这段时间"决定，而不是由"碰巧有数据的那几天"决定。
  上方给两个日期输入与「近 7 天 / 近 30 天 / 全部」三个预设：`to` 会被**夹到数据末尾**
  （往未来画格子才是真的谎报——那不是"没用过"而是"还没发生"），**`from` 早于数据起点时
  保留**（否则窗口里没数据的日期又会被整段吃掉），但整个窗口的跨度不超过 **366 天**
  （手打 2020 年只会得到一年宽的窗口，而不是横跨六年的网格）。默认窗口是 **365 天**，
  正好落在这个上限之内、还留一天余量，所以**永远不会被静默夹短**（有一条断言钉住
  "默认窗口经 `clampRange` 后 `clamped === false`"；没有它的话，将来把默认调大过上限，
  窗口会被悄悄削短而没人发现）。夹过的值写回输入框
  （框里显示的就是画出来的），清空某一端表示那一端不限制。
  鼠标悬停或键盘聚焦格子时给的是**自绘浮层**，不再是原生 `title`（原生 tooltip 的样式由系统
  渲染、无法用 CSS 定制）；格子仍然带 `aria-label`，无障碍不退化。
  两个日期输入显式上了令牌色（`bg-layer-2 / border-l2 / label-primary`），
  **原生日期选择器的日历图标不另外处理**：它由浏览器按页面的 `color-scheme` 绘制，
  而应用自己已经把它设在根元素上（见「验证状态」里的查证证据）。
- **只用真实数字**：计数来自会话日志里 `assistant/message` 事件的 `usage` 字段，
  就是提供方适配器上报的原样。本插件**不做任何估算，也不计算费用**。

## 为什么这样设计

### 只用提供方上报的用量，且与官方投影同一套四桶口径

四个桶是 `uncachedInputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`
—— 与官方 `@deepseek-ai/dsh-token-meter` 的 `tokenUsage` 投影同一套口径。
`reasoningTokens` 刻意**不在其中**：它通常是 `outputTokens` 的子集，单独成一列既会与
官方数字对不上，也容易让人把它重复加进总量。

适配器没有上报的字段一律记 `0`，绝不猜：适配器不报缓存用量，意思是"未上报"，
而不是"没有缓存"。负值与 `NaN` 同样按"未上报"处理，小数一律向下取整。

### 按模型的拆分在宿主算好，不在浏览器算

官方实践规则写得很明确：

> When the Client needs a value derived from a session, declare `wire.view` on the Host
> projection. The value reaches the Client already computed; the Client does not fold session
> events itself.

所以宿主侧注册了一个**自己的会话投影单元** `tokenByModel`（`stateVersion: 1`，
带 `stateSchema`、`init`、对无关事件返回同一引用的纯 `apply`，以及
承载 `viewSchema` 与 `view` 的 `wire` 块）。浏览器侧只是
`useProjection('tokenByModel')` 取值并渲染，完全不接触事件流。

`assistant/message` 事件在 `message.source` 里带着这次调用的身份
（`{ kind: 'model', provider, model }`），所以按 `(provider, model)` 的折叠由
`lib/fold.js` 完成，排好序的行也在宿主产出。

为什么不复用官方已有的 `tokenUsage` 投影：它只有整个会话的四个桶合计，
没有按模型拆分 —— 而拆分正是本插件要的东西。

### 跨会话总量只能由宿主扫描

跨会话汇总不属于任何单个会话，装不进会话投影。而 `ctx.sessionQuery` 的方法
**都不是** `@Remote`，浏览器侧根本读不到别的会话的日志。唯一走得通的路是：

1. 宿主列出会话、按最新优先读日志、折叠 `assistant/message` 事件，
   把汇总写进插件设置；
2. 浏览器侧用 `remote.settings.describe()` 读回来。

为什么非得走设置：`ctx.remote.*` 是**编译期固定白名单**，第三方纯 JS 插件加不了
Remote 命名空间 —— 根本没有注册入口。`remote.settings` 是唯一通用的读写通道，
而且这条路已被姊妹插件 `dsh-plugin-scheduled-tasks` 在真机上验证过。

### 扫描是有界的，而且界面上说得明白

- **`scanLimit` 默认 200 个会话**，可在 `cordis.patch.yml` 里配置。
- 会话按创建时间**最新优先**扫描。日志里的会话数超过上限时，页面会直接把话说明白
  ——「只扫描了最近的 N / M 个会话，更早的未计入」—— 不会悄悄少算。
- 读不出来的会话日志会被**跳过并计数**，页面在扫描说明旁显示跳过了多少个。
- 读历史日志是 O(会话数 × 事件数)，所以只有客户端请求刷新、或从未扫描过时才扫。
  宿主每分钟检查一次，但没有待处理请求、且手上已有汇总时，这一轮什么都不做。

### 别的几个选择

- **刷新是请求，不是就地扫描**：按钮只把 `internal.refreshRequestedAt` 一个时间戳
  写进插件设置，宿主在下一轮取走并在宿主侧扫描。页面在挂载时读一次设置快照，
  所以新表格要等宿主扫完、页面再读一次才会出现。
- **`internal` 在 Config schema 里是 `.volatile()`**：`@deepseek-ai/dsh-settings` 的
  `describe()` 只投影 volatile 节点，而一个 volatile 字段都没有时 `mutate()` 会直接抛。
  所有需要被界面读回的值（跨会话汇总、刷新请求）都住在 `internal` 下。
- **归不到模型的调用也照样入账**：消息 `source.kind` 不是 `model` 时（system prompt、
  工具结果），用量进 `unknown/unknown` 桶并单独计数，这样总量才对得上提供方，
  而不是把 token 悄悄丢掉。
- **排序放在纯函数层**：`rowsOf` 按总量降序排，同量时按 key 稳定排序，
  宿主与客户端不可能对顺序产生分歧。
- **只显示 token，不显示费用**：DSH 有 route-pricing 机制，但它需要供应商定价数据。
  本插件刻意不做估算，而不是给出一个误导性的金额。

## 目录结构

```
dsh-plugin-token-usage/
├── package.json          # dsh.bundle.patch + dsh.client 声明
├── cordis.patch.yml      # bundle 补丁：插入 id 为 token-usage 的宿主条目
├── index.js              # 宿主侧：注册投影 + 有上限的跨会话扫描
├── lib/constants.js      # 无依赖常量（命名空间、投影 key、四个桶、上限）
├── lib/fold.js           # 纯函数：四个桶、按 (provider, model) 折叠、行、格式化
├── lib/config.js         # Config schema（schemastery）：scanLimit + volatile internal
├── lib/store.js          # 设置层：读写汇总、消费刷新请求
├── lib/projection.js     # tokenByModel 会话投影单元及其 wire.view schema
├── lib/summary.js        # 跨会话扫描：列会话、读取、折叠、统计跳过
├── client.js             # 浏览器侧：两个界面 + 页面与指示器组件
├── locale/{en,zh}.json   # 插件页标题与描述
├── icon.svg              # 面板图标（currentColor，24x24）
├── scripts/test-fold.mjs # lib/fold.js 纯函数测试（零依赖）
├── CONTRACT.md           # 接口冻结 v1（团队协作契约）
├── README.md             # 英文（默认）
└── README.zh.md          # 中文
```

`lib/fold.js` 是**零依赖纯函数层**：除 `lib/constants.js` 外不 import 任何东西，
由宿主侧与自检脚本共用，纯 Node 下不需要任何垫片就能跑。

## 安装

```text
plugin_manager install_bundle  target: file:E:\repos\dsh-plugins\dsh-plugin-token-usage
```

它会做两件事：把包加进 profile 的 `dependencies`，并把 `dsh-plugin-token-usage`
追加到 profile 的 `dsh.profile.bundles`。补丁层只插入一行宿主条目：

```yaml
- insert:
    - id: token-usage
      name: 'dsh-plugin-token-usage'
```

浏览器侧不需要在补丁里声明：`dsh-client-modules` 扫描已启用 Loader 条目的
`package.json dsh.client`，再通过 `exports["./client"]` 取 bundle。
Loader 行 id `token-usage` 同时是本插件的设置命名空间，
浏览器侧写刷新请求时用的就是它。

### 改动之后要重新安装

pnpm 对 `file:` 依赖是**拷贝**而不是软链，所以改了 `client.js` / `lib/*.js` 之后
必须让 profile 拿到新文件：

```text
plugin_manager remove_bundle   target: dsh-plugin-token-usage
plugin_manager install_bundle  target: file:E:\repos\dsh-plugins\dsh-plugin-token-usage
```

（直接重复 `install_bundle` 会返回 `changed: false` / `ambiguous-install`。）
重新安装后**刷新页面**，浏览器才会拿到新的 bundle。

### 卸载

```text
plugin_manager remove_bundle   target: dsh-plugin-token-usage
```

## 使用

1. 点侧边栏的「Token 用量」图标进入页面（同一页面也会在 `main` 区域以
   `token-usage` 这个 key 挂载）；
2. 表格是跨会话汇总，一个 `(provider, model)` 一行；
3. 页脚显示扫描了多少个会话（共多少个）、跳过了几份日志，以及上次扫描的时间；
4. 会话里，头部指示器显示本次会话总量；点开看按模型的明细。

### 数字从哪来

唯一的输入是会话日志里 `assistant/message` 事件的 `usage` 对象
（`{ inputTokens, outputTokens, totalTokens?, cacheReadTokens?, cacheWriteTokens?,
reasoningTokens? }`）。它被归一成四个桶：

| 列 | 桶 | 来源 |
| --- | --- | --- |
| 输入 | `uncachedInputTokens` | `usage.inputTokens` —— 未命中缓存的那部分输入 |
| 输出 | `outputTokens` | `usage.outputTokens` |
| 缓存读 | `cacheReadTokens` | `usage.cacheReadTokens`（适配器不上报时为 0） |
| 缓存写 | `cacheWriteTokens` | `usage.cacheWriteTokens`（适配器不上报时为 0） |

只有真正带用量的事件才算一次尝试；一次重试会各自留下一条 `assistant/message`，
所以调用次数就是计费次数。模型行的 provider 与 model 取自 `message.source`；
`source.kind` 不是 `model` 的调用落进 `unknown/unknown` 行，
会话指示器把它标为「未归属模型」。

点**刷新**只是排一个请求，而不是在页面里扫描：浏览器通过 `remote.settings.mutate()`
写入 `internal.refreshRequestedAt`，宿主在下一轮（每分钟检查一次）完成扫描。
页面在挂载时读一次设置快照，所以新数字要等宿主扫完、页面再读一次才会出现。
profile 无法写入设置时，按钮会禁用并说明原因。

## 验证状态

### 自动化检查（全部 exit 0，本会话实际运行）

```powershell
node scripts/test-fold.mjs        # 全部通过：81 项断言
node scripts/test-summary.mjs     # 全部通过：35 项断言
node scripts/verify-layout.mjs    # 全部通过：306 项布局与结构断言
node scripts/verify-contract.mjs  # 全部通过：292 项装配形状断言
```

`verify-contract.mjs` 在这个插件上最值得留着，因为本包有四条性质**没法靠运行它本身**验证：

- **两侧的常量必须一致。** `client.js` 无法 import `lib/constants.js`（浏览器 bundle 只拿到
  `require`），所以 `PANEL_ID`、`CONFIG_NS`、`PROJECTION_KEY`、`TOKEN_BY_MODEL_KEY` 各有两份。
  脚本同时解析两侧并比对，还用 `window.__ModuleLoader__` 桩把浏览器侧**真的**跑起来。
- **两份 `formatTokens` 必须逐值一致。** 出于同样的原因这份重复无法避免。脚本从
  `__internals` 取出浏览器侧那份，与 `lib/fold.js` 逐值比对 16 个取值加上
  `-1` / `NaN` / `Infinity` 三个边界。把任一侧的阈值改掉都会让它失败，所以这不是走过场。
- **数据形状必须挺过两侧之间的那一跳。** 宿主折叠 → 写入 `internal.summary` → settings 服务
  投影 → 浏览器读回。任何一处嵌套层级、字段名或大小写不一致，界面上都只表现为"没有数据"，
  而不会报错。脚本用**宿主真实的 store** 写一次（捕获它实际提交的完整 raw config），
  把那份 config 按 `settings.describe()` 的返回形状包起来，交给浏览器侧真实的
  `readSummary` / `normaliseRows` 读回，逐行比对两端——并附一条负向对照：把 `summary`
  放上一层，浏览器侧必须什么都读不到。
- **持久化必须按失败回退，而不是按可用性二选一。** `mode` 只决定"优先用谁"；
  `persist()` 两条通道都试，只有两条都抛错才算失败。脚本用桩做了行为验证 ——
  `configEditor` 抛错时仍会经 `settings` 写成功，两条都死则如实返回 `false`。

布局约定同样被写成断言（`verify-layout.mjs`）：每个定义出来的 `stu-*` 类都被用到、每个用到的
类都有定义、颜色只走 `--dsw-alias-*`（唯一例外是那处已记录的 `box-shadow`）、不出现
`word-break: break-all`、根容器**必须**声明 `height: 100%` 并自建 `overflow: auto`（`main` 席位不给滚动容器，限宽放在内层子元素上），以及**两个组件里所有 hook 都在第一个
`return` 之前** —— 违反这条会让整个 slot 变空白（React #310）。

图表的数学是**跑出来**验证的，不是拿正则看源码 —— 图算错了照样渲染成功，只是撒谎。
热力图有三条尤其被钉死：列必须对齐到自然周（网格从"窗口起点所在周的周日"起画，
于是每个格子的行号严格等于它真实的 `getDay()`）；强度必须落在**同一个色相的四档**上
（负向对照把它压成 `total > 0 ? 4 : 0` 时，整个套件立刻变红）；**网格必须按窗口铺满**
而不是按数据跨度画 —— 断言把"整个窗口覆盖的整周数 × 7 + 图例 5"算成确切数字
（默认 365 天窗口 = 53 列 = 371 格 + 5 个图例色块 = **376** 个格子节点），而不是"大于 0"。
同一条断言里窗口列数还**独立算了两遍**（字面量 53 × 7 = 371，以及按夹取后的窗口现跑一遍
`weeksInWindow`），所以任何一侧单独漂移都会红。
把 `renderHeatmap` 里那一步补窗去掉（负向对照 A）时，"3 天数据也铺满整个窗口"的断言立刻红。

日期区间用同一套办法钉：默认窗口是 **365 天（一整年）**、锚在**数据里最晚那天**
（负向对照把锚点改成"今天"时套件变红），而且默认窗口必须**严格落在** 366 天跨度上限之内
—— 负向对照把默认调到 400 天时，"默认窗口不会被静默夹短"这条立刻红：没有它，将来有人把
默认调大过上限，窗口会被悄悄削短而没人发现。
窗口**不按数据起点收缩**（负向对照 B 把 `from` 夹回数据最早那天时，"2 天数据也铺满 365 天"
的断言立刻红）、`to` 被夹到数据末尾而 **`from` 早于数据起点时保留**、
整个窗口跨度不超过 366 天（超了只把 `from` 推到 `to − 366 天`）、
`from > to` 交换两端而不是塌成单天、清空某一端是"不限制"（`from` 为 null 仍解析成数据最早
那天，「全部」预设靠这条）而不是 `NaN` 日期、选中的区间里没有用量时空态**保留控件**
（否则用户被锁在空区间里出不来）。
`padRangeToDays` 这个补窗纯函数单独成组：空数组不补、单天、跨月、跨年、跨闰日、
`from > to` / 端点不可解析 / 非对象 range 原样返回不抛、坏条目丢掉、同一窗口内不重不漏、
六年宽的窗口有循环次数保护（最多 `MAX_RANGE_DAYS + 1` 项）、
以及"补满之后几何的跨度就是窗口"（2 天数据 + 一个刻意取小的 30 天窗口 → 5 列 35 格，
不补则只有 1 列；这里用 30 天是为了让补窗这一步的算术能手算核对，**默认**窗口另由
`defaultRange` 现算的那一组断言负责）。
自绘 tooltip 同样被钉：它不能在横向滚动容器内部
（在那里一定被裁）、格子必须带 `aria-label` 且**不能**带 `title`（两者并存会同时弹两个）、
位置必须被夹在卡片内。

星期轴与原生日期控件这两件事由第 8.h 组单独钉：

- **星期轴的双语。** 断言不查源码里有没有 `t('heatWeekdayMon')`，而是拿中文与英文两份
  文案表**各渲染一次真实的热力图**，逐字比对渲染树里那三行标签的文字——中文必须是
  `一 / 三 / 五`、英文必须是 `Mon / Wed / Fri` 且不含任何 CJK 字符。把标签改回硬编码
  中文（负向对照 A）时英文那几条立刻红。同时逐值算出标签列宽（从 CSS 规则里读列宽、
  轨道宽、字号，不在测试里重复写死），要求它是 14px 列轨道的整数倍、放得下最长的英文
  标签，并且只允许溢出、不允许折行或省略号截断。
- **原生日期控件的配色前提。** 日历图标由浏览器按页面的 `color-scheme` 绘制，所以先查证
  应用有没有自己设置它，再决定改不改。查证结果（用 `_scratch/asar.mjs` 从
  `resources/app.asar` 读出的原文）是**应用已经设了，而且设了两处**：
  1. `@deepseek-ai/dsh-client-ui-theme/lib/index.js` 里
     `bootThemeStyle()` 产出 `:root{color-scheme:light}` / `:root{color-scheme:dark}`
     （`system` 偏好包在 `@media(prefers-color-scheme:dark)` 里），宿主把它作为
     `kind:"style"` 注入 `<head>`，**在任何脚本执行之前**就定下了文档配色；
  2. `@deepseek-ai/dsh-client-ui-layout/lib/client.js` 的 `ThemePresenter.apply()` 里
     `document.documentElement.style.colorScheme = snapshot.active.colorScheme`，
     运行时切主题时持续改写（`dispose()` 里归还）。

  所以**没有**加 `::-webkit-calendar-picker-indicator` 的对比度覆盖（那会在另一种主题下
  反过来出错），也不自绘图标，更没有写死 `color-scheme`（还会与宿主的 applier 抢同一份
  设置）。断言改成把这个**前提**钉住：本插件不出现 `color-scheme`，并在能读到已发布应用包
  时验证上面两处证据确实存在（读不到时打印"跳过"而不是静默变绿）。图标的最终观感仍需
  **真机确认**——它是浏览器绘制的，静态分析看不到。

这套断言覆盖的是纯函数层 —— 插件两侧都依赖它算数：

| 面 | 覆盖内容 |
| --- | --- |
| `bucketsOf` | 完整上报时四个桶都取到；缺缓存字段记 0 而不是猜；完全没有输入输出时返回 `null`；输入输出都是 0 仍是有效用量；负值与 `NaN` 按"未上报"处理；`reasoningTokens` 不进任何桶 |
| 桶运算 | `totalOf` 四桶相加且容错 `null`；`emptyBuckets`；`addBuckets` 逐桶相加、不改入参、容忍 `undefined` |
| `attemptOf` | 只认 `assistant/message` —— `assistant/attempt`（只有流、无用量）、没有 `usage` 的事件、垃圾 `usage`、非对象事件一律返回 `null` |
| `modelIdentityOf` | 必须 `source.kind === 'model'`；`system-prompt` 与 `tool` 消息不算模型调用；缺 model 时回落 `provider/unknown`，其余回落 `unknown/unknown` |
| `applyAttempt` | 纯函数（无关事件返回同一引用、不改入参状态、返回新对象）；同 key 累加；重试计为独立次数；归不到模型的尝试单独计数且仍落进 `unknown/unknown` 桶 |
| `foldEvents` / `rowsOf` | 折叠混合事件流；按总量降序；同量按 key 稳定排序；`rows` 里的桶是副本；空状态与 `null` 状态 |
| 格式化 | 紧凑格式（`1000` → `1K`、`1234` → `1.2K`、`123456` → `123K`、`1000000` → `1M`、`1000000000` → `1B`、负值与 `NaN` → `0`）与千分位的精确格式 |

### 真机端到端（本会话在运行中的 Host 上实测）

- **宿主侧激活**：本插件的 Config 报告 `status: "schema"`。这同时证明 `zod` 与
  `@deepseek-ai/schemastery` 在宿主进程内可解析。
- **浏览器侧激活**：客户端席位 `token-usage` 在 `conversation.session.header.utilities`
  中 `active: true`，与官方 `open-in-app`、`session-log-download` 并列，
  且没有顶掉任何官方控件。
- **投影 schema 在真机 `zod` 4.6.5 下合法**：宿主模块加载成功，
  就意味着 `lib/projection.js` 的静态 `import { z } from 'zod'` 与其中所有 `z.*`
  调用在真机上都成立。

### 未验证（需人工在真实页面确认）

- **视觉呈现**：配色、间距、浅色/深色主题下的对比度 —— 均未验证。本会话拿不到浏览器
  控制权，按官方验证规则**不做** mock 预览、截图或模拟 React 渲染来"证明"视觉效果。
- **会话内指示器在真机上的实际读数与浮层交互**：两者都需要浏览器控制，尚未观察到。
- **投影的 `wire.view` 输出没有在离线环境用 `zod` 校验过**：`zod` 只存在于 DSH 安装包
  （`app.asar`）内，纯 Node 解析不到，所以这项校验离线无法复现。已验证的是：
  在 `zod` 存在的地方 schema 构造成功（见上）。

### 重新加载已安装的插件代码

`pnpm` 对 `file:` 依赖是**拷贝**，且宿主进程会缓存已加载的模块。改了插件代码后：

```text
plugin_manager remove_bundle  target: dsh-plugin-token-usage
plugin_manager install_bundle target: file:E:\repos\dsh-plugins\dsh-plugin-token-usage
```

然后**重启 Host**（或重新启用该 Loader 条目）才会加载新的 JavaScript 生成；
只刷新页面只能拿到新的浏览器侧 bundle。Node 的 ESM 模块缓存按解析路径命中，
换掉磁盘文件不会换掉已经导入的模块 —— 所以宿主侧的改动（投影、扫描、config schema）
在重启之前看起来就像"修了没用"。

### 仓库工具脚本的运行前提

`node scripts/test-fold.mjs` 什么都不需要：`lib/fold.js` 只 import
`lib/constants.js`，纯 Node 下不需要任何第三方包就能跑。宿主的 `lib/config.js`
确实需要 `@deepseek-ai/schemastery`，它由 dsh 安装提供、不在本插件的依赖里 ——
但本插件没有任何脚本 import 它，因此这里不需要 `node_modules` 垫片。

## 已知限制

- **实时视图依赖宿主的会话投影**：一个 profile 若没有 `sessionProjections`
  （或缺少 `sessionManager` 类服务），该视图会渲染一句降级说明而不是数字。
  本插件**不会**因此整体失效 —— 跨会话页面仍然可用。
- **跨会话的数字范围受 `scanLimit` 限制**（默认 200 个会话）：更早的会话不计入，
  页面会明确写出这一点，而不会暗示这个数字就是全部历史。
- **归不到模型的调用被保留而不是丢掉**：消息 `source.kind` 不是 `model` 的用量
  进 `unknown/unknown` 行并单独计数，界面标为「未归属模型」—— 这样总量才对得上
  提供方，而不是把 token 丢掉。
- **只显示 token，不显示费用**：DSH 有 route-pricing 机制，但需要供应商定价数据；
  本插件刻意不做估算，避免给出误导性的金额。
- **只显示适配器上报过的内容**：提供方不上报缓存用量时，缓存列显示 0 ——
  插件不会回填提供方从未发来的数字。
- 没有构建步骤：`client.js` 就是可直接加载的浏览器 bundle。
