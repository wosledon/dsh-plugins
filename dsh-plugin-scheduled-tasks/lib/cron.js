/**
 * 调度时间计算（纯函数，无副作用，可单测）。
 *
 * 支持 CONTRACT.md §2.2 的五种 schedule。daily / weekly / cron 一律按**宿主本地
 * 时区**求下一次触发时间：本地时区是用户写「每天 9 点」时心里的那个时区，
 * 也是界面展示 `nextRunAt` 时用的那个时区。
 */

/** cron 字段越界时的上界。 */
const FIELD_RANGES = {
  minute: [0, 59],
  hour: [0, 23],
  dom: [1, 31],
  month: [1, 12],
  // 0 与 7 都是周日；解析后统一归一化到 0..6（0 = 周日）。
  dow: [0, 7],
};

/** 扫描上限：约 5 年。超过即认为无解（例如 2 月 30 日）。 */
const MAX_SCAN_MINUTES = 5 * 366 * 24 * 60;

/**
 * 解析 cron 表达式。
 *
 * 方言严格限制为五段 Vixie：`minute hour day-of-month month day-of-week`。
 * 每段支持 `*`、单值、`a-b`、星号步长（如 `*` 后接 `/15`）、区间步长、逗号列表。
 * 明确拒绝 `L` / `W` / `#` / 月份或星期英文名 / `@daily` 一类宏 / 六段 / 越界 /
 * 倒置区间 / 步长为 0 —— 这些错误必须在创建任务时就让用户看到，
 * 而不是静默算出一个他不想要的时间。
 *
 * @param {string} expression
 * @returns {{ minute: number[], hour: number[], dom: number[], month: number[], dow: number[],
 *             domStar: boolean, dowStar: boolean, expression: string }}
 * @throws {Error} 消息中会指明出错的字段名。
 */
export function parseCron(expression) {
  if (typeof expression !== 'string') throw new Error('cron 表达式必须是字符串');
  const text = expression.trim();
  if (text === '') throw new Error('cron 表达式不能为空');
  if (text.startsWith('@')) {
    throw new Error(`cron 不支持 @ 宏（收到 "${text}"）；请使用五段表达式，例如 "0 9 * * *"`);
  }
  const fields = text.split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron 必须是五段（分 时 日 月 周），收到 ${fields.length} 段："${text}"`);
  }

  const names = ['minute', 'hour', 'dom', 'month', 'dow'];
  const labels = ['分钟', '小时', '日', '月', '星期'];
  const parsed = {};
  for (let index = 0; index < 5; index += 1) {
    parsed[names[index]] = parseField(fields[index], names[index], labels[index]);
  }

  return {
    minute: parsed.minute.values,
    hour: parsed.hour.values,
    dom: parsed.dom.values,
    month: parsed.month.values,
    dow: parsed.dow.values,
    domStar: parsed.dom.star,
    dowStar: parsed.dow.star,
    expression: text,
  };
}

/**
 * 解析单个字段。
 * @returns {{ values: number[], star: boolean }}
 */
function parseField(text, field, label) {
  if (text === '') throw new Error(`cron ${label}字段为空`);
  const [min, max] = FIELD_RANGES[field];
  const star = text.startsWith('*');
  const values = new Set();

  for (const piece of text.split(',')) {
    if (piece === '') throw new Error(`cron ${label}字段 "${text}" 含空的列表项`);
    if (/[LW#]/i.test(piece)) {
      throw new Error(`cron ${label}字段不支持 L / W / #（收到 "${piece}"）`);
    }
    if (/[A-Za-z]/.test(piece)) {
      throw new Error(`cron ${label}字段不支持英文名（收到 "${piece}"），请使用数字`);
    }

    let step = 1;
    let body = piece;
    const slash = piece.indexOf('/');
    if (slash !== -1) {
      body = piece.slice(0, slash);
      const stepText = piece.slice(slash + 1);
      if (!/^\d+$/.test(stepText)) throw new Error(`cron ${label}字段步长非法："${piece}"`);
      step = Number(stepText);
      if (step < 1) throw new Error(`cron ${label}字段步长必须 >= 1（收到 "${piece}"）`);
    }

    let from;
    let to;
    if (body === '*') {
      from = min;
      to = max;
    } else if (body.includes('-')) {
      const parts = body.split('-');
      if (parts.length !== 2 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) {
        throw new Error(`cron ${label}字段区间非法："${piece}"`);
      }
      from = Number(parts[0]);
      to = Number(parts[1]);
      if (from > to) throw new Error(`cron ${label}字段区间倒置："${piece}"`);
    } else {
      if (!/^\d+$/.test(body)) throw new Error(`cron ${label}字段值非法："${piece}"`);
      from = Number(body);
      to = from;
    }

    if (from < min || to > max) {
      throw new Error(`cron ${label}字段越界（允许 ${min}-${max}）："${piece}"`);
    }
    for (let value = from; value <= to; value += step) values.add(value);
  }

  if (values.size === 0) throw new Error(`cron ${label}字段没有匹配任何值："${text}"`);

  const list = [...values].sort((left, right) => left - right);
  if (field === 'dow') {
    // 7 与 0 都是周日；归一化到 0..6，避免同一天出现两个值。
    const normalized = new Set(list.map((value) => (value === 7 ? 0 : value)));
    return { values: [...normalized].sort((left, right) => left - right), star };
  }
  return { values: list, star };
}

/**
 * 求 `fromMs` 之后第一个匹配该 cron 的时刻。
 *
 * 逐分钟线性扫描：cron 最小粒度是分钟，扫描上界 5 年（约 260 万次纯数值比较），
 * 相对一次大模型运行的开销可以忽略，换来的是「任何方言边角都不会算错」。
 *
 * @param {ReturnType<typeof parseCron>} parsed
 * @param {number} fromMs 不含该时刻（严格大于）
 * @returns {number|null} epoch ms，超过扫描上界返回 null
 */
export function nextCronTime(parsed, fromMs) {
  const start = Math.floor(fromMs / 60_000) * 60_000 + 60_000;
  for (let index = 0; index < MAX_SCAN_MINUTES; index += 1) {
    const at = start + index * 60_000;
    const date = new Date(at);
    if (!parsed.month.includes(date.getMonth() + 1)) continue;
    if (!parsed.minute.includes(date.getMinutes())) continue;
    if (!parsed.hour.includes(date.getHours())) continue;

    const domMatch = parsed.dom.includes(date.getDate());
    const dowMatch = parsed.dow.includes(date.getDay());
    // 与 Vixie 一致：两个字段都为 * 时都算匹配；只有一个为 * 时，另一个必须匹配；
    // 都不为 * 时任一匹配即可。
    const dayMatch = parsed.domStar && parsed.dowStar
      ? true
      : parsed.domStar
        ? dowMatch
        : parsed.dowStar
          ? domMatch
          : domMatch || dowMatch;
    if (!dayMatch) continue;

    return at;
  }
  return null;
}

/**
 * 求某个 schedule 的下一次触发时刻。
 * @param {object} schedule CONTRACT.md §2.2 的判别式对象
 * @param {number} fromMs 严格大于该时刻
 * @returns {number|null}
 */
export function nextScheduleTime(schedule, fromMs) {
  if (schedule === null || typeof schedule !== 'object') return null;
  switch (schedule.kind) {
    case 'every': {
      const minutes = schedule.everyMinutes;
      if (!Number.isSafeInteger(minutes) || minutes < 30) return null;
      return fromMs + minutes * 60_000;
    }
    case 'daily': {
      const parts = parseClock(schedule.time);
      if (parts === null) return null;
      return nextLocalClock(fromMs, parts, () => true);
    }
    case 'weekly': {
      const parts = parseClock(schedule.time);
      if (parts === null) return null;
      const days = normalizeWeekdays(schedule.weekdays);
      if (days.length === 0) return null;
      return nextLocalClock(fromMs, parts, (date) => days.includes(isoWeekday(date)));
    }
    case 'cron': {
      let parsed;
      try {
        parsed = parseCron(schedule.expression);
      } catch {
        return null;
      }
      return nextCronTime(parsed, fromMs);
    }
    case 'once': {
      const at = schedule.at;
      if (!Number.isFinite(at)) return null;
      return at > fromMs ? at : null;
    }
    default:
      return null;
  }
}

/**
 * 校验 schedule，返回 null 或错误信息。
 * @param {object} schedule
 * @returns {string|null}
 */
export function validateSchedule(schedule) {
  if (schedule === null || typeof schedule !== 'object') return 'schedule 必须是对象';
  switch (schedule.kind) {
    case 'every':
      if (!Number.isSafeInteger(schedule.everyMinutes)) return 'everyMinutes 必须是整数';
      if (schedule.everyMinutes < 30) return 'everyMinutes 不能小于 30 分钟';
      if (schedule.everyMinutes > 43_200) return 'everyMinutes 不能大于 43200（30 天）';
      return null;
    case 'daily':
      return parseClock(schedule.time) === null ? 'time 必须形如 "HH:mm"' : null;
    case 'weekly': {
      if (parseClock(schedule.time) === null) return 'time 必须形如 "HH:mm"';
      if (normalizeWeekdays(schedule.weekdays).length === 0) {
        return 'weekdays 必须是非空的星期集合（1=周一 … 7=周日）';
      }
      return null;
    }
    case 'cron':
      try {
        parseCron(schedule.expression);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    case 'once':
      if (!Number.isFinite(schedule.at)) return 'at 必须是毫秒时间戳';
      return null;
    default:
      return `未知的 schedule.kind：${String(schedule === null ? '' : schedule.kind)}`;
  }
}

/**
 * 人类可读的时间描述（界面与日志共用）。
 * @param {object} schedule
 * @returns {string}
 */
export function describeSchedule(schedule) {
  if (schedule === null || typeof schedule !== 'object') return '未知时间';
  switch (schedule.kind) {
    case 'every':
      return `每 ${schedule.everyMinutes} 分钟`;
    case 'daily':
      return `每天 ${schedule.time}`;
    case 'weekly': {
      const days = normalizeWeekdays(schedule.weekdays);
      const names = ['日', '一', '二', '三', '四', '五', '六'];
      const text = days.map((day) => `周${names[day % 7]}`).join('、');
      return `每 ${text} ${schedule.time}`;
    }
    case 'cron':
      return `cron(${String(schedule.expression)})`;
    case 'once': {
      const at = Number(schedule.at);
      if (!Number.isFinite(at)) return '一次性（时间非法）';
      return `一次性 ${new Date(at).toLocaleString()}`;
    }
    default:
      return '未知时间';
  }
}

/**
 * 解析 `HH:mm`；非法返回 null。
 *
 * 严格要求两位小时与两位分钟（`09:00`，不接受 `9:00`）：这个字符串会被原样
 * 存进 Config 并展示给用户，允许两种写法会让同一份配置出现两种形态，
 * 也会让「去重比较」和「配置 diff」变得不可靠。
 */
function parseClock(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (match === null) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** ISO 星期：周一 = 1 … 周日 = 7。 */
function isoWeekday(date) {
  const day = date.getDay();
  return day === 0 ? 7 : day;
}

/** 归一化星期集合：去重、升序、只保留 1..7 的整数。 */
function normalizeWeekdays(value) {
  if (!Array.isArray(value)) return [];
  const set = new Set();
  for (const item of value) {
    if (Number.isSafeInteger(item) && item >= 1 && item <= 7) set.add(item);
  }
  return [...set].sort((left, right) => left - right);
}

/**
 * 求下一个满足谓词的本地 `HH:mm` 时刻。
 * 先试今天，再逐日向后找（最多 8 天覆盖周规则）。
 */
function nextLocalClock(fromMs, clock, dayPredicate) {
  const cursor = new Date(fromMs);
  for (let offset = 0; offset <= 8; offset += 1) {
    const candidate = new Date(
      cursor.getFullYear(),
      cursor.getMonth(),
      cursor.getDate() + offset,
      clock.hour,
      clock.minute,
      0,
      0,
    );
    if (candidate.getTime() <= fromMs) continue;
    if (!dayPredicate(candidate)) continue;
    return candidate.getTime();
  }
  return null;
}
