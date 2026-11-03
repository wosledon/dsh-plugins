[English](README.md) | 中文

# dsh-plugin-copilot-config

读取项目 `.github/` 下的 GitHub Copilot 配置——也就是 VS Code Copilot 使用的那批
文件——并提供给 agent 和你自己，其中的文件链接可以直接打开。

## 读取哪些文件

| 路径 | 类型 | 说明 |
| --- | --- | --- |
| `.github/copilot-instructions.md` | 仓库指令 | 对每个该项目下的 Session 注入提示词 |
| `.github/instructions/**/*.instructions.md` | 路径指令 | frontmatter 里的 `applyTo` glob 与 `description` |
| `.github/prompts/*.prompt.md` | 可复用提示词 | frontmatter 里的 `mode`、`description` |
| `.github/skills/*/SKILL.md` | 代理技能 | frontmatter 里的 `name`、`description` |
| `.github/chatmodes/*.chatmode.md` | 聊天模式 | frontmatter 里的 `description`、`mode` |
| `.github/agents/*.agent.md` | 自定义代理 | frontmatter 里的 `description` |
| `.github/` 下其他 `*.md` | 其他 | 一并列出，不隐藏 |

frontmatter 只按扁平 `key: value` 解析——`name`、`description`、`applyTo`、
`mode`——不做 YAML 求值。标题依次回退：frontmatter `name` → 第一个标题 → 文件名。

代理技能自带的资源（`scripts/`、`references/`、`assets/`、`templates/`、许可证）
本身不是 Copilot 配置，所以扫描保留 `SKILL.md` 条目，跳过技能目录里的其余文件。

## 出现在哪里

每个 Session 在**右侧栏**里有一个 **Copilot 配置** 标签页——和 Files、Document
preview 共用同一列。从右侧栏的 guide（加号控件会列出 **Copilot 配置** 入口）打开，
或在 设置 → 快捷键 里绑定 `copilot-config.open`；左侧菜单里没有入口。标签页按类型
分组列出文件，选中一个会渲染它（标题、列表、代码块、引用、行内代码），并给出
**文件链接** 区。所有相对链接都会相对于所在文件解析，转换成
`dsh-resource://file/session/<id>/<path>` 地址，点击就在右侧栏的 Document preview
里打开——和 Files tab 用的是同一个面板。代码块里的链接不会被当成链接，外部链接在
新窗口打开。可引入的条目带 `/name` 徽标。

## 用 `/` 把条目引入对话

在输入框里敲 `/`，菜单会在内置指令和技能旁边列出项目的 **Copilot 技能**
（提示词文件和代理技能）和 **Copilot 代理**（聊天模式和自定义代理）。输入的
关键字会同时匹配名称、标题和描述。

选中一个会插入一枚 `/​<name>`  chip：`.github/prompts/review.prompt.md` 是
`/review`，`.github/chatmodes/plan.chatmode.md` 是 `/plan`，
`.github/skills/webapp-testing/SKILL.md` 是 `/webapp-testing`。名称优先取
frontmatter 的 `name`，否则取去掉 `.prompt.md` / `.chatmode.md` / `.agent.md`
后缀的文件名（技能取所在目录名）。点击这枚 chip 就在右侧栏打开对应文件。

发送时，chip 会展开成该文件自己的内容：

```text
<copilot_skill name="review" path=".github/prompts/review.prompt.md">
# Review prompt

Summarize the diff and list risks.
</copilot_skill>
```

模型因此直接读到交给它的指令，不用去猜路径。聊天模式和自定义代理用同样的形状，
只是标签换成 `copilot_agent`。发出去的消息会把这段内容渲染回 chip，点击仍能打开
原文件。正文超过 64 KiB 会被截断，并带上一个可见标记，说明剩下的部分用哪个工具读。

用户手打的 `/name` 是同一件事的纯文本形式：下面的提示词段会告诉模型它指向哪个文件。

## agent 怎么读

三条入口，同一份数据：

- `copilot_config` 工具：`action: "list"`、`action: "read"` 加仓库相对 `path`；
  `list` 同时返回可引入条目的目录；
- 每个 Session 一条提示词段：来自项目自己的 `copilot-instructions.md`，加上其他
  文件的索引（含 `applyTo` 作用域）和可用 `/` 引入的条目索引，上限 16 KiB；
- `/` 选中后写进消息的引用块。

三条入口走的是同一个 scanner：通过 `ctx.fs` 遍历 `.github`，硬上限为 300 个文件、深度
4、单文件 256 KiB、单目录 500 项。没有 `.github` 是正常状态——标签页显示空状态，
`/` 菜单没有条目，提示词段干脆不出现。

## 要求与安全

- 只读 Session 的工作目录（没有 Session 时读宿主默认目录），不会走出该目录，
  也不会写入。
- Web UI 通过同源、带 token 的路由读取（`/plugin-copilot-config/api/*`）；
  token 每进程一个，只交给本地页面。
- 引用里带着选中它的 Session，所以发送时读到的还是菜单当时读的那份 `.github`。
  读取失败会让发送停下来并说明原因，不会退化成只发一个光秃秃的 `/name`。
- 零依赖：宿主侧是普通 ESM，客户端是普通模块。

## 已知限制

- 本插件读的是**本地**项目；远端项目请配合 `dsh-plugin-remote-dsh`。
- `AGENTS.md` / `CLAUDE.md` 已由 `dsh-agent-instructions` 处理，这里不重复。
- 不支持引用式链接（`[text][ref]`）和链接标题。
- 每个 Session 的提示词段在 agent 创建时加载一次；改完配置文件后新建 Session
  （或直接调工具）即可看到变化。
- 两个条目可能推出同一个 `/name`（比如一个提示词和一个聊天模式都叫 `review`）。
  菜单会同时列出两行，每枚 chip 也各带自己的路径，但复制 chip 得到的剪贴板文本
  只有名字。
- 手打的 `/name` 不会在输入框里被装饰成 chip：只有选中才会插入引用，所以手输
  的名字不会意外变成引用。

## 验证

```text
node scripts/verify-contract.mjs
# verify-contract: 344 assertions passed
```

覆盖分类（含代理技能及其资源目录）、frontmatter、标题与引入名推导、引用块构建、
链接解析与 `dsh-resource://` 地址、markdown 块/行内解析（含代码块）、内存文件
系统上的 scanner 与可引入目录、HTTP API 的 token 与路由契约（含 `catalog`）、
工具的参数/输出/执行、通过假上下文验证宿主接线（工具、静态段、按 Session 段、
路由），以及客户端模块——静态契约、纯引用辅助函数、打桩 API 上的 `/` 源（候选、
排序、选中、序列化、右侧栏打开、缓存失效）、对宿主生成的引用块的解析规则，以及
通过假上下文验证的运行时接线（标签页类型、guide 入口、快捷键、标签页 body、`/`
源、chip 插槽）和标签页 body 的渲染。

针对 desktop profile 的在线检查：

- `GET /plugin-copilot-config/api/bootstrap` → 200 返回 token；不带 token → 401。
- 用一个带 `.github` 夹具的真实 Session：`config` 报告 `present: true`，两个文件
  分类正确、`applyTo` 解析正确；`file` 返回块和两个已解析链接（含右侧栏地址），
  代码块里的链接被正确排除。验证后已删除夹具。
- `Tool.listTools` 里能看到 `copilot_config` 及其参数。
- React 渲染冒烟测试走通标签页 body：挂载 → 读取配置 → 分组列表 → 选择 → 渲染
  markdown → 文件链接 → 右侧栏打开，每次读取都带着标签页所在 Session。

## 文件

```text
index.js               宿主入口：工具、提示词段、API 路由
lib/copilot.js         纯函数：分类、frontmatter、markdown、链接、地址、引用块
lib/scan.js            ctx.fs scanner、可引入目录与提示词渲染
lib/server.js          token 保护的本地 API
lib/tool.js            copilot_config 工具定义
client.js              右侧栏标签页 + markdown 渲染器 + `/` 引用
scripts/verify-contract.mjs
locale/{en,zh}.json    插件清单标题/描述
icon.svg               原创图标
README.md / README.zh.md
```
