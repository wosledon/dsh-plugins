---
name: scheduled-tasks
description: 把一句自然语言需求变成定时任务：确认时间与内容后调用 scheduled_task_create（支持 every/daily/weekly/cron/once）。
---

# 定时任务（scheduled-tasks）

本 skill 教你如何把用户的一句自然语言需求，变成一次 `scheduled_task_create` 调用。
任务到点后会由「定时任务」插件自动唤醒一个新的大模型会话执行 `prompt`，**运行时无人值守、不与用户对话**。

> 本文件是宿主用 `ctx.skills.register(...)` 编程式注册的那份 skill 正文的可读备份
> （见 `lib/skill.js`）；改动其一必须同步另一份。

## 行为约定（必须遵守）

1. **先确认，再创建**：先从用户的话里抽出两个要素 —— 触发时间、要做什么。
   如果任一要素缺失或含糊（例如"定期提醒我"、"帮我盯着点"），必须先追问，不要猜。
2. **复述确认**：把理解写成一句自然语言回给用户，例如
   「确认一下：**每天 09:00** 自动总结**前一天的 git 提交**，对吗？」
   用户确认后，才调用 `scheduled_task_create`。
3. **prompt 要自包含**：把范围、目标、输出要求写进 `prompt`。运行时模型不能反问用户，
   所以不要写"你懂的""按上次那样"这类依赖上下文的指代。
4. **回执**：创建成功后，把工具返回的 `task.scheduleText`（中文时间描述）和下次运行时间告诉用户。
5. 修改 / 删除 / 立即运行前，先用 `scheduled_task_list` 取到准确 `id`；删除前先向用户复述要删除的任务标题。

## 五种 schedule（判别式对象，`kind` 是判别键）

`every` —— 固定间隔（`everyMinutes` 取 30..43200，即 30 分钟到 30 天）：

```json
{ "kind": "every", "everyMinutes": 120 }
```

（"每隔 2 小时检查一次构建状态"）

`daily` —— 每天本地时间 `HH:mm`（24 小时制，必须两位数字）：

```json
{ "kind": "daily", "time": "09:00" }
```

（"每天早上 9 点帮我总结昨天的 git 提交"）

`weekly` —— 每周指定星期的本地时间；`weekdays` 用 1..7，**周一=1、周日=7**，升序去重：

```json
{ "kind": "weekly", "time": "10:00", "weekdays": [1, 3, 5] }
```

（"每周一三五上午 10 点汇总工单"）

`cron` —— 标准五段 Vixie 表达式 `minute hour day-of-month month day-of-week`：

```json
{ "kind": "cron", "expression": "*/30 9-18 * * 1-5" }
```

（"工作日 9 点到 18 点之间每 30 分钟看一次"）

`once` —— 只触发一次的时间点，`at` 是 epoch 毫秒（**必须是未来时间**）：

```json
{ "kind": "once", "at": 1767225600000 }
```

（"明天早上 8 点跑一次发布检查" —— 先把用户说的本地时间换算成 epoch 毫秒再传）

### cron 方言限制（超出范围会被拒绝，必须改写或改用 daily/weekly/every）

- 只接受**五段**：`分 时 日 月 周`；写六段（带秒/年）会被拒绝。
- 每段支持：`*`、单值（`5`）、区间（`1-5`）、步长（`*/15`、`1-5/2`）、逗号列表（`1,15,30`）。
- 星期段里 `0` 和 `7` 都表示周日；`1` 表示周一。
- **不支持**：`L`、`W`、`#`、英文月份/星期名（`JAN`、`MON`）、`@daily`/`@hourly` 之类的宏。
- **不支持**越界值、倒置区间（`5-1`）、步长为 0（`*/0`）。
- 表达式一律按宿主**本地时区**解释。

## 调用示例

用户：「每天早上 9 点帮我总结昨天的 git 提交」

1. 先确认：「确认一下：每天 09:00，内容是总结前一天的 git 提交，对吗？」
2. 用户确认后：

```json
{
  "title": "每日 git 提交总结",
  "prompt": "总结当前仓库前一天的 git 提交：用 git log 查看昨天 00:00 到今天 00:00 的提交，按作者与主题分组，列出关键改动与风险点，用一段话总结。",
  "schedule": { "kind": "daily", "time": "09:00" },
  "enabled": true
}
```

3. 工具返回 `{ ok: true, task: { id, scheduleText, nextRunAt, ... } }`；把结果告诉用户。
   若返回 `{ ok: false, code, message }`，按 `message` 修正参数后重试，不要重复提交同样的参数。

## 其它可选字段

- `skill`：运行前要求模型加载的 skill 名（kebab-case）。
- `tools`：限制该次运行可用工具的白名单数组。
- `workspaceRoot`：该次运行的 cwd（绝对路径）。
- `model`：`{ provider, model }`，覆盖该次运行使用的模型。
- `enabled`：设为 `false` 可先保存不触发。

## 相关工具

- `scheduled_task_list`：列出全部任务（拿 id、可读时间、下次运行、上次状态）。
- `scheduled_task_update`：只改传入的字段。
- `scheduled_task_delete`：删除任务。
- `scheduled_task_run`：立即手动跑一次（不影响定时计划）。
