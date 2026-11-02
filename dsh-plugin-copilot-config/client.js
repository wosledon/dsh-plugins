/**
 * Client half of the Copilot configuration plugin.
 *
 * A left-sidebar panel and its main page list the GitHub Copilot configuration
 * a project carries in `.github/`, render one file at a time, and turn every
 * relative markdown link into a file link that opens in the right sidebar's
 * Document preview.
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
      missingHint: '在项目里创建 .github/copilot-instructions.md、.github/instructions/*.instructions.md、.github/prompts/*.prompt.md 或 .github/chatmodes/*.chatmode.md 后刷新。',
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
      kindChatmode: '聊天模式',
      kindAgent: '自定义代理',
      kindOther: '其他',
      openFailed: '右侧栏打开失败，已改用新窗口。',
      errorsNote: '部分路径无法读取：{message}',
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
      missingHint: 'Create .github/copilot-instructions.md, .github/instructions/*.instructions.md, .github/prompts/*.prompt.md, or .github/chatmodes/*.chatmode.md in the project, then refresh.',
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
      kindChatmode: 'Chat modes',
      kindAgent: 'Custom agents',
      kindOther: 'Other',
      openFailed: 'Could not open in the right sidebar; opened a new window instead.',
      errorsNote: 'Some paths could not be read: {message}',
    };

    /** Display order of the Copilot configuration kinds. */
    const KINDS = ['instructions', 'instruction', 'prompt', 'chatmode', 'agent', 'other'];

    const CSS = [
      '.rdc-root{height:100%;box-sizing:border-box;overflow:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
      '.rdc-inner{display:flex;flex-direction:column;gap:16px;max-width:1180px;margin:0 auto;padding:28px 22px 48px;box-sizing:border-box}',
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

    function createPage(ctx, t) {
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

      async function bootstrap() {
        const response = await fetch(API_ROOT + 'bootstrap', { credentials: 'same-origin' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || typeof data.token !== 'string') throw new Error(messageOf(data));
        return data.token;
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
        const sessionId = React.useMemo(() => {
          if (!isObject(sessionsSnapshot)) return '';
          const byId = isObject(sessionsSnapshot.byId) ? sessionsSnapshot.byId : {};
          const ids = Array.isArray(sessionsSnapshot.ids) ? sessionsSnapshot.ids : Object.keys(byId);
          const main = ids.find((id) => {
            const retained = byId[id]?.retainedBy;
            return isObject(retained) && Number(retained.mainView ?? 0) > 0;
          });
          return main ?? ids[0] ?? '';
        }, [sessionsSnapshot]);

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
            const token = await bootstrap();
            const params = new URLSearchParams();
            if (sessionId !== '') params.set('session', sessionId);
            const query = params.toString();
            const response = await fetch(API_ROOT + 'config' + (query === '' ? '' : `?${query}`), {
              credentials: 'same-origin',
              headers: { 'x-copilot-config-token': token },
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(messageOf(data));
            setState({
              phase: 'ready',
              error: '',
              root: typeof data.root === 'string' ? data.root : '',
              present: data.present === true,
              files: Array.isArray(data.files) ? data.files : [],
              errors: Array.isArray(data.errors) ? data.errors : [],
            });
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
            const token = await bootstrap();
            const params = new URLSearchParams();
            if (sessionId !== '') params.set('session', sessionId);
            params.set('path', path);
            const response = await fetch(API_ROOT + 'file?' + params.toString(), {
              credentials: 'same-origin',
              headers: { 'x-copilot-config-token': token },
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(messageOf(data));
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
          return h('div', { className: 'rdc-root' }, h('div', { className: 'rdc-inner' },
            h('div', { className: 'rdc-state' },
              h('span', { className: 'rdc-spinner', 'aria-hidden': 'true' }),
              h('span', null, t('loading')),
            ),
          ));
        }

        if (state.phase === 'error') {
          return h('div', { className: 'rdc-root' }, h('div', { className: 'rdc-inner' },
            h('div', { className: 'rdc-state' },
              h('div', { className: 'rdc-note rdc-note--error' }, fill('loadFailed', { message: state.error })),
              h('button', { type: 'button', className: 'rdc-btn', onClick: load }, t('retry')),
            ),
          ));
        }

        return h('div', { className: 'rdc-root' },
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

      ctx.effect(() => {
        const offs = [];
        const contribute = (owner, options, Component) => {
          if (typeof ctx.slots?.inject !== 'function' || typeof ctx.slots?.register !== 'function') return;
          const off = ctx.slots.inject(owner, function* () {
            yield ctx.slots.register(options, Component);
          });
          if (typeof off === 'function') offs.push(off);
        };

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

        contribute('sidebar.panellist', {
          name: 'sidebar.panellist',
          id: 'copilot-config',
          order: 40,
          label: () => t('menu'),
        }, Icon);
        contribute('main', { name: 'main', key: 'copilot-config' }, createPage(ctx, t));
        return () => {
          for (const off of offs) {
            try { off(); } catch { /* ignore */ }
          }
        };
      }, 'copilot-config: slots');
    }

    const internals = { createPage, CSS, zh, en };

    return { inject: ['slots', 'locale', 'sidebarRight'], apply, __internals: internals };
  },
});
