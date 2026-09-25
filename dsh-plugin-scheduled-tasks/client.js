/**
 * 「定时任务」——浏览器半（无构建步骤的纯 JS，与 dsh-plugin-reasoning-effort 同风格）。
 *
 * 职责（CONTRACT.md §5）：
 *   - 在 `sidebar.panellist` 登记一个按钮（id = PANEL_ID），在 `main` 登记同 key 的整页；
 *   - 整页 = 任务列表 + 新建表单 + 立即运行 / 启停 / 删除 + 运行日志；
 *   - 显式提示用户「可以直接在对话里描述需求创建任务」（模型工具那半在宿主侧）。
 *
 * 数据通道只有一条：`ctx.remote.settings.describe()` / `mutate(ns, ops, revision)`，
 * ns 固定 'scheduled-tasks'。客户端不 import 任何宿主包（没有构建步骤，无法解析
 * 宿主包名，也不需要），所以时间描述与 nextRunAt 的计算在本文件里自带一份小实现。
 *
 * 写入粒度是**整个 tasks 数组**：设置文档的路径编辑不会下钻数组元素，逐元素写
 * `['tasks','0',...]` 会把数组打散成对象键，所以必须整段回写、其它字段原样保留。
 *
 * 两个关键约束（照宿主实现核对过，不是猜的）：
 *   1. `lib/model.js` 的 `isTaskDue()` 对 every/daily/weekly/cron 只看 `nextRunAt`，
 *      而宿主的 `prime()`（补排期）只在进程启动时跑一次 —— 所以**界面新建/重新启用
 *      的任务必须自己带上 nextRunAt**，否则它永远不会被判定为到期（once 例外，
 *      它按自身 `at` 判定）。
 *   2. 浏览器半无法创建 Agent，「立即运行」只能把意图写成
 *      `internal.manualRuns: [{ taskId, requestedAt }]`；宿主的调度器在下一次 tick
 *      消费并清空该队列（见 lib/scheduler.js drainManualRuns）。`internal.log` 由
 *      宿主写，客户端**只读**。
 *
 * 工厂无副作用：样式、locale、slot 注册一律在 apply 内建立，并用 ctx.effect 收尾。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-scheduled-tasks',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** 文案命名空间；与包名分开，避免和宿主命名空间撞车。 */
    const LOCALE_NS = 'plugin.scheduled-tasks';
    /** 面板 id：`sidebar.panellist` 的 id 与 `main` 的 key 必须一致，owner 才配得上对。 */
    const PANEL_ID = 'scheduled-tasks';
    /** 设置命名空间，等于本插件 Loader 行 id。 */
    const CONFIG_NS = 'scheduled-tasks';
    /** 界面最多展示多少条日志。 */
    /** 单个任务展开时最多列几条运行记录（不铺满页面）。 */
    const LOG_VIEW_LIMIT = 60;
    /** 每一页的条数：任务与运行日志各 20 条，一屏基本能看完，翻页不累。 */
    const PAGE_SIZE = 20;
    /** 契约 §2.2：every 的合法区间。 */
    const EVERY_MIN = 30;
    const EVERY_MAX = 43200;
    /** 「立即运行」请求的过期时间，与宿主 drainManualRuns 保持一致。 */
    const MANUAL_RUN_TTL = 300000;

    /* ---------------------------------------------------------------- */
    /* 文案                                                              */
    /* ---------------------------------------------------------------- */

    const zh = {
      panelLabel: '定时任务',
      title: '定时任务',
      hint: '到点后插件会新开一个会话，让大模型按提示词执行任务；每次运行的记录写进下方日志。',
      converseHint: '也可以直接在对话里描述需求来创建任务，例如：「每天早上 9 点帮我总结昨天的 git 提交」。',
      newTask: '新建任务',
      editTask: '编辑',
      formTitleNew: '新建任务',
      formTitleEdit: '编辑任务',
      cancel: '取消',
      create: '创建',
      creating: '创建中…',
      save: '保存',
      saving: '保存中…',
      fieldTitle: '标题',
      fieldPrompt: '提示词（发给大模型的任务指令）',
      fieldSkill: '技能名（可选）',
      fieldWorkspaceRoot: '工作目录（可选）',
      workspaceRootPlaceholder: '例如 D:\\projects\\my-repo，留空用默认工作区',
      fieldModel: '大模型（可选）',
      modelDefault: '跟随默认模型',
      fieldModelName: '模型',
      fieldReasoningEffort: '推理强度',
      reasoningDefault: '模型默认',
      modelStale: '此前选择的 {id} 已不在可用目录里，请重新选择。',
      fieldSchedule: '触发时间',
      titlePlaceholder: '每日 git 提交总结',
      promptPlaceholder: '总结当前仓库前一天的 git 提交：按作者与主题分组，列出关键改动与风险点。',
      skillPlaceholder: '例如 git-review（留空表示不使用技能）',
      kindEvery: '固定间隔',
      kindDaily: '每天',
      kindWeekly: '每周',
      kindCron: 'cron 表达式',
      kindOnce: '一次性',
      everyMinutes: '间隔（分钟，30–43200）',
      time: '时间（HH:mm）',
      weekdays: '星期',
      cronExpr: '表达式（分 时 日 月 周）',
      onceAt: '执行时刻（本地时间）',
      weekday1: '一', weekday2: '二', weekday3: '三', weekday4: '四',
      weekday5: '五', weekday6: '六', weekday7: '日',
      everyText: '每 {n} 分钟',
      dailyText: '每天 {time}',
      weeklyText: '每周{days} {time}',
      cronText: 'cron {expr}',
      onceText: '一次性 {time}',
      running: '运行中',
      statusOk: '成功',
      statusError: '失败',
      statusTimeout: '超时',
      statusSkipped: '跳过',
      statusRunning: '运行中',
      enable: '启用',
      disable: '停用',
      runNow: '立即运行',
      runningNow: '提交中…',
      runRequested: '已请求立即运行：宿主的调度器会在下一次检查（默认 30 秒内）执行，进度看下方日志。',
      remove: '删除',
      confirmRemove: '确定删除任务「{title}」吗？已产生的运行日志会保留。',
      nextRun: '下次运行',
      lastRun: '上次运行',
      never: '尚未运行',
      notScheduled: '未排定',
      noTasks: '还没有任务。点「新建任务」，或者直接在对话里说出你的需求。',
      runHistory: '运行记录',
      tasksTitle: '任务列表',
      logsTitle: '运行日志',
      tabTasks: '任务',
      tabLogs: '运行日志',
      prevPage: '上一页',
      nextPage: '下一页',
      pagerInfo: '第 {from}–{to} 条，共 {total} 条',
      logsHint: '按时间倒序。宿主只保留最近若干条记录，更早的已被滚掉。',
      records: '条记录',
      noLogs: '还没有任何运行记录。',
      noRunsForTask: '这个任务还没有运行过。点「立即运行」试一次，或等它到点自动运行。',
      toolCalls: '次工具调用',
      loading: '加载中…',
      empty: '（无摘要）',
      unavailable: '设置文档里还没有本插件的条目：插件可能尚未生效，或还没有写入任何配置。',
      errLoad: '读取设置失败',
      errWrite: '写入设置失败',
      errNoApi: '远程设置接口不可用，定时任务面板暂时不可用。',
      errTitleRequired: '请填写标题（最多 120 字）。',
      errPromptRequired: '请填写提示词（最多 20000 字）。',
      errTimeFormat: '时间格式必须是 HH:mm，例如 09:00。',
      errCronRequired: '请填写 cron 表达式。',
      errCronFormat: 'cron 表达式不合法：只支持五段（分 时 日 月 周），每段可用 *、单值、a-b、*/n、a-b/n 或逗号列表；不支持 L、W、#、英文名、@ 宏与六段。',
      errEveryRange: '间隔必须是 30 到 43200 之间的整数分钟。',
      errWeekdayRequired: '请至少选择一个星期。',
      errOnceFuture: '执行时刻必须在未来。',
      conflict: '设置已被其他改动推进，已重新读取，请重试。',
      triggerSchedule: '定时',
      triggerManual: '手动',
      readOnly: '当前设置文档只读，无法保存任务。',
      taskCount: '{n} 个任务',
      refresh: '刷新',
    };

    const en = {
      panelLabel: 'Scheduled tasks',
      title: 'Scheduled tasks',
      hint: 'At the scheduled time the plugin opens a fresh session and has the model run your prompt. Every run is recorded in the log below.',
      converseHint: 'You can also just describe it in chat, e.g. "every day at 9am summarize yesterday\'s git commits".',
      newTask: 'New task',
      editTask: 'Edit',
      formTitleNew: 'New task',
      formTitleEdit: 'Edit task',
      cancel: 'Cancel',
      create: 'Create',
      creating: 'Creating…',
      save: 'Save',
      saving: 'Saving…',
      fieldTitle: 'Title',
      fieldPrompt: 'Prompt (the instruction sent to the model)',
      fieldSkill: 'Skill name (optional)',
      fieldWorkspaceRoot: 'Working directory (optional)',
      workspaceRootPlaceholder: 'e.g. D:\\projects\\my-repo; blank uses the default workspace',
      fieldModel: 'Model (optional)',
      modelDefault: 'Follow the default model',
      fieldModelName: 'Model',
      fieldReasoningEffort: 'Reasoning effort',
      reasoningDefault: 'Model default',
      modelStale: 'The previously selected {id} is no longer available; please pick another.',
      fieldSchedule: 'Schedule',
      titlePlaceholder: 'Daily git summary',
      promptPlaceholder: 'Summarize yesterday\'s git commits: group by author and topic, list key changes and risks.',
      skillPlaceholder: 'e.g. git-review (blank for none)',
      kindEvery: 'Fixed interval',
      kindDaily: 'Daily',
      kindWeekly: 'Weekly',
      kindCron: 'Cron expression',
      kindOnce: 'One-shot',
      everyMinutes: 'Interval (minutes, 30–43200)',
      time: 'Time (HH:mm)',
      weekdays: 'Weekdays',
      cronExpr: 'Expression (min hour dom month dow)',
      onceAt: 'Run at (local time)',
      weekday1: 'Mon', weekday2: 'Tue', weekday3: 'Wed', weekday4: 'Thu',
      weekday5: 'Fri', weekday6: 'Sat', weekday7: 'Sun',
      everyText: 'every {n} minutes',
      dailyText: 'daily at {time}',
      weeklyText: 'every {days} at {time}',
      cronText: 'cron {expr}',
      onceText: 'once at {time}',
      running: 'Running',
      statusOk: 'Succeeded',
      statusError: 'Failed',
      statusTimeout: 'Timed out',
      statusSkipped: 'Skipped',
      statusRunning: 'Running',
      enable: 'Enable',
      disable: 'Disable',
      runNow: 'Run now',
      runningNow: 'Requesting…',
      runRequested: 'Run requested: the scheduler picks it up on its next check (30 seconds by default); progress appears in the log below.',
      remove: 'Delete',
      confirmRemove: 'Delete task "{title}"? Its run log is kept.',
      nextRun: 'Next run',
      lastRun: 'Last run',
      never: 'never',
      notScheduled: 'not scheduled',
      noTasks: 'No tasks yet. Click "New task", or just describe what you want in chat.',
      tasksTitle: 'Tasks',
      runHistory: 'Run history',
      logsTitle: 'Run log',
      tabTasks: 'Tasks',
      tabLogs: 'Run log',
      prevPage: 'Previous',
      nextPage: 'Next',
      pagerInfo: '{from}–{to} of {total}',
      logsHint: 'Newest first. The host keeps only the most recent records; older ones are rolled off.',
      records: 'record(s)',
      noLogs: 'No runs recorded yet.',
      noRunsForTask: 'This task has not run yet. Use "Run now" to try it, or wait for its next scheduled run.',
      toolCalls: 'tool call(s)',
      loading: 'Loading…',
      empty: '(no summary)',
      unavailable: 'The settings document has no entry for this plugin yet: it may not be active, or nothing has been written to its config.',
      errLoad: 'Could not read settings',
      errWrite: 'Could not write settings',
      errNoApi: 'The remote settings API is unavailable, so this panel stays inert.',
      errTitleRequired: 'Please enter a title (at most 120 characters).',
      errPromptRequired: 'Please enter a prompt (at most 20000 characters).',
      errTimeFormat: 'Time must be HH:mm, e.g. 09:00.',
      errCronRequired: 'Please enter a cron expression.',
      errCronFormat: 'Invalid cron expression: exactly five fields (minute hour day-of-month month day-of-week); each field accepts *, a value, a-b, */n, a-b/n and comma lists; L, W, #, English names, @ macros and six fields are rejected.',
      errEveryRange: 'The interval must be an integer between 30 and 43200 minutes.',
      errWeekdayRequired: 'Please pick at least one weekday.',
      errOnceFuture: 'The run time must be in the future.',
      conflict: 'Settings moved on; they were re-read, please retry.',
      triggerSchedule: 'scheduled',
      triggerManual: 'manual',
      readOnly: 'The settings document is read-only, so tasks cannot be saved.',
      taskCount: '{n} task(s)',
      refresh: 'Refresh',
    };

    /* ---------------------------------------------------------------- */
    /* 样式（只用 --dsw-alias-* 主题令牌；类名统一 stp- 前缀）              */
    /* ---------------------------------------------------------------- */

    /**
     * 布局约定（每条都对应一次真实的错位，改前先读）：
     *
     * 1. **不做卡中卡**。宿主的管理类页面是「一条细分隔线切分的平面列表」；
     *    每一行都加边框 + 底色会立刻显碎。
     * 2. **行内用 grid 而不是 flex**。flex 的 `flex:1` 会让"谁被推到右边"取决于
     *    兄弟元素宽度，元素一多就散。日志行曾复用带 `flex:1` 的标题类，
     *    结果把触发徽标与时间戳顶到最右侧、中间留一大片空白。
     * 3. **不写 `height:100%`**。主区域高度归外壳管，插件再声明一次就会和外层
     *    滚动容器打架（双滚动条或高度塌陷）。用 `min-height:100%` 且不自建滚动。
     * 4. 文案一律 `text-overflow:ellipsis` 截断，不用 `word-break:break-all`——
     *    中文逐字换行会把一行变成一列。
     * 5. 最大宽度 980px：全屏下主区域很宽，不约束会把行内元素拉散。
     */
    const CSS = [
      '.stp-root{display:flex;flex-direction:column;gap:16px;min-height:100%;box-sizing:border-box;padding:20px 24px 36px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
      '.stp-root *{box-sizing:border-box}',
      '.stp-inner{display:flex;flex-direction:column;gap:16px;width:100%;max-width:980px}',

      /* 头部：标题块 + 右侧操作区 */
      '.stp-head{display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap}',
      '.stp-headText{display:flex;flex-direction:column;gap:4px;flex:1 1 320px;min-width:0}',
      '.stp-title{font-size:16px;font-weight:600;line-height:24px}',
      '.stp-hint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;max-width:68ch}',
      '.stp-headActions{display:flex;align-items:center;gap:8px;flex:0 0 auto}',

      /* 按钮 */
      '.stp-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap}',
      '.stp-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}',
      '.stp-btn:focus-visible{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.stp-btn[data-primary="true"]{border-color:transparent;background:var(--dsw-alias-brand-primary);color:#fff}',
      '.stp-btn[data-primary="true"]:hover:not(:disabled){opacity:.9;background:var(--dsw-alias-brand-primary)}',
      '.stp-btn[data-danger="true"]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-border-l2)}',
      '.stp-btn:disabled{cursor:default;opacity:.45}',

      /* 提示条：一行说明，不用卡片感 */
      '.stp-note-bar{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.stp-note-bar b{color:var(--dsw-alias-label-primary);font-weight:500}',

      /* 分区标题 */
      '.stp-section{display:flex;flex-direction:column;gap:0}',
      '.stp-sectionHead{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-bottom:8px}',
      '.stp-sectionTitle{font-size:13px;font-weight:600;line-height:20px}',
      '.stp-count{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',

      /* 页内 tab：下划线式，与宿主设置面板同类手法。
         任务（配置）与运行日志（流水）分开，避免流水把配置挤下去。 */
      '.stp-tabs{display:flex;align-items:center;gap:20px;border-bottom:.5px solid var(--dsw-alias-border-l1)}',
      '.stp-tab{position:relative;padding:0 0 8px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;cursor:pointer}',
      '.stp-tab:hover{color:var(--dsw-alias-label-primary)}',
      '.stp-tab:focus-visible{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.stp-tab[aria-selected="true"]{color:var(--dsw-alias-label-primary);font-weight:500}',
      '.stp-tab[aria-selected="true"]::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;background:var(--dsw-alias-brand-primary);border-radius:1px}',
      '.stp-tabCount{color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:400}',

      /* 布尔开关：独立成行的一个小控件，不占字段网格的一格 */
      '.stp-check{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap}',
      '.stp-check input{margin:0}',
      /* 分页 */
      '.stp-pager{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:12px;flex-wrap:wrap}',
      '.stp-pagerInfo{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.stp-pagerBtns{display:flex;align-items:center;gap:6px}',
      '.stp-pageNo{min-width:44px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:28px}',

      /* 列表：平面 + 细分隔线 */
      '.stp-list{display:flex;flex-direction:column;border-top:.5px solid var(--dsw-alias-border-l1)}',
      '.stp-item{padding:12px 2px;border-bottom:.5px solid var(--dsw-alias-border-l1)}',
      '.stp-item[data-off="true"] .stp-itemMain{opacity:.55}',
      /* 运行记录入口：低调的文字按钮，不与右侧三个操作抢视觉重量 */
      '.stp-itemFoot{display:flex;align-items:center;padding-top:6px}',
      '.stp-linkBtn{padding:0;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}',
      '.stp-linkBtn:hover{color:var(--dsw-alias-label-primary)}',
      '.stp-linkBtn:focus-visible{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      /* 展开区：浅底 + 左缩进，明确属于上面那张任务，而不是又一个同级区块 */
      '.stp-history{margin-top:8px;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-1)}',
      '.stp-historyEmpty{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',

      /* 行内网格：左侧内容自适应，右侧操作固定列 → 任何宽度都对得齐 */
      '.stp-itemGrid{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:start}',
      '.stp-itemMain{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.stp-itemSide{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}',
      '.stp-itemTitleRow{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}',
      '.stp-itemTitle{font-size:13px;font-weight:500;line-height:20px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}',
      '.stp-sched{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.stp-prompt{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',

      /* 元信息：用分隔点，不用散落的 flex 子项 */
      '.stp-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;min-width:0}',
      '.stp-metaItem{white-space:nowrap}',
      '.stp-metaDot{color:var(--dsw-alias-border-l2)}',

      /* 徽标 */
      '.stp-badge{display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:5px;border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1;white-space:nowrap}',
      '.stp-badge[data-status="ok"]{color:var(--dsw-alias-state-success-primary);border-color:currentColor}',
      '.stp-badge[data-status="error"]{color:var(--dsw-alias-state-error-primary);border-color:currentColor}',
      '.stp-badge[data-status="timeout"]{color:var(--dsw-alias-state-warn-primary);border-color:currentColor}',
      '.stp-badge[data-status="running"]{color:var(--dsw-alias-brand-primary);border-color:currentColor}',
      '.stp-badge[data-status="skipped"]{color:var(--dsw-alias-label-secondary)}',
      '.stp-badgePlain{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l1)}',

      /* 表单 */
      '.stp-form{display:flex;flex-direction:column;gap:12px;padding:14px;border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}',
      '.stp-formTitle{font-size:13px;font-weight:600;line-height:20px}',
      /* 表单按「语义行」分组，每行自己决定几列。
         不用 auto-fit：字段数量随 schedule 类型变化，auto-fit 会把
         「启用」复选框也摊成一个独立格子，右侧留一大片空白。 */
      '.stp-formRows{display:flex;flex-direction:column;gap:12px}',
      '.stp-formRow{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}',
      '.stp-formRow[data-cols="1"]{grid-template-columns:minmax(0,1fr)}',
      '.stp-formRow[data-cols="3"]{grid-template-columns:repeat(3,minmax(0,1fr))}',
      '.stp-field{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.stp-label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.stp-input,.stp-textarea,.stp-select{width:100%;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;padding:5px 8px}',
      '.stp-input,.stp-select{height:30px;padding:0 8px}',
      '.stp-input:focus-visible,.stp-textarea:focus-visible,.stp-select:focus-visible{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:-1px}',
      '.stp-textarea{min-height:84px;resize:vertical;font-family:inherit}',
      '.stp-days{display:flex;gap:6px;flex-wrap:wrap}',
      '.stp-day{min-width:34px;height:28px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;cursor:pointer}',
      '.stp-day[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);font-weight:500}',
      '.stp-formActions{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding-top:2px}',

      /* 状态文案 */
      '.stp-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;word-break:break-word}',
      '.stp-note{color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:18px}',
      '.stp-warn{color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:18px}',

      /* 日志：
         主行三列固定（状态 | 内容 | 时间），展开区独占一行，
         彻底避免"徽标被推到最右、中间留白"。 */
      '.stp-logList{display:flex;flex-direction:column;border-top:.5px solid var(--dsw-alias-border-l1)}',
      '.stp-logRow{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:10px;align-items:center;padding:10px 2px;border-bottom:.5px solid var(--dsw-alias-border-l1)}',
      '.stp-logBody{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.stp-logTitle{font-size:13px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.stp-logDetail{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
      '.stp-logTime{display:flex;flex-direction:column;align-items:flex-end;gap:2px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:nowrap;text-align:right}',
      '.stp-logTools{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}',
      '.stp-logSub{grid-column:2/4;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;word-break:break-all}',
      '.stp-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px}',

      /* 空状态 */
      '.stp-empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:28px 16px;border:.5px dashed var(--dsw-alias-border-l1);border-radius:10px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;text-align:center}',

      '.stp-icon{display:block;flex:0 0 auto}',
    ].join('');

    /* ---------------------------------------------------------------- */
    /* 纯工具                                                            */
    /* ---------------------------------------------------------------- */

    function isObject(value) {
      return typeof value === 'object' && value !== null;
    }

    function isPlainObject(value) {
      return isObject(value) && !Array.isArray(value);
    }

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error);
    }

    /**
     * 把 epoch 毫秒转成 `datetime-local` 需要的本地格式 "YYYY-MM-DDTHH:mm"。
     * 直接用 `toISOString()` 是 UTC，会差一个时区，所以这里逐段取本地分量。
     */
    function toLocalStamp(ms) {
      const date = new Date(ms);
      if (!Number.isFinite(date.getTime())) return '';
      return String(date.getFullYear()) + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
        + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes());
    }

    /**
     * 从草稿里取出模型覆盖。
     * 只有 provider 与 model **都齐了**才返回对象，否则返回 null（= 跟随默认模型）——·
     * 半截配置会让 `createAgent` 拿到一个说不清的 agentOptions。
     *
     * @param {object} draft
     * @returns {{ provider: string, model: string, reasoningEffort?: string } | null}
     */
    function modelPairOf(draft) {
      if (draft.modelKey === 'default') return null;
      const text = String(draft.modelKey);
      const slash = text.indexOf('/');
      if (slash <= 0) return null;
      const provider = text.slice(0, slash);
      const model = text.slice(slash + 1);
      if (provider === '' || model === '') return null;
      const pair = { provider, model };
      const effort = String(draft.reasoningEffort).trim();
      if (effort !== '') pair.reasoningEffort = effort;
      return pair;
    }

    /** 按段取路径；数组与普通对象都能下钻，取不到返回 undefined。 */
    function getPath(root, path) {
      let node = root;
      for (const segment of path) {
        if (!isObject(node)) return undefined;
        node = node[segment];
        if (node === undefined) return undefined;
      }
      return node;
    }

    function clampText(text, limit) {
      const value = typeof text === 'string' ? text : '';
      return value.length > limit ? value.slice(0, limit - 1) + '…' : value;
    }

    /** 补零到两位。 */
    function pad(value) {
      return String(value).padStart(2, '0');
    }

    /** 本地时间字符串（界面展示用）。 */
    function formatTime(ms) {
      if (!Number.isFinite(ms)) return '—';
      const date = new Date(ms);
      return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
        + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
    }

    /** `<input type="datetime-local">` 需要的 `YYYY-MM-DDTHH:mm`。 */
    function inputStamp(ms) {
      if (!Number.isFinite(ms)) return '';
      const date = new Date(ms);
      return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
        + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes());
    }

    /** 与契约 §2.1 同形的 id，客户端自己生成。 */
    function newTaskId(nowMs) {
      let random = '';
      for (let index = 0; index < 4; index += 1) random += Math.floor(Math.random() * 36).toString(36);
      return 't' + Math.floor(nowMs).toString(36) + random;
    }

    /** 把 `{n}` 之类占位符替换掉。 */
    function fill(text, values) {
      let out = String(text);
      for (const [key, value] of Object.entries(values)) out = out.split('{' + key + '}').join(String(value));
      return out;
    }

    const WEEKDAY_KEYS = ['', 'weekday1', 'weekday2', 'weekday3', 'weekday4', 'weekday5', 'weekday6', 'weekday7'];

    /* ---- cron：客户端自带的最小实现，规则严格照契约 §2.2 ---- */

    /** 一段 cron 字段 -> { set, star }；非法返回 null。 */
    function parseCronField(text, min, max) {
      const trimmed = String(text).trim();
      const star = trimmed === '*';
      const values = new Set();
      const chunks = trimmed.split(',');
      if (chunks.length === 0) return null;
      for (const chunk of chunks) {
        if (chunk === '') return null;
        let body = chunk;
        let step = 1;
        const slash = chunk.indexOf('/');
        if (slash !== -1) {
          body = chunk.slice(0, slash);
          const stepText = chunk.slice(slash + 1);
          if (!/^\d+$/.test(stepText)) return null;
          step = Number(stepText);
          if (step <= 0) return null;
        }
        let low;
        let high;
        if (body === '*') {
          low = min;
          high = max;
        } else if (/^\d+$/.test(body)) {
          low = Number(body);
          high = low;
        } else {
          const range = /^(\d+)-(\d+)$/.exec(body);
          if (range === null) return null;
          low = Number(range[1]);
          high = Number(range[2]);
          if (low > high) return null;
        }
        if (low < min || high > max) return null;
        for (let value = low; value <= high; value += step) values.add(value);
      }
      if (values.size === 0) return null;
      return { set: values, star };
    }

    /** 五段 Vixie 表达式 -> 五个 { set, star }；非法返回 null。 */
    function parseCronFields(expression) {
      const parts = String(expression).trim().split(/\s+/);
      if (parts.length !== 5) return null;
      const bounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
      const fields = [];
      for (let index = 0; index < 5; index += 1) {
        const field = parseCronField(parts[index], bounds[index][0], bounds[index][1]);
        if (field === null) return null;
        fields.push(field);
      }
      return fields;
    }

    function sortedValues(set) {
      return Array.from(set).sort((left, right) => left - right);
    }

    /** 下一次 cron 触发（本机本地时区）；5 年内无解返回 null。 */
    function nextCronTime(fields, fromMs) {
      const minutes = sortedValues(fields[0].set);
      const hours = sortedValues(fields[1].set);
      const daysOfMonth = fields[2].set;
      const months = fields[3].set;
      const daysOfWeek = new Set();
      for (const value of fields[4].set) daysOfWeek.add(value === 7 ? 0 : value);
      const domRestricted = fields[2].star !== true;
      const dowRestricted = fields[4].star !== true;

      const cursor = new Date(fromMs);
      cursor.setHours(0, 0, 0, 0);
      const limit = fromMs + 5 * 366 * 24 * 3600 * 1000;
      while (cursor.getTime() <= limit) {
        const monthOk = months.has(cursor.getMonth() + 1);
        const domOk = daysOfMonth.has(cursor.getDate());
        const dowOk = daysOfWeek.has(cursor.getDay());
        // Vixie 语义：dom 与 dow 都被限定时，任一命中即可。
        const dayOk = domRestricted && dowRestricted
          ? (domOk || dowOk)
          : (domRestricted ? domOk : (dowRestricted ? dowOk : true));
        if (monthOk && dayOk) {
          for (const hour of hours) {
            for (const minute of minutes) {
              const candidate = new Date(cursor.getTime());
              candidate.setHours(hour, minute, 0, 0);
              if (candidate.getTime() >= fromMs) return candidate.getTime();
            }
          }
        }
        cursor.setDate(cursor.getDate() + 1);
      }
      return null;
    }

    /** 契约 §3 的 nextScheduleTime：五种 schedule 的下一次触发时间。 */
    function nextScheduleTime(schedule, fromMs) {
      if (!isPlainObject(schedule)) return null;
      if (schedule.kind === 'every') {
        const minutes = Number(schedule.everyMinutes);
        if (!Number.isFinite(minutes) || minutes <= 0) return null;
        return fromMs + minutes * 60000;
      }
      if (schedule.kind === 'daily') {
        const time = parseHHMM(schedule.time);
        if (time === null) return null;
        const cursor = new Date(fromMs);
        cursor.setHours(time.hours, time.minutes, 0, 0);
        if (cursor.getTime() < fromMs) cursor.setDate(cursor.getDate() + 1);
        return cursor.getTime();
      }
      if (schedule.kind === 'weekly') {
        const time = parseHHMM(schedule.time);
        if (time === null || !Array.isArray(schedule.weekdays) || schedule.weekdays.length === 0) return null;
        const wanted = new Set();
        for (const day of schedule.weekdays) {
          const value = Number(day);
          if (Number.isInteger(value) && value >= 1 && value <= 7) wanted.add(value === 7 ? 0 : value);
        }
        if (wanted.size === 0) return null;
        for (let offset = 0; offset < 14; offset += 1) {
          const cursor = new Date(fromMs);
          cursor.setDate(cursor.getDate() + offset);
          cursor.setHours(time.hours, time.minutes, 0, 0);
          if (!wanted.has(cursor.getDay())) continue;
          if (cursor.getTime() < fromMs) continue;
          return cursor.getTime();
        }
        return null;
      }
      if (schedule.kind === 'cron') {
        const fields = parseCronFields(schedule.expression);
        if (fields === null) return null;
        return nextCronTime(fields, fromMs);
      }
      if (schedule.kind === 'once') {
        const at = Number(schedule.at);
        if (!Number.isFinite(at) || at <= fromMs) return null;
        return at;
      }
      return null;
    }

    function parseHHMM(text) {
      const matched = /^(\d{1,2}):(\d{2})$/.exec(String(text).trim());
      if (matched === null) return null;
      const hours = Number(matched[1]);
      const minutes = Number(matched[2]);
      if (hours > 23 || minutes > 59) return null;
      return { hours, minutes };
    }

    /**
     * 给任务补上 nextRunAt。
     *
     * 宿主只在自己的 `createTask` / `updateTask`（模型工具走的路径）里调
     * `ensureNextRun`，`prime()` 又只在进程启动时跑一次；设置文档是界面直接写的，
     * 所以界面必须自己把排期写好，否则 every/daily/weekly/cron 任务永远不会到期。
     * once 由自身的 `at` 判定，但写一份 nextRunAt 也能让界面立刻显示「下次运行」。
     * @returns {object} 新任务（不改原对象）
     */
    function withNextRun(task, nowMs) {
      const next = { ...task };
      const computed = nextScheduleTime(next.schedule, nowMs);
      if (computed === null) delete next.nextRunAt;
      else next.nextRunAt = computed;
      return next;
    }

    /**
     * 时间表的本地化描述。
     * 客户端自己实现而不是复用 lib/cron.js：浏览器半不能 import 宿主模块。
     * @param {object} schedule
     * @param {(key: string) => string} t
     */
    function describeSchedule(schedule, t) {
      if (!isPlainObject(schedule)) return '—';
      if (schedule.kind === 'every') return fill(t('everyText'), { n: schedule.everyMinutes });
      if (schedule.kind === 'daily') return fill(t('dailyText'), { time: String(schedule.time) });
      if (schedule.kind === 'weekly') {
        const days = Array.isArray(schedule.weekdays) ? schedule.weekdays : [];
        const text = days
          .map((day) => (WEEKDAY_KEYS[day] === undefined ? String(day) : t(WEEKDAY_KEYS[day])))
          .join('/');
        return fill(t('weeklyText'), { days: text, time: String(schedule.time) });
      }
      if (schedule.kind === 'cron') return fill(t('cronText'), { expr: String(schedule.expression) });
      if (schedule.kind === 'once') return fill(t('onceText'), { time: formatTime(Number(schedule.at)) });
      return '—';
    }

    /** 状态 → 文案键。 */
    function statusKey(status) {
      if (status === 'ok') return 'statusOk';
      if (status === 'error') return 'statusError';
      if (status === 'timeout') return 'statusTimeout';
      if (status === 'running') return 'statusRunning';
      return 'statusSkipped';
    }

    /**
     * 渲染分页条。
     * 只有一页时返回 null——给一个只有"上一页/下一页"两个灰按钮的控件比没有更差。
     *
     * @param {{ page: number, pageCount: number, total: number, from: number, to: number,
     *          onPrev: () => void, onNext: () => void, t: (key: string) => string }} spec
     */
    function renderPager(spec) {
      if (spec.pageCount <= 1) return null;
      return h(
        'div',
        { className: 'stp-pager' },
        h(
          'div',
          { className: 'stp-pagerInfo' },
          fill(spec.t('pagerInfo'), {
            from: String(spec.from),
            to: String(spec.to),
            total: String(spec.total),
          }),
        ),
        h(
          'div',
          { className: 'stp-pagerBtns' },
          h(
            'button',
            {
              type: 'button',
              className: 'stp-btn',
              disabled: spec.page <= 0,
              onClick: spec.onPrev,
            },
            spec.t('prevPage'),
          ),
          h('span', { className: 'stp-pageNo' }, `${spec.page + 1} / ${spec.pageCount}`),
          h(
            'button',
            {
              type: 'button',
              className: 'stp-btn',
              disabled: spec.page + 1 >= spec.pageCount,
              onClick: spec.onNext,
            },
            spec.t('nextPage'),
          ),
        ),
      );
    }

    /**
     * 把 `internal.catalog` 收敛成界面能直接用的形状。
     * 全程防御：宿主可能还没写过、或只写了部分字段。任何畸形项都跳过——
     * 目录的作用是"有东西可选"，一个坏项不该让整个选择器消失。
     *
     * @param {unknown} value
     * @returns {{ id: string, name: string, models: { id: string, name: string, efforts: {id,name}[] }[] }[]}
     */
    function readProviders(value) {
      const raw = isPlainObject(value) && Array.isArray(value.providers) ? value.providers : [];
      const out = [];
      for (const provider of raw) {
        if (!isPlainObject(provider) || typeof provider.id !== 'string' || provider.id === '') continue;
        const rawModels = Array.isArray(provider.models) ? provider.models : [];
        const models = [];
        for (const model of rawModels) {
          if (!isPlainObject(model) || typeof model.id !== 'string' || model.id === '') continue;
          const efforts = [];
          const rawEfforts = Array.isArray(model.efforts) ? model.efforts : [];
          for (const effort of rawEfforts) {
            if (!isPlainObject(effort) || typeof effort.id !== 'string' || effort.id === '') continue;
            efforts.push({
              id: effort.id,
              name: typeof effort.name === 'string' && effort.name !== '' ? effort.name : effort.id,
            });
            if (efforts.length >= 8) break;
          }
          models.push({
            id: model.id,
            name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id,
            efforts,
          });
          if (models.length >= 200) break;
        }
        if (models.length === 0) continue;
        out.push({
          id: provider.id,
          name: typeof provider.displayName === 'string' && provider.displayName !== ''
            ? provider.displayName
            : provider.id,
          models,
        });
        if (out.length >= 50) break;
      }
      return out;
    }

    /**
     * 渲染一条运行记录。
     *
     * 布局是**三列固定网格**：状态 | 内容 | 时间。内容列 `minmax(0,1fr)` 保证长文本
     * 自己截断，不会把时间列顶走——旧版用 flex 并复用了带 `flex:1` 的标题类，
     * 结果徽标与时间戳被推到最右、中间留一大片空白。
     *
     * 这些记录现在挂在**各自任务**的展开区里，不再是页面底部的全局流水
     * （任务列表是配置，日志是流水，混在一页会让日志把配置挤下去）。
     *
     * @param {object} row LogRecord
     * @param {number} index 兜底 key（记录缺 seq 时）
     * @param {(key: string) => string} t
     */
    function renderLogRow(row, index, t) {
      const cells = [
        h('span', { className: 'stp-badge', 'data-status': row.status, key: 'status' }, t(statusKey(row.status))),
        h(
          'div',
          { className: 'stp-logBody' },
          h(
            'div',
            { className: 'stp-logDetail' },
            typeof row.summary === 'string' && row.summary !== '' ? clampText(row.summary, 800) : t('empty'),
          ),
        ),
        h(
          'div',
          { className: 'stp-logTime' },
          h('span', { className: 'stp-logTitle' }, formatTime(Number(row.startedAt))),
          Number.isFinite(Number(row.toolCalls))
            ? h('span', { className: 'stp-logTools' }, String(row.toolCalls) + ' ' + t('toolCalls'))
            : null,
        ),
      ];
      const extra = [];
      if (typeof row.error === 'string' && row.error !== '') {
        extra.push(h('div', { className: 'stp-error', key: 'err' }, clampText(row.error, 400)));
      }
      if (typeof row.sessionId === 'string' && row.sessionId !== '') {
        extra.push(h('div', { className: 'stp-mono', key: 'sid', title: row.sessionId }, row.sessionId));
      }
      if (extra.length > 0) cells.push(h('div', { className: 'stp-logSub' }, extra));
      return h('div', { className: 'stp-logRow', key: String(row.seq === undefined ? index : row.seq) }, cells);
    }

    /** 新建表单的初始草稿。 */
    function emptyDraft() {
      return {
        title: '',
        prompt: '',
        skill: '',
        workspaceRoot: '',
        // 'default' = 跟随会话默认模型；否则是 'provider/model' 形式的选中值。
        modelKey: 'default',
        reasoningEffort: '',
        enabled: true,
        kind: 'daily',
        everyMinutes: '60',
        time: '09:00',
        weekdays: [1],
        cron: '0 9 * * *',
        onceAt: '',
      };
    }

    /* ---------------------------------------------------------------- */
    /* 视图工厂：组件在 apply 作用域内创建，闭包拿到 api / t              */
    /* ---------------------------------------------------------------- */

    /**
     * sidebar.panellist 的图标：24x24、currentColor，接 { size, active }。
     */
    function PanelIcon(props) {
      const size = isPlainObject(props) && Number.isFinite(props.size) ? props.size : 24;
      const active = isPlainObject(props) && props.active === true;
      return h(
        'svg',
        {
          className: 'stp-icon',
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('rect', { x: 3, y: 4.5, width: 18, height: 16, rx: 2.5, key: 'rect' }),
        h('path', { d: 'M3 9h18', key: 'line' }),
        h('path', { d: 'M8 3v3M16 3v3', key: 'ticks' }),
        h('path', { d: 'M12 12.5V16l2.5 1.5', key: 'clock' }),
      );
    }

    /**
     * @param {{ available: boolean, t: Function, describe: Function, mutate: Function }} api
     */
    function createViews(api) {
      const t = (key) => api.t(key);

      function TasksPage() {
        const [state, setState] = React.useState({
          status: api.available === true ? 'loading' : 'inert',
          error: null,
          readOnly: false,
          revision: 0,
          tasks: [],
          log: [],
          runs: {},
          // 模型目录（宿主写、界面读）。空数组表示暂时拿不到，
          // 此时「跟随默认模型」依然可用，不阻塞创建。
          catalog: [],
        });
        const [draft, setDraft] = React.useState(emptyDraft);
        const [formOpen, setFormOpen] = React.useState(false);
        /** null = 新建；否则是被编辑的任务 id。同一个表单两种用途。 */
        const [editingId, setEditingId] = React.useState(null);
        const [formError, setFormError] = React.useState(null);
        const [busy, setBusy] = React.useState(null);
        const [note, setNote] = React.useState(null);
        /** 当前 tab：'tasks'（配置）或 'logs'（流水）。 */
        const [tab, setTab] = React.useState('tasks');
        /** 两个 tab 各自的分页游标（从 0 开始）。分开记：切 tab 不该丢失对方的位置。 */
        const [taskPage, setTaskPage] = React.useState(0);
        const [logPage, setLogPage] = React.useState(0);
        /**
         * 当前展开了运行记录的任务 id（null = 全部收起）。
         * 只允许展开一个：日志是流水，同时铺开多个就把页面拉得和全局列表一样长，
         * 又回到了"配置被流水挤下去"的老问题。
         */
        const [expandedTask, setExpandedTask] = React.useState(null);

        /**
         * 数据变动（删除任务、日志被裁剪）后把分页游标夹回合法范围，
         * 否则会停在一个空页上：列表空了、分页条却还在。
         *
         * **这个 effect 必须待在所有 early return 之前**。它就放在这里，
         * 而不是渲染分支内部——否则会出现「首帧少调一个 hook、数据到位后多调一个」
         * 的情况，React 直接抛 error #310（Rendered more hooks than during the
         * previous render），整个 slot entry 崩掉，主区域一片空白。
         * 这是真实发生过的故障：静态检查与「apply 不抛」都发现不了。
         */
        React.useEffect(() => {
          const taskPages = Math.max(1, Math.ceil(state.tasks.length / PAGE_SIZE));
          setTaskPage((current) => (current > taskPages - 1 ? taskPages - 1 : current));
          const logPages = Math.max(1, Math.ceil(state.log.length / PAGE_SIZE));
          setLogPage((current) => (current > logPages - 1 ? logPages - 1 : current));
        }, [state.tasks.length, state.log.length]);

        /** 读一次设置文档。 */
        const load = React.useCallback(async () => {
          if (api.available !== true) {
            setState((current) => ({ ...current, status: 'inert' }));
            return;
          }
          setState((current) => ({ ...current, status: 'loading', error: null }));
          let response;
          try {
            response = await api.describe();
          } catch (error) {
            setState((current) => ({ ...current, status: 'error', error: messageOf(error) }));
            return;
          }
          if (!isObject(response) || response.ok !== true || !isPlainObject(response.value)) {
            const detail = isObject(response) && isObject(response.error) && typeof response.error.message === 'string'
              ? response.error.message
              : '';
            setState((current) => ({ ...current, status: 'error', error: detail }));
            return;
          }
          const view = response.value;
          const entries = Array.isArray(view.namespaces) ? view.namespaces : [];
          const entry = entries.find((item) => isPlainObject(item) && item.ns === CONFIG_NS);
          if (entry === undefined) {
            setState((current) => ({ ...current, status: 'unavailable', error: null, tasks: [], log: [], runs: {} }));
            return;
          }
          // 用户层原始值优先：把解析后的值整段回写会把 schema 默认值固化到用户层。
          const userTasks = getPath(entry.user, ['tasks']);
          const resolvedTasks = getPath(entry.value, ['tasks']);
          const tasks = Array.isArray(userTasks)
            ? userTasks
            : (Array.isArray(resolvedTasks) ? resolvedTasks : []);
          // 日志与运行表永远是宿主写的，只读。
          const log = getPath(entry.value, ['internal', 'log']);
          const runs = getPath(entry.value, ['internal', 'runs']);
          const catalog = getPath(entry.value, ['internal', 'catalog']);
          setState({
            status: 'ready',
            error: null,
            readOnly: view.writable === false,
            revision: Number.isFinite(entry.revision) ? entry.revision : 0,
            tasks: tasks.filter((task) => isPlainObject(task)),
            log: Array.isArray(log) ? log.filter((row) => isPlainObject(row)) : [],
            runs: isPlainObject(runs) ? runs : {},
            catalog: readProviders(catalog),
          });
        }, []);

        React.useEffect(() => {
          void load();
        }, [load]);

        /**
         * 整段回写 tasks。冲突时重读最新 revision 并提示用户重试。
         * @returns {Promise<boolean>}
         */
        const writeTasks = React.useCallback(async (tasks, okKey) => {
          if (api.available !== true) return false;
          setBusy('tasks');
          setNote(null);
          setState((current) => ({ ...current, error: null }));
          let response;
          try {
            response = await api.mutate([{ op: 'set', path: ['tasks'], value: tasks }], state.revision);
          } catch (error) {
            setBusy(null);
            setState((current) => ({ ...current, error: t('errWrite') + '：' + messageOf(error) }));
            return false;
          }
          if (!isObject(response) || response.ok !== true) {
            const detail = isObject(response) && isObject(response.error) && typeof response.error.message === 'string'
              ? response.error.message
              : t('conflict');
            setBusy(null);
            setState((current) => ({ ...current, error: t('errWrite') + '：' + detail + '　' + t('conflict') }));
            await load();
            return false;
          }
          setBusy(null);
          if (okKey !== undefined) setNote(t(okKey));
          await load();
          return true;
        }, [load, state.revision, t]);

        /**
         * 「立即运行」= 往 `internal.manualRuns` 追加一条请求。
         *
         * 浏览器半不能创建 Agent，真正执行由宿主的下一次 tick 完成；这里在写入前
         * 重新 describe 拿最新 revision（该队列可能与其它设置写入并行推进）。
         */
        const requestRun = React.useCallback(async (taskId) => {
          if (api.available !== true) return false;
          setBusy('run:' + taskId);
          setNote(null);
          setState((current) => ({ ...current, error: null }));
          try {
            const fresh = await api.describe();
            if (!isObject(fresh) || fresh.ok !== true || !isPlainObject(fresh.value)) {
              setBusy(null);
              setState((current) => ({ ...current, error: t('errLoad') }));
              return false;
            }
            const entries = Array.isArray(fresh.value.namespaces) ? fresh.value.namespaces : [];
            const entry = entries.find((item) => isPlainObject(item) && item.ns === CONFIG_NS);
            if (entry === undefined) {
              setBusy(null);
              setState((current) => ({ ...current, error: t('errLoad') }));
              return false;
            }
            const response = await api.mutate(
              [{
                op: 'set',
                path: ['internal', 'manualRuns'],
                value: [{ taskId, requestedAt: Date.now() }],
              }],
              entry.revision,
            );
            if (!isObject(response) || response.ok !== true) {
              const detail = isObject(response) && isObject(response.error) && typeof response.error.message === 'string'
                ? response.error.message
                : t('conflict');
              setBusy(null);
              setState((current) => ({ ...current, error: t('errWrite') + '：' + detail }));
              await load();
              return false;
            }
            setBusy(null);
            setNote(t('runRequested'));
            await load();
            return true;
          } catch (error) {
            setBusy(null);
            setState((current) => ({ ...current, error: t('errWrite') + '：' + messageOf(error) }));
            return false;
          }
        }, [load, t]);

        const patchDraft = React.useCallback((changes) => {
          setDraft((current) => ({ ...current, ...changes }));
          setFormError(null);
        }, []);

        const toggleWeekday = React.useCallback((day) => {
          setDraft((current) => {
            const days = Array.isArray(current.weekdays) ? current.weekdays : [];
            const next = days.includes(day)
              ? days.filter((item) => item !== day)
              : days.concat([day]).sort((left, right) => left - right);
            return { ...current, weekdays: next };
          });
          setFormError(null);
        }, []);

        /**
         * 把草稿编成任务对象（契约 §2.1）。
         * @returns {{ task: object } | { errorKey: string }}
         */
        /** 正在编辑的任务本体：保存时要沿用它的 createdAt。 */
        const original = editingId === null
          ? null
          : (state.tasks.find((item) => item.id === editingId) ?? null);

        /**
         * 把草稿编成任务对象。
         * 新建与编辑共用：区别只在 id/createdAt 从哪来。
         */
        const buildTask = React.useCallback(() => {
          const title = String(draft.title).trim();
          if (title === '' || title.length > 120) return { errorKey: 'errTitleRequired' };
          const prompt = String(draft.prompt).trim();
          if (prompt === '' || prompt.length > 20000) return { errorKey: 'errPromptRequired' };

          let schedule;
          if (draft.kind === 'every') {
            const minutes = Number(String(draft.everyMinutes).trim());
            if (!Number.isInteger(minutes) || minutes < EVERY_MIN || minutes > EVERY_MAX) {
              return { errorKey: 'errEveryRange' };
            }
            schedule = { kind: 'every', everyMinutes: minutes };
          } else if (draft.kind === 'daily') {
            const time = parseHHMM(draft.time);
            if (time === null) return { errorKey: 'errTimeFormat' };
            schedule = { kind: 'daily', time: pad(time.hours) + ':' + pad(time.minutes) };
          } else if (draft.kind === 'weekly') {
            const time = parseHHMM(draft.time);
            if (time === null) return { errorKey: 'errTimeFormat' };
            const weekdays = Array.from(new Set(
              (Array.isArray(draft.weekdays) ? draft.weekdays : [])
                .map((day) => Number(day))
                .filter((day) => Number.isInteger(day) && day >= 1 && day <= 7),
            )).sort((left, right) => left - right);
            if (weekdays.length === 0) return { errorKey: 'errWeekdayRequired' };
            schedule = { kind: 'weekly', time: pad(time.hours) + ':' + pad(time.minutes), weekdays };
          } else if (draft.kind === 'cron') {
            const expression = String(draft.cron).trim().replace(/\s+/g, ' ');
            if (expression === '') return { errorKey: 'errCronRequired' };
            if (parseCronFields(expression) === null) return { errorKey: 'errCronFormat' };
            schedule = { kind: 'cron', expression };
          } else {
            // once：datetime-local 的值按本地时间解析。
            const text = String(draft.onceAt).trim();
            const at = text === '' ? Number.NaN : Date.parse(text);
            if (!Number.isFinite(at)) return { errorKey: 'errTimeFormat' };
            if (at <= Date.now()) return { errorKey: 'errOnceFuture' };
            schedule = { kind: 'once', at };
          }

          const now = Date.now();
          const task = {
            id: editingId === null ? newTaskId(now) : editingId,
            title,
            prompt,
            enabled: draft.enabled === true,
            schedule,
            createdAt: editingId === null
              ? now
              : (Number.isFinite(original && original.createdAt) ? original.createdAt : now),
            updatedAt: now,
          };
          const skill = String(draft.skill).trim();
          if (skill !== '') task.skill = skill;
          const workspaceRoot = String(draft.workspaceRoot).trim();
          if (workspaceRoot !== '') task.workspaceRoot = workspaceRoot;

          // 模型覆盖：只有选完整一组 provider/model 才写。
          // 「跟随默认模型」不写这个字段——那正是让宿主走会话默认模型的方式。
          const modelPair = modelPairOf(draft);
          if (modelPair !== null) task.model = modelPair;

          return { task: withNextRun(task, now) };
        }, [draft, editingId, original]);

        /**
         * 新建与保存共用：新建是「追加」，保存是「原位替换」。
         * 两条路都走 writeTasks 整段回写——设置文档的路径编辑不下钻数组元素，
         * 逐元素写路径会把数组打散成对象键。
         */
        const submit = React.useCallback(async () => {
          const built = buildTask();
          if (built.errorKey !== undefined) {
            setFormError(t(built.errorKey));
            setState((current) => ({ ...current, error: null }));
            return;
          }
          // 只提交可写字段：lastRunAt/nextRunAt/lastStatus 这类运行态字段不被表单
          // 管理，否则会把宿主的运行记录一起冲掉。
          const next = editingId === null
            ? state.tasks.concat([built.task])
            : state.tasks.map((item) => (item.id === editingId ? built.task : item));
          const ok = await writeTasks(next, editingId === null ? 'create' : 'update');
          if (ok) {
            setDraft(emptyDraft());
            setFormOpen(false);
            setEditingId(null);
            setFormError(null);
          }
        }, [buildTask, editingId, state.tasks, t, writeTasks]);

        const toggleTask = React.useCallback(async (task) => {
          const now = Date.now();
          const next = state.tasks.map((item) => {
            if (item.id !== task.id) return item;
            if (item.enabled === true) return { ...item, enabled: false, updatedAt: now };
            // 重新启用必须重排下一次触发，否则 isTaskDue 永远为 false。
            const enabled = { ...item, enabled: true, updatedAt: now };
            return withNextRun(enabled, now);
          });
          await writeTasks(next, 'disable');
        }, [state.tasks, writeTasks]);

        const removeTask = React.useCallback(async (task) => {
          const confirmed = typeof window === 'undefined'
            || typeof window.confirm !== 'function'
            || window.confirm(fill(t('confirmRemove'), { title: task.title }));
          if (confirmed !== true) return;
          await writeTasks(state.tasks.filter((item) => item.id !== task.id), 'remove');
        }, [state.tasks, t, writeTasks]);

        /**
         * 打开编辑：把任务灌进同一个表单。
         * 表单与新建共用，但 id / createdAt 沿用原值——这样保存是「原位替换」
         * 而不是「删旧建新」，运行历史（按 taskId 归组）才接得上。
         */
        const startEdit = React.useCallback((task) => {
          const model = isPlainObject(task.model) ? task.model : undefined;
          const modelKey = model !== undefined && typeof model.provider === 'string' && model.provider !== ''
            && typeof model.model === 'string' && model.model !== ''
            ? model.provider + '/' + model.model
            : 'default';
          setDraft({
            ...emptyDraft(),
            title: task.title === undefined ? '' : String(task.title),
            prompt: task.prompt === undefined ? '' : String(task.prompt),
            skill: typeof task.skill === 'string' ? task.skill : '',
            workspaceRoot: typeof task.workspaceRoot === 'string' ? task.workspaceRoot : '',
            enabled: task.enabled !== false,
            modelKey,
            reasoningEffort: model !== undefined && typeof model.reasoningEffort === 'string'
              ? model.reasoningEffort
              : '',
            kind: isPlainObject(task.schedule) && typeof task.schedule.kind === 'string'
              ? task.schedule.kind
              : 'daily',
            time: isPlainObject(task.schedule) && typeof task.schedule.time === 'string'
              ? task.schedule.time
              : '09:00',
            everyMinutes: isPlainObject(task.schedule) && Number.isFinite(task.schedule.everyMinutes)
              ? String(task.schedule.everyMinutes)
              : '60',
            weekdays: isPlainObject(task.schedule) && Array.isArray(task.schedule.weekdays)
              ? task.schedule.weekdays.slice()
              : [1],
            cron: isPlainObject(task.schedule) && typeof task.schedule.expression === 'string'
              ? task.schedule.expression
              : '0 9 * * *',
            // datetime-local 只认 "YYYY-MM-DDTHH:mm"，所以要转成本地格式；
            // 直接塞 ISO 字符串浏览器会当无效值丢掉。
            onceAt: isPlainObject(task.schedule) && typeof task.schedule.at === 'number'
              ? toLocalStamp(task.schedule.at)
              : '',
          });
          setEditingId(String(task.id));
          setFormOpen(true);
          setFormError(null);
          setNote(null);
          // 编辑时停用收起状态，避免编辑完还要再点一次才看到变化。
          setExpandedTask(null);
        }, [t]);

        if (state.status === 'inert') {
          return h('div', { className: 'stp-root' }, h('div', { className: 'stp-inner' },
            h('div', { className: 'stp-warn' }, t('errNoApi'))));
        }
        if (state.status === 'loading' && state.tasks.length === 0) {
          return h('div', { className: 'stp-root' }, h('div', { className: 'stp-inner' },
            h('div', { className: 'stp-hint' }, t('loading'))));
        }
        if (state.status === 'unavailable') {
          return h(
            'div',
            { className: 'stp-root' },
            h(
              'div',
              { className: 'stp-inner' },
              h('div', { className: 'stp-title' }, t('title')),
              h('div', { className: 'stp-empty' }, t('unavailable')),
              h(
                'div',
                { className: 'stp-headActions', style: { justifyContent: 'flex-start' } },
                h('button', { type: 'button', className: 'stp-btn', disabled: busy !== null, onClick: () => { void load(); } }, t('refresh')),
              ),
            ),
          );
        }

        const disabled = state.readOnly || busy !== null;
        const children = [];

        // 头部：标题块在左，计数与操作在右；操作区单独成组，不再散落在标题行里。
        children.push(h(
          'div',
          { className: 'stp-head', key: 'head' },
          h(
            'div',
            { className: 'stp-headText' },
            h('div', { className: 'stp-title' }, t('title')),
            h('div', { className: 'stp-hint' }, t('hint')),
          ),
          h(
            'div',
            { className: 'stp-headActions' },
            h('span', { className: 'stp-badge stp-badgePlain' }, fill(t('taskCount'), { n: state.tasks.length })),
            h(
              'button',
              { type: 'button', className: 'stp-btn', disabled: busy !== null, onClick: () => { void load(); } },
              t('refresh'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'stp-btn',
                'data-primary': 'true',
                disabled: disabled,
                onClick: () => {
                  setFormOpen(formOpen !== true);
                  setDraft(emptyDraft());
                  setFormError(null);
                  setNote(null);
                },
              },
              t('newTask'),
            ),
          ),
        ));
        children.push(h(
          'div',
          { className: 'stp-note-bar', key: 'converse' },
          h('span', null, t('converseHint')),
        ));

        // 页内 tab：任务（配置，条数稳定）与运行日志（流水，持续增长）分开，
        // 各自分页。混在一页会让流水把配置挤下去。
        children.push(h(
          'div',
          { className: 'stp-tabs', role: 'tablist', key: 'tabs' },
          h(
            'button',
            {
              type: 'button',
              role: 'tab',
              className: 'stp-tab',
              'aria-selected': tab === 'tasks',
              onClick: () => setTab('tasks'),
            },
            t('tabTasks') + ' ',
            h('span', { className: 'stp-tabCount' }, `(${state.tasks.length})`),
          ),
          h(
            'button',
            {
              type: 'button',
              role: 'tab',
              className: 'stp-tab',
              'aria-selected': tab === 'logs',
              onClick: () => setTab('logs'),
            },
            t('tabLogs') + ' ',
            h('span', { className: 'stp-tabCount' }, `(${state.log.length})`),
          ),
        ));

        // 新建 / 编辑表单。
        // 字段按**语义行**分组，每行显式声明列数（data-cols）。不用 auto-fit 网格：
        // 可选项随 schedule 类型增减，auto-fit 会把「启用」复选框摊成独立格子，
        // 右侧留一大片空白——真机截图里的排版问题就是它。
        if (formOpen === true) {
          /** 一行字段。cols：1 = 通栏，2 = 两列（默认），3 = 三列。 */
          const row = (key, cols, cells) => h(
            'div',
            { className: 'stp-formRow', key, 'data-cols': String(cols) },
            cells.filter(Boolean),
          );
          const rows = [];

          rows.push(row('r-title', 1, [h(
            'label',
            { className: 'stp-field', key: 'title' },
            h('span', { className: 'stp-label' }, t('fieldTitle')),
            h('input', {
              className: 'stp-input',
              type: 'text',
              value: draft.title,
              maxLength: 120,
              placeholder: t('titlePlaceholder'),
              disabled: state.readOnly,
              onChange: (event) => patchDraft({ title: event.target.value }),
            }),
          )]));

          rows.push(row('r-prompt', 1, [h(
            'label',
            { className: 'stp-field', key: 'prompt' },
            h('span', { className: 'stp-label' }, t('fieldPrompt')),
            h('textarea', {
              className: 'stp-textarea',
              value: draft.prompt,
              placeholder: t('promptPlaceholder'),
              spellCheck: false,
              disabled: state.readOnly,
              onChange: (event) => patchDraft({ prompt: event.target.value }),
            }),
          )]));

          rows.push(row('r-context', 2, [
            h(
              'label',
              { className: 'stp-field', key: 'skill' },
              h('span', { className: 'stp-label' }, t('fieldSkill')),
              h('input', {
                className: 'stp-input',
                type: 'text',
                value: draft.skill,
                placeholder: t('skillPlaceholder'),
                autoComplete: 'off',
                spellCheck: false,
                disabled: state.readOnly,
                onChange: (event) => patchDraft({ skill: event.target.value }),
              }),
            ),
            h(
              'label',
              { className: 'stp-field', key: 'workspaceRoot' },
              h('span', { className: 'stp-label' }, t('fieldWorkspaceRoot')),
              h('input', {
                className: 'stp-input stp-mono',
                type: 'text',
                value: draft.workspaceRoot,
                placeholder: t('workspaceRootPlaceholder'),
                autoComplete: 'off',
                spellCheck: false,
                disabled: state.readOnly,
                onChange: (event) => patchDraft({ workspaceRoot: event.target.value }),
              }),
            ),
          ]));

          /* 模型与推理强度。
             目录由宿主写进 internal.catalog（客户端拿不到 llm.listModels，
             它不是 @Remote），所以这里是纯下拉、不发请求。
             两个 select 都是**受控且可空的**：目录缺失时只有「默认模型」一项。 */
          const providers = state.catalog;
          const providerCell = h(
            'label',
            { className: 'stp-field', key: 'modelProvider' },
            h('span', { className: 'stp-label' }, t('fieldModel')),
            h(
              'select',
              {
                className: 'stp-select',
                value: draft.modelKey === 'default' ? 'default' : String(draft.modelKey).split('/')[0],
                disabled: state.readOnly || providers.length === 0,
                onChange: (event) => {
                  // 换供应商要连带清掉模型与强度：上一个供应商的模型 id 在新供应商
                  // 里没有意义，留着会写出一组对不上的组合。
                  const provider = event.target.value;
                  if (provider === 'default') patchDraft({ modelKey: 'default', reasoningEffort: '' });
                  else patchDraft({ modelKey: provider + '/', reasoningEffort: '' });
                },
              },
              h('option', { key: 'default', value: 'default' }, t('modelDefault')),
              providers.map((provider) => h(
                'option',
                { key: provider.id, value: provider.id },
                provider.name,
              )),
            ),
          );

          const selectedProvider = providers.find(
            (provider) => draft.modelKey !== 'default' && String(draft.modelKey).startsWith(provider.id + '/'),
          );
          const selectedModelId = selectedProvider === undefined
            ? ''
            : String(draft.modelKey).slice(selectedProvider.id.length + 1);
          const modelCell = selectedProvider === undefined
            ? (providers.length > 0 && draft.modelKey !== 'default'
              ? h(
                'div',
                { className: 'stp-field', key: 'modelStale' },
                h('div', { className: 'stp-warn' }, fill(t('modelStale'), { id: String(draft.modelKey) })),
              )
              : null)
            : h(
              'label',
              { className: 'stp-field', key: 'modelName' },
              h('span', { className: 'stp-label' }, t('fieldModelName')),
              h(
                'select',
                {
                  className: 'stp-select',
                  value: selectedModelId,
                  disabled: state.readOnly,
                  onChange: (event) => patchDraft({
                    modelKey: selectedProvider.id + '/' + event.target.value,
                    reasoningEffort: '',
                  }),
                },
                selectedProvider.models.map((model) => h(
                  'option',
                  { key: model.id, value: model.id },
                  model.name,
                )),
              ),
            );

          // 供应商与模型同一行：它们本来就是一组的（先选供应商才出现模型）。
          rows.push(row('r-model', 2, [providerCell, modelCell]));

          // 推理强度独居一行（只有该模型支持时才出现），不和别的字段挤在一起。
          const selectedModel = selectedProvider === undefined
            ? undefined
            : selectedProvider.models.find((model) => model.id === selectedModelId);
          const efforts = selectedModel === undefined ? [] : selectedModel.efforts;
          if (efforts.length > 0) {
            rows.push(row('r-effort', 1, [h(
              'label',
              { className: 'stp-field', key: 'reasoningEffort' },
              h('span', { className: 'stp-label' }, t('fieldReasoningEffort')),
              h(
                'select',
                {
                  className: 'stp-select',
                  value: draft.reasoningEffort,
                  disabled: state.readOnly,
                  onChange: (event) => patchDraft({ reasoningEffort: event.target.value }),
                },
                // 第一项是「模型默认」：不写 reasoningEffort 字段，
                // 让宿主/模型自己的默认强度生效。写死一个值会失去这个语义。
                h('option', { key: '', value: '' }, t('reasoningDefault')),
                efforts.map((effort) => h(
                  'option',
                  { key: effort.id, value: effort.id },
                  effort.name,
                )),
              ),
            )]));
          }

          /* 触发时间与它的取值同一行。
             例如「触发时间 = cron 表达式」+「表达式输入框」，
             这样"选什么类型"和"填什么值"永远并排，不会一个占满、另一个被挤到下一行。 */
          const kinds = [['every', 'kindEvery'], ['daily', 'kindDaily'], ['weekly', 'kindWeekly'], ['cron', 'kindCron'], ['once', 'kindOnce']];
          const kindCell = h(
            'label',
            { className: 'stp-field', key: 'kind' },
            h('span', { className: 'stp-label' }, t('fieldSchedule')),
            h(
              'select',
              {
                className: 'stp-select',
                value: draft.kind,
                disabled: state.readOnly,
                onChange: (event) => patchDraft({ kind: event.target.value }),
              },
              kinds.map(([kind, key]) => h('option', { key: kind, value: kind }, t(key))),
            ),
          );

          let valueCell = null;
          if (draft.kind === 'every') {
            valueCell = h(
              'label',
              { className: 'stp-field', key: 'every' },
              h('span', { className: 'stp-label' }, t('everyMinutes')),
              h('input', {
                className: 'stp-input',
                type: 'number',
                min: EVERY_MIN,
                max: EVERY_MAX,
                step: 1,
                value: draft.everyMinutes,
                disabled: state.readOnly,
                onChange: (event) => patchDraft({ everyMinutes: event.target.value }),
              }),
            );
          } else if (draft.kind === 'daily' || draft.kind === 'weekly') {
            valueCell = h(
              'label',
              { className: 'stp-field', key: 'time' },
              h('span', { className: 'stp-label' }, t('time')),
              h('input', {
                className: 'stp-input',
                type: 'time',
                value: draft.time,
                disabled: state.readOnly,
                onChange: (event) => patchDraft({ time: event.target.value }),
              }),
            );
          } else if (draft.kind === 'cron') {
            valueCell = h(
              'label',
              { className: 'stp-field', key: 'cron' },
              h('span', { className: 'stp-label' }, t('cronExpr')),
              h('input', {
                className: 'stp-input stp-mono',
                type: 'text',
                value: draft.cron,
                placeholder: '*/30 9-18 * * 1-5',
                autoComplete: 'off',
                spellCheck: false,
                disabled: state.readOnly,
                onChange: (event) => patchDraft({ cron: event.target.value }),
              }),
            );
          } else {
            valueCell = h(
              'label',
              { className: 'stp-field', key: 'once' },
              h('span', { className: 'stp-label' }, t('onceAt')),
              h('input', {
                className: 'stp-input',
                type: 'datetime-local',
                value: draft.onceAt,
                disabled: state.readOnly,
                onChange: (event) => patchDraft({ onceAt: event.target.value }),
              }),
            );
          }
          rows.push(row('r-sched', 2, [kindCell, valueCell]));

          if (draft.kind === 'weekly') {
            rows.push(row('r-days', 1, [h(
              'div',
              { className: 'stp-field', key: 'days' },
              h('span', { className: 'stp-label' }, t('weekdays')),
              h(
                'div',
                { className: 'stp-days' },
                [1, 2, 3, 4, 5, 6, 7].map((day) => h(
                  'button',
                  {
                    type: 'button',
                    key: day,
                    className: 'stp-day',
                    'aria-pressed': Array.isArray(draft.weekdays) && draft.weekdays.includes(day),
                    disabled: state.readOnly,
                    onClick: () => toggleWeekday(day),
                  },
                  t(WEEKDAY_KEYS[day]),
                )),
              ),
            )]));
          }
          // 「启用」不放进行内网格：它是一个布尔开关，塞进字段网格会独占
          // 一整格、右侧留大片空白。这里放到操作行，和取消/保存同一层级。
          const enabledCell = h(
            'label',
            { className: 'stp-check', key: 'enabled' },
            h('input', {
              type: 'checkbox',
              checked: draft.enabled === true,
              disabled: state.readOnly,
              onChange: (event) => patchDraft({ enabled: event.target.checked }),
            }),
            h('span', null, t('enable')),
          );

          const actions = h(
            'div',
            { className: 'stp-formActions', key: 'actions' },
            enabledCell,
            h('span', { style: { flex: '1' } }),
            formError === null ? null : h('span', { className: 'stp-error' }, formError),
            h(
              'button',
              {
                type: 'button',
                className: 'stp-btn',
                disabled: busy !== null,
                onClick: () => { setFormOpen(false); setFormError(null); setEditingId(null); },
              },
              t('cancel'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'stp-btn',
                'data-primary': 'true',
                disabled: disabled,
                onClick: () => { void submit(); },
              },
              busy === 'tasks'
                ? (editingId === null ? t('creating') : t('saving'))
                : (editingId === null ? t('create') : t('save')),
            ),
          );

          children.push(h(
            'div',
            { className: 'stp-form', key: 'form' },
            // 表单标题区分新建与编辑：两种模式的按钮语义不同（创建 vs 保存）。
            h('div', { className: 'stp-formTitle' }, editingId === null ? t('formTitleNew') : t('formTitleEdit')),
            h('div', { className: 'stp-formRows' }, rows),
            actions,
          ));
        }

        // 运行记录按任务归组，挂在各自任务的展开区里
        // （任务列表是配置、日志是流水；混成一个全局列表会让日志把配置挤下去）。
        const logByTask = new Map();
        for (const row of state.log) {
          if (row === null || typeof row !== 'object') continue;
          const key = String(row.taskId);
          const bucket = logByTask.get(key);
          if (bucket === undefined) logByTask.set(key, [row]);
          else bucket.push(row);
        }
        for (const bucket of logByTask.values()) {
          bucket.sort((left, right) => Number(right.seq) - Number(left.seq));
        }

        // 任务列表：平面列表 + 细分隔线；行内 grid 两列（内容自适应 / 操作固定）。
        // 任务「条数稳定」是相对流水而言；真堆到几十条时同样需要分页。
        const taskPageCount = Math.max(1, Math.ceil(state.tasks.length / PAGE_SIZE));
        const safeTaskPage = Math.min(taskPage, taskPageCount - 1);
        const taskSlice = state.tasks.slice(safeTaskPage * PAGE_SIZE, safeTaskPage * PAGE_SIZE + PAGE_SIZE);

        if (tab === 'tasks') children.push(h(
          'div',
          { className: 'stp-section', key: 'tasksSection' },
          h(
            'div',
            { className: 'stp-sectionHead' },
            h('div', { className: 'stp-sectionTitle' }, t('tasksTitle')),
            h('div', { className: 'stp-count' }, fill(t('taskCount'), { n: state.tasks.length })),
          ),
          state.tasks.length === 0
            ? h('div', { className: 'stp-empty' }, t('noTasks'))
            : h(
              'div',
              { className: 'stp-list' },
              taskSlice.map((task) => {
                const off = task.enabled !== true;
                const running = isPlainObject(state.runs) && Object.prototype.hasOwnProperty.call(state.runs, task.id);
                const nextRun = Number.isFinite(Number(task.nextRunAt)) && Number(task.nextRunAt) > 0
                  ? formatTime(Number(task.nextRunAt))
                  : t('notScheduled');
                const lastRun = Number.isFinite(Number(task.lastRunAt)) && Number(task.lastRunAt) > 0
                  ? formatTime(Number(task.lastRunAt))
                  : t('never');
                const history = logByTask.get(String(task.id)) ?? [];
                const expanded = expandedTask === task.id;

                // 元信息用「分隔点」组装成一个数组，避免三段文字被 flex 拉到不同位置。
                const metaBits = [];
                metaBits.push(h('span', { className: 'stp-metaItem', key: 'next' }, t('nextRun') + '：' + (off ? '—' : nextRun)));
                metaBits.push(h('span', { className: 'stp-metaDot', key: 'd1', 'aria-hidden': 'true' }, '·'));
                metaBits.push(h('span', { className: 'stp-metaItem', key: 'last' }, t('lastRun') + '：' + lastRun));
                if (typeof task.skill === 'string' && task.skill !== '') {
                  metaBits.push(h('span', { className: 'stp-metaDot', key: 'd2', 'aria-hidden': 'true' }, '·'));
                  metaBits.push(h('span', { className: 'stp-metaItem', key: 'skill' }, 'skill: ' + task.skill));
                }

                const main = [
                  h(
                    'div',
                    { className: 'stp-itemTitleRow', key: 'title' },
                    // title 属性让被 ellipsis 截断的长标题仍可 hover 查看全文。
                    h('span', { className: 'stp-itemTitle', title: task.title === undefined ? '' : String(task.title) },
                      task.title === undefined ? '(untitled)' : String(task.title)),
                    running ? h('span', { className: 'stp-badge', 'data-status': 'running', key: 'r' }, t('running')) : null,
                    off ? h('span', { className: 'stp-badge stp-badgePlain', key: 'off' }, t('disable')) : null,
                    typeof task.lastStatus === 'string'
                      ? h('span', { className: 'stp-badge', 'data-status': task.lastStatus, key: 'st' }, t(statusKey(task.lastStatus)))
                      : null,
                  ),
                  h('div', { className: 'stp-sched', key: 'sched', title: describeSchedule(task.schedule, t) }, describeSchedule(task.schedule, t)),
                  h('div', { className: 'stp-meta', key: 'meta' }, metaBits),
                ];
                if (typeof task.prompt === 'string' && task.prompt !== '') {
                  main.push(h('div', { className: 'stp-prompt', key: 'prompt', title: task.prompt }, clampText(task.prompt, 400)));
                }

                const side = [
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'stp-btn',
                      key: 'run',
                      'data-primary': 'true',
                      disabled: disabled || running,
                      onClick: () => { void requestRun(task.id); },
                    },
                    busy === 'run:' + task.id ? t('runningNow') : t('runNow'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'stp-btn',
                      key: 'edit',
                      disabled: disabled || running,
                      title: t('editTask'),
                      onClick: () => startEdit(task),
                    },
                    t('editTask'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'stp-btn',
                      key: 'toggle',
                      disabled: disabled || running,
                      onClick: () => { void toggleTask(task); },
                    },
                    off ? t('enable') : t('disable'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'stp-btn',
                      key: 'remove',
                      'data-danger': 'true',
                      disabled: disabled || running,
                      onClick: () => { void removeTask(task); },
                    },
                    t('remove'),
                  ),
                ];

                const itemChildren = [
                  h(
                    'div',
                    { className: 'stp-itemGrid', key: 'grid' },
                    h('div', { className: 'stp-itemMain' }, main),
                    h('div', { className: 'stp-itemSide' }, side),
                  ),
                ];

                // 运行记录入口：带条数，展开后列出该任务的最近若干次运行。
                itemChildren.push(h(
                  'div',
                  { className: 'stp-itemFoot', key: 'foot' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'stp-linkBtn',
                      'aria-expanded': expanded,
                      onClick: () => setExpandedTask(expanded ? null : task.id),
                    },
                    (expanded ? '▾ ' : '▸ ') + t('runHistory') + (history.length > 0 ? ` (${history.length})` : ''),
                  ),
                ));

                if (expanded) {
                  const visible = history.slice(0, LOG_VIEW_LIMIT);
                  itemChildren.push(h(
                    'div',
                    { className: 'stp-history', key: 'history' },
                    visible.length === 0
                      ? h('div', { className: 'stp-historyEmpty' }, t('noRunsForTask'))
                      : h('div', { className: 'stp-logList' }, visible.map((row, index) => renderLogRow(row, index, t))),
                  ));
                }

                return h(
                  'div',
                  { className: 'stp-item', key: String(task.id), 'data-off': off ? 'true' : 'false' },
                  itemChildren,
                );
              }),
            ),
          renderPager({
            page: safeTaskPage,
            pageCount: taskPageCount,
            total: state.tasks.length,
            from: safeTaskPage * PAGE_SIZE + 1,
            to: safeTaskPage * PAGE_SIZE + taskSlice.length,
            onPrev: () => setTaskPage(Math.max(0, safeTaskPage - 1)),
            onNext: () => setTaskPage(Math.min(taskPageCount - 1, safeTaskPage + 1)),
            t,
          }),
        ));

        // 运行日志 tab：全局流水，按时间倒序分页。
        // 它独立于任务 tab，所以流水再长也只是这一页翻页，不会把任务配置挤下去。
        if (tab === 'logs') {
          const sortedLog = state.log
            .filter((row) => row !== null && typeof row === 'object')
            .slice()
            .sort((left, right) => Number(right.seq) - Number(left.seq));
          const logPageCount = Math.max(1, Math.ceil(sortedLog.length / PAGE_SIZE));
          const safeLogPage = Math.min(logPage, logPageCount - 1);
          const logSlice = sortedLog.slice(safeLogPage * PAGE_SIZE, safeLogPage * PAGE_SIZE + PAGE_SIZE);

          children.push(h(
            'div',
            { className: 'stp-section', key: 'logSection' },
            h(
              'div',
              { className: 'stp-sectionHead' },
              h('div', { className: 'stp-sectionTitle' }, t('logsTitle')),
              h('div', { className: 'stp-count' }, String(state.log.length) + ' ' + t('records')),
            ),
            h('div', { className: 'stp-hint', key: 'logsHint' }, t('logsHint')),
            sortedLog.length === 0
              ? h('div', { className: 'stp-empty' }, t('noLogs'))
              : h('div', { className: 'stp-list' }, logSlice.map((row, index) => h(
                'div',
                { className: 'stp-item', key: String(row.seq === undefined ? index : row.seq) },
                h(
                  'div',
                  { className: 'stp-itemTitleRow' },
                  h(
                    'span',
                    { className: 'stp-itemTitle', title: row.taskId === undefined ? '' : String(row.taskId) },
                    row.title === undefined ? String(row.taskId) : String(row.title),
                  ),
                  h('span', { className: 'stp-badge' }, row.trigger === 'manual' ? t('triggerManual') : t('triggerSchedule')),
                ),
                h('div', { className: 'stp-logList' }, renderLogRow(row, index, t)),
              ))),
            renderPager({
              page: safeLogPage,
              pageCount: logPageCount,
              total: sortedLog.length,
              from: safeLogPage * PAGE_SIZE + 1,
              to: safeLogPage * PAGE_SIZE + logSlice.length,
              onPrev: () => setLogPage(Math.max(0, safeLogPage - 1)),
              onNext: () => setLogPage(Math.min(logPageCount - 1, safeLogPage + 1)),
              t,
            }),
          ));
        }

        if (state.readOnly === true) children.push(h('div', { className: 'stp-warn', key: 'readonly' }, t('readOnly')));
        if (state.error !== null && state.error !== undefined && state.error !== '') {
          children.push(h('div', { className: 'stp-error', key: 'error' }, String(state.error)));
        }
        if (note !== null) children.push(h('div', { className: 'stp-note', key: 'note' }, note));

        return h('div', { className: 'stp-root' }, h('div', { className: 'stp-inner' }, children));
      }

      return { PanelIcon, TasksPage };
    }

    /* ---------------------------------------------------------------- */
    /* 插件                                                              */
    /* ---------------------------------------------------------------- */

    const inject = ['slots', 'locale', 'remote', 'remote.settings'];

    /** 同一 ctx 重复 apply 时不重复注册（幂等）。 */
    const disposers = new WeakMap();

    function apply(ctx) {
      if (isObject(ctx) && disposers.has(ctx)) return disposers.get(ctx);

      const cleanups = [];
      /** 有 ctx.effect 就用它收尾；没有就直接用组件自己的 dispose，apply 的返回值同样能收尾。 */
      const use = (fn, label) => {
        if (typeof ctx.effect === 'function') {
          const disposer = ctx.effect(fn, label);
          if (typeof disposer === 'function') cleanups.push(disposer);
          return;
        }
        const disposer = fn();
        if (typeof disposer === 'function') cleanups.push(disposer);
      };

      // 样式：只在 apply 内插入，卸载时移除。
      use(() => {
        const tagId = 'dsh-plugin-scheduled-tasks/styles.css';
        if (typeof document === 'undefined') return () => {};
        if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') !== null) return () => {};
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-plugin-scheduled-tasks';
        tag.dataset.pluginCss = tagId;
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => { tag.remove(); };
      }, 'scheduled-tasks: styles');

      // 文案：走 Client locale 服务，界面文字不写死在组件里。
      let t = (key) => (zh[key] === undefined ? key : zh[key]);
      try {
        use(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'scheduled-tasks: locale');
        const bound = ctx.locale.bind(LOCALE_NS);
        if (typeof bound === 'function') t = bound;
      } catch (error) {
        console.error('[scheduled-tasks] locale unavailable, falling back to built-in copy', error);
      }

      const settings = isObject(ctx.remote) ? ctx.remote.settings : undefined;
      const api = {
        t,
        available: isObject(settings),
        describe: () => {
          if (typeof settings.describe !== 'function') throw new Error('remote.settings.describe is unavailable');
          return settings.describe();
        },
        mutate: (ops, revision) => {
          if (typeof settings.mutate !== 'function') throw new Error('remote.settings.mutate is unavailable');
          return settings.mutate(CONFIG_NS, ops, revision);
        },
      };

      const views = createViews(api);

      // 两个席位都是 root scope、注册形状固定：main 不接 session props，页面依赖的
      // 一切都在 apply 作用域里闭包拿到，所以注册选项里不放 inject。
      //
      // 必须走 `ctx.slots.inject(ownerKey, …)`，**不能**裸调 `ctx.slots.register`。
      //
      // 真实事故（2026-09-25）：裸注册在 boot 时抛
      //   Error: slot "sidebar.panellist" is not declared
      //   （a parent entry's children table must declare it）
      // 因为浏览器 bundle 的执行顺序由 combo 决定，本包可能排在"声明这些 slot 的
      // 那些包"之前。错误从 ctx.effect 的回调里抛出，Cordis 把该 effect 记为失败，
      // 于是整个 entry 被判为未激活 —— 用户看到的就是启动失败对话框：
      //   web boot: 1 entry did not activate
      //   dsh-plugin-scheduled-tasks: failed
      // 官方 practices.md 的写法正是 inject：
      //   Contribute through slots: `ctx.slots.inject(ownerKey, () => ctx.slots.register(...))`.
      //   The callback's registrations are disposed when the owning declaration
      //   collapses and reinstalled when it returns.
      use(() => {
        const offs = [];
        const contribute = (ownerKey, options, Component) => {
          if (typeof ctx.slots?.inject !== 'function' || typeof ctx.slots?.register !== 'function') return;
          const off = ctx.slots.inject(ownerKey, () => ctx.slots.register(options, Component));
          if (typeof off === 'function') offs.push(off);
        };
        contribute('sidebar.panellist', { name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => t('panelLabel') }, views.PanelIcon);
        contribute('main', { name: 'main', key: PANEL_ID }, views.TasksPage);
        return () => {
          for (const off of offs) {
            try {
              off();
            } catch {
              /* ignore */
            }
          }
        };
      }, 'scheduled-tasks: slots');

      const dispose = () => {
        for (let index = cleanups.length - 1; index >= 0; index -= 1) {
          try {
            cleanups[index]();
          } catch (error) {
            console.error('[scheduled-tasks] cleanup failed', error);
          }
        }
        cleanups.length = 0;
      };
      if (isObject(ctx)) disposers.set(ctx, dispose);
      return dispose;
    }

    /*
     * 测试接缝：把纯映射函数暴露给自检脚本。Cordis 只读
     * `inject` / `apply` / `name` / `Config`，多余导出会被忽略。
     */
    const internals = {
      panelId: PANEL_ID,
      configNs: CONFIG_NS,
      NS: CONFIG_NS,
      PANEL_ID,
      LOG_VIEW_LIMIT,
      EVERY_MIN,
      EVERY_MAX,
      MANUAL_RUN_TTL,
      localeNs: LOCALE_NS,
      describeSchedule,
      statusKey,
      parseCronField,
      parseCronFields,
      nextCronTime,
      nextScheduleTime,
      buildTaskFromDraft: (draft, nowMs) => {
        // 供自检脚本使用的最小封装：形状与页面里的 buildTask 相同。
        const schedule = draft.schedule;
        const now = Number.isFinite(nowMs) ? nowMs : Date.now();
        return withNextRun({
          id: draft.id === undefined ? newTaskId(now) : draft.id,
          title: String(draft.title),
          prompt: String(draft.prompt),
          enabled: draft.enabled !== false,
          schedule,
          createdAt: now,
          updatedAt: now,
        }, now);
      },
      withNextRun,
      newTaskId,
      formatTime,
      inputStamp,
      emptyDraft,
    };

    return { inject, apply, __internals: internals };
  },
});
