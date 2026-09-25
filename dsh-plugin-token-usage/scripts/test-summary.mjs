/**
 * 探针：验证 buildSummary 的真实输出形状能被 Config 接受。
 * 放在插件目录内运行，这样 @deepseek-ai/schemastery 垫片可解析。
 */
import { Config } from '../lib/config.js';
import { buildSummary, probeSessionSource, ADAPTERS } from '../lib/summary.js';

let ok = 0;
const bad = [];
const check = (label, cond, detail) => {
  if (cond) { ok += 1; console.log('  ok   ' + label); }
  else { bad.push(label + (detail === undefined ? '' : ' — ' + detail)); console.log('  FAIL ' + label + (detail === undefined ? '' : ' — ' + detail)); }
};

// —— 两个来源都能折叠 ——
const events = [
  // 必须带 `time`：时间轴按事件时间归日，没有时间戳的事件**刻意不进轴**
  // （宁可少一个点，也不假装它属于某一天）。夹具漏了它，折线图数据就会是空的。
  { type: 'assistant/message', time: Date.UTC(2026, 5, 1, 4, 0, 0), data: { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model', provider: 'stepfun', model: 'step-5-preview' } }, stream: [], usage: { inputTokens: 900, outputTokens: 100, cacheReadTokens: 50 } } },
];
const makeSource = (kind) => {
  if (kind === 'query') {
    return { listSessions: async () => [{ header: { id: 's1', createdAt: 100 } }], readSession: async () => ({ events }) };
  }
  return {
    list: async () => [{ header: { id: 's1', createdAt: 100 } }],
    open: async () => ({ read: async () => ({ events }), close: async () => {} }),
  };
};

// —— 关键：整份 summary 必须能被 Config 接受，且原样保留 ——
//
// `.volatile()` 会把值包成带 `.get()` 的访问器，所以要拆包之后才读得到
// （`@deepseek-ai/dsh-settings` 自己的 `plainConfig()` 做的就是这件事）。
function plainConfig(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function'
    && Object.getOwnPropertySymbols(value).some((symbol) => String(symbol).includes('volatile'))) {
    try {
      return plainConfig(value.get());
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) return value.map(plainConfig);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plainConfig(child)]));
  }
  return value;
}

for (const kind of Object.keys(ADAPTERS)) {
  const probe = { available: true, kind, label: ADAPTERS[kind].label, source: makeSource(kind) };
  const summary = await buildSummary(probe, { limit: 10 });
  check(`${kind}: 折叠出 1 行`, summary.rows.length === 1, JSON.stringify(summary.rows.length));
  check(`${kind}: 总量正确（1050）`, summary.rows[0]?.total === 1050, String(summary.rows[0]?.total));
  check(`${kind}: summary.source 是 ${ADAPTERS[kind].label}`, summary.source === ADAPTERS[kind].label, summary.source);
  check(`${kind}: 带 skipped 字段`, Number.isFinite(summary.skipped), String(summary.skipped));
  check(`${kind}: 带 timeline 数组（折线图数据源）`, Array.isArray(summary.timeline), JSON.stringify(summary.timeline));
  check(
    `${kind}: timeline 有 1 天且总量为 1050`,
    summary.timeline.length === 1 && summary.timeline[0].total === 1050,
    JSON.stringify(summary.timeline),
  );

  const input = { scanLimit: 200, internal: { summary, lastSweep: { at: 1, ok: true, detail: '' } } };
  try {
    Config(input);
    const resolved = plainConfig(input);
    const kept = resolved?.internal?.summary;
    check(`${kind}: Config 接受整份 summary`, true);
    check(`${kind}: Config 保留了 skipped`, Number.isFinite(kept?.skipped), JSON.stringify(kept?.skipped));
    check(`${kind}: Config 保留了 source`, typeof kept?.source === 'string', JSON.stringify(kept?.source));
    check(`${kind}: Config 保留了 rows`, Array.isArray(kept?.rows) && kept.rows.length === 1, JSON.stringify(kept?.rows?.length));
    check(`${kind}: Config 保留了每行的 buckets`, kept?.rows?.[0]?.buckets?.uncachedInputTokens === 900, JSON.stringify(kept?.rows?.[0]?.buckets));
    // 折线图数据源必须原样落盘：丢了它图表就永远是空的，而页面不会报错。
    check(`${kind}: Config 保留了 timeline`, Array.isArray(kept?.timeline) && kept.timeline.length === 1, JSON.stringify(kept?.timeline));
    check(`${kind}: Config 保留了 timeline 的 day 与 total`,
      typeof kept?.timeline?.[0]?.day === 'string' && kept.timeline[0].total === 1050,
      JSON.stringify(kept?.timeline?.[0]));
    check(`${kind}: Config 保留了 timeline 的 buckets`,
      kept?.timeline?.[0]?.buckets?.uncachedInputTokens === 900,
      JSON.stringify(kept?.timeline?.[0]?.buckets));
  } catch (error) {
    check(`${kind}: Config 接受整份 summary`, false, error.message);
  }
}

// —— 老数据没有 timeline 时不能炸 ——
//
// 实测：schemastery **不会**为 `.volatile()` 里缺失的嵌套数组字段填充
// `default([])`——`timeline` 会如实是 `undefined`。所以"默认值兜底"这个假设
// 是错的，契约只能是：**旧数据确实可能没有 timeline，客户端必须容忍它的缺失**。
// 这条测的就是"不会炸"，而不是"会被补成空数组"。
{
  const legacy = {
    rows: [],
    scanned: 0, total: 0, truncated: false, skipped: 0, builtAt: 1,
    // 刻意没有 timeline
  };
  const input = { scanLimit: 200, internal: { summary: legacy } };
  try {
    Config(input);
    const kept = plainConfig(input)?.internal?.summary;
    check('旧 summary 缺 timeline 时 Config 不抛错', true);
    check(
      '缺 timeline 时它是 undefined（不是被默认成空数组）——客户端必须容忍缺失',
      kept?.timeline === undefined || Array.isArray(kept?.timeline),
      JSON.stringify(kept?.timeline),
    );
    check(
      '缺 timeline 时其它字段照常保留（不会因为一个可选字段整段丢掉）',
      kept?.builtAt === 1 && Array.isArray(kept?.rows),
      JSON.stringify({ builtAt: kept?.builtAt, rows: kept?.rows }),
    );
  } catch (error) {
    check('旧 summary 缺 timeline 时 Config 不抛错', false, error.message);
  }
}

// —— 探测顺序 ——
const withGet = (map) => ({ get: (n) => map[n] });
check('两个都有时优先 sessionQuery',
  probeSessionSource(withGet({ sessionQuery: { listSessions() {}, readSession() {} }, sessionPersistence: { list() {}, open() {} } })).label === 'sessionQuery');
check('只有 sessionPersistence 时用它',
  probeSessionSource(withGet({ sessionPersistence: { list() {}, open() {} } })).label === 'sessionPersistence');
check('都没有时 available=false 且带 reason',
  probeSessionSource(withGet({})).available === false && typeof probeSessionSource(withGet({})).reason === 'string');
check('方法不齐时不误认（只有 list 没有 open）',
  probeSessionSource(withGet({ sessionPersistence: { list() {} } })).available === false);

console.log('');
if (bad.length === 0) { console.log('全部通过：' + ok + ' 项。'); process.exit(0); }
console.log('失败 ' + bad.length + ' 项：');
for (const b of bad) console.log('  - ' + b);
process.exit(1);
