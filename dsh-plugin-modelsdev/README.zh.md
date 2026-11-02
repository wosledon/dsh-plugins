[English](README.md) | 中文

# dsh-plugin-modelsdev

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：在
**设置 → 模型** 里浏览公共的 [models.dev](https://models.dev) 目录，把供应商及其
模型一键导入成可直接使用的 `llm-pi-ai` 路由。

models.dev 维护着 235 个供应商、约 9 千个模型描述：端点、所需环境变量、上下文
窗口、输出上限、输入模态、推理等级。这些几乎正好是
`@deepseek-ai/dsh-llm-pi-ai` 的 `providers.<route>` 需要的字段，所以本插件把
「目录条目」翻译成一次合法的设置写入，省去逐项抄写。

## 出现位置

插件注册在官方为仓库外插件预留的 `settings.models.footer` 席位，位于供应商行和
**添加模型供应商** 控件之后：

```
设置 → 模型
  DeepSeek 账号
  DeepSeek
  … 供应商行 …
  [ 添加模型供应商 ]
  ┌ models.dev 目录 ────────────────────────────── [浏览目录] ┐   ← 本插件
  │ 搜索供应商 · 供应商列表 · 模型选择                      │
  │ Provider ID · 显示名称 · 协议 · 端点 · API Key          │
  └─────────────────────────────────────────────────────────┘
```

它不修改“模型”页本身，只使用 `@deepseek-ai/dsh-client-ui-settings-models`
为第三方 bundle 暴露的席位契约。

## 使用

1. 打开 **设置 → 模型**，展开 **models.dev 目录**。
2. 搜索供应商。目录由宿主进程抓取一次并缓存 6 小时；**刷新目录** 会强制刷新。
3. 选择要暴露的模型。插件默认选中该供应商的全部未弃用对话模型；**全选**、
   **清空** 和模型搜索可以收窄范围。
4. 检查预填的连接信息：
   - **Provider ID** —— 设置键与请求路由名。由 models.dev id 派生
     （`Acme AI` → `acme-ai`），已存在时自动加后缀。
   - **API 协议** —— 由供应商的 `npm` 字段推断。pi-ai 已安装目录里的供应商可以
     保持 **使用已安装目录**。
   - **API 地址** —— 由供应商的 `api` 字段推断，并按所选协议归一化。
   - **API Key** —— 可选。输入框下方显示将要写入的凭据引用
     （models.dev 提供环境变量名时用它，否则 `<ROUTE>_API_KEY`）以及该引用是否
     已配置。
5. 点击 **导入到 DSH**。路由会立即出现在供应商列表中；打开该行即可在官方编辑器
   里继续修改。

## 写入了什么

设置写入落在 `llm-pi-ai` 命名空间的 `providers.<route>`。例如导入 MiniMax 的
Anthropic 兼容端点会写入：

```yaml
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      minimax:
        displayName: MiniMax (minimax.io)
        apiKeyEnv: MINIMAX_API_KEY
        api: anthropic-messages
        baseURL: https://api.minimax.io/anthropic
        models:
          - id: MiniMax-M3
            contextWindow: 1000000
            maxTokens: 524288
            input: [text, image]
          - id: MiniMax-M3.1-Flash
            contextWindow: 1000000
            maxTokens: 524288
            input: [text, image]
            reasoningEfforts:
              low: low
              medium: medium
              high: high
              xhigh: xhigh
              max: max
```

API Key 本身不会进入设置文档：它通过凭据 seam（`remote.credentials.set`）按
`apiKeyEnv` 存储，路由在每次请求时解析。轮换密钥后下一次请求立即生效，无需重启。

带**原生认证**的目录供应商（Bedrock、Vertex 以及类似的凭据链）在密钥留空时会
保留原生认证：写入会省略 `apiKeyEnv`，而不是把认证钉死在一个环境变量上。输入
密钥，或页面已经确认该引用已配置时，仍会照常写入引用。

## 映射规则

| models.dev | 写入为 | 说明 |
| --- | --- | --- |
| `provider.id` | 路由 id 默认值 | 转小写、非字母数字变 `-`；已存在时自动加后缀 |
| `provider.name` | `displayName` | 表单可改 |
| `provider.api` | `baseURL` | 按协议归一化；`${PLACEHOLDER}` 地址会被丢弃，需手填 |
| `provider.npm` | `api` | `@ai-sdk/anthropic` → `anthropic-messages`；`@ai-sdk/openai*`、`@ai-sdk/azure` → `openai-completions` |
| `provider.env[0]` | `apiKeyEnv` | 合法的 POSIX 标识符才采用，否则 `<ROUTE>_API_KEY` |
| `model.id` | `models[].id` | — |
| `model.name` | `models[].name` | 与 id 相同时省略 |
| `limit.context` | `contextWindow` | 缺失时省略 |
| `limit.output` | `maxTokens` | 缺失时省略 |
| `modalities.input` | `input` | 支持图像时写 `image`；总是包含 `text` |
| `reasoning_options[].type = effort` | `reasoningEfforts` | `none` → `off`；pi-ai 七级之外的取值丢弃；`toggle` / `budget_tokens` **不猜** |
| `status = deprecated` | 不导入 | 同时排除 embedding、图像、实时、重排、语音、转写、视频模型 |

**目录路由与手工声明路由。** pi-ai 已安装目录里的供应商不需要写 `api` 或
`baseURL`：适配器保留每个模型自己的协议与端点。插件通过
`llm.listConfigurableProviders()` 识别这种情况，并用 `llm.discoverModels()`
取得已安装目录的模型 id。目录内的模型只写 `{ id }`，让适配器自己的元数据生效；
目录外的模型写全量字段，表单会要求选择协议（目录没有默认端点时还要填地址）。
pi-ai 完全不认识的供应商则始终写 `api`、`baseURL` 和全量元数据。

**Anthropic 端点。** Anthropic Messages 适配器自己拼 `/v1/messages`，因此
models.dev 的 `https://api.minimax.io/anthropic/v1` 会被写成
`https://api.minimax.io/anthropic`。OpenAI 协议保留 `/v1`。

## 架构

| 半 | 文件 | 职责 |
| --- | --- | --- |
| 宿主 | `index.js` | 在 `ctx.webServer` 上挂一条精确路由 `/plugin-modelsdev/catalog` |
| 宿主 | `lib/catalog.js` | 抓取 `https://models.dev/api.json`，投影成紧凑负载，进程内缓存，处理 GET/HEAD，上游失败时回退旧缓存 |
| 浏览器 | `client.js` | 渲染页脚区块、驱动目录浏览器、推断连接信息，并通过 `remote.settings.mutate` + `remote.credentials.set` 写入 |

宿主投影约 1.1 MB（233 个供应商、7,600+ 对话模型），上游原始文档约 6 MB。
描述和价格不发给浏览器，因为 DSH 的模型界面不显示它们。

路由刻意不放在 `/api` 下：它是一条只读、同源的目录端点，不是 Remote RPC
命名空间。可以用环境变量 `DSH_MODELSDEV_URL` 指向镜像。

## 限制

- **不覆盖已有路由。** 检测到 `providers.<route>` 已存在时表单会拒绝写入；换一个
  Provider ID 新增路由，或在官方模型编辑器里改已有路由。
- **没有价格。** models.dev 的成本数据在投影时被丢弃，因为 DSH 不显示价格。
- **推理能力保守映射。** 只映射 `effort`；`toggle` 和 `budget_tokens` 模型不写
  `reasoningEfforts`，而不是编造一个网线拼写。
- **协议范围有限。** 只提供 `llm-pi-ai` 接受的三种协议；Bedrock、Vertex、
  Azure 原生和 Codex 路由仍应走 pi-ai 自己的目录。
- **目录是快照。** 每个进程缓存 6 小时，刷新按钮可跳过缓存；models.dev 不可达时
  返回旧缓存。
- **非文本模型不导入。** 嵌入、图像、语音等模型无法被 DSH 的模型循环驱动。

## 安装与更新

```text
plugin_manager install_bundle   target: file:E:\repos\dsh-plugins\dsh-plugin-modelsdev
```

更新已安装副本时先移除再安装（pnpm 对 `file:` 依赖是复制而不是软链）：

```text
plugin_manager remove_bundle    target: dsh-plugin-modelsdev
plugin_manager install_bundle   target: file:E:\repos\dsh-plugins\dsh-plugin-modelsdev
```

宿主侧改动还需要重启 Harness，因为 Node 会缓存已导入的模块；浏览器半随页面刷新
重新加载。

## 验证

包内有一个零依赖自检，覆盖宿主投影、缓存、过期回退、HTTP 路由，以及浏览器半的
全部纯映射：

```text
node scripts/verify-catalog.mjs
# verify-catalog: 100 assertions passed
```

插件已安装进 desktop profile 并做过在线验证：目录路由返回 233 个供应商 /
7,619 个模型（1.09 MB），`settings.models.footer` 席位报告
`modelsdev-catalog` 占用者处于 active 状态。渲染后的区块需要已认证的 Harness
页面才能目视检查；本开发环境无法附加到该页面，因此没有记录截图。

## 许可

MIT。models.dev 数据在运行时抓取，本包不重新分发这些数据。图标为原创作品。
