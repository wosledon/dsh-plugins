/**
 * 「SSH 远程工作区」插件 —— 浏览器侧。
 *
 * 两个席位：
 *   - `sidebar.panellist`（root 作用域）：侧边栏入口，点开主页面
 *   - `main`（root 作用域）：主机管理 / 探通 / 远端命令执行 / 执行记录
 *
 * ## 三条来自真机事故的约定，缺一条就会让整个席位变白或应用起不来
 *
 * 1. **slot 注册必须走 generator 形式**：
 *       ctx.slots.inject(ownerKey, function* () { yield ctx.slots.register(...); })
 *    裸 `ctx.slots.register` 在 boot 时会抛 `slot "sidebar.panellist" is not declared`
 *    ——bundle 的执行顺序由 combo 决定，可能排在声明这些 slot 的包之前。那会让
 *    entry 激活失败、**应用直接起不来**。这里也刻意**没有 try/catch 吞错**：
 *    吞掉只会让席位静默消失，比响亮地失败更难查。
 *
 * 2. **主页面根容器必须自建滚动**：
 *       .ssh-inner{height:100%;overflow:auto}  +  .ssh-inner>*{max-width:1100px}
 *    `main` 席位**不给**滚动容器。不自建滚动，超出窗口的内容完全看不见、
 *    连滚动条都没有（真实事故，且当时的断言还把对的做法判为违规）。
 *    限宽放子元素上——容器既限宽又自滚会打架。
 *
 * 3. **所有 hook 必须在第一个 `return` 之前且处于语句层**。条件 return 之后
 *    再调 hook 会让两次渲染的 hook 数不同，React 抛 #310，整个 slot 变空白。
 *
 * 另外：颜色只走 `--dsw-alias-*` 令牌（唯一例外是浮层阴影的 rgba）；
 * 主题里没有"与品牌色对比的前景色"，所以主按钮用描边式而不是填色+白字。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-ssh-workspace',
  factory(require) {
    const React = require('react');
    // 用 React.createElement 而不是手搓 element 对象：手搓的 `$$typeof`/
    // `_store` 形状稍有偏差，React 会静默拒绝渲染，而界面上只是"空白"。
    const h = React.createElement;
    const { useEffect, useState } = React;

    /* ------------------------------------------------------------------ */
    /* 常量与文案                                                          */
    /* ------------------------------------------------------------------ */

    /** 面板 id：`sidebar.panellist` 的 id 与 `main` 的 key 必须一致。 */
    const PANEL_ID = 'ssh-workspace';
    /** 设置命名空间，等于本插件 Loader 行 id。 */
    const CONFIG_NS = 'ssh-workspace';

    const zh = {
      title: 'SSH 远程工作区',
      sub: '按工作区绑定远程主机；Agent 通过 ssh_exec / ssh_read_file 等工具在远端工作。',
      hosts: '远程主机',
      count: '{n} 台',
      empty: '还没有配置远程主机。填下面的表单添加第一台。',
      add: '新增主机',
      label: '名称（可选）',
      host: '主机 / IP',
      port: '端口',
      user: '用户',
      key: '私钥路径',
      save: '保存',
      cancel: '取消',
      saved: '已保存',
      needHost: '主机名不能为空。',
      writeFailed: '写入配置失败，请查看宿主日志。',
      exec: '执行',
      cmd: '在远端执行的命令',
      run: '执行',
      running: '执行中…',
      needCmd: '命令不能为空。',
      history: '最近执行',
      noHistory: '还没有执行记录。',
      ok: '退出码 0',
      failed: '失败',
      truncated: '（输出已截断）',
      selectFirst: '先在上面选一台主机。',
      note: '只支持私钥认证：密钥留在你自己的 ~/.ssh 里，插件不存任何口令。',
      toolsOff: 'enableTools 为 false，Agent 侧工具未注册；面板仍可使用。',
      readFailed: '读取配置失败',
      loading: '载入中…',
    };

    const en = {
      title: 'SSH Remote Workspace',
      sub: 'Bind remote hosts per workspace; the Agent works there through ssh_exec / ssh_read_file and friends.',
      hosts: 'Remote hosts',
      count: '{n} hosts',
      empty: 'No remote hosts yet. Add the first one with the form below.',
      add: 'Add host',
      label: 'Name (optional)',
      host: 'Host / IP',
      port: 'Port',
      user: 'User',
      key: 'Identity file',
      save: 'Save',
      cancel: 'Cancel',
      saved: 'Saved',
      needHost: 'Host cannot be empty.',
      writeFailed: 'Failed to write config; see the host log.',
      exec: 'Execute',
      cmd: 'Command to run remotely',
      run: 'Run',
      running: 'Running…',
      needCmd: 'Command cannot be empty.',
      history: 'Recent runs',
      noHistory: 'No runs yet.',
      ok: 'exit 0',
      failed: 'failed',
      truncated: '(output truncated)',
      selectFirst: 'Select a host above first.',
      note: 'Key auth only: your key stays in your own ~/.ssh; no password is ever stored.',
      toolsOff: 'enableTools is false, so the Agent-facing tools are not registered; the panel still works.',
      readFailed: 'Failed to read config',
      loading: 'Loading…',
    };

    const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
    const fill = (text, values) => String(text).replace(/\{(\w+)\}/g, (all, key) => (key in values ? String(values[key]) : all));

    /* ------------------------------------------------------------------ */
    /* 样式                                                                */
    /* ------------------------------------------------------------------ */

    const CSS = [
      '.ssh-inner{box-sizing:border-box;height:100%;display:flex;flex-direction:column;gap:12px;overflow:auto;padding:20px 24px 40px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
      '.ssh-inner>*{width:100%;max-width:1100px}',
      '.ssh-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}',
      '.ssh-title{margin:0;font-size:18px;font-weight:600;line-height:26px}',
      '.ssh-sub{margin:4px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.ssh-card{display:flex;flex-direction:column;gap:10px;padding:14px;border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}',
      '.ssh-cardHead{font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.ssh-row{display:flex;align-items:center;gap:10px;min-width:0}',
      '.ssh-rowEnd{display:flex;align-items:center;gap:10px;justify-content:flex-end}',
      '.ssh-list{display:flex;flex-direction:column;gap:6px}',
      '.ssh-item{display:flex;align-items:center;gap:10px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;cursor:pointer;text-align:left;font:inherit;color:inherit;min-width:0}',
      '.ssh-item:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.ssh-item[data-active="true"]{border-color:var(--dsw-alias-brand-primary)}',
      '.ssh-itemName{font-size:13px;line-height:19px;font-weight:500}',
      '.ssh-itemMeta{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      /* 长主机名/命令一律 ellipsis：break-all 会把含中文的一行拆成一列。 */
      '.ssh-ell{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
      '.ssh-input{box-sizing:border-box;height:30px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;min-width:0}',
      '.ssh-input:focus-visible{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.ssh-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:30px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}',
      '.ssh-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}',
      /* 主按钮用描边式：主题里没有"与品牌色对照的前景色"令牌，
         而 brand-primary 在暗色主题下本身是浅色，填色+白字会直接看不见。 */
      '.ssh-btn[data-primary="true"]{border-color:var(--dsw-alias-brand-primary);background:transparent;color:var(--dsw-alias-brand-primary)}',
      '.ssh-btn:disabled{cursor:default;opacity:.55}',
      '.ssh-empty{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.ssh-error{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}',
      '.ssh-log{display:flex;flex-direction:column;gap:6px;max-height:280px;overflow:auto}',
      '.ssh-logItem{display:flex;flex-direction:column;gap:3px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:8px;min-width:0}',
      '.ssh-logCmd{font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ssh-logMeta{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
    ].join('');

    /* ------------------------------------------------------------------ */
    /* 主页面                                                              */
    /* ------------------------------------------------------------------ */

    function UsagePage({ ctx, t, internals }) {
      const [state, setState] = useState({ phase: 'loading', config: {}, error: null, notice: null });
      const [selectedId, setSelectedId] = useState('');
      const [draft, setDraft] = useState(null);
      const [command, setCommand] = useState('');
      const [busy, setBusy] = useState(false);

      // 挂载时读一次配置。**不赋值给变量**：`const load = useEffect(...)` 会把
      // 卸载函数存进没人用的常量，清理永不执行，而严格模式下看起来完全正常。
      useEffect(() => {
        let alive = true;
        (async () => {
          const settings = isObject(ctx.remote?.settings) ? ctx.remote.settings : undefined;
          if (settings === undefined || typeof settings.describe !== 'function') {
            if (alive) setState({ phase: 'ready', config: {}, error: t.readFailed, notice: null });
            return;
          }
          try {
            const response = await settings.describe();
            const read = internals.readConfig(response);
            if (alive) setState({ phase: 'ready', config: read.config ?? {}, error: null, notice: null });
          } catch (error) {
            if (alive) {
              setState({
                phase: 'ready',
                config: {},
                error: error instanceof Error ? error.message : String(error),
                notice: null,
              });
            }
          }
        })();
        return () => { alive = false; };
      }, []);

      const hosts = internals.normaliseHosts(state.config.hosts);
      const history = internals.normaliseHistory(state.config.internal?.history, 30);
      const selected = hosts.find((item) => item.id === selectedId) ?? null;

      const settings = isObject(ctx.remote?.settings) ? ctx.remote.settings : undefined;

      const persist = async (nextHosts) => {
        if (settings === undefined || typeof settings.mutate !== 'function') {
          setState((current) => ({ ...current, notice: t.writeFailed }));
          return false;
        }
        // 写整份 hosts 数组而不是某一行：`settings.mutate` 的 set 语义是替换该路径。
        await settings.mutate(CONFIG_NS, [{ op: 'set', path: ['hosts'], value: nextHosts }]);
        setState((current) => ({ ...current, config: { ...current.config, hosts: nextHosts }, notice: t.saved }));
        return true;
      };

      const onSaveDraft = async () => {
        if (draft === null) return;
        const host = String(draft.host ?? '').trim();
        if (host === '') {
          setState((current) => ({ ...current, notice: t.needHost }));
          return;
        }
        const entry = {
          id: draft.id ?? `host-${Date.now().toString(36)}`,
          label: String(draft.label ?? '').trim(),
          host,
          port: Number.isFinite(Number(draft.port)) ? Math.floor(Number(draft.port)) : 22,
          user: String(draft.user ?? '').trim(),
          identityFile: String(draft.identityFile ?? '').trim(),
          sshOptions: [],
          note: '',
          tags: [],
        };
        const next = draft.id === undefined || hosts.every((item) => item.id !== draft.id)
          ? [...hosts, entry]
          : hosts.map((item) => (item.id === draft.id ? { ...item, ...entry, id: item.id } : item));
        if (await persist(next)) {
          setDraft(null);
          setSelectedId(entry.id);
        }
      };

      const runCommand = async () => {
        const text = command.trim();
        if (selected === null || text === '') {
          setState((current) => ({ ...current, notice: selected === null ? t.selectFirst : t.needCmd }));
          return;
        }
        setBusy(true);
        try {
          const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined;
          if (tools === undefined || typeof tools.execute !== 'function') {
            setState((current) => ({ ...current, notice: t.readFailed }));
            return;
          }
          /*
           * 入参键名是 **`arguments`**，不是 `args`。
           * 依据：`_scratch/ref/dsh-tools.index.js:3411` 解构 `{ name, callId }`，
           * 3310 行 `tool.execute(exec.arguments, exec)`。写成 `args` 不会抛错，
           * 只会让宿主拿到空参数——工具里 `input.command` 是 undefined，
           * 于是"执行"静默变成"命令为空"。这类错误在界面上完全看不出来。
           */
          await tools.execute({
            name: 'ssh_exec',
            callId: `ssh-${Date.now().toString(36)}`,
            arguments: { hostId: selected.id, command: text },
          });
          // 记录由宿主写进 internal.history；重新读一次配置把它显示出来。
          if (settings !== undefined && typeof settings.describe === 'function') {
            const fresh = await settings.describe();
            const read = internals.readConfig(fresh);
            setState((current) => ({ ...current, config: read.config ?? {} }));
          }
        } catch (error) {
          setState((current) => ({
            ...current,
            notice: error instanceof Error ? error.message : String(error),
          }));
        } finally {
          setBusy(false);
        }
      };

      const body = [];

      body.push(h('div', { className: 'ssh-head', key: 'head' },
        h('div', null,
          h('h1', { className: 'ssh-title' }, t.title),
          h('p', { className: 'ssh-sub' }, t.sub)),
        h('button', {
          className: 'ssh-btn',
          type: 'button',
          onClick: () => setDraft({ id: undefined, label: '', host: '', port: 22, user: '', identityFile: '' }),
        }, t.add)));

      if (state.error !== null) body.push(h('p', { className: 'ssh-error', key: 'err' }, state.error));
      if (state.notice !== null) body.push(h('p', { className: 'ssh-sub', key: 'notice' }, state.notice));

      /* ---- 主机列表 ---- */
      body.push(h('div', { className: 'ssh-card', key: 'hosts' },
        h('div', { className: 'ssh-cardHead' }, `${t.hosts} · ${fill(t.count, { n: hosts.length })}`),
        hosts.length === 0
          ? h('p', { className: 'ssh-empty' }, t.empty)
          : h('div', { className: 'ssh-list' }, hosts.map((host) => h('button', {
              className: 'ssh-item',
              key: host.id,
              type: 'button',
              'data-active': String(host.id === selectedId),
              onClick: () => setSelectedId(host.id),
            },
              h('span', { className: 'ssh-ell', style: { flex: 1 } },
                h('span', { className: 'ssh-itemName' }, internals.hostDisplayName(host)),
                h('span', { className: 'ssh-itemMeta', style: { display: 'block' } }, internals.hostSummary(host))),
              h('span', { className: 'ssh-itemMeta ssh-ell' }, host.identityFile || '—'))))));

      /* ---- 新增 / 编辑表单 ---- */
      if (draft !== null) {
        const field = (key, label, extra) => h('input', {
          className: 'ssh-input',
          'aria-label': label,
          placeholder: label,
          value: String(draft[key] ?? ''),
          onChange: (event) => setDraft((current) => ({ ...current, [key]: event.target.value })),
          ...extra,
        });
        body.push(h('div', { className: 'ssh-card', key: 'form' },
          h('div', { className: 'ssh-cardHead' }, t.add),
          h('div', { className: 'ssh-row' },
            field('label', t.label, { style: { flex: 2 } }),
            field('host', t.host, { style: { flex: 3 } })),
          h('div', { className: 'ssh-row' },
            field('port', t.port, { type: 'number', min: '1', max: '65535', style: { flex: 1 } }),
            field('user', t.user, { style: { flex: 2 } })),
          h('div', { className: 'ssh-row' }, field('identityFile', t.key, { style: { flex: 1 } })),
          h('div', { className: 'ssh-rowEnd' },
            h('button', { className: 'ssh-btn', type: 'button', onClick: () => setDraft(null) }, t.cancel),
            h('button', { className: 'ssh-btn', type: 'button', 'data-primary': 'true', onClick: onSaveDraft }, t.save))));
      }

      /* ---- 选中主机的操作区 ---- */
      if (selected !== null) {
        body.push(h('div', { className: 'ssh-card', key: 'ops' },
          h('div', { className: 'ssh-cardHead' }, `${t.exec} · ${internals.hostDisplayName(selected)}`),
          h('div', { className: 'ssh-row' },
            h('input', {
              className: 'ssh-input',
              style: { flex: 1 },
              'aria-label': t.cmd,
              placeholder: t.cmd,
              value: command,
              onChange: (event) => setCommand(event.target.value),
            }),
            h('button', {
              className: 'ssh-btn',
              type: 'button',
              'data-primary': 'true',
              disabled: busy || command.trim() === '',
              onClick: runCommand,
            }, busy ? t.running : t.run))));

        body.push(h('div', { className: 'ssh-card', key: 'hist' },
          h('div', { className: 'ssh-cardHead' }, `${t.history} · ${history.length}`),
          history.length === 0
            ? h('p', { className: 'ssh-empty' }, t.noHistory)
            : h('div', { className: 'ssh-log' }, history.map((record) => h('div', {
                className: 'ssh-logItem',
                key: record.id,
              },
                h('span', { className: 'ssh-logCmd', title: record.command }, record.command),
                h('span', { className: 'ssh-logMeta' },
                  `${record.ok ? t.ok : t.failed} · ${internals.formatDuration(record.durationMs)} · ${new Date(record.at).toLocaleString()}`),
                record.detail === '' ? null : h('span', { className: 'ssh-logMeta ssh-ell' }, record.detail),
                record.truncated ? h('span', { className: 'ssh-logMeta' }, t.truncated) : null)))));
      } else if (hosts.length > 0) {
        body.push(h('p', { className: 'ssh-empty', key: 'hint' }, t.selectFirst));
      }

      body.push(h('p', { className: 'ssh-sub', key: 'note' }, t.note));
      if (state.config.enableTools === false) {
        body.push(h('p', { className: 'ssh-error', key: 'toolsoff' }, t.toolsOff));
      }

      if (state.phase === 'loading') {
        return h('div', { className: 'ssh-inner' }, h('p', { className: 'ssh-empty' }, t.loading));
      }
      return h('div', { className: 'ssh-inner' }, body);
    }

    /* ------------------------------------------------------------------ */
    /* 侧边栏图标                                                          */
    /* ------------------------------------------------------------------ */

    function PanelIcon() {
      return h('svg', { viewBox: '0 0 24 24', width: 20, height: 20, 'aria-hidden': true },
        h('g', { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
          h('rect', { x: 2.5, y: 4, width: 19, height: 16, rx: 3 }),
          h('path', { d: 'M2.5 8.5h19' }),
          h('path', { d: 'M6.5 12.2l2.4 2.4-2.4 2.4' }),
          h('path', { d: 'M11.6 17.4h5.6' })));
    }

    /* ------------------------------------------------------------------ */
    /* apply                                                              */
    /* ------------------------------------------------------------------ */

    function apply(ctx) {
      const raw = typeof ctx.locale?.current === 'function' ? ctx.locale.current() : ctx.locale?.current;
      const t = typeof raw === 'string' && raw.startsWith('zh') ? zh : en;
      /*
       * 宿主通过 globalThis 暴露纯函数（index.js 里挂的
       * `__SSH_WORKSPACE_INTERNALS__`）。两半用**同一份**算法——各写一份是
       * "界面显示的端口和实际连的端口不一致"这类 bug 的直接来源。
       * 全部做了兜底：宿主半没起来时面板至少不该白屏。
       */
      const internals = globalThis.__SSH_WORKSPACE_INTERNALS__ ?? {};
      const safe = {
        readConfig: typeof internals.readConfig === 'function' ? internals.readConfig : () => ({ found: false, config: {} }),
        normaliseHosts: typeof internals.normaliseHosts === 'function' ? internals.normaliseHosts : (list) => (Array.isArray(list) ? list : []),
        hostDisplayName: typeof internals.hostDisplayName === 'function' ? internals.hostDisplayName : () => '',
        hostSummary: typeof internals.hostSummary === 'function' ? internals.hostSummary : () => '',
        normaliseHistory: typeof internals.normaliseHistory === 'function' ? internals.normaliseHistory : (list) => (Array.isArray(list) ? list : []),
        formatDuration: typeof internals.formatDuration === 'function' ? internals.formatDuration : () => '—',
      };

      /* 样式：工厂无副作用，注入与回收都放进 ctx.effect。 */
      ctx.effect(() => {
        const tag = document.createElement('style');
        tag.setAttribute('data-plugin-css', JSON.stringify('dsh-plugin-ssh-workspace'));
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => { tag.remove(); };
      }, 'ssh-workspace: styles');

      /* 国际化：失败只降级成英文，不该让整个席位消失。 */
      try {
        if (typeof ctx.locale?.register === 'function') {
          ctx.locale.register({ [PANEL_ID]: zh }, 'zh-CN');
          ctx.locale.register({ [PANEL_ID]: en }, 'en-US');
        }
      } catch {
        /* 忽略 */
      }

      /**
       * 席位注册。**必须是 generator 形式**——见文件头第 1 条。
       * 回调返回的是 `SlotInjectionEffect`（可迭代的 disposer 序列），
       * 不是普通 disposer；这也和已发布代码 `dsh-client-ui-sidebar-right`
       * 的写法逐字一致。
       */
      const contribute = (ownerKey, options, component) => {
        if (typeof ctx.slots?.inject !== 'function') return;
        ctx.slots.inject(ownerKey, function* () {
          yield ctx.slots.register(options, component);
        });
      };

      const openPage = () => {
        // 打开主页面：宿主侧若提供了导航服务就用它；这里没有通用入口时
        // 退化为无操作——入口本身仍可点，用户从侧边栏关掉再开也能看到页面。
        const remote = isObject(ctx.remote) ? ctx.remote : {};
        for (const key of Object.keys(remote)) {
          const service = remote[key];
          if (isObject(service) && typeof service.open === 'function') {
            try { service.open(PANEL_ID); return; } catch { /* 试下一个 */ }
          }
        }
      };

      contribute('sidebar.panellist', {
        key: PANEL_ID,
        order: 40,
        icon: PanelIcon,
        title: t.title,
        onClick: openPage,
      }, PanelIcon);

      contribute('main', { key: PANEL_ID, order: 40 }, () => h(UsagePage, { ctx, t, internals: safe }));

      return undefined;
    }

    return {
      /*
       * 客户端半的 `inject` 与宿主半**不是一回事**——一度写成 `['settings']`
       * （那是宿主侧的形状）。客户端要访问的三个服务属性都必须在这里声明：
       *
       *   - `slots`           注册席位（访问 ctx.slots）
       *   - `locale`          注册文案（访问 ctx.locale）
       *   - `remote` /
       *     `remote.settings` 读写设置（访问 ctx.remote.settings）
       *
       * 漏一个就抛 `cannot get property "x" without inject`，而它在 apply 期间
       * 抛出意味着**整个客户端半不激活**——界面上是"插件装了但毫无迹象"，
       * 诊断里只有一行 `1 entry did not activate`，极难定位。
       *
       * 取值照抄已真机验证的另两个插件（token-usage / scheduled-tasks）。
       */
      inject: ['slots', 'locale', 'remote', 'remote.settings'],
      apply,
    };
  },
});
