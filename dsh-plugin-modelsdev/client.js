/**
 * 「models.dev 目录」——浏览器侧。
 *
 * 背景：DSH 的“设置 → 模型”页负责声明供应商路由和模型，但这份声明需要用户
 * 逐项手填。models.dev 维护了 235 个供应商、约 9 千个模型的公共目录，其中包含
 * 端点、所需环境变量、上下文窗口、输出上限、输入模态和推理等级——正好是
 * `@deepseek-ai/dsh-llm-pi-ai` 的 `providers.<route>` 需要的信息。
 *
 * 本插件在官方为仓库外插件预留的席位 `settings.models.footer` 里加一个浏览器：
 *
 *   1. 从宿主路由 `/plugin-modelsdev/catalog` 读紧凑目录（宿主已缓存、已剔除
 *      非对话模型和弃用模型）；
 *   2. 选中供应商后，按 models.dev 的 `npm` 字段推断协议、按 `api` 预填端点、
 *      按 `env` 推导凭据引用；
 *   3. 选中模型并通过 `remote.settings.mutate('llm-pi-ai', …)` 写入一条
 *      供应商路由；API Key 走 `remote.credentials.set`，永不进入设置文档。
 *
 * 关键判断：一个供应商是否「已被 pi-ai 安装目录认识」。认识的目录路由不需要
 * 声明 `api`/`baseURL`，模型元数据也能从已安装目录继承；不认识的（绝大多数
 * OpenAI 兼容网关）必须显式给出协议和端点。为此插件通过
 * `remote.llm.discoverModels('llm-pi-ai', …)` 读取 pi-ai 的已安装模型清单，
 * 用它决定每条模型是否需要写全量字段。
 *
 * 工厂必须无副作用：样式、文案、席位注册都在 apply 内建立并清理。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-modelsdev',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** 文案命名空间；与包名分开，避免和宿主命名空间撞车。 */
    const LOCALE_NS = 'plugin.modelsdev';
    /** 官方为仓库外插件预留的列表席位：供应商行与添加控件之后。 */
    const SLOT_KEY = 'settings.models.footer';
    /** 宿主路由；必须与 lib/catalog.js 的 CATALOG_PATH 一致。 */
    const CATALOG_PATH = '/plugin-modelsdev/catalog';
    /** pi-ai 适配器在设置文档里的命名空间。 */
    const SETTINGS_NS = 'llm-pi-ai';
    /** pi-ai 支持的自定义路由协议（顺序即下拉顺序）。 */
    const PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages'];
    /** 一次最多渲染多少个模型行，避免超长列表拖慢设置页；搜索仍覆盖全部。 */
    const MODEL_RENDER_LIMIT = 250;
    /** 路由 id：pi-ai 的凭据记录使用小写连字符标识，这里也保持这个形状。 */
    const ROUTE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
    /** 凭据引用必须是 POSIX 标识符。 */
    const CREDENTIAL_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

    /* ---------------------------------------------------------------- */
    /* 文案                                                              */
    /* ---------------------------------------------------------------- */

    const zh = {
      title: 'models.dev 目录',
      subtitle: '浏览公共供应商与模型目录，选中后直接导入 DSH。',
      browse: '浏览目录',
      collapse: '收起',
      refresh: '刷新目录',
      refreshing: '刷新中…',
      retry: '重试',
      loading: '正在读取 models.dev 目录…',
      loadFailed: '读取 models.dev 目录失败：{message}',
      stale: '上游暂时不可用，正在使用缓存目录',
      updatedAt: '更新于 {time}',
      summary: '{providers} 个供应商 · {models} 个模型',
      catalogEmpty: '目录中没有任何可用的对话模型。',
      searchProvider: '搜索供应商（名称或 ID）',
      onlyReady: '只看可直接导入',
      noProviderMatch: '没有匹配的供应商。',
      pickProvider: '从左侧选择一个供应商，挑选要导入的模型。',
      added: '已添加',
      needsEndpoint: '需填端点',
      onlyCatalog: '已安装目录',
      models: '模型',
      docs: '文档',
      route: 'Provider ID',
      routeHint: '设置键与请求路由名；只能使用小写字母、数字、点、下划线和连字符。',
      displayName: '显示名称',
      protocol: 'API 协议',
      protocolAuto: '使用已安装目录',
      protocolHintCatalog: '留空表示沿用 pi-ai 已安装目录中每个模型自己的协议。',
      protocolHintCustom: '该供应商不在 pi-ai 已安装目录中，必须选择协议。',
      protocolHintMixed: '已安装模型沿用目录协议；目录外模型需要显式选择协议。',
      baseURL: 'API 地址',
      baseURLHintCatalog: '留空使用已安装目录的默认地址。',
      baseURLHintCustom: '必填：该供应商不在 pi-ai 已安装目录中。',
      baseURLHintMixed: '目录外模型需要 API 地址；已安装模型可沿用目录地址。',
      apiKey: 'API Key',
      apiKeyPlaceholder: '粘贴密钥；留空则使用环境变量',
      apiKeyStored: '已配置（{ref}）',
      apiKeyMissing: '未配置（{ref}）',
      apiKeyUnknown: '无法确认密钥状态',
      apiKeyHint: '密钥写入 DSH 凭据库，不进入设置文档。',
      nativeAuthHint: '留空则沿用供应商原生认证（不写 apiKeyEnv）。',
      modelsTitle: '选择模型',
      searchModel: '搜索模型（名称或 ID）',
      selectAll: '全选',
      clearAll: '清空',
      selectedCount: '已选 {selected} / {total}',
      installedHint: '其中 {count} 个模型不在 pi-ai 已安装目录中，导入时会写全量元数据。',
      discovering: '正在读取 pi-ai 已安装模型…',
      discoverFailed: '无法读取 pi-ai 已安装目录；导入结果仍会由宿主校验。',
      showingFirst: '列表仅显示前 {shown} 个匹配项，继续输入可缩小范围。',
      noModelMatch: '没有匹配的模型。',
      context: '上下文',
      output: '输出',
      reasoning: '推理',
      vision: '图像',
      import: '导入到 DSH',
      importing: '导入中…',
      imported: '已导入。展开“设置 → 模型”中的供应商行可继续编辑。',
      importedKeyFailed: '路由已导入，但 API Key 保存失败。',
      noSettings: '找不到 llm-pi-ai 设置命名空间，无法导入。',
      readOnly: '当前设置文档只读。',
      errRoute: 'Provider ID 不合法：只能使用小写字母、数字、点、下划线和连字符，并以字母或数字开头。',
      errRouteExists: '该 Provider ID 已存在，请换一个。',
      errDisplayName: '显示名称不能为空。',
      errModels: '至少选择一个模型。',
      errProtocol: '该供应商需要显式 API 协议。',
      errBaseURL: '该供应商不在 pi-ai 已安装目录中，必须填写 API 地址。',
      errBaseURLInvalid: 'API 地址必须是 http(s) URL。',
      errWrite: '写入设置失败：{message}',
      errConflict: '设置已被其他改动推进，已重新读取，请重试。',
      errSettings: '读取设置失败：{message}',
      errDirectory: '读取供应商目录失败：{message}',
      unknownError: '未知错误',
    };

    const en = {
      title: 'models.dev catalog',
      subtitle: 'Browse the public provider and model catalog, then import a route into DSH.',
      browse: 'Browse catalog',
      collapse: 'Collapse',
      refresh: 'Refresh catalog',
      refreshing: 'Refreshing…',
      retry: 'Retry',
      loading: 'Loading the models.dev catalog…',
      loadFailed: 'Could not load the models.dev catalog: {message}',
      stale: 'models.dev is unavailable; showing the cached catalog',
      updatedAt: 'Updated {time}',
      summary: '{providers} providers · {models} models',
      catalogEmpty: 'The catalog has no usable chat models.',
      searchProvider: 'Search providers (name or ID)',
      onlyReady: 'Only directly importable',
      noProviderMatch: 'No provider matches.',
      pickProvider: 'Pick a provider on the left, then choose the models to import.',
      added: 'Added',
      needsEndpoint: 'Needs endpoint',
      onlyCatalog: 'Installed catalog',
      models: 'models',
      docs: 'Docs',
      route: 'Provider ID',
      routeHint: 'Settings key and request route; lowercase letters, digits, dots, underscores and hyphens.',
      displayName: 'Display name',
      protocol: 'API protocol',
      protocolAuto: 'Use installed catalog',
      protocolHintCatalog: 'Leave empty to keep each installed model’s own protocol.',
      protocolHintCustom: 'This provider is not in pi-ai’s installed catalog; choose a protocol.',
      protocolHintMixed: 'Installed models keep their catalog protocol; models outside it need an explicit protocol.',
      baseURL: 'API base URL',
      baseURLHintCatalog: 'Leave empty to use the installed catalog’s default endpoint.',
      baseURLHintCustom: 'Required: this provider is not in pi-ai’s installed catalog.',
      baseURLHintMixed: 'Models outside the installed catalog need an endpoint; installed models can use the catalog endpoint.',
      apiKey: 'API key',
      apiKeyPlaceholder: 'Paste a key; leave empty to use the environment',
      apiKeyStored: 'Configured ({ref})',
      apiKeyMissing: 'Not configured ({ref})',
      apiKeyUnknown: 'Key status unavailable',
      apiKeyHint: 'The key is stored in the DSH credential store, never in the settings document.',
      nativeAuthHint: 'Leave empty to keep the provider’s native authentication (no apiKeyEnv is written).',
      modelsTitle: 'Models',
      searchModel: 'Search models (name or ID)',
      selectAll: 'Select all',
      clearAll: 'Clear',
      selectedCount: '{selected} / {total} selected',
      installedHint: '{count} selected models are not in pi-ai’s installed catalog; their full metadata will be written.',
      discovering: 'Reading pi-ai’s installed catalog…',
      discoverFailed: 'Could not read pi-ai’s installed catalog; the Host still validates the import.',
      showingFirst: 'Showing the first {shown} matches; refine the search to see more.',
      noModelMatch: 'No model matches.',
      context: 'Context',
      output: 'Output',
      reasoning: 'Reasoning',
      vision: 'Vision',
      import: 'Import into DSH',
      importing: 'Importing…',
      imported: 'Imported. Expand the provider row under Settings → Models to keep editing.',
      importedKeyFailed: 'The route was imported, but the API key could not be saved.',
      noSettings: 'The llm-pi-ai settings namespace is not available, so nothing can be imported.',
      readOnly: 'The settings document is read-only.',
      errRoute: 'Invalid Provider ID: use lowercase letters, digits, dots, underscores and hyphens, starting with a letter or digit.',
      errRouteExists: 'That Provider ID already exists; choose another.',
      errDisplayName: 'Display name is required.',
      errModels: 'Select at least one model.',
      errProtocol: 'This provider needs an explicit API protocol.',
      errBaseURL: 'This provider is not in pi-ai’s installed catalog, so the API base URL is required.',
      errBaseURLInvalid: 'The API base URL must be an http(s) URL.',
      errWrite: 'Could not write settings: {message}',
      errConflict: 'Settings moved on; they were re-read. Please retry.',
      errSettings: 'Could not read settings: {message}',
      errDirectory: 'Could not read the provider directory: {message}',
      unknownError: 'Unknown error',
    };

    /* ---------------------------------------------------------------- */
    /* 样式（只依赖 --dsw-alias-* 主题令牌；类名统一带 mdv- 前缀）          */
    /* ---------------------------------------------------------------- */

    const CSS = [
      '.mdv-root{display:flex;flex-direction:column;gap:12px;margin-top:20px;padding:16px;border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}',
      '.mdv-head{display:flex;align-items:flex-start;gap:12px}',
      '.mdv-mark{flex:none;display:flex;align-items:center;justify-content:center;width:34px;height:34px;border:.5px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary);font-size:17px;font-weight:600;line-height:1}',
      '.mdv-heading{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.mdv-title{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px}',
      '.mdv-sub{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.mdv-head-actions{margin-left:auto;display:flex;align-items:center;gap:8px;flex:none}',
      '.mdv-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;min-height:30px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;padding:3px 12px;cursor:pointer;white-space:nowrap;appearance:none;-webkit-appearance:none}',
      '.mdv-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.mdv-btn:active:not(:disabled){background:var(--dsw-alias-button-ghost-active-fill)}',
      '.mdv-btn:focus{outline:none}',
      '.mdv-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}',
      '.mdv-btn:disabled{opacity:.45;cursor:not-allowed}',
      '.mdv-btn--primary{border-color:var(--dsw-alias-border-l4);font-weight:500}',
      '.mdv-btn--small{min-height:24px;padding:1px 8px;font-size:11px;line-height:16px;border-radius:var(--dsw-radius-sm)}',
      '.mdv-meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}',
      '.mdv-badge{display:inline-flex;align-items:center;gap:3px;border-radius:999px;padding:0 6px;font-size:10px;line-height:16px;border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.mdv-badge--ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}',
      '.mdv-badge--warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}',
      '.mdv-badge--brand{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.mdv-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px}',
      '.mdv-input{box-sizing:border-box;width:100%;border:.5px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;padding:5px 8px}',
      '.mdv-input::placeholder{color:var(--dsw-alias-label-secondary);opacity:.8}',
      '.mdv-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
      '.mdv-grid{display:grid;grid-template-columns:minmax(220px,.85fr) minmax(0,1.4fr);gap:14px;align-items:start}',
      '@media (max-width:760px){.mdv-grid{grid-template-columns:minmax(0,1fr)}}',
      '.mdv-pane{display:flex;flex-direction:column;gap:8px;min-width:0}',
      '.mdv-list{display:flex;flex-direction:column;gap:2px;max-height:360px;overflow:auto;padding:2px;border:.5px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-base)}',
      '.mdv-provider{display:flex;flex-direction:column;align-items:flex-start;gap:1px;width:100%;box-sizing:border-box;border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;text-align:left;padding:6px 8px;cursor:pointer;appearance:none;-webkit-appearance:none}',
      '.mdv-provider:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.mdv-provider:focus{outline:none}',
      '.mdv-provider:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}',
      '.mdv-provider[aria-current="true"]{background:var(--dsw-alias-bg-layer-2);box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}',
      '.mdv-provider-name{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;font-weight:500;max-width:100%}',
      '.mdv-provider-name > span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mdv-provider-id{color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10px;line-height:14px;overflow-wrap:anywhere}',
      '.mdv-empty{display:flex;align-items:center;justify-content:center;min-height:120px;padding:16px;border:.5px dashed var(--dsw-alias-border-l2);border-radius:9px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;text-align:center}',
      '.mdv-detail{display:flex;flex-direction:column;gap:12px;min-width:0}',
      '.mdv-detail-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px}',
      '.mdv-detail-title{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:20px}',
      '.mdv-detail-id{color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:16px;overflow-wrap:anywhere}',
      '.mdv-detail-head a{color:var(--dsw-alias-brand-primary);font-size:11px;line-height:16px;text-decoration:none}',
      '.mdv-detail-head a:hover{text-decoration:underline}',
      '.mdv-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}',
      '@media (max-width:560px){.mdv-fields{grid-template-columns:minmax(0,1fr)}}',
      '.mdv-field{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.mdv-field--wide{grid-column:1/-1}',
      '.mdv-label{color:var(--dsw-alias-label-primary);font-size:11px;line-height:16px;font-weight:500}',
      '.mdv-hint{color:var(--dsw-alias-label-secondary);font-size:10px;line-height:15px}',
      '.mdv-hint--warn{color:var(--dsw-alias-state-warn-primary)}',
      '.mdv-hint--error{color:var(--dsw-alias-state-error-primary)}',
      '.mdv-hint--ok{color:var(--dsw-alias-state-success-primary)}',
      '.mdv-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere}',
      '.mdv-models-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px}',
      '.mdv-models-title{color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;font-weight:500}',
      '.mdv-count{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}',
      '.mdv-models{display:flex;flex-direction:column;gap:1px;max-height:280px;overflow:auto;padding:2px;border:.5px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-base)}',
      '.mdv-model{display:flex;align-items:flex-start;gap:8px;padding:5px 7px;border-radius:6px;cursor:pointer}',
      '.mdv-model:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.mdv-model input{margin-top:2px;accent-color:var(--dsw-alias-brand-primary);flex:none}',
      '.mdv-model-main{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}',
      '.mdv-model-name{color:var(--dsw-alias-label-primary);font-size:12px;line-height:17px;overflow-wrap:anywhere}',
      '.mdv-model-id{color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10px;line-height:14px;overflow-wrap:anywhere}',
      '.mdv-model-tags{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:3px;flex:none;max-width:45%}',
      '.mdv-tag{display:inline-flex;align-items:center;border-radius:5px;padding:0 5px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10px;line-height:15px;white-space:nowrap}',
      '.mdv-note{border-radius:7px;padding:6px 9px;font-size:11px;line-height:17px}',
      '.mdv-note--ok{border:.5px solid var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}',
      '.mdv-note--error{border:.5px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.mdv-note--warn{border:.5px solid var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}',
      '.mdv-footer{display:flex;flex-wrap:wrap;align-items:center;gap:10px}',
      '.mdv-footer .mdv-note{flex:1;min-width:0}',
      '.mdv-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}',
    ].join('');

    /* ---------------------------------------------------------------- */
    /* 纯函数（也供 scripts/verify-catalog.mjs 断言）                     */
    /* ---------------------------------------------------------------- */

    function isObject(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    function messageOf(error) {
      if (error instanceof Error && error.message !== '') return error.message;
      return String(error);
    }

    function formatNumber(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : '—';
    }

    function formatTokens(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '';
      if (value >= 1_000_000) {
        const millions = value / 1_000_000;
        return (Number.isInteger(millions) ? String(millions) : millions.toFixed(1)) + 'M';
      }
      if (value >= 1000) {
        const thousands = value / 1000;
        return (Number.isInteger(thousands) ? String(thousands) : thousands.toFixed(1)) + 'K';
      }
      return String(value);
    }

    function formatTime(timestamp) {
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) return '';
      try {
        return new Date(timestamp).toLocaleString();
      } catch {
        return '';
      }
    }

    /** 按 models.dev 的 npm 包推断 pi-ai 协议；推断不出时返回空串。 */
    function protocolFor(provider) {
      const npm = provider !== null && provider !== undefined && typeof provider.npm === 'string'
        ? provider.npm.toLowerCase()
        : '';
      if (npm === '') return '';
      if (npm.includes('anthropic')) return 'anthropic-messages';
      if (npm.includes('openai-compatible')) return 'openai-completions';
      if (npm.includes('openai') || npm.includes('azure')) return 'openai-completions';
      return '';
    }

    /**
     * 端点归一化。
     *
     * pi-ai 的 Anthropic Messages 适配器自己拼 `/v1/messages`，所以它的
     * `baseURL` 应当是 API 根（设置页的占位符也是 `https://gateway.example`）。
     * models.dev 却常把 Anthropic 兼容端点写成 `…/anthropic/v1`，直接照抄会
     * 变成 `…/v1/v1/messages`，这里去掉末尾的 `/v1`。OpenAI 协议保留 `/v1`。
     */
    function normalizeBaseURL(url, protocol) {
      if (typeof url !== 'string') return '';
      let next = url.trim().replace(/\/+$/, '');
      if (protocol === 'anthropic-messages') next = next.replace(/\/v1$/i, '');
      return next;
    }

    /** 默认路由 id：小写、非字母数字折成连字符，以字母或数字开头。 */
    function defaultRoute(provider) {
      const raw = provider !== null && provider !== undefined && typeof provider.id === 'string' ? provider.id : '';
      const cleaned = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '');
      return cleaned === '' ? 'provider' : cleaned;
    }

    /** 选一个尚未被设置文档占用的路由 id，避免覆盖已有供应商。 */
    function freeRoute(base, providers) {
      const taken = isObject(providers) ? providers : {};
      if (taken[base] === undefined) return base;
      for (let index = 2; index < 1000; index += 1) {
        const candidate = base + '-' + index;
        if (taken[candidate] === undefined) return candidate;
      }
      return base + '-' + Date.now().toString(36);
    }

    /**
     * 凭据引用：优先 models.dev 给出的环境变量名（通常是 `XXX_API_KEY`），
     * 否则由路由派生；两者都保持 POSIX 标识符形状。
     */
    function credentialRefFor(provider, route) {
      const env = provider !== null && provider !== undefined && Array.isArray(provider.env) ? provider.env : [];
      for (const name of env) {
        if (typeof name === 'string' && CREDENTIAL_PATTERN.test(name)) return name;
      }
      const stem = String(route === undefined || route === null ? '' : route)
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
      const raw = (stem === '' ? 'PROVIDER' : stem) + '_API_KEY';
      // 像 `302ai` 这样的路由派生出的引用不能以数字开头，补一个标识前缀。
      const ref = /^[A-Za-z_]/.test(raw) ? raw : 'P_' + raw;
      return CREDENTIAL_PATTERN.test(ref) ? ref : 'PROVIDER_API_KEY';
    }

    /** 从紧凑模型的 `efforts` 构造 pi-ai 的 `reasoningEfforts` 映射。 */
    function reasoningEffortsFor(model) {
      if (model === null || typeof model !== 'object' || !Array.isArray(model.efforts)) return undefined;
      const efforts = {};
      let thinking = 0;
      for (const level of model.efforts) {
        if (typeof level !== 'string') continue;
        if (level === 'off') {
          efforts.off = null;
          continue;
        }
        if (!['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(level)) continue;
        efforts[level] = level;
        thinking += 1;
      }
      return thinking > 0 ? efforts : undefined;
    }

    /**
     * 一条模型在 `providers.<route>.models` 里的表示。
     *
     * `known` 为真时只写 `id`：pi-ai 会从已安装目录继承协议、上下文和推理能力，
     * 我们不应该用 models.dev 的数值去覆盖它。未知模型才需要写全量字段。
     */
    function modelEntry(model, known) {
      const entry = { id: model.id };
      if (known === true) return entry;
      if (typeof model.name === 'string' && model.name !== '') entry.name = model.name;
      if (typeof model.context === 'number' && model.context > 0) entry.contextWindow = model.context;
      if (typeof model.maxTokens === 'number' && model.maxTokens > 0) entry.maxTokens = model.maxTokens;
      entry.input = model.image === true ? ['text', 'image'] : ['text'];
      const efforts = reasoningEffortsFor(model);
      if (efforts !== undefined) entry.reasoningEfforts = efforts;
      return entry;
    }

    function providerModelsById(provider) {
      const map = new Map();
      if (provider !== null && provider !== undefined && Array.isArray(provider.models)) {
        for (const model of provider.models) {
          if (isObject(model) && typeof model.id === 'string') map.set(model.id, model);
        }
      }
      return map;
    }

    /**
     * 校验编辑草稿；返回文案键或 null。
     *
     * @param {object} detail
     * @param {{providers?: object, writable?: boolean}} settings
     * @param {object} directory 以 provider id 为键的 pi-ai 目录条目
     */
    function validateDetail(detail, settings, directory) {
      if (detail === null || typeof detail !== 'object') return 'errModels';
      if (typeof detail.route !== 'string' || !ROUTE_PATTERN.test(detail.route)) return 'errRoute';
      const providers = isObject(settings) && isObject(settings.providers) ? settings.providers : {};
      if (Object.prototype.hasOwnProperty.call(providers, detail.route)) return 'errRouteExists';
      if (typeof detail.displayName !== 'string' || detail.displayName.trim() === '') return 'errDisplayName';
      if (!(detail.selected instanceof Set) || detail.selected.size === 0) return 'errModels';
      const entry = isObject(directory) ? directory[detail.providerId] : undefined;
      const catalogKnown = isObject(entry) && entry.declared !== true;
      const baseURL = typeof detail.baseURL === 'string' ? detail.baseURL.trim() : '';
      const unknownSelected = detail.installed instanceof Set
        ? [...detail.selected].some((id) => !detail.installed.has(id))
        : false;
      if (!catalogKnown || unknownSelected) {
        if (baseURL === '') return 'errBaseURL';
        if (!/^https?:\/\/\S+$/i.test(baseURL)) return 'errBaseURLInvalid';
      } else if (baseURL !== '' && !/^https?:\/\/\S+$/i.test(baseURL)) {
        return 'errBaseURLInvalid';
      }
      const protocol = typeof detail.protocol === 'string' ? detail.protocol : '';
      if ((!catalogKnown || unknownSelected) && protocol === '') return 'errProtocol';
      return null;
    }

    /** 构造写入设置文档的 provider profile。 */
    function buildProfile(detail, directory, options = {}) {
      const entry = isObject(directory) ? directory[detail.providerId] : undefined;
      const catalogKnown = isObject(entry) && entry.declared !== true;
      const provider = detail.provider;
      const models = [];
      const byId = providerModelsById(provider);
      for (const id of detail.selected) {
        const model = byId.get(id);
        if (model === undefined) continue;
        const known = catalogKnown && (!(detail.installed instanceof Set) || detail.installed.has(id));
        models.push(modelEntry(model, known));
      }
      const profile = {
        displayName: detail.displayName.trim(),
        models,
      };
      // 有密钥、没有原生认证，或该引用已配置时才写 apiKeyEnv；否则把认证留给
      // 供应商原生链（Bedrock / Vertex 这类不是「一个环境变量里的 bearer key」）。
      const hasKey = typeof detail.apiKey === 'string' && detail.apiKey.trim() !== '';
      const nativeAuth = isObject(entry) && isObject(entry.nativeAuth);
      if (hasKey || !nativeAuth || options.apiKeyConfigured === true) {
        profile.apiKeyEnv = credentialRefFor(provider, detail.route);
      }
      const baseURL = typeof detail.baseURL === 'string' ? detail.baseURL.trim() : '';
      if (baseURL !== '') profile.baseURL = baseURL;
      if (typeof detail.protocol === 'string' && detail.protocol !== '') profile.api = detail.protocol;
      return profile;
    }

    /** 供应商能否直接导入：目录已安装，或 models.dev 给了静态端点。 */
    function capabilityOf(provider, directory) {
      const entry = isObject(directory) ? directory[provider.id] : undefined;
      if (isObject(entry) && entry.declared !== true) return 'catalog';
      if (typeof provider.api === 'string' && provider.api !== '') return 'ready';
      return 'needs-endpoint';
    }

    function matchesQuery(text, query) {
      if (query === '') return true;
      return String(text).toLowerCase().includes(query.toLowerCase());
    }

    function envelopeError(response, fallback) {
      if (isObject(response) && response.ok === false) {
        const error = response.error;
        if (isObject(error)) {
          if (typeof error.message === 'string' && error.message !== '') return error.message;
          if (typeof error.code === 'string' && error.code !== '') return error.code;
        }
      }
      return fallback;
    }

    /* ---------------------------------------------------------------- */
    /* 组件                                                              */
    /* ---------------------------------------------------------------- */

    /**
     * 创建 Section 组件。`api` 由 apply 注入，组件只通过它访问宿主能力，
     * 这让浏览器半在没有 React 测试环境时也能被单独加载和断言。
     */
    function createSection(api) {
      const t = api.t;

      function fill(key, vars) {
        let text = String(t(key));
        if (!isObject(vars)) return text;
        for (const [name, value] of Object.entries(vars)) {
          text = text.split('{' + name + '}').join(String(value));
        }
        return text;
      }

      return function ModelsDevSection(props) {
        const [open, setOpen] = React.useState(false);
        const [catalog, setCatalog] = React.useState(null);
        const [meta, setMeta] = React.useState(null);
        const [load, setLoad] = React.useState({ phase: 'idle', error: null });
        const [query, setQuery] = React.useState('');
        const [onlyReady, setOnlyReady] = React.useState(false);
        const [settings, setSettings] = React.useState({
          phase: 'loading',
          writable: false,
          revision: 0,
          providers: {},
          error: null,
        });
        const [directory, setDirectory] = React.useState({});
        const [selectedId, setSelectedId] = React.useState(null);
        const [detail, setDetail] = React.useState(null);
        const [notice, setNotice] = React.useState(null);
        const [busy, setBusy] = React.useState(false);
        const [credential, setCredential] = React.useState({ phase: 'idle', ref: '' });

        const refreshSettings = React.useCallback(async () => {
          try {
            const response = await api.describeSettings();
            if (!isObject(response) || response.ok !== true) {
              setSettings({
                phase: 'error',
                writable: false,
                revision: 0,
                providers: {},
                error: envelopeError(response, t('unknownError')),
              });
              return;
            }
            const value = response.value;
            const namespaces = isObject(value) && Array.isArray(value.namespaces) ? value.namespaces : [];
            const ns = namespaces.find((entry) => isObject(entry) && entry.ns === SETTINGS_NS);
            if (ns === undefined) {
              setSettings({ phase: 'missing', writable: false, revision: 0, providers: {}, error: null });
              return;
            }
            const providers = isObject(ns.value) && isObject(ns.value.providers) ? ns.value.providers : {};
            setSettings({
              phase: 'ready',
              writable: isObject(value) ? value.writable !== false : true,
              revision: typeof ns.revision === 'number' ? ns.revision : 0,
              providers,
              error: null,
            });
          } catch (error) {
            setSettings({
              phase: 'error',
              writable: false,
              revision: 0,
              providers: {},
              error: messageOf(error),
            });
          }
        }, []);

        const refreshDirectory = React.useCallback(async () => {
          try {
            const response = await api.listProviders();
            if (!isObject(response) || response.ok !== true) return;
            const list = Array.isArray(response.value) ? response.value : [];
            const map = {};
            for (const entry of list) {
              if (isObject(entry) && typeof entry.provider === 'string') map[entry.provider] = entry;
            }
            setDirectory(map);
          } catch {
            /* 目录不可用不阻塞导入：手写 api/baseURL 仍然可行 */
          }
        }, []);

        React.useEffect(() => {
          refreshSettings();
          refreshDirectory();
        }, [refreshSettings, refreshDirectory]);

        React.useEffect(() => {
          if (typeof api.onAdaptersUpdated !== 'function') return undefined;
          const off = api.onAdaptersUpdated(() => {
            refreshSettings();
            refreshDirectory();
          });
          return typeof off === 'function' ? off : undefined;
        }, [refreshSettings, refreshDirectory]);

        const loadCatalog = React.useCallback(async (force) => {
          setLoad({ phase: 'loading', error: null });
          try {
            const data = await api.fetchCatalog(force === true);
            const providers = isObject(data) && Array.isArray(data.providers) ? data.providers : [];
            setCatalog(providers);
            setMeta({
              fetchedAt: isObject(data) && typeof data.fetchedAt === 'number' ? data.fetchedAt : 0,
              stale: isObject(data) && data.stale === true,
              source: isObject(data) && typeof data.source === 'string' ? data.source : '',
              providerCount: providers.length,
              modelCount: providers.reduce(
                (total, provider) => total + (Array.isArray(provider.models) ? provider.models.length : 0),
                0,
              ),
            });
            setLoad({ phase: 'ready', error: null });
          } catch (error) {
            setLoad({ phase: 'error', error: messageOf(error) });
          }
        }, []);

        React.useEffect(() => {
          if (open && load.phase === 'idle') loadCatalog(false);
        }, [open, load.phase, loadCatalog]);

        const providerById = React.useCallback(
          (id) => (Array.isArray(catalog) ? catalog.find((provider) => provider.id === id) : undefined),
          [catalog],
        );

        // 选中供应商时读一次凭据状态；路由变化会改写凭据引用，也要重读。
        React.useEffect(() => {
          if (detail === null) {
            setCredential({ phase: 'idle', ref: '' });
            return undefined;
          }
          const provider = providerById(detail.providerId);
          if (provider === undefined) {
            setCredential({ phase: 'idle', ref: '' });
            return undefined;
          }
          const ref = credentialRefFor(provider, detail.route);
          let alive = true;
          setCredential({ phase: 'loading', ref });
          api.describeCredential(ref).then(
            (response) => {
              if (!alive) return;
              if (isObject(response) && response.ok === true && isObject(response.value)) {
                const info = response.value[ref];
                setCredential({
                  phase: 'ready',
                  ref,
                  configured: isObject(info) ? info.configured === true : false,
                });
              } else {
                setCredential({ phase: 'error', ref });
              }
            },
            () => {
              if (alive) setCredential({ phase: 'error', ref });
            },
          );
          return () => {
            alive = false;
          };
        }, [api, detail === null ? '' : detail.providerId, detail === null ? '' : detail.route, providerById]);

        const selectProvider = React.useCallback(
          async (provider) => {
            const route = freeRoute(defaultRoute(provider), settings.providers);
            const entry = directory[provider.id];
            // 已安装目录里的供应商默认不覆盖协议，让每个模型使用目录自己的
            // 协议（OpenAI 目录就同时有 completions 与 responses 模型）。
            const catalogKnown = isObject(entry) && entry.declared !== true;
            const protocol = catalogKnown ? '' : protocolFor(provider);
            const fallbackURL = isObject(entry) && typeof entry.defaultBaseURL === 'string'
              ? entry.defaultBaseURL
              : '';
            const baseURL = normalizeBaseURL(
              typeof provider.api === 'string' && provider.api !== '' ? provider.api : fallbackURL,
              protocol,
            );
            const selected = new Set();
            if (Array.isArray(provider.models)) {
              for (const model of provider.models) {
                if (isObject(model) && typeof model.id === 'string') selected.add(model.id);
              }
            }
            setSelectedId(provider.id);
            setNotice(null);
            setDetail({
              providerId: provider.id,
              provider,
              route,
              displayName: provider.name,
              protocol,
              baseURL,
              apiKey: '',
              modelQuery: '',
              selected,
              installed: null,
              discovering: isObject(entry) && entry.declared !== true,
              discoveryError: null,
            });
            if (isObject(entry) && entry.declared !== true) {
              try {
                const response = await api.discoverModels(provider.id);
                if (isObject(response) && response.ok === true && Array.isArray(response.value)) {
                  const installed = new Set();
                  for (const model of response.value) {
                    if (isObject(model) && typeof model.id === 'string') installed.add(model.id);
                  }
                  setDetail((current) => (
                    current !== null && current.providerId === provider.id
                      ? { ...current, installed, discovering: false, discoveryError: null }
                      : current
                  ));
                } else {
                  setDetail((current) => (
                    current !== null && current.providerId === provider.id
                      ? { ...current, discovering: false, discoveryError: 'discoverFailed' }
                      : current
                  ));
                }
              } catch (error) {
                setDetail((current) => (
                  current !== null && current.providerId === provider.id
                    ? { ...current, discovering: false, discoveryError: messageOf(error) }
                    : current
                ));
              }
            }
          },
          [api, directory, settings.providers],
        );

        const patchDetail = React.useCallback((changes) => {
          setDetail((current) => (current === null ? current : { ...current, ...changes }));
          setNotice(null);
        }, []);

        const changeRoute = React.useCallback((route) => {
          patchDetail({ route: route.toLowerCase().replace(/[^a-z0-9._-]/g, '') });
        }, [patchDetail]);

        const changeProtocol = React.useCallback((protocol) => {
          setDetail((current) => {
            if (current === null) return current;
            const provider = current.provider;
            const entry = directory[current.providerId];
            const fallback = isObject(entry) && typeof entry.defaultBaseURL === 'string' ? entry.defaultBaseURL : '';
            const source = isObject(provider) && typeof provider.api === 'string' && provider.api !== ''
              ? provider.api
              : fallback;
            const previousDefault = normalizeBaseURL(source, current.protocol);
            const nextDefault = normalizeBaseURL(source, protocol);
            const keepManual = current.baseURL.trim() !== '' && current.baseURL !== previousDefault;
            return { ...current, protocol, baseURL: keepManual ? current.baseURL : nextDefault };
          });
          setNotice(null);
        }, [directory]);

        const toggleModel = React.useCallback((id) => {
          setDetail((current) => {
            if (current === null) return current;
            const selected = new Set(current.selected);
            if (selected.has(id)) selected.delete(id);
            else selected.add(id);
            return { ...current, selected };
          });
          setNotice(null);
        }, []);

        const selectAllModels = React.useCallback(() => {
          setDetail((current) => {
            if (current === null || !Array.isArray(current.provider.models)) return current;
            const selected = new Set();
            for (const model of current.provider.models) {
              if (isObject(model) && typeof model.id === 'string') selected.add(model.id);
            }
            return { ...current, selected };
          });
          setNotice(null);
        }, []);

        const clearModels = React.useCallback(() => {
          setDetail((current) => (current === null ? current : { ...current, selected: new Set() }));
          setNotice(null);
        }, []);

        const importProvider = React.useCallback(async () => {
          if (detail === null || busy) return;
          const problem = validateDetail(detail, settings, directory);
          if (problem !== null) {
            setNotice({ kind: 'error', text: fill(problem, {}) });
            return;
          }
          if (settings.phase !== 'ready' || settings.writable !== true) {
            setNotice({ kind: 'error', text: t('readOnly') });
            return;
          }
          setBusy(true);
          setNotice(null);
          try {
            const profile = buildProfile(detail, directory, {
              apiKeyConfigured: credential.phase === 'ready'
                && credential.ref === credentialRefFor(detail.provider, detail.route)
                && credential.configured === true,
            });
            const response = await api.mutateSettings(
              [{ op: 'set', path: ['providers', detail.route], value: profile }],
              settings.revision,
            );
            if (!isObject(response) || response.ok !== true) {
              const text = envelopeError(response, '');
              if (text.includes('conflict')) {
                setNotice({ kind: 'error', text: t('errConflict') });
                await refreshSettings();
              } else {
                setNotice({ kind: 'error', text: fill('errWrite', { message: text || t('unknownError') }) });
              }
              return;
            }
            const view = response.value;
            setSettings((current) => ({
              ...current,
              revision: isObject(view) && typeof view.revision === 'number' ? view.revision : current.revision,
              providers: isObject(view) && isObject(view.value) && isObject(view.value.providers)
                ? view.value.providers
                : { ...current.providers, [detail.route]: profile },
            }));
            let keyFailed = false;
            const key = detail.apiKey.trim();
            if (key !== '') {
              const provider = detail.provider;
              const ref = credentialRefFor(provider, detail.route);
              try {
                const stored = await api.setCredential(ref, key);
                keyFailed = !(isObject(stored) && stored.ok === true);
              } catch {
                keyFailed = true;
              }
            }
            setNotice({
              kind: 'ok',
              text: keyFailed ? t('imported') + ' ' + t('importedKeyFailed') : t('imported'),
            });
            setDetail(null);
            setSelectedId(null);
            await refreshSettings();
            await refreshDirectory();
          } catch (error) {
            setNotice({ kind: 'error', text: fill('errWrite', { message: messageOf(error) || t('unknownError') }) });
          } finally {
            setBusy(false);
          }
        }, [api, busy, credential, detail, directory, refreshDirectory, refreshSettings, settings]);

        /* ------------------------- 派生数据 ------------------------- */

        const providers = Array.isArray(catalog) ? catalog : [];
        const providerMap = React.useMemo(() => {
          const map = {};
          for (const provider of providers) {
            if (isObject(provider) && typeof provider.id === 'string') map[provider.id] = provider;
          }
          return map;
        }, [providers]);

        const configured = isObject(settings.providers) ? settings.providers : {};
        const visibleProviders = React.useMemo(() => {
          const needle = query.trim();
          return providers.filter((provider) => {
            if (!isObject(provider) || typeof provider.id !== 'string') return false;
            if (!matchesQuery(provider.name + ' ' + provider.id, needle)) return false;
            if (onlyReady) {
              if (configured[provider.id] !== undefined) return false;
              if (capabilityOf(provider, directory) !== 'ready' && capabilityOf(provider, directory) !== 'catalog') return false;
            }
            return true;
          });
        }, [providers, query, onlyReady, configured, directory]);

        const provider = detail === null ? undefined : providerMap[detail.providerId];
        const entry = detail === null ? undefined : directory[detail.providerId];
        const catalogKnown = isObject(entry) && entry.declared !== true;
        const modelById = detail === null ? new Map() : providerModelsById(detail.provider);
        const filteredModels = detail === null || !Array.isArray(detail.provider.models)
          ? []
          : detail.provider.models.filter((model) => (
            isObject(model)
            && typeof model.id === 'string'
            && matchesQuery((model.name || '') + ' ' + model.id, detail.modelQuery.trim())
          ));
        const shownModels = filteredModels.slice(0, MODEL_RENDER_LIMIT);
        const installedCount = detail !== null && detail.installed instanceof Set
          ? [...detail.selected].filter((id) => !detail.installed.has(id)).length
          : 0;
        const problem = detail === null ? null : validateDetail(detail, settings, directory);
        const envRef = detail === null || provider === undefined ? '' : credentialRefFor(provider, detail.route);
        const credentialKey = credential.ref === envRef ? credential : { phase: 'idle', ref: envRef };

        /* --------------------------- 渲染 --------------------------- */

        const header = h('div', { className: 'mdv-head' },
          h('div', { className: 'mdv-mark', 'aria-hidden': 'true' }, 'm'),
          h('div', { className: 'mdv-heading' },
            h('div', { className: 'mdv-title' }, t('title')),
            h('div', { className: 'mdv-sub' }, t('subtitle')),
          ),
          h('div', { className: 'mdv-head-actions' },
            open
              ? h('button', {
                type: 'button',
                className: 'mdv-btn mdv-btn--small',
                onClick: () => { setOpen(false); },
              }, t('collapse'))
              : h('button', {
                type: 'button',
                className: 'mdv-btn mdv-btn--primary',
                onClick: () => { setOpen(true); },
              }, t('browse')),
          ),
        );

        const metaLine = meta === null
          ? null
          : h('div', { className: 'mdv-meta' },
            h('span', null, fill('summary', {
              providers: formatNumber(meta.providerCount),
              models: formatNumber(meta.modelCount),
            })),
            meta.fetchedAt > 0 ? h('span', null, fill('updatedAt', { time: formatTime(meta.fetchedAt) })) : null,
            meta.stale ? h('span', { className: 'mdv-badge mdv-badge--warn' }, t('stale')) : null,
          );

        let body = null;
        if (open) {
          if (load.phase === 'loading') {
            body = h('div', { className: 'mdv-empty' }, t('loading'));
          } else if (load.phase === 'error') {
            body = h('div', { className: 'mdv-note mdv-note--error' },
              fill('loadFailed', { message: load.error || '' }),
              h('button', {
                type: 'button',
                className: 'mdv-btn mdv-btn--small',
                style: { marginLeft: '8px' },
                onClick: () => loadCatalog(true),
              }, t('retry')),
            );
          } else if (providers.length === 0) {
            body = h('div', { className: 'mdv-empty' }, t('catalogEmpty'));
          } else {
            const providerList = h('div', { className: 'mdv-pane' },
              h('div', { className: 'mdv-toolbar' },
                h('input', {
                  className: 'mdv-input',
                  style: { flex: '1 1 160px', width: 'auto' },
                  type: 'search',
                  value: query,
                  placeholder: t('searchProvider'),
                  'aria-label': t('searchProvider'),
                  onChange: (event) => setQuery(event.target.value),
                }),
                h('button', {
                  type: 'button',
                  className: 'mdv-btn mdv-btn--small',
                  onClick: () => loadCatalog(true),
                }, t('refresh')),
              ),
              h('label', { className: 'mdv-hint', style: { display: 'flex', alignItems: 'center', gap: '6px' } },
                h('input', {
                  type: 'checkbox',
                  checked: onlyReady,
                  onChange: (event) => setOnlyReady(event.target.checked),
                }),
                t('onlyReady'),
              ),
              h('div', { className: 'mdv-list' },
                visibleProviders.length === 0
                  ? h('div', { className: 'mdv-empty' }, t('noProviderMatch'))
                  : visibleProviders.map((item) => {
                    const isConfigured = configured[item.id] !== undefined;
                    const capability = capabilityOf(item, directory);
                    return h('button', {
                      key: item.id,
                      type: 'button',
                      className: 'mdv-provider',
                      'aria-current': selectedId === item.id ? 'true' : 'false',
                      onClick: () => { selectProvider(item); },
                    },
                    h('span', { className: 'mdv-provider-name' },
                      h('span', null, item.name),
                      isConfigured ? h('span', { className: 'mdv-badge mdv-badge--ok' }, t('added')) : null,
                      capability === 'needs-endpoint' ? h('span', { className: 'mdv-badge mdv-badge--warn' }, t('needsEndpoint')) : null,
                    ),
                    h('span', { className: 'mdv-provider-id' }, item.id + ' · ' + formatNumber(item.models.length) + ' ' + t('models')),
                    );
                  }),
              ),
            );

            let detailPane = null;
            if (detail === null || provider === undefined) {
              detailPane = h('div', { className: 'mdv-empty' }, t('pickProvider'));
            } else {
              const routeExists = configured[detail.route] !== undefined;
              const fields = h('div', { className: 'mdv-fields' },
                h('label', { className: 'mdv-field' },
                  h('span', { className: 'mdv-label' }, t('route')),
                  h('input', {
                    className: 'mdv-input mdv-mono',
                    type: 'text',
                    value: detail.route,
                    spellCheck: false,
                    onChange: (event) => changeRoute(event.target.value),
                  }),
                  h('span', { className: routeExists ? 'mdv-hint mdv-hint--error' : 'mdv-hint' },
                    routeExists ? t('errRouteExists') : t('routeHint')),
                ),
                h('label', { className: 'mdv-field' },
                  h('span', { className: 'mdv-label' }, t('displayName')),
                  h('input', {
                    className: 'mdv-input',
                    type: 'text',
                    value: detail.displayName,
                    onChange: (event) => patchDetail({ displayName: event.target.value }),
                  }),
                ),
                h('label', { className: 'mdv-field' },
                  h('span', { className: 'mdv-label' }, t('protocol')),
                  h('select', {
                    className: 'mdv-input',
                    value: detail.protocol,
                    onChange: (event) => changeProtocol(event.target.value),
                  },
                  catalogKnown ? h('option', { value: '' }, t('protocolAuto')) : null,
                  PROTOCOLS.map((value) => h('option', { key: value, value }, value)),
                  ),
                  h('span', { className: 'mdv-hint' },
                    catalogKnown
                      ? (installedCount > 0 ? t('protocolHintMixed') : t('protocolHintCatalog'))
                      : t('protocolHintCustom'),
                  ),
                ),
                h('label', { className: 'mdv-field' },
                  h('span', { className: 'mdv-label' }, t('baseURL')),
                  h('input', {
                    className: 'mdv-input mdv-mono',
                    type: 'text',
                    value: detail.baseURL,
                    spellCheck: false,
                    placeholder: (typeof provider.api === 'string' && provider.api) || (isObject(entry) && entry.defaultBaseURL) || 'https://…/v1',
                    onChange: (event) => patchDetail({ baseURL: event.target.value }),
                  }),
                  h('span', { className: 'mdv-hint' },
                    catalogKnown
                      ? (installedCount > 0 ? t('baseURLHintMixed') : t('baseURLHintCatalog'))
                      : t('baseURLHintCustom'),
                  ),
                ),
                h('label', { className: 'mdv-field mdv-field--wide' },
                  h('span', { className: 'mdv-label' }, t('apiKey')),
                  h('input', {
                    className: 'mdv-input mdv-mono',
                    type: 'password',
                    autoComplete: 'new-password',
                    value: detail.apiKey,
                    placeholder: t('apiKeyPlaceholder'),
                    onChange: (event) => patchDetail({ apiKey: event.target.value }),
                  }),
                  h('span', { className: 'mdv-hint' },
                    h('span', { className: 'mdv-mono' }, envRef),
                    ' · ',
                    credentialKey.phase === 'ready'
                      ? (credentialKey.configured
                        ? h('span', { className: 'mdv-hint--ok' }, fill('apiKeyStored', { ref: envRef }))
                        : h('span', null, fill('apiKeyMissing', { ref: envRef })))
                      : credentialKey.phase === 'error'
                        ? h('span', { className: 'mdv-hint--warn' }, t('apiKeyUnknown'))
                        : h('span', null, isObject(entry) && isObject(entry.nativeAuth)
                          ? t('nativeAuthHint')
                          : t('apiKeyHint')),
                  ),
                ),
              );

              const modelHead = h('div', { className: 'mdv-models-head' },
                h('span', { className: 'mdv-models-title' }, t('modelsTitle')),
                h('span', { className: 'mdv-count' }, fill('selectedCount', {
                  selected: formatNumber(detail.selected.size),
                  total: formatNumber(modelById.size),
                })),
                h('span', { className: 'mdv-spacer', style: { flex: '1' } }),
                h('button', {
                  type: 'button',
                  className: 'mdv-btn mdv-btn--small',
                  onClick: selectAllModels,
                }, t('selectAll')),
                h('button', {
                  type: 'button',
                  className: 'mdv-btn mdv-btn--small',
                  onClick: clearModels,
                }, t('clearAll')),
              );

              const modelSearch = h('input', {
                className: 'mdv-input',
                type: 'search',
                value: detail.modelQuery,
                placeholder: t('searchModel'),
                'aria-label': t('searchModel'),
                onChange: (event) => patchDetail({ modelQuery: event.target.value }),
              });

              const discoveryHint = detail.discovering
                ? h('span', { className: 'mdv-hint' }, t('discovering'))
                : detail.discoveryError !== null && detail.discoveryError !== undefined
                  ? h('span', { className: 'mdv-hint mdv-hint--warn' }, t('discoverFailed'))
                  : installedCount > 0
                    ? h('span', { className: 'mdv-hint mdv-hint--warn' }, fill('installedHint', { count: installedCount }))
                    : null;

              const modelList = h('div', { className: 'mdv-models' },
                shownModels.length === 0
                  ? h('div', { className: 'mdv-empty' }, t('noModelMatch'))
                  : shownModels.map((model) => h('label', { key: model.id, className: 'mdv-model' },
                    h('input', {
                      type: 'checkbox',
                      checked: detail.selected.has(model.id),
                      onChange: () => toggleModel(model.id),
                    }),
                    h('span', { className: 'mdv-model-main' },
                      h('span', { className: 'mdv-model-name' }, model.name || model.id),
                      model.name ? h('span', { className: 'mdv-model-id' }, model.id) : null,
                    ),
                    h('span', { className: 'mdv-model-tags' },
                      model.context ? h('span', { className: 'mdv-tag' }, t('context') + ' ' + formatTokens(model.context)) : null,
                      model.maxTokens ? h('span', { className: 'mdv-tag' }, t('output') + ' ' + formatTokens(model.maxTokens)) : null,
                      model.reasoning ? h('span', { className: 'mdv-tag' }, t('reasoning')) : null,
                      model.image ? h('span', { className: 'mdv-tag' }, t('vision')) : null,
                    ),
                  )),
              );

              detailPane = h('div', { className: 'mdv-detail' },
                h('div', { className: 'mdv-detail-head' },
                  h('span', { className: 'mdv-detail-title' }, provider.name),
                  h('span', { className: 'mdv-detail-id' }, provider.id),
                  typeof provider.doc === 'string' && provider.doc !== ''
                    ? h('a', { href: provider.doc, target: '_blank', rel: 'noreferrer noopener' }, t('docs'))
                    : null,
                ),
                fields,
                h('div', { className: 'mdv-field' },
                  modelHead,
                  h('div', { className: 'mdv-toolbar' }, modelSearch),
                  discoveryHint,
                ),
                modelList,
                filteredModels.length > shownModels.length
                  ? h('span', { className: 'mdv-hint' }, fill('showingFirst', { shown: formatNumber(shownModels.length) }))
                  : null,
                h('div', { className: 'mdv-footer' },
                  h('button', {
                    type: 'button',
                    className: 'mdv-btn mdv-btn--primary',
                    disabled: busy || problem !== null || settings.writable !== true,
                    onClick: importProvider,
                  }, busy ? t('importing') : t('import')),
                  problem !== null
                    ? h('span', { className: 'mdv-hint mdv-hint--warn' }, fill(problem, {}))
                    : null,
                ),
              );
            }

            body = h('div', { className: 'mdv-grid' }, providerList, detailPane);
          }

          if (notice !== null) {
            body = h(React.Fragment, null,
              h('div', { className: 'mdv-note mdv-note--' + notice.kind, role: 'status' }, notice.text),
              body,
            );
          }
        }

        return h('section', { className: 'mdv-root', 'aria-label': t('title') },
          header,
          load.phase === 'ready' && meta !== null ? metaLine : null,
          settings.phase === 'missing'
            ? h('div', { className: 'mdv-note mdv-note--error' }, t('noSettings'))
            : settings.phase === 'error'
              ? h('div', { className: 'mdv-note mdv-note--error' }, fill('errSettings', { message: settings.error || '' }))
              : settings.writable === false && settings.phase === 'ready'
                ? h('div', { className: 'mdv-note mdv-note--warn' }, t('readOnly'))
                : null,
          body,
        );
      };
    }

    /* ---------------------------------------------------------------- */
    /* 插件                                                              */
    /* ---------------------------------------------------------------- */

    /** 硬依赖：席位、文案、Remote 代理与 settings 命名空间。 */
    const inject = ['slots', 'locale', 'remote', 'remote.settings'];

    function apply(ctx) {
      // 样式：只在 apply 内插入，卸载时移除。
      ctx.effect(() => {
        const tagId = 'dsh-plugin-modelsdev/styles.css';
        if (typeof document === 'undefined') return () => {};
        if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') !== null) return () => {};
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-plugin-modelsdev';
        tag.dataset.pluginCss = tagId;
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => { tag.remove(); };
      }, 'modelsdev: styles');

      // 文案：走 Client locale 服务，界面文字不写死在组件里。
      let t = (key) => (zh[key] === undefined ? key : zh[key]);
      try {
        ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'modelsdev: locale');
        const bound = ctx.locale.bind(LOCALE_NS);
        if (typeof bound === 'function') t = bound;
      } catch (error) {
        console.error('[modelsdev] locale unavailable, falling back to built-in copy', error);
      }

      const api = {
        t,
        fetchCatalog: async (force) => {
          const url = CATALOG_PATH + (force ? '?refresh=1' : '');
          const response = await fetch(url, {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          });
          if (!response.ok) throw new Error('catalog ' + response.status);
          const data = await response.json();
          return {
            ...(isObject(data) ? data : {}),
            stale: response.headers.get('x-modelsdev-stale') === '1',
            fetchedAt: Number(response.headers.get('x-modelsdev-fetched-at')) || (isObject(data) ? data.fetchedAt : 0),
          };
        },
        describeSettings: () => ctx.remote.settings.describe(),
        mutateSettings: (ops, revision) => ctx.remote.settings.mutate(SETTINGS_NS, ops, revision),
        listProviders: () => {
          try {
            const llm = isObject(ctx.remote) ? ctx.remote.llm : undefined;
            if (llm === undefined || llm === null || typeof llm.listConfigurableProviders !== 'function') {
              return Promise.resolve({ ok: true, value: [] });
            }
            return llm.listConfigurableProviders();
          } catch {
            return Promise.resolve({ ok: true, value: [] });
          }
        },
        discoverModels: (provider) => {
          try {
            const llm = isObject(ctx.remote) ? ctx.remote.llm : undefined;
            if (llm === undefined || llm === null || typeof llm.discoverModels !== 'function') return Promise.resolve(undefined);
            return llm.discoverModels(SETTINGS_NS, { provider });
          } catch {
            return Promise.resolve(undefined);
          }
        },
        describeCredential: (ref) => {
          try {
            const credentials = isObject(ctx.remote) ? ctx.remote.credentials : undefined;
            if (credentials === undefined || credentials === null || typeof credentials.describe !== 'function') {
              return Promise.resolve(undefined);
            }
            return credentials.describe([ref]);
          } catch {
            return Promise.resolve(undefined);
          }
        },
        setCredential: (ref, value) => {
          try {
            const credentials = isObject(ctx.remote) ? ctx.remote.credentials : undefined;
            if (credentials === undefined || credentials === null || typeof credentials.set !== 'function') {
              return Promise.resolve(undefined);
            }
            return credentials.set(ref, value);
          } catch {
            return Promise.resolve(undefined);
          }
        },
        onAdaptersUpdated: (handler) => {
          if (typeof ctx.remote.$on !== 'function') return () => {};
          try {
            return ctx.remote.$on('llm/adapters-updated', handler);
          } catch {
            return () => {};
          }
        },
      };

      const Section = createSection(api);

      ctx.slots.inject(SLOT_KEY, () => {
        const dispose = ctx.slots.register({ name: SLOT_KEY, id: 'modelsdev-catalog', order: 30 }, Section);
        return () => {
          if (typeof dispose === 'function') dispose();
        };
      });
    }

    /*
     * 测试接缝：把纯映射函数暴露给 scripts/verify-catalog.mjs。Cordis 只读
     * `inject` / `apply` / `name` / `Config`，多余导出会被忽略。
     */
    const internals = {
      protocolFor,
      normalizeBaseURL,
      defaultRoute,
      freeRoute,
      credentialRefFor,
      reasoningEffortsFor,
      modelEntry,
      buildProfile,
      validateDetail,
      capabilityOf,
      matchesQuery,
      formatTokens,
      createSection,
      CSS,
    };

    return { inject, apply, __internals: internals };
  },
});
