/**
 * 「Token 用量」插件 —— 浏览器侧。
 *
 * 两个界面，各自用能走通的那条数据通道：
 *
 *   1. `conversation.session.header.utilities`（会话作用域，list 席位）
 *      实时显示**本次会话**按模型拆分的用量。数据来自宿主投影
 *      `tokenByModel` 的 `wire.view`，用 owner 传下来的 `useProjection`
 *      读取——官方实践明确要求：会话派生值由宿主算好，客户端不折叠事件。
 *
 *   2. `sidebar.panellist` + `main`（root 作用域）
 *      **跨会话**按模型汇总。这个量不属于任何单个会话，装不进会话投影，
 *      所以宿主扫描历史日志后写进设置，客户端用 `remote.settings.describe()`
 *      读回。这条路在定时任务插件里已被真机验证。
 *
 * 工厂无副作用：样式、locale、席位注册一律在 apply 内建立并用 ctx.effect 收尾。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-token-usage',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** 文案命名空间；与包名分开，避免和宿主命名空间撞车。 */
    const LOCALE_NS = 'plugin.token-usage';
    /** 面板 id：`sidebar.panellist` 的 id 与 `main` 的 key 必须一致。 */
    const PANEL_ID = 'token-usage';
    /** 设置命名空间，等于本插件 Loader 行 id。 */
    const CONFIG_NS = 'token-usage';
    /** 宿主注册的会话投影 key。 */
    const PROJECTION_KEY = 'tokenByModel';
    /** 跨会话表每页行数。 */
    const PAGE_SIZE = 20;

    /* ---------------------------------------------------------------- */
    /* 文案                                                              */
    /* ---------------------------------------------------------------- */

    const zh = {
      panelLabel: 'Token 用量',
      title: 'Token 用量',
      subtree: '提供方上报的 token 消耗，按模型归并；不做任何估算。',
      colModel: '模型',
      colInput: '输入',
      colOutput: '输出',
      colCacheRead: '缓存读',
      colCacheWrite: '缓存写',
      colTotal: '合计',
      colShare: '占比',
      refresh: '刷新',
      refreshing: '扫描中…',
      emptyAll: '已扫描的会话里还没有记录 token 用量。',
      scanNote: '已扫描 {scanned} / {total} 个会话。',
      scanTruncatedAll: '只扫描了最近的 {scanned} / {total} 个会话，更早的未计入。',
      skipped: '（{count} 个会话日志读取失败，已跳过）',
      builtAt: '上次扫描：{time}',
      never: '从未',
      requested: '已排入刷新请求，宿主下一轮扫描后出现结果。',
      notPersistent: '当前 profile 无法写入设置，刷新按钮不可用。',
      loadFailed: '读取汇总失败：{reason}',
      meterAria: '本会话 token 用量：{total}。展开按模型明细。',
      meterTitle: '本次会话',
      meterEmpty: '本次会话还没有上报用量。',
      meterHint: '只统计提供方上报的用量。',
      meterUnsupported: '本 profile 未提供会话投影，无法实时显示。',
      unattributed: '未归属模型',
      attempts: '{count} 次调用',
      bIn: '输入',
      bOut: '输出',
      bCacheRead: '缓存读',
      bCacheWrite: '缓存写',
      chartAria: '{model}（{provider}）合计 {total} token',
      chartModels: '按模型占比',
      chartTrend: '按天趋势',
      chartComposition: '按模型构成',
      donutAria: '环形图：按模型占比，共 {total} token',
      segmentAria: '{model}：{share}% 合计 {total} token',
      donutCenter: '合计',
      trendEmpty: '这段时间没有用量。',
      pointAria: '{day}：{total} token',
      heatLess: '少',
      heatMore: '多',
      loading: '载入中…',
      close: '关闭',
    };

    const en = {
      panelLabel: 'Token usage',
      title: 'Token usage',
      subtree: 'Provider-reported token consumption, grouped by model. No estimates.',
      colModel: 'Model',
      colInput: 'Input',
      colOutput: 'Output',
      colCacheRead: 'Cache read',
      colCacheWrite: 'Cache write',
      colTotal: 'Total',
      colShare: 'Share',
      refresh: 'Refresh',
      refreshing: 'Scanning…',
      emptyAll: 'No token usage recorded in any scanned session yet.',
      scanNote: 'Scanned {scanned} of {total} sessions.',
      scanTruncatedAll: 'Scanned the {scanned} most recent of {total} sessions; older ones are not included.',
      skipped: ' ({count} session logs could not be read and were skipped)',
      builtAt: 'Last scan: {time}',
      never: 'never',
      requested: 'A refresh has been queued; results appear on the next Host pass.',
      notPersistent: 'This profile cannot persist settings, so refresh is unavailable.',
      loadFailed: 'Could not read the summary: {reason}',
      meterAria: 'Token usage in this session: {total}. Open the per-model breakdown.',
      meterTitle: 'This session',
      meterEmpty: 'No usage reported in this session yet.',
      meterHint: 'Provider-reported usage only.',
      meterUnsupported: 'This profile provides no session projections, so live usage is unavailable.',
      unattributed: 'Unattributed',
      attempts: '{count} calls',
      bIn: 'In',
      bOut: 'Out',
      bCacheRead: 'Cache R',
      bCacheWrite: 'Cache W',
      chartAria: '{model} ({provider}), {total} tokens total',
      chartModels: 'Share by model',
      chartTrend: 'Trend by day',
      chartComposition: 'Composition by model',
      donutAria: 'Donut chart: share by model, {total} tokens total',
      segmentAria: '{model}: {share}%, {total} tokens',
      donutCenter: 'Total',
      trendEmpty: 'No usage recorded in this period.',
      pointAria: '{day}: {total} tokens',
      heatLess: 'Less',
      heatMore: 'More',
      loading: 'Loading…',
      close: 'Close',
    };

    /* ---------------------------------------------------------------- */
    /* 样式                                                              */
    /* ---------------------------------------------------------------- */

    /* 全部颜色走 --dsw-alias-* 主题令牌：令牌改名只会降级外观，不会渲染失败。 */
    const CSS = [
      /*
       * 根容器：**自己滚动**，限宽交给子元素。
       *
       * 真机事故：原先写成 `max-width:980px;margin:0 auto` 且不自建滚动，
       * 以为"外壳会滚"。实际 `main` 席位不给滚动容器——超出窗口的内容直接
       * 看不见，连滚动条都没有。
       *
       * 已发布页面的约定（dsh-client-ui-plugin-manager 的 _.page）：
       *   height:100%; display:flex; flex-direction:column; overflow:auto;
       *   且 `> * { width:100%; max-width:960px }` —— 限宽在子元素上。
       * 照它写。
       */
      '.stu-inner{box-sizing:border-box;height:100%;display:flex;flex-direction:column;align-items:center;gap:14px;padding:20px 24px 40px;overflow:auto}',
      '.stu-inner>*{width:100%;max-width:980px}',
      '.stu-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}',
      '.stu-title{font-size:16px;font-weight:600;line-height:24px;color:var(--dsw-alias-label-primary)}',
      '.stu-sub{margin-top:2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.stu-btn{display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap}',
      '.stu-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}',
      '.stu-btn:disabled{opacity:.55;cursor:default}',
      /* 表格用固定布局 + 数字列右对齐：不这么做，行与行之间的小数位会对不齐。 */
      '.stu-table{width:100%;border-collapse:collapse;font-size:13px;line-height:20px}',
      '.stu-table th{text-align:left;font-weight:500;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);padding:0 10px 8px 0;border-bottom:.5px solid var(--dsw-alias-border-l1);white-space:nowrap}',
      '.stu-table td{padding:8px 10px 8px 0;border-bottom:.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);vertical-align:top}',
      '.stu-table tr:last-child td{border-bottom:0}',
      '.stu-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.stu-model{display:flex;flex-direction:column;gap:1px;min-width:0}',
      '.stu-modelName{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.stu-provider{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.stu-nameCol{width:34%}',
      '.stu-totalCell{font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.stu-foot{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);display:flex;flex-direction:column;gap:4px}',
      '.stu-empty{padding:28px 0;text-align:center;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}',
      '.stu-error{padding:10px 12px;border:.5px solid var(--dsw-alias-state-error-primary);border-radius:8px;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}',
      /* ---- 图表：横向堆叠条 ---------------------------------------- */
      /*
       * 四段只用同一个品牌色的不同透明度，而不是四个不同语义色。
       * 理由：主题令牌里没有"分类色板"，硬借 state-* 会把"缓存读"染成警告色
       * 这类误读。用同色深浅 + 段内直接标数值，颜色只负责分组，读数不依赖颜色，
       * 浅色/深色主题下都不会失效。
       */
      '.stu-chart{display:flex;flex-direction:column;gap:12px;padding:14px;border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}',
      '.stu-chartRow{display:flex;flex-direction:column;gap:5px;min-width:0}',
      '.stu-chartHead{display:flex;align-items:baseline;justify-content:space-between;gap:10px;min-width:0}',
      '.stu-chartName{font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.stu-chartProvider{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.stu-chartTotal{font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;white-space:nowrap}',
      /* 轨道高度固定，条形按占比填满；min-width 保证极小段也看得见 */
      '.stu-chartTrack{display:flex;width:100%;height:14px;border-radius:3px;overflow:hidden;background:var(--dsw-alias-bg-layer-2)}',
      '.stu-seg{height:100%;min-width:2px}',
      /*
       * 图表系列色用**字面色**，这是刻意的例外，理由是可验证的：
       *
       * 1. `--dsw-alias-brand-primary` 在本主题里是**高对比前景色**（浅色主题下近黑、
       *    深色主题下近白），不是彩色强调色。拿它当分类色，圆环就呈"黑 / 绿 /
       *    浅灰"——真机截图两次确认，两次"丑"的反馈都源于此。
       * 2. 主题里唯一真正有色的令牌只有 state-success（绿）/ warn（琥珀）/
       *    error（红）/ idle（灰）。四路分类里放红色会给"缓存写"凭空加上失败
       *    的含义，而灰色与浅色轨道底几乎同色、等于看不见。
       * 3. 所以可用的分类色板实际上并不存在。字面色是唯一能给出四个可分辨、
       *    且明暗主题下都成立的色相的办法。
       *
       * 取值与三个插件的图标同一套官方色（蓝 / 绿 / 紫 / 琥珀），因此图表与图标
       * 自洽；都是中间调饱和度，白底与近黑底上都清晰。
       */
      '.stu-seg[data-bucket="uncachedInputTokens"]{background:#4D6BFE}',
      '.stu-seg[data-bucket="outputTokens"]{background:#22C55E}',
      '.stu-seg[data-bucket="cacheReadTokens"]{background:#8B5CF6}',
      '.stu-seg[data-bucket="cacheWriteTokens"]{background:#F5A524}',
      '.stu-legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
      '.stu-legendItem{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}',
      '.stu-swatch{width:9px;height:9px;border-radius:2px;flex:none}',
      '.stu-swatch[data-bucket="uncachedInputTokens"]{background:#4D6BFE}',
      '.stu-swatch[data-bucket="outputTokens"]{background:#22C55E}',
      '.stu-swatch[data-bucket="cacheReadTokens"]{background:#8B5CF6}',
      '.stu-swatch[data-bucket="cacheWriteTokens"]{background:#F5A524}',
      '.stu-legendValue{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
      /* ---- 图表：环形图（按模型占比） ------------------------------ */
      /*
       * 环形图回答"谁占大头"，堆叠条回答"每个模型的内部构成"，折线回答"什么时候用的"。
       * 三个问题不同，所以是三个视图而不是一个——之前只有堆叠条，于是"哪几天用量暴涨"
       * 和"整体份额"这两件事在界面上没有表达。
       */
      '.stu-figure{display:flex;flex-direction:column;gap:10px;padding:14px;border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}',
      '.stu-figureHead{font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-primary)}',
      /*
       * 环形用 grid 而不是 flex：图例条数不固定，flex 下长图例会把圆环挤扁成椭圆。
       * 环宽固定、图例占剩余宽度，模型再多也只会把图例换行。
       */
      '.stu-donut{display:grid;grid-template-columns:132px minmax(0,1fr);gap:16px;align-items:center}',
      '.stu-donutWrap{position:relative;width:132px;height:132px}',
      '.stu-donutSvg{display:block;width:100%;height:100%}',
      '.stu-donutTrack{stroke:var(--dsw-alias-bg-layer-2)}',
      /*
       * 段色按模型次序取四个**实色令牌**，与四桶共用同一套分类色。
       *
       * 原先是"品牌色按次序降透明度"，真机反馈是"黑灰、不好看"——低透明度叠在
       * 暗色背景上就等于深灰。颜色只负责分组，读数看图例与数值，所以借 state-*
       * 当分类色的语义代价可以接受，"看不见"则不可接受。
       */
      /*
       * 段色按模型次序取四色，与四桶共用同一套字面色板（理由见上方四桶处）。
       *
       * `--dsw-alias-brand-primary` 在本主题里是黑白高对比色而非彩色，所以
       * `[data-series="0"]` 也必须显式给色，不能靠 `.stu-donutSeg` 的默认值。
       */
      '.stu-donutSeg{stroke:#4D6BFE}',
      '.stu-donutSeg[data-series="1"]{stroke:#22C55E}',
      '.stu-donutSeg[data-series="2"]{stroke:#8B5CF6}',
      '.stu-donutSeg[data-series="3"]{stroke:#F5A524}',
      '.stu-donutSwatch[data-series="0"]{background:#4D6BFE}',
      '.stu-donutSwatch[data-series="1"]{background:#22C55E}',
      '.stu-donutSwatch[data-series="2"]{background:#8B5CF6}',
      '.stu-donutSwatch[data-series="3"]{background:#F5A524}',
      /* 圆环中心的总量：absolute 定位，避免再叠一层 SVG 文本节点（跨浏览器基线不稳）。 */
      '.stu-donutCenter{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;pointer-events:none}',
      '.stu-donutTotal{font-size:15px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
      '.stu-donutCaption{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
      '.stu-donutLegend{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.stu-donutItem{display:flex;align-items:baseline;gap:8px;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}',
      '.stu-donutSwatch{width:9px;height:9px;border-radius:2px;flex:none}',
      '.stu-donutName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.stu-donutShare{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.stu-donutValue{color:var(--dsw-alias-label-primary);font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap}',
      /* ---- 图表：按天热力图（GitHub 贡献图那种） -------------------- */
      /*
       * 为什么网格用 CSS grid 而不是 SVG：热力图的格子必须是**正方形**。
       * SVG 要自适应宽度就得给 preserveAspectRatio="none"，那会把 `rect` 连同任何
       * 圆角一起非等比拉伸；上一版折线图的圆点就是被压成横向椭圆才挪出 SVG 的。
       * 固定 px 的 div + CSS grid 没有这个问题，而且格子的 title 是原生 tooltip。
       *
       * 列 = 周、行 = 星期（0=周日）。列宽写死 14px（11px 格子 + 3px 间距），
       * 于是 53 列 = 742px，能塞进 980px 的限宽；再宽就由外层横向滚动，**不压缩格子**
       * ——格子一旦被压缩，深浅与面积就对不上，图会撒谎。
       */
      '.stu-heatScroll{display:flex;align-items:flex-start;width:100%;overflow-x:auto;overflow-y:hidden}',
      /*
       * 左侧星期标签**吸附**在滚动容器左边（sticky 而不是独立一列）：
       * 独立一列要么跟着滚动（横滚后看不见），要么与右侧的列宽各自为政，
       * 上下两处一旦对不齐，读者会把格子数错一行。
       */
      '.stu-heatLabels{position:sticky;left:0;z-index:1;flex:none;width:26px;display:flex;flex-direction:column;gap:3px;background:var(--dsw-alias-bg-layer-1)}',
      /* 占位块的高度必须等于月份带（16px），否则星期一那一行的标签会整体错位一格。 */
      '.stu-heatLabelSpacer{height:16px;flex:none}',
      '.stu-heatLabelCell{height:11px;flex:none;font-size:9px;line-height:11px;color:var(--dsw-alias-label-secondary)}',
      '.stu-heatInner{display:flex;flex-direction:column;gap:3px}',
      /*
       * 月份带：与网格**共用同一套列轨道**，格子里的月份文字允许溢出到相邻轨道
       * （overflow:visible 是 grid item 的默认值），这样"月份"标在该月第一列的正上方，
       * 而不会把后面的列推歪。只在新月份的第一列出现，否则 53 列会标成一排糊。
       */
      '.stu-heatMonths{display:grid;grid-template-columns:repeat(var(--stu-heat-weeks),14px);gap:3px;height:16px}',
      '.stu-heatMonth{font-size:9px;line-height:16px;white-space:nowrap;color:var(--dsw-alias-label-secondary)}',
      '.stu-heatBody{display:grid;grid-template-columns:repeat(var(--stu-heat-weeks),14px);gap:3px}',
      /*
       * 格子尺寸写死在 `.stu-heatBody` 的列轨道（14px = 11px 格子 + 3px 间距）与
       * `.stu-heatCell` 两处，必须同步：只改一处会让列轨道与格子宽度脱钩，
       * 格子被拉伸成矩形，而图照画不误。
       */
      '.stu-heatCell{width:11px;height:11px;border-radius:2px;background:var(--dsw-alias-bg-layer-2)}',
      /*
       * level 0 = "这一天没有用量"，用底色令牌——**不是**第 5 档强度。
       * 它写在 `.stu-heatCell` 的基础规则里，不再单独来一条 `[data-level="0"]`：
       * 基础规则已经覆盖它，多一条只会多一处需要同步的声明。
       *
       * 1..4 档刻意用同一个色相的**不透明度**而不是四个色相：这里表达的是
       * "深浅 = 多少"的**序数**关系，用分类色（四个色相）会让读者以为四档是四种
       * 互相独立的类别，读不出大小。四个声明里只出现一个色值，白名单见
       * verify-layout.mjs 的 CHART_COLOR_RULE。
       *
       * 写 `#4D6BFE38` 这种八位十六进制而不是 `rgba(77,107,254,.22)`：
       * 白名单是**按色值**比对的，rgba 形式无法与 CHART_PALETTE 里的四个值对齐，
       * 只能再放宽一条规则；而"收紧成白名单"正是这套断言的价值所在。
       *
       * 建议档位 .22 / .45 / .72 / 1：最低档在浅色与深色主题下都还看得见，
       * 又不至于让"很少"和"没有"（level 0 的底色）混淆。
       */
      '.stu-heatCell[data-level="1"]{background:#4D6BFE38}',
      '.stu-heatCell[data-level="2"]{background:#4D6BFE73}',
      '.stu-heatCell[data-level="3"]{background:#4D6BFEB8}',
      '.stu-heatCell[data-level="4"]{background:#4D6BFE}',
      /* 图例：左边"少"，右边"多"，中间五档色块按深浅排开。 */
      '.stu-heatLegend{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:10px;line-height:14px;color:var(--dsw-alias-label-secondary)}',
      '.stu-heatLegendScale{display:inline-flex;align-items:center;gap:4px}',
      '.stu-heatEmpty{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.stu-notice{padding:8px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.stu-bar{height:4px;border-radius:2px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;margin-top:6px}',
      '.stu-barFill{height:100%;background:var(--dsw-alias-brand-primary)}',
      '.stu-footRow{display:flex;align-items:center;justify-content:space-between;gap:12px}',
      '.stu-pager{display:flex;align-items:center;gap:6px}',
      '.stu-pageInfo{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.stu-btnSm{height:24px;padding:0 8px;font-size:11px}',
      /* 会话头部角标：紧凑按钮 + 自绘浮层（不 import primitives） */
      '.stu-meterRoot{position:relative;display:inline-flex;align-items:center}',
      '.stu-meterBtn{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px;border:.5px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;cursor:pointer;font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.stu-meterBtn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.stu-meterBtn[aria-expanded="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.stu-meterDot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary)}',
      '.stu-pop{position:absolute;top:calc(100% + 8px);right:0;z-index:40;width:320px;max-width:calc(100vw - 32px);padding:12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-overlay);box-shadow:0 8px 24px rgba(0,0,0,.16);display:flex;flex-direction:column;gap:10px}',
      '.stu-popHead{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-primary)}',
      '.stu-popTotal{font-size:20px;font-weight:600;line-height:26px;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
      '.stu-popList{display:flex;flex-direction:column;gap:8px;max-height:260px;overflow-y:auto}',
      '.stu-popRow{display:flex;flex-direction:column;gap:3px;min-width:0}',
      '.stu-popTop{display:flex;align-items:baseline;justify-content:space-between;gap:8px}',
      '.stu-popModel{font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.stu-popVal{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.stu-popHint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
      /* 四桶分解：2 列网格而不是一行四项——浮层宽度 320px，四个中文标签横排会挤到换行， */
      /* 换行后列与列对不齐，比不显示还难看。 */
      '.stu-popBuckets{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:2px 12px;margin-top:2px}',
      '.stu-popBucket{display:flex;align-items:baseline;justify-content:space-between;gap:6px;min-width:0}',
      '.stu-popBucketLabel{font-style:normal;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.stu-popBucketValue{font-size:11px;line-height:16px;font-weight:500;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.stu-popEmpty{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
    ].join('\n');

    /* ---------------------------------------------------------------- */
    /* 纯工具（与 lib/fold.js 保持同一口径）                              */
    /* ---------------------------------------------------------------- */

    /*
     * 为什么这里要重复一份 formatTokens：
     * 浏览器侧是独立的 bundle，只经 `__ModuleLoader__` 注册，工厂只拿到 `require`，
     * 无法 import 宿主的 `lib/fold.js`（它不在 boot graph 里）。
     * 重复是不得已，所以契约里把它列为必须一致的实现，并由 verify-contract
     * 逐值比对两份实现——重复但被验证，而不是重复且可能漂移。
     */
    function formatTokens(value) {
      if (!Number.isFinite(value) || value < 0) return '0';
      const rounded = Math.floor(value);
      if (rounded >= 1e9) return scale(rounded / 1e9) + 'B';
      if (rounded >= 1e6) return scale(rounded / 1e6) + 'M';
      if (rounded >= 1e3) return scale(rounded / 1e3) + 'K';
      return String(rounded);
    }

    function scale(value) {
      return value >= 100 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
    }

    function formatExact(value) {
      if (!Number.isFinite(value) || value < 0) return '0';
      return String(Math.floor(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    function totalOf(buckets) {
      if (buckets === null || typeof buckets !== 'object') return 0;
      let sum = 0;
      for (const key of ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
        const value = buckets[key];
        if (Number.isFinite(value) && value > 0) sum += value;
      }
      return sum;
    }

    function isObject(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    /** 把 `{name}` 占位符替换掉；缺值时保留原样便于发现。 */
    function fill(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match);
    }

    /** 本地时间戳：精确到分钟就够，秒没有信息量。 */
    function stampOf(ms) {
      if (!Number.isFinite(ms)) return null;
      const date = new Date(ms);
      const pad = (value) => String(value).padStart(2, '0');
      return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
        + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
    }

    /**
     * 从 `remote.settings.describe()` 的结果里取跨会话汇总。
     *
     * **`describe()` 返回的是信封，不是数组。** 真实形状是
     * `{ ok: true, value: { revision, writable, namespaces: [...] } }`，
     * 条目在 `response.value.namespaces` 里。当初这里写成
     * `if (!Array.isArray(entries)) return null`，于是永远判空——
     * 页面上就只是"没有数据"，不报错、不留痕。
     * 姊妹插件（已真机验证）读的是同一条路，照它写。
     *
     * 层：`entry.value` 是解析后的值（`internal` 通常在这里），
     * `entry.user` 是用户层原始值。两层都看，用户层优先。
     */
    function readSummary(response) {
      if (!isObject(response) || response.ok !== true || !isObject(response.value)) {
        return { summary: null, persistent: false };
      }
      const view = response.value;
      const entries = Array.isArray(view.namespaces) ? view.namespaces : [];
      const entry = entries.find((candidate) => isObject(candidate) && candidate.ns === CONFIG_NS);
      if (entry === undefined) return { summary: null, persistent: true };
      const user = isObject(entry.user) ? entry.user : undefined;
      const value = isObject(entry.value) ? entry.value : undefined;
      const summary = (user?.internal?.summary) ?? (value?.internal?.summary) ?? null;
      return { summary: isObject(summary) ? summary : null, persistent: true };
    }

    /** 四桶的展示顺序与文案键。 */
    const CHART_BUCKETS = [
      ['uncachedInputTokens', 'bIn'],
      ['outputTokens', 'bOut'],
      ['cacheReadTokens', 'bCacheRead'],
      ['cacheWriteTokens', 'bCacheWrite'],
    ];

    /**
     * 环形图与四桶共用的**分类色档数**（4 档：brand / success / idle / warn）。
     *
     * 原先这里是四档**透明度**，真机反馈"黑灰、不好看"——`opacity:.24` 叠在暗色
     * 背景上等于深灰。主题没有分类色板，所以借 state-* 当分类色；颜色只负责分组，
     * 图例与数值负责读数，所以语义名的代价可以接受。第 5 个模型与第 1 个同色，
     * 这也是图例必须直接写名字与数值的原因。
     */
    const SEGMENT_SERIES = 4;

    /**
     * 横向堆叠条形图：每个模型一条，四段 = 四个桶。
     *
     * 为什么不画饼图：这里 cacheRead 常占九成以上，饼图会把其余三段压成看不清的
     * 细线。堆叠条同时回答两个问题——
     *   - **谁大**：条长按「该模型总量 / 最大总量」归一，跨模型直接比长短；
     *   - **构成**：段宽按「该桶 / 该模型总量」分配，看的是内部比例。
     * 两者分开算，所以大模型的内部构成和小模型的一样可读。
     *
     * 数值在每段图例里直接给出：颜色只负责分组，读数不依赖颜色，
     * 浅色/深色主题下都不会失真。
     */
    function renderChart(rows, t) {
      if (!Array.isArray(rows) || rows.length === 0) return null;
      const max = rows.reduce((peak, row) => Math.max(peak, Number.isFinite(row.total) ? row.total : 0), 0);
      return h('section', { className: 'stu-figure', key: 'chart' },
        h('div', { className: 'stu-figureHead' }, t('chartComposition')),
        h('div', { className: 'stu-chart' },
        rows.map((row) => {
          const total = Number.isFinite(row.total) ? row.total : 0;
          const segments = CHART_BUCKETS
            .map(([bucket, labelKey]) => ({
              bucket,
              labelKey,
              value: Number.isFinite(row.buckets?.[bucket]) ? row.buckets[bucket] : 0,
            }))
            .filter((segment) => segment.value > 0);
          const label = fill(t('chartAria'), {
            model: row.model === 'unknown' ? t('unattributed') : row.model,
            provider: row.provider,
            total: formatExact(total),
          });
          return h('div', { className: 'stu-chartRow', key: row.key },
            h('div', { className: 'stu-chartHead' },
              h('span', { className: 'stu-chartName', title: row.model + ' · ' + row.provider },
                row.model === 'unknown' ? t('unattributed') : row.model,
                ' ',
                h('span', { className: 'stu-chartProvider' }, row.provider)),
              h('span', { className: 'stu-chartTotal' }, formatExact(total))),
            h('div', {
              className: 'stu-chartTrack',
              role: 'img',
              'aria-label': label,
              title: label,
            },
              segments.map((segment) => h('div', {
                key: segment.bucket,
                className: 'stu-seg',
                'data-bucket': segment.bucket,
                // 段宽 = 该桶 / 全局最大总量。和起来就是 total/max —— 条长比大小、
                // 段宽看构成，一次归一同时满足两者。
                style: { width: (max > 0 ? (segment.value / max) * 100 : 0) + '%' },
              }))),
            h('div', { className: 'stu-legend' },
              segments.map((segment) => h('span', { className: 'stu-legendItem', key: segment.bucket },
                h('i', { className: 'stu-swatch', 'data-bucket': segment.bucket }),
                t(segment.labelKey),
                ' ',
                h('b', { className: 'stu-legendValue' }, formatExact(segment.value))))));
        })));
    }

    /**
     * 把汇总的 `timeline` 归一成界面用的序列。
     *
     * 三种"没有趋势可画"的情况在这里就归一到空数组，渲染层于是只有一条分支：
     *   - 字段**不存在**（旧数据、或宿主还没升级到写 timeline 的版本）；
     *   - 存在但不是数组（手工改过设置、或将来换成别的形状）；
     *   - 数组里没有一条带得上日期的记录。
     *
     * 为什么"没有 timeline"必须和"timeline 是空数组"走同一条降级路：
     * 二者在界面上是同一件事——没有可画的数据点。分开处理只会多一条永远走不到的
     * 分支，而漏处理其中一条的表现是"画出一条歪线"，不报错、最难查。
     *
     * 不做排序：契约规定宿主按 day 升序给。这里替它排一次序只会掩盖宿主侧的顺序
     * 漂移（线上看到的顺序就是真实顺序），而且 `day` 是本地日期字符串，重排还得
     * 依赖字符串比较的隐式约定。
     */
    function normaliseTimeline(summary) {
      const raw = Array.isArray(summary?.timeline) ? summary.timeline : [];
      const out = [];
      for (const item of raw) {
        if (!isObject(item) || typeof item.day !== 'string' || item.day === '') continue;
        const total = Number.isFinite(item.total) && item.total > 0 ? item.total : 0;
        out.push({ day: item.day, total });
      }
      return out;
    }

    /**
     * `2026-06-01` / `2026-6-1` → `06-01`。
     *
     * 手工拆字符串而不是 `new Date(day)`：日期字符串没有时区，`new Date` 会按 UTC
     * 解析再按本地时区回读，西半球时区下整条趋势会**整体偏移一天**——今天的数据
     * 标成昨天。偏移一天不会报错，只会让人对着错误的日期找原因。
     */
    function shortDay(day) {
      const match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(day));
      if (match === null) return String(day);
      const pad = (value) => value.padStart(2, '0');
      return pad(match[2]) + '-' + pad(match[3]);
    }

    /**
     * `YYYY-MM-DD` / `YYYY-M-D` → `Date`（**本地**零点）。
     *
     * 刻意不用 `new Date(day)` 或 `Date.parse(day)`：日期字符串没有时区，这两种
     * 解析都按 **UTC** 处理再按本地时区回读，东八区会整体偏一天（周日算成周六，
     * 整个热力图的行会错位一格）；西半球同理偏回去。偏一天不报错，只是所有格子
     * 都画到了错误的星期几上——最难查的一类错。
     *
     * 解析不出年月日时返回 null，由调用方降级，而不是抛。
     */
    function parseDay(day) {
      const match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(day));
      if (match === null) return null;
      const year = Number(match[1]);
      const month = Number(match[2]);
      const date = Number(match[3]);
      if (month < 1 || month > 12 || date < 1 || date > 31) return null;
      // `new Date(y, m-1, d)` 走本地时区，与 `getDay()` / `setDate()` 同一套语义。
      return new Date(year, month - 1, date);
    }

    /** 本地日期加减天数；用 `setDate` 跨月跨年由宿主 Date 自己处理，不必手算。 */
    function shiftDay(date, delta) {
      return new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta);
    }

    /**
     * `Date` → `YYYY-MM-DD`（本地）。
     *
     * **不能用 `toISOString().slice(0, 10)`**：那按 UTC 输出，东八区的本地零点
     * 会退回前一天，热力图的每一格都会挪到错误的日期上（错一天不报错）。
     */
    function dayKey(date) {
      const pad = (value) => String(value).padStart(2, '0');
      return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
    }

    /**
     * 热力图的强度档数：0 = 没有用量，1..4 = 有用量。
     *
     * 分档用 `total / max` 的**相对**比例，而不是绝对阈值：用量有两三个数量级的
     * 波动（真机上见过同一天 7e7 与 1.5e9 并存），写死绝对阈值在这批数据下只会
     * 把 7e7 判成最低档、让它看起来和"没有用量"差不多。
     */
    const HEAT_LEVELS = 4;

    /**
     * 一天的用量 → 强度档。
     *
     * 两个必须钉住的语义：
     *   1. `max <= 0`（全零 / 坏数据）时一律 level 0，**不做除法**：除零会给出 NaN，
     *      而 `NaN < 0.25` 是 false，格子会拿到 `data-level="NaN"`——颜色规则全都
     *      匹配不上，整块图变成一排无色方块，不报错。
     *   2. `total > 0` 时结果至少是 1，**不能是 0**：level 0 的语义是"这天没有用量"，
     *      一个刚好低于 `0.25 × max` 的极小值若落进 0，图就会说"这天没用过"。
     *      这也是"level 0 不参与 t/max 分档"的实现方式。
     */
    function heatLevel(total, max) {
      if (!(Number.isFinite(total) && total > 0) || !(Number.isFinite(max) && max > 0)) return 0;
      const ratio = total / max;
      if (ratio >= 1) return HEAT_LEVELS;
      if (ratio >= 0.72) return 3;
      if (ratio >= 0.45) return 2;
      if (ratio >= 0.25) return 1;
      return 0;
    }

    /** 同一档内至少要有 1，避免"极小但非零"被 heatLevel 的阈值判成 0。 */
    function levelOf(total, max) {
      if (!(Number.isFinite(total) && total > 0)) return 0;
      return Math.max(1, heatLevel(total, max));
    }

    /**
     * 把 `timeline` 排成热力图网格：**列 = 周、行 = 星期**（0=周日）。
     *
     * 三条几何约定，任何一条错了都不会抛错、只会让图错位或撒谎：
     *
     *   1. **起点是"最早那天所在周的周日"，终点是"最晚那天所在周的周六"。**
     *      起点若直接取最早那天本身，列就不再对齐到周：同一列里星期一和星期三
     *      会挤在一起，整个网格的"行 = 星期几"这个前提当场失效（负向对照 B 钉这条）。
     *   2. **区间内的每一天都要有格子，包括中间没数据的天。** 宿主只给有量的天
     *      （真机上两天之间隔了一周），不补 0 的话热力图会把 09-18 与 09-25 画成
     *      相邻两格，读者会以为中间那天有别的值。
     *   3. **首列起点之前、末列终点之后的格子是 null**，不画也不参与 hover。
     *      把它们画成 level 0 会让"这一天在统计范围外"和"这天没用过"混为一谈。
     *
     * 顺带把每天的 attempts 一起带出来（没有 attempts 的记录沿用调用方在
     * `normaliseTimeline` 里算好的值，这里再兜一次底）：将来要在 tooltip 里
     * 显示"几次调用"时不必再回查 timeline。
     */
    function heatmapGeometry(points) {
      const list = Array.isArray(points) ? points : [];
      const cells = new Map();
      let max = 0;

      for (const point of list) {
        if (!isObject(point)) continue;
        const date = parseDay(point.day);
        if (date === null) continue;
        const total = Number.isFinite(point.total) && point.total > 0 ? point.total : 0;
        // 同一天出现两条（宿主数据损坏）时取和：丢掉一条等于少算这一天的量。
        const bucket = cells.get(point.day);
        if (bucket === undefined) {
          cells.set(point.day, {
            day: point.day,
            date,
            total,
            attempts: Number.isFinite(point.attempts) && point.attempts > 0 ? point.attempts : 0,
          });
        } else {
          bucket.total += total;
          bucket.attempts += Number.isFinite(point.attempts) && point.attempts > 0 ? point.attempts : 0;
        }
        if (total > max) max = total;
      }

      // 一条可用记录都没有（缺 timeline / 空数组 / day 全是坏格式）：返回空网格，
      // 渲染层据此走空态。这里不抛，也不返回 null——上层只需要判 `days`。
      if (cells.size === 0) {
        return { weeks: [], columns: 0, days: 0, totalDays: 0, max: 0, from: null, to: null, weekStart: null, weekEnd: null };
      }

      // 首尾按**本地日期**比较，不按字符串：字符串比较要求宿主严格补零，
      // `2026-9-8` 与 `2026-10-01` 一比就错。
      let minDate = null;
      let maxDate = null;
      let from = null;
      let to = null;
      for (const cell of cells.values()) {
        if (minDate === null || cell.date < minDate) { minDate = cell.date; from = cell.day; }
        if (maxDate === null || cell.date > maxDate) { maxDate = cell.date; to = cell.day; }
      }

      // `getDay()` 就是本地星期（0=周日），往回退这么多天即本周周日。
      const start = shiftDay(minDate, -minDate.getDay());
      const end = shiftDay(maxDate, 6 - maxDate.getDay());
      /*
       * 列数 = ⌈（终点 − 起点）/ 7⌉。
       *
       * **不是 `除以 7 再取整 + 1`**：端点是周日..周六，所以 `end - start` 恰好是
       * `7 × (columns - 1)` 天。写成 `Math.round((end - start) / 86400000 / 7) + 1`
       * 会在 `end === start`（单天就在周六）时算出 2 列——多出一整列 7 个 null 占位，
       * 并顺带把月份带整体推后一列。这个 off-by-one 不报错，只是图右边多一条空白，
       * 而自检里"列数正好 N"的断言会立刻抓到。
       */
      const columns = Math.ceil((end - start) / 86400000 / 7);

      const weeks = [];
      const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
      for (let column = 0; column < columns; column += 1) {
        const week = [];
        for (let row = 0; row < 7; row += 1) {
          // 该格对应的日期字符串由本地日期现算，不依赖宿主严格补零（`2026-9-8` 也算）。
          const key = dayKey(cursor);
          const cell = cells.get(key);
          /*
           * 区间是 **[start, end]**——即"最早那天所在周的周日"到"最晚那天所在周的周六"
           * 这段连续的日历区间，**不是** [最早那天, 最晚那天]。
           *
           * 两者的差别只在两端补出来的那几天：区间内的日子必须都有格子（没量的补 0，
           * 这才是热力图"哪几天断过"的信息所在）；区间外的格子留 null（不画、不参与
           * hover），因为"不在统计范围"和"这天没用过"是两件事，混在一起图就撒谎。
           * 用严格 min/max 当区间会把两端补出来的日子也说成"没用过"，
           * 07:00 的边界因此错成"图的两端多出一截没有用量的底色"。
           */
          const inside = cursor.getTime() >= start.getTime() && cursor.getTime() <= end.getTime();
          if (cell === undefined) {
            week.push(inside ? { day: key, total: 0, attempts: 0, level: 0 } : null);
          } else {
            week.push({
              day: cell.day,
              total: cell.total,
              attempts: cell.attempts,
              level: levelOf(cell.total, max),
            });
          }
          // 唯一推进 cursor 的地方。用 setDate 而不是 `+ 86400000`：
          // 夏令时切换的那一天是 23/25 小时，按毫秒加会让整列慢/快一天。
          cursor.setDate(cursor.getDate() + 1);
        }
        weeks.push(week);
      }

      return {
        weeks,
        columns,
        days: cells.size,
        totalDays: columns * 7,
        max,
        from,
        to,
        weekStart: dayKey(start),
        weekEnd: dayKey(end),
      };
    }

    /**
     * 环形图的段与其图例（按 `row.total / grandTotal` 分配）。
     *
     * **分母是 grandTotal，不是 max。** 写成 max 是这里唯一会静默出错的写法：
     * 占比之和会超过 100%，圆环上后面的段还会叠到前面的段上（视觉上像"少了一个模型"），
     * 而每个数字单看都"像是对的"。所以分母只出现一次，就是在下面这一行。
     *
     * 值为 0 / 负 / 非数的行直接不画：给 0 占比的模型留一个零长段，图例里就会多出
     * 一条 "0%"——那是"没有用量"和"有模型没上报"的混淆，宁可少一行。
     *
     * 正因为它会**跳过**行，段里必须带上源行（`row`）与源索引：渲染时若回头用
     * `rows[段序号]` 取模型名，前面跳过一个 0 值行就会让后面所有图例**整体错位**——
     * 显示的是 A 的名字配上 B 的数值和颜色。这种错位不报错，只是名字和数字不是
     * 同一个模型，肉眼极难发现（自检里有一条专门钉它）。
     */
    function donutSegments(rows, grandTotal) {
      const list = Array.isArray(rows) ? rows : [];
      const total = Number.isFinite(grandTotal) && grandTotal > 0 ? grandTotal : 0;
      const out = [];
      if (total <= 0) return out;
      let offset = 0;
      for (let index = 0; index < list.length; index += 1) {
        const row = list[index];
        const value = Number.isFinite(row?.total) && row.total > 0 ? row.total : 0;
        if (value <= 0) continue;
        const ratio = value / total;
        const length = ratio * 100;
        // 段色取**模型次序**（超过 4 个循环）。用段自己的 value 当索引会让两个
        // 等量模型拿到同一个颜色，图例就分不出来了。
        const series = index % SEGMENT_SERIES;
        out.push({
          key: typeof row.key === 'string' ? row.key : String(index),
          row,
          index,
          value,
          ratio,
          length,
          offset,
          series,
        });
        offset += length;
      }
      return out;
    }

    /**
     * 按天热力图（GitHub 贡献图那种）。
     *
     * 为什么换成热力图而不是继续用折线：折线图的 X 轴必须**等距**（缺日在时间轴上
     * 不能塌成零宽），于是"哪几天完全没用"这件事在图上根本看不出来——而"这周是不是
     * 断过"恰恰是看用量时第一个想知道的问题。热力图把每个自然日都占一个格子，
     * 缺日=底色格子，一眼就能看出来。
     *
     * 三种降级，一种都不能抛：
     *   - **没有 timeline**（`hasTrend` 为假）：整块不出现（调用方判，旧数据下页面
     *     回到原来的样子）；
     *   - **空数组 / 全是坏日期**：`heatmapGeometry` 给出 `days === 0`，这里走空态
     *     文案而不是画一个空网格——空网格和"这段时间用量是 0"长得一模一样，
     *     而两者含义相反；
     *   - **只有一天**：照常画**一列**（周日起到周六 7 个格子，1 格有量、6 格补 0）。
     *     这一点是真机数据逼出来的：宿主只给"有用量的天"，实测就可能是孤零零的一天。
     */
    function renderHeatmap(points, t) {
      const list = Array.isArray(points) ? points : [];
      if (list.length === 0) return null;
      const geometry = heatmapGeometry(list);

      const head = h('div', { className: 'stu-figureHead' }, t('chartTrend'));

      // 一条可用记录都没有，或全部为 0：给一句文案，不画网格。
      // 全 0 时所有格子都是 level 0，画出来就是 7×N 个同色方块——它表达的
      // "这段时间没有用量"用一句话说更清楚，也少 350 个无意义的 DOM 节点。
      if (geometry.days === 0 || geometry.max <= 0) {
        return h('section', { className: 'stu-figure', key: 'heatmap' },
          head,
          h('div', { className: 'stu-heatEmpty' }, t('trendEmpty')));
      }

      /*
       * 月份带：只在**新月份的第一列**写标签。
       *
       * 53 列的月份带若每列都标，就会是一排同样的 "MM"；若按 `column % 4` 之类的
       * 固定间隔标，月份边界又会落在两列之间、标在错误的列上方。
       *
       * 取值必须用**第一格有实际用量的日期**，不能用"该列第一个非 null 格子"：
       * 首列前面几天是补出来的 0（真机数据里 09-13 那一列的前 5 天就是），
       * 拿它们判月份会把 5 月底的补 0 格当成"这是 5 月的列"，于是 6 月的图顶着
       * "5月"。这也是一处不报错、只是标签错的偏差。
       */
      const monthOf = (week) => {
        const first = week.find((cell) => cell !== null && cell.total > 0) ?? null;
        return first === null ? null : Number(first.day.slice(5, 7));
      };
      const monthCells = geometry.weeks.map((week, index) => {
        const month = monthOf(week);
        const previous = index === 0 ? null : monthOf(geometry.weeks[index - 1]);
        const label = month !== null && month !== previous ? String(month) + '月' : '';
        return h('span', {
          className: 'stu-heatMonth',
          key: 'month-' + index,
          // 显式指定列，而不是靠自动排布：万一将来在带里插了别的节点，
          // 自动排布会把后面所有标签整体挤到下一列，而肉眼只会觉得"月份偏了"。
          style: { gridColumn: String(index + 1) },
        }, label);
      });

      /*
       * 星期标签：**只标奇数行**（周一/周三/周五）。
       * 七行全标在 11px 行高下会互相挤，标成 "Sun/Mon/Tue…" 反而更难对行；
       * 隔行标已经足够让读者定位到具体是哪一天（配合格子的 title 给出完整日期）。
       *
       * 这三个字**不进文案表**：它们是 3 个单字，中英两表各存一份只会让键集合
       * 检查多两处需要同步的死键风险，而"标签的语义"完全由图例与 title 承载。
       */
      const weekdayLabels = ['', '一', '', '三', '', '五', ''];
      const labelCells = [];
      for (let row = 0; row < 7; row += 1) {
        labelCells.push(h('span', { className: 'stu-heatLabelCell', key: 'label-' + row },
          weekdayLabels[row]));
      }

      const bodyCells = [];
      for (let column = 0; column < geometry.weeks.length; column += 1) {
        const week = geometry.weeks[column];
        for (let row = 0; row < 7; row += 1) {
          const cell = week[row];
          // null 格子（本周之外的日期）**不渲染**：渲染成透明方块会留下 hover 热区，
          // 鼠标停在"统计范围之外"上却弹出日期，比不弹更让人困惑。
          if (cell === null || cell === undefined) continue;
          bodyCells.push(h('div', {
            className: 'stu-heatCell',
            key: cell.day,
            'data-level': String(cell.level),
            style: { gridColumn: String(column + 1), gridRow: String(row + 1) },
            title: fill(t('pointAria'), { day: cell.day, total: formatExact(cell.total) }),
          }));
        }
      }

      /*
       * 列数写进 CSS 变量：`grid-template-columns:repeat(var(--stu-heat-weeks),14px)`
       * 让列宽固定 14px，53 列就是 742px，**永远不会被压缩**。列宽一旦被压，
       * 格子就不再是正方形，读者对"深浅"的判断会跟着出错。
       */
      const layout = { '--stu-heat-weeks': String(geometry.columns) };

      return h('section', { className: 'stu-figure', key: 'heatmap' },
        head,
        // 外层横向滚动：371 天（53 列）在窄侧栏里也放得下，且是"内容滚动"而不是
        // "格子压缩"。
        h('div', { className: 'stu-heatScroll' },
          h('div', { className: 'stu-heatLabels' },
            h('span', { className: 'stu-heatLabelSpacer' }),
            ...labelCells),
          h('div', { className: 'stu-heatInner', style: layout },
            h('div', { className: 'stu-heatMonths' }, ...monthCells),
            h('div', { className: 'stu-heatBody' }, ...bodyCells))),
        // 图例回答"深浅代表多少"：没有它，五档颜色只是五种装饰。
        // level 0 的色块与网格里的 level 0 同色，读者才能把"底色=没有用量"对上。
        // 色块用同一个 `.stu-heatCell` 类，尺寸/圆角与网格里的格子严格一致
        // （另起一个"小色块"类很容易在后续调格子尺寸时忘记同步，图例就开始撒谎）。
        h('div', { className: 'stu-heatLegend' },
          h('span', null, t('heatLess')),
          h('span', { className: 'stu-heatLegendScale' },
            h('i', { className: 'stu-heatCell', 'data-level': '0' }),
            h('i', { className: 'stu-heatCell', 'data-level': '1' }),
            h('i', { className: 'stu-heatCell', 'data-level': '2' }),
            h('i', { className: 'stu-heatCell', 'data-level': '3' }),
            h('i', { className: 'stu-heatCell', 'data-level': '4' })),
          h('span', null, t('heatMore'))));
    }

    /**
     * 环形图（按模型占比）。
     *
     * 用 `<circle>` + `stroke-dasharray` / `stroke-dashoffset` 画弧，而不是手算
     * `path` 的 A 命令：dasharray 的分段语义就是"画一段、空一段"，改成占比只需换
     * 两个数；手算弧要处理"每段起点终点 + 超过半圈要拆两段 + 整圈退化"，全是能
     * 静默画错的边角（单个模型 100% 就是其中一种，path 写法下半径等于半径会退化）。
     *
     * 整圈的兜底：`stroke-dasharray: 100 100` 在整圈时会被浏览器按 50/50 画成
     * 两个半圆？——不会，dasharray 只在路径长度内生效，而周长是 100（r=15.9155），
     * 所以 100 恰好覆盖整圈。**r 的取值就是为这个选的**：2πr ≈ 100，dasharray 的
     * 数字因而可以当成百分比用，不必再乘周长。
     */
    function renderDonut(rows, t) {
      if (!Array.isArray(rows) || rows.length === 0) return null;
      const grandTotal = rows.reduce((sum, row) => sum + (Number.isFinite(row.total) ? row.total : 0), 0);
      const segments = donutSegments(rows, grandTotal);
      // 总量为 0（全是 0 / 坏数据）时不画空圆环：空圆环看起来像"加载失败"。
      if (segments.length === 0) return null;

      const radius = 15.9155;
      const centre = 21;
      const title = fill(t('donutAria'), { total: formatExact(grandTotal) });
      const legend = [];

      for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index];
        const row = segment.row ?? {};
        const share = Math.round(segment.ratio * 100);
        const label = fill(t('segmentAria'), {
          model: row.model === 'unknown' ? t('unattributed') : row.model,
          share,
          total: formatExact(segment.value),
        });
        // 环上每段带 <title>：鼠标悬停看得到"这是哪个模型"，图例里则给准确数字。
        legend.push(h('g', { key: 'seg-' + segment.key },
          h('title', null, label),
          h('circle', {
            className: 'stu-donutSeg',
            cx: centre, cy: centre, r: radius,
            fill: 'none',
            strokeWidth: 6,
            // 段色由 CSS 的 [data-series] 决定（四个实色令牌），不再用透明度。
            'data-series': String(segment.series),
            strokeDasharray: segment.length + ' 100',
            strokeDashoffset: -segment.offset,
          })));
      }

      // 模型名一律取 `segment.row`（段自带的源行），**不能**用 `rows[index]`：
      // donutSegments 会跳过 0 值行，按段序号回去索引会让图例整体错位。
      const legendItems = segments.map((segment) => {
        const row = segment.row ?? {};
        const share = Math.round(segment.ratio * 100);
        return h('li', { className: 'stu-donutItem', key: segment.key },
          h('i', { className: 'stu-donutSwatch', 'data-series': String(segment.series) }),
          h('span', { className: 'stu-donutName', title: row.model + ' · ' + row.provider },
            row.model === 'unknown' ? t('unattributed') : row.model),
          h('span', { className: 'stu-donutShare' }, share + '%'),
          h('b', { className: 'stu-donutValue' }, formatExact(segment.value)));
      });

      return h('section', { className: 'stu-figure', key: 'donut' },
        h('div', { className: 'stu-figureHead' }, t('chartModels')),
        h('div', { className: 'stu-donut' },
          h('div', { className: 'stu-donutWrap' },
            h('svg', {
              className: 'stu-donutSvg',
              viewBox: '0 0 42 42',
              role: 'img',
              'aria-label': title,
            },
            // 底圈：总占比不足 100% 时（有模型没上报 / 值不完整）露出底色，
            // 比"圆环缺一角但看不出缺"要诚实。
            h('circle', { className: 'stu-donutTrack', cx: centre, cy: centre, r: radius, fill: 'none', strokeWidth: 6 }),
            // -90° 起画：不旋转的话第一段从三点钟方向开始，读图的人会找错起点。
            h('g', { transform: 'rotate(-90 ' + centre + ' ' + centre + ')' }, legend)),
            h('div', { className: 'stu-donutCenter' },
              h('span', { className: 'stu-donutTotal' }, formatTokens(grandTotal)),
              h('span', { className: 'stu-donutCaption' }, t('donutCenter')))),
          h('ul', { className: 'stu-donutLegend' }, legendItems)));
    }

    /** 把汇总的 rows 归一成界面用的行（容错，坏数据不炸渲染）。 */
    function normaliseRows(summary) {
      const raw = Array.isArray(summary?.rows) ? summary.rows : [];
      const rows = [];
      for (const row of raw) {
        if (!isObject(row)) continue;
        const buckets = isObject(row.buckets) ? row.buckets : {};
        rows.push({
          key: typeof row.key === 'string' ? row.key : String(row.provider) + '/' + String(row.model),
          provider: typeof row.provider === 'string' ? row.provider : 'unknown',
          model: typeof row.model === 'string' ? row.model : 'unknown',
          buckets,
          total: Number.isFinite(row.total) ? row.total : totalOf(buckets),
          attempts: Number.isFinite(row.attempts) ? row.attempts : 0,
        });
      }
      return rows;
    }

    /* ---------------------------------------------------------------- */
    /* 组件                                                              */
    /* ---------------------------------------------------------------- */

    /**
     * `useProjection` 缺失时的替身。
     *
     * 它是普通函数而不是 hook —— 调用它不注册任何 hook。owner 传下来的
     * `useProjection` 在一个席位条目的生命周期内是稳定的，所以"有没有它"
     * 在两次渲染之间不会变，hook 数因此恒定。
     */
    function noProjection() {
      return null;
    }

    /** 侧边栏面板图标。owner 传 size/active，这里只用 currentColor 描线。 */
    function PanelIcon(props) {
      const size = Number.isFinite(props?.size) ? props.size : 24;
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
      h('path', { d: 'M4 20V10' }),
      h('path', { d: 'M10 20V4' }),
      h('path', { d: 'M16 20v-7' }),
      h('path', { d: 'M22 20V8' }),
      h('path', { d: 'M2 20h20' }));
    }

    /**
     * 独立页面：跨会话按模型汇总。
     *
     * 数据只在挂载时与点刷新后读，不做轮询——汇总本身是宿主扫描的产物，
     * 轮询只会反复读同一份值。
     */
    function UsagePage(props) {
      const api = props?.api;
      const t = props?.t ?? ((key) => key);
      const [state, setState] = React.useState({
        phase: 'loading', summary: null, persistent: true, error: null, timeline: [], timelinePresent: false,
      });
      const [page, setPage] = React.useState(0);
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState(null);

      const load = React.useCallback(async () => {
        if (api === undefined || typeof api.describe !== 'function') {
          setState({ phase: 'ready', summary: null, persistent: false, error: null, timeline: [], timelinePresent: false });
          return;
        }
        try {
          const response = await api.describe();
          const read = readSummary(response);
          // timeline 在**读取时**就归一：渲染路径上于是不必再判空/判数组，
          // 少一处忘了判就是"画一条歪线"。同时留一个 timelinePresent 标志，
          // 用来区分"宿主没给 timeline"（整块图不出现）和"给了但都是 0"（显示空态文案）。
          const timeline = normaliseTimeline(read.summary);
          setState({
            phase: 'ready',
            summary: read.summary,
            persistent: read.persistent,
            error: null,
            timeline,
            timelinePresent: timeline.length > 0,
          });
        } catch (error) {
          setState({
            phase: 'ready',
            summary: null,
            persistent: true,
            error: error instanceof Error ? error.message : String(error),
            timeline: [],
            timelinePresent: false,
          });
        }
      }, [api]);

      React.useEffect(() => {
        void load();
      }, [load]);

      const rows = normaliseRows(state.summary);

      // 页码钳制必须放在任何 early return 之前：否则两次渲染的 hook 数不同，
      // React 会抛 #310，整个 slot 变空白（这个坑在定时任务上踩过一次）。
      React.useEffect(() => {
        const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
        if (page > pageCount - 1) setPage(pageCount - 1);
      }, [rows.length, page]);

      const onRefresh = React.useCallback(async () => {
        if (api === undefined || typeof api.mutate !== 'function') return;
        setBusy(true);
        setNotice(null);
        try {
          // 只写一个时间戳：真正的扫描在宿主的下一轮 sweep 里做。
          await api.mutate([{ op: 'set', path: ['internal', 'refreshRequestedAt'], value: Date.now() }]);
          setNotice(t('requested'));
        } catch (error) {
          setNotice(String(error instanceof Error ? error.message : error));
        } finally {
          setBusy(false);
        }
      }, [api, t]);

      const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
      const safePage = Math.min(page, pageCount - 1);
      const slice = rows.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
      const grandTotal = rows.reduce((sum, row) => sum + row.total, 0);
      // 趋势数据也在 hook 之后、首个 return 之前取出（这个位置本来就是语句层）。
      const trendPoints = Array.isArray(state.timeline) ? state.timeline : [];
      const hasTrend = state.timelinePresent === true;

      const body = [];
      if (state.phase === 'loading') {
        body.push(h('div', { className: 'stu-empty', key: 'loading' }, t('loading')));
      } else if (state.error !== null) {
        body.push(h('div', { className: 'stu-error', key: 'error' }, fill(t('loadFailed'), { reason: state.error })));
      } else if (rows.length === 0) {
        body.push(h('div', { className: 'stu-empty', key: 'empty' }, t('emptyAll')));
      } else {
        /*
         * 三个视图，三种问题，顺序从"整体"到"细节"：
         *   环形图 → 谁占大头；热力图 → 哪些天用的；堆叠条 → 每个模型内部构成。
         * 图表一律用**全部行 / 全部天**而不是当前页——它们是总览，翻页不该改变它。
         *
         * 热力图用 `hasTrend &&` 而不是 `renderHeatmap(...) ?? null`：后者在 React 里
         * 会把 `null` 当成一个子节点（渲染成空），语义上等价但要多想一步；
         * 显式条件也顺便让"没有 timeline 就整块不出现"这件事在源码里可断言。
         */
        const donut = renderDonut(rows, t);
        if (donut !== null) body.push(donut);
        if (hasTrend) body.push(renderHeatmap(trendPoints, t));
        body.push(renderChart(rows, t));
        const head = h('thead', { key: 'thead' }, h('tr', null,
          h('th', { className: 'stu-nameCol' }, t('colModel')),
          h('th', { className: 'stu-num' }, t('colInput')),
          h('th', { className: 'stu-num' }, t('colOutput')),
          h('th', { className: 'stu-num' }, t('colCacheRead')),
          h('th', { className: 'stu-num' }, t('colCacheWrite')),
          h('th', { className: 'stu-num' }, t('colTotal')),
          h('th', { className: 'stu-num' }, t('colShare'))));
        const rowsEls = slice.map((row) => {
          const share = grandTotal > 0 ? Math.round((row.total / grandTotal) * 100) : 0;
          return h('tr', { key: row.key },
            h('td', null, h('div', { className: 'stu-model' },
              h('span', { className: 'stu-modelName', title: row.model }, row.model),
              h('span', { className: 'stu-provider', title: row.provider }, row.provider))),
            h('td', { className: 'stu-num' }, formatExact(row.buckets.uncachedInputTokens ?? 0)),
            h('td', { className: 'stu-num' }, formatExact(row.buckets.outputTokens ?? 0)),
            h('td', { className: 'stu-num' }, formatExact(row.buckets.cacheReadTokens ?? 0)),
            h('td', { className: 'stu-num' }, formatExact(row.buckets.cacheWriteTokens ?? 0)),
            h('td', { className: 'stu-num stu-totalCell' }, formatExact(row.total)),
            h('td', { className: 'stu-num' }, share + '%'));
        });
        body.push(h('table', { className: 'stu-table', key: 'table' }, head, h('tbody', null, rowsEls)));
        if (pageCount > 1) {
          body.push(h('div', { className: 'stu-footRow', key: 'pager' },
            h('span', { className: 'stu-pageInfo' }, (safePage + 1) + ' / ' + pageCount),
            h('span', { className: 'stu-pager' },
              h('button', {
                type: 'button', className: 'stu-btn stu-btnSm', disabled: safePage === 0,
                onClick: () => setPage(safePage - 1),
              }, '‹'),
              h('button', {
                type: 'button', className: 'stu-btn stu-btnSm', disabled: safePage >= pageCount - 1,
                onClick: () => setPage(safePage + 1),
              }, '›'))));
        }
      }

      const summary = state.summary;
      const foot = [];
      if (isObject(summary)) {
        const scanned = Number.isFinite(summary.scanned) ? summary.scanned : 0;
        const total = Number.isFinite(summary.total) ? summary.total : 0;
        foot.push(h('div', { key: 'scan' },
          summary.truncated === true
            ? fill(t('scanTruncatedAll'), { scanned, total })
            : fill(t('scanNote'), { scanned, total }),
          Number.isFinite(summary.skipped) && summary.skipped > 0
            ? fill(t('skipped'), { count: summary.skipped })
            : null));
        foot.push(h('div', { key: 'built' },
          fill(t('builtAt'), { time: stampOf(summary.builtAt) ?? t('never') })));
      }

      return h('div', { className: 'stu-inner' },
        h('div', { className: 'stu-head' },
          h('div', null,
            h('div', { className: 'stu-title' }, t('title')),
            h('div', { className: 'stu-sub' }, t('subtree'))),
          h('button', {
            type: 'button',
            className: 'stu-btn',
            disabled: busy || state.persistent !== true,
            title: state.persistent === true ? undefined : t('notPersistent'),
            onClick: () => { void onRefresh(); },
          }, busy ? t('refreshing') : t('refresh'))),
        notice === null ? null : h('div', { className: 'stu-notice' }, notice),
        ...body,
        foot.length === 0 ? null : h('div', { className: 'stu-foot' }, foot));
    }

    /**
     * 会话头部角标：本次会话的实时用量。
     *
     * 数据来自投影 `tokenByModel` 的 wire view（宿主算好），用 owner 注入的
     * `useProjection` 读。`useProjection` 缺失时渲染一句降级说明而不是崩——
     * 席位组件抛错会让整个 slot 空白。
     */
    function SessionMeter(props) {
      const t = props?.t ?? ((key) => key);
      const useProjection = props?.useProjection;
      const [open, setOpen] = React.useState(false);
      const rootRef = React.useRef(null);

      const hasHook = typeof useProjection === 'function';
      // hook 必须无条件调用：条件调用会让两次渲染的 hook 数不同（React #310）。
      // 这里选好要调的函数再调一次，而不是 `cond ? useProjection(k) : null`——
      // 后者的调用表达式本身在条件分支里，一旦 owner 传下来的 useProjection
      // 在两次渲染间改变存在性，hook 数就会变，整个 slot 变空白。
      const readProjection = hasHook ? useProjection : noProjection;
      const projection = readProjection(PROJECTION_KEY);

      React.useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
          if (rootRef.current !== null && !rootRef.current.contains(event.target)) setOpen(false);
        };
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown);
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true);
          document.removeEventListener('keydown', onKeyDown);
        };
      }, [open]);

      if (!hasHook) {
        return h('span', { className: 'stu-popHint' }, t('meterUnsupported'));
      }

      const rows = normaliseRows(projection === null ? null : { rows: projection?.rows });
      const total = Number.isFinite(projection?.total) ? projection.total : totalOf(projection?.totals);
      if (rows.length === 0 && total === 0) {
        // 没有用量时不占位：头部空间有限，空角标只是噪音。
        return null;
      }

      /**
       * 一行模型的四桶分解。
       *
       * 投影的 wire 数据本来就把每行的 `buckets` 一起带过来了，早期版本只渲染了
       * `total`——于是"按模型汇总 token 用量"这件事只做了一半：能看出哪个模型花得多，
       * 看不出花在输入还是输出、缓存命中多少。四桶里**无值的不渲染**（适配器不上报
       * 缓存时不写 0），避免把"未上报"画成"确实是 0"。
       */
      const bucketCells = (row) => {
        const items = [
          ['bIn', row.buckets.uncachedInputTokens],
          ['bOut', row.buckets.outputTokens],
          ['bCacheRead', row.buckets.cacheReadTokens],
          ['bCacheWrite', row.buckets.cacheWriteTokens],
        ];
        return h('div', { className: 'stu-popBuckets' },
          items.map(([key, value]) => h('span', { className: 'stu-popBucket', key },
            h('i', { className: 'stu-popBucketLabel' }, t(key)),
            h('b', { className: 'stu-popBucketValue' }, formatExact(value ?? 0)))));
      };

      const list = rows.length === 0
        ? [h('div', { className: 'stu-popEmpty', key: 'empty' }, t('meterEmpty'))]
        : rows.map((row) => h('div', { className: 'stu-popRow', key: row.key },
          h('div', { className: 'stu-popTop' },
            h('span', { className: 'stu-popModel', title: row.model + ' · ' + row.provider },
              row.model === 'unknown' ? t('unattributed') : row.model),
            h('span', { className: 'stu-popVal' }, formatExact(row.total))),
          h('div', { className: 'stu-bar' }, h('div', {
            className: 'stu-barFill',
            style: { width: (total > 0 ? Math.max(2, Math.round((row.total / total) * 100)) : 0) + '%' },
          })),
          h('div', { className: 'stu-popHint' },
            row.provider + ' · ' + fill(t('attempts'), { count: row.attempts })),
          bucketCells(row)));

      return h('span', { className: 'stu-meterRoot', ref: rootRef },
        h('button', {
          type: 'button',
          className: 'stu-meterBtn',
          'aria-expanded': open,
          'aria-haspopup': 'dialog',
          'aria-label': fill(t('meterAria'), { total: formatExact(total) }),
          title: fill(t('meterAria'), { total: formatExact(total) }),
          onClick: () => setOpen(!open),
        },
        h('span', { className: 'stu-meterDot' }),
        formatTokens(total)),
        open ? h('div', { className: 'stu-pop', role: 'dialog', 'aria-label': t('meterTitle') },
          h('div', { className: 'stu-popHead' },
            h('span', null, t('meterTitle')),
            h('button', {
              type: 'button', className: 'stu-btn stu-btnSm',
              onClick: () => setOpen(false),
            }, t('close'))),
          h('div', { className: 'stu-popTotal' }, formatExact(total)),
          h('div', { className: 'stu-popList' }, list),
          h('div', { className: 'stu-popHint' }, t('meterHint'))) : null);
    }

    /* ---------------------------------------------------------------- */
    /* 装配                                                              */
    /* ---------------------------------------------------------------- */

    const inject = ['slots', 'locale', 'remote', 'remote.settings'];

    function apply(ctx) {
      const cleanups = [];
      const use = (fn, label) => {
        if (typeof ctx.effect !== 'function') {
          try {
            const disposer = fn();
            if (typeof disposer === 'function') cleanups.push(disposer);
          } catch (error) {
            console.error('[token-usage] ' + label + ' failed', error);
          }
          return;
        }
        try {
          ctx.effect(fn, label);
        } catch (error) {
          console.error('[token-usage] ' + label + ' failed', error);
        }
      };

      // 样式：只在 apply 内插入，卸载时移除。
      use(() => {
        const tagId = 'dsh-plugin-token-usage/styles.css';
        if (typeof document === 'undefined') return () => {};
        const existing = document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']');
        if (existing !== null) return () => {};
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-plugin-token-usage';
        tag.dataset.pluginCss = tagId;
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => { tag.remove(); };
      }, 'token-usage: styles');

      // 文案：走 Client locale 服务，界面文字不写死在组件里。
      let t = (key) => (zh[key] === undefined ? key : zh[key]);
      try {
        if (isObject(ctx.locale) && typeof ctx.locale.register === 'function') {
          use(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'token-usage: locale');
          t = ctx.locale.bind(LOCALE_NS);
        }
      } catch (error) {
        console.error('[token-usage] locale binding failed', error);
      }

      // 跨会话汇总的读写通道。
      const settings = isObject(ctx.remote) ? ctx.remote.settings : undefined;
      const api = {
        available: isObject(settings),
        describe: () => {
          if (typeof settings?.describe !== 'function') throw new Error('remote.settings.describe is unavailable');
          return settings.describe();
        },
        mutate: (ops, revision) => {
          if (typeof settings?.mutate !== 'function') throw new Error('remote.settings.mutate is unavailable');
          return settings.mutate(CONFIG_NS, ops, revision);
        },
      };

      const Page = (props) => UsagePage({ ...props, api, t });
      const Meter = (props) => SessionMeter({ ...props, t });

      /*
       * 三个席位必须通过 `ctx.slots.inject(ownerKey, …)` 注册，**不能**裸调
       * `ctx.slots.register`。
       *
       * 真实事故：裸注册在 boot 时会抛
       *   Error: slot "sidebar.panellist" is not declared
       *   （a parent entry's children table must declare it）
       * 因为浏览器 bundle 的执行顺序由 combo 决定，本包可能排在"声明这些 slot 的
       * 那些包"之前。此时 slot 尚未声明，注册直接失败——三个席位全部丢失，
       * 而 apply 本身不报错，界面只是"少了东西"。
       *
       * 官方 practices.md 就是这条：
       *   Contribute through slots: `ctx.slots.inject(ownerKey, () => ctx.slots.register(...))`.
       *   The callback's registrations are disposed when the owning declaration
       *   collapses and reinstalled when it returns.
       * `inject` 会把注册推迟到属主声明出现之后，并在它重新出现时重装。
       *
       * 注意：这里**不要**再用 try/catch 吞错。吞掉只会把"注册失败"变成
       * "界面少了一块"，而 boot 审计仍会把该 entry 记为失败；让错误照实暴露
       * 比静默降级好排查。
       */
      use(() => {
        const offs = [];
        const contribute = (ownerKey, options, Component) => {
          if (typeof ctx.slots?.inject !== 'function' || typeof ctx.slots?.register !== 'function') return;
          // 回调写成 **generator** 而不是箭头函数。
          //
          // 官方 practices.md 写的是 `() => ctx.slots.register(...)`，但已发布的生产
          // 代码（@deepseek-ai/dsh-client-ui-sidebar-right）用的是 generator：
          //   ctx.slots.inject("rightbar", function* () { yield ctx.slots.register({...}, C); });
          // 而契约里回调的返回类型叫 `SlotInjectionEffect`——既然线上用的是 generator，
          // 就照它写，不赌箭头返回 disposer 也能被接受。
          const off = ctx.slots.inject(ownerKey, function* () {
            yield ctx.slots.register(options, Component);
          });
          if (typeof off === 'function') offs.push(off);
        };
        contribute('sidebar.panellist', { name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: () => t('panelLabel') }, PanelIcon);
        contribute('main', { name: 'main', key: PANEL_ID }, Page);
        contribute('conversation.session.header.utilities', {
          name: 'conversation.session.header.utilities',
          id: PANEL_ID,
          order: 40,
          label: () => t('panelLabel'),
          locale: LOCALE_NS,
        }, Meter);
        return () => {
          for (const off of offs) {
            try {
              off();
            } catch {
              /* ignore */
            }
          }
        };
      }, 'token-usage: slots');

      const dispose = () => {
        for (let index = cleanups.length - 1; index >= 0; index -= 1) {
          try {
            cleanups[index]();
          } catch (error) {
            console.error('[token-usage] cleanup failed', error);
          }
        }
        cleanups.length = 0;
      };
      return dispose;
    }

    /*
     * 测试接缝：自检脚本用它逐值比对浏览器侧与 lib/fold.js 的格式化实现。
     * Cordis 只读 `inject` / `apply` / `name` / `Config`，多余导出会被忽略。
     */
    const internals = {
      panelId: PANEL_ID,
      configNs: CONFIG_NS,
      projectionKey: PROJECTION_KEY,
      localeNs: LOCALE_NS,
      pageSize: PAGE_SIZE,
      formatTokens,
      formatExact,
      totalOf,
      readSummary,
      normaliseRows,
      fill,
      stampOf,
      /*
       * 图表的纯函数也走这个接缝。
       *
       * 理由和 formatTokens 一样但更强：图**画错不会抛错**。热力图的起点错开一天
       * （列不对齐到周）、强度不分档、环形图分母写成 max、缺 timeline 时画空坐标系
       * ——这些表现都是"渲染成功的一张图"，静态形状断言看不见。只有把归一化数学
       * 取出来跑真实输入，才能钉住。
       */
      normaliseTimeline,
      shortDay,
      heatmapGeometry,
      donutSegments,
      /*
       * 两个渲染函数也暴露出去。
       *
       * 只有纯函数数学可验证是不够的：**"降级分支有没有接上"** 是另一类错误。
       * 例如 `heatmapGeometry` 对空序列返回零列（数学正确），但渲染层若写成
       * `weeks.length === 1 ? 单列 : 网格`，单点之外的 0 列就会走进网格分支，
       * 画出一堆 `data-level` 都没有的方块——算式全对，界面全错。自检脚本因此还要
       * 拿真实的行/序列走一遍渲染，按 className 找节点来断言存在与缺失。
       */
      renderDonut,
      renderHeatmap,
      // 组件本身也暴露出去，供渲染自检直接驱动。
      UsagePage,
      SessionMeter,
      PanelIcon,
    };

    return { inject, apply, __internals: internals };
  },
});
