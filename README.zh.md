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
| [`dsh-plugin-remote-dsh`](dsh-plugin-remote-dsh/README.zh.md) | 把 SSH 主机变成远程 DSH Web 工作区：探活、安装官方 CLI、启动 `dsh web`、建隧道，并在右侧栏打开 | 有（SSH 配置、安装/启动/隧道、本地 API） | 有（左侧菜单 + 主机管理页） |

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

### dsh-plugin-remote-dsh

远端版本：左侧栏一个 **远程 DSH** 菜单，读取 `~/.ssh/config`（通过 `ssh -G`），
也支持手动添加远端。每台主机可以：

- **探活** `node` / `npm` / `npx` / `dsh` 和 npm 全局前缀；
- **启动** 远端 Web profile：默认
  `npx -y @deepseek-ai/dsh@latest web --host 127.0.0.1 --port <p> --no-open`，
  或切到 global 模式，先 `npm install -g --prefix ~/.npm-global @deepseek-ai/dsh@latest`。
  registry 默认 npmmirror，可以避免远端不可达的 `.npmrc` 把启动拖到超时。
- 宿主建同端口 SSH 隧道，解析 `dsh web: <url>?token=…`，返回本地 URL；启动不会
  自动切面板或弹窗；
- 运行中的卡片只有一个 **浏览器** 按钮；启动不会切面板或弹窗；
- 右侧栏按 Session，所以会话头部的 **远程 DSH** 按钮（以及右侧栏引导入口）会打开
  启动器 tab；每台运行中的远端整行可点，直接在当前 Session 的 Browser tab 打开。

远端 Web 只绑 loopback，流量走 SSH 本地转发，因此**不要求同一局域网**：只要本地
能 `ssh <target>`，公网 IP、DDNS、Tailscale 或跳板机后的主机都可以；ssh-config 的
`ProxyJump` / `ProxyCommand`，以及手动主机的 Proxy jump 字段都会生效。本地和远端
仍是两套 session。模式、安全和限制见[插件 README](dsh-plugin-remote-dsh/README.zh.md)。

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
  node scripts/verify-catalog.mjs      107 条断言

dsh-plugin-remote-dsh
  node scripts/verify-contract.mjs      80 条断言
```

`verify-catalog.mjs` 覆盖目录投影（模型过滤、推理等级别名、api 归一化）、缓存过期 /
强制刷新 / 旧缓存回退、并发抓取、HTTP 路由的 200/404/405/502 响应，以及浏览器半的
全部纯映射（协议推断、端点归一化、凭据引用、模型 profile、导入校验）。

`verify-contract.mjs` 覆盖 ssh-config 解析 / `ssh -G`、SSH 参数构造、日志 URL
提取、探活解析、手动主机校验、状态文件、token 保护的 API、假 SSH 的
start/open/stop 流程，以及远程页面的样式契约。

针对 desktop profile 做过的在线检查：

- `GET /plugin-modelsdev/catalog` → 200，233 个供应商、7,619 个对话模型，
  首次抓取 1.09 MB / 1.46 秒。
- `settings.models.footer` → `modelsdev-catalog` 占用者，active。
- `GET /plugin-remote-dsh/api/bootstrap` → 200，返回 token；
  `GET /plugin-remote-dsh/api/hosts` → 4 台来自 `~/.ssh/config` 的主机，无配置
  错误；不带 token → 401。
- `sidebar.panellist` 与 `main` 都报告 `remote-dsh` 占用者 active。
- 通过插件真实启动测试主机，npx（npmmirror）和 global（安装到 `~/.npm-global`）
  两种模式都成功：返回远端 URL，本地 SSH 隧道返回 `DeepSeek Harness`（HTTP 200），
  停止后清理。
- 端口冲突返回 `PORT_IN_USE` 和监听 PID，未截断日志；显式 force 重启替换了已有
  `dsh web`，新 URL 通过隧道返回。
- 一台远端已占用本地 3080 时，启动另一台远端自动在两边改用 3081；两个 URL 都能
  返回 `DeepSeek Harness`。

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

dsh-plugin-remote-dsh/
  index.js              宿主入口：API 路由 + 隧道生命周期
  lib/ssh-config.js     ~/.ssh/config + ssh -G + 命令构造
  lib/state.js          state.json 存储与手动主机模型
  lib/remote.js         probe / install / start / stop / open / logs
  lib/server.js         token 保护的本地 API
  client.js             侧栏图标 + 远程 DSH 页面
  scripts/
    verify-contract.mjs 零依赖自检
  cordis.patch.yml
  locale/{en,zh}.json
  icon.svg
  README.md / README.zh.md
```

`_scratch/` 是本地、被 git 忽略的开发目录（提取的 DSH 源码、临时探针），不属于
任何插件。

## 许可

MIT —— 见 [LICENSE](LICENSE)。
