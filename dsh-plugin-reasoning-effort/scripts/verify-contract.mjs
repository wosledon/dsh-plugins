/**
 * 契约自检 —— 不渲染 React，只验证「装配形状」。
 *
 * 它回答四个问题：
 *   1. 浏览器半真的以包名为 id 注册了懒工厂（id 与 package.json 的 name 一致）；
 *   2. 工厂返回的是合法的 Cordis 插件对象（inject + apply）；
 *   3. apply() 只在 `settings.models.provider-card` 上登记 **keyed** 单元格，
 *      键取自 `remote.llm.listConfigurableProviders()` 真实返回的 settingsNs；
 *   4. 单元格的 inject 面把可用的远程读写句柄交给组件。
 *
 * 它刻意不模拟 React 渲染、不做 DOM 断言，也不产生任何视觉结论 ——
 * 视觉效果必须在真实页面里看。
 *
 * 用法：node scripts/verify-contract.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const source = fs.readFileSync(path.join(root, 'client.js'), 'utf8');
const patch = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8');

const failures = [];
function check(label, condition, detail) {
  if (condition) {
    console.log('  ok   ' + label);
    return;
  }
  failures.push(label + (detail === undefined ? '' : ' — ' + detail));
  console.log('  FAIL ' + label + (detail === undefined ? '' : ' — ' + detail));
}

console.log('manifest');
check('dsh.bundle.patch 指向补丁文件', pkg.dsh?.bundle?.patch === './cordis.patch.yml');
check('dsh.client.platform 为 web', pkg.dsh?.client?.platform === 'web');
check('exports["./client"] 指向 client.js', pkg.exports?.['./client'] === './client.js');
check(
  '补丁插入的行名与包名一致',
  patch.includes("- insert:") && patch.includes("name: '" + pkg.name + "'"),
  '补丁缺少 name: ' + pkg.name,
);
check('补丁存在唯一 insert 段', patch.split('- insert:').length === 2);

console.log('client bundle');
let entry;
const windowStub = { __ModuleLoader__: { load: (value) => { entry = value; } } };
const reactStub = {
  createElement: () => null,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
};
const documentStub = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '', remove: () => {} }),
  head: { appendChild: () => {} },
};
const requireStub = (spec) => {
  if (spec === 'react') return reactStub;
  throw new Error('unexpected require("' + spec + '")');
};

new Function('window', 'document', 'console', 'require', source)(windowStub, documentStub, console, requireStub);

check('工厂以包名为 id 注册', entry?.id === pkg.name, String(entry?.id));
check('工厂是函数', typeof entry?.factory === 'function');

const plugin = entry.factory(requireStub);
check('插件导出 inject 数组', Array.isArray(plugin?.inject));
check('插件声明 slots 依赖', plugin?.inject?.includes('slots') === true);
check('插件声明 remote.settings 依赖', plugin?.inject?.includes('remote.settings') === true);
check('插件导出 apply 函数', typeof plugin?.apply === 'function');

console.log('apply() 装配');
const registered = [];
const effects = [];
const providers = [
  { provider: 'my-gateway', displayName: 'My Gateway', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'my-gateway'] },
  { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
];
const ctx = {
  effect: (callback) => {
    const disposer = callback();
    effects.push(disposer);
    return () => {};
  },
  locale: {
    register: () => () => {},
    bind: () => (key) => key,
  },
  remote: {
    $on: () => () => {},
    settings: {
      describe: async () => ({ ok: true, value: { writable: true, namespaces: [] } }),
      mutate: async () => ({ ok: true, value: {} }),
    },
    llm: {
      listConfigurableProviders: async () => ({ ok: true, value: providers }),
    },
  },
  slots: {
    inject: (key, callback) => {
      check('inject 的目标席位正确', key === 'settings.models.provider-card', key);
      callback();
      return () => {};
    },
    register: (options, component) => {
      registered.push({ options, component });
      return () => {};
    },
  },
};

plugin.apply(ctx);
await new Promise((resolve) => { setTimeout(resolve, 20); });

check('为目录里每个命名空间登记一个单元格', registered.length === providers.length, '得到 ' + registered.length);
check(
  '全部登记到 settings.models.provider-card',
  registered.every((item) => item.options.name === 'settings.models.provider-card'),
);
check(
  '单元格是 keyed 的，键取自 settingsNs',
  registered.map((item) => item.options.key).join(',') === providers.map((item) => item.settingsNs).join(','),
  registered.map((item) => item.options.key).join(','),
);
check('每个单元格都带组件', registered.every((item) => typeof item.component === 'function'));
const extra = registered[0]?.options.inject?.();
check('inject 面提供 reasoningApi', typeof extra?.reasoningApi === 'object');
check('reasoningApi 暴露 describe', typeof extra?.reasoningApi?.describe === 'function');
check('reasoningApi 暴露 writeModels', typeof extra?.reasoningApi?.writeModels === 'function');
check('样式与文案副作用在 apply 内建立', effects.length >= 1);

console.log('写入形状');
let mutateCall;
ctx.remote.settings.mutate = async (ns, ops, revision) => {
  mutateCall = { ns, ops, revision };
  return { ok: true, value: {} };
};
const modelsToWrite = [{ id: 'step-3.7-flash', reasoningEfforts: { off: null, low: 'low' } }];
await extra.reasoningApi.writeModels('llm-pi-ai', ['providers', 'stepfun', 'models'], modelsToWrite, 7);
check('写入走 remote.settings.mutate', mutateCall !== undefined);
check('写入目标是供应商的设置命名空间', mutateCall?.ns === 'llm-pi-ai', String(mutateCall?.ns));
check('写入带回读到的 revision', mutateCall?.revision === 7);
check('写入是单个 set 操作', mutateCall?.ops?.length === 1 && mutateCall.ops[0].op === 'set');
check(
  '写入路径落在 models 数组（不是数组元素）',
  mutateCall?.ops?.[0]?.path?.join('/') === 'providers/stepfun/models',
  mutateCall?.ops?.[0]?.path?.join('/'),
);
check('写入值是完整 models 数组', Array.isArray(mutateCall?.ops?.[0]?.value) && mutateCall.ops[0].value.length === 1);

console.log('等级映射规则（与宿主校验对齐）');
const internals = plugin.__internals;
check('测试接缝可用', internals !== undefined);

check('空 reasoningEfforts 视为继承', internals?.storedMode({}) === 'inherit');
check('false 视为非推理模型', internals?.storedMode({ reasoningEfforts: false }) === 'off');
check('对象视为自定义', internals?.storedMode({ reasoningEfforts: { low: 'low' } }) === 'custom');
check('compat 缺省视为继承', internals?.storedSupport({}) === 'inherit');
check('compat=true 读成 on', internals?.storedSupport({ compat: { supportsReasoningEffort: true } }) === 'on');
check('compat=false 读成 off', internals?.storedSupport({ compat: { supportsReasoningEffort: false } }) === 'off');

const blank = { off: '', minimal: '', low: '', medium: '', high: '', xhigh: '', max: '' };
const onlyOff = internals.buildEfforts({ levels: blank });
check('只声明 off 被拒（宿主同样拒绝）', onlyOff.errorKey === 'errNeedThinking', JSON.stringify(onlyOff));

const lowHigh = internals.buildEfforts({ levels: { ...blank, low: 'low', high: '  high  ' } });
check('off 留空写成 null（支持关闭但不发参数）', lowHigh.efforts?.off === null, JSON.stringify(lowHigh));
check('等级值按网线拼写原样写入并去空白', lowHigh.efforts?.low === 'low' && lowHigh.efforts?.high === 'high');
check('未填写的等级不写键', lowHigh.efforts?.medium === undefined);

const offSpelling = internals.buildEfforts({ levels: { ...blank, off: 'none', low: 'low' } });
check('off 填了拼写就按拼写发', offSpelling.efforts?.off === 'none', JSON.stringify(offSpelling));

const baseModel = { id: 'm1', name: 'M1', contextWindow: 1000, input: ['text'], compat: { maxTokensField: 'max_tokens' } };
const inherit = internals.applyDraft(baseModel, { mode: 'inherit', levels: blank, support: 'inherit' });
check('继承模式不写 reasoningEfforts', inherit.model !== undefined && !('reasoningEfforts' in inherit.model));
check('继承模式保留其它字段', inherit.model?.contextWindow === 1000 && inherit.model?.input?.[0] === 'text');
check('继承模式保留无关 compat 字段', inherit.model?.compat?.maxTokensField === 'max_tokens');

const noReasoning = internals.applyDraft(baseModel, { mode: 'off', levels: blank, support: 'inherit' });
check('不推理模式写 false', noReasoning.model?.reasoningEfforts === false);

const custom = internals.applyDraft(baseModel, {
  mode: 'custom',
  levels: { ...blank, low: 'low', high: 'high' },
  support: 'on',
});
check('自定义模式写入等级表', custom.model?.reasoningEfforts?.low === 'low' && custom.model?.reasoningEfforts?.off === null);
check('compat 开关按三态写入', custom.model?.compat?.supportsReasoningEffort === true);
check('compat 其它字段不被丢弃', custom.model?.compat?.maxTokensField === 'max_tokens');
const compatOff = internals.applyDraft(baseModel, { mode: 'custom', levels: { ...blank, low: 'low' }, support: 'off' });
check('compat 可显式置 false', compatOff.model?.compat?.supportsReasoningEffort === false);
const compatCleared = internals.applyDraft({ id: 'm2' }, { mode: 'custom', levels: { ...blank, low: 'low' }, support: 'inherit' });
check('compat 继承且无其它键时整块移除', !('compat' in compatCleared.model));
check('原始模型对象未被改动', !('reasoningEfforts' in baseModel) && baseModel.compat?.supportsReasoningEffort === undefined);

const rejected = internals.applyDraft(baseModel, { mode: 'custom', levels: blank, support: 'inherit' });
check('自定义但无思考等级时保存被拦下', rejected.errorKey === 'errNeedThinking');

console.log('');
if (failures.length > 0) {
  console.log('失败 ' + failures.length + ' 项：');
  for (const item of failures) console.log('  - ' + item);
  process.exit(1);
}
console.log('全部通过：装配形状与 bundle 契约一致（视觉效果仍需在真实页面确认）。');
