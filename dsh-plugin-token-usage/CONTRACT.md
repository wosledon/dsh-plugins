# dsh-plugin-token-usage — 内部契约 v1

本文件冻结插件的**数据形状、不变式与通道选择**。任何一处改动都要同步更新本文件、
`lib/constants.js` 与 `scripts/verify-contract.mjs`——三者不一致时以真机行为为准，
并立即修正另两者。

---

## §1 数据源：提供方上报的用量

唯一数据源是会话日志里 `assistant/message` 事件的 `usage` 字段：

```ts
type TokenUsage = {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}
```

### 1.1 四桶口径（必须与官方一致）

归一为**四个**桶：

```ts
type TokenBuckets = {
  uncachedInputTokens: number   // ← usage.inputTokens
  outputTokens: number          // ← usage.outputTokens
  cacheReadTokens: number       // ← usage.cacheReadTokens ?? 0
  cacheWriteTokens: number      // ← usage.cacheWriteTokens ?? 0
}
```

- **不变式**：`BUCKET_KEYS` 的顺序与内容即上表。`totalOf()` 是四者之和。
- **刻意不含 `reasoningTokens`**：它通常是 `outputTokens` 的子集，单列一列既会与官方
  `tokenUsage` 投影的数字对不上，也容易让人误加成总量。
- **缺失字段记 0 而不是猜**：适配器不上报缓存时，语义是"未上报"，不是"没有缓存"。
  `countOf()` 对非有限值或负值返回 `null`（未上报），由 `bucketsOf()` 折算成 0；
  但 `inputTokens` 与 `outputTokens` **同时**不可用时，`bucketsOf()` 返回 `null`
  ——该事件不算一次计费尝试。

### 1.2 归因

`modelIdentityOf(message)` 只认 `message.source.kind === 'model'`。

- `system-prompt` 与 `tool` 消息同样带 `source`，但都不代表一次模型调用，**必须排除**。
- 认不出 provider 时归到 `unknown/unknown`，并让 `unattributed` 计数 +1。
  **不允许丢弃**——丢掉会让分项之和小于总量，界面上无法解释。
- provider 有而 model 缺 → `provider/unknown`。

### 1.3 计费次数

每条带 `usage` 的 `assistant/message` 记 **1 次尝试**。一次重试会留下第二条
`assistant/message`，因此天然计 2 次，与官方 token-meter 的口径一致
（"a retry in the same step contributes another billed attempt"）。

`assistant/attempt` 事件只有流记录、没有用量，**不计**。

---

## §2 会话投影：`tokenByModel`

### 2.1 为什么需要它

官方已有 `tokenUsage` 投影，但它只有整个会话的四桶合计，**没有按模型拆分**。
本插件需要拆分后的视图。

官方实践规则（`cordis-plugin-development/references/practices.md`）：

> When the Client needs a value derived from a session, declare `wire.view` on the
> Host projection. The value reaches the Client already computed; the Client does
> not fold session events itself.

所以按模型的折叠在**宿主**完成，客户端只 `useProjection('tokenByModel')`。

### 2.2 状态与视图

```ts
// 宿主状态（stateSchema）
type State = {
  byModel: Record<string, { provider: string; model: string; buckets: TokenBuckets; attempts: number }>
  attempts: number        // 计费尝试总数
  unattributed: number    // 归不到模型的尝试数
}

// 客户端可见值（wire.viewSchema）
type View = {
  rows: Array<{ key, provider, model, buckets, total, attempts }>   // 已按 total 降序
  totals: TokenBuckets
  total: number
  attempts: number
  unattributed: number
}
```

- **不变式**：`apply` 是纯的，且对与用量无关的事件**返回同一引用**——投影层靠引用
  相等抑制下游重算，所以绝不 clone 状态。
- **不变式**：`rows` 在主键上按 `total` 降序、同 `total` 时按 `key` 升序。排序在
  `rowsOf()` 里做，宿主与客户端**共用同一个顺序**，不各自再排一次。
- **不变式**：`PROJECTION_STATE_VERSION` 在字段或折叠语义变化时**必须**递增，
  否则旧检查点会被当成新数据。
- `key` 的形状恒为 `provider + '/' + model`。

---

## §3 跨会话汇总与持久化通道

### 3.1 为什么只能宿主扫描

跨会话总量不属于任何单个会话，装不进会话投影。而 `ctx.sessionQuery` 的方法
（`listSessions` / `readSession` …）**都不是 `@Remote`**，浏览器侧读不到别的会话日志。

### 3.2 通道选择（**易错点，务必按此实现**）

| 模式 | 条件 | 优先用 |
| --- | --- | --- |
| `editor` | `ctx.get('configEditor')` 有 `edit` + `configuration` | `configEditor` |
| `settings` | 退而求其次：`ctx.get('settings')` 有 `mutate` + `describe` | `settings` |
| `read-only` | 两者都不可用 | 只写内存，`isPersistent()` 为 false |

**不变式（按成功回退，不是按可用性二选一）**：`mode` 只表示"优先用谁"。
`persist()` 必须把**两条通道都列为候选**并逐个尝试，前一条抛错就继续试下一条，
**两条都失败**才返回 `false`（并给出合并后的失败原因）。

为什么这条是硬要求：`configEditor` 存在不等于它一定成功——条目可能还没被 patch 层
认领、Loader 正在重载、校验拒绝。如果写成 `if (mode === 'editor') { …; return false }`，
一旦编辑器通道失败就直接放弃，另一条明明可用的通道从不尝试，功能会**静默**变成
"刷新了但没有数据"。

**不变式**：`lastChannel()` 记录最近一次**实际成功**的通道（`'editor'` /
`'settings'` / `null`），诊断时不必猜"到底是谁写进去的"。

**为什么首选 `configEditor`**：`ctx.settings.mutate(ns, ops, revision)` 改的是
**profile patch 层里已有的条目**。本插件的行由 bundle 自己的 `cordis.patch.yml`
用 `insert` 提供，patch 层里没有 `token-usage` 条目，所以经由 `settings` 的写入
**不会落地**（实测：patch 文件自始至终没有出现该条目）。`configEditor` 改为按
**Loader 条目**寻址：

- `entries()` → "Active entries with unique profile patch ids"
- `configuration()` → 每项 `{ entry, inherited, override }`
- `edit(entry, change)` → `change` 返回**完整** raw config，由它校验并持久化

- **不变式**：`absorb()` 必须**同时**合并 `inherited` 与 `override`。只读 override
  会丢掉 bundle 与 profile 补丁提供的值。
- **不变式**：`findEntry()` 同时比对 patch id 与包名——只认 id 会在行 id 被改时失联，
  只认包名会在同名多行时选错。
- **不变式**：`takeRefreshRequest()` 先清空再返回。反过来会让"清理失败"变成
  "每轮重复扫描"，空转比重扫一次更糟。

### 3.3 汇总形状

```ts
type Summary = {
  rows: Array<{ key, provider, model, buckets, total, attempts }>
  scanned: number      // 实际扫描的会话数
  total: number        // 语料里的会话总数
  truncated: boolean   // total > scanned
  skipped: number      // 日志读取失败而被跳过的会话数
  builtAt: number
}
```

---

## §4 扫描的边界与诚实性

- **不变式**：按 `header.createdAt` **从新到旧**排序后再截断。截断时留下的必须是
  "最近的"，而不是"字典序靠前的"。
- **不变式**：`scanLimit` 默认 200，可在 `cordis.patch.yml` 配置。
- **不变式**：`truncated === (total > scanned)`。界面据此显示
  「只扫描了最近的 N / M 个会话，更早的未计入」——**不允许**悄悄少算。
- **不变式**：单个会话 `readSession` 抛错只 `skipped += 1` 并继续，不让一个坏日志
  毁掉整次扫描。
- **不变式**：读取历史日志是 O(会话数 × 事件数)，所以只在
  ①客户端写入刷新请求 或 ②从未扫描过（冷启动）时才扫，**不轮询**。
- **不变式**：扫描结果与失败原因都落盘（`internal.summary` / `internal.lastSweep`）。
  失败也要留痕，否则界面只会显示"没有数据"，用户无从区分"没用量"与"插件坏了"。

---

## §5 界面席位

| 席位 | 作用域 | 类型 | 数据来源 |
| --- | --- | --- | --- |
| `conversation.session.header.utilities` | session | list | `useProjection('tokenByModel')` |
| `sidebar.panellist` | root | list | —（图标） |
| `main` | root | keyed | `remote.settings.describe()` 读 `internal.summary` |

- **不变式**：三个席位都必须是 `replaceRisk: none`（或未声明），**绝不顶掉官方控件**。
- **不变式**：会话内指示器在**没有用量时不渲染任何东西**——头部空间有限，空角标
  只是噪音。
- **不变式**：会话内浮层必须渲染**四桶分解**（输入 / 输出 / 缓存读 / 缓存写），
  取自投影每行的 `buckets`，**不是**只显示 `total`。只显示总量只完成了"按模型汇总"
  的一半：能看出哪个模型花得多，看不出花在输入还是输出、缓存命中多少。这条属于
  "数据到了但没用上"，外观上完全看不出来，只能靠断言守
  （`verify-layout.mjs` 有 5 条断言盯着它，并做过负向对照）。
- **不变式**：`useProjection` 缺失时渲染一句降级说明，**不抛错**。席位组件抛错会让
  整个 slot 变空白（控制台：`slot entry crashed in '<slot>'`）。
- **不变式（Hook 顺序）**：组件内所有 hook 必须在**第一个 `return` 之前**且处于语句层。
  把 hook 放在 early return 之后会让两次渲染的 hook 数不同，React 抛 #310，
  整个 slot 变空白。（此坑在姊妹插件上真实发生过。）
- **不变式**：颜色只走 `--dsw-alias-*` 主题令牌；唯一允许的裸色是 `box-shadow` 里的
  `rgba(0,0,0,.16)`（阴影没有对应令牌）。

---

## §6 两份 `formatTokens` 必须一致

浏览器 bundle 只经 `__ModuleLoader__` 注册，工厂只拿到 `require`，**无法 import 宿主的
`lib/fold.js`**（它不在 boot graph 里）。所以 `formatTokens` / `formatExact` 在
`lib/fold.js` 与 `client.js` 里各有一份。

- **不变式**：两份实现必须**逐值一致**。这是**不得已的重复**，因此由
  `scripts/verify-contract.mjs` 把 `client.js` 的那份取出来实跑并与 `lib/fold.js`
  逐值比对（含边界：`0/999/1000/1234/999999/1000000/1234567/1e9` 与
  `-1/NaN/Infinity`）。
- 修改任一份后另一份必须同步，否则脚本 FAIL。

---

## §7 跨两侧的数据形状契约

数据流是：**宿主折叠 → 写进插件配置的 `internal.summary` → settings 服务投影给客户端 →
浏览器侧 `readSummary()` 取回**。

- **不变式**：宿主写出的 `internal.summary` 形状 = §3.3 的 `Summary`；浏览器侧
  `readSummary()` 必须能从 `settings.describe()` 的返回里取到它。
- **不变式**：`internal` 住在 **user 层**（`entry.user.internal`）。浏览器侧**两层都要看**
  （`user` 优先，回落 `value`）——只读其中一层会在某些 profile 下静默拿到空数据。
- **不变式**：两端对同一份 `rows` 必须得出**相同的顺序、相同的每行 `total`、相同的桶值**。
  宿主侧由 `rowsOf()` 排序，客户端侧由 `normaliseRows()` 归一；两处漂移在界面上只表现为
  "没有数据"，不会报错。
- **为什么这条要单独测**：中间任何一处嵌套层级、字段名或大小写不一致，界面都只是
  "没有数据"——这是最难查的一类契约漂移。`verify-contract.mjs` §11 用**宿主真实的 store**
  写一次（编辑器桩捕获它实际提交的完整 raw config），再把那份 config 按
  `settings.describe()` 的返回形状包起来交给**浏览器侧真实的** `readSummary` /
  `normaliseRows` 去读，逐值比对两端结果；并附一条负向对照：把 `summary` 放错层级时
  浏览器侧必须读不到。

---

## §8 验证状态

**已验证**

- `node scripts/test-fold.mjs` —— 65 项断言，零依赖。
- `node scripts/verify-layout.mjs` —— 58 项布局/主题/文案键/Hook 顺序/席位安全断言。
- `node scripts/verify-contract.mjs` —— 261 项装配形状断言，其中 §11 是**跨两侧的
  端到端契约**（见 §7）：用宿主真实的 store 写一次，交给浏览器侧真实的 `readSummary` /
  `normaliseRows` 读回，逐值比对，并附负向对照。
- 宿主 Config 报告 `status: "schema"`，即宿主模块加载成功，也即 `zod`（真机 4.6.5）
  与 `@deepseek-ai/schemastery` 在宿主进程内可解析，且 `lib/projection.js` 里所有
  `z.*` 调用在真实 zod 下合法。
- 客户端席位 `token-usage` 在 `conversation.session.header.utilities` 与
  `sidebar.panellist` 中均 `active: true`，与官方的 `open-in-app`、
  `session-log-download`、`plugins` 并列。

**未验证**

- **视觉呈现**：配色、间距、浅色/深色主题下的对比度，需要真实页面确认。
- **投影 `wire.view` 的输出没有在离线环境用 zod 校验过**：`zod` 只存在于 DSH 安装包
  （`app.asar`）内，纯 Node 解析不到。风险由两点约束：schema 构造在真机合法（已证），
  且视图数据按构造全为整数（由 `test-fold.mjs` 覆盖）。
- **会话内指示器的真机读数与浮层交互**：需要浏览器控制。
- **`configEditor` 持久化路径的真机落盘**：需要重启宿主才能载入新的模块代次
  （Node 的 ESM 缓存按解析路径命中，`remove_bundle` + `install_bundle` 换不掉已导入
  的模块）。**在重启前，`internal.summary` / `internal.lastSweep` 是否出现在 profile
  patch 中属于未验证。** 失败时 `lastSweep.detail` 会带上两条通道各自的报错。
