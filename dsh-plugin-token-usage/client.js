/**
 * 「Token 用量」插件 —— 浏览器半。
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
      loading: 'Loading…',
      close: 'Close',
    };

    /* ---------------------------------------------------------------- */
    /* 样式                                                              */
    /* ---------------------------------------------------------------- */

    /* 全部颜色走 --dsw-alias-* 主题令牌：令牌改名只会降级外观，不会渲染失败。 */
    const CSS = [
      '.stu-inner{max-width:980px;margin:0 auto;padding:20px 24px 40px;display:flex;flex-direction:column;gap:14px}',
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
      '.stu-seg[data-bucket="uncachedInputTokens"]{background:var(--dsw-alias-brand-primary)}',
      '.stu-seg[data-bucket="outputTokens"]{background:var(--dsw-alias-brand-primary);opacity:.74}',
      '.stu-seg[data-bucket="cacheReadTokens"]{background:var(--dsw-alias-brand-primary);opacity:.46}',
      '.stu-seg[data-bucket="cacheWriteTokens"]{background:var(--dsw-alias-brand-primary);opacity:.24}',
      '.stu-legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
      '.stu-legendItem{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}',
      '.stu-swatch{width:9px;height:9px;border-radius:2px;flex:none}',
      '.stu-swatch[data-bucket="uncachedInputTokens"]{background:var(--dsw-alias-brand-primary)}',
      '.stu-swatch[data-bucket="outputTokens"]{background:var(--dsw-alias-brand-primary);opacity:.74}',
      '.stu-swatch[data-bucket="cacheReadTokens"]{background:var(--dsw-alias-brand-primary);opacity:.46}',
      '.stu-swatch[data-bucket="cacheWriteTokens"]{background:var(--dsw-alias-brand-primary);opacity:.24}',
      '.stu-legendValue{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
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
     * 浏览器半是独立的 bundle，只经 `__ModuleLoader__` 注册，工厂只拿到 `require`，
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
      return h('div', { className: 'stu-chart', key: 'chart' },
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
        }));
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
      const [state, setState] = React.useState({ phase: 'loading', summary: null, persistent: true, error: null });
      const [page, setPage] = React.useState(0);
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState(null);

      const load = React.useCallback(async () => {
        if (api === undefined || typeof api.describe !== 'function') {
          setState({ phase: 'ready', summary: null, persistent: false, error: null });
          return;
        }
        try {
          const response = await api.describe();
          const read = readSummary(response);
          setState({ phase: 'ready', summary: read.summary, persistent: read.persistent, error: null });
        } catch (error) {
          setState({
            phase: 'ready',
            summary: null,
            persistent: true,
            error: error instanceof Error ? error.message : String(error),
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

      const body = [];
      if (state.phase === 'loading') {
        body.push(h('div', { className: 'stu-empty', key: 'loading' }, t('loading')));
      } else if (state.error !== null) {
        body.push(h('div', { className: 'stu-error', key: 'error' }, fill(t('loadFailed'), { reason: state.error })));
      } else if (rows.length === 0) {
        body.push(h('div', { className: 'stu-empty', key: 'empty' }, t('emptyAll')));
      } else {
        // 图表放在表格之上：先给"谁大 / 构成如何"的直觉，再给精确读数。
        // 图表用**全部行**而不是当前页——它是总览，翻页不该改变它。
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
     * 测试接缝：自检脚本用它逐值比对浏览器半与 lib/fold.js 的格式化实现。
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
      // 组件本身也暴露出去，供渲染自检直接驱动。
      UsagePage,
      SessionMeter,
      PanelIcon,
    };

    return { inject, apply, __internals: internals };
  },
});
