/**
 * 「远程 DSH 主机」——浏览器侧。
 *
 * 左侧栏一个独立菜单，主面板列出：
 *   - `~/.ssh/config` 里的 Host（由宿主用 `ssh -G` 解析成有效值）
 *   - 用户手动添加的远端
 *
 * 每个远端可以探活、在远端全局安装/升级官方 dsh、启动 `dsh web`、停止、看日志；
 * 启动成功后宿主会在本地建同端口 SSH 隧道并返回带 token 的 URL，这里用
 * `ctx.sidebarRight.openTab('browser', { params: { url } })` 在右侧栏打开。
 *
 * 远端 Web 和本地 DSH 是两个独立 Host：侧栏只是远端 UI 的窗口，不共享 session。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-remote-dsh',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const LOCALE_NS = 'plugin.remote-dsh';
    const MENU_ID = 'remote-dsh';
    const API_ROOT = '/plugin-remote-dsh/api/';

    const zh = {
      menu: '远程 DSH',
      title: '远程 DSH',
      subtitle: '通过 SSH 管理远端 DSH Web；启动后可在此用浏览器打开，或进入会话用右侧栏启动菜单。',
      eyebrow: 'SSH 远程工作区',
      runningStat: '{count} 个运行中',
      hostStat: '{count} 台主机',
      mode: '启动方式',
      modeNpx: 'npx（缓存，@latest）',
      modeGlobal: '全局 dsh（一份，可升级）',
      modeNpxHint: '远端不需要预装 dsh；每次按 @latest 解析，缓存已有版本。',
      modeGlobalHint: '安装到远端用户级全局前缀 ~/.npm-global（一份、可升级，不需要 sudo）。',
      registry: 'npm Registry',
      registryHint: '默认 npmmirror；留空使用远端 .npmrc。',
      remoteRegistry: '远端 npm registry',
      sshTunnelHint: '远端 Web 只绑 loopback，通过 ssh -L 隧道访问，不要求同一局域网。跳板机用 ssh_config 的 ProxyJump，或手动主机的 ProxyJump 字段。',
      refresh: '刷新',
      openSidebar: '右侧栏',
      openBrowser: '浏览器',
      launcherTitle: '远程 DSH',
      launcherGuide: '打开已启动的远端',
      launcherHint: '只列出已启动的远端；先在左侧「远程 DSH」启动一个。',
      launcherEmpty: '还没有已启动的远端。',
      addHost: '添加远端',
      addTitle: '手动添加远端',
      save: '保存',
      cancel: '取消',
      label: '名称',
      sshTarget: 'SSH 目标',
      sshTargetHint: '~/.ssh/config 的 Host 别名，或 user@host',
      sshPort: 'SSH 端口',
      identityFile: '私钥路径',
      proxyJump: '跳板机',
      remotePort: '远端端口',
      optional: '可选',
      hosts: '远端列表',
      noHosts: '还没有可用的远端。检查 ~/.ssh/config，或手动添加一个。',
      loading: '正在读取主机…',
      loadFailed: '读取主机失败：{message}',
      retry: '重试',
      sourceSsh: 'ssh config',
      sourceManual: '手动',
      running: '运行中',
      stopped: '未启动',
      probe: '探活',
      probing: '探活中…',
      install: '安装 / 升级',
      installing: '安装中…',
      start: '启动并打开',
      starting: '启动中…',
      restart: '重启',
      stop: '停止',
      stopping: '停止中…',
      open: '打开',
      opening: '打开中…',
      logs: '日志',
      hideLogs: '收起日志',
      remove: '删除',
      removed: '远端已删除',
      confirmRemove: '删除这个手动远端？正在运行的实例会先停止。',
      probeOk: 'SSH 可用',
      probeFailed: '探活失败',
      platform: '系统',
      node: 'Node',
      npm: 'npm',
      npx: 'npx',
      dsh: 'dsh',
      version: '版本',
      npmPrefix: 'npm 全局前缀',
      notInstalled: '未安装',
      installed: '已安装',
      portLabel: '端口',
      portAutoHint: '冲突时自动避让',
      addSaved: '已添加远端',
      installDone: '安装完成：{version}',
      started: '远端已启动，正在打开侧栏',
      stoppedNotice: '远端已停止',
      logEmpty: '暂无日志。',
      logFailed: '读取日志失败：{message}',
      unauthorized: '本地 API 令牌无效，刷新页面后重试。',
      sshConfigErrors: '部分 ssh 配置无法解析：{message}',
      portInUseConfirm: '远端端口 {port} 已被占用（通常是已有的 dsh web）。停止那个实例并在这里重新启动吗？会话会保留，但旧 URL/token 会失效。',
      portAdjusted: '本地端口 {requested} 已被占用，已自动改用 {port}（远端和本地同端口）。',
      unknownError: '未知错误',
      openFailed: '无法打开侧栏浏览器，已尝试新窗口。',
      deleteConfirm: '确认删除？',
    };

    const en = {
      menu: 'Remote DSH',
      title: 'Remote DSH',
      subtitle: 'Manage remote DSH Web over SSH; open one in a browser here, or use a session’s launcher for the sidebar.',
      eyebrow: 'SSH WORKSPACES',
      runningStat: '{count} running',
      hostStat: '{count} hosts',
      mode: 'Start mode',
      modeNpx: 'npx (cached, @latest)',
      modeGlobal: 'Global dsh (single copy, upgradeable)',
      modeNpxHint: 'No preinstalled dsh needed; resolves @latest and reuses the npx cache.',
      modeGlobalHint: 'Installs into the remote user-global prefix ~/.npm-global (one upgradeable copy; no sudo).',
      registry: 'npm registry',
      registryHint: 'Defaults to npmmirror; leave empty to use the remote .npmrc.',
      remoteRegistry: 'Remote npm registry',
      sshTunnelHint: 'The remote Web binds loopback and is reached over an ssh -L tunnel; same-LAN is not required. Use ssh_config ProxyJump or the manual host ProxyJump field for a jump host.',
      refresh: 'Refresh',
      openSidebar: 'Right sidebar',
      openBrowser: 'Browser',
      launcherTitle: 'Remote DSH',
      launcherGuide: 'Open a running remote',
      launcherHint: 'Only running remotes are listed. Start one from Remote DSH first.',
      launcherEmpty: 'No running remotes yet.',
      addHost: 'Add remote',
      addTitle: 'Add a remote',
      save: 'Save',
      cancel: 'Cancel',
      label: 'Label',
      sshTarget: 'SSH target',
      sshTargetHint: 'A ~/.ssh/config Host alias, or user@host',
      sshPort: 'SSH port',
      identityFile: 'Identity file',
      proxyJump: 'Proxy jump',
      remotePort: 'Remote port',
      optional: 'optional',
      hosts: 'Remotes',
      noHosts: 'No remote yet. Check ~/.ssh/config, or add one manually.',
      loading: 'Loading hosts…',
      loadFailed: 'Could not load hosts: {message}',
      retry: 'Retry',
      sourceSsh: 'ssh config',
      sourceManual: 'manual',
      running: 'Running',
      stopped: 'Stopped',
      probe: 'Probe',
      probing: 'Probing…',
      install: 'Install / upgrade',
      installing: 'Installing…',
      start: 'Start and open',
      starting: 'Starting…',
      restart: 'Restart',
      stop: 'Stop',
      stopping: 'Stopping…',
      open: 'Open',
      opening: 'Opening…',
      logs: 'Logs',
      hideLogs: 'Hide logs',
      remove: 'Delete',
      removed: 'Remote removed',
      confirmRemove: 'Delete this manual remote? A running instance will be stopped first.',
      probeOk: 'SSH reachable',
      probeFailed: 'Probe failed',
      platform: 'Platform',
      node: 'Node',
      npm: 'npm',
      npx: 'npx',
      dsh: 'dsh',
      version: 'Version',
      npmPrefix: 'npm global prefix',
      notInstalled: 'not installed',
      installed: 'installed',
      portLabel: 'Port',
      portAutoHint: 'Auto-avoids conflicts',
      addSaved: 'Remote added',
      installDone: 'Installed: {version}',
      started: 'Remote started; opening the sidebar',
      stoppedNotice: 'Remote stopped',
      logEmpty: 'No log yet.',
      logFailed: 'Could not read logs: {message}',
      unauthorized: 'Local API token rejected; refresh the page and retry.',
      sshConfigErrors: 'Some SSH entries could not be resolved: {message}',
      portInUseConfirm: 'Remote port {port} is already in use (usually an existing dsh web). Stop that instance and restart here? Sessions are preserved, but the old URL/token stops working.',
      portAdjusted: 'Local port {requested} was busy; using {port} on both sides instead.',
      unknownError: 'Unknown error',
      openFailed: 'Could not open the sidebar browser; tried a new window instead.',
      deleteConfirm: 'Confirm delete?',
    };

    const CSS = [
      '.rdsh-root{height:100%;box-sizing:border-box;overflow:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
      '.rdsh-inner{display:flex;flex-direction:column;gap:14px;max-width:960px;margin:0 auto;padding:24px 20px 48px}',
      '.rdsh-head{display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap}',
      '.rdsh-headings{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}',
      '.rdsh-title{font-size:18px;font-weight:600;line-height:26px;color:var(--dsw-alias-label-primary)}',
      '.rdsh-sub{font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary)}',
      '.rdsh-head-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.rdsh-seg{display:inline-flex;overflow:hidden;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm)}',
      '.rdsh-seg>button{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:16px;padding:5px 9px;cursor:pointer}',
      '.rdsh-seg>button[aria-pressed="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.rdsh-hosts-title{font-size:12px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-primary);margin-top:4px}',
      '.rdsh-hint{font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary)}',
      '.rdsh-hint--error{color:var(--dsw-alias-state-error-primary)}',
      '.rdsh-registry{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.rdsh-registry-label{font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);flex:none}',
      '.rdsh-registry-input{max-width:380px;flex:1 1 240px}',
      '.rdsh-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;min-height:30px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;padding:3px 11px;cursor:pointer;white-space:nowrap;appearance:none;-webkit-appearance:none}',
      '.rdsh-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.rdsh-btn:active:not(:disabled){background:var(--dsw-alias-button-ghost-active-fill)}',
      '.rdsh-btn:focus{outline:none}',
      '.rdsh-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}',
      '.rdsh-btn:disabled{opacity:.45;cursor:not-allowed}',
      '.rdsh-btn--primary{border-color:var(--dsw-alias-border-l4);font-weight:500}',
      '.rdsh-btn--danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '.rdsh-btn--small{min-height:24px;padding:1px 8px;font-size:11px;line-height:16px;border-radius:var(--dsw-radius-sm)}',
      '.rdsh-card{display:flex;flex-direction:column;gap:10px;border:.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l4));border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2));padding:12px 14px}',
      '.rdsh-card-head{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap}',
      '.rdsh-card-title{display:flex;align-items:center;gap:7px;flex-wrap:wrap;min-width:0}',
      '.rdsh-name{font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary)}',
      '.rdsh-target{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
      '.rdsh-card-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-left:auto}',
      '.rdsh-badge{display:inline-flex;align-items:center;gap:3px;border:.5px solid var(--dsw-alias-border-l3);border-radius:999px;padding:0 7px;font-size:10px;line-height:17px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.rdsh-badge--ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}',
      '.rdsh-badge--warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}',
      '.rdsh-badge--error{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '.rdsh-probe{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:5px 12px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base)}',
      '.rdsh-probe-row{display:flex;align-items:baseline;gap:6px;min-width:0;font-size:11px;line-height:17px}',
      '.rdsh-probe-key{color:var(--dsw-alias-label-secondary);flex:none}',
      '.rdsh-probe-val{color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere}',
      '.rdsh-toolbar{display:flex;align-items:center;gap:7px;flex-wrap:wrap}',
      '.rdsh-port{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.rdsh-input{box-sizing:border-box;width:100%;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;padding:5px 8px}',
      '.rdsh-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
      '.rdsh-input--port{width:78px}',
      '.rdsh-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);padding:12px;background:var(--dsw-alias-bg-base)}',
      '@media (max-width:640px){.rdsh-form{grid-template-columns:minmax(0,1fr)}}',
      '.rdsh-field{display:flex;flex-direction:column;gap:3px;min-width:0}',
      '.rdsh-field--wide{grid-column:1/-1}',
      '.rdsh-label{font-size:11px;line-height:16px;color:var(--dsw-alias-label-primary);font-weight:500}',
      '.rdsh-form-actions{display:flex;justify-content:flex-end;gap:8px;grid-column:1/-1}',
      '.rdsh-log{max-height:280px;overflow:auto;margin:0;padding:9px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:17px;white-space:pre-wrap;overflow-wrap:anywhere}',
      '.rdsh-launcher{box-sizing:border-box;display:flex;flex-direction:column;gap:10px;height:100%;overflow:auto;padding:14px}',
      '.rdsh-launcher-head{display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.rdsh-launcher-title{font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.rdsh-launcher-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-m);background:transparent}',
      '.rdsh-launcher-copy{min-width:0}',
      '.rdsh-launcher-name{font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rdsh-launcher-meta{font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary)}',
      '.rdsh-launcher-actions{display:flex;flex:none;flex-wrap:wrap;gap:6px}',
      '.rdsh-note{border-radius:var(--dsw-radius-sm);padding:7px 10px;font-size:12px;line-height:18px}',
      '.rdsh-note--ok{border:.5px solid var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}',
      '.rdsh-note--error{border:.5px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.rdsh-note--warn{border:.5px solid var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}',
      '.rdsh-empty{display:flex;align-items:center;justify-content:center;min-height:140px;padding:18px;border:.5px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;text-align:center}',
      '.rdsh-root{height:100%;box-sizing:border-box;overflow:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
      '.rdsh-inner{display:flex;flex-direction:column;gap:18px;max-width:1080px;margin:0 auto;padding:32px 24px 56px;box-sizing:border-box}',
      '.rdsh-hero{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;flex-wrap:wrap;padding:4px 0 2px}',
      '.rdsh-hero-copy{display:flex;flex-direction:column;gap:6px;min-width:0;max-width:660px}',
      '.rdsh-eyebrow{font-size:10px;line-height:16px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}',
      '.rdsh-title{font-size:26px;line-height:34px;font-weight:650;letter-spacing:-.02em;margin:0;color:var(--dsw-alias-label-primary)}',
      '.rdsh-sub{font-size:13px;line-height:21px;color:var(--dsw-alias-label-secondary);margin:0}',
      '.rdsh-stats{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}',
      '.rdsh-stat{display:inline-flex;align-items:center;gap:6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;padding:2px 9px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary)}',
      '.rdsh-stat-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 3px var(--dsw-alias-bg-layer-2)}',
      '.rdsh-hero-actions{display:flex;align-items:center;gap:8px}',
      '.rdsh-controls{display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap;padding:14px 16px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1)}',
      '.rdsh-control{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.rdsh-control-label{font-size:10px;line-height:15px;text-transform:uppercase;letter-spacing:.08em;color:var(--dsw-alias-label-secondary);font-weight:600}',
      '.rdsh-control--registry{flex:1 1 300px;min-width:240px}',
      '.rdsh-control-note{flex-basis:100%;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary)}',
      '.rdsh-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:30px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;padding:3px 11px;cursor:pointer;white-space:nowrap;appearance:none;-webkit-appearance:none}',
      '.rdsh-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.rdsh-btn:active:not(:disabled){background:var(--dsw-alias-button-ghost-active-fill)}',
      '.rdsh-btn:focus{outline:none}',
      '.rdsh-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}',
      '.rdsh-btn:disabled{opacity:.45;cursor:not-allowed}',
      '.rdsh-btn--primary{border-color:var(--dsw-alias-border-l2);font-weight:600}',
      '.rdsh-btn--quiet{border-color:transparent;color:var(--dsw-alias-label-secondary);padding:3px 8px}',
      '.rdsh-btn--quiet:hover:not(:disabled){color:var(--dsw-alias-label-primary)}',
      '.rdsh-btn--quiet.rdsh-btn--danger{color:var(--dsw-alias-state-error-primary);border-color:transparent}',
      '.rdsh-btn--danger{color:var(--dsw-alias-state-error-primary)}',
      '.rdsh-btn--small{min-height:26px;padding:2px 9px;font-size:11px;line-height:17px;border-radius:var(--dsw-radius-sm)}',
      '.rdsh-btn--small.rdsh-btn--primary{padding:2px 10px}',
      '.rdsh-btn--icon{width:30px;height:30px;min-height:30px;padding:0;justify-content:center}',
      '.rdsh-btn-glyph{display:inline-flex;align-items:center;flex:none}',
      '.rdsh-seg{display:inline-flex;overflow:hidden;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base)}',
      '.rdsh-seg>button{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:17px;padding:4px 12px;cursor:pointer}',
      '.rdsh-seg>button[aria-pressed="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:500}',
      '.rdsh-section{display:flex;flex-direction:column;gap:10px}',
      '.rdsh-section-head{display:flex;align-items:center;justify-content:space-between;gap:12px}',
      '.rdsh-section-title{font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.rdsh-section-note{font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary)}',
      '.rdsh-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;align-items:start}',
      '@media (max-width:860px){.rdsh-grid{grid-template-columns:minmax(0,1fr)}}',
      '.rdsh-host-card{display:flex;flex-direction:column;gap:10px;padding:15px 16px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);min-width:0;transition:border-color .15s ease,background .15s ease}',
      '.rdsh-host-card:hover{border-color:var(--dsw-alias-border-l3)}',
      '.rdsh-host-top{display:flex;align-items:flex-start;gap:9px;min-width:0}',
      '.rdsh-host-status{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);margin-top:8px;flex:none}',
      '.rdsh-host-status--on{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 3px var(--dsw-alias-bg-layer-2)}',
      '.rdsh-host-main{flex:1;min-width:0}',
      '.rdsh-host-name-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}',
      '.rdsh-host-name{font-size:14px;line-height:22px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}',
      '.rdsh-host-target{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);margin-top:2px;overflow-wrap:anywhere}',
      '.rdsh-port-pill{flex:none;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:17px;padding:1px 7px;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base)}',
      '.rdsh-badge{display:inline-flex;align-items:center;gap:3px;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 6px;font-size:10px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.rdsh-badge--muted{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l1)}',
      '.rdsh-badge--ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}',
      '.rdsh-badge--error{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '.rdsh-host-error{font-size:11px;line-height:17px;color:var(--dsw-alias-state-error-primary);padding:2px 0 2px 8px;border-left:2px solid var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}',
      '.rdsh-port-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.rdsh-port-label{display:flex;align-items:center;gap:6px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary)}',
      '.rdsh-port-value{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}',
      '.rdsh-host-actions{display:flex;align-items:center;gap:5px;flex-wrap:wrap;padding-top:10px;border-top:.5px solid var(--dsw-alias-border-l1)}',
      '.rdsh-host-actions .rdsh-btn--primary{margin-right:auto}',
      '.rdsh-input{box-sizing:border-box;width:100%;min-height:30px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;padding:5px 8px}',
      '.rdsh-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
      '.rdsh-input--port{width:86px}',
      '.rdsh-form-panel{display:flex;flex-direction:column;gap:12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);padding:15px 16px}',
      '.rdsh-form-head{display:flex;align-items:center;justify-content:space-between;gap:10px}',
      '.rdsh-form-title{font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.rdsh-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 12px}',
      '@media (max-width:700px){.rdsh-form-grid{grid-template-columns:minmax(0,1fr)}}',
      '.rdsh-field{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.rdsh-label{font-size:11px;line-height:16px;color:var(--dsw-alias-label-primary);font-weight:500}',
      '.rdsh-form-actions{display:flex;justify-content:flex-end;gap:8px}',
      '.rdsh-probe{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:6px 14px;padding:9px 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base)}',
      '.rdsh-probe-row{display:flex;align-items:baseline;gap:6px;min-width:0;font-size:11px;line-height:17px}',
      '.rdsh-probe-key{color:var(--dsw-alias-label-secondary);flex:none}',
      '.rdsh-probe-val{color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere}',
      '.rdsh-log{max-height:280px;overflow:auto;margin:0;padding:9px 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:17px;white-space:pre-wrap;overflow-wrap:anywhere}',
      '.rdsh-note{border-radius:var(--dsw-radius-sm);padding:7px 10px;font-size:12px;line-height:18px}',
      '.rdsh-note--ok{border:.5px solid var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}',
      '.rdsh-note--error{border:.5px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.rdsh-note--warn{border:.5px solid var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}',
      '.rdsh-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;min-height:180px;padding:24px;border:.5px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);color:var(--dsw-alias-label-secondary);text-align:center;background:var(--dsw-alias-bg-layer-1)}',
      '.rdsh-empty-icon{display:flex;color:var(--dsw-alias-label-secondary);opacity:.75}',
      '.rdsh-empty-title{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);font-weight:500}',
      '.rdsh-state{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;min-height:240px;padding:24px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.rdsh-spinner{width:18px;height:18px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;animation:rdsh-spin .8s linear infinite}',
      '@keyframes rdsh-spin{to{transform:rotate(360deg)}}',
      '.rdsh-hint{font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary)}',
      '.rdsh-footer-note{font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary);padding-top:10px;border-top:.5px solid var(--dsw-alias-border-l1)}',
      '.rdsh-launcher{box-sizing:border-box;display:flex;flex-direction:column;gap:12px;height:100%;overflow:auto;padding:18px;background:var(--dsw-alias-bg-base)}',
      '.rdsh-launcher-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}',
      '.rdsh-launcher-heading{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.rdsh-launcher-lead{font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary)}',
      '.rdsh-launch-card{box-sizing:border-box;display:flex;align-items:center;gap:10px;width:100%;text-align:left;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;padding:12px 14px;cursor:pointer;transition:background .15s,border-color .15s}',
      '.rdsh-launch-card:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3)}',
      '.rdsh-launch-card:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}',
      '.rdsh-launch-card:disabled{opacity:.55;cursor:wait}',
      '.rdsh-launch-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary);flex:none}',
      '.rdsh-launch-copy{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}',
      '.rdsh-launch-name{font-size:13px;line-height:20px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rdsh-launch-meta{font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
      '.rdsh-launch-cta{font-size:11px;color:var(--dsw-alias-label-secondary);flex:none;display:inline-flex;align-items:center;gap:4px}',
      '.rdsh-launch-cta::after{content:"›";font-size:16px;line-height:16px;color:var(--dsw-alias-label-primary)}',
      '.rdsh-launcher-empty{display:flex;align-items:center;justify-content:center;min-height:120px;padding:18px;border:.5px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);color:var(--dsw-alias-label-secondary);font-size:12px;text-align:center;background:var(--dsw-alias-bg-layer-1)}',
      '.rdsh-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}',
    ].join('');

    function isObject(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    function messageOf(error) {
      if (error instanceof Error && error.message !== '') return error.message;
      return String(error);
    }

    function createPage(ctx, t) {
      let token = '';

      async function bootstrap() {
        const response = await fetch(API_ROOT + 'bootstrap', { headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error('bootstrap ' + response.status);
        const data = await response.json();
        if (!isObject(data) || typeof data.token !== 'string' || data.token === '') {
          throw new Error('bootstrap token missing');
        }
        token = data.token;
      }

      async function call(path, options = {}) {
        if (token === '') await bootstrap();
        const method = options.method ?? 'GET';
        const headers = { accept: 'application/json', 'x-remote-dsh-token': token };
        if (options.body !== undefined) headers['content-type'] = 'application/json';
        const response = await fetch(API_ROOT + path, {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          const message = isObject(data) && isObject(data.error) && typeof data.error.message === 'string'
            ? data.error.message
            : 'HTTP ' + response.status;
          const error = new Error(message);
          if (isObject(data) && isObject(data.error) && typeof data.error.code === 'string') {
            error.code = data.error.code;
          }
          throw error;
        }
        return data;
      }

      function fill(key, vars) {
        let text = String(t(key));
        if (!isObject(vars)) return text;
        for (const [name, value] of Object.entries(vars)) {
          text = text.split('{' + name + '}').join(String(value));
        }
        return text;
      }

      return function RemoteDshPage() {
        const defaultSettings = { mode: 'npx', spec: 'latest', registry: 'https://registry.npmmirror.com' };
        const [state, setState] = React.useState({
          phase: 'loading',
          error: '',
          hosts: [],
          settings: defaultSettings,
          configErrors: [],
        });
        const [busy, setBusy] = React.useState({});
        const [probes, setProbes] = React.useState({});
        const [logs, setLogs] = React.useState({});
        const [notice, setNotice] = React.useState(null);
        const [showAdd, setShowAdd] = React.useState(false);
        const [ports, setPorts] = React.useState({});
        const [draft, setDraft] = React.useState({
          label: '',
          sshTarget: '',
          port: '',
          identityFile: '',
          proxyJump: '',
          remotePort: '3080',
        });

        const load = React.useCallback(async () => {
          setState((current) => ({ ...current, phase: 'loading', error: '' }));
          try {
            const data = await call('hosts');
            setState({
              phase: 'ready',
              error: '',
              hosts: Array.isArray(data.hosts) ? data.hosts : [],
              settings: {
                mode: isObject(data.settings) && data.settings.mode === 'global' ? 'global' : 'npx',
                spec: isObject(data.settings) && typeof data.settings.spec === 'string' ? data.settings.spec : 'latest',
                registry: isObject(data.settings) && typeof data.settings.registry === 'string'
                  ? data.settings.registry
                  : defaultSettings.registry,
              },
              configErrors: Array.isArray(data.configErrors) ? data.configErrors : [],
            });
          } catch (error) {
            setState((current) => ({ ...current, phase: 'error', error: messageOf(error) }));
          }
        }, []);

        React.useEffect(() => {
          load();
        }, [load]);

        const setHostBusy = React.useCallback((id, action) => {
          setBusy((current) => {
            const next = { ...current };
            if (action === '') delete next[id];
            else next[id] = action;
            return next;
          });
        }, []);

        async function runHostAction(id, action, work) {
          if (busy[id] !== undefined) return;
          setHostBusy(id, action);
          setNotice(null);
          try {
            return await work();
          } catch (error) {
            setNotice({ kind: 'error', text: messageOf(error) });
            return undefined;
          } finally {
            setHostBusy(id, '');
          }
        }

        const probeHost = React.useCallback(async (id) => {
          await runHostAction(id, 'probe', async () => {
            const data = await call('probe', { method: 'POST', body: { id } });
            setProbes((current) => ({ ...current, [id]: data.probe }));
          });
        }, [busy]);

        const installHost = React.useCallback(async (id) => {
          await runHostAction(id, 'install', async () => {
            const data = await call('install', { method: 'POST', body: { id, registry: state.settings.registry } });
            setNotice({ kind: 'ok', text: fill('installDone', { version: data.install?.version || '?' }) });
            setProbes((current) => ({ ...current, [id]: undefined }));
            await load();
          });
        }, [busy, load, state.settings.registry]);

        const startRemote = React.useCallback(async (id) => {
          const host = state.hosts.find((candidate) => candidate.id === id);
          const port = Number(ports[id] ?? host?.defaultPort ?? 3080);
          const body = { id, port, mode: state.settings.mode, registry: state.settings.registry };
          let data;
          try {
            data = await call('start', { method: 'POST', body });
          } catch (error) {
            if (error.code !== 'PORT_IN_USE') throw error;
            if (!window.confirm(fill('portInUseConfirm', { port }))) return;
            data = await call('start', { method: 'POST', body: { ...body, force: true } });
          }
          setNotice({ kind: 'ok', text: t('started') });
          await load();
          const actualPort = Number(data.instance?.remotePort);
          if (Number.isInteger(actualPort) && actualPort > 0 && actualPort !== port) {
            setPorts((current) => ({ ...current, [id]: String(actualPort) }));
            setNotice({ kind: 'ok', text: fill('portAdjusted', { requested: port, port: actualPort }) });
          }
        }, [load, ports, state.hosts, state.settings.mode, state.settings.registry]);

        const startHost = React.useCallback(async (id) => {
          await runHostAction(id, 'start', () => startRemote(id));
        }, [busy, startRemote]);

        const stopHost = React.useCallback(async (id) => {
          await runHostAction(id, 'stop', async () => {
            await call('stop', { method: 'POST', body: { id } });
            setNotice({ kind: 'ok', text: t('stoppedNotice') });
            setLogs((current) => {
              const next = { ...current };
              delete next[id];
              return next;
            });
            await load();
          });
        }, [busy, load]);

        const openHostInBrowser = React.useCallback(async (id) => {
          await runHostAction(id, 'browser', async () => {
            const data = await call('open', { method: 'POST', body: { id } });
            if (typeof data.url === 'string' && data.url !== '') {
              window.open(data.url, '_blank', 'noopener,noreferrer');
            }
          });
        }, [busy]);

        const restartHost = React.useCallback(async (id) => {
          if (busy[id] !== undefined) return;
          setHostBusy(id, 'restart');
          setNotice(null);
          try {
            await call('stop', { method: 'POST', body: { id } });
            await startRemote(id);
          } catch (error) {
            setNotice({ kind: 'error', text: messageOf(error) });
          } finally {
            setHostBusy(id, '');
          }
        }, [busy, startRemote]);

        const toggleLogs = React.useCallback(async (id) => {
          if (isObject(logs[id]) && logs[id].open === true) {
            setLogs((current) => ({ ...current, [id]: { ...current[id], open: false } }));
            return;
          }
          setLogs((current) => ({ ...current, [id]: { open: true, loading: true, text: '' } }));
          try {
            const data = await call('logs', { method: 'POST', body: { id } });
            setLogs((current) => ({
              ...current,
              [id]: { open: true, loading: false, text: typeof data.log === 'string' ? data.log : '' },
            }));
          } catch (error) {
            setLogs((current) => ({
              ...current,
              [id]: { open: true, loading: false, text: fill('logFailed', { message: messageOf(error) }) },
            }));
          }
        }, [logs]);

        const removeHost = React.useCallback(async (id) => {
          if (!window.confirm(t('confirmRemove'))) return;
          await runHostAction(id, 'remove', async () => {
            await call('hosts/' + encodeURIComponent(id), { method: 'DELETE' });
            setNotice({ kind: 'ok', text: t('removed') });
            await load();
          });
        }, [busy, load]);

        const changeMode = React.useCallback(async (mode) => {
          if (state.settings.mode === mode) return;
          try {
            const data = await call('settings', { method: 'POST', body: { mode } });
            setState((current) => ({ ...current, settings: data.settings }));
          } catch (error) {
            setNotice({ kind: 'error', text: messageOf(error) });
          }
        }, [state.settings.mode]);

        const changeRegistry = React.useCallback(async (registry) => {
          const next = String(registry).trim();
          if (next === state.settings.registry) return;
          try {
            const data = await call('settings', { method: 'POST', body: { registry: next } });
            setState((current) => ({ ...current, settings: data.settings }));
          } catch (error) {
            setNotice({ kind: 'error', text: messageOf(error) });
          }
        }, [state.settings.registry]);

        const submitHost = React.useCallback(async () => {
          if (draft.sshTarget.trim() === '') {
            setNotice({ kind: 'error', text: t('sshTargetHint') });
            return;
          }
          try {
            await call('hosts', {
              method: 'POST',
              body: {
                host: {
                  label: draft.label,
                  sshTarget: draft.sshTarget,
                  port: draft.port === '' ? undefined : Number(draft.port),
                  identityFile: draft.identityFile,
                  proxyJump: draft.proxyJump,
                  remotePort: draft.remotePort === '' ? undefined : Number(draft.remotePort),
                },
              },
            });
            setDraft({ label: '', sshTarget: '', port: '', identityFile: '', proxyJump: '', remotePort: '3080' });
            setShowAdd(false);
            setNotice({ kind: 'ok', text: t('addSaved') });
            await load();
          } catch (error) {
            setNotice({ kind: 'error', text: messageOf(error) });
          }
        }, [draft, load]);

        const mode = state.settings.mode === 'global' ? 'global' : 'npx';
        const runningCount = state.hosts.filter((host) => isObject(host.instance)).length;

        const glyph = (paths, size = 14) => h('svg', {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        }, paths.map((d, index) => h('path', { d, key: index })));

        const iconPlus = glyph(['M12 5v14', 'M5 12h14']);
        const iconRefresh = glyph(['M20 11a8 8 0 1 0-2.4 5.7', 'M20 5v6h-6']);
        const iconExternal = glyph(['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5']);
        const iconPlay = glyph(['M8 5l11 7-11 7z']);

        const header = h('header', { className: 'rdsh-hero' },
          h('div', { className: 'rdsh-hero-copy' },
            h('div', { className: 'rdsh-eyebrow' }, t('eyebrow')),
            h('h1', { className: 'rdsh-title' }, t('title')),
            h('p', { className: 'rdsh-sub' }, t('subtitle')),
            h('div', { className: 'rdsh-stats' },
              h('span', { className: 'rdsh-stat' },
                h('span', { className: 'rdsh-stat-dot', 'aria-hidden': 'true' }),
                fill('runningStat', { count: runningCount }),
              ),
              h('span', { className: 'rdsh-stat' }, fill('hostStat', { count: state.hosts.length })),
            ),
          ),
          h('div', { className: 'rdsh-hero-actions' },
            h('button', {
              type: 'button',
              className: 'rdsh-btn rdsh-btn--icon',
              onClick: load,
              title: t('refresh'),
              'aria-label': t('refresh'),
            }, iconRefresh),
            h('button', {
              type: 'button',
              className: 'rdsh-btn rdsh-btn--primary',
              onClick: () => setShowAdd((current) => !current),
            }, iconPlus, t('addHost')),
          ),
        );

        const controls = h('section', { className: 'rdsh-controls' },
          h('div', { className: 'rdsh-control' },
            h('span', { className: 'rdsh-control-label' }, t('mode')),
            h('div', { className: 'rdsh-seg', role: 'group', 'aria-label': t('mode') },
              h('button', {
                type: 'button',
                'aria-pressed': mode === 'npx' ? 'true' : 'false',
                onClick: () => changeMode('npx'),
              }, t('modeNpx')),
              h('button', {
                type: 'button',
                'aria-pressed': mode === 'global' ? 'true' : 'false',
                onClick: () => changeMode('global'),
              }, t('modeGlobal')),
            ),
          ),
          h('label', { className: 'rdsh-control rdsh-control--registry' },
            h('span', { className: 'rdsh-control-label' }, t('registry')),
            h('input', {
              className: 'rdsh-input',
              type: 'text',
              spellCheck: false,
              value: state.settings.registry,
              placeholder: 'https://registry.npmmirror.com',
              title: t('registryHint'),
              onChange: (event) => setState((current) => ({
                ...current,
                settings: { ...current.settings, registry: event.target.value },
              })),
              onBlur: (event) => changeRegistry(event.target.value),
            }),
          ),
          h('div', { className: 'rdsh-control-note' }, mode === 'global' ? t('modeGlobalHint') : t('modeNpxHint')),
        );

        const noticeBar = notice === null
          ? null
          : h('div', { className: 'rdsh-note rdsh-note--' + notice.kind, role: 'status' }, notice.text);

        const sshTunnelHint = h('div', { className: 'rdsh-footer-note' }, t('sshTunnelHint'));

        const configErrorBar = state.configErrors.length === 0
          ? null
          : h('div', { className: 'rdsh-note rdsh-note--warn' },
            fill('sshConfigErrors', { message: state.configErrors.join('; ') }));

        const addForm = !showAdd ? null : h('div', { className: 'rdsh-form-panel' },
          h('div', { className: 'rdsh-form-head' },
            h('div', { className: 'rdsh-form-title' }, t('addTitle')),
          ),
          h('div', { className: 'rdsh-form-grid' },
          h('label', { className: 'rdsh-field' },
            h('span', { className: 'rdsh-label' }, t('label')),
            h('input', {
              className: 'rdsh-input',
              value: draft.label,
              placeholder: 'my-server',
              onChange: (event) => setDraft((current) => ({ ...current, label: event.target.value })),
            }),
          ),
          h('label', { className: 'rdsh-field' },
            h('span', { className: 'rdsh-label' }, t('sshTarget')),
            h('input', {
              className: 'rdsh-input',
              value: draft.sshTarget,
              placeholder: 'user@host or ssh-alias',
              onChange: (event) => setDraft((current) => ({ ...current, sshTarget: event.target.value })),
            }),
            h('span', { className: 'rdsh-hint' }, t('sshTargetHint')),
          ),
          h('label', { className: 'rdsh-field' },
            h('span', { className: 'rdsh-label' }, t('sshPort')),
            h('input', {
              className: 'rdsh-input',
              type: 'number',
              value: draft.port,
              placeholder: '22',
              onChange: (event) => setDraft((current) => ({ ...current, port: event.target.value })),
            }),
          ),
          h('label', { className: 'rdsh-field' },
            h('span', { className: 'rdsh-label' }, t('identityFile')),
            h('input', {
              className: 'rdsh-input',
              value: draft.identityFile,
              placeholder: '~/.ssh/id_ed25519',
              onChange: (event) => setDraft((current) => ({ ...current, identityFile: event.target.value })),
            }),
          ),
          h('label', { className: 'rdsh-field' },
            h('span', { className: 'rdsh-label' }, t('proxyJump')),
            h('input', {
              className: 'rdsh-input',
              value: draft.proxyJump,
              placeholder: 'jump-host',
              onChange: (event) => setDraft((current) => ({ ...current, proxyJump: event.target.value })),
            }),
          ),
          h('label', { className: 'rdsh-field' },
            h('span', { className: 'rdsh-label' }, t('remotePort')),
            h('input', {
              className: 'rdsh-input',
              type: 'number',
              value: draft.remotePort,
              onChange: (event) => setDraft((current) => ({ ...current, remotePort: event.target.value })),
            }),
          ),
          ),
          h('div', { className: 'rdsh-form-actions' },
            h('button', {
              type: 'button',
              className: 'rdsh-btn',
              onClick: () => { setShowAdd(false); setNotice(null); },
            }, t('cancel')),
            h('button', { type: 'button', className: 'rdsh-btn rdsh-btn--primary', onClick: submitHost }, t('save')),
          ),
        );

        function probePanel(id) {
          const probe = probes[id];
          if (!isObject(probe)) return null;
          const rows = [
            [t('platform'), probe.platform],
            [t('node'), probe.node],
            [t('npm'), probe.npm],
            [t('npx'), probe.npx],
            [t('dsh'), probe.dsh || t('notInstalled')],
            [t('version'), probe.version],
            [t('npmPrefix'), probe.npmPrefix],
            [t('remoteRegistry'), probe.npmRegistry],
          ];
          return h('div', { className: 'rdsh-probe' },
            rows.map(([key, value]) => h('div', { className: 'rdsh-probe-row', key },
              h('span', { className: 'rdsh-probe-key' }, key),
              h('span', { className: 'rdsh-probe-val' }, value === '' ? '—' : String(value)),
            )),
          );
        }

        function hostCard(host) {
          const id = host.id;
          const busyAction = busy[id];
          const instance = isObject(host.instance) ? host.instance : undefined;
          const port = ports[id] ?? String(host.defaultPort ?? 3080);
          const log = logs[id];
          const busyLabels = {
            probe: t('probing'),
            install: t('installing'),
            start: t('starting'),
            stop: t('stopping'),
            open: t('opening'),
            browser: t('opening'),
            restart: t('starting'),
          };
          const action = (name, label, handler, extra = {}) => h('button', {
            type: 'button',
            className: 'rdsh-btn rdsh-btn--small'
              + (extra.primary === true ? ' rdsh-btn--primary' : ' rdsh-btn--quiet')
              + (extra.danger === true ? ' rdsh-btn--danger' : ''),
            disabled: busyAction !== undefined,
            onClick: handler,
          },
          extra.glyph === undefined ? null : h('span', { className: 'rdsh-btn-glyph' }, extra.glyph),
          busyAction === name ? (busyLabels[name] ?? label) : label,
          );

          return h('article', { className: 'rdsh-host-card' + (instance !== undefined ? ' rdsh-host-card--running' : ''), key: id },
            h('div', { className: 'rdsh-host-top' },
              h('span', {
                className: 'rdsh-host-status' + (instance !== undefined ? ' rdsh-host-status--on' : ''),
                'aria-hidden': 'true',
              }),
              h('div', { className: 'rdsh-host-main' },
                h('div', { className: 'rdsh-host-name-row' },
                  h('span', { className: 'rdsh-host-name' }, host.label || id),
                  h('span', { className: 'rdsh-badge rdsh-badge--muted' }, host.source === 'ssh-config' ? t('sourceSsh') : t('sourceManual')),
                  h('span', { className: 'rdsh-badge' + (instance !== undefined ? ' rdsh-badge--ok' : '') },
                    instance === undefined ? t('stopped') : t('running')),
                  host.error !== undefined ? h('span', { className: 'rdsh-badge rdsh-badge--error' }, t('probeFailed')) : null,
                ),
                h('div', { className: 'rdsh-host-target' },
                  host.sshTarget + (host.user ? '  ·  ' + host.user : '') + (host.port ? '  ·  :' + String(host.port) : ''),
                ),
              ),
            ),
            host.error === undefined
              ? null
              : h('div', { className: 'rdsh-host-error' }, host.error),
            h('div', { className: 'rdsh-port-row' },
              h('span', { className: 'rdsh-port-label' }, t('portLabel')),
              instance === undefined
                ? h('input', {
                  className: 'rdsh-input rdsh-input--port',
                  type: 'number',
                  min: 1024,
                  max: 65535,
                  value: port,
                  onChange: (event) => setPorts((current) => ({ ...current, [id]: event.target.value })),
                })
                : h('span', { className: 'rdsh-port-value' }, String(instance.remotePort)),
            ),
            h('div', { className: 'rdsh-host-actions' },
              instance === undefined
                ? action('start', t('start'), () => startHost(id), { primary: true, glyph: iconPlay })
                : action('browser', t('openBrowser'), () => openHostInBrowser(id), { primary: true, glyph: iconExternal }),
              h('button', {
                type: 'button',
                className: 'rdsh-btn rdsh-btn--small rdsh-btn--quiet',
                disabled: busyAction !== undefined,
                onClick: () => probeHost(id),
              }, busyAction === 'probe' ? t('probing') : t('probe')),
              mode === 'global' ? action('install', t('install'), () => installHost(id)) : null,
              instance !== undefined ? action('restart', t('restart'), () => restartHost(id)) : null,
              instance !== undefined ? action('stop', t('stop'), () => stopHost(id)) : null,
              h('button', {
                type: 'button',
                className: 'rdsh-btn rdsh-btn--small rdsh-btn--quiet',
                onClick: () => toggleLogs(id),
              }, isObject(log) && log.open === true ? t('hideLogs') : t('logs')),
              host.source === 'manual'
                ? action('remove', t('remove'), () => removeHost(id), { danger: true })
                : null,
            ),
            probePanel(id),
            isObject(log) && log.open === true
              ? h('pre', { className: 'rdsh-log' }, log.loading === true ? t('loading') : log.text === '' ? t('logEmpty') : log.text)
              : null,
          );
        }

        if (state.phase === 'loading') {
          return h('div', { className: 'rdsh-root' }, h('div', { className: 'rdsh-inner' },
            h('div', { className: 'rdsh-state' },
              h('span', { className: 'rdsh-spinner', 'aria-hidden': 'true' }),
              h('span', null, t('loading')),
            ),
          ));
        }

        if (state.phase === 'error') {
          return h('div', { className: 'rdsh-root' }, h('div', { className: 'rdsh-inner' },
            h('div', { className: 'rdsh-state' },
              h('div', { className: 'rdsh-note rdsh-note--error' }, fill('loadFailed', { message: state.error })),
              h('button', { type: 'button', className: 'rdsh-btn', onClick: load }, t('retry')),
            ),
          ));
        }

        return h('div', { className: 'rdsh-root' },
          h('div', { className: 'rdsh-inner' },
            header,
            controls,
            noticeBar,
            configErrorBar,
            addForm,
            h('section', { className: 'rdsh-section' },
              h('div', { className: 'rdsh-section-head' },
                h('div', { className: 'rdsh-section-title' }, t('hosts')),
                h('span', { className: 'rdsh-section-note' },
                  fill('hostStat', { count: state.hosts.length }) + '  ·  ' + t('portAutoHint')),
              ),
              state.hosts.length === 0
                ? h('div', { className: 'rdsh-empty' },
                  h('div', { className: 'rdsh-empty-icon' }, glyph(['M4 7h16v12H4z', 'M8 7V4h8v3', 'M8 12h8'], 30)),
                  h('div', { className: 'rdsh-empty-title' }, t('noHosts')),
                  h('button', { type: 'button', className: 'rdsh-btn', onClick: () => setShowAdd(true) }, t('addHost')),
                )
                : h('div', { className: 'rdsh-grid' }, state.hosts.map(hostCard)),
            ),
            sshTunnelHint,
          ),
        );
      };
    }

    function createLauncher(ctx, t) {
      const apiRoot = '/plugin-remote-dsh/api/';

      function format(key, vars) {
        let text = String(t(key));
        for (const [name, value] of Object.entries(vars ?? {})) {
          text = text.split('{' + name + '}').join(String(value));
        }
        return text;
      }

      return function RemoteDshLauncher() {
        const [state, setState] = React.useState({ phase: 'loading', hosts: [], error: '' });
        const [busy, setBusy] = React.useState('');
        const [actionError, setActionError] = React.useState('');
        const tokenRef = React.useRef('');

        const load = React.useCallback(async () => {
          setState((current) => ({ ...current, phase: 'loading', error: '' }));
          try {
            const bootResponse = await fetch(apiRoot + 'bootstrap', { credentials: 'same-origin' });
            const boot = await bootResponse.json().catch(() => ({}));
            if (!bootResponse.ok || typeof boot.token !== 'string') throw new Error(messageOf(boot));
            tokenRef.current = boot.token;
            const response = await fetch(apiRoot + 'hosts', {
              credentials: 'same-origin',
              headers: { 'x-remote-dsh-token': boot.token },
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(messageOf(data));
            setState({
              phase: 'ready',
              hosts: Array.isArray(data.hosts) ? data.hosts : [],
              error: '',
            });
          } catch (error) {
            setState({ phase: 'error', hosts: [], error: messageOf(error) });
          }
        }, []);

        React.useEffect(() => {
          load();
        }, [load]);

        const openInSidebar = (url) => {
          try {
            ctx.sidebarRight.openTab('browser', { params: { url } });
          } catch (error) {
            console.error('[remote-dsh] launcher sidebar open failed', error);
            window.open(url, '_blank', 'noopener,noreferrer');
          }
        };

        const ensureUrl = async (id) => {
          if (tokenRef.current === '') throw new Error('remote-dsh API token is not ready');
          const response = await fetch(apiRoot + 'open', {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
              'content-type': 'application/json',
              'x-remote-dsh-token': tokenRef.current,
            },
            body: JSON.stringify({ id }),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(messageOf(data));
          if (typeof data.url !== 'string' || data.url === '') throw new Error('open did not return a URL');
          return data.url;
        };

        const openHost = async (host) => {
          if (busy !== '') return;
          setBusy(host.id);
          setActionError('');
          try {
            const url = await ensureUrl(host.id);
            openInSidebar(url);
          } catch (error) {
            setActionError(messageOf(error));
          } finally {
            setBusy('');
          }
        };

        const active = state.hosts.filter((host) => isObject(host.instance) && typeof host.instance.url === 'string');

        return h('div', { className: 'rdsh-launcher' },
          h('div', { className: 'rdsh-launcher-head' },
            h('div', { className: 'rdsh-launcher-heading' },
              h('div', { className: 'rdsh-eyebrow' }, t('launcherTitle')),
              h('div', { className: 'rdsh-launcher-lead' }, t('launcherHint')),
            ),
            h('button', { type: 'button', className: 'rdsh-btn rdsh-btn--small', onClick: load }, t('refresh')),
          ),
          actionError === '' ? null : h('div', { className: 'rdsh-note rdsh-note--error' }, format('loadFailed', { message: actionError })),
          state.phase === 'loading' ? h('div', { className: 'rdsh-launcher-empty' }, t('loading')) : null,
          state.phase === 'error'
            ? h('div', { className: 'rdsh-note rdsh-note--error' }, format('loadFailed', { message: state.error }))
            : state.phase === 'ready' && active.length === 0
              ? h('div', { className: 'rdsh-launcher-empty' }, t('launcherEmpty'))
              : active.map((host) => h('button', {
                type: 'button',
                className: 'rdsh-launch-card',
                key: host.id,
                disabled: busy !== '',
                onClick: () => openHost(host),
              },
              h('span', { className: 'rdsh-launch-dot', 'aria-hidden': 'true' }),
              h('span', { className: 'rdsh-launch-copy' },
                h('span', { className: 'rdsh-launch-name' }, host.label || host.id),
                h('span', { className: 'rdsh-launch-meta' },
                  ':' + String(host.instance.remotePort) + (host.user ? '  ·  ' + host.user : '')),
              ),
              h('span', { className: 'rdsh-launch-cta' }, busy === host.id ? t('opening') : t('open')),
              )),
        );
      };
    }

    function apply(ctx) {
      ctx.effect(() => {
        const tagId = 'dsh-plugin-remote-dsh/styles.css';
        if (typeof document === 'undefined') return () => {};
        if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') !== null) return () => {};
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-plugin-remote-dsh';
        tag.dataset.pluginCss = tagId;
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => { tag.remove(); };
      }, 'remote-dsh: styles');

      let t = (key) => (zh[key] === undefined ? key : zh[key]);
      try {
        ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'remote-dsh: locale');
        const bound = ctx.locale.bind(LOCALE_NS);
        if (typeof bound === 'function') t = bound;
      } catch (error) {
        console.error('[remote-dsh] locale unavailable, falling back to built-in copy', error);
      }

      ctx.effect(() => {
        const offs = [];
        const contribute = (owner, options, Component) => {
          if (typeof ctx.slots?.inject !== 'function' || typeof ctx.slots?.register !== 'function') return;
          const off = ctx.slots.inject(owner, function* () {
            yield ctx.slots.register(options, Component);
          });
          if (typeof off === 'function') offs.push(off);
        };

        const Icon = ({ size = 20, active = false } = {}) => h('svg', {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: active ? 2 : 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('rect', { x: 3, y: 4, width: 18, height: 12, rx: 2 }),
        h('path', { d: 'M8 20h8M12 16v4' }),
        h('path', { d: 'M7 10l2.5 2L7 14M12 14h4' }),
        );

        contribute('sidebar.panellist', {
          name: 'sidebar.panellist',
          id: MENU_ID,
          order: 30,
          label: () => t('menu'),
        }, Icon);
        contribute('main', { name: 'main', key: MENU_ID }, createPage(ctx, t));

        const launcherId = 'remote-dsh-launcher';
        let disposeLauncherType;
        try {
          disposeLauncherType = ctx.sidebarRightTabs.register({
            id: launcherId,
            kind: launcherId,
            title: () => t('launcherTitle'),
            guide: [{
              id: launcherId,
              kind: launcherId,
              title: () => t('launcherTitle'),
              description: () => t('launcherGuide'),
            }],
          });
          contribute('sidebar.right.pane.tab', { name: 'sidebar.right.pane.tab', key: launcherId }, createLauncher(ctx, t));
          const LauncherButton = () => h('button', {
            type: 'button',
            className: 'rdsh-btn rdsh-btn--small',
            onClick: () => {
              try {
                ctx.sidebarRight.openTab(launcherId);
              } catch (error) {
                console.error('[remote-dsh] launcher tab open failed', error);
              }
            },
          }, t('launcherTitle'));
          contribute('conversation.session.header.utilities', {
            name: 'conversation.session.header.utilities',
            id: launcherId,
            order: 100,
            label: () => t('launcherTitle'),
          }, LauncherButton);
        } catch (error) {
          console.error('[remote-dsh] launcher registration failed', error);
        }

        return () => {
          if (typeof disposeLauncherType === 'function') {
            try { disposeLauncherType(); } catch { /* ignore */ }
          }
          for (const off of offs) {
            try { off(); } catch { /* ignore */ }
          }
        };
      }, 'remote-dsh: slots');
    }

    const internals = { createPage, CSS };

    return { inject: ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'], apply, __internals: internals };
  },
});
