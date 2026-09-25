/**
 * 把 client.js 真正跑一遍，并把渲染树 dump 成文本。
 *
 * 为什么需要：面板上「新增主机」按钮**从第一版起就没出现过**，而空态文案却写着
 * "用下面的表单添加"。静态检查、语法检查、断言全都看不见这件事——按钮元素是
 * 被创建了的（`t.add` 有值、部署副本与源码一致），问题只可能在**渲染或样式**。
 * 我在这上面推理了几轮都没结论，所以直接把它跑起来看。
 *
 * 自己实现了一个极小的 React 运行时（useState 有真实状态与重渲染、useEffect
 * 可手动触发），所以不需要第三方依赖、不需要浏览器。
 *
 * 用法：node scripts/render-dump.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = fs.readFileSync(path.join(root, 'client.js'), 'utf8');

/* ---------------- 迷你 React ---------------- */
let current = null;
let pendingRender = null;

const React = {
  createElement(type, props, ...children) {
    return {
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false && child !== true),
    };
  },
  useState(initial) {
    const inst = current;
    const index = inst.hookIndex;
    inst.hookIndex += 1;
    if (inst.hooks.length <= index) inst.hooks[index] = typeof initial === 'function' ? initial() : initial;
    const setter = (next) => {
      const value = typeof next === 'function' ? next(inst.hooks[index]) : next;
      inst.hooks[index] = value;
      if (pendingRender !== null) pendingRender();
    };
    return [inst.hooks[index], setter];
  },
  useEffect(fn) {
    current.hookIndex += 1;
    current.effects.push(fn);
  },
  useCallback(fn) { current.hookIndex += 1; return fn; },
  useMemo(fn) { current.hookIndex += 1; return fn(); },
  useRef(value) { current.hookIndex += 1; return { current: value }; },
};

/** 调用一个函数组件（含真实 hook 状态与一次 effect 冲刷）。 */
function renderComponent(component, props) {
  const inst = { hooks: [], hookIndex: 0, effects: [] };
  const previous = current;
  current = inst;
  const tree = component(props);
  current = previous;
  const effects = inst.effects.slice();
  inst.effects.length = 0;
  return { tree, effects, inst };
}

/** 把渲染树 dump 成可读文本。 */
function dump(node, depth = 0) {
  const pad = '  '.repeat(depth);
  if (node === null || node === undefined) return [`${pad}(null)`];
  if (typeof node === 'string' || typeof node === 'number') return [`${pad}"${node}"`];
  if (Array.isArray(node)) return node.flatMap((child) => dump(child, depth));
  if (typeof node.type === 'function') {
    const { tree } = renderComponent(node.type, node.props);
    return [`${pad}<${node.type.name || 'Component'}>`, ...dump(tree, depth + 1)];
  }
  const className = node.props?.className === undefined ? '' : ` class=${node.props.className}`;
  const lines = [`${pad}<${String(node.type)}${className}>`];
  for (const child of node.children) lines.push(...dump(child, depth + 1));
  return lines;
}

/* ---------------- 加载 client.js ---------------- */
let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load(options) { captured = options; },
  },
};
globalThis.document = {
  createElement: () => ({ setAttribute() {}, remove() {}, dataset: {}, style: {}, textContent: '' }),
  head: { appendChild() {} },
  querySelector: () => null,
};
globalThis.globalThis.__SSH_WORKSPACE_INTERNALS__ = undefined;

// eslint-disable-next-line no-new-func
new Function('window', 'document', src)(globalThis.window, globalThis.document);

if (captured === null) {
  console.error('client.js 没有调用 __ModuleLoader__.load —— 客户端半不会被加载');
  process.exit(1);
}

const plugin = captured.factory((name) => {
  if (name === 'react') return React;
  throw new Error(`工厂只应 require react，实际要求 ${name}`);
});

/* ---------------- 假的 ctx ---------------- */
const registered = [];
const ctx = {
  get: () => undefined,
  effect(fn) { const off = fn(); return typeof off === 'function' ? off : () => {}; },
  on() { return () => {}; },
  locale: {
    current: 'zh-CN',
    register() {},
    bind: () => (key) => key,
  },
  slots: {
    inject(ownerKey, callback) {
      const effect = callback();
      for (const item of effect) registered.push({ ownerKey, item });
      return () => {};
    },
    register(options) { return () => {}; },
  },
  remote: {
    settings: {
      async describe() {
        return { ok: true, value: { namespaces: [{ ns: 'ssh-workspace', revision: 1, value: { hosts: [], internal: {} } }] } };
      },
      async mutate() {},
    },
  },
};

plugin.apply(ctx);

console.log('=== 注册的席位 ===');
for (const entry of registered) console.log(`  ${entry.ownerKey}  id/key=${entry.item?.id ?? entry.item?.key ?? '?'}`);

/* ---------------- 渲染主页面 ---------------- */
const main = registered.find((entry) => entry.ownerKey === 'main');
if (main === undefined) {
  console.error('没有注册 main 席位');
  process.exit(1);
}
const Component = main.item.component ?? main.item;

let tree = renderComponent(Component, {});
// 冲刷 effect（触发 load）并重渲染一次
for (const effect of tree.effects) {
  const cleanup = effect();
  if (typeof cleanup === 'function') cleanup();
}
await new Promise((resolve) => setTimeout(resolve, 50));
tree = renderComponent(Component, {});

console.log('');
console.log('=== 主页面渲染树 ===');
const lines = dump(tree.tree);
for (const line of lines) console.log('  ' + line);

console.log('');
console.log('=== 关键检查 ===');
const text = lines.join('\n');
console.log(`  树里出现 button: ${text.includes('<button')}`);
console.log(`  树里出现 "Add host" / "新增主机": ${text.includes('Add host') || text.includes('新增主机')}`);
console.log(`  树里出现 ssh-head: ${text.includes('ssh-head')}`);
console.log(`  树里出现 ssh-btn: ${text.includes('ssh-btn')}`);
