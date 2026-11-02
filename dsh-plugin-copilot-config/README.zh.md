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
| `.github/chatmodes/*.chatmode.md` | 聊天模式 | frontmatter 里的 `description`、`mode` |
| `.github/agents/*.agent.md` | 自定义代理 | frontmatter 里的 `description` |
| `.github/` 下其他 `*.md` | 其他 | 一并列出，不隐藏 |

frontmatter 只按扁平 `key: value` 解析——`name`、`description`、`applyTo`、
`mode`——不做 YAML 求值。标题依次回退：frontmatter `name` → 第一个标题 → 文件名。

## 出现在哪里

左侧栏 **Copilot 配置** 面板按类型分组列出文件。选中一个会渲染它（标题、列表、
代码块、引用、行内代码），并给出 **文件链接** 区。所有相对链接都会相对于所在文件
解析，转换成 `dsh-resource://file/session/<id>/<path>` 地址，点击就在右侧栏的
Document preview 里打开——和 Files tab 用的是同一个面板。代码块里的链接不会被
当成链接，外部链接在新窗口打开。

## agent 怎么读

两条入口，同一份数据：

- `copilot_config` 工具：`action: "list"`、`action: "read"` 加仓库相对 `path`；
- 每个 Session 一条提示词段：来自项目自己的 `copilot-instructions.md`，加上其他
  文件的索引（含 `applyTo` 作用域），上限 16 KiB。

两者都走同一个 scanner：通过 `ctx.fs` 遍历 `.github`，硬上限为 300 个文件、深度
4、单文件 256 KiB、单目录 500 项。没有 `.github` 是正常状态——面板显示空状态，
提示词段干脆不出现。

## 要求与安全

- 只读 Session 的工作目录（没有 Session 时读宿主默认目录），不会走出该目录，
  也不会写入。
- Web UI 通过同源、带 token 的路由读取（`/plugin-copilot-config/api/*`）；
  token 每进程一个，只交给本地页面。
- 零依赖：宿主侧是普通 ESM，客户端是普通模块。

## 已知限制

- 本插件读的是**本地**项目；远端项目请配合 `dsh-plugin-remote-dsh`。
- `AGENTS.md` / `CLAUDE.md` 已由 `dsh-agent-instructions` 处理，这里不重复。
- 不支持引用式链接（`[text][ref]`）和链接标题。
- 每个 Session 的提示词段在 agent 创建时加载一次；改完配置文件后新建 Session
  （或直接调工具）即可看到变化。

## 验证

```text
node scripts/verify-contract.mjs
# verify-contract: 150 assertions passed
```

覆盖分类、frontmatter、标题推导、链接解析与 `dsh-resource://` 地址、markdown
块/行内解析（含代码块）、内存文件系统上的 scanner、HTTP API 的 token 与路由契约、
工具的参数/输出/执行、通过假上下文验证宿主接线（工具、静态段、按 Session 段、
路由），以及客户端模块的静态契约。

针对 desktop profile 的在线检查：

- `GET /plugin-copilot-config/api/bootstrap` → 200 返回 token；不带 token → 401。
- 用一个带 `.github` 夹具的真实 Session：`config` 报告 `present: true`，两个文件
  分类正确、`applyTo` 解析正确；`file` 返回块和两个已解析链接（含右侧栏地址），
  代码块里的链接被正确排除。验证后已删除夹具。
- `Tool.listTools` 里能看到 `copilot_config` 及其参数。
- React 渲染冒烟测试走通：列表 → 选择 → 渲染 markdown → 文件链接 → 右侧栏打开。

## 文件

```text
index.js               宿主入口：工具、提示词段、API 路由
lib/copilot.js         纯函数：分类、frontmatter、markdown、链接、地址
lib/scan.js            ctx.fs scanner 与提示词渲染
lib/server.js          token 保护的本地 API
lib/tool.js            copilot_config 工具定义
client.js              侧栏面板 + 配置页 + markdown 渲染器
scripts/verify-contract.mjs
locale/{en,zh}.json    插件清单标题/描述
icon.svg               原创图标
README.md / README.zh.md
```
