[English](README.md) | 中文

# dsh-plugins

**DeepSeek Harness**（DSH）的第三方插件集合。DSH 的插件以 *bundle* 形式声明，
由基于 Cordis 的 Loader 装载。

这里的每个插件都是自包含的包，可以用 `plugin_manager` 装进任意 DSH profile。
它们**都不需要构建步骤**：浏览器半是 DSH 模块装载器要求的纯 JavaScript bundle，
宿主半是普通的 ESM。

## 插件

| 插件 | 作用 | 宿主半 | 浏览器半 |
| --- | --- | --- | --- |
| [`dsh-plugin-reasoning-effort`](dsh-plugin-reasoning-effort/README.zh.md) | 在「设置 → 模型」里为手工声明的供应商按**每个模型**编辑推理强度 | 空（不注册任何东西） | 有 |
| [`dsh-plugin-scheduled-tasks`](dsh-plugin-scheduled-tasks/README.zh.md) | 按时间表（cron / 间隔 / 每日 / 每周 / 一次性）唤醒大模型执行提示词任务，带管理面板、按任务的运行记录与对话创建 | 有（调度器、执行引擎、工具、skill） | 有 |
| [`dsh-plugin-token-usage`](dsh-plugin-token-usage/README.zh.md) | 按模型展示提供方上报的 token 用量：会话内实时指示器 + 跨会话汇总表 | 有（会话投影 + 有界日志扫描） | 有 |

### dsh-plugin-reasoning-effort

DSH 的模型选择器只提供「适配器已公布」的推理等级。对于自定义（手工声明的）路由，
适配器拿不到任何推理元数据，于是连 Effort 一行都不会出现；而
`dsh-client-ui-settings-models` 是**故意**不做供应商级强度控件的 —— 强度是
**每个模型**的能力。

本插件补上这块界面：向官方预留的席位 `settings.models.provider-card` 投递一张卡片，
只读走 `remote.settings.describe()`，写入走 `remote.settings.mutate()`。
不新增任何 Host 服务、事件或工具。

### dsh-plugin-scheduled-tasks

到点后插件会**新开一个会话**，让大模型按提示词执行任务。每个任务可以单独指定
大模型、推理强度、工作目录、技能与工具白名单，每次运行都有记录。

- **菜单**：侧边栏面板入口 + 主区域页面，页内两个 tab ——「任务」与「运行日志」，
  各自分页。
- **运行记录**：按任务归组，所以页面长度只跟**任务数量**走，不跟运行次数走。
- **对话创建**：五个面向模型的工具
  （`scheduled_task_create` / `list` / `update` / `delete` / `run`）加一个
  `scheduled-tasks` skill —— 一句「每天早上 9 点帮我总结昨天的 git 提交」
  就能变成真实任务。

它和内置的 `@deepseek-ai/dsh-schedule` **不是一回事**：那个只把提醒文本投递进已有
会话，从不触发模型。

### dsh-plugin-token-usage

展示提供方适配器**真实上报**的 token 用量，按 `(provider, model)` 归并 ——
**不做估算，也不算费用**。四个桶与官方 `tokenUsage` 投影一致
（`uncachedInputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`）；
刻意不含 `reasoningTokens`，因为它通常是 `outputTokens` 的子集。

拿到这些数据要走两条不同的路，因为两个视图问的是不同的问题：

- **单个会话内、按模型**是会话派生的值，而官方要求客户端不得自己折叠会话事件。
  所以宿主注册一个名为 `tokenByModel` 的会话投影并带 `wire.view`，浏览器半只读
  `useProjection('tokenByModel')`。它渲染为 `conversation.session.header.utilities`
  里的一个席位 —— 一个总量 + 按模型的浮层 —— 会话没有用量时不渲染任何东西。
- **跨会话**不属于任何单个会话，装不进投影；而 `ctx.sessionQuery` 的方法都不是
  `@Remote`，浏览器根本读不到别的会话日志。因此由**宿主扫描**：从新到旧、受
  `scanLimit` 限制（默认 200）、按模型折叠后持久化；独立页面（侧边栏面板 + 主页）
  读回结果。

它对自己的边界是诚实的：扫描被截断时会写明「只扫描了最近的 *N* / *M* 个会话」，
读不出的日志会计数而不是悄悄丢掉，归不到模型的调用会进一个显式的
`unknown/unknown`「未归属」行，让总量仍然对得上。

## 安装

把 `plugin_manager` 指向插件目录即可：

```text
plugin_manager install_bundle   target: file:<插件目录的绝对路径>
```

例如：

```text
plugin_manager install_bundle   target: file:E:\repos\dsh-plugins\dsh-plugin-scheduled-tasks
```

更新已安装的插件要**先移除**：pnpm 对 `file:` 依赖是拷贝而不是软链，直接重复
`install_bundle` 会返回 `ambiguous-install`。

```text
plugin_manager remove_bundle    target: dsh-plugin-scheduled-tasks
plugin_manager install_bundle   target: file:E:\repos\dsh-plugins\dsh-plugin-scheduled-tasks
```

### 两个会让人意外的点

**1. 可能需要重启宿主。** 刷新页面只换**浏览器半**。**宿主半**跑在 DSH 进程里，
而 Node 的 ESM 模块缓存按解析后的路径命中 —— 换掉磁盘上的文件并不会换掉已经
导入的模块。如果宿主侧的改动（某个工具、调度器、新的配置字段）没生效，请重启。

**2. 自检脚本需要一个垫片。** `scripts/*.mjs` 本身零依赖，但任何间接 import
插件 `lib/config.js` 的脚本都会连带 import `@deepseek-ai/schemastery` —— 它随
**DSH 安装**提供，不是这些包的依赖。要在纯 Node 下跑这些脚本，需要让它可解析，
例如把 DSH 安装里的副本链接过来：

```text
<插件>/node_modules/@deepseek-ai/schemastery
<插件>/node_modules/@deepseek-ai/cosmokit
```

该目录只是本地测试辅助，已被 gitignore。`dsh-plugin-reasoning-effort` 的自检
没有这个依赖，随处可跑。

## 验证

这些插件由随包自带的自检脚本验证，零第三方依赖 —— clone 下来即可复现每一个记录在案
的结果。

```text
dsh-plugin-reasoning-effort
  node scripts/verify-contract.mjs      49 项断言

dsh-plugin-scheduled-tasks
  node scripts/test-cron.mjs           190 项断言
  node scripts/test-store.mjs           35 项断言
  node scripts/verify-contract.mjs      65 项断言
  node scripts/verify-layout.mjs        54 项断言
  node scripts/verify-render.mjs        57 项断言

dsh-plugin-token-usage
  node scripts/test-fold.mjs            65 项断言
  node scripts/verify-layout.mjs        63 项断言
  node scripts/verify-contract.mjs     261 项断言
```

这些套件刻意覆盖普通功能测试抓不到的东西：

- **`verify-layout.mjs`** 把布局约定变成可断言规则 —— 行内用显式 grid 列而不是
  `flex: 1`、中文长文案绝不 `word-break: break-all`、根容器不声明 `height: 100%`。
  这些描述的都是**渲染成功**却错位的真实问题，任何功能测试都抓不到。
- **`verify-render.mjs`** 自己实现了一个极小 React 运行时（真实状态、真实重渲染），
  并驱动页面走完「新建 → 切 tab → 展开记录 → 打开表单 → 切换时间类型」。
  它存在的理由：「页面空白」是**渲染期**崩溃 —— `apply()` 不抛错，是 slot entry
  死了。它还断言 **Hook 顺序** —— 把 effect 写在 early `return` 之后会让两次渲染的
  hook 数不同，直接把整个 slot 变空白。
- 多条检查带**负向对照**：把修复回退掉，该断言必须失败。一条永远不可能失败的断言
  什么也证明不了。

**没有**验证、也无法在终端验证的：视觉结果 —— 配色、间距、浅色/深色主题下的对比度。
这些需要真实页面。

## 目录结构

```
.
├── dsh-plugin-reasoning-effort/
│   ├── index.js                 宿主半（有意留空）
│   ├── client.js                浏览器半
│   ├── cordis.patch.yml         bundle 补丁：插入一行宿主条目
│   ├── package.json             dsh.bundle.patch + dsh.client 声明
│   ├── locale/{en,zh}.json
│   └── scripts/verify-contract.mjs
└── dsh-plugin-scheduled-tasks/
    ├── index.js                 宿主半入口
    ├── lib/                     调度器、执行引擎、cron、store、工具、skill…
    ├── client.js                浏览器半：面板 + 双 tab 页面
    ├── CONTRACT.md              冻结的内部契约（数据形状、不变式）
    ├── cordis.patch.yml
    ├── package.json
    ├── locale/{en,zh}.json
    ├── skills/scheduled-tasks/SKILL.md
    └── scripts/                 上面列出的那些自检脚本
└── dsh-plugin-token-usage/
    ├── index.js                 宿主半：tokenByModel 投影 + 有界的跨会话扫描
    ├── lib/                     fold（纯函数）、projection、summary、store、config、constants
    ├── client.js                浏览器半：会话内指示器 + 跨会话页面
    ├── CONTRACT.md              冻结的内部契约（数据形状、不变式）
    ├── cordis.patch.yml
    ├── package.json
    ├── locale/{en,zh}.json
    └── scripts/                 上面列出的那些自检脚本
```

`_scratch/` 是开发期目录，已被 gitignore；原因写在 `.gitignore` 里。

## 兼容性

三个插件都是在 DSH **0.1.7-rc.2** 上开发与验证的。它们使用的是有文档的插件接口
（`settings` 与 `configEditor` 服务、会话投影、slots、`agentLoop`、`tools`、`skills`），
但 DSH 仍是预发布版本：内部接口可能在版本之间变化。每一处跨服务调用都写成了
防御式的 —— 可选服务缺失时只降级该功能，而不是让整个插件加载失败 —— 但上游的
行为变化仍可能让某个功能**静默**失效。

有一条这样的行为值得单独点出来，因为它从任何签名上都看不出来：
**`ctx.settings.mutate()` 改的是 profile patch 层里**已有**的条目。** 由 bundle 自己的
`cordis.patch.yml`（`insert`）提供的行，在那一层里没有条目，所以经由 `settings` 的
写入不会落地。`ctx.configEditor.edit(entry, change)` 是按 Loader 条目寻址的 ——
这正是 `dsh-plugin-token-usage` 优先用它、只把 `settings` 留作后备的原因。

## 许可

[MIT](LICENSE) © 2026 ledon

你可以自由使用、修改与再分发这些插件（包括商用），只需保留版权声明与许可声明。
软件按「原样」提供，不附带任何形式的担保。

注意 DSH 本身是另一个产品，有自己的许可。本仓库授权的是**这些插件**，
不授予 DeepSeek Harness 的任何权利，也不代表其作者对本项目的认可。
