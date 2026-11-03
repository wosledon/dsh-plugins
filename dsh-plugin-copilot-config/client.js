/**
 * Client half of the Copilot configuration plugin.
 *
 * The GitHub Copilot configuration a project carries in `.github/` is rendered
 * as one right-sidebar tab per Session, and the same catalog feeds the
 * conversation: a `/` trigger source offers the project's prompts, Agent Skills,
 * chat modes, and custom agents in the composer menu, a pick inserts a chip
 * whose model form carries that file's content, and a sent reference renders
 * back as a chip that reopens the file.
 *
 * @module dsh-plugin-copilot-config/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-copilot-config',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Client API root, matching `lib/server.js`. */
    const API_ROOT = '/plugin-copilot-config/api/';

    /** Locale namespace for every visible string. */
    const LOCALE_NS = 'plugin.copilot-config';

    /** Name this plugin's trigger source registers under; unique per `/`. */
    const SOURCE_NAME = 'copilot';

    /** Tab kind the configuration page registers under in the right sidebar. */
    const TAB_KIND = 'copilot-config';

    /** Implementation identity in the tab system, and the key its body registers under. */
    const TAB_ID = 'dsh-plugin-copilot-config';

    /** Shortcut command that opens the configuration tab. */
    const COMMAND_ID = 'copilot-config.open';

    /** Menu section of every invocable kind. */
    const SECTION_OF_KIND = { prompt: 'skills', skill: 'skills', chatmode: 'agents', agent: 'agents' };

    /** Dictionary key of one menu section. */
    const sectionKey = (section) => `section${section.charAt(0).toUpperCase()}${section.slice(1)}`;

    // Original mark: a configuration document carrying two linked chain links,
    // echoing "project config" plus the file links this plugin renders.
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
    h('path', { d: 'M6.2 3.5h7.6l4 4v13a1 1 0 0 1-1 1H6.2a1 1 0 0 1-1-1v-16a1 1 0 0 1 1-1z' }),
    h('path', { d: 'M13.8 3.5v4h4' }),
    h('path', { d: 'M8.6 9.6h6.4' }),
    h('path', { d: 'M8.6 12.2h4.2' }),
    h('rect', { x: 8.4, y: 14.2, width: 5.2, height: 3, rx: 1.5 }),
    h('rect', { x: 12.6, y: 13.4, width: 5.2, height: 3, rx: 1.5 }),
    );

    const zh = {
      menu: 'Copilot 配置',
      title: 'Copilot 配置',
      subtitle: '读取项目 .github 下的 Copilot 指令、提示词与聊天模式，并支持文件链接。',
      eyebrow: 'PROJECT STYLE',
      refresh: '刷新',
      loading: '正在读取…',
      retry: '重试',
      loadFailed: '读取失败：{message}',
      rootLabel: '项目根目录',
      sessionLabel: '会话',
      presentBadge: '已找到 .github',
      missingBadge: '没有 .github',
      missingTitle: '没有找到 Copilot 配置',
      missingHint: '在项目里创建 .github/copilot-instructions.md、.github/instructions/*.instructions.md、.github/prompts/*.prompt.md、.github/skills/*/SKILL.md 或 .github/chatmodes/*.chatmode.md 后刷新。',
      filesTitle: '配置文件',
      filesCount: '{count} 个文件',
      emptyGroup: '（空）',
      viewerTitle: '选择一个配置文件',
      viewerHint: '从左侧列表选择一个文件查看内容与文件链接。',
      openInSidebar: '在右侧栏打开',
      fileLinks: '文件链接',
      noFileLinks: '这个文件没有文件链接。',
      externalLink: '外部',
      applyToLabel: '作用于',
      modeLabel: '模式',
      bytesLabel: '大小',
      kindInstructions: '仓库指令',
      kindInstruction: '路径指令',
      kindPrompt: '提示词',
      kindSkill: '代理技能',
      kindChatmode: '聊天模式',
      kindAgent: '自定义代理',
      kindOther: '其他',
      openFailed: '右侧栏打开失败，已改用新窗口。',
      errorsNote: '部分路径无法读取：{message}',
      invokeTitle: '对话中输入 /{name} 可引入',
      sectionAgents: 'Copilot 代理',
      sectionSkills: 'Copilot 技能',
      chipTitle: 'Copilot 配置：{path}',
      referenceFailed: '无法读取 Copilot 配置 {path}：{message}',
      tabTitle: 'Copilot 配置',
      guideDescription: '读取项目 .github 下的 Copilot 指令、提示词与代理',
      shortcutNoSession: '请先选择会话',
    };

    const en = {
      menu: 'Copilot config',
      title: 'Copilot configuration',
      subtitle: 'Read the Copilot instructions, prompts, and chat modes a project keeps under .github, with file links.',
      eyebrow: 'PROJECT STYLE',
      refresh: 'Refresh',
      loading: 'Reading…',
      retry: 'Retry',
      loadFailed: 'Could not read: {message}',
      rootLabel: 'Project root',
      sessionLabel: 'Session',
      presentBadge: '.github found',
      missingBadge: 'no .github',
      missingTitle: 'No Copilot configuration found',
      missingHint: 'Create .github/copilot-instructions.md, .github/instructions/*.instructions.md, .github/prompts/*.prompt.md, .github/skills/*/SKILL.md, or .github/chatmodes/*.chatmode.md in the project, then refresh.',
      filesTitle: 'Configuration files',
      filesCount: '{count} files',
      emptyGroup: '(empty)',
      viewerTitle: 'Pick a configuration file',
      viewerHint: 'Choose a file on the left to read its content and file links.',
      openInSidebar: 'Open in right sidebar',
      fileLinks: 'File links',
      noFileLinks: 'This file has no file links.',
      externalLink: 'external',
      applyToLabel: 'applies to',
      modeLabel: 'mode',
      bytesLabel: 'size',
      kindInstructions: 'Repository instructions',
      kindInstruction: 'Path instructions',
      kindPrompt: 'Prompts',
      kindSkill: 'Agent Skills',
      kindChatmode: 'Chat modes',
      kindAgent: 'Custom agents',
      kindOther: 'Other',
      openFailed: 'Could not open in the right sidebar; opened a new window instead.',
      errorsNote: 'Some paths could not be read: {message}',
      invokeTitle: 'Bring into the conversation with /{name}',
      sectionAgents: 'Copilot agents',
      sectionSkills: 'Copilot skills',
      chipTitle: 'Copilot configuration: {path}',
      referenceFailed: 'Could not read the Copilot configuration {path}: {message}',
      tabTitle: 'Copilot config',
      guideDescription: 'Read the Copilot instructions, prompts, and agents a project keeps under .github',
      shortcutNoSession: 'Select a session first',
    };

    /** Display order of the Copilot configuration kinds. */
    const KINDS = ['instructions', 'instruction', 'prompt', 'skill', 'chatmode', 'agent', 'other'];

    const CSS = [
      '.rdc-root{height:100%;box-sizing:border-box;overflow:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
      '.rdc-inner{display:flex;flex-direction:column;gap:16px;max-width:1180px;margin:0 auto;padding:28px 22px 48px;box-sizing:border-box}',
      '.rdc-root[data-surface="tab"] .rdc-inner{padding:16px 14px 32px;gap:12px}',
      '.rdc-root[data-surface="tab"] .rdc-title{font-size:19px;line-height:26px}',
      '.rdc-root[data-surface="tab"] .rdc-sub{display:none}',
      '.rdc-hero{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap}',
      '.rdc-hero-copy{display:flex;flex-direction:column;gap:6px;min-width:0;max-width:680px}',
      '.rdc-eyebrow{font-size:10px;line-height:16px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}',
      '.rdc-title{font-size:24px;line-height:32px;font-weight:650;letter-spacing:-.02em;margin:0;color:var(--dsw-alias-label-primary)}',
      '.rdc-sub{font-size:13px;line-height:21px;color:var(--dsw-alias-label-secondary);margin:0}',
      '.rdc-hero-actions{display:flex;align-items:center;gap:8px}',
      '.rdc-config-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:11px 13px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1)}',
      '.rdc-config-label{font-size:10px;line-height:15px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}',
      '.rdc-config-value{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:17px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}',
      '.rdc-badge{display:inline-flex;align-items:center;gap:3px;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 7px;font-size:10px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.rdc-badge--ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}',
      '.rdc-badge--muted{border-color:var(--dsw-alias-border-l1)}',
      '.rdc-badge--invoke{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-border-l1)}',
      '.rdc-chip{display:inline-flex;align-items:center;gap:0;max-width:100%;min-width:0;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;padding:0 6px;vertical-align:baseline}',
      '.rdc-chip--button{cursor:pointer;appearance:none;-webkit-appearance:none}',
      '.rdc-chip--button:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.rdc-chip--button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      '.rdc-chip-slash{color:var(--dsw-alias-label-tertiary);flex:none}',
      '.rdc-chip-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rdc-body{display:grid;grid-template-columns:minmax(240px,320px) minmax(0,1fr);gap:14px;align-items:start}',
      '@media (max-width:900px){.rdc-body{grid-template-columns:minmax(0,1fr)}}',
      '.rdc-filelist{display:flex;flex-direction:column;gap:10px;min-width:0}',
      '.rdc-group{display:flex;flex-direction:column;gap:4px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);padding:10px}',
      '.rdc-group-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 2px 4px}',
      '.rdc-group-title{font-size:11px;line-height:17px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.rdc-group-count{font-size:10px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
      '.rdc-item{display:flex;flex-direction:column;gap:3px;width:100%;text-align:left;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:inherit;font:inherit;padding:6px 8px;cursor:pointer;min-width:0}',
      '.rdc-item:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.rdc-item[aria-pressed="true"]{background:var(--dsw-alias-interactive-bg-hover)}',
      '.rdc-item:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      '.rdc-item-name{font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rdc-item-path{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rdc-item-meta{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-top:1px}',
      '.rdc-viewer{display:flex;flex-direction:column;gap:12px;min-width:0;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);padding:16px 18px}',
      '.rdc-viewer-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}',
      '.rdc-viewer-copy{display:flex;flex-direction:column;gap:0;min-width:0;flex:1}',
      '.rdc-viewer-title{font-size:15px;line-height:23px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0}',
      '.rdc-viewer-path{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);margin-top:3px;overflow-wrap:anywhere}',
      '.rdc-viewer-meta{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}',
      '.rdc-viewer-actions{display:flex;align-items:center;gap:8px;flex:none}',
      '.rdc-content{display:flex;flex-direction:column;gap:10px;border-top:.5px solid var(--dsw-alias-border-l1);padding-top:14px;min-width:0}',
      '.rdc-h{font-size:14px;line-height:22px;font-weight:600;color:var(--dsw-alias-label-primary);margin:6px 0 0}',
      '.rdc-h3{font-size:13px}',
      '.rdc-h4,.rdc-h5,.rdc-h6{font-size:12px}',
      '.rdc-p{font-size:13px;line-height:21px;color:var(--dsw-alias-label-primary);margin:0;overflow-wrap:anywhere}',
      '.rdc-mdlist{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:3px}',
      '.rdc-li{font-size:13px;line-height:21px;color:var(--dsw-alias-label-primary)}',
      '.rdc-code{margin:0;overflow:auto;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:17px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere}',
      '.rdc-code-inline{padding:0 4px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px}',
      '.rdc-quote{margin:0;padding:2px 0 2px 10px;border-left:2px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);font-size:13px;line-height:21px}',
      '.rdc-hr{border:0;border-top:.5px solid var(--dsw-alias-border-l2);margin:2px 0}',
      '.rdc-link{border:0;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:13px;padding:0;cursor:pointer;text-decoration:underline;text-underline-offset:2px}',
      '.rdc-link:hover{color:var(--dsw-alias-label-primary)}',
      '.rdc-links{display:flex;flex-direction:column;gap:8px;border-top:.5px solid var(--dsw-alias-border-l1);padding-top:12px}',
      '.rdc-links-title{font-size:11px;line-height:17px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.rdc-link-rows{display:flex;flex-wrap:wrap;gap:6px}',
      '.rdc-link-chip{display:inline-flex;align-items:center;gap:6px;max-width:100%;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;line-height:17px;padding:2px 9px;cursor:pointer;min-width:0}',
      '.rdc-link-chip:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.rdc-link-chip-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rdc-link-chip-path{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rdc-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:30px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;padding:3px 11px;cursor:pointer;white-space:nowrap;appearance:none;-webkit-appearance:none}',
      '.rdc-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.rdc-btn:focus{outline:none}',
      '.rdc-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}',
      '.rdc-btn:disabled{opacity:.45;cursor:not-allowed}',
      '.rdc-btn--small{min-height:26px;padding:2px 9px;font-size:11px;line-height:17px;border-radius:var(--dsw-radius-sm)}',
      '.rdc-btn--primary{font-weight:600}',
      '.rdc-btn--icon{width:30px;height:30px;min-height:30px;padding:0;justify-content:center}',
      '.rdc-btn-glyph{display:inline-flex;align-items:center;flex:none}',
      '.rdc-note{border-radius:var(--dsw-radius-sm);padding:7px 10px;font-size:12px;line-height:18px}',
      '.rdc-note--error{border:.5px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.rdc-note--warn{border:.5px solid var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}',
      '.rdc-hint{font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary)}',
      '.rdc-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;min-height:220px;padding:28px;border:.5px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);text-align:center}',
      '.rdc-empty-icon{display:flex;color:var(--dsw-alias-label-secondary);opacity:.75}',
      '.rdc-empty-title{font-size:14px;line-height:22px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.rdc-state{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;min-height:240px;padding:24px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.rdc-spinner{width:18px;height:18px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;animation:rdc-spin .8s linear infinite}',
      '@keyframes rdc-spin{to{transform:rotate(360deg)}}',
    ].join('');

    function isObject(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    function messageOf(error) {
      if (error instanceof Error && error.message !== '') return error.message;
      return String(error);
    }

    /* ------------------------------------------------------------------ *
     * API access
     * ------------------------------------------------------------------ */

    /** Fetch the per-process API token the local route hands to this page. */
    async function bootstrap() {
      const response = await fetch(API_ROOT + 'bootstrap', { credentials: 'same-origin' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || typeof data.token !== 'string') throw new Error(messageOf(data));
      return data.token;
    }

    /**
     * Call one token-protected route of the plugin API.
     *
     * @param {string} route - route name under the API root
     * @param {Record<string, string>} [params] - query parameters
     * @param {AbortSignal} [signal] - abort for a stale call
     */
    async function apiGet(route, params, signal) {
      const token = await bootstrap();
      const query = params === undefined ? '' : `?${new URLSearchParams(params).toString()}`;
      const response = await fetch(API_ROOT + route + query, {
        credentials: 'same-origin',
        headers: { 'x-copilot-config-token': token },
        ...(signal === undefined ? {} : { signal }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(messageOf(data));
      return data;
    }

    /* ------------------------------------------------------------------ *
     * `/` references — pure helpers
     * ------------------------------------------------------------------ */

    /**
     * Build the `dsh-resource://` address of a workspace file.
     *
     * Mirrors `buildFileAddress` from `lib/copilot.js`: the Host half and this
     * bundle cannot share a module, and one address scheme keeps a picked
     * reference opening in the same Document preview the Files tab uses.
     *
     * @param {string} sessionId - Session the path is read in
     * @param {string} path - workspace-relative path
     * @returns {string}
     */
    function sessionFileAddress(sessionId, path) {
      const encodeSegment = (segment) => encodeURIComponent(segment).replace(/%3A/gi, ':');
      const encodePath = (value) => value.split('/').map(encodeSegment).join('/');
      const normalized = String(path ?? '').replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
      return `dsh-resource://file/session/${encodeSegment(String(sessionId ?? ''))}/${encodePath(normalized)}`;
    }

    /**
     * Derive the name a user types after `/` from one configuration path.
     *
     * The path-only fallback of the Host's `deriveSlug`: it answers for a
     * clipboard projection whose frontmatter `name` is no longer at hand.
     *
     * @param {string} path - repository-relative path under `.github/`
     * @returns {string}
     */
    function slugFromPath(path) {
      const segments = String(path ?? '').replace(/\\/g, '/').split('/');
      const base = segments.pop() ?? '';
      if (base.toLowerCase() === 'skill.md') {
        const directory = segments.pop() ?? '';
        if (directory !== '') return directory;
      }
      return base.replace(/\.md$/i, '').replace(/\.(prompt|chatmode|instructions|agent)$/i, '');
    }

    /**
     * Pack one picked entry into the opaque reference id a chip carries.
     *
     * The Session travels with the path because the reference is serialized at
     * submit time, when no session projection is at hand, and the Host
     * resolves `.github` against the Session's working directory.
     *
     * @param {string} sessionId - Session the entry was picked in
     * @param {string} path - repository-relative path
     * @returns {string}
     */
    function encodeRef(sessionId, path) {
      return `${String(sessionId ?? '')}::${String(path ?? '')}`;
    }

    /**
     * Split one reference id back into its Session and path.
     *
     * @param {string} ref - id from {@link encodeRef}
     * @returns {{ sessionId: string, path: string }}
     */
    function decodeRef(ref) {
      const raw = String(ref ?? '');
      const cut = raw.indexOf('::');
      if (cut === -1) return { sessionId: '', path: raw };
      return { sessionId: raw.slice(0, cut), path: raw.slice(cut + 2) };
    }

    /**
     * Score one candidate against the text typed after `/`.
     *
     * @param {Record<string, unknown>} row - candidate
     * @param {string} needle - lower-cased query
     * @returns {number} `0` when the row does not match at all
     */
    function scoreRow(row, needle) {
      const name = String(row.name ?? '').toLowerCase();
      const label = String(row.label ?? '').toLowerCase();
      const description = String(row.description ?? '').toLowerCase();
      if (name === needle) return 100;
      if (name.startsWith(needle)) return 80;
      if (label.startsWith(needle)) return 60;
      if (name.includes(needle)) return 40;
      if (label.includes(needle)) return 20;
      if (description.includes(needle)) return 10;
      return 0;
    }

    /**
     * Rank the menu candidates, keeping one section's rows adjacent.
     *
     * @param {ReadonlyArray<Record<string, unknown>>} rows - candidates
     * @param {string} query - text typed after `/`
     * @returns {Array<Record<string, unknown>>} the rows to show
     */
    function rankRows(rows, query) {
      const list = [...rows];
      const needle = String(query ?? '').trim().toLowerCase();
      if (needle === '') return list;
      const scored = [];
      for (const row of list) {
        const score = scoreRow(row, needle);
        if (score > 0) scored.push({ row, score });
      }
      scored.sort((left, right) => (
        right.score - left.score || String(left.row.name).localeCompare(String(right.row.name))
      ));
      const ranked = scored.map((item) => item.row);
      const sections = [];
      for (const row of ranked) if (!sections.includes(row.section)) sections.push(row.section);
      const grouped = [];
      for (const section of sections) {
        for (const row of ranked) if (row.section === section) grouped.push(row);
      }
      return grouped;
    }

    /**
     * Reverse the attribute escaping the Host applies when it builds a block.
     *
     * @param {string} value - escaped attribute value
     * @returns {string}
     */
    function unescapeAttribute(value) {
      return String(value ?? '')
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
    }

    /** One serialized reference block inside a sent message. */
    const REFERENCE_BLOCK = /<copilot_(skill|agent) name="([^"]*)" path="([^"]*)">[\s\S]*?<\/copilot_\1>/g;

    /**
     * Render one `<copilot_skill>` / `<copilot_agent>` block of a sent message
     * as a chip that reopens the file it came from.
     */
    const copilotReferenceRule = {
      id: 'copilot',
      order: 25,
      match(text, from) {
        REFERENCE_BLOCK.lastIndex = from;
        const match = REFERENCE_BLOCK.exec(text);
        if (match === null) return undefined;
        return {
          id: 'copilot',
          start: match.index,
          end: match.index + match[0].length,
          data: {
            kind: match[1],
            name: unescapeAttribute(match[2]),
            path: unescapeAttribute(match[3]),
          },
        };
      },
    };

    /* ------------------------------------------------------------------ *
     * `/` references — catalog, source, and chip
     * ------------------------------------------------------------------ */

    /**
     * Build the conversation half of the `/` pipeline.
     *
     * One catalog per Session feeds the composer menu, the reference codec,
     * and the panel refresh; a failed read drops the cache entry so the next
     * interaction retries instead of serving a stale answer.
     *
     * @param {Record<string, unknown>} ctx - client root context
     * @param {(key: string) => string} t - translator
     */
    function createReferenceLayer(ctx, t) {
      const caches = new Map();

      function fill(key, vars) {
        let text = String(t(key));
        if (!isObject(vars)) return text;
        for (const [name, value] of Object.entries(vars)) {
          text = text.split('{' + name + '}').join(String(value));
        }
        return text;
      }

      function sidebarService() {
        try {
          if (ctx.sidebarRight !== undefined && ctx.sidebarRight !== null) return ctx.sidebarRight;
        } catch {
          /* fall through to the optional lookup */
        }
        try {
          if (typeof ctx.get === 'function') {
            const service = ctx.get('sidebarRight');
            if (service !== undefined && service !== null) return service;
          }
        } catch (error) {
          console.error('[copilot-config] sidebarRight lookup failed', error);
        }
        return undefined;
      }

      function openFile(sessionId, path) {
        const sidebar = sidebarService();
        if (sidebar !== undefined && typeof sidebar.openResource === 'function') {
          try {
            sidebar.openResource(sessionFileAddress(sessionId, path));
            return true;
          } catch (error) {
            console.error('[copilot-config] openResource failed', error);
          }
        }
        return false;
      }

      function catalogOf(sessionId) {
        const existing = caches.get(sessionId);
        if (existing !== undefined) return existing;
        const entry = { entries: [], promise: undefined };
        entry.promise = (async () => {
          const data = await apiGet('catalog', sessionId === '' ? undefined : { session: sessionId });
          entry.entries = Array.isArray(data.entries) ? data.entries : [];
          return entry.entries;
        })().catch((error) => {
          if (caches.get(sessionId) === entry) caches.delete(sessionId);
          throw error;
        });
        entry.promise.catch(() => {});
        caches.set(sessionId, entry);
        return entry;
      }

      function invalidate(sessionId) {
        caches.delete(sessionId);
      }

      function invalidateAll() {
        caches.clear();
      }

      const source = {
        trigger: '/',
        name: SOURCE_NAME,
        order: 3,
        showGroupTitle: false,
        async candidates(session, req) {
          const entries = await catalogOf(session.sessionId).promise;
          if (req.signal.aborted) return [];
          const rows = [];
          for (const entry of entries) {
            const section = SECTION_OF_KIND[entry.kind];
            if (section === undefined) continue;
            const name = String(entry.name ?? '');
            const path = String(entry.path ?? '');
            if (name === '' || path === '') continue;
            rows.push({
              name,
              label: String(entry.title ?? '') === '' ? name : String(entry.title),
              description: String(entry.description ?? ''),
              section: t(sectionKey(section)),
              value: path,
            });
          }
          return rankRows(rows, req.query);
        },
        warm(session) {
          catalogOf(session.sessionId).promise.catch(() => {});
        },
        onPick(pick) {
          const name = String(pick.candidate.name ?? '');
          const path = String(pick.candidate.value ?? '');
          if (name === '' || path === '') return undefined;
          return {
            insert: {
              source: SOURCE_NAME,
              ref: encodeRef(pick.session.sessionId, path),
              label: `/${name}`,
              appearance: 'file',
              clipboardText: `/${name}`,
            },
          };
        },
        openReference(session, reference) {
          const decoded = decodeRef(reference?.ref);
          if (decoded.path === '') return false;
          const sessionId = String(session?.sessionId ?? '') === '' ? decoded.sessionId : String(session.sessionId);
          return openFile(sessionId, decoded.path);
        },
        codec: {
          clipboardText(ref) {
            return `/${slugFromPath(decodeRef(ref).path)}`;
          },
          async serialize(ref, signal) {
            const decoded = decodeRef(ref);
            if (decoded.path === '') throw new Error('the Copilot reference lost its path');
            try {
              const data = await apiGet('file', {
                path: decoded.path,
                ...(decoded.sessionId === '' ? {} : { session: decoded.sessionId }),
              }, signal);
              const file = isObject(data.file) ? data.file : undefined;
              const reference = typeof file?.reference === 'string' ? file.reference : '';
              if (reference === '') throw new Error('the file is not an invocable Copilot entry');
              return reference;
            } catch (error) {
              throw new Error(fill('referenceFailed', { path: decoded.path, message: messageOf(error) }));
            }
          },
        },
      };

      function CopilotReference({ node, interactive, openCopilot }) {
        const data = isObject(node?.data) ? node.data : {};
        const name = String(data.name ?? '');
        const path = String(data.path ?? '');
        const label = name === '' ? path : `/${name}`;
        const body = h(React.Fragment, null,
          h('span', { className: 'rdc-chip-slash', 'aria-hidden': 'true' }, '/'),
          h('span', { className: 'rdc-chip-label' }, label),
        );
        if (interactive === true && typeof openCopilot === 'function' && path !== '') {
          return h('button', {
            type: 'button',
            className: 'rdc-chip rdc-chip--button',
            title: fill('chipTitle', { path }),
            onClick: () => openCopilot(path),
          }, body);
        }
        return h('span', { className: 'rdc-chip', title: fill('chipTitle', { path }) }, body);
      }

      return { source, rule: copilotReferenceRule, CopilotReference, openFile, invalidate, invalidateAll };
    }

    /**
     * Build the configuration page.
     *
     * @param {Record<string, unknown>} ctx - client root context
     * @param {(key: string) => string} t - translator
     * @param {{ invalidate: (sessionId: string) => void }} [reference] - `/` layer to refresh with the panel
     */
    function createPage(ctx, t, reference) {
      function fill(key, vars) {
        let text = String(t(key));
        if (!isObject(vars)) return text;
        for (const [name, value] of Object.entries(vars)) {
          text = text.split('{' + name + '}').join(String(value));
        }
        return text;
      }

      function sidebarService() {
        try {
          if (ctx.sidebarRight !== undefined && ctx.sidebarRight !== null) return ctx.sidebarRight;
        } catch {
          /* fall through to the optional lookup */
        }
        try {
          if (typeof ctx.get === 'function') {
            const service = ctx.get('sidebarRight');
            if (service !== undefined && service !== null) return service;
          }
        } catch (error) {
          console.error('[copilot-config] sidebarRight lookup failed', error);
        }
        return undefined;
      }

      function openResource(address) {
        const sidebar = sidebarService();
        if (sidebar !== undefined && typeof sidebar.openResource === 'function') {
          try {
            sidebar.openResource(address);
            return true;
          } catch (error) {
            console.error('[copilot-config] openResource failed', error);
          }
        }
        return false;
      }

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

      const iconRefresh = glyph(['M20 11a8 8 0 1 0-2.4 5.7', 'M20 5v6h-6']);
      const iconExternal = glyph(['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5']);
      const iconImage = glyph(['M4 5h16v14H4z', 'M8.5 10.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z', 'M6 17l4.5-5 3.5 4 3-3.5L20 17'], 12);
      const iconFile = glyph(['M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7z', 'M14 3v4h4'], 30);

      return function RemoteCopilotPage(props) {
        const useSessions = typeof props?.useSessions === 'function' ? props.useSessions : () => undefined;
        const sessionsSnapshot = useSessions((state) => state);
        // The tab body hands over the Session it belongs to; the fallback reads
        // the main Session when the page is rendered outside a tab.
        const ownSession = typeof props?.sessionId === 'string' ? props.sessionId : '';
        const mainSession = React.useMemo(() => {
          if (!isObject(sessionsSnapshot)) return '';
          const byId = isObject(sessionsSnapshot.byId) ? sessionsSnapshot.byId : {};
          const ids = Array.isArray(sessionsSnapshot.ids) ? sessionsSnapshot.ids : Object.keys(byId);
          const main = ids.find((id) => {
            const retained = byId[id]?.retainedBy;
            return isObject(retained) && Number(retained.mainView ?? 0) > 0;
          });
          return main ?? ids[0] ?? '';
        }, [sessionsSnapshot]);
        const sessionId = ownSession !== '' ? ownSession : mainSession;
        const surface = props?.surface === 'tab' ? 'tab' : 'page';

        const [notice, setNotice] = React.useState(null);
        const [state, setState] = React.useState({
          phase: 'loading',
          error: '',
          root: '',
          present: false,
          files: [],
          errors: [],
        });
        const [detail, setDetail] = React.useState({ phase: 'idle', path: '', file: undefined, error: '' });

        const noticeBar = notice === null
          ? null
          : h('div', { className: 'rdc-note rdc-note--' + notice.kind, role: 'status' }, notice.text);

        const load = React.useCallback(async () => {
          setState((current) => ({ ...current, phase: 'loading', error: '' }));
          try {
            const data = await apiGet('config', sessionId === '' ? undefined : { session: sessionId });
            setState({
              phase: 'ready',
              error: '',
              root: typeof data.root === 'string' ? data.root : '',
              present: data.present === true,
              files: Array.isArray(data.files) ? data.files : [],
              errors: Array.isArray(data.errors) ? data.errors : [],
            });
            if (typeof reference?.invalidate === 'function') reference.invalidate(sessionId);
          } catch (error) {
            setState((current) => ({ ...current, phase: 'error', error: messageOf(error) }));
          }
        }, [sessionId]);

        React.useEffect(() => {
          load();
        }, [load]);

        const open = React.useCallback(async (path) => {
          setDetail({ phase: 'loading', path, file: undefined, error: '' });
          try {
            const data = await apiGet('file', {
              ...(sessionId === '' ? {} : { session: sessionId }),
              path,
            });
            setDetail({ phase: 'ready', path, file: data.file, error: '' });
          } catch (error) {
            setDetail({ phase: 'error', path, file: undefined, error: messageOf(error) });
          }
        }, [sessionId]);

        const openAddress = (address) => {
          if (typeof address !== 'string' || address === '') return;
          if (openResource(address)) return;
          setNotice({ kind: 'error', text: t('openFailed') });
        };

        function renderSpans(spans) {
          if (!Array.isArray(spans)) return null;
          return spans.map((span, index) => {
            const key = `${span?.type ?? 'text'}-${index}`;
            switch (span?.type) {
              case 'code':
                return h('code', { className: 'rdc-code-inline', key }, span.text ?? '');
              case 'strong':
                return h('strong', { key }, span.text ?? '');
              case 'em':
                return h('em', { key }, span.text ?? '');
              case 'link': {
                if (typeof span.address === 'string' && span.address !== '') {
                  return h('button', {
                    type: 'button',
                    className: 'rdc-link',
                    key,
                    onClick: () => openAddress(span.address),
                  }, span.text ?? span.href ?? '');
                }
                if (span.external === true || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(String(span.href ?? ''))) {
                  return h('a', {
                    className: 'rdc-link',
                    key,
                    href: span.href,
                    target: '_blank',
                    rel: 'noreferrer noopener',
                  }, span.text ?? span.href ?? '');
                }
                return h('span', { key }, span.text ?? '');
              }
              case 'image': {
                const label = span.text === '' ? String(span.href ?? '') : String(span.text);
                if (typeof span.address === 'string' && span.address !== '') {
                  return h('button', {
                    type: 'button',
                    className: 'rdc-link',
                    key,
                    onClick: () => openAddress(span.address),
                  }, iconImage, ' ' + label);
                }
                return h('span', { key }, label);
              }
              default: {
                const text = String(span?.text ?? '');
                if (!text.includes('\n')) return text;
                return text.split('\n').map((part, partIndex) => (
                  partIndex === 0 ? part : h(React.Fragment, { key: `${key}-${partIndex}` }, h('br'), part)
                ));
              }
            }
          });
        }

        function renderBlock(block, index) {
          const key = `${block?.type ?? 'block'}-${index}`;
          switch (block?.type) {
            case 'heading': {
              const level = Math.min(6, Math.max(2, Number(block.level) || 2));
              return h(`h${level}`, { className: 'rdc-h' + (level > 2 ? ` rdc-h${level}` : ''), key }, renderSpans(block.spans));
            }
            case 'paragraph':
              return h('p', { className: 'rdc-p', key }, renderSpans(block.spans));
            case 'quote':
              return h('blockquote', { className: 'rdc-quote', key }, renderSpans(block.spans));
            case 'list':
              return h(block.ordered === true ? 'ol' : 'ul', { className: 'rdc-mdlist', key },
                (block.items ?? []).map((item, itemIndex) => h('li', { className: 'rdc-li', key: itemIndex }, renderSpans(item.spans))));
            case 'code':
              return h('pre', { className: 'rdc-code', key }, h('code', null, String(block.text ?? '')));
            case 'hr':
              return h('div', { className: 'rdc-hr', key });
            default:
              return null;
          }
        }

        const kindLabel = (kind) => t('kind' + String(kind ?? 'other').charAt(0).toUpperCase() + String(kind ?? 'other').slice(1));

        const grouped = KINDS.map((kind) => ({
          kind,
          files: state.files.filter((file) => file.kind === kind),
        })).filter((group) => group.files.length > 0);

        const listPanel = h('aside', { className: 'rdc-filelist' },
          grouped.map((group) => h('div', { className: 'rdc-group', key: group.kind },
            h('div', { className: 'rdc-group-head' },
              h('span', { className: 'rdc-group-title' }, kindLabel(group.kind)),
              h('span', { className: 'rdc-group-count' }, String(group.files.length)),
            ),
            group.files.map((file) => h('button', {
              type: 'button',
              className: 'rdc-item',
              key: file.path,
              'aria-pressed': detail.path === file.path ? 'true' : 'false',
              onClick: () => open(file.path),
            },
            h('span', { className: 'rdc-item-name' }, file.title || file.path),
            h('span', { className: 'rdc-item-path' }, file.path),
            h('span', { className: 'rdc-item-meta' },
              file.invoke === '' || file.invoke === undefined
                ? null
                : h('span', { className: 'rdc-badge rdc-badge--invoke', title: fill('invokeTitle', { name: file.invoke }) }, `/${file.invoke}`),
              file.applyTo === '' ? null : h('span', { className: 'rdc-badge rdc-badge--muted' }, `${t('applyToLabel')} ${file.applyTo}`),
              file.mode === '' ? null : h('span', { className: 'rdc-badge rdc-badge--muted' }, `${t('modeLabel')} ${file.mode}`),
            ),
            )),
          )),
        );

        const file = isObject(detail.file) ? detail.file : undefined;
        const links = Array.isArray(file?.links) ? file.links : [];

        const viewerPanel = h('section', { className: 'rdc-viewer' },
          detail.phase === 'loading' && file === undefined
            ? h('div', { className: 'rdc-state' },
              h('span', { className: 'rdc-spinner', 'aria-hidden': 'true' }),
              h('span', null, t('loading')),
            )
            : file === undefined
              ? h('div', { className: 'rdc-state' },
                iconFile,
                h('div', { className: 'rdc-empty-title' }, t('viewerTitle')),
                h('div', { className: 'rdc-hint' }, t('viewerHint')),
              )
              : h(React.Fragment, null,
                h('div', { className: 'rdc-viewer-head' },
                  h('div', { className: 'rdc-viewer-copy' },
                    h('h2', { className: 'rdc-viewer-title' }, file.title || file.path),
                    h('div', { className: 'rdc-viewer-path' }, file.path),
                    h('div', { className: 'rdc-viewer-meta' },
                      h('span', { className: 'rdc-badge rdc-badge--muted' }, kindLabel(file.kind)),
                      file.invoke === '' || file.invoke === undefined
                        ? null
                        : h('span', { className: 'rdc-badge rdc-badge--invoke', title: fill('invokeTitle', { name: file.invoke }) }, `/${file.invoke}`),
                      file.applyTo === '' ? null : h('span', { className: 'rdc-badge rdc-badge--muted' }, `${t('applyToLabel')} ${file.applyTo}`),
                      file.mode === '' ? null : h('span', { className: 'rdc-badge rdc-badge--muted' }, `${t('modeLabel')} ${file.mode}`),
                      h('span', { className: 'rdc-badge rdc-badge--muted' }, `${t('bytesLabel')} ${file.bytes}`),
                    ),
                  ),
                  h('div', { className: 'rdc-viewer-actions' },
                    h('button', {
                      type: 'button',
                      className: 'rdc-btn rdc-btn--small rdc-btn--primary',
                      disabled: typeof file.address !== 'string' || file.address === '',
                      onClick: () => openAddress(file.address),
                    }, iconExternal, t('openInSidebar')),
                  ),
                ),
                detail.phase === 'loading' ? h('div', { className: 'rdc-hint' }, t('loading')) : null,
                detail.phase === 'error' && detail.error !== ''
                  ? h('div', { className: 'rdc-note rdc-note--error' }, fill('loadFailed', { message: detail.error }))
                  : null,
                h('div', { className: 'rdc-content' }, (file.blocks ?? []).map(renderBlock)),
                h('div', { className: 'rdc-links' },
                  h('div', { className: 'rdc-links-title' }, t('fileLinks')),
                  links.length === 0
                    ? h('div', { className: 'rdc-hint' }, t('noFileLinks'))
                    : h('div', { className: 'rdc-link-rows' },
                      links.map((link, index) => h('button', {
                        type: 'button',
                        className: 'rdc-link-chip',
                        key: `${link.target}-${index}`,
                        onClick: () => {
                          if (link.external === true) {
                            window.open(link.target, '_blank', 'noopener,noreferrer');
                            return;
                          }
                          openAddress(link.address ?? '');
                        },
                      },
                      h('span', { className: 'rdc-link-chip-text' }, link.text || link.target),
                      h('span', { className: 'rdc-link-chip-path' }, link.external === true ? t('externalLink') : link.path),
                      )),
                    ),
                ),
              ),
        );

        if (state.phase === 'loading') {
          return h('div', { className: 'rdc-root', 'data-surface': surface }, h('div', { className: 'rdc-inner' },
            h('div', { className: 'rdc-state' },
              h('span', { className: 'rdc-spinner', 'aria-hidden': 'true' }),
              h('span', null, t('loading')),
            ),
          ));
        }

        if (state.phase === 'error') {
          return h('div', { className: 'rdc-root', 'data-surface': surface }, h('div', { className: 'rdc-inner' },
            h('div', { className: 'rdc-state' },
              h('div', { className: 'rdc-note rdc-note--error' }, fill('loadFailed', { message: state.error })),
              h('button', { type: 'button', className: 'rdc-btn', onClick: load }, t('retry')),
            ),
          ));
        }

        return h('div', { className: 'rdc-root', 'data-surface': surface },
          h('div', { className: 'rdc-inner' },
            h('header', { className: 'rdc-hero' },
              h('div', { className: 'rdc-hero-copy' },
                h('div', { className: 'rdc-eyebrow' }, t('eyebrow')),
                h('h1', { className: 'rdc-title' }, t('title')),
                h('p', { className: 'rdc-sub' }, t('subtitle')),
              ),
              h('div', { className: 'rdc-hero-actions' },
                h('button', {
                  type: 'button',
                  className: 'rdc-btn rdc-btn--icon',
                  onClick: load,
                  title: t('refresh'),
                  'aria-label': t('refresh'),
                }, iconRefresh),
              ),
            ),
            h('div', { className: 'rdc-config-bar' },
              h('span', { className: 'rdc-config-label' }, t('rootLabel')),
              h('span', { className: 'rdc-config-value' }, state.root || '—'),
              h('span', { className: 'rdc-badge' + (state.present === true ? ' rdc-badge--ok' : '') },
                state.present === true ? t('presentBadge') : t('missingBadge')),
              sessionId === '' ? null : h('span', { className: 'rdc-badge rdc-badge--muted' }, `${t('sessionLabel')} ${sessionId}`),
            ),
            state.errors.length === 0 ? null : h('div', { className: 'rdc-note rdc-note--warn' }, fill('errorsNote', { message: state.errors.join('; ') })),
            noticeBar,
            state.present !== true || state.files.length === 0
              ? h('div', { className: 'rdc-empty' },
                iconFile,
                h('div', { className: 'rdc-empty-title' }, t('missingTitle')),
                h('div', { className: 'rdc-hint' }, t('missingHint')),
              )
              : h('div', { className: 'rdc-body' }, listPanel, viewerPanel),
          ),
        );
      };
    }

    function apply(ctx) {
      ctx.effect(() => {
        const tagId = 'dsh-plugin-copilot-config/styles.css';
        if (typeof document === 'undefined') return () => {};
        if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') !== null) return () => {};
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-plugin-copilot-config';
        tag.dataset.pluginCss = tagId;
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => { tag.remove(); };
      }, 'copilot-config: styles');

      let t = (key) => (zh[key] === undefined ? key : zh[key]);
      try {
        ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'copilot-config: locale');
        const bound = ctx.locale.bind(LOCALE_NS);
        if (typeof bound === 'function') t = bound;
      } catch (error) {
        console.error('[copilot-config] locale unavailable, falling back to built-in copy', error);
      }

      const reference = createReferenceLayer(ctx, t);

      // One page component, wrapped once: a new component identity on every
      // render would remount the whole tab and lose its selection.
      const Page = createPage(ctx, t, reference);
      const TabBody = (props) => h(Page, { ...props, surface: 'tab' });

      ctx.effect(() => {
        const offs = [];
        // A slot a host does not declare must not take the others down with it:
        // the failure is logged and the remaining contributions still register.
        const contribute = (owner, options, Component) => {
          if (typeof ctx.slots?.inject !== 'function' || typeof ctx.slots?.register !== 'function') return;
          const off = ctx.slots.inject(owner, function* () {
            try {
              yield ctx.slots.register(options, Component);
            } catch (error) {
              console.error(`[copilot-config] slot ${owner} unavailable`, error);
            }
          });
          if (typeof off === 'function') offs.push(off);
        };

        // The configuration lives in the conversation's right panel: one tab per
        // Session, opened from the panel's guide or the shortcut below.
        contribute('sidebar.right.pane.tab', {
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
        }, TabBody);
        contribute('conversation.user.text.node', {
          name: 'conversation.user.text.node',
          key: SOURCE_NAME,
          priority: 100,
          inject: (sessionId) => ({
            openCopilot: (path) => { reference.openFile(sessionId, path); },
          }),
        }, reference.CopilotReference);
        return () => {
          for (const off of offs) {
            try { off(); } catch { /* ignore */ }
          }
        };
      }, 'copilot-config: slots');

      // The tab type itself, with the guide entry box that opens it.
      ctx.inject(['sidebarRightTabs'], (tabCtx) => {
        tabCtx.effect(() => tabCtx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          priority: 'extension',
          title: () => t('tabTitle'),
          guide: [{
            id: 'config',
            commandId: COMMAND_ID,
            order: 40,
            title: () => t('menu'),
            description: () => t('guideDescription'),
            icon: Icon,
          }],
        }), 'copilot-config: tab type');
      });

      // A keyboard path to the tab, now that no menu row opens it.
      ctx.inject(['shortcuts', 'sidebarRight'], (shortcutCtx) => {
        shortcutCtx.effect(() => shortcutCtx.shortcuts.register({
          id: COMMAND_ID,
          label: () => t('menu'),
          aliases: ['copilot config', 'copilot configuration', 'copilot 配置'],
          defaults: {},
          regions: ['page', 'editable', 'terminal'],
          modals: [],
          resolve: ({ target: element }) => {
            const target = shortcutCtx.sidebarRight.commandTarget(element);
            if (target === undefined) return { status: 'blocked', reason: t('shortcutNoSession') };
            return {
              status: 'handled',
              run: () => { shortcutCtx.sidebarRight.openTabFromTarget(TAB_KIND, target); },
            };
          },
        }), 'copilot-config: shortcut');
      });

      // `/` menu: the project's prompts, Agent Skills, chat modes, and agents.
      // Both services are optional at runtime: a host without the conversation
      // UI keeps the tab, and the references simply never register.
      ctx.inject(['inputTriggers'], (triggerCtx) => {
        triggerCtx.effect(() => {
          const unregister = triggerCtx.inputTriggers.registerSource(reference.source);
          return () => {
            unregister();
            reference.invalidateAll();
          };
        }, 'copilot-config: slash source');
      });

      // Sent references render back as chips instead of raw wrapper blocks.
      ctx.inject(['uiConversation'], (conversationCtx) => {
        conversationCtx.effect(
          () => conversationCtx.uiConversation.userText.register(reference.rule),
          'copilot-config: user text',
        );
      });
    }

    const internals = {
      createPage, CSS, zh, en,
      rankRows, slugFromPath, encodeRef, decodeRef, sessionFileAddress,
      copilotReferenceRule, createReferenceLayer,
    };

    return {
      inject: ['slots', 'locale', 'sidebarRight'],
      apply,
      __internals: internals,
    };
  },
});
