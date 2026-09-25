#!/usr/bin/env node
/**
 * test-cron.mjs — lib/cron.js / lib/model.js 纯函数契约测试（零第三方依赖）。
 *
 * 规范来源：CONTRACT.md §2（数据模型）、§3（模块 API）、§6（验证契约）。
 * 用法：node scripts/test-cron.mjs
 * 退出码：0 = 全部通过；1 = 有断言失败；2 = lib 文件缺失或无法加载。
 *
 * 时间断言一律使用「显式构造的本地 Date」，不依赖运行日期，也不硬编码 UTC 偏移：
 * 期望值由 new Date(y, m-1, d, hh, mm) 在同一本地时区算出，运行多久都不会失效。
 * 契约里的 weekdays 用 1..7（周一=1），Date#getDay() 用 0..6（周日=0），
 * 两者转换集中在 wd() 里。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const libDir = path.join(root, 'lib');

/* ------------------------------------------------------------------ */
/* 最小 harness                                                        */
/* ------------------------------------------------------------------ */

let passed = 0;
const failures = [];
let sectionName = '(root)';
const missing = [];

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

function okEq(label, actual, expected) {
  return ok(label, Object.is(actual, expected), '期望 ' + fmt(expected) + '，实际 ' + fmt(actual));
}

function fmt(value) {
  if (value instanceof Date) return 'Date(' + value.toISOString() + ')';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'function') return '[function ' + (value.name || 'anonymous') + ']';
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

function capture(fn) {
  try {
    return { value: fn() };
  } catch (error) {
    return { error };
  }
}

/** 断言表达式被拒绝，且错误信息非空。 */
function expectReject(label, fn) {
  const result = capture(fn);
  if (result.error === undefined) {
    return ok(label, false, '未抛错，返回 ' + fmt(result.value));
  }
  const message = result.error instanceof Error ? result.error.message : '';
  return ok(
    label,
    typeof message === 'string' && message.trim().length > 0,
    '抛出的不是 Error，或 message 为空：' + fmt(result.error),
  );
}

/** 本地时间构造 -> epoch ms。 */
const at = (year, month, day, hh = 0, mm = 0, ss = 0, ms = 0) =>
  new Date(year, month - 1, day, hh, mm, ss, ms).getTime();

/** Date#getDay()(0=周日) -> 契约的 weekdays(1=周一..7=周日)。 */
const wd = (date) => (date.getDay() === 0 ? 7 : date.getDay());

/* ------------------------------------------------------------------ */
/* 加载被测模块（缺失时友好退出，不崩溃）                                */
/* ------------------------------------------------------------------ */

async function loadLib(name) {
  const file = path.join(libDir, name + '.js');
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

console.log('test-cron.mjs — CONTRACT.md §6 纯函数断言');
console.log('插件根目录：' + root);
console.log('运行时：node ' + process.version);

const cronModule = await loadLib('cron');
const modelModule = await loadLib('model');

const CRON_EXPORTS = ['parseCron', 'nextCronTime', 'nextScheduleTime', 'describeSchedule', 'validateSchedule'];
const MODEL_EXPORTS = ['newTaskId', 'normalizeTask', 'validateTask', 'isTaskDue', 'advanceTask', 'findTask'];

/* ================================================================== */
/* lib/cron.js                                                        */
/* ================================================================== */

if (cronModule !== undefined) {
  section('lib/cron.js 导出面（契约 §3）');
  let cronReady = true;
  for (const name of CRON_EXPORTS) {
    if (!ok('导出 ' + name + ' 函数', typeof cronModule[name] === 'function', '实际 ' + typeof cronModule[name])) {
      cronReady = false;
    }
  }

  const { parseCron, nextCronTime, nextScheduleTime, describeSchedule, validateSchedule } = cronModule;

  if (cronReady) {
    /* ------------------------------ parseCron 接受 ------------------------------ */
    section('parseCron 接受（契约 §2.2）');
    const accepted = [
      ['全部 *', '* * * * *'],
      ['单值', '30 9 * * *'],
      ['区间 a-b', '0-30 9-17 1-15 3-9 1-5'],
      ['步长 */n', '*/15 */2 */3 */2 */1'],
      ['区间步长 a-b/n', '0-30/10 8-18/2 1-20/5 1-11/3 1-6/1'],
      ['逗号列表', '1,15,30,45 0,12 1,15 1,6,12 0,3,6'],
      ['dow 0（周日）', '0 0 * * 0'],
      ['dow 7（周日）', '0 0 * * 7'],
      ['多余空白容错', '  5   0  *  *  *  '],
    ];
    for (const [label, expression] of accepted) {
      const result = capture(() => parseCron(expression));
      if (result.error !== undefined) {
        ok('接受 ' + label + '（' + expression + '）', false, result.error.message);
      } else {
        const value = result.value;
        // 契约 §3：parseCron 返回完整对象，五个字段是**已展开的升序数字数组**，
        // domStar/dowStar 保留 `*` 信息，expression 是归一化后的原文。
        ok(
          '接受 ' + label + '（' + expression + '）',
          value !== null && typeof value === 'object'
            && ['minute', 'hour', 'dom', 'month', 'dow'].every((key) => Array.isArray(value[key]))
            && typeof value.domStar === 'boolean'
            && typeof value.dowStar === 'boolean'
            && typeof value.expression === 'string',
          '返回 ' + fmt(value),
        );
      }
    }

    section('parseCron 展开与升序（契约 §3）');
    const expandedCases = [
      ['*/15', '*/15 * * * *', 'minute', [0, 15, 30, 45]],
      ['0-30/10', '0-30/10 8-18/2 1-20/5 1-11/3 1-6/1', 'minute', [0, 10, 20, 30]],
      ['1-5', '0-30 9-17 1-15 3-9 1-5', 'dow', [1, 2, 3, 4, 5]],
      ['0,3,6', '1,15,30,45 0,12 1,15 1,6,12 0,3,6', 'dow', [0, 3, 6]],
      ['*', '* * * * *', 'hour', Array.from({ length: 24 }, (_, index) => index)],
    ];
    for (const [label, expression, field, expected] of expandedCases) {
      const result = capture(() => parseCron(expression));
      const actual = result.error === undefined && result.value !== null ? result.value[field] : undefined;
      ok(
        'parseCron("' + expression + '").' + field + ' 展开为 ' + label + '（升序）',
        Array.isArray(actual) && JSON.stringify(actual) === JSON.stringify(expected),
        '实际 ' + fmt(actual),
      );
    }
    const starInfo = capture(() => parseCron('0 0 * * *'));
    ok(
      '日/周为 * 时 domStar / dowStar 为 true',
      starInfo.value !== null && starInfo.value.domStar === true && starInfo.value.dowStar === true,
      fmt(starInfo.value),
    );
    const nonStarInfo = capture(() => parseCron('0 0 1 * 1'));
    ok(
      '日/周非 * 时 domStar / dowStar 为 false',
      nonStarInfo.value !== null && nonStarInfo.value.domStar === false && nonStarInfo.value.dowStar === false,
      fmt(nonStarInfo.value),
    );

    /* ------------------------------ parseCron 拒绝 ------------------------------ */
    section('parseCron 拒绝且错误信息非空（契约 §2.2）');
    const rejected = [
      ['dom 中的 L', '0 0 L * *'],
      ['dow 中的 L', '0 0 * * L'],
      ['dom 中的 W', '0 0 15W * *'],
      ['dow 中的 #', '0 0 * * 5#2'],
      ['月份英文名', '0 0 * JAN *'],
      ['星期英文名', '0 0 * * MON'],
      ['@daily 宏', '@daily'],
      ['@hourly 宏', '@hourly'],
      ['六段', '0 0 0 * * *'],
      ['四段', '* * * *'],
      ['分钟越界 60', '60 * * * *'],
      ['小时越界 24', '* 24 * * *'],
      ['日越界 32', '* * 32 * *'],
      ['日为 0', '* * 0 * *'],
      ['月越界 13', '* * * 13 *'],
      ['月为 0', '* * * 0 *'],
      ['dow 越界 8', '* * * * 8'],
      ['倒置区间 30-10', '30-10 * * * *'],
      ['步长 0 */0', '*/0 * * * *'],
      ['区间步长 0', '0-30/0 * * * *'],
      ['空串', ''],
      ['null', null],
      ['数字 5', 5],
      ['裸字母', 'a * * * *'],
      ['尾随逗号', '1, * * * *'],
    ];
    for (const [label, expression] of rejected) {
      expectReject('拒绝 ' + label + '（' + fmt(expression) + '）', () => parseCron(expression));
    }

    /* ------------------------------ nextCronTime ------------------------------ */
    section('nextCronTime（契约 §3：超过 5 年无解返回 null）');
    const cronFrom = at(2026, 1, 5, 10, 7); // 2026-01-05 周一 10:07（本地）
    okEq('*/15 从 10:07 -> 10:15', nextCronTime(parseCron('*/15 * * * *'), cronFrom), at(2026, 1, 5, 10, 15));
    okEq('0 * * * * 从 10:07 -> 11:00', nextCronTime(parseCron('0 * * * *'), cronFrom), at(2026, 1, 5, 11, 0));
    okEq(
      '0 9 * * 1-5 从周一 10:00 -> 周二 09:00',
      nextCronTime(parseCron('0 9 * * 1-5'), at(2026, 1, 5, 10, 0)),
      at(2026, 1, 6, 9, 0),
    );
    okEq(
      '0 0 1 * * 从 2026-01-05 -> 2026-02-01 00:00',
      nextCronTime(parseCron('0 0 1 * *'), at(2026, 1, 5, 10, 0)),
      at(2026, 2, 1, 0, 0),
    );
    okEq(
      '0 0 1 1 * 跨年 -> 2027-01-01 00:00',
      nextCronTime(parseCron('0 0 1 1 *'), at(2026, 3, 5, 10, 0)),
      at(2027, 1, 1, 0, 0),
    );
    okEq(
      'dow 0 与 dow 7 指向同一个周日',
      nextCronTime(parseCron('0 0 * * 0'), at(2026, 1, 5, 12, 0)),
      nextCronTime(parseCron('0 0 * * 7'), at(2026, 1, 5, 12, 0)),
    );
    okEq(
      'dow 0 从周一 -> 2026-01-11（周日）00:00',
      nextCronTime(parseCron('0 0 * * 0'), at(2026, 1, 5, 12, 0)),
      at(2026, 1, 11, 0, 0),
    );
    okEq('2 月 30 日五年内无解 -> null', nextCronTime(parseCron('0 0 30 2 *'), cronFrom), null);
    const stepTime = nextCronTime(parseCron('*/15 * * * *'), cronFrom);
    ok('结果严格晚于 fromMs', typeof stepTime === 'number' && stepTime > cronFrom, fmt(stepTime));

    /* ------------------------------ nextScheduleTime ------------------------------ */
    section('nextScheduleTime — every');
    okEq(
      'every 30 分钟 = fromMs + 1800000',
      nextScheduleTime({ kind: 'every', everyMinutes: 30 }, cronFrom),
      cronFrom + 30 * 60000,
    );
    okEq(
      'every 下界 30 分钟同样成立',
      nextScheduleTime({ kind: 'every', everyMinutes: 30 }, at(2026, 1, 5, 0, 0)),
      at(2026, 1, 5, 0, 30),
    );

    section('nextScheduleTime — daily（本地时区）');
    okEq(
      '当天未到（08:00 求 09:00）-> 当天 09:00',
      nextScheduleTime({ kind: 'daily', time: '09:00' }, at(2026, 1, 5, 8, 0)),
      at(2026, 1, 5, 9, 0),
    );
    okEq(
      '当天已过（10:00 求 09:00）-> 次日 09:00',
      nextScheduleTime({ kind: 'daily', time: '09:00' }, at(2026, 1, 5, 10, 0)),
      at(2026, 1, 6, 9, 0),
    );
    okEq(
      '正好等于目标时刻（契约 §2.2 严格大于）-> 次日 09:00',
      nextScheduleTime({ kind: 'daily', time: '09:00' }, at(2026, 1, 5, 9, 0)),
      at(2026, 1, 6, 9, 0),
    );
    okEq(
      '跨月：1 月 31 日 10:00 求 09:00 -> 2 月 1 日 09:00',
      nextScheduleTime({ kind: 'daily', time: '09:00' }, at(2026, 1, 31, 10, 0)),
      at(2026, 2, 1, 9, 0),
    );
    okEq(
      '午夜 00:00 从 23:59 -> 次日 00:00',
      nextScheduleTime({ kind: 'daily', time: '00:00' }, at(2026, 1, 5, 23, 59)),
      at(2026, 1, 6, 0, 0),
    );

    section('nextScheduleTime — weekly（周一=1 ... 周日=7）');
    okEq(
      '周一 12:00 求周一 09:00 -> 下周一（跨周）',
      nextScheduleTime({ kind: 'weekly', time: '09:00', weekdays: [1] }, at(2026, 1, 5, 12, 0)),
      at(2026, 1, 12, 9, 0),
    );
    okEq(
      '周一 08:00 求周一 09:00 -> 当天 09:00',
      nextScheduleTime({ kind: 'weekly', time: '09:00', weekdays: [1] }, at(2026, 1, 5, 8, 0)),
      at(2026, 1, 5, 9, 0),
    );
    okEq(
      '正好等于本周一 09:00（严格大于）-> 下周一 09:00',
      nextScheduleTime({ kind: 'weekly', time: '09:00', weekdays: [1] }, at(2026, 1, 5, 9, 0)),
      at(2026, 1, 12, 9, 0),
    );
    okEq(
      '周一 12:00 求周三 08:00 -> 本周三 2026-01-07',
      nextScheduleTime({ kind: 'weekly', time: '08:00', weekdays: [3] }, at(2026, 1, 5, 12, 0)),
      at(2026, 1, 7, 8, 0),
    );
    okEq(
      '周一 12:00 求 Sunday（weekdays=[7]）10:00 -> 2026-01-11',
      nextScheduleTime({ kind: 'weekly', time: '10:00', weekdays: [7] }, at(2026, 1, 5, 12, 0)),
      at(2026, 1, 11, 10, 0),
    );
    okEq(
      '周五 20:00 求周一 07:00 -> 下周一 2026-01-12',
      nextScheduleTime({ kind: 'weekly', time: '07:00', weekdays: [1] }, at(2026, 1, 9, 20, 0)),
      at(2026, 1, 12, 7, 0),
    );
    const weeklyResult = nextScheduleTime(
      { kind: 'weekly', time: '09:00', weekdays: [1, 3, 5] },
      at(2026, 1, 6, 12, 0), // 周二 12:00
    );
    const weeklyDate = new Date(weeklyResult);
    ok('结果落在 weekdays 内（周三）', wd(weeklyDate) === 3, '得到 weekdays=' + wd(weeklyDate));
    okEq('结果精确为 2026-01-07 09:00', weeklyResult, at(2026, 1, 7, 9, 0));
    okEq(
      '结果 >= fromMs',
      weeklyResult >= at(2026, 1, 6, 12, 0),
      true,
    );

    section('nextScheduleTime — cron（步长）');
    okEq(
      '*/15 从 10:07 -> 10:15',
      nextScheduleTime({ kind: 'cron', expression: '*/15 * * * *' }, cronFrom),
      at(2026, 1, 5, 10, 15),
    );
    okEq(
      '正好等于 10:15（*/15，严格大于）-> 10:30',
      nextScheduleTime({ kind: 'cron', expression: '*/15 * * * *' }, at(2026, 1, 5, 10, 15)),
      at(2026, 1, 5, 10, 30),
    );
    okEq(
      'nextScheduleTime(cron) 与 nextCronTime(parseCron) 一致',
      nextScheduleTime({ kind: 'cron', expression: '*/15 * * * *' }, cronFrom),
      nextCronTime(parseCron('*/15 * * * *'), cronFrom),
    );
    okEq(
      '工作日 09:00 从周一 10:00 -> 周二 09:00',
      nextScheduleTime({ kind: 'cron', expression: '0 9 * * 1-5' }, at(2026, 1, 5, 10, 0)),
      at(2026, 1, 6, 9, 0),
    );
    okEq(
      '每月 1 日 00:00 从 2026-01-05 -> 2026-02-01',
      nextScheduleTime({ kind: 'cron', expression: '0 0 1 * *' }, at(2026, 1, 5, 10, 0)),
      at(2026, 2, 1, 0, 0),
    );

    section('nextScheduleTime — once');
    okEq('过去时间 -> null', nextScheduleTime({ kind: 'once', at: cronFrom - 1 }, cronFrom), null);
    okEq('at === fromMs -> null（契约要求严格大于）', nextScheduleTime({ kind: 'once', at: cronFrom }, cronFrom), null);
    okEq(
      '未来时间 -> at',
      nextScheduleTime({ kind: 'once', at: cronFrom + 60000 }, cronFrom),
      cronFrom + 60000,
    );

    /* ------------------------------ validateSchedule ------------------------------ */
    section('validateSchedule（契约 §2.2）');
    const validSchedules = [
      ['every 下界 30', { kind: 'every', everyMinutes: 30 }],
      ['every 上界 43200', { kind: 'every', everyMinutes: 43200 }],
      ['daily 09:00', { kind: 'daily', time: '09:00' }],
      ['weekly [1,3,5]', { kind: 'weekly', time: '08:30', weekdays: [1, 3, 5] }],
      ['cron 五段', { kind: 'cron', expression: '*/15 * * * *' }],
      ['once 未来', { kind: 'once', at: at(2099, 1, 1, 0, 0) }],
    ];
    for (const [label, schedule] of validSchedules) {
      const result = validateSchedule(schedule);
      ok('接受 ' + label, result === null, '实际 ' + fmt(result));
    }

    const invalidSchedules = [
      ['未知 kind', { kind: 'monthly' }],
      ['缺 kind', {}],
      ['every 低于下界 29', { kind: 'every', everyMinutes: 29 }],
      ['every 高于上界 43201', { kind: 'every', everyMinutes: 43201 }],
      ['every 非数字', { kind: 'every', everyMinutes: '30' }],
      ['daily 未补零 9:00', { kind: 'daily', time: '9:00' }],
      ['daily 越界 24:00', { kind: 'daily', time: '24:00' }],
      ['daily 越界 09:60', { kind: 'daily', time: '09:60' }],
      ['weekly 空数组', { kind: 'weekly', time: '09:00', weekdays: [] }],
      ['weekly weekday 0', { kind: 'weekly', time: '09:00', weekdays: [0] }],
      ['weekly weekday 8', { kind: 'weekly', time: '09:00', weekdays: [8] }],
      ['cron 宏', { kind: 'cron', expression: '@daily' }],
      ['cron 六段', { kind: 'cron', expression: '0 0 0 * * *' }],
      ['once 非数字', { kind: 'once', at: 'soon' }],
    ];
    for (const [label, schedule] of invalidSchedules) {
      const result = validateSchedule(schedule);
      ok('拒绝 ' + label, typeof result === 'string' && result.trim().length > 0, '实际 ' + fmt(result));
    }

    /* ------------------------------ describeSchedule ------------------------------ */
    section('describeSchedule（契约 §3：人类可读中文串）');
    const described = [
      ['every', { kind: 'every', everyMinutes: 30 }],
      ['daily', { kind: 'daily', time: '09:00' }],
      ['weekly', { kind: 'weekly', time: '08:30', weekdays: [1, 3, 5] }],
      ['cron', { kind: 'cron', expression: '*/15 * * * *' }],
      ['once', { kind: 'once', at: at(2099, 1, 1, 0, 0) }],
    ];
    for (const [label, schedule] of described) {
      const text = capture(() => describeSchedule(schedule));
      ok(
        'describeSchedule(' + label + ') 返回非空字符串',
        text.error === undefined && typeof text.value === 'string' && text.value.trim().length > 0,
        text.error === undefined ? fmt(text.value) : text.error.message,
      );
    }
    const everyText = capture(() => describeSchedule({ kind: 'every', everyMinutes: 30 }));
    ok('every 描述包含分钟数 30', typeof everyText.value === 'string' && /30/.test(everyText.value), fmt(everyText.value));
    const dailyText = capture(() => describeSchedule({ kind: 'daily', time: '09:00' }));
    ok(
      'daily 描述包含 09:00（允许 9:00）',
      typeof dailyText.value === 'string' && /09?[:\uff1a]00/.test(dailyText.value),
      fmt(dailyText.value),
    );
  }
}

/* ================================================================== */
/* lib/model.js                                                       */
/* ================================================================== */

if (modelModule !== undefined) {
  section('lib/model.js 导出面（契约 §3）');
  let modelReady = true;
  for (const name of MODEL_EXPORTS) {
    if (!ok('导出 ' + name + ' 函数', typeof modelModule[name] === 'function', '实际 ' + typeof modelModule[name])) {
      modelReady = false;
    }
  }

  const { newTaskId, normalizeTask, validateTask, isTaskDue, advanceTask, findTask } = modelModule;

  if (modelReady) {
    const ID_SHAPE = /^t[0-9a-z]+[0-9a-z]{8}$/;

    /* ------------------------------ newTaskId ------------------------------ */
    section('newTaskId（契约 §2.1 + §3：t + base36 时间戳 + 8 位 base36 随机）');
    const nowMs = at(2026, 1, 5, 10, 0);
    const prefix = 't' + nowMs.toString(36);
    // 注入一个永不返回 0 的确定性序列：d/36 的 base36 小数恰好是单个数字字符。
    const sequenceRandom = (digits) => {
      let cursor = 0;
      return () => digits[cursor++ % digits.length] / 36;
    };
    const idA = newTaskId(nowMs, sequenceRandom([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    const idB = newTaskId(nowMs, sequenceRandom([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    ok('返回字符串', typeof idA === 'string', fmt(idA));
    ok('以 t + base36 时间戳开头', typeof idA === 'string' && idA.startsWith(prefix), fmt(idA));
    ok('整体形状符合 ^t[0-9a-z]+[0-9a-z]{8}$', typeof idA === 'string' && ID_SHAPE.test(idA), fmt(idA));
    okEq('后缀恰为 8 位', idA.length, prefix.length + 8);
    ok('同参同 random 结果一致（纯函数）', idA === idB, fmt(idA) + ' vs ' + fmt(idB));
    ok(
      '不同 random 给出不同 id',
      newTaskId(nowMs, () => 1 / 36) !== newTaskId(nowMs, () => 2 / 36),
      fmt(newTaskId(nowMs, () => 1 / 36)),
    );
    const defaultRandomId = newTaskId(Date.now());
    ok('random 缺省（Math.random）仍返回合法形状', typeof defaultRandomId === 'string' && ID_SHAPE.test(defaultRandomId), fmt(defaultRandomId));

    const uniqueIds = new Set();
    for (let index = 0; index < 2000; index += 1) uniqueIds.add(newTaskId(nowMs, Math.random));
    ok('固定时间戳下 2000 次生成互不相同', uniqueIds.size === 2000, '不重复 ' + uniqueIds.size + ' / 2000');
    const stampIds = new Set();
    for (let index = 0; index < 1000; index += 1) stampIds.add(newTaskId(nowMs + index, Math.random));
    ok('时间戳递增的 1000 个 id 互不相同', stampIds.size === 1000, '不重复 ' + stampIds.size + ' / 1000');

    section('newTaskId 边界健壮性（random 注入必须能终止）');
    // random = () => 0 时 (0).toString(36).slice(2) === ''，while 循环需要终止保护。
    // 同进程内测会挂死，所以放到子进程里带超时探测。
    let zeroProbe = 'spawn-error';
    try {
      const modelUrl = pathToFileURL(path.join(libDir, 'model.js')).href;
      const probe = spawnSync(
        process.execPath,
        ['-e', `import(${JSON.stringify(modelUrl)}).then((m)=>{process.stdout.write(String(m.newTaskId(0, () => 0)));});`],
        { timeout: 5000, encoding: 'utf8' },
      );
      if (probe.error !== undefined && probe.error.code === 'ETIMEDOUT') zeroProbe = 'timeout';
      else if (probe.error !== undefined) zeroProbe = 'spawn-error:' + probe.error.code;
      else zeroProbe = 'value:' + String(probe.stdout || '').trim();
    } catch (error) {
      zeroProbe = 'spawn-error:' + error.message;
    }
    ok(
      'newTaskId(nowMs, () => 0) 会返回而不是死循环',
      zeroProbe.startsWith('value:'),
      zeroProbe === 'timeout'
        ? '子进程 5 秒未返回：random=()=>0 时 chunk 为空串，while (suffix.length < 8) 永不满足'
        : zeroProbe,
    );

    /* ------------------------------ normalizeTask ------------------------------ */
    section('normalizeTask 接受与归一化（契约 §2.1）');
    const validInput = {
      title: '  早上汇报  ',
      prompt: '  汇总昨天的 git 提交  ',
      schedule: { kind: 'daily', time: '09:00' },
      enabled: true,
      skill: 'scheduled-tasks',
      tools: ['scheduled_task_list'],
      workspaceRoot: 'E:/repo',
      model: { provider: 'deepseek', model: 'c1' },
    };
    const inputSnapshot = JSON.stringify(validInput);
    const normalized = capture(() => normalizeTask(validInput, nowMs));
    if (normalized.error !== undefined) {
      ok('normalizeTask 合法输入不抛错', false, normalized.error.message);
    } else {
      const task = normalized.value && normalized.value.task;
      ok('合法输入返回 { task }', task !== null && typeof task === 'object' && normalized.value.error === undefined, fmt(normalized.value));
      okEq('title 去掉首尾空白', task && task.title, '早上汇报');
      okEq('prompt 去掉首尾空白', task && task.prompt, '汇总昨天的 git 提交');
      okEq('createdAt = nowMs', task && task.createdAt, nowMs);
      okEq('updatedAt = nowMs', task && task.updatedAt, nowMs);
      ok('id 形状合法', typeof (task && task.id) === 'string' && ID_SHAPE.test(task.id), fmt(task && task.id));
      okEq('enabled 保留', task && task.enabled, true);
      okEq('skill 保留', task && task.skill, 'scheduled-tasks');
      ok('tools 保留', Array.isArray(task && task.tools) && task.tools[0] === 'scheduled_task_list', fmt(task && task.tools));
      okEq('workspaceRoot 保留', task && task.workspaceRoot, 'E:/repo');
      ok('model 覆盖保留', (task && task.model && task.model.provider === 'deepseek' && task.model.model === 'c1') === true, fmt(task && task.model));
      ok(
        'schedule 原样保留',
        (task && task.schedule && task.schedule.kind === 'daily' && task.schedule.time === '09:00') === true,
        fmt(task && task.schedule),
      );
      ok('不修改输入对象（纯函数）', JSON.stringify(validInput) === inputSnapshot, JSON.stringify(validInput));
    }

    const defaultEnabled = capture(() => normalizeTask(
      { title: 't', prompt: 'p', schedule: { kind: 'every', everyMinutes: 60 } },
      nowMs,
    ));
    ok('未给 enabled 时默认 true', defaultEnabled.value && defaultEnabled.value.task && defaultEnabled.value.task.enabled === true, fmt(defaultEnabled.value));

    const boundary120 = capture(() => normalizeTask(
      { title: 'x'.repeat(120), prompt: 'p', schedule: { kind: 'every', everyMinutes: 30 } },
      nowMs,
    ));
    ok('title 恰好 120 字被接受', boundary120.value && boundary120.value.task !== undefined && boundary120.error === undefined, fmt(boundary120.value && boundary120.value.error));
    const boundary20000 = capture(() => normalizeTask(
      { title: 't', prompt: 'y'.repeat(20000), schedule: { kind: 'every', everyMinutes: 30 } },
      nowMs,
    ));
    ok('prompt 恰好 20000 字被接受', boundary20000.value && boundary20000.value.task !== undefined && boundary20000.error === undefined, fmt(boundary20000.value && boundary20000.value.error));

    section('normalizeTask options（契约 §3：{ id?, random? }）');
    const bare = { title: 't', prompt: 'p', schedule: { kind: 'every', everyMinutes: 30 } };
    const withId = capture(() => normalizeTask(bare, nowMs, { id: 'tcustom00' }));
    okEq('options.id 被采用', withId.value && withId.value.task && withId.value.task.id, 'tcustom00');
    const withInputId = capture(() => normalizeTask({ ...bare, id: 'tinput00' }, nowMs));
    okEq('input.id 被沿用（更新既有任务时不换 id）', withInputId.value && withInputId.value.task && withInputId.value.task.id, 'tinput00');
    const randomA = capture(() => normalizeTask(bare, nowMs, { random: () => 0.5 }));
    const randomB = capture(() => normalizeTask(bare, nowMs, { random: () => 0.5 }));
    ok(
      'options.random 让生成的 id 可复现',
      randomA.value && randomA.value.task && randomB.value && randomB.value.task
        && randomA.value.task.id === randomB.value.task.id
        && ID_SHAPE.test(randomA.value.task.id),
      fmt(randomA.value && randomA.value.task && randomA.value.task.id),
    );
    const keepCreated = capture(() => normalizeTask({ ...bare, createdAt: 123456 }, nowMs));
    okEq('已有 createdAt 被保留（只有 updatedAt 刷新）', keepCreated.value && keepCreated.value.task && keepCreated.value.task.createdAt, 123456);

    section('normalizeTask 拒绝（契约 §2.1：返回 { error } 而非抛错）');
    const everyOk = { kind: 'every', everyMinutes: 30 };
    const badInputs = [
      ['title 空串', { title: '', prompt: 'p', schedule: everyOk }],
      ['title 全空白', { title: '   ', prompt: 'p', schedule: everyOk }],
      ['title 缺失', { prompt: 'p', schedule: everyOk }],
      ['title 超 120 字', { title: 'x'.repeat(121), prompt: 'p', schedule: everyOk }],
      ['prompt 空串', { title: 't', prompt: '', schedule: everyOk }],
      ['prompt 全空白', { title: 't', prompt: '  ', schedule: everyOk }],
      ['prompt 缺失', { title: 't', schedule: everyOk }],
      ['prompt 超 20000 字', { title: 't', prompt: 'x'.repeat(20001), schedule: everyOk }],
      ['schedule 缺失', { title: 't', prompt: 'p' }],
      ['schedule 空对象', { title: 't', prompt: 'p', schedule: {} }],
      ['schedule daily 越界', { title: 't', prompt: 'p', schedule: { kind: 'daily', time: '25:00' } }],
      ['schedule every 越界', { title: 't', prompt: 'p', schedule: { kind: 'every', everyMinutes: 1 } }],
      ['schedule weekly 空', { title: 't', prompt: 'p', schedule: { kind: 'weekly', time: '09:00', weekdays: [] } }],
      ['schedule cron 非法', { title: 't', prompt: 'p', schedule: { kind: 'cron', expression: '@daily' } }],
      ['schedule once 类型错', { title: 't', prompt: 'p', schedule: { kind: 'once', at: 'later' } }],
      ['输入为 null', null],
      ['输入为字符串', 'nope'],
    ];
    for (const [label, bad] of badInputs) {
      const result = capture(() => normalizeTask(bad, nowMs));
      if (result.error !== undefined) {
        ok('拒绝 ' + label, false, '抛出了异常（' + result.error.message + '），契约要求返回 { task } | { error }');
        continue;
      }
      const message = result.value && typeof result.value.error === 'string' ? result.value.error : '';
      ok('拒绝 ' + label, message.trim().length > 0, '返回 ' + fmt(result.value));
    }

    /* ------------------------------ validateTask ------------------------------ */
    section('validateTask（契约 §3）');
    const goodTask = {
      id: 'tabc0000',
      title: 't',
      prompt: 'p',
      enabled: true,
      schedule: { kind: 'every', everyMinutes: 30 },
      createdAt: nowMs,
      updatedAt: nowMs,
    };
    ok('接受合法任务 -> null', validateTask(goodTask) === null, fmt(validateTask(goodTask)));
    const badTasks = [
      ['空 title', { ...goodTask, title: '' }],
      ['title 超长', { ...goodTask, title: 'x'.repeat(121) }],
      ['空 prompt', { ...goodTask, prompt: '   ' }],
      ['id 缺失', { ...goodTask, id: '' }],
      ['schedule 非法', { ...goodTask, schedule: { kind: 'weekly', time: '09:00', weekdays: [] } }],
      ['enabled 非布尔', { ...goodTask, enabled: 'yes' }],
    ];
    for (const [label, task] of badTasks) {
      const result = validateTask(task);
      ok('拒绝 ' + label, typeof result === 'string' && result.trim().length > 0, '实际 ' + fmt(result));
    }

    /* ------------------------------ isTaskDue ------------------------------ */
    section('isTaskDue（契约 §3）');
    const dueNow = at(2026, 1, 5, 10, 0);
    okEq('enabled 且 nextRunAt 已过 -> true', isTaskDue({ enabled: true, nextRunAt: dueNow - 1 }, dueNow), true);
    okEq('enabled 且 nextRunAt 未到 -> false', isTaskDue({ enabled: true, nextRunAt: dueNow + 60000 }, dueNow), false);
    okEq('enabled=false 且已到期 -> false', isTaskDue({ enabled: false, nextRunAt: dueNow - 1 }, dueNow), false);
    okEq('enabled=false 且未到期 -> false', isTaskDue({ enabled: false, nextRunAt: dueNow + 60000 }, dueNow), false);
    okEq(
      'once 且 at 已过 -> true',
      isTaskDue({ enabled: true, schedule: { kind: 'once', at: dueNow - 1 } }, dueNow),
      true,
    );
    okEq(
      'once 且 at 未到 -> false',
      isTaskDue({ enabled: true, schedule: { kind: 'once', at: dueNow + 1 } }, dueNow),
      false,
    );
    okEq(
      '缺 nextRunAt 时不误触发 -> false',
      isTaskDue({ enabled: true, schedule: { kind: 'daily', time: '08:00' } }, dueNow),
      false,
    );
    console.log('  info 缺 nextRunAt = 尚未排定，按契约判为不触发；排期由 ensureNextRun / prime() 补齐');
    ok(
      '返回布尔值（无 nextRunAt 时不抛错）',
      typeof capture(() => isTaskDue({ enabled: true }, dueNow)).value === 'boolean',
      fmt(capture(() => isTaskDue({ enabled: true }, dueNow)).value),
    );

    /* ------------------------------ advanceTask ------------------------------ */
    section('advanceTask（契约 §3：advanceTask(task, { nowMs, status }) -> 新 task，不改原对象）');
    const sourceTask = {
      id: 'tabc0000',
      title: 't',
      prompt: 'p',
      enabled: true,
      schedule: { kind: 'every', everyMinutes: 60 },
      createdAt: 1,
      updatedAt: 1,
      nextRunAt: 100,
    };
    const sourceSnapshot = JSON.stringify(sourceTask);
    const advanced = capture(() => advanceTask(sourceTask, { nowMs: dueNow, status: 'ok' }));
    if (advanced.error !== undefined) {
      ok('advanceTask 不抛错', false, advanced.error.message);
    } else {
      const next = advanced.value;
      ok('返回对象且不是原对象', next !== null && typeof next === 'object' && next !== sourceTask, fmt(next));
      okEq('lastRunAt = outcome.nowMs', next && next.lastRunAt, dueNow);
      okEq('updatedAt = outcome.nowMs', next && next.updatedAt, dueNow);
      okEq('lastStatus = outcome.status', next && next.lastStatus, 'ok');
      okEq('every 的 nextRunAt 按时间表重算（nowMs + 60 分钟）', next && next.nextRunAt, dueNow + 3600000);
      ok('保留 id/title/prompt/schedule', (
        next && next.id === 'tabc0000' && next.title === 't' && next.prompt === 'p' &&
        next.schedule && next.schedule.kind === 'every' && next.schedule.everyMinutes === 60
      ) === true, fmt(next));
      ok('原对象未被修改', JSON.stringify(sourceTask) === sourceSnapshot, JSON.stringify(sourceTask));
    }

    const deadEnd = capture(() => advanceTask(
      { ...sourceTask, schedule: { kind: 'cron', expression: '0 0 30 2 *' } },
      { nowMs: dueNow, status: 'ok' },
    ));
    ok(
      '无解时间表（2 月 30 日）推进后删除 nextRunAt',
      deadEnd.error === undefined && deadEnd.value.nextRunAt === undefined,
      fmt(deadEnd.value && deadEnd.value.nextRunAt),
    );

    const onceTask = {
      id: 'tabc0001',
      title: 't',
      prompt: 'p',
      enabled: true,
      schedule: { kind: 'once', at: dueNow + 1000 },
      createdAt: 1,
      updatedAt: 1,
      nextRunAt: dueNow + 1000,
    };
    const onceSnapshot = JSON.stringify(onceTask);
    const advancedOnce = capture(() => advanceTask(onceTask, { nowMs: dueNow, status: 'ok' }));
    if (advancedOnce.error !== undefined) {
      ok('advanceTask 处理 once 任务不抛错', false, advancedOnce.error.message);
    } else {
      ok('once 推进后置 enabled=false（契约 §2.2）', advancedOnce.value.enabled === false, fmt(advancedOnce.value.enabled));
      ok('once 推进后删除 nextRunAt（契约 §2.2）', !('nextRunAt' in advancedOnce.value), fmt(advancedOnce.value.nextRunAt));
      okEq('once 仍写 lastRunAt', advancedOnce.value.lastRunAt, dueNow);
    }
    ok('once 原对象未被修改', JSON.stringify(onceTask) === onceSnapshot, JSON.stringify(onceTask));
    ok('连续两次 advance 仍不改原对象', JSON.stringify(sourceTask) === sourceSnapshot, JSON.stringify(sourceTask));

    /* ------------------------------ findTask ------------------------------ */
    section('findTask（契约 §3）');
    okEq('命中返回同一个对象', findTask([sourceTask], 'tabc0000'), sourceTask);
    okEq('未命中返回 undefined', findTask([sourceTask], 'nope'), undefined);
    okEq('空数组返回 undefined', findTask([], 'tabc0000'), undefined);
  }
}

/* ------------------------------------------------------------------ */
/* 汇总                                                                */
/* ------------------------------------------------------------------ */

console.log('\n' + '='.repeat(64));
if (missing.length > 0) {
  console.log('缺失 / 无法加载（宿主模块尚未就位）：');
  for (const item of missing) console.log('  - ' + item.file + ' —— ' + item.reason);
  console.log('已通过 ' + passed + ' 项，失败 ' + failures.length + ' 项；其余断言需要上述文件就位后重跑。');
  process.exit(2);
}
if (failures.length > 0) {
  console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项：');
  for (const item of failures) console.log('  - ' + item);
  process.exit(1);
}
console.log('全部通过：' + passed + ' 项断言。');
process.exit(0);
