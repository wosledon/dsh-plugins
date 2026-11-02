[English](README.md) | 中文

# dsh-plugin-remote-dsh

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：
把远端机器变成可以直接在本地侧栏打开的 DSH Web 工作区。

它读取 `~/.ssh/config`，也支持手动添加远端；每台远端可以探活、全局安装官方
DSH CLI、启动远端 Web profile、通过 SSH 隧道接回本地，并在右侧栏 Browser 中
打开远端 UI。远端工作区及其会话都在远端，本地窗口只是它的查看器。

## 出现位置

左侧栏一个独立入口：

```text
左栏
  …
  远程 DSH          ← 本插件
  …

主面板
  Remote DSH hosts
  ┌ alpha ─ ssh config ─ 未启动 ───────────────┐
  │ 探活 · 安装/升级 · 启动 · 日志              │
  │ 端口 3080                                   │
  └─────────────────────────────────────────────┘
  ┌ home ─ ssh config ─ 运行中 :3080 ───────────┐
  │ 打开 · 重启 · 停止 · 日志                   │
  └─────────────────────────────────────────────┘
```

## 主机发现

宿主侧解析 `~/.ssh/config` 的 `Host` 与 `Include`，跳过通配模式，然后对每个
具体别名执行 `ssh -G <alias>`。因此 `HostName`、`User`、`Port`、
`IdentityFile`、`ProxyJump` 都来自 OpenSSH 本身，而不是重新实现一套
`ssh_config` 匹配逻辑。

手动添加的主机保存在 `$DSH_HOME/remote-dsh/state.json`，与 ssh-config 主机合并。
手动字段：名称、SSH 目标（`user@host` 或别名）、SSH 端口、私钥路径、跳板机、
远端 Web 端口。

## 两种启动方式

| 方式 | 命令 | 适用 |
| --- | --- | --- |
| **npx**（默认） | `npx -y @deepseek-ai/dsh@latest web --host 127.0.0.1 --port <port> --no-open` | 远端没预装 dsh；使用 npx 缓存，每次按 `@latest` 解析 |
| **global** | `npm install -g --prefix ~/.npm-global @deepseek-ai/dsh@latest`，然后 `~/.npm-global/bin/dsh web --host 127.0.0.1 --port <port> --no-open` | 用户级全局一份，可升级；不需要 sudo |

页面顶部可以切换。global 模式下卡片会出现 **安装 / 升级**，执行
`npm install -g --prefix ~/.npm-global` 并回读 `dsh --version`。前缀属于当前
SSH 用户，因此不需要系统级 `/usr/local` 权限。

**npm Registry。** 页面有 registry 输入，默认
`https://registry.npmmirror.com`。npx 通过 `npm_config_registry`、安装通过
`--registry` 传入，所以远端 `.npmrc` 指向不可达的私有源时不会再把启动拖到超时。
可以改成 `https://registry.npmjs.org` 或自己的源；留空则使用远端 `.npmrc`。
npx 启动前会先跑一个短的 `npm view <pkg> version` 预检，源不可达会在几秒内失败。

两种方式启动的都是**官方** `dsh web`，插件只决定二进制来源。

## 点击“启动”后发生什么

1. 探活：`command -v node/npm/npx/dsh`、版本、npm 全局前缀
2. 在远端后台启动 Web profile：`127.0.0.1:<port>`，`setsid`（或 `nohup`），
   日志写到 `~/.dsh-remote/web-<port>.log`
3. 轮询日志，取出 `dsh web: <url>?token=…`
4. 本地建同端口 SSH 隧道：
   `ssh -N -L <port>:127.0.0.1:<port> <host>`
5. 把 URL 改写成 `http://127.0.0.1:<port>/?token=…`，保存为本地 URL。**启动不会**
   自动切面板或弹窗。

右侧栏是**按 Session** 的。远程 DSH 页面是根面板，不会把页面本身塞进 Session。
启动后页面保持不动，运行中的卡片只有一个 **浏览器** 按钮：先确保隧道，再开普通
浏览器窗口。

### 会话内启动菜单

进入任意本地 Session 后，点会话头部的 **远程 DSH** 按钮，或在右侧栏引导页选同名
入口，会打开启动器 tab。它列出所有**运行中**的远端；整行就是一个点击目标，点击后
先确保 SSH 隧道，再把远端 URL 作为 Browser tab 开进当前 Session。启动器里不再提供
“右侧栏/浏览器”选择——浏览器入口就是远程 DSH 页面上的 **浏览器** 按钮。

启动器会先调用插件的 `open` API，所以 Harness 重启后断掉的隧道也会被重建。这是把
远端工作区和本地会话并排看的推荐入口。

**本地端口冲突。** 每台运行中的远端需要一个本地端口。如果请求的本地端口已被另一台
远端的隧道占用，Start 会从下一个端口开始探测，选第一对**远端和本地都空闲**的端口。
两边保持同一个端口号，这样 token URL 仍然在远端 Web 绑定的同一 authority 下打开。
卡片会更新成实际端口并给出提示。

远端 Web 只绑 loopback，流量走 SSH 隧道。停止会杀本地隧道和远端进程组；状态
文件记住 PID / URL / 日志，所以 Harness 重启后 **打开** 可以重建已断开的隧道。

**端口冲突。** 启动前先查远端端口；如果已被占用，Start 返回 `PORT_IN_USE`，带上
监听进程的 PID 和命令。页面会问是否停止那个监听器；只有它确实是 `dsh web` 时才会
杀，会话保留，但旧 token URL 失效。非 DSH 进程不会被杀，请换端口。

## 跨公网与 SSH 跳板

远端 Web 只绑 `127.0.0.1`，**局域网不是必要条件**。本地访问完全走 SSH 本地转发：

```text
ssh -N -L <port>:127.0.0.1:<port> <ssh-target>
```

所以只要本地能 `ssh <target>`，就能用：公网 IP、DDNS、Tailscale / ZeroTier 地址，
或者跳板机后面的主机都可以。ssh-config 主机是把 alias 直接交给 `ssh`，因此
`~/.ssh/config` 里的 `ProxyJump` / `ProxyCommand` 会自动生效。手动主机有
**Proxy jump** 字段，隧道会传成 `-J`。

如果本地 `ssh <alias>` 本身就连不上，插件也到不了那台机器，先解决 SSH 可达性。
不支持密码 / 2FA 交互（`BatchMode=yes`），请用密钥或 ssh-agent。

## 状态与 API

没有插件 Config schema。状态在 `$DSH_HOME/remote-dsh/state.json`：

```json
{
  "settings": { "mode": "npx", "spec": "latest", "registry": "https://registry.npmmirror.com" },
  "manualHosts": [],
  "instances": {
    "home": {
      "remotePort": 3080,
      "localPort": 3080,
      "pid": 12345,
      "url": "http://127.0.0.1:3080/?token=…",
      "logPath": "/home/ledon/.dsh-remote/web-3080.log",
      "mode": "npx",
      "spec": "latest"
    }
  }
}
```

本地 API 挂在 `/plugin-remote-dsh/api/`。`GET bootstrap` 返回进程级 token；其余
路由都要求 `x-remote-dsh-token`。token 只交给同源的本地页面，所以侧栏里加载的
远端 Web（另一个 origin）无法驱动本插件。

## 要求

- **远端系统**：Linux 或 macOS，有 `sh`；npx 模式需要 `npx`，global 模式需要
  `npm`（安装到用户级 `~/.npm-global`，不需要 sudo）
- **SSH**：密钥 / ssh-agent，`BatchMode=yes`；不支持密码和 2FA 交互，host key
  必须已在 `known_hosts` 中；`~/.ssh/config` 的 `ProxyJump` 会生效
- **远端模型**：远端 Web profile 是独立的。首次打开时在远端 UI 里登录 / 配置
  模型；本插件不复制本地账号或凭据
- **本地端口**：每台运行中的远端占一个本地端口；冲突时自动选择下一对空闲端口

## 安全

- 远端 Web 只绑 `127.0.0.1`，本插件不会把它暴露到网络；本地隧道是本地 SSH 进程
- 带 token 的远端 URL 存在本地状态文件里，侧栏打开；请把该文件当作敏感文件
- 本地 API token 阻止侧栏里的远端页面（不同 origin）调用 install/start/stop
- `npm install -g --prefix ~/.npm-global` 会以 SSH 用户身份执行远端包安装脚本；
  请使用可信 registry 和最小权限的远端账号
- 默认 registry 是 npmmirror；可以改成 npmjs 或自己的源；留空使用远端 `.npmrc`

## 已知限制

- 不支持 Windows 远端
- 不支持密码 / 2FA SSH，只支持密钥/agent
- 启动最多等 180 秒（首次 npx 下载可能较慢）
- 远端模型/账号需要在远端 UI 手动配置
- 没有后台健康检查；**打开** 会重建断开的本地隧道，**停止** 会清除实例
- 不是 session 联邦：本地会话和远端会话相互独立
- 一台运行中的远端占一个本地端口；请求的端口被占用时自动改用下一对空闲端口

## 验证

```text
node scripts/verify-contract.mjs
# verify-contract: 80 assertions passed
```

覆盖 ssh-config 解析 / `ssh -G`、SSH 参数构造、日志 URL 提取、探活解析、手动主机
校验、状态持久化、API token 路由、假 SSH 的 start/open/stop 流程，以及浏览器半的
样式契约。

desktop profile 里的在线检查：

- `GET /plugin-remote-dsh/api/bootstrap` → 200，返回 token
- `GET /plugin-remote-dsh/api/hosts` → 4 台来自 `~/.ssh/config` 的主机，
  `mode: npx`，无配置错误；不带 token → 401
- `sidebar.panellist` 与 `main` 都报告 `remote-dsh` 占用者 active
- React 渲染冒烟测试走通 探活 → 启动 → 侧栏打开（假 API）
- **真实远端**：通过本地 API 在测试主机上分别用 npx（npmmirror）和 global
  （安装到 `~/.npm-global`）启动；远端 `dsh web` 打印 URL，本地 SSH 隧道返回
  `DeepSeek Harness`（HTTP 200）；**停止** 后远端进程和本地隧道都被清理。
  global 安装 19 秒装了 616 个包，版本 `0.2.1-rc.5`。测试实例已停止。
- **端口冲突**：另一台主机已有 `dsh web` 监听 3080。不带 force 的 Start 返回
  `PORT_IN_USE` 并带上 PID，日志未被截断，也没有新进程；带 force 会停止那个
  `dsh web` 并启动新实例，新 token URL 通过隧道返回 UI。
- **本地端口冲突**：一台主机已占用本地 3080 时，第二台主机用同一个请求端口启动，
  自动在远端和本地都改用 3081；两个 token URL 同时返回 HTTP 200。

## 文件

```text
index.js                 宿主入口：API 路由 + 隧道生命周期
lib/ssh-config.js        ~/.ssh/config + ssh -G + 命令构造
lib/state.js             state.json 存储与手动主机模型
lib/remote.js            probe / install / start / stop / open / logs
lib/server.js            token 保护的本地 API
client.js                侧栏图标 + 远程 DSH 页面
scripts/verify-contract.mjs
locale/{en,zh}.json
icon.svg
```
