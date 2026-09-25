#!/usr/bin/env node
/**
 * test-store.mjs — lib/store.js 的持久化不变式测试（零第三方依赖）。
 *
 * Lead 报告并修复过一个真实的数据丢失 bug：
 *   1. `persist()` 为拿最新 revision 调 `refresh()`，而 refresh 用磁盘快照整体替换
 *      内存态 → 刚 `appendLog` 的本地改动在内存里消失，随后 `updateLog` 基于空数组
 *      写回，把磁盘上刚写好的日志覆盖成 []；
 *   2. 某些实现的 `describe()` 返回设置文档的**活引用**，持有引用会让内存快照
 *      在别人写盘时被悄悄改掉。
 * 本脚本用两个替身（describe 返回深拷贝 / 返回活引用）独立复现这两条不变式，
 * 并交叉比对两种语义下的最终结果必须一致。
 *
 * 规范来源：CONTRACT.md §2.3（LogRecord 环形缓冲）、§2.4（RunState）、§3（store API）。
 * 用法：node scripts/test-store.mjs
 * 退出码：0 = 全部通过；1 = 有断言失败；2 = 依赖文件缺失或无法加载。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as nodeModule from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/* ------------------------------------------------------------------ */
/* 最小 harness                                                        */
/* ------------------------------------------------------------------ */

let passed = 0;
const failures = [];
const missing = [];
let sectionName = '(root)';

function section(name) {
  sectionName = name;
  console.log('\n[' + name + ']');
}

function ok(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log('  ok   ' + label);
    return true;
  }
  const line = label + (detail === undefined ? '' : ' — ' + detail);
  failures.push(sectionName + ' :: ' + line);
  console.log('  FAIL ' + line);
  return false;
}

function fmt(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

/* ------------------------------------------------------------------ */
/* 解析桩：store.js -> config.js -> @deepseek-ai/schemastery            */
/* 仓库里没有 node_modules，安装期依赖只有 DSH 运行时能解析。            */
/* ------------------------------------------------------------------ */

const STUB_SOURCE = [
  'const chain = new Proxy(function stub() {}, {',
  '  get(target, prop) {',
  "    if (prop === 'then') return undefined;",
  "    if (prop === 'toJSON') return () => '[stub]';",
  '    if (prop === Symbol.toPrimitive) return () => "[stub]";',
  "    if (prop === Symbol.toStringTag) return 'Stub';",
  "    if (prop === Symbol.for('nodejs.util.inspect.custom')) return () => '[stub]';",
  "    if (prop === '__esModule') return true;",
  '    return chain;',
  '  },',
  '  apply() { return chain; },',
  '  construct() { return chain; },',
  '  has() { return true; },',
  '});',
  'export default chain;',
  'export const Schema = chain, z = chain;',
].join('\n');
const stubUrl = 'data:text/javascript;base64,' + Buffer.from(STUB_SOURCE, 'utf8').toString('base64');

const isBare = (specifier) => !(
  specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')
  || specifier.startsWith('node:') || specifier.startsWith('file:') || specifier.startsWith('data:')
);

if (typeof nodeModule.registerHooks === 'function') {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (isBare(specifier)) return { url: stubUrl, shortCircuit: true, format: 'module' };
        throw error;
      }
    },
  });
}

/* ------------------------------------------------------------------ */
/* 加载被测模块                                                        */
/* ------------------------------------------------------------------ */

async function loadLib(name) {
  const file = path.join(root, 'lib', name);
  if (!fs.existsSync(file)) {
    missing.push({ file, reason: '文件不存在' });
    return undefined;
  }
  try {
    return await import(pathToFileURL(file).href);
  } catch (error) {
    missing.push({ file, reason: '加载失败：' + (error && error.message ? error.message : String(error)) });
    return undefined;
  }
}

console.log('test-store.mjs — CONTRACT.md §2.3/§2.4/§3 持久化不变式');
console.log('插件根目录：' + root);
console.log('运行时：node ' + process.version);

const storeModule = await loadLib('store.js');
const configModule = await loadLib('config.js');

/* 命名空间取自补丁层的 Loader 行 id（客户端 mutate 用的 ns）。 */
function patchNamespace() {
  const file = path.join(root, 'cordis.patch.yml');
  if (!fs.existsSync(file)) return undefined;
  const match = /^\s*-\s*id\s*:\s*(.+?)\s*$/m.exec(fs.readFileSync(file, 'utf8'));
  return match === null ? undefined : match[1].replace(/^['"]|['"]$/g, '');
}

const NAMESPACE = patchNamespace();

/* ------------------------------------------------------------------ */
/* 设置服务替身                                                        */
/* ------------------------------------------------------------------ */

const deepClone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

function writeInto(target, segments, value) {
  let node = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const key = segments[index];
    if (node[key] === null || typeof node[key] !== 'object') node[key] = {};
    node = node[key];
  }
  // 真实设置在写盘时会把值序列化，替身同样深拷贝，避免替身自身引入别名效应。
  node[segments[segments.length - 1]] = deepClone(value);
}

/**
 * @param {string} namespace
 * @param {object} initialDoc
 * @param {{ liveReference: boolean }} options liveReference=true 时 describe() 返回文档活引用
 */
function createSettingsService(namespace, initialDoc, options) {
  let doc = deepClone(initialDoc);
  let revision = 1;
  const calls = { describe: 0, mutate: [] };
  return {
    calls,
    document: () => doc,
    currentRevision: () => revision,
    service: {
      async describe() {
        calls.describe += 1;
        return [{
          ns: namespace,
          revision,
          user: options.liveReference ? doc : deepClone(doc),
        }];
      },
      async mutate(targetNs, ops, expectedRevision) {
        calls.mutate.push({ ns: targetNs, ops: deepClone(ops), revision: expectedRevision });
        if (targetNs !== namespace) throw new Error('未知命名空间 ' + targetNs);
        if (expectedRevision !== revision) {
          const error = new Error('revision 不匹配（当前 ' + revision + '，收到 ' + expectedRevision + '）');
          error.code = 'REVISION_MISMATCH';
          throw error;
        }
        for (const op of ops) {
          if (op.op !== 'set') throw new Error('替身只支持 set，收到 ' + op.op);
          writeInto(doc, op.path, op.value);
        }
        revision += 1;
        return { ok: true };
      },
    },
  };
}

const logSeqs = (log) => log.map((row) => row.seq).join(',');

/* ------------------------------------------------------------------ */
/* 场景                                                                */
/* ------------------------------------------------------------------ */

async function runScenario(label, options) {
  section(label);
  if (storeModule === undefined || typeof storeModule.createStore !== 'function') {
    console.log('  skip store.js 缺失，跳过');
    return undefined;
  }

  const harness = createSettingsService(NAMESPACE, { tasks: [], internal: { log: [], runs: {} } }, options);
  const warnings = [];
  const ctx = {
    get: (name) => (name === 'settings' ? harness.service : undefined),
    logger: { warn: (text) => warnings.push(String(text)) },
  };

  const store = storeModule.createStore(ctx, { logLimit: 200 });
  ok('createStore 在设置可用时进入持久化模式', store.isPersistent() === true, fmt(store.isPersistent()));

  /* ---- 连续追加 5 条日志 ---- */
  const appended = [];
  for (let index = 1; index <= 5; index += 1) {
    appended.push(await store.appendLog({
      taskId: 'task-' + index,
      title: '标题' + index,
      startedAt: 1000 + index,
      endedAt: 1000 + index,
      status: 'ok',
      trigger: 'manual',
      summary: '摘要' + index,
    }));
  }
  const persistedLog = () => harness.document().internal.log;

  ok('appendLog 返回递增 seq 1..5', logSeqs(appended) === '1,2,3,4,5', logSeqs(appended));
  ok('内存 getLog() 保留全部 5 条（未被 refresh 冲掉）', store.getLog().length === 5, '实际 ' + store.getLog().length);
  ok('磁盘 internal.log 写入 5 条', persistedLog().length === 5, '实际 ' + persistedLog().length);
  ok(
    '内存与磁盘 seq 序列一致',
    logSeqs(store.getLog()) === logSeqs(persistedLog()),
    '内存 ' + logSeqs(store.getLog()) + ' / 磁盘 ' + logSeqs(persistedLog()),
  );

  /* ---- 原地更新第 3 条 ---- */
  const updated = await store.updateLog(3, { status: 'error', error: 'boom' });
  ok('updateLog 返回被更新的记录', updated !== undefined && updated.seq === 3 && updated.status === 'error', fmt(updated));
  ok('updateLog 后内存仍是 5 条', store.getLog().length === 5, '实际 ' + store.getLog().length);
  ok(
    '内存第 3 条变为 error',
    store.getLog().find((row) => row.seq === 3)?.status === 'error',
    fmt(store.getLog().find((row) => row.seq === 3)),
  );
  ok('updateLog 后磁盘仍是 5 条（未被空数组覆盖）', persistedLog().length === 5, '实际 ' + persistedLog().length);
  ok(
    '磁盘第 3 条也是 error',
    persistedLog().find((row) => row.seq === 3)?.status === 'error',
    fmt(persistedLog().find((row) => row.seq === 3)),
  );
  ok(
    'updateLog 后内存与磁盘完全一致',
    JSON.stringify(store.getLog()) === JSON.stringify(persistedLog()),
    '内存 ' + fmt(store.getLog()) + ' / 磁盘 ' + fmt(persistedLog()),
  );

  /* ---- 运行去重表（契约 §2.4） ---- */
  await store.setRunState('task-1', { seq: 1, startedAt: 1, trigger: 'manual' });
  ok(
    'setRunState 写入内存与磁盘 internal.runs',
    store.getRuns()['task-1']?.seq === 1 && harness.document().internal.runs['task-1']?.seq === 1,
    fmt(harness.document().internal.runs),
  );
  await store.setRunState('task-1', null);
  ok(
    'setRunState(taskId, null) 从内存与磁盘删除',
    store.getRuns()['task-1'] === undefined && harness.document().internal.runs['task-1'] === undefined,
    fmt(harness.document().internal.runs),
  );

  /* ---- 活引用替身：外部改写设置文档不得污染 store 的内存快照 ---- */
  if (options.liveReference) {
    // 上一次 persist 之后 store 会 refresh 一次，此刻正是"活引用"最容易粘住的时候。
    const beforeLen = store.getLog().length;
    harness.document().internal.log.push({
      seq: 999, taskId: 'ghost', title: 'ghost', startedAt: 0, endedAt: 0, status: 'ok', trigger: 'manual', summary: '',
    });
    ok(
      '外部改写设置文档不会污染 store 内存快照（未持活引用）',
      store.getLog().length === beforeLen,
      '内存 ' + store.getLog().length + ' 条，改写前 ' + beforeLen + ' 条',
    );
    harness.document().internal.log.pop();
    ok(
      'store 至少读取过一次设置目录',
      harness.calls.describe >= 1,
      'describe 调用 ' + harness.calls.describe + ' 次',
    );
  }

  return {
    memoryLog: deepClone(store.getLog()),
    diskLog: deepClone(persistedLog()),
    warnings: warnings.slice(),
    mutateCalls: harness.calls.mutate.length,
  };
}

const scenarioA = await runScenario('场景 A：describe() 返回深拷贝', { liveReference: false });
const scenarioB = await runScenario('场景 B：describe() 返回设置文档活引用（暴露 bug 的关键）', { liveReference: true });

if (scenarioA !== undefined && scenarioB !== undefined) {
  section('交叉比对：两种 describe 语义必须得到同一结果');
  ok(
    '两种语义下最终内存日志一致',
    JSON.stringify(scenarioA.memoryLog) === JSON.stringify(scenarioB.memoryLog),
    'A ' + fmt(scenarioA.memoryLog) + ' / B ' + fmt(scenarioB.memoryLog),
  );
  ok(
    '两种语义下最终磁盘日志一致',
    JSON.stringify(scenarioA.diskLog) === JSON.stringify(scenarioB.diskLog),
    'A ' + fmt(scenarioA.diskLog) + ' / B ' + fmt(scenarioB.diskLog),
  );
  ok(
    '两种语义下磁盘日志都保留 5 条（无数据丢失）',
    scenarioA.diskLog.length === 5 && scenarioB.diskLog.length === 5,
    'A ' + scenarioA.diskLog.length + ' / B ' + scenarioB.diskLog.length,
  );
  ok(
    '内存与磁盘一致（A）',
    JSON.stringify(scenarioA.memoryLog) === JSON.stringify(scenarioA.diskLog),
  );
  ok(
    '内存与磁盘一致（B）',
    JSON.stringify(scenarioB.memoryLog) === JSON.stringify(scenarioB.diskLog),
  );
}

/* ------------------------------------------------------------------ */
/* 环形缓冲裁剪（契约 §2.3：追加后裁剪到 logLimit，保留最新）             */
/* ------------------------------------------------------------------ */

if (storeModule !== undefined && typeof storeModule.createStore === 'function') {
  section('日志环形缓冲裁剪（契约 §2.3）');
  const harness = createSettingsService(NAMESPACE, { tasks: [], internal: { log: [], runs: {} } }, { liveReference: false });
  const ctx = { get: (name) => (name === 'settings' ? harness.service : undefined), logger: { warn: () => {} } };
  const store = storeModule.createStore(ctx, { logLimit: 3 });
  for (let index = 1; index <= 5; index += 1) {
    await store.appendLog({ taskId: 't', title: 't', startedAt: index, endedAt: index, status: 'ok', trigger: 'schedule', summary: 's' });
  }
  ok('内存裁剪到 logLimit=3，保留最新 3 条', logSeqs(store.getLog()) === '3,4,5', logSeqs(store.getLog()));
  ok(
    '磁盘也裁剪到 3 条（最新保留）',
    logSeqs(harness.document().internal.log) === '3,4,5',
    logSeqs(harness.document().internal.log),
  );
}

/* ------------------------------------------------------------------ */
/* 汇总                                                                */
/* ------------------------------------------------------------------ */

console.log('\n' + '='.repeat(64));
if (missing.length > 0) {
  console.log('缺失 / 无法加载：');
  for (const item of missing) console.log('  - ' + item.file + ' —— ' + item.reason);
  console.log('已通过 ' + passed + ' 项，失败 ' + failures.length + ' 项；其余断言需要上述文件就位后重跑。');
  process.exit(2);
}
if (NAMESPACE === undefined) {
  console.log('无法从 cordis.patch.yml 读出 Loader 行 id。');
  process.exit(2);
}
if (configModule !== undefined && configModule.CONFIG_NS !== NAMESPACE) {
  section('常量一致性');
  ok('lib/config.js 的 CONFIG_NS = 补丁行 id', false, fmt(configModule.CONFIG_NS) + ' vs ' + fmt(NAMESPACE));
}
if (failures.length > 0) {
  console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项：');
  for (const item of failures) console.log('  - ' + item);
  process.exit(1);
}
console.log('全部通过：' + passed + ' 项断言（namespace=' + NAMESPACE + '）。');
process.exit(0);
