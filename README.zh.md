[English](README.md) | 中文

# dsh-plugins

**DeepSeek Harness**（DSH）的第三方插件仓库。DSH 的插件以 *bundle* 形式声明，
由基于 Cordis 的 Loader 装载。

这里的每个插件都是自包含的包，可以用 `plugin_manager` 安装进 DSH profile。
它们都不需要构建步骤：浏览器侧是 DSH 模块加载器要求的纯 JavaScript bundle，
宿主侧是普通 ESM。

## 插件

| 插件 | 功能 | 宿主侧 | 浏览器侧 |
| --- | --- | --- | --- |
| [`dsh-plugin-modelsdev`](dsh-plugin-modelsdev/README.zh.md) | 在“设置 → 模型”里浏览 models.dev 供应商/模型目录，把供应商及其模型导入成可用的 `llm-pi-ai` 路由 | 有（带缓存的目录 HTTP 路由） | 有（页脚区块 + 导入器） |

### dsh-plugin-modelsdev

models.dev 为 235 个供应商、约 9 千个模型提供端点、凭据变量、上下文窗口、输出
上限、输入模态和推理等级。DSH 的“模型”页可以通过
`@deepseek-ai/dsh-llm-pi-ai` 的 `providers.<route>` 表达其中大部分信息，但需要
手工逐项填写。本插件补上这一步：

- **宿主半**每个进程抓取一次 `https://models.dev/api.json`，投影成约 1.1 MB 的
  紧凑负载（去掉描述、价格、弃用模型和非对话模型），缓存 6 小时，并通过
  `/plugin-modelsdev/catalog` 提供给页面；上游失败时回退旧缓存。
- **浏览器半**注册在官方 `settings.models.footer` 席位。搜索供应商、勾选模型、
  确认推断出的协议 / 端点 / 凭据引用、粘贴 API Key，点击 **导入到 DSH**。设置
  写入走 `remote.settings.mutate('llm-pi-ai', …)`；密钥走
  `remote.credentials.set`，永远不进入设置文档。

它区分**目录路由**（pi-ai 已安装目录里的供应商，模型元数据和协议由目录提供）和
**手工声明路由**（OpenAI 兼容网关、Anthropic 兼容端点，必须显式给出 `api` 与
`baseURL`）。Anthropic 端点会自动归一化，因为适配器自己拼 `/v1/messages`；
`none` 推理等级映射为 `off`，而 `toggle` / `budget_tokens` 模型不会写入凭空猜测
的等级映射。

完整映射表、写入形状和限制见[插件 README](dsh-plugin-modelsdev/README.zh.md)。

## 安装

把 `plugin_manager` 指向包目录即可安装进当前 DSH profile：

```text
plugin_manager install_bundle   target: file:<插件目录的绝对路径>
```

例如：

```text
plugin_manager install_bundle   target: file:E:\repos\dsh-plugins\dsh-plugin-modelsdev
```

更新已安装插件时先移除再安装 —— pnpm 对 `file:` 依赖是复制而不是软链，重复
`install_bundle` 会报 `ambiguous-install`：

```text
plugin_manager remove_bundle    target: dsh-plugin-modelsdev
plugin_manager install_bundle   target: file:E:\repos\dsh-plugins\dsh-plugin-modelsdev
```

### 容易踩的两个点

**1. 宿主侧改动可能需要重启。** 刷新页面只重载浏览器侧。宿主侧运行在 DSH 进程
里，Node 的 ESM 缓存以解析后的路径为键 —— 替换磁盘上的文件不会替换已经导入的
模块。如果宿主侧改动（目录路由、投影逻辑）没有出现，重启 Harness。

**2. 目录路由是同源端点，不在 `/api` 下。** `/plugin-modelsdev/catalog` 是注册在
`ctx.webServer` 上的只读 HTTP 路由，浏览器不经过 Remote RPC 网关就能读取。它提供
的是公开目录数据，因此不需要凭据；可以用环境变量 `DSH_MODELSDEV_URL` 指向镜像。

## 验证

插件自带零依赖自检：

```text
dsh-plugin-modelsdev
  node scripts/verify-catalog.mjs      100 条断言
```

覆盖目录投影（模型过滤、推理等级别名、api 归一化）、缓存过期 / 强制刷新 / 旧缓存
回退、并发抓取、HTTP 路由的 200/404/405/502 响应，以及浏览器半的全部纯映射
（协议推断、端点归一化、凭据引用、模型 profile、导入校验）。

针对 desktop profile 做过的在线检查：

- `GET /plugin-modelsdev/catalog` → 200，233 个供应商、7,619 个对话模型，
  首次抓取 1.09 MB / 1.46 秒。
- `settings.models.footer` → `modelsdev-catalog` 占用者，active。

渲染后的区块需要已认证的 Harness 页面；本开发环境无法附加到该页面，因此没有记录
截图，目视验证仍不可用。

## 仓库结构

```text
dsh-plugin-modelsdev/
  index.js              宿主入口：挂载目录路由
  lib/catalog.js        抓取、投影、缓存、提供 HTTP 响应
  client.js             Web bundle：页脚区块 + 导入器
  scripts/
    verify-catalog.mjs  零依赖自检
  cordis.patch.yml      bundle 补丁（一行 Loader 条目）
  locale/{en,zh}.json   插件清单标题/描述
  icon.svg              原创图标
  README.md / README.zh.md
```

`_scratch/` 是本地、被 git 忽略的开发目录（提取的 DSH 源码、临时探针），不属于
任何插件。

## 许可

MIT —— 见 [LICENSE](LICENSE)。
