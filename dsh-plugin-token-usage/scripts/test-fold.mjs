/**
 * `lib/fold.js` 的纯函数测试。
 *
 * 零第三方依赖：直接 `node scripts/test-fold.mjs` 即可运行，不需要
 * schemastery 垫片，也不需要 DSH。这是本插件最该被信任的一层——
 * 宿主半与客户端半都用它算数。
 */
import {
  addBuckets,
  applyAttempt,
  attemptOf,
  bucketsOf,
  emptyBuckets,
  emptyFold,
  foldEvents,
  formatExact,
  formatTokens,
  modelIdentityOf,
  rowsOf,
  totalOf,
} from '../lib/fold.js';

let ok = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    ok += 1;
    console.log('  ok   ' + label);
  } else {
    failures.push(label + (detail === undefined ? '' : ' — ' + detail));
    console.log('  FAIL ' + label + (detail === undefined ? '' : ' — ' + detail));
  }
}

const eq = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/** 造一条带用量的 assistant/message 事件。 */
function assistant(provider, model, usage, turn = 1, step = 1) {
  return {
    type: 'assistant/message',
    seq: 1,
    time: 1,
    data: {
      turn,
      step,
      message: { role: 'assistant', source: { kind: 'model', provider, model } },
      stream: [],
      ...(usage === undefined ? {} : { usage }),
    },
  };
}

console.log('=== 1. bucketsOf：提供方上报的归一 ===');
{
  const full = bucketsOf({
    inputTokens: 1000,
    outputTokens: 250,
    totalTokens: 1250,
    cacheReadTokens: 800,
    cacheWriteTokens: 40,
    reasoningTokens: 60,
  });
  check('四个桶都取到', eq(full, {
    uncachedInputTokens: 1000, outputTokens: 250, cacheReadTokens: 800, cacheWriteTokens: 40,
  }), JSON.stringify(full));

  const noCache = bucketsOf({ inputTokens: 10, outputTokens: 2 });
  check('适配器不报缓存时记 0（不猜）', noCache.cacheReadTokens === 0 && noCache.cacheWriteTokens === 0);

  check('完全没用量返回 null', bucketsOf(undefined) === null && bucketsOf(null) === null && bucketsOf('x') === null);
  check('只有缓存字段、没有输入输出时返回 null', bucketsOf({ cacheReadTokens: 5 }) === null);

  const zeroes = bucketsOf({ inputTokens: 0, outputTokens: 0 });
  check('输入输出都是 0 仍是有效用量', zeroes !== null && totalOf(zeroes) === 0);

  const weird = bucketsOf({ inputTokens: -5, outputTokens: 3.9 });
  check('负输入被当成未上报，小数向下取整', weird !== null && weird.uncachedInputTokens === 0 && weird.outputTokens === 3, JSON.stringify(weird));

  check('NaN 输入被当成未上报', bucketsOf({ inputTokens: NaN, outputTokens: 7 }).uncachedInputTokens === 0);
  check('reasoningTokens 不进任何桶（避免与 outputTokens 重复计数）',
    !Object.prototype.hasOwnProperty.call(full, 'reasoningTokens'));
}

console.log('');
console.log('=== 2. 桶运算 ===');
{
  const base = { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 };
  check('totalOf 四桶相加', totalOf(base) === 10);
  check('totalOf 容错 null', totalOf(null) === 0);
  check('emptyBuckets 全零', eq(emptyBuckets(), {
    uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  }));

  const left = { uncachedInputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const right = { uncachedInputTokens: 2, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 0 };
  const sum = addBuckets(left, right);
  check('addBuckets 逐桶相加', eq(sum, {
    uncachedInputTokens: 3, outputTokens: 4, cacheReadTokens: 4, cacheWriteTokens: 0,
  }), JSON.stringify(sum));
  // 负向对照：如果有任何一处写成了原地修改，这里就会失败
  check('addBuckets 不改入参', eq(left, {
    uncachedInputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
  }));
  check('addBuckets 容忍 undefined 桶', eq(addBuckets(undefined, left), left));
}

console.log('');
console.log('=== 3. attemptOf：只认真正计费的事件 ===');
{
  const a = attemptOf(assistant('deepseek-account', 'deepseek-flash', { inputTokens: 100, outputTokens: 20 }));
  check('认出 assistant/message 的用量', a !== null && a.key === 'deepseek-account/deepseek-flash', JSON.stringify(a));
  check('attemptOf 带出桶', a.buckets.uncachedInputTokens === 100 && a.buckets.outputTokens === 20);

  check('非 assistant/message 事件不算', attemptOf({ type: 'turn/end', data: {} }) === null);
  check('assistant/attempt（只有流、无用量）不算',
    attemptOf({ type: 'assistant/attempt', data: { turn: 1, step: 1, stream: [] } }) === null);
  check('assistant/message 但没有 usage 不算', attemptOf(assistant('p', 'm', undefined)) === null);
  check('usage 全是垃圾时不算', attemptOf(assistant('p', 'm', { foo: 1 })) === null);
  check('null 事件不炸', attemptOf(null) === null && attemptOf(undefined) === null && attemptOf(42) === null);
  check('data 缺失不炸', attemptOf({ type: 'assistant/message' }) === null);
}

console.log('');
console.log('=== 4. modelIdentityOf：归因不能张冠李戴 ===');
{
  const model = modelIdentityOf({ source: { kind: 'model', provider: 'stepfun', model: 'step-5-preview' } });
  check('kind=model 取到 provider/model', model.key === 'stepfun/step-5-preview');

  // system-prompt 与 tool 消息也带 source，但都不代表一次模型调用
  const sys = modelIdentityOf({ source: { kind: 'system-prompt' } });
  check('system-prompt 消息不算模型', sys.key === 'unknown/unknown', JSON.stringify(sys));
  const tool = modelIdentityOf({ source: { kind: 'tool', callId: 'c1' } });
  check('tool 消息不算模型', tool.key === 'unknown/unknown');

  check('provider 有、model 缺 → 归到 provider/unknown',
    modelIdentityOf({ source: { kind: 'model', provider: 'p' } }).key === 'p/unknown');
  check('空字符串 provider 视为缺失',
    modelIdentityOf({ source: { kind: 'model', provider: '', model: 'm' } }).key === 'unknown/unknown');
  check('message 为 null 不炸', modelIdentityOf(null).key === 'unknown/unknown');
}

console.log('');
console.log('=== 5. applyAttempt：纯函数与累加 ===');
{
  const empty = emptyFold();
  check('空折叠形状正确', eq(empty, { byModel: {}, attempts: 0, unattributed: 0 }));

  const irrelevant = { type: 'tool/result', data: {} };
  const untouched = applyAttempt(empty, irrelevant);
  // 引用相等是硬要求：投影单元靠它抑制无变化的下游重算
  check('无关事件返回同一引用（省掉下游重算）', untouched === empty);

  const one = applyAttempt(empty, assistant('p', 'm', { inputTokens: 10, outputTokens: 1 }));
  check('一条尝试后 attempts=1', one.attempts === 1);
  check('原始状态未被修改', eq(empty, { byModel: {}, attempts: 0, unattributed: 0 }));
  check('产生的是新对象', one !== empty);

  const two = applyAttempt(one, assistant('p', 'm', { inputTokens: 5, outputTokens: 2 }));
  check('同模型累加到同一 key', Object.keys(two.byModel).length === 1);
  check('同模型用量相加', two.byModel['p/m'].buckets.uncachedInputTokens === 15);
  check('同模型 attempts 累加', two.byModel['p/m'].attempts === 2);
  check('上一次的状态未被改写', one.byModel['p/m'].buckets.uncachedInputTokens === 10);

  const three = applyAttempt(two, assistant('q', 'n', { inputTokens: 1, outputTokens: 1 }));
  check('不同模型各自成 key', Object.keys(three.byModel).length === 2);

  // 重试会产生第二条 assistant/message，天然计两次
  const retry = applyAttempt(three, assistant('p', 'm', { inputTokens: 3, outputTokens: 0 }));
  check('重试累加为独立计费次数', retry.byModel['p/m'].attempts === 3);

  const unattributed = applyAttempt(empty, {
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'system-prompt' } }, stream: [], usage: { inputTokens: 4, outputTokens: 1 } },
  });
  check('归不到模型的尝试单独计数', unattributed.unattributed === 1 && unattributed.attempts === 1);
  check('归不到模型的尝试仍进 unknown 桶（总量才不丢）', unattributed.byModel['unknown/unknown'].buckets.uncachedInputTokens === 4);

  check('传入 null 状态不炸', applyAttempt(null, assistant('p', 'm', { inputTokens: 1, outputTokens: 1 })).attempts === 1);
}

console.log('');
console.log('=== 6. foldEvents 与 rowsOf ===');
{
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    assistant('deepseek-account', 'deepseek-flash', { inputTokens: 100, outputTokens: 50 }, 1, 1),
    assistant('stepfun', 'step-5-preview', { inputTokens: 900, outputTokens: 100 }, 1, 2),
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    assistant('deepseek-account', 'deepseek-flash', { inputTokens: 20, outputTokens: 5 }, 2, 1),
  ];
  const state = foldEvents(events);
  check('折叠出两个模型', Object.keys(state.byModel).length === 2);
  check('只数有用量的事件（3 条）', state.attempts === 3);
  check('累加正确', state.byModel['deepseek-account/deepseek-flash'].buckets.uncachedInputTokens === 120);

  const rows = rowsOf(state);
  check('按总量降序：stepfun 在前', rows[0].key === 'stepfun/step-5-preview', JSON.stringify(rows.map((r) => [r.key, r.total])));
  check('rows 带 total', rows[0].total === 1000 && rows[1].total === 175);
  check('rows 带 attempts', rows[0].attempts === 1 && rows[1].attempts === 2);
  check('rows 的 buckets 是副本（改它不影响状态）', (() => {
    rows[0].buckets.outputTokens = 99999;
    return rowsOf(state)[0].buckets.outputTokens === 100;
  })());

  // 稳定性：同总量时按 key 排序，两次结果必须一致
  const tie = foldEvents([
    assistant('b', 'm', { inputTokens: 10, outputTokens: 0 }),
    assistant('a', 'm', { inputTokens: 10, outputTokens: 0 }),
  ]);
  check('同总量按 key 稳定排序', rowsOf(tie).map((r) => r.key).join(',') === 'a/m,b/m');

  check('空状态 rows 为空数组', eq(rowsOf(emptyFold()), []));
  check('rowsOf(null) 不炸', eq(rowsOf(null), []));
}

console.log('');
console.log('=== 7. 紧凑格式化 ===');
{
  check('0 → 0', formatTokens(0) === '0');
  check('999 → 999', formatTokens(999) === '999');
  check('1000 → 1K', formatTokens(1000) === '1K', formatTokens(1000));
  check('1234 → 1.2K', formatTokens(1234) === '1.2K', formatTokens(1234));
  // 超过 100 不再留小数：123.4K 那种精度没有意义
  check('123456 → 123K（百位以上取整）', formatTokens(123456) === '123K', formatTokens(123456));
  check('999999 → 1000K（未到百万阈值内取整）', formatTokens(999999) === '1000K', formatTokens(999999));
  check('1000000 → 1M', formatTokens(1000000) === '1M', formatTokens(1000000));
  check('1234567 → 1.2M', formatTokens(1234567) === '1.2M', formatTokens(1234567));
  check('1000000000 → 1B', formatTokens(1000000000) === '1B', formatTokens(1000000000));
  check('负数与 NaN 归一成 0', formatTokens(-5) === '0' && formatTokens(NaN) === '0');

  check('formatExact 千分位', formatExact(1234567) === '1,234,567', formatExact(1234567));
  check('formatExact 三位以下不加逗号', formatExact(999) === '999');
  check('formatExact 容错', formatExact(undefined) === '0');
}

console.log('');
if (failures.length === 0) {
  console.log('全部通过：' + ok + ' 项断言。');
  process.exit(0);
}
console.log('失败 ' + failures.length + ' 项：');
for (const failure of failures) console.log('  - ' + failure);
process.exit(1);
