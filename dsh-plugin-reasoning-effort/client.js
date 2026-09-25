/**
 * 「按模型设置推理强度」——浏览器侧。
 *
 * 背景：DSH 的模型选择器只提供「适配器已公布」的推理等级，而
 * `dsh-client-ui-settings-models` 明确不做供应商级的强度控件：强度是**每个模型**
 * 的能力，同一个供应商下的模型可以各自不同。对于 pi-ai 装目录里没有的自定义
 * （手工声明的）路由，适配器拿不到任何推理元数据，于是模型选择器里连 Effort
 * 一行都不会出现，也「不存在任意推理强度输入」。
 *
 * 但配置层早就支持了：`@deepseek-ai/dsh-llm-pi-ai` 允许每个模型声明
 * `providers.<route>.models[].reasoningEfforts`，其中每个键是选择器提供的等级，
 * 值是该等级在网线上的拼写。本插件补上的正是这块缺失的编辑界面：
 *
 *   - 注册进官方为仓库外插件预留的席位 `settings.models.provider-card`
 *     （keyed，键为该行所属设置命名空间的 `settingsNs`）；
 *   - 只读地读 `remote.settings.describe()`，写只用
 *     `remote.settings.mutate(ns, ops, revision)`；
 *   - 写入粒度是**整个 models 数组**：设置文档的路径编辑只遍历普通对象
 *     （`isPlainObject` 为假的数组不会被下钻），逐元素写路径会把数组打散成
 *     `{ "0": … }`，所以必须整段回写，其它字段原样保留。
 *
 * 工厂必须是「无副作用」的：样式、监听、注册一律在 apply 内建立并用
 * ctx.effect / slots.inject 的清理函数收尾。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-reasoning-effort',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** 文案命名空间；与包名分开，避免和宿主命名空间撞车。 */
    const LOCALE_NS = 'plugin.reasoning-effort';
    /** 目标席位：每张「展示目录行」的供应商卡片内部的适配器扩展区。 */
    const SLOT_KEY = 'settings.models.provider-card';

    /* ---------------------------------------------------------------- */
    /* 与 pi-ai 对齐的常量                                                */
    /* ---------------------------------------------------------------- */

    /** pi-ai 认识的全部思考等级，顺序即选择器顺序。 */
    const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    /** `off` 之外的等级：宿主要求至少声明其中一个，否则整个条目被判非法。 */
    const THINKING_LEVELS = LEVELS.filter((level) => level !== 'off');
    /** 唯一由 `compat` 决定「是否发送推理参数」的协议。 */
    const COMPLETIONS_API = 'openai-completions';

    /* ---------------------------------------------------------------- */
    /* 文案                                                              */
    /* ---------------------------------------------------------------- */

    const zh = {
      title: '推理强度（按模型）',
      hint: '等级是选择器提供项，值是该等级在网线上的拼写。留空的等级视为不支持。',
      modeInherit: '继承',
      modeOff: '不推理',
      modeCustom: '自定义',
      modeInheritHint: '保留已安装目录对该模型的推理能力',
      modeOffHint: '声明为非推理模型（reasoningEfforts: false）',
      modeCustomHint: '逐等级声明网线拼写',
      expand: '展开',
      collapse: '收起',
      level_off: '关闭思考',
      level_minimal: '最低',
      level_low: '低',
      level_medium: '中',
      level_high: '高',
      level_xhigh: '极高',
      level_max: '最高',
      placeholderOff: '留空 = 不发送该参数',
      placeholderWire: '如 {level}',
      fillSame: '同名填充',
      clear: '清空',
      save: '保存',
      saving: '保存中…',
      reset: '重置',
      saved: '已保存',
      levels: '等级 → 网线拼写',
      compat: 'compat.supportsReasoningEffort',
      compatHint: '网关协议无法被自动识别时，显式声明它会发送推理参数',
      apiIs: '协议：{api}',
      apiUnknown: '协议未知',
      errLoad: '读取设置失败',
      errWrite: '写入设置失败',
      errNoApi: '缺少可用的远程设置接口，推理强度插件不生效。',
      errNeedThinking: '自定义模式至少要有一个「思考」等级（如 low / high）。只想要关闭思考，请选「不推理」。',
      readOnly: '当前设置文档只读。',
      restartRequired: '这项改动需要重启 Harness 后生效。',
      conflict: '设置已被其他改动推进，已重新读取，请重试。',
      noModels: '该供应商还没有模型。',
    };

    const en = {
      title: 'Reasoning effort (per model)',
      hint: 'A level is what the picker offers; its value is the spelling sent on the wire. A blank level counts as unsupported.',
      modeInherit: 'Inherit',
      modeOff: 'No reasoning',
      modeCustom: 'Custom',
      modeInheritHint: 'Keep the installed catalog capability for this model',
      modeOffHint: 'Declare a non-reasoning model (reasoningEfforts: false)',
      modeCustomHint: 'Declare the wire spelling per level',
      expand: 'Expand',
      collapse: 'Collapse',
      level_off: 'off',
      level_minimal: 'minimal',
      level_low: 'low',
      level_medium: 'medium',
      level_high: 'high',
      level_xhigh: 'xhigh',
      level_max: 'max',
      placeholderOff: 'blank = send nothing',
      placeholderWire: 'e.g. {level}',
      fillSame: 'Fill with level names',
      clear: 'Clear',
      save: 'Save',
      saving: 'Saving…',
      reset: 'Reset',
      saved: 'Saved',
      levels: 'Level → wire spelling',
      compat: 'compat.supportsReasoningEffort',
      compatHint: 'Declare it explicitly when the gateway protocol cannot be detected',
      apiIs: 'Protocol: {api}',
      apiUnknown: 'Protocol unknown',
      errLoad: 'Could not read settings',
      errWrite: 'Could not write settings',
      errNoApi: 'The remote settings API is unavailable, so this plugin stays inert.',
      errNeedThinking: 'Custom mode needs at least one thinking level (such as low or high). To only disable thinking, choose “No reasoning”.',
      readOnly: 'The settings document is read-only.',
      restartRequired: 'This change applies after restarting Harness.',
      conflict: 'Settings moved on; they were re-read, please retry.',
      noModels: 'This provider has no models yet.',
    };

    /* ---------------------------------------------------------------- */
    /* 样式（只依赖 --dsw-alias-* 主题令牌；类名统一带 pre- 前缀）           */
    /* ---------------------------------------------------------------- */

    const CSS = [
      '.pre-root{display:flex;flex-direction:column;gap:8px;margin-top:4px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l1)}',
      '.pre-head{display:flex;flex-direction:column;gap:2px}',
      '.pre-title{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px}',
      '.pre-hint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.pre-model{display:flex;flex-direction:column;gap:8px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}',
      '.pre-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}',
      '.pre-id{color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;word-break:break-all}',
      '.pre-seg{display:inline-flex;overflow:hidden;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px}',
      '.pre-seg>button{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;padding:2px 8px;cursor:pointer}',
      '.pre-seg>button[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.pre-spacer{flex:1}',
      '.pre-compat{display:inline-flex;align-items:center;gap:8px;margin-left:4px}',
      '.pre-btn{border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;padding:3px 10px;cursor:pointer}',
      /*
       * 主按钮用「品牌色描边 + 品牌色文字」，**不填色**。
       *
       * 原先是 `background:var(--dsw-alias-brand-primary); color:#fff`。问题是
       * 主题里**没有**「与 brand 对照的前景色」令牌（Theme.listTokens 只有
       * bg/border/brand/label/state 这几族），而 brand-primary 在暗色主题下本身
       * 就是浅色——白字压上去直接看不见。
       *
       * 描边式则完全不依赖任何对照假设：brand-primary 是设计来在 bg-base /
       * bg-layer-1 上可见的强调色，所以"品牌色文字 + 品牌色描边"落在页面自身的
       * 背景上，明暗两套主题都成立。
       */
      '.pre-btn[data-primary="true"]{border-color:var(--dsw-alias-brand-primary);background:transparent;color:var(--dsw-alias-brand-primary)}',
      '.pre-btn[data-primary="true"]:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}',
      '.pre-btn:disabled{cursor:default;opacity:.5}',
      '.pre-levels{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:6px 12px;padding-top:2px}',
      '.pre-level{display:flex;align-items:center;gap:8px}',
      '.pre-level>span{flex:0 0 66px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.pre-input{flex:1;min-width:0;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;padding:3px 6px}',
      '.pre-input:focus-visible{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:-1px}',
      '.pre-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}',
      '.pre-note{color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:18px}',
      '.pre-warn{color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:18px}',
    ].join('');

    /* ---------------------------------------------------------------- */
    /* 纯工具                                                            */
    /* ---------------------------------------------------------------- */

    function isPlainObject(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    /** 按段取路径；数组与普通对象都能下钻，取不到返回 undefined。 */
    function getPath(root, path) {
      let node = root;
      for (const segment of path) {
        if (!isPlainObject(node) && !Array.isArray(node)) return undefined;
        node = node[segment];
        if (node === undefined) return undefined;
      }
      return node;
    }

    function cloneJson(value) {
      return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    }

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error);
    }

    /** 已存值的编辑模式：inherit / off / custom。 */
    function storedMode(model) {
      const efforts = model.reasoningEfforts;
      if (efforts === false) return 'off';
      if (isPlainObject(efforts)) return 'custom';
      return 'inherit';
    }

    /** 已存值的 compat 三态：inherit / on / off。 */
    function storedSupport(model) {
      const compat = isPlainObject(model.compat) ? model.compat : undefined;
      if (compat !== undefined && typeof compat.supportsReasoningEffort === 'boolean') {
        return compat.supportsReasoningEffort ? 'on' : 'off';
      }
      return 'inherit';
    }

    function draftOf(model) {
      const efforts = isPlainObject(model.reasoningEfforts) ? model.reasoningEfforts : undefined;
      const levels = {};
      for (const level of LEVELS) {
        const wire = efforts === undefined ? undefined : efforts[level];
        levels[level] = typeof wire === 'string' ? wire : '';
      }
      return { mode: storedMode(model), levels, support: storedSupport(model) };
    }

    /**
     * 把草稿编成 `reasoningEfforts`，并复述宿主的两条硬规则：
     * 非 off 的等级必须有非空拼写；至少声明一个思考等级。
     * @returns {{ efforts: object } | { errorKey: string }}
     */
    function buildEfforts(draft) {
      const efforts = {};
      for (const level of LEVELS) {
        const wire = String(draft.levels[level] === undefined ? '' : draft.levels[level]).trim();
        if (level === 'off') {
          // 留空写成 null：宿主把它读成「支持关闭思考，但不发送任何参数」；
          // 空字符串会被宿主判为非法（"must not be an empty string"）。
          efforts.off = wire === '' ? null : wire;
          continue;
        }
        // 留空 = 不提供该等级。宿主会把未声明的等级钉成 null（不支持），
        // 这正是「供应商不接受某等级」的表达方式。
        if (wire === '') continue;
        efforts[level] = wire;
      }
      const declared = THINKING_LEVELS.some((level) => typeof efforts[level] === 'string');
      if (!declared) return { errorKey: 'errNeedThinking' };
      return { efforts };
    }

    /**
     * 把一份草稿套用到模型条目上（不改动原对象）。
     * @returns {{ model: object } | { errorKey: string }}
     */
    function applyDraft(model, draft) {
      const next = cloneJson(model);
      if (draft.mode === 'inherit') {
        // 省略字段 = 保留已安装目录的能力。
        delete next.reasoningEfforts;
      } else if (draft.mode === 'off') {
        next.reasoningEfforts = false;
      } else {
        const built = buildEfforts(draft);
        if (built.errorKey !== undefined) return { errorKey: built.errorKey };
        next.reasoningEfforts = built.efforts;
      }
      const compat = isPlainObject(next.compat) ? { ...next.compat } : {};
      if (draft.support === 'inherit') delete compat.supportsReasoningEffort;
      else compat.supportsReasoningEffort = draft.support === 'on';
      if (Object.keys(compat).length === 0) delete next.compat;
      else next.compat = compat;
      return { model: next };
    }

    /* ---------------------------------------------------------------- */
    /* 卡片组件                                                          */
    /* ---------------------------------------------------------------- */

    function ReasoningEffortCard(props) {
      const api = props === null || props === undefined ? undefined : props.reasoningApi;
      const provider = props === null || props === undefined ? undefined : props.provider;
      const t = api === undefined ? (key) => key : api.t;

      const ns = provider !== undefined && typeof provider.settingsNs === 'string' ? provider.settingsNs : '';
      const route = provider !== undefined && typeof provider.provider === 'string' ? provider.provider : '';
      const pathKey = provider !== undefined && Array.isArray(provider.settingsPath)
        ? provider.settingsPath.filter((segment) => typeof segment === 'string').join('\u0000')
        : '';
      const settingsPath = React.useMemo(
        () => (pathKey === '' ? [] : pathKey.split('\u0000')),
        [pathKey],
      );

      const [state, setState] = React.useState({
        status: 'loading',
        error: null,
        readOnly: false,
        restart: false,
        revision: 0,
        models: [],
        api: undefined,
      });
      const [drafts, setDrafts] = React.useState({});
      const [openIndex, setOpenIndex] = React.useState(-1);
      const [busyIndex, setBusyIndex] = React.useState(-1);
      const [note, setNote] = React.useState(null);

      const load = React.useCallback(async () => {
        if (api === undefined || ns === '') {
          setState((s) => ({ ...s, status: 'inert' }));
          return;
        }
        setState((s) => ({ ...s, status: 'loading', error: null }));
        let response;
        try {
          response = await api.describe();
        } catch (error) {
          setState((s) => ({ ...s, status: 'error', error: messageOf(error) }));
          return;
        }
        if (response === undefined || response === null || response.ok !== true) {
          const detail = response !== undefined && response !== null && response.error !== undefined ? response.error.message : '';
          setState((s) => ({ ...s, status: 'error', error: detail }));
          return;
        }
        const view = response.value;
        const found = view !== undefined && view !== null && Array.isArray(view.namespaces)
          ? view.namespaces.find((entry) => entry !== null && entry !== undefined && entry.ns === ns)
          : undefined;
        if (found === undefined) {
          setState((s) => ({ ...s, status: 'unavailable' }));
          return;
        }
        // 优先用用户层的原始数组：把解析后的值整段回写会把 schema 默认值
        // 一并固化到用户层。用户层没有 models 时才退回解析值。
        const resolved = getPath(found.value, settingsPath);
        const user = getPath(found.user, settingsPath);
        const profile = isPlainObject(user) && Array.isArray(user.models)
          ? user
          : (isPlainObject(resolved) ? resolved : {});
        const models = Array.isArray(profile.models)
          ? profile.models.filter((model) => isPlainObject(model))
          : [];
        if (models.length === 0) {
          setState((s) => ({ ...s, status: 'empty', models: [] }));
          return;
        }
        const nextDrafts = {};
        for (let index = 0; index < models.length; index += 1) nextDrafts[index] = draftOf(models[index]);
        setDrafts(nextDrafts);
        setOpenIndex(-1);
        setState({
          status: 'ready',
          error: null,
          readOnly: view.writable === false,
          restart: found.applies === 'restart',
          revision: typeof found.revision === 'number' ? found.revision : 0,
          models,
          api: isPlainObject(profile) && typeof profile.api === 'string' ? profile.api : undefined,
        });
      }, [api, ns, settingsPath]);

      React.useEffect(() => {
        load();
      }, [load]);

      const patchDraft = React.useCallback((index, changes) => {
        setDrafts((current) => {
          const draft = current[index];
          if (draft === undefined) return current;
          return { ...current, [index]: { ...draft, ...changes } };
        });
        setNote(null);
      }, []);

      const patchLevel = React.useCallback((index, level, value) => {
        setDrafts((current) => {
          const draft = current[index];
          if (draft === undefined) return current;
          return {
            ...current,
            [index]: { ...draft, levels: { ...draft.levels, [level]: value } },
          };
        });
        setNote(null);
      }, []);

      const save = React.useCallback(async (index) => {
        const draft = drafts[index];
        const model = state.models[index];
        if (draft === undefined || model === undefined || api === undefined) return;
        const applied = applyDraft(model, draft);
        if (applied.errorKey !== undefined) {
          setState((s) => ({ ...s, error: t(applied.errorKey) }));
          return;
        }
        const nextModels = state.models.map((item, at) => (at === index ? applied.model : item));
        setBusyIndex(index);
        setNote(null);
        let response;
        try {
          // 整段回写 models：设置文档的路径编辑只下钻普通对象，
          // 逐元素写 ['models','0',…] 会把数组打散成对象键。
          response = await api.writeModels(ns, [...settingsPath, 'models'], nextModels, state.revision);
        } catch (error) {
          setBusyIndex(-1);
          setState((s) => ({ ...s, error: t('errWrite') + '：' + messageOf(error) }));
          return;
        }
        setBusyIndex(-1);
        if (response === undefined || response === null || response.ok !== true) {
          const detail = response !== undefined && response !== null && response.error !== undefined
            ? response.error.message
            : t('conflict');
          setState((s) => ({ ...s, error: t('errWrite') + '：' + detail }));
          await load();
          return;
        }
        setState((s) => ({ ...s, error: null }));
        setNote(t('saved'));
        await load();
      }, [api, drafts, load, ns, settingsPath, state, t]);

      if (api === undefined || state.status === 'inert' || state.status === 'loading') return null;
      if (state.status === 'empty' || state.status === 'unavailable') return null;
      if (state.status === 'error' && state.models.length === 0) {
        return h(
          'div',
          { className: 'pre-root' },
          h('div', { className: 'pre-error' }, t('errLoad') + '：' + String(state.error === null ? '' : state.error)),
        );
      }

      const showCompat = state.api === COMPLETIONS_API || state.models.some((model) => storedSupport(model) !== 'inherit');

      const children = [
        h(
          'div',
          { className: 'pre-head', key: 'head' },
          h('div', { className: 'pre-title' }, t('title')),
          h('div', { className: 'pre-hint' }, t('hint')),
        ),
      ];

      for (let index = 0; index < state.models.length; index += 1) {
        const model = state.models[index];
        const draft = drafts[index] === undefined ? draftOf(model) : drafts[index];
        const modelId = typeof model.id === 'string' ? model.id : '(model ' + String(index) + ')';
        const expanded = openIndex === index && draft.mode === 'custom';

        const modeButton = (mode, label, hint) => h(
          'button',
          {
            type: 'button',
            key: mode,
            'aria-pressed': draft.mode === mode,
            title: hint,
            onClick: () => {
              setNote(null);
              patchDraft(index, { mode });
              if (mode === 'custom') setOpenIndex(index);
              else if (openIndex === index) setOpenIndex(-1);
            },
          },
          label,
        );

        const rowChildren = [
          h('span', { className: 'pre-id', key: 'id' }, modelId),
          h(
            'div',
            { className: 'pre-seg', role: 'group', key: 'mode' },
            modeButton('inherit', t('modeInherit'), t('modeInheritHint')),
            modeButton('off', t('modeOff'), t('modeOffHint')),
            modeButton('custom', t('modeCustom'), t('modeCustomHint')),
          ),
          h('span', { className: 'pre-spacer', key: 'spacer' }),
        ];

        if (draft.mode === 'custom') {
          rowChildren.push(h(
            'button',
            {
              type: 'button',
              key: 'toggle',
              className: 'pre-btn',
              onClick: () => setOpenIndex(expanded ? -1 : index),
            },
            expanded ? t('collapse') : t('expand'),
          ));
        }

        rowChildren.push(h(
          'button',
          {
            type: 'button',
            key: 'save',
            className: 'pre-btn',
            'data-primary': 'true',
            disabled: state.readOnly || busyIndex !== -1,
            onClick: () => { save(index); },
          },
          busyIndex === index ? t('saving') : t('save'),
        ));
        rowChildren.push(h(
          'button',
          {
            type: 'button',
            key: 'reset',
            className: 'pre-btn',
            disabled: busyIndex !== -1,
            onClick: () => {
              patchDraft(index, draftOf(model));
              setOpenIndex(-1);
            },
          },
          t('reset'),
        ));

        const cardChildren = [h('div', { className: 'pre-row', key: 'row' }, rowChildren)];

        if (expanded) {
          const levelRows = LEVELS.map((level) => {
            const placeholder = level === 'off'
              ? t('placeholderOff')
              : t('placeholderWire').replace('{level}', level);
            return h(
              'label',
              { className: 'pre-level', key: level },
              h('span', null, t('level_' + level)),
              h('input', {
                className: 'pre-input',
                type: 'text',
                spellCheck: false,
                autoComplete: 'off',
                value: draft.levels[level] === undefined ? '' : draft.levels[level],
                placeholder,
                disabled: state.readOnly,
                onChange: (event) => patchLevel(index, level, event.target.value),
              }),
            );
          });

          cardChildren.push(h(
            'div',
            { className: 'pre-levels', key: 'levels' },
            levelRows,
          ));

          cardChildren.push(h(
            'div',
            { className: 'pre-row', key: 'tools' },
            h(
              'button',
              {
                type: 'button',
                className: 'pre-btn',
                disabled: state.readOnly,
                onClick: () => {
                  const levels = {};
                  for (const level of LEVELS) levels[level] = level === 'off' ? '' : level;
                  patchDraft(index, { levels });
                },
              },
              t('fillSame'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'pre-btn',
                disabled: state.readOnly,
                onClick: () => {
                  const levels = {};
                  for (const level of LEVELS) levels[level] = '';
                  patchDraft(index, { levels });
                },
              },
              t('clear'),
            ),
            showCompat
              ? h(
                'div',
                { className: 'pre-compat', key: 'compat', title: t('compatHint') },
                h('span', { className: 'pre-hint' }, t('compat')),
                h(
                  'div',
                  { className: 'pre-seg', role: 'group' },
                  h(
                    'button',
                    {
                      type: 'button',
                      'aria-pressed': draft.support === 'inherit',
                      onClick: () => patchDraft(index, { support: 'inherit' }),
                    },
                    t('modeInherit'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      'aria-pressed': draft.support === 'on',
                      onClick: () => patchDraft(index, { support: 'on' }),
                    },
                    'true',
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      'aria-pressed': draft.support === 'off',
                      onClick: () => patchDraft(index, { support: 'off' }),
                    },
                    'false',
                  ),
                ),
              )
              : null,
          ));
        }

        children.push(h('div', { className: 'pre-model', key: 'model-' + String(index) }, cardChildren));
      }

      if (state.api !== undefined) {
        children.push(h('div', { className: 'pre-hint', key: 'api' }, t('apiIs').replace('{api}', state.api)));
      }
      if (state.readOnly) children.push(h('div', { className: 'pre-warn', key: 'ro' }, t('readOnly')));
      if (state.restart) children.push(h('div', { className: 'pre-warn', key: 'restart' }, t('restartRequired')));
      if (state.error !== null && state.error !== undefined && state.error !== '') {
        children.push(h('div', { className: 'pre-error', key: 'err' }, String(state.error)));
      }
      if (note !== null) children.push(h('div', { className: 'pre-note', key: 'note' }, note));

      return h('div', { className: 'pre-root' }, children);
    }

    /* ---------------------------------------------------------------- */
    /* 插件                                                              */
    /* ---------------------------------------------------------------- */

    /** 硬依赖：席位服务与两个 Remote 命名空间。缺任何一个就等它出现。 */
    const inject = ['slots', 'locale', 'remote', 'remote.settings', 'remote.llm'];

    function apply(ctx) {
      // 样式：只在 apply 内插入，卸载时移除。
      ctx.effect(() => {
        const tagId = 'dsh-plugin-reasoning-effort/styles.css';
        if (typeof document === 'undefined') return () => {};
        if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') !== null) return () => {};
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-plugin-reasoning-effort';
        tag.dataset.pluginCss = tagId;
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => { tag.remove(); };
      }, 'reasoning-effort: styles');

      // 文案：走 Client locale 服务，界面文字不写死在组件里。
      let t = (key) => (zh[key] === undefined ? key : zh[key]);
      try {
        ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'reasoning-effort: locale');
        const bound = ctx.locale.bind(LOCALE_NS);
        if (typeof bound === 'function') t = bound;
      } catch (error) {
        console.error('[reasoning-effort] locale unavailable, falling back to built-in copy', error);
      }

      const api = {
        t,
        describe: () => ctx.remote.settings.describe(),
        listProviders: () => ctx.remote.llm.listConfigurableProviders(),
        writeModels: (ns, path, models, revision) => ctx.remote.settings.mutate(
          ns,
          [{ op: 'set', path, value: models }],
          revision,
        ),
      };

      // 席位是 keyed 的，键为该行所属设置命名空间的 settingsNs；这张卡片属于
      // 哪个命名空间只能从目录里问出来，所以先发现再逐个登记单元格。
      ctx.slots.inject(SLOT_KEY, () => {
        let active = true;
        const cells = new Map();

        const registerCell = (ns) => {
          if (!active || typeof ns !== 'string' || ns === '' || cells.has(ns)) return;
          cells.set(ns, ctx.slots.register(
            { name: SLOT_KEY, key: ns, inject: () => ({ reasoningApi: api }) },
            ReasoningEffortCard,
          ));
        };

        const discover = async () => {
          try {
            const response = await api.listProviders();
            if (response === undefined || response === null || response.ok !== true) return;
            if (!Array.isArray(response.value)) return;
            for (const entry of response.value) {
              if (entry !== null && entry !== undefined) registerCell(entry.settingsNs);
            }
          } catch (error) {
            console.error('[reasoning-effort] provider directory unavailable', error);
          }
        };

        discover();

        // 目录变化（新增/删除自定义供应商）时补齐新命名空间的单元格。
        // 这是 Host 推来的 Remote 事件，不是本进程的 Cordis 事件，所以走 $on；
        // 该接口在旧版本里可能缺席，因此只做能力探测。
        let offDirectory = () => {};
        try {
          if (typeof ctx.remote.$on === 'function') {
            offDirectory = ctx.remote.$on('llm/adapters-updated', () => { discover(); });
          }
        } catch (error) {
          console.error('[reasoning-effort] provider directory events unavailable', error);
        }

        return () => {
          active = false;
          try {
            offDirectory();
          } catch (error) {
            console.error('[reasoning-effort] failed to detach directory listener', error);
          }
          for (const disposer of cells.values()) {
            if (typeof disposer === 'function') disposer();
          }
          cells.clear();
        };
      });
    }

    /*
     * 测试接缝：把纯映射函数暴露给 scripts/verify-contract.mjs，让「等级 → 网线
     * 拼写」这套规则可以被断言，而不是只靠人眼读代码。Cordis 只读
     * `inject` / `apply` / `name` / `Config`，多余导出会被忽略。
     */
    const internals = {
      LEVELS,
      THINKING_LEVELS,
      draftOf,
      buildEfforts,
      applyDraft,
      storedMode,
      storedSupport,
    };

    return { inject, apply, __internals: internals };
  },
});
