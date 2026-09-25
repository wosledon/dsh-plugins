[English](README.md) | 中文

# dsh-plugin-scheduled-tasks

**定时按提示词触发大模型执行任务**：写一条提示词、给一个时间表达，到点 DSH 会
**真的开一个新会话跑模型**，把结果写进运行日志。

内置的 `@deepseek-ai/dsh-schedule` 做的是另一件事：

> 它只在到点时把一段**提醒文本投递进已有会话**，等你自己去看。
> 它**不触发任何模型执行** —— 没有人打开那个会话、没有人送一条消息，就什么都不会发生。

本插件补的正是这一段：`ctx.agentLoop.createAgent(...)` 建一个属于该次运行的会话，
`agent.followup(prompt)` 唤醒一轮，然后等**耐久事件** `turn/end` 收尾。
即使当时没有任何窗口看着它，任务也会跑完并把结果落进日志。

## 它做什么

- **菜单入口**：侧边栏面板图标（`sidebar.panellist`，id `scheduled-tasks`，order 20）
  与主区域页面（`main`，同一个 key），面板打开就是任务管理页。
- **5 种时间表达**：间隔 `every`、每日 `daily`、每周 `weekly`、cron 五段、一次性 `once`。
- **真正执行**：每次触发生成 sessionId `scheduled-task-<taskId>-<epochMs>`，
  新建 agent、驱动一轮、拿最后一条 assistant 文本当结果摘要，结束无论成败都 `dispose()`。
- **运行日志**：宿主侧环形缓冲（默认 200 条），运行开始写一条 `running`，结束时
  **原地替换**为终态（`ok` / `error` / `timeout` / `skipped`），带 `sessionId` 可跳转。
- **任务可携带 skill 与运行约束**：可选 `skill`（提示执行体先加载该 skill）、
  `tools` 白名单、`workspaceRoot`（该次运行的 cwd）、`model`（覆盖 provider/model）。
- **对话创建**：注册 5 个模型工具 `scheduled_task_create` / `_list` / `_update` /
  `_delete` / `_run`，并注册 `scheduled-tasks` skill —— 直接说
  「每天早上 9 点帮我总结昨天的 git 提交」就能建任务。

## 为什么这样设计

### Config 是唯一的持久化状态

配置文档（Loader 行 id 就是 `scheduled-tasks`，也是设置命名空间）就是数据库：

```jsonc
{
  "enabled": true,            // 总开关
  "tickMs": 30000,            // 调度器轮询间隔
  "maxConcurrentRuns": 2,     // 同一 tick 内并发上限
  "runTimeoutMs": 1800000,    // 单次运行超时（30 分钟）
  "logLimit": 200,            // 日志环形缓冲条数
  "workspaceRoot": null,      // 默认 cwd
  "tasks": [ /* ScheduleTask[] */ ],
  "internal": { "log": [ /* LogRecord[] */ ], "runs": { /* 运行中去重标记 */ } }
}
```

任务定义、运行中去重标记、运行日志全在这一个文档里：卸载/重装插件不会留下第二份
状态，写回统一走 `ctx.settings.mutate` 的乐观并发控制（每次带刚读到的 `revision`），
所以界面和宿主同时改任务时不会互相覆盖。

### 客户端为什么不用自定义 Remote

DSH 客户端 `ctx.remote` 的 namespace 是**编译期固定白名单**：只有官方 bundle
里预先声明过的名字（`settings`、`workspaceFiles`、`llm`……）存在，
第三方纯 JS 插件**无法新增** namespace —— 不是"没写文档"，而是根本没有注册入口。

所以本插件的浏览器侧完全没有自定义 Remote，只复用既有的
`ctx.remote.settings.describe()` / `mutate(ns, ops, revision)` 作为读写通道：

- 读：`describe()` 里找本插件那条，拿任务列表、日志和 `revision`；
- 写：`mutate(CONFIG_NS, [{ op: 'set', path: [...], value }], revision)`；
- 并发：设置是 CAS 语义，revision 不匹配就重新 `describe()` 后重试一次，
  仍失败则提示用户重试，而不是覆盖别人的修改；
- 降级：`ctx.settings` / `remote` 缺失时只读渲染或提示，绝不抛异常拖垮插件。

### 运行日志为什么不走 `remote.workspaceFiles`

那条通道需要 `sessionId` 才能定位工作区文件，而 `main` 是 **root scope、不绑定
session** 的 keyed slot —— 页面拿不到 `sessionId`。日志因此改由 Config 承载，
宿主只写、客户端只读；跨进程零额外 API。

### 别的几个选择

- **每次运行开新会话**，而不是塞进已有会话：任务之间互不污染，可以并发，
  日志里的 `sessionId` 也能直接跳过去看那次运行到底做了什么。
- **等 `turn/end` 这类耐久事件**，不轮询 `agent/status`：轮询会漏事件且浪费 tick，
  超时保护用 `runTimeoutMs` 兜底。
- **提示词里写死"不要询问确认"**：这次运行没有人可以回答它，问确认等于卡死。
- **cron 只支持五段子集**：拒绝 `L`/`W`/`#`、英文名、`@daily` 宏、六段、步长 0。
  纯 JS 实现可以做到完全可预测、可单测、跨平台一致，而不是悄悄给出错误的下一次时间。
- **`once` 触发后自动 `enabled: false`**：一次性任务留在列表里可见，但不会重复触发。

## 目录结构

```
dsh-plugin-scheduled-tasks/
├── package.json          # dsh.bundle.patch + dsh.client 声明
├── cordis.patch.yml      # bundle 补丁：插入 id 为 scheduled-tasks 的宿主条目
├── index.js              # 宿主入口：Config、apply、装配
├── lib/config.js         # Config schema + 常量 + 默认值
├── lib/constants.js      # 无依赖常量（命名空间、默认值、字段上限）
├── lib/model.js          # 纯数据：任务读写、校验、序列化
├── lib/cron.js           # 纯函数：cron 解析 + 下一次触发时间 + 人类可读描述
├── lib/store.js          # 运行日志环形缓冲 + Config 读写（revision CAS）
├── lib/runner.js         # 执行引擎：建 agent、驱动一轮、超时、dispose
├── lib/scheduler.js      # 定时器 + 派发 + 并发上限 + 重叠去重
├── lib/tools.js          # 模型工具 scheduled_task_*
├── lib/skill.js          # 编程式注册 scheduled-tasks skill
├── client.js             # 浏览器侧：懒工厂 + 两个 slot + 页面组件
├── skills/scheduled-tasks/SKILL.md   # skill 的人类可读备份
├── locale/{en,zh}.json   # 插件页标题与描述
├── icon.svg              # 面板图标（currentColor，24x24）
├── scripts/test-cron.mjs          # cron/model 纯函数测试（开发用，不随包安装）
├── scripts/test-store.mjs         # store 读写与 revision 冲突测试
├── scripts/verify-contract.mjs    # 装配形状自检（开发用，不随包安装）
├── scripts/verify-layout.mjs      # 布局与信息架构规则自检
├── scripts/verify-render.mjs      # 渲染与交互自检（自建迷你 React 运行时）
├── CONTRACT.md           # 接口冻结 v1（团队协作契约）
├── README.md             # 英文（默认）
└── README.zh.md          # 中文
```

## 安装

```text
plugin_manager install_bundle  target: file:E:\repos\dsh-plugins\dsh-plugin-scheduled-tasks
```

它会做两件事：把包加进 profile 的 `dependencies`，并把
`dsh-plugin-scheduled-tasks` 追加到 profile 的 `dsh.profile.bundles`。
补丁层只插入一行宿主条目：

```yaml
- insert:
    - id: scheduled-tasks
      name: 'dsh-plugin-scheduled-tasks'
```

浏览器侧不需要在补丁里声明：`dsh-client-modules` 扫描已启用 Loader 条目的
`package.json dsh.client`，再通过 `exports["./client"]` 取 bundle。

### 改动之后要重新安装

pnpm 对 `file:` 依赖是**拷贝**而不是软链，所以改了 `client.js` / `lib/*.js` 之后
必须让 profile 拿到新文件：

```text
plugin_manager remove_bundle   target: dsh-plugin-scheduled-tasks
plugin_manager install_bundle  target: file:E:\repos\dsh-plugins\dsh-plugin-scheduled-tasks
```

（直接重复 `install_bundle` 会返回 `changed: false` / `ambiguous-install`。）
重新安装后**刷新页面**，浏览器才会拿到新的 bundle。

### 卸载

```text
plugin_manager remove_bundle   target: dsh-plugin-scheduled-tasks
```

## 使用

1. 点侧边栏的「定时任务」图标进入管理页（同一页面也会在 `main` 区域以
   `scheduled-tasks` 这个 key 挂载）；
2. 「新建任务」填标题 + 提示词 + 时间表达；
3. 列表里可以看时间描述、下次运行时间、最近状态，并做启停 / 立即运行 / 删除；
4. 底部日志区显示最近若干次运行，可展开看摘要与错误。

### 5 种时间表达

| 形式 | 含义 | 例子 |
| --- | --- | --- |
| `every` | 每隔 N 分钟（30..43200） | 每 2 小时 → `{"kind":"every","everyMinutes":120}` |
| `daily` | 每天某个本地时刻 | 每天早上 9 点 → `{"kind":"daily","time":"09:00"}` |
| `weekly` | 每周某几天（1=周一 … 7=周日） | 一三五 18:30 → `{"kind":"weekly","time":"18:30","weekdays":[1,3,5]}` |
| `cron` | 五段 Vixie 子集 | 工作日 9–18 点每 15 分钟 → `{"kind":"cron","expression":"*/15 9-18 * * 1-5"}` |
| `once` | 一次性的 epoch 毫秒（必须在未来） | 明天 8 点 → `{"kind":"once","at":1767225600000}` |

`daily` / `weekly` / `cron` 一律按**宿主本地时区**求下一次触发时间。

cron 五段方言：`minute hour day-of-month month day-of-week`，每段支持 `*`、单值、
`a-b`、`*/n`、`a-b/n`、逗号列表，`dow` 里 `0` 和 `7` 都是周日；
**拒绝** `L` / `W` / `#` / 英文名 / `@daily` 宏 / 六段 / 越界 / 倒置区间 / 步长 0。

### 用对话创建

不用打开面板，直接在对话里说需求：

- 「每天早上 9 点帮我总结昨天的 git 提交」
- 「每 2 小时检查一次构建状态，挂了就把失败日志总结给我」
- 「每周一三五 18:30 汇总今天改过的文件」
- 「工作日 9 点到 18 点之间每 15 分钟跑一次 repo 健康检查」
- 「明天早上 8 点跑一次依赖更新检查，只跑这一次」

模型会先复述确认（「确认一下：每天 09:00 自动总结前一天的 git 提交，对吗？」），
用户确认后才调用 `scheduled_task_create`；时间或内容含糊时它应该先追问，不要猜。
时间表达**永远由模型翻译成结构化 `schedule`**，不需要用户写 cron。

## 功能：模型与推理强度、任务编辑

每个任务可以单独指定：

- **大模型**（供应商 + 模型），省略则跟随会话默认模型；
- **推理强度**，只列出**该模型自己声明**的等级（`reasoning.efforts`），
  并且第一项是「模型默认」（不写字段，让模型自己的默认强度生效）；
- **工作目录**（该次运行的 cwd）；
- **技能**、**工具白名单**、**启停**。

任务可以**编辑**：点任务行的「编辑」打开同一个表单，标题/提示词/时间/模型等
都能改，保存是**原位替换**（`id` 与 `createdAt` 不变），所以运行历史和该任务
接得上；`lastRunAt` / `nextRunAt` / `lastStatus` 这些运行态字段不由表单管理，
不会被整段回写冲掉。

模型目录从哪来：客户端拿不到 `llm.listModels`（它不是 `@Remote`），所以由宿主
算好后写进 `internal.catalog`，界面从它本来就要读的 `describe()` 一并取走——
不引入任何新的 Remote 依赖。

## 验证状态

### 自动化检查（全部 exit 0，本会话实际运行）

```powershell
node scripts/test-cron.mjs        # 全部通过：190 项断言
node scripts/test-store.mjs       # 全部通过：35 项断言（namespace=scheduled-tasks）
node scripts/verify-contract.mjs  # 全部通过：65 项装配形状断言
node scripts/verify-layout.mjs    # 全部通过：54 项布局与信息架构断言
node scripts/verify-render.mjs    # 全部通过：57 项渲染与交互断言
```

五者合计 **401 项断言**，覆盖：

| 面 | 覆盖内容 |
| --- | --- |
| `lib/cron.js` | cron 五段方言的接受面（`*`/单值/区间/步长/逗号列表、dow 0 与 7 同义）与**拒绝面**（`L`/`W`/`#`/英文名/`@` 宏/六段/越界/倒置区间/步长 0）；5 种 schedule 的边界与跨日/跨周；`0 0 30 2 *` 无解返回 `null` |
| `lib/model.js` | `newTaskId` 形状与唯一性（含 `random` 恒为 0 的健壮性）、`normalizeTask` 的接受/拒绝、`isTaskDue`、`advanceTask` 不改原对象且 `once` 正确停用 |
| `lib/store.js` | 深拷贝与**活引用**两种 `describe()` 语义下，`appendLog`/`updateLog`/`setRunState` 的内存与磁盘一致性、revision 冲突重试、`logLimit` 裁剪 |
| 装配形状 | manifest 与补丁合法；`client.js` 以包名注册工厂、`apply` **恰好**注册 `sidebar.panellist` 与 `main`（`id`/`key` 均为 `scheduled-tasks`）；`index.js` 不返回清理函数、同一 ctx 二次 `apply` 幂等、不同 ctx 各自装配；各文件无 `@deepseek-ai/*` 运行时 import |
| 布局结构 | CSS 类名与 JSX 引用的闭环（无死类、无无样式类）；行/标题类不得带 `flex:1`；行内布局用 grid 显式分列（日志行 `auto minmax(0,1fr) auto`、任务行 `minmax(0,1fr) auto`）；中文长文案不用 `break-all`；根容器不声明 `height:100%` 且不自建滚动 |

**`verify-layout.mjs` 为什么存在**：真机截图暴露的错位（日志行的徽标与时间戳被顶到最右、
卡片套卡片、分段选择器换行后圆角被切）**任何功能性断言都抓不到**——它们都"渲染成功"。
这个脚本把布局约定变成可断言的规则，并做过**负向对照**：把它改回旧写法
（日志行用 flex、标题类加 `flex:1`）会精确报出这 2 项失败。

### 真机端到端（本会话在运行中的 Host 上实测）

- **宿主侧激活**：`Config.listConfigs` 查到 `include:scheduled-tasks`（status `schema`）；
  五个 `scheduled_task_*` 工具与 `scheduled-tasks` skill 实际出现在会话的工具/技能目录里。
- **浏览器侧激活**：客户端 slot 实况显示 `sidebar.panellist` 有活跃占位
  `{ id: "scheduled-tasks", order: 20 }`，`main` 有活跃占位 `{ key: "scheduled-tasks" }`。
- **对话创建可用**：`scheduled_task_create` 真实创建成功并回读；
  任务定义落进 profile 的 `cordis.patch.yml`（`- id: scheduled-tasks` → `config.tasks`）。
- **真跑了一次大模型**：`scheduled_task_run` 让插件**新开了一个独立会话**
  （`C:\Users\Administrator\.dsh\sessions\_no-cwd\scheduled-task-<id>-<ts>\`），
  且该次运行的 `lastStatus` 回写为 `ok`。这正是本插件与内置 `dsh-schedule` 的本质差别。

### 这次真机验证抓到并修掉的三个真实缺陷

自动化断言**没能**发现它们，真机跑一次就暴露了——这也是为什么"装上去跑一次"不可省：

1. **一次从未启动的运行被记成 `ok`**：`agent.whenIdle()` 的语义是「当前活动区间结束」，
   而 `followup()` 之后驱动可能还没开工，此时它立刻返回。真机上表现为：会话里只有一行
   session 头、什么都没做，日志却写 `ok`。现在分两段判定（先等开工，再等空闲），
   未开工一律记 `error`，绝不谎报成功。
2. **周期任务可能静默永不触发**：`isTaskDue` 只看 `nextRunAt`，而它原先只在进程启动与
   运行结束时写入。界面新建或手工编辑写进来的任务在本次进程内会一直缺 `nextRunAt`。
   现在每个 tick 都会为「enabled 但没有 `nextRunAt`」的任务补一次排期（补出的时间点在
   未来，不在本轮触发）。
3. **`scheduled_task_run` 返回 `status: "unknown"`**：`lib/tools.js` 期望运行记录本身，
   而接线层当时返回了 `{ ok: true, record }` 包装。现在两侧统一为「返回记录本身」，
   工具层同时兼容包装形态。

### 未验证（需人工在真实页面确认）

- **视觉呈现**：面板图标配色/线宽、任务列表与表单排版、与宿主控件的一致性、
  浅色/深色主题下的对比度 —— 均未验证。本会话拿不到浏览器控制权，
  按官方验证规则**不做** mock 预览、截图或模拟 React 渲染来"证明"视觉效果。
- **点「立即运行」的实际时序**：客户端只把它写成 `internal.manualRuns` 的一条请求，
  由宿主在下一次 tick（≤ `tickMs`，默认 30 秒）消费。所以点了按钮后日志不会立刻更新，
  需要等一个 tick 并刷新 —— 这是设计取舍，但"点一下多久能看到结果"的体感未在页面上确认。
- **`once` 的跨时区换算**与用户本地时钟不一致时的表现。
- 手工把设置文档改坏（`tasks` 混入非对象、非法 cron）时页面的容错只做了过滤/拒绝，
  未真机走一遍。

### 重新加载已安装的插件代码

`pnpm` 对 `file:` 依赖是**拷贝**，且宿主进程会缓存已加载的模块。改了插件代码后：

```text
plugin_manager remove_bundle  target: dsh-plugin-scheduled-tasks
plugin_manager install_bundle target: file:E:\repos\dsh-plugins\dsh-plugin-scheduled-tasks
```

然后**重启 Host**（或重新启用该 Loader 条目）才会加载新的 JavaScript 生成；
只刷新页面只能拿到新的浏览器侧 bundle。本会话在改完 runner 后实测过：
磁盘上的文件已更新，但同一进程内 `scheduled_task_run` 仍在跑旧代码
（这在 Docker 式增量开发里正常，但排查时容易误判成"修了没用"）。

### 仓库工具脚本的运行前提

`scripts/*.mjs` 与 `lib/config.js` 需要 `@deepseek-ai/schemastery`，它由 dsh 安装提供、
不在本插件的依赖里。纯 Node 下要跑这些脚本，需要一个可解析的副本，例如在插件目录下建：

```text
node_modules/@deepseek-ai/schemastery  ->  dsh 安装中的同名包
node_modules/@deepseek-ai/cosmokit     ->  schemastery 的依赖
```

该目录只用于本地测试，已在 `package.json` 的 `files` 之外，不会进入发布内容。

## 已知限制

- **宿主必须在运行**：调度器跑在 DSH 宿主进程里，应用关掉就没有任何触发；
  重新打开后按当前时间重算下一次，不会补跑错过的触发。
- **单机本地时区**：`daily` / `weekly` / `cron` 都按宿主本地时区解释，
  多机/跨时区部署时同一表达式在不同机器上触发时刻不同。
- **cron 只有五段子集**：不支持秒级、`L`/`W`/`#`、英文名与 `@daily` 宏。
- **日志有上限**：默认只保留最近 200 条（`logLimit`），更早的记录被裁剪；
  运行中的记录为同 `seq` 原地替换，不会被重复计数。
- **并发有上限**：默认同一 tick 内最多 2 个任务（`maxConcurrentRuns`），
  正在运行的任务会被重叠触发跳过（`internal.runs` 去重）；单次运行超过
  `runTimeoutMs`（默认 30 分钟）按 `timeout` 记终态。
- **任务在插件设置里，不在会话里**：客户端不新增 Remote，页面只能通过
  `remote.settings` 读写，因此任务不能被会话级工具直接共享给别的插件。
- **`skill` 是提示，不是强制**：执行体只被要求去加载指定 skill，
  是否真的加载取决于那一轮模型的判断。
- 没有构建步骤：`client.js` 就是可直接加载的浏览器 bundle。
