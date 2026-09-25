# 接口冻结（Interface Freeze）— dsh-plugin-scheduled-tasks

本文件是**唯一共享契约**。所有模块必须严格按此处定义的数据形状与职责边界实现；
如需变更，先改本文件并在团队消息里说明，再改代码。

状态：**FROZEN v1**（Lead 维护，teammate 只读）

---

## 0. 目标

一个 DSH 插件：**定时按提示词触发大模型执行任务**。

- 有菜单（侧边栏面板入口 + 主区域页面）
- 有日志（每次运行的记录）
- 定时触发大模型（cron / 间隔 / 一次性）
- 任务可携带 skill 与工具
- 可以用对话创建任务（模型工具 + 注册 skill）

### 关键事实（已核实，不可推翻）

| 事实 | 结论 |
| --- | --- |
| 内置 `@deepseek-ai/dsh-schedule` 只把提醒文本投递进会话，**不触发模型执行** | 本插件必须自己跑模型 |
| 客户端 `ctx.remote` 的 namespace 是**编译期固定白名单**，第三方纯 JS 插件无法新增 Remote | 客户端只能复用既有 namespace |
| 既有可复用读写通道：`remote.settings`（`describe`/`mutate`） | 任务定义走这里 |
| `main` 是 keyed slot，key 由 `sidebar.panellist` 的 `id` 决定；`main` 为 root scope、**不绑定 session** | 页面不能依赖 session props |
| 跨进程日志：`remote.workspaceFiles` 需要 `sessionId`，root-scope 页面拿不到 | 日志改由 Config 承载（见下） |
| 宿主执行大模型：`ctx.agentLoop.createAgent(ctx, {sessionId, agentOptions, meta})` 返回 `{agent, dispose}`；`agent.followup(input)` 唤醒一轮 | 每次运行开新会话 |
| 等待完成：等 `turn/end` 这类**耐久事件**，不要轮询 `agent/status` | 见 `references/practices.md` |
| 注册 skill：`ctx.skills.register({name, description, content, source, invocation})` | 宿主侧编程式注册，无需文件目录 |
| 工具：`ctx.tools.register(defineTool({...}))` | 对话创建任务的入口 |

---

## 1. 包布局与写入范围（write scope，严格不重叠）

```
dsh-plugin-scheduled-tasks/
├── package.json                 # Lead
├── cordis.patch.yml             # Lead
├── icon.svg                     # Lead（占位，可后补）
├── locale/en.json               # teammate: docs
├── locale/zh.json               # teammate: docs
├── index.js                     # Lead  ← 宿主入口（薄：Config、apply、装配）
├── lib/constants.js             # Lead  ← 无依赖常量（纯逻辑模块只依赖它，保证可离线单测）
├── lib/config.js                # Lead  ← Config schema + 归一化（唯一依赖 schemastery 的文件）
├── lib/model.js                 # Lead  ← 纯数据：任务读写、校验、序列化
├── lib/cron.js                  # Lead  ← 纯函数：cron 解析 + 下一次触发时间
├── lib/store.js                 # Lead  ← 运行日志环形缓冲 + 读写 Config
├── lib/runner.js                # Lead  ← 执行引擎（创建 agent 并驱动一轮）
├── lib/scheduler.js             # Lead  ← 定时器 + 派发 + 并发/去重
├── lib/tools.js                 # teammate: agents ← 模型工具注册
├── lib/skill.js                 # teammate: agents ← 对话创建任务的 skill 注册
├── client.js                    # teammate: client ← 浏览器侧
├── skills/scheduled-tasks/SKILL.md  # teammate: docs ← 人类可读 skill 备份
├── README.md                    # teammate: docs
└── scripts/verify-contract.mjs  # teammate: verify ← 装配形状自检
    scripts/test-cron.mjs        # teammate: verify ← cron/模型纯函数测试
```

> 本插件**不新增** `lib/remote-*`、不改 profile 的 `package.json`/`cordis.patch.yml`
> （由 `plugin_manager install_bundle` 负责）。

---

## 2. 数据模型（Config）

Config 是这个插件**唯一的持久化状态**。客户端通过 `remote.settings.describe()`
读取、通过 `remote.settings.mutate(ns, ops, revision)` 写入。

```jsonc
{
  "enabled": true,
  "tickMs": 30000,
  "maxConcurrentRuns": 2,
  "runTimeoutMs": 1800000,
  "logLimit": 200,
  "workspaceRoot": null,
  "tasks": [ /* ScheduleTask[] */ ],
  "internal": { "log": [ /* LogRecord[] */ ], "runs": { /* RunState */ } }
}
```

### 2.1 ScheduleTask

```ts
interface ScheduleTask {
  id: string                 // 稳定，`t<base36 时间戳><8 位 base36 随机>`，创建后不变
  title: string              // 1..120，去掉首尾空白后非空
  prompt: string             // 1..20000，发给大模型的提示词（去掉首尾空白后非空）
  enabled: boolean           // 关闭时调度器跳过
  schedule: Schedule
  skill?: string             // 可选 skill 名，作为提示词前缀提示（kebab-case）
  tools?: string[]           // 可选：限制该次运行可用的工具（白名单）
  workspaceRoot?: string     // 可选：该次运行的 cwd
  model?: {                  // 可选：覆盖该次运行使用的模型；整段省略 = 跟随会话默认模型
    provider: string
    model: string
    reasoningEffort?: string // 必须是该模型自己声明的 effort id；省略 = 用模型默认强度
  }
  createdAt: number          // epoch ms
  updatedAt: number          // epoch ms
  lastRunAt?: number         // epoch ms
  nextRunAt?: number         // 由宿主计算并回写，便于界面展示
  lastStatus?: 'ok' | 'error' | 'timeout' | 'skipped'
}
```

### 2.2 Schedule（判别式联合，`kind` 为判别键）

```ts
type Schedule =
  | { kind: 'every';   everyMinutes: number }                      // 30..43200
  | { kind: 'daily';   time: 'HH:mm' }                             // 本地时区
  | { kind: 'weekly';  time: 'HH:mm'; weekdays: number[] }          // 1..7（周一=1），升序去重
  | { kind: 'cron';    expression: string }                        // 五段 Vixie
  | { kind: 'once';    at: number }                                // epoch ms，必须未来
```

- `daily`/`weekly`/`cron` 一律按**宿主本地时区**求下一次触发时间。
- `time` 严格要求两位小时 + 两位分钟（`09:00`）；`9:00` 视为非法。
- 边界语义：`nextScheduleTime(schedule, from)` 返回**严格大于** `from` 的第一个时刻。
  若当前时刻正好等于目标时刻，返回的是下一次（与宿主内置 schedule 一致）。
  过期的任务由 `isTaskDue` 判定，而不是靠 `nextScheduleTime`。
- `cron` 只接受五段：`minute hour day-of-month month day-of-week`；
  每段支持 `*`、单值、`a-b`、星号步长（`*` 后接 `/n`）、区间步长、逗号列表；
  `dow` 中 `0` 和 `7` 都是周日。
  **拒绝** `L`/`W`/`#`/月份或星期英文名/`@daily` 宏/六段/越界/倒置区间/步长 0。
- `once` 触发一次后自动置 `enabled: false` 并**删除 `nextRunAt`**。

### 2.2.1 Config 可见性（关键，勿改）

`tasks` 与 `internal` 在 `Config` schema 里**必须声明为 `.volatile()`**：
`@deepseek-ai/dsh-settings` 的 `describe()` 只投影 volatile 节点，且没有任何
volatile 字段的条目会让 `mutate()` 直接抛错。由于第三方插件无法新增 Remote
namespace，`remote.settings` 是浏览器侧唯一的读写通道，所以这两个节点必须可读写。

副作用：schemastery 解析后 volatile 字段的值是**访问器对象**（带 `get()`），
不是数据本身。`lib/config.js` 的 `plainConfig()` / `resolveConfig()` 负责解包；
任何拿到 `Schema(...)` 解析产物的代码都必须先过 `resolveConfig` 才能当数据用。

### 2.3 LogRecord（环形缓冲，宿主只写，客户端只读）

```ts
interface LogRecord {
  seq: number                  // 自增，用于稳定排序
  taskId: string
  title: string                // 冗余保存，任务删除后日志仍可读
  startedAt: number            // epoch ms
  endedAt: number              // epoch ms
  status: 'ok' | 'error' | 'timeout' | 'skipped' | 'running'
  trigger: 'schedule' | 'manual'
  sessionId?: string           // 该次运行的会话 id，界面可跳转
  summary: string              // 结果摘要，单条上限 4000 字符
  error?: string               // 失败原因，上限 1000 字符
  toolCalls?: number           // 该次运行的工具调用次数（拿不到则省略）
}
```

- 追加后裁剪到 `logLimit`（最新的保留）。
- 运行开始时写一条 `status: 'running'`，结束时**原地替换**该条为终态（同 `seq`）。

### 2.4 RunState（运行中去重，`internal.runs`）

```ts
// key = taskId
type RunState = {
  seq: number
  startedAt: number
  trigger: 'schedule' | 'manual'
}
```

存在即表示该任务正在运行；调度器据此跳过重叠触发。

### 2.5 手动运行队列（`internal.manualRuns`）

```ts
type ManualRunRequest = { taskId: string; requestedAt: number }
```

浏览器侧**不能创建 Agent**，所以界面上的「立即运行」只能把意图写成数据：
客户端往 `internal.manualRuns` 追加一条请求，宿主调度器在**下一次 tick**
（≤ `tickMs`）消费它、执行任务并清空队列。超过 5 分钟的请求会被丢弃
（多半来自已经结束的界面会话）。

写入分工是这一层的关键：客户端只写 `tasks` 与 `internal.manualRuns`，
宿主只写 `internal.log` 与 `internal.runs`，互不覆盖。

### 2.6 模型与推理强度

`model` 是**可选的整段覆盖**：省略 = 跟随会话默认模型。
`provider` 与 `model` **必须成对出现**；只给一个会被拒绝——否则 `{provider:'p'}`
被丢掉，任务就从"指定模型"悄悄变成"默认模型"，而用户以为自己配过。
`reasoningEffort` 必须来自**该模型自己声明**的 `reasoning.efforts`（宿主从
`llm.resolveModelInfo()` 拿到）；省略 = 用模型默认强度，空白串同样按省略处理。

因为 `llm.listModels` / `resolveModelInfo` 不是 `@Remote`（客户端拿不到），
模型目录由宿主算好后写进 `internal.catalog`，界面从它本来就要读的 `describe()`
一并取走（见 `lib/catalog.js`）。

### 2.7 任务的编辑语义

界面「编辑」与「新建」**共用同一个表单**，保存时是**原位替换**：
`id` 与 `createdAt` 沿用原值，只改表单管理的字段。
`lastRunAt` / `nextRunAt` / `lastStatus` 等运行态字段**不被表单管理**——
否则整段回写会把宿主的运行记录冲掉。

### 2.8 一次运行的「真正完成」判定

`agent.followup()` 之后**不能只等 `agent.whenIdle()`**：它的语义是「当前活动区间
结束」，而驱动可能还没开工，此时它会立刻返回。实测（真机 E2E）这个竞态会把一次
**从未启动**的运行记成 `ok`（会话里只有一行 session 头）。

runner 的正确判定顺序：
1. 记下投递前的会话事件数；
2. 等驱动开工（会话事件数增长，或 `agent.status === 'running'`）；
   超过宽限期（3s）仍未开工 → 记为 `error`，**绝不谎报 ok**；
3. 再等 `whenIdle()` 返回 → `ok`；超过 `runTimeoutMs` → `timeout` 并取消。

另外，任何 `enabled` 却没有 `nextRunAt` 的周期任务，会在每个 tick 被自动补一次
排期（补出的时间点在未来，因此不在本次触发）。否则一份由界面或手工编辑写进来的
任务定义会在本次进程内永远缺 `nextRunAt`，从而静默永不触发。

---

## 3. 模块 API（宿主内部，互相调用）

### `lib/config.js`

```js
export const CONFIG_NS       // 本插件 Loader 行 id，客户端 mutate 用的 ns
export const LOG_LIMIT_DEFAULT
export const Config          // schemastery schema（z.object(...)）
```

### `lib/cron.js`（纯函数，必须无副作用、可单测）

```js
export function parseCron(expression)
  // -> { minute, hour, dom, month, dow, domStar, dowStar, expression }
  //    各字段是已展开的升序数字数组；domStar/dowStar 保留「是否以 * 开头」
  //    的信息（day-match 规则需要）。非法输入抛 Error，消息须指明出错字段。
export function nextCronTime(parsed, fromMs)  // -> number | null（超过 5 年无解返回 null）
export function nextScheduleTime(schedule, fromMs)
  // -> number | null；一律返回**严格大于** fromMs 的第一个时刻
  // every:  fromMs + everyMinutes*60000
  // daily:  下一个 > fromMs 的本地 HH:mm（正好等于则次日）
  // weekly: 下一个 > fromMs 且本地星期在 weekdays 中的本地 HH:mm
  // cron:   nextCronTime
  // once:   仅当 at > fromMs 返回 at，否则 null
export function describeSchedule(schedule)  // -> 人类可读中文串（界面与日志共用）
export function validateSchedule(schedule)  // -> null | string（错误信息）
```

### `lib/model.js`（纯函数）

```js
export function newTaskId(nowMs, random)             // 纯，random 注入便于测试
                                                     // 形状：t + base36(nowMs) + 8 位 base36 随机
export function normalizeTask(input, nowMs, options)  // -> { task } | { error: string }
                                                     // options: { id?, random? }
export function validateTask(task)                   // -> null | string
export function normalizeSchedule(schedule)          // -> 规范形状 | null
export function isTaskDue(task, nowMs)               // -> boolean
export function advanceTask(task, outcome)           // -> 新 task（不改原对象）
                                                     //   outcome = { nowMs: number, status: string }
                                                     //   写 lastRunAt / updatedAt / lastStatus；
                                                     //   重算 nextRunAt；once 任务置 enabled=false 并删除 nextRunAt
export function ensureNextRun(task, nowMs)           // -> 新 task（已有未来 nextRunAt 则原样返回）
export function findTask(tasks, id)                  // -> task | undefined
```

**签名是冻结的**：`advanceTask` 的第二个参数是 `{ nowMs, status }` 对象，
不是裸的毫秒数。超长字段一律**拒绝**（返回 error）而不是静默截断。

### `lib/store.js`

```js
export function createStore(ctx, rawConfig) // 返回 store
// store.getConfig()           -> 浅拷贝的 Config 快照
// store.getTasks()            -> ScheduleTask[]（内部数组引用；调用方只读，改前先复制）
// store.getLog()              -> LogRecord[]
// store.getRuns()             -> Record<taskId, RunState>
// store.isPersistent()        -> boolean（settings 可用且写入成功过）
// store.refresh()             -> Promise<boolean> 重读设置文档并刷新快照与 revision
// store.setTasks(tasks)       -> Promise<boolean> 写回 config.tasks
// store.appendLog(record)     -> Promise<LogRecord>（补 seq 并裁剪到 logLimit）
// store.updateLog(seq, patch) -> Promise<LogRecord|undefined> 原地更新一条日志
// store.setRunState(taskId, state | null) -> Promise<void> 写回 config.internal.runs
```

写回实现要点：读取 `ctx.settings.describe()` 找到本插件条目拿 `revision`，
再 `ctx.settings.mutate(CONFIG_NS, [{op:'set', path:[...], value}], revision)`；
冲突（revision 不匹配）时重新 describe 后重试一次（共两次尝试）。
`ctx.settings` 缺失时降级为**内存态**并在日志里警告，绝不抛异常拖垮插件。

### `index.js`（宿主入口生命周期）

```js
export const inject = ['settings', 'tools'];   // 硬依赖仅这两项
export function apply(ctx, rawConfig): void    // 无返回值
```

**`apply()` 不返回清理函数**：所有资源（定时器、工具、skill、提示词段落）
都在 `apply` 内部用 `ctx.effect(...)` 注册，由 Cordis 在插件卸载时按序收尾——
这正是 `references/host-plugin.md` 的约定。资源不通过返回值交给 Loader。

`apply` 用一个 `WeakSet` 按 **ctx 身份**做幂等守卫：同一个 ctx 上二次 `apply`
直接 no-op 并告警，避免同一任务被两个调度器各跑一次。不同 ctx 各自独立装配
（测试里被 stub 掉的 `ctx.setInterval` 与真 `globalThis.setInterval` 都要算数）。

### `lib/runner.js`

```js
export function createRunner(ctx, store, options)
// runner.run(task, trigger) -> Promise<LogRecord 终态>
//   1. 生成 sessionId：`scheduled-task-<taskId>-<epochMs>`
//   2. ctx.agentLoop.createAgent(ctx, { sessionId, agentOptions, meta })
//      agentOptions: task.model 覆盖 provider/model；否则省略走默认模型
//      meta: { cwd: task.workspaceRoot ?? options.workspaceRoot ?? undefined }
//   3. 组合提示词（见 §4）
//   4. await 该 agent 的 `turn/end`（用 agent.ctx.on）+ runTimeoutMs 超时
//   5. 收集最后一条 assistant 文本作为 summary
//   6. 结束时必须 dispose()，且在超时/异常路径也 dispose
// 依赖缺失（agentLoop/agents）时返回 status:'error' 的终态记录，不抛。
```

### `lib/scheduler.js`

```js
export function createScheduler(ctx, store, runner, options)
// scheduler.start()  -> () => void 清理函数（必须能被 ctx.effect 收尾）
// scheduler.tick()   -> Promise<void> 手动触发一次检查（供工具/测试调用）
// scheduler.runNow(taskId, trigger) -> Promise<LogRecord>（手动立即执行）
// 规则：
//   - 每 tickMs 检查一次；enabled=false 或正在运行的任务跳过
//   - 同一 tick 内到期的任务并发执行，但总数不超过 maxConcurrentRuns
//   - 每次运行结束回写 lastRunAt/lastStatus/nextRunAt；once 任务置 enabled=false
//   - tick 内任何单个任务失败都不得中断其它任务
```

### `lib/tools.js`（teammate: agents）

注册到 `ctx.tools`，命名前缀 `scheduled_task_`：

| 工具名 | 作用 | 关键参数 |
| --- | --- | --- |
| `scheduled_task_create` | 用对话创建任务 | `title`, `prompt`, `schedule`（判别式对象）, 可选 `skill`/`enabled` |
| `scheduled_task_list` | 列出任务 | 无 |
| `scheduled_task_update` | 改标题/提示词/时间/启停 | `id` + 可选字段 |
| `scheduled_task_delete` | 删除 | `id` |
| `scheduled_task_run` | 立即跑一次 | `id` |

- 返回 JSON 文本；失败返回 `{ ok:false, code, message }` 而不是抛异常。
- 依赖通过 `inject` 或参数传入，不要直接 import 宿主包。

### `lib/skill.js`（teammate: agents）

`ctx.skills.register({ name:'scheduled-tasks', description, content, source:'runtime', invocation:{modelInvocable:true,userInvocable:true} })`。

`content` 必须教会模型：**怎么把一句自然语言需求变成 `scheduled_task_create` 调用**，
含 5 种 schedule 形状的示例、cron 方言限制、以及"先确认再创建"的行为约定。
`ctx.skills` 缺失时静默跳过。

---

## 4. 提示词组合（runner 内，唯一实现）

```
你是由「定时任务」插件自动唤醒的执行体，本次运行无人实时对话。
任务标题：<title>
任务指令：
<prompt>
<若 task.skill 有值>
请先调用 skill 工具加载「<task.skill>」技能，并按它的说明执行。
</若>
要求：直接开始执行，不要询问确认；完成后用一段话总结你做了什么、结果如何。
```

---

## 5. 客户端契约（`client.js`）

- 以包名注册懒工厂：`window.__ModuleLoader__.load({ id: 'dsh-plugin-scheduled-tasks', factory })`。
- `factory(require)` 只 `require('react')`；**不得** import 任何 `@deepseek-ai/*`。
- `inject = ['slots', 'locale', 'remote', 'remote.settings']`。
- 注册两个 slot（同一 id 字符串，固化常量 `PANEL_ID = 'scheduled-tasks'`）：
  - `sidebar.panellist`：`{ id: PANEL_ID, order: 20, label: () => t('panelLabel') }`，渲染图标组件（`{size, active}` props）。
  - `main`：`{ key: PANEL_ID }`，渲染整个任务管理页。
- 只通过 `ctx.remote.settings.describe()` / `ctx.remote.settings.mutate()` 读写。
- 全部文案走 `ctx.locale.register(NS, {zh, en})` + `ctx.locale.bind(NS)`。
- 样式只用 `--dsw-alias-*` token；类名统一前缀 `stp-`；样式在 `apply` 内用 `ctx.effect` 插入。
- 组件内部**不得**调用未在 `inject` 声明的服务；`remote` 缺失时渲染降级提示而不是抛异常。
- 页面功能：任务列表（标题/时间描述/下次运行/状态/启停/删除）、新建表单
  （标题、提示词、schedule 判别式选择器）、立即运行、日志区（最近 N 条，可展开）。
- 写入必须是"读取当前 revision → mutate"；冲突时重读并提示用户重试。
- 界面上必须显式提供**对话创建任务**的说明（提示用户直接在对话里说需求，
  例如「每天早上 9 点帮我总结昨天的 git 提交」）。

---

## 6. 验证契约

每个 teammate 交付前必须自己跑通：

```powershell
node --check <你改的每个 .js>
node scripts/test-cron.mjs
node scripts/verify-contract.mjs
```

`scripts/verify-contract.mjs` 至少断言：
1. manifest 合法（`dsh.bundle.patch`、`dsh.client.platform === 'web'`、`exports['./client']`）；
2. `client.js` 以包名为 id 注册工厂，`apply` 只注册 `sidebar.panellist` 与 `main` 两个 slot；
3. `apply()` 幂等且返回清理函数；重复 apply 不重复注册定时器；
4. 宿主 `index.js` 导出 `apply` / `inject`；
5. 纯函数：`nextScheduleTime` 对 5 种 schedule 的边界（含跨日、跨周、cron 步长）。

**禁止**：写 mock HTML 预览、装栅格化工具、模拟 React 渲染来"证明"视觉效果。
视觉效果只能靠真实页面；拿不到浏览器控制权时如实声明未验证。
