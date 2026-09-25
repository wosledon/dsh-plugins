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
     * 从 settings.describe() 的结果里取跨会话汇总。
     *
     * 两层都要看：`internal` 住在**用户层**（`entry.user`），而 resolved 值在
     * `entry.value`。只读其中一层会在某些 profile 下静默拿到空数据。
     */
    function readSummary(entries) {
      if (!Array.isArray(entries)) return { summary: null, persistent: false };
      const entry = entries.find((candidate) => candidate?.ns === CONFIG_NS);
      if (!isObject(entry)) return { summary: null, persistent: false };
      const user = isObject(entry.user) ? entry.user : undefined;
      const value = isObject(entry.value) ? entry.value : undefined;
      const summary = (user?.internal?.summary) ?? (value?.internal?.summary) ?? null;
      return { summary: isObject(summary) ? summary : null, persistent: true };
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
          const entries = await api.describe();
          const read = readSummary(entries);
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
            row.provider + ' · ' + fill(t('attempts'), { count: row.attempts }))));

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

      // 三个席位分别注册：任何一个失败都不能拖垮另外两个。
      use(() => {
        const offs = [];
        const tryRegister = (label, options, Component) => {
          if (typeof ctx.slots?.register !== 'function') return;
          try {
            const off = ctx.slots.register(options, Component);
            if (typeof off === 'function') offs.push(off);
          } catch (error) {
            console.error('[token-usage] slot ' + label + ' failed', error);
          }
        };
        tryRegister('panellist', { name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: () => t('panelLabel') }, PanelIcon);
        tryRegister('main', { name: 'main', key: PANEL_ID }, Page);
        tryRegister('sessionUtilities', {
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
