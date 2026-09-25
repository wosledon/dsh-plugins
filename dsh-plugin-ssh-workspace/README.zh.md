# dsh-plugin-ssh-workspace

SSH 远程工作区：让 Agent 真正在远程主机上工作，并提供一个管理面板。

> **状态：宿主半已在真机验证可用；SSH 连通性尚未验证。**
>
> **已验证**：插件激活（`internal.lastBoot.phase = ready`）、**5 个工具全部注册**
> （`detail: tools=5`）、工具可被模型调用并正确渲染结果、插件列表显示本地化名称、
> 面板在侧边栏可见。离线自检 121 项断言全过（含 SHA256 校验的负向对照）。
>
> **尚未验证**：真正连上一台远程主机（需要先配一台）。`ssh_exec` /
> `ssh_read_file` / `ssh_list_dir` 的实际行为、远端 `find -printf` 的可用性、
> 以及面板里的「执行」按钮，都要等有主机之后才能确认。

## 它做什么

Agent 通过一组工具（Tool）在远程主机上执行命令、列目录、读文件；你可以在面板里
管理多台主机、探通连通性、回看命令历史。

**架构选择：走 Tool，而不是替换 `fs`/`shell` 服务。**

宿主管线里 `fs` 与 `shell` 都是 abstract 服务，理论上可替换。但"第三方插件能否在
Agent 能看到的作用域上覆盖 base 实现"这条我没有验证过，而赌它的代价是整套功能
不可用。Tool 是已证明可用的扩展点（定时任务插件已真机跑通），所以：

| 能力 | 落地方式 |
| --- | --- |
| Agent 在远端执行命令 | `ssh_exec` 工具 |
| Agent 读远端文件 | `ssh_read_file` / `ssh_list_dir` 工具 |
| 人管理主机、探通、看历史 | 面板（客户端半） |

代价：Agent 的**本地**文件工具仍然指向本地工作区，不会因为配了远程主机而改变。
这符合"按工作区绑定"的选择，也意味着不会因为配错而让本地工作区失效。

## 为什么用系统 `ssh` 而不是 npm 的 `ssh2`

1. 不引入第三方依赖——带原生模块的包装不进 profile 的风险很高。
2. 复用你机器上已有的 `~/.ssh`、`ssh-agent`、`known_hosts`，**密钥永不进本插件的
   任何存储**。这与"只支持私钥认证"直接对应。
3. SSH 协议的密钥交换与加密交给 `ssh` 自己，本插件不实现、也不该实现。

顺带一个实现细节：用 `spawn` 而不是 `execFile`。`execFile` 的 `maxBuffer` 超限会
直接以 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` 失败，于是"输出很长"会被报成"执行失败"，
界面也无法说清是被截断了。这里自己按字节累积，超限只置 `truncated`。

## 安全边界（重要）

`ssh_exec` 让模型在远程主机上跑**任意命令**。这是本插件存在的目的，但也意味着
一旦配置了主机，模型就拥有那台机器上该用户的全部权限。三道收窄：

1. **必须显式指定 `hostId`** —— 工具不可能自己"发现"或连到没配过的主机。
2. **只支持私钥认证**，插件不存任何口令；密钥留在你自己的 `~/.ssh`。
3. **`enableTools: false` 可整组关掉** —— 只想用面板时关掉它，模型就碰不到远端。

没有做命令白名单：那会给"跑个 grep 都要先加白名单"的日常使用制造摩擦。真正的
边界是"配了哪些主机、用哪个身份"，那已经由 `hostId` + 私钥决定了。

密钥策略用 `StrictHostKeyChecking=accept-new`：首次连接新主机不弹交互确认
（BatchMode 下也弹不出来，只会失败），但主机密钥一旦变化仍然拒绝——后者才是
真正要防的中间人风险。

## 安装

```powershell
plugin_manager install_bundle "file:E:\repos\dsh-plugins\dsh-plugin-ssh-workspace"
```

宿主半改动**必须重启宿主**才生效（Node ESM 缓存按解析路径缓存，
`remove_bundle`+`install_bundle` 只重载行、不重载模块）。

## 配置项

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `hosts` | `[]` | 远程主机列表 |
| `hosts[].identityFile` | — | 私钥路径。**只支持私钥，不存密码** |
| `timeoutMs` | `30000` | 单次执行的墙钟上限，上限 300000 |
| `maxListEntries` | `500` | 目录浏览单次最多回传多少条 |
| `enableTools` | `true` | 是否注册面向 Agent 的工具 |

持久化走 `ctx.configEditor.edit()`（按 Loader entry 寻址），这是唯一能稳定写到
bundle 自己 insert 出来的行的通道；`remote.settings.mutate()` 只在 editor 不可用
时兜底，两条都试、按成功回退。

## 已知限制

- 远端目录浏览需要 **GNU findutils**（`find -printf` 是 GNU 扩展，BSD/macOS 的
  `find` 没有）。远端不满足时会返回一条明确错误，而不是静默给空列表。
- `ssh_read_file` 只适合文本文件；二进制文件会被当 UTF-8 解码而损坏。
- 超时会 `SIGKILL` 掉本地 `ssh` 进程，但 Windows 上这不一定能连带到远端进程。
- `find -printf` 的字段顺序是刻意把**路径放在最前**的：文件名里合法地可以含制表符，
  路径在前时只取记录里最后三个字段当类型/大小/时间，剩下的拼回来就是完整路径。

## 诊断

`internal.lastBoot` 会写两条自述，存在即有价值：

- `phase: 'enter'` —— `apply()` 被调用了
- `phase: 'ready'` —— 装配走完

此前另一个插件因为没有任何可观测出口，"没被调用 / 抛错了 / 定时器没跑 / 扫描没结束"
四种故障从外面看一模一样，只能靠外部 CPU 采样和姊妹插件对照去猜，白费了好几轮重启。
这个插件从一开始就把这个能力做进去。
