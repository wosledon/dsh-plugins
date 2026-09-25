[English](README.md) | 中文

# dsh-plugin-reasoning-effort

给**自定义（手工声明的）供应商**补上「按模型设置推理强度」的界面。

DSH 的模型选择器只列出**适配器已公布**的推理等级。对于 pi-ai 装目录里没有的
自定义路由，适配器拿不到任何推理元数据，于是模型选择器里连 Effort 一行都不会
出现，界面上也「不存在任意推理强度输入」；而
`dsh-client-ui-settings-models` 是**故意**不做供应商级强度控件的：

> There is deliberately no reasoning-effort control, here or on the editor card:
> effort is a per-MODEL capability, and the models under one provider disagree
> about it, so a provider-scoped control can only be set to a value some of them
> reject.

配置层其实早就支持了：`@deepseek-ai/dsh-llm-pi-ai` 允许每个模型声明
`providers.<route>.models[].reasoningEfforts`。本插件补的就是这块缺失的编辑
界面，并且严格遵守「强度是每模型能力」这条设计前提。

## 它做什么

在「设置 → 模型」的每张供应商卡片内部（官方为此预留的席位
`settings.models.provider-card`）为每个模型加一行编辑器：

- **继承** —— 省略 `reasoningEfforts`，保留已安装目录对该模型的能力；
- **不推理** —— 写入 `reasoningEfforts: false`；
- **自定义** —— 逐等级声明网线拼写，例如
  `{ low: low, high: high }`；`off` 留空写成 `null`，表示「支持关闭思考，
  但不发送任何参数」；
- 当路由协议是 `openai-completions` 时，额外提供
  `compat.supportsReasoningEffort` 的三态开关（继承 / true / false）——
  网关协议无法被自动识别时，必须显式声明它才会发送推理参数。

只读：`remote.settings.describe()`；写入：`remote.settings.mutate()`。
不新增任何 Host 服务、事件或工具。

### 写入粒度为什么是整个 `models` 数组

设置文档的路径编辑只下钻**普通对象**（`isPlainObject` 为假的数组不会被下钻）。
写 `['providers', route, 'models', '0', 'reasoningEfforts']` 会把 `models`
打散成 `{ "0": … }`，所以本插件整段回写
`['providers', route, 'models']`，其它字段（`id` / `name` / `contextWindow` /
`input` / `compat` 等）原样保留。

回写优先取**用户层原始数组**（`namespace.user`），避免把 schema 默认值固化进
用户层；用户层没有该数组时才退回解析值（`namespace.value`）。

## 目录结构

```
dsh-plugin-reasoning-effort/
├── package.json          # dsh.bundle.patch + dsh.client 声明
├── cordis.patch.yml      # bundle 补丁：插入一行宿主条目
├── index.js              # 宿主侧：空实现（浏览器侧才有行为）
├── client.js             # 浏览器侧：懒工厂 + 席位注册 + 卡片组件
├── icon.svg              # 插件页图标
├── locale/{en,zh}.json   # 插件页标题与描述
├── scripts/verify-contract.mjs   # 契约自检（开发用，不随包安装）
├── README.md             # 英文（默认）
└── README.zh.md          # 中文
```

宿主侧之所以存在，只是因为 `dsh-client-modules` 只扫描**已启用 Loader 条目**
的 `package.json dsh.client` 声明；浏览器 bundle 通过 `exports["./client"]`
取到。没有这一行，`client.js` 就不会进入 `window.__DSH_BOOT__`。

## 安装（本机已完成）

```text
plugin_manager install_bundle  target: file:E:\repos\dsh-plugins\dsh-plugin-reasoning-effort
```

它会做两件事：把包加进 profile 的 `dependencies`，并把
`dsh-plugin-reasoning-effort` 追加到 `package.json` 的
`dsh.profile.bundles`。当前 profile 是 `C:\Users\Administrator\.dsh\profiles\desktop`。

### 改动之后要重新安装

pnpm 对 `file:` 依赖是**拷贝**而不是软链，所以改了 `client.js` 之后必须让
profile 拿到新文件：

```text
plugin_manager remove_bundle   target: dsh-plugin-reasoning-effort
plugin_manager install_bundle  target: file:E:\repos\dsh-plugins\dsh-plugin-reasoning-effort
```

（直接重复 `install_bundle` 会返回 `changed: false` / `ambiguous-install`。）
重新安装后刷新页面，浏览器才会拿到新的 bundle。

### 卸载

```text
plugin_manager remove_bundle   target: dsh-plugin-reasoning-effort
```

## 使用

1. 打开「设置 → 模型」；
2. 展开自定义供应商（例如本 profile 里的 `stepfun`）；
3. 在卡片底部找到「推理强度（按模型）」；
4. 选 **自定义** → 展开 → 填等级拼写 → 保存。

以 `stepfun` 为例，保存后 profile 的 `cordis.patch.yml` 里该模型的条目会变成：

```yaml
- id: llm-pi-ai
  config:
    providers:
      stepfun:
        api: openai-completions
        models:
          - id: step-3.7-flash
            name: step-3.7-flash
            contextWindow: 262144
            input: [text, image]
            reasoningEfforts:
              off: null      # 留空：支持关闭思考，但不发送该参数
              low: low
              high: high
            compat:
              supportsReasoningEffort: true
```

具体拼写要以网关文档为准：`low` / `medium` / `high` 一类是 OpenAI 兼容端点
的常见取值，但值由你填，插件不做任何臆断。

### 两条宿主硬规则（插件已在保存前替你校验）

1. `off` 之外的等级必须有非空拼写，否则宿主在**任何网络 I/O 之前**就拒绝；
2. 至少要声明一个思考等级；只想要关闭思考请选「不推理」，它写的是
   `reasoningEfforts: false`。

## 验证状态

已验证：

- 包与补丁清单可解析，`insert` 行名与包名一致；
- 浏览器侧以包名为 id 注册懒工厂，工厂返回合法的 Cordis 插件对象；
- `apply()` 只在 `settings.models.provider-card` 上登记 **keyed** 单元格，
  键取自 `remote.llm.listConfigurableProviders()` 的真实 `settingsNs`；
- 写入形状：单条 `set` 操作，路径落在 `providers/<route>/models`（不是数组
  元素），值是完整 `models` 数组，并带回读到的 `revision`；
- 等级映射规则：`off` 留空 → `null`、未填写的等级不写键、只声明 `off` 被拒、
  继承模式不写字段、`compat` 三态与无关字段保留、原对象不被改动；
- 宿主条目 `include:reasoning-effort` 已 `active`；
- 客户端席位实况：`llm-pi-ai` / `llm-deepseek` / `llm-deepseek-account`
  三个键上均有活跃占位，正是设置页实际派发的命名空间。

未验证（需要你在页面上操作，本会话没有浏览器控制权）：

- 卡片的**视觉呈现**（配色、间距、与宿主控件的一致性）；
- **保存往返**：点「保存」后写回 profile 并出现在下一次 `describe()` 里。

自检脚本（不渲染 React，只验证装配形状与映射规则，共 49 项断言）：

```powershell
node scripts/verify-contract.mjs
```

它通过 `plugin.__internals` 这个测试接缝读取纯映射函数 —— Cordis 只读
`inject` / `apply` / `name` / `Config`，多余导出会被忽略。

## 已知限制

- 只覆盖带 `models` 数组的供应商命名空间；DeepSeek 官方等目录型路由不显示
  这一区（它们的模型不在 `models` 数组里）。
- 手写声明、尚未保存的「添加供应商」草稿卡没有目录行，因此在保存成真实路由
  之前不会渲染这一区（宿主侧的既定行为）。
- 不提供供应商级的强度默认值 —— 与官方设计一致，强度是每模型的能力。
- 没有构建步骤：`client.js` 就是可直接加载的浏览器 bundle
  （`window.__ModuleLoader__.load({ id, factory })`，工厂返回插件对象）。
