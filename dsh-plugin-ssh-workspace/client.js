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
      hostsFromConfig: '来自 ~/.ssh/config',
      reloadHosts: '重新读取配置',
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
      browse: '远程目录',
      browseHint: '浏览远端目录，选中一个作为工作目录。Agent 会用 ssh_exec 在它下面执行命令。',
      browsePath: '远端路径（如 /home/me/project）',
      needPath: '请先填一个远端路径。',
      list: '列出',
      listing: '读取中…',
      up: '上一层',
      root: '根目录',
      dirEmpty: '这个目录是空的。',
      notADirectory: '可能不是目录，或没有读取权限。',
      selectedDir: '当前工作目录',
      useDir: '用这个目录',
      usedDir: '已选为工作目录，可直接让 Agent 在这里干活。',
      entriesCount: '{n} 项',
      note: '只支持私钥认证：密钥留在你自己的 ~/.ssh 里，插件不存任何口令。',
      toolsOff: 'enableTools 为 false，Agent 侧工具未注册；面板仍可使用。',
      readFailed: '读取配置失败',
      loading: '载入中…',
    };

    const en = {
      title: 'SSH Remote Workspace',
      sub: 'Bind remote hosts per workspace; the Agent works there through ssh_exec / ssh_read_file and friends.',
      hosts: 'Remote hosts',
      hostsFromConfig: 'from ~/.ssh/config',
      reloadHosts: 'Re-read config',
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
      browse: 'Remote directory',
      browseHint: 'Browse a remote directory and pick one to work in. The Agent runs commands there with ssh_exec.',
      browsePath: 'Remote path (e.g. /home/me/project)',
      needPath: 'Enter a remote path first.',
      list: 'List',
      listing: 'Reading…',
      up: 'Up',
      root: 'Root',
      dirEmpty: 'This directory is empty.',
      notADirectory: 'Probably not a directory, or not readable.',
      selectedDir: 'Working directory',
      useDir: 'Use this directory',
      usedDir: 'Selected. You can ask the Agent to work here now.',
      entriesCount: '{n} entries',
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
      /* ---- 远程目录浏览（看起来像工作区选择器） ---------------------- */
      '.ssh-crumbs{display:flex;flex-wrap:wrap;align-items:center;gap:4px;font-size:12px;line-height:18px;min-width:0}',
      '.ssh-crumb{border:0;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:12px;cursor:pointer;padding:0 2px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ssh-crumb:hover{text-decoration:underline}',
      '.ssh-crumb[data-current="true"]{color:var(--dsw-alias-label-primary);cursor:default;font-weight:500}',
      '.ssh-dir{display:flex;flex-direction:column;gap:4px;max-height:300px;overflow:auto;border:.5px solid var(--dsw-alias-border-l1);border-radius:8px;padding:4px}',
      '.ssh-dirItem{display:flex;align-items:center;gap:8px;padding:5px 8px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;min-width:0}',
      '.ssh-dirItem:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.ssh-dirItem[data-plain="true"]{cursor:default}',
      '.ssh-dirName{flex:1;font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ssh-dirMeta{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.ssh-cwd{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:12px;line-height:18px;min-width:0}',
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
      /** 目录浏览：当前路径输入、待配对的请求 id、是否在等结果。 */
      const [browsePath, setBrowsePath] = useState('');
      const [browseBusy, setBrowseBusy] = useState(false);
      const [listing, setListing] = useState(null);
      /** 人工选定的"当前工作目录"，展示给用户并可作为命令的执行目录。 */
      const [workdir, setWorkdir] = useState('');

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

      /*
       * 主机来自 `~/.ssh/config`，由宿主读出来投影到 `internal.sshHosts`。
       *
       * **不再有手填主机表单**：ssh config 已经是主机信息的权威副本，在插件里再
       * 维护一份只会产生"面板写的和 ssh 实际连的不一致"。客户端读不到文件，
       * 所以列表必须由宿主投影过来。
       */
      const sshHosts = Array.isArray(state.config.internal?.sshHosts) ? state.config.internal.sshHosts : [];
      const sshWarnings = Array.isArray(state.config.internal?.sshWarnings) ? state.config.internal.sshWarnings : [];
      const hosts = internals.normaliseHosts(sshHosts);
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

      /**
       * 请求列出远端目录。
       *
       * 客户端**不能**直接执行远端命令：它拿不到 `tools` 服务，也没有新增 Remote
       * 命名空间的权限。所以走"设置即通道"：
       *   写入 `internal.request` → 宿主收到 `settings/document-updated` → 执行
       *   → 写 `internal.result` → 这里短轮询 `describe()` 把结果取回。
       *
       * 轮询是**有界**的（最多约 20 秒），且只在用户点了「列出」之后才开始——
       * 不是常驻轮询。宿主的执行是事件驱动的，没有定时器。
       */
      const requestListing = async (rawPath) => {
        if (selected === null) {
          setState((current) => ({ ...current, notice: t.selectFirst }));
          return;
        }
        const path = String(rawPath ?? '').trim();
        if (path === '') {
          setState((current) => ({ ...current, notice: t.needPath }));
          return;
        }
        if (settings === undefined || typeof settings.mutate !== 'function') {
          setState((current) => ({ ...current, notice: t.writeFailed }));
          return;
        }
        const id = `ls-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
        setBrowseBusy(true);
        setListing(null);
        try {
          await settings.mutate(CONFIG_NS, [
            { op: 'set', path: ['internal', 'request'], value: { id, hostId: selected.id, path, at: Date.now() } },
          ]);
          // 短轮询等结果：宿主是事件驱动的，处理完会写 result。
          const deadline = Date.now() + 20_000;
          while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 400));
            const response = await settings.describe();
            const read = internals.readConfig(response);
            const result = read.config?.internal?.result;
            if (isObject(result) && result.id === id) {
              setState((current) => ({ ...current, config: read.config ?? {} }));
              setListing(result);
              setWorkdir(result.ok === true ? String(result.path ?? path) : '');
              break;
            }
          }
        } catch (error) {
          setState((current) => ({
            ...current,
            notice: error instanceof Error ? error.message : String(error),
          }));
        } finally {
          setBrowseBusy(false);
        }
      };

      /** 把路径切成可点的面包屑（根 → 当前）。 */
      const crumbsOf = (path) => {
        const text = String(path ?? '');
        if (text === '' || text === '/') return [{ label: '/', path: '/' }];
        const parts = text.split('/').filter((segment) => segment !== '');
        const out = [{ label: '/', path: '/' }];
        let built = '';
        for (const segment of parts) {
          built += `/${segment}`;
          out.push({ label: segment, path: built });
        }
        return out;
      };

      const parentOf = (path) => {
        const text = String(path ?? '');
        if (text === '' || text === '/') return '/';
        const trimmed = text.replace(/\/+$/, '');
        const slash = trimmed.lastIndexOf('/');
        return slash <= 0 ? '/' : trimmed.slice(0, slash);
      };

      /**
       * 重新读一次 ssh config。
       *
       * 客户端读不到文件，所以只能请宿主重读：写一个时间戳触发
       * `settings/document-updated`，宿主在那次事件里会 `syncHosts()`，
       * 然后这里重新 `describe()` 把新的列表取回来。
       */
      const reloadHosts = async () => {
        if (settings === undefined || typeof settings.mutate !== 'function') return;
        try {
          await settings.mutate(CONFIG_NS, [
            { op: 'set', path: ['internal', 'hostsRequestedAt'], value: Date.now() },
          ]);
          await new Promise((resolve) => setTimeout(resolve, 600));
          const response = await settings.describe();
          const read = internals.readConfig(response);
          setState((current) => ({ ...current, config: read.config ?? {}, notice: null }));
        } catch (error) {
          setState((current) => ({
            ...current,
            notice: error instanceof Error ? error.message : String(error),
          }));
        }
      };

      const body = [];

      /*
       * 页头**不放"新增主机"按钮**：主机来自 ssh config，没有可新增的东西。
       * 早期版本这里有个按钮而它从来没显示出来（详情见 scripts/render-dump.mjs
       * 的调查）——现在那个表单整个去掉了，问题也随之消失。
       */
      body.push(h('div', { className: 'ssh-head', key: 'head' },
        h('div', null,
          h('h1', { className: 'ssh-title' }, t.title),
          h('p', { className: 'ssh-sub' }, t.sub)),
        h('button', {
          className: 'ssh-btn',
          type: 'button',
          title: state.config.internal?.sshConfigPath ?? '',
          onClick: () => void reloadHosts(),
        }, t.reloadHosts)));

      if (state.error !== null) body.push(h('p', { className: 'ssh-error', key: 'err' }, state.error));
      if (state.notice !== null) body.push(h('p', { className: 'ssh-sub', key: 'notice' }, state.notice));

      // ssh config 的读取说明（文件不存在、Include 未展开等）要显示出来，
      // 否则"列表是空的"会被理解成插件坏了。
      for (const [index, warning] of sshWarnings.entries()) {
        body.push(h('p', { className: 'ssh-sub', key: `warn-${index}` }, warning));
      }

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

        /* ---- 远程目录浏览：看起来像工作区选择器 -------------------- */
        const crumbs = crumbsOf(listing !== null && listing.ok === true ? listing.path : browsePath);
        const entries = listing !== null && Array.isArray(listing.entries) ? listing.entries : [];

        body.push(h('div', { className: 'ssh-card', key: 'browse' },
          h('div', { className: 'ssh-cardHead' }, `${t.browse} · ${internals.hostDisplayName(selected)}`),
          h('p', { className: 'ssh-sub', style: { margin: 0 } }, t.browseHint),

          // 路径输入 + 列出 + 上一层
          h('div', { className: 'ssh-row' },
            h('input', {
              className: 'ssh-input',
              style: { flex: 1 },
              'aria-label': t.browsePath,
              placeholder: t.browsePath,
              value: browsePath,
              onChange: (event) => setBrowsePath(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter') void requestListing(browsePath); },
            }),
            h('button', {
              className: 'ssh-btn',
              type: 'button',
              'data-primary': 'true',
              disabled: browseBusy || browsePath.trim() === '',
              onClick: () => void requestListing(browsePath),
            }, browseBusy ? t.listing : t.list),
            h('button', {
              className: 'ssh-btn',
              type: 'button',
              disabled: browseBusy || browsePath === '',
              onClick: () => { const up = parentOf(browsePath); setBrowsePath(up); void requestListing(up); },
            }, t.up)),

          // 面包屑（每一节都可点，像路径导航）
          listing !== null && listing.ok === true
            ? h('div', { className: 'ssh-crumbs' }, crumbs.map((crumb, index) => h('button', {
                className: 'ssh-crumb',
                key: crumb.path,
                type: 'button',
                'data-current': String(index === crumbs.length - 1),
                title: crumb.path,
                onClick: () => {
                  if (index === crumbs.length - 1) return;
                  setBrowsePath(crumb.path);
                  void requestListing(crumb.path);
                },
              }, crumb.label)))
            : null,

          // 当前选定的工作目录
          workdir === '' ? null : h('div', { className: 'ssh-cwd' },
            h('span', { className: 'ssh-dirMeta' }, t.selectedDir),
            h('span', { className: 'ssh-dirName', title: workdir }, workdir)),

          // 结果
          listing === null
            ? null
            : listing.ok !== true
              ? h('p', { className: 'ssh-error' }, `${t.notADirectory} ${listing.detail ?? ''}`.trim())
              : entries.length === 0
                ? h('p', { className: 'ssh-empty' }, t.dirEmpty)
                : h('div', { className: 'ssh-dir' }, entries.map((entry) => h('button', {
                    className: 'ssh-dirItem',
                    key: entry.path,
                    type: 'button',
                    'data-plain': String(entry.directory !== true),
                    title: entry.path,
                    onClick: () => {
                      if (entry.directory !== true) return;
                      setBrowsePath(entry.path);
                      void requestListing(entry.path);
                    },
                  },
                    h('span', { className: 'ssh-dirName' }, entry.directory === true ? `${entry.name}/` : entry.name),
                    h('span', { className: 'ssh-dirMeta' },
                      entry.directory === true ? '' : internals.formatBytes(entry.size)))))));
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
        formatBytes: typeof internals.formatBytes === 'function' ? internals.formatBytes : () => '',
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

      /*
       * 席位注册。
       *
       * 三件事缺一不可，缺了都不会报错，只是界面上"没有这个东西"：
       *
       * 1. **回调必须是 generator 形式**（见文件头第 1 条）。
       * 2. **注册要放进 `ctx.effect`**，由 fiber 拥有注册与清理的生命周期。
       * 3. **options 的字段名不是随便起的**（这一条我一开始写错了）：
       *      - `name`  必须是席位名本身，`sidebar.panellist` 与 `main` 都要给；
       *      - 侧边栏用 **`id`**，主页面用 **`key`**——两者不是同一个字段；
       *      - 标题是 **`label: () => string`**（函数），不是 `title: string`。
       *    我原先写的是 `{ key, order, icon, title, onClick }`，于是侧边栏那一格
       *    永远不会出现，而控制台里没有一行报错。
       *
       * 取值形状照抄已真机验证的 token-usage / scheduled-tasks。
       */
      ctx.effect(() => {
        const offs = [];
        const contribute = (ownerKey, options, component) => {
          if (typeof ctx.slots?.inject !== 'function' || typeof ctx.slots?.register !== 'function') return;
          const off = ctx.slots.inject(ownerKey, function* () {
            yield ctx.slots.register(options, component);
          });
          if (typeof off === 'function') offs.push(off);
        };

        contribute('sidebar.panellist', {
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 40,
          label: () => t.title,
        }, PanelIcon);

        contribute('main', { name: 'main', key: PANEL_ID }, () => h(UsagePage, { ctx, t, internals: safe }));

        return () => {
          for (const off of offs) {
            try {
              off();
            } catch {
              /* 单个注销失败不该阻塞其余 */
            }
          }
        };
      }, 'ssh-workspace: slots');

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
