/**
 * 业务日期纯函数（ADR-0005）。
 *
 * 规则：
 * - "业务日"是空间时区下的 YYYY-MM-DD，用 Intl 推导，不手写时区偏移；
 * - 日期字符串只接受严格的 YYYY-MM-DD，拒绝 2026-02-30 这类不存在的日期；
 * - 所有函数无副作用、不读系统时区、不依赖 Date 的本地时间方法。
 */

const MS_PER_DAY = 86_400_000;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_PATTERN = /^(\d{4})-(\d{2})$/;

export interface DateRange {
  /** 含头 */
  start: string;
  /** 含尾 */
  end: string;
}

export interface WeekRange extends DateRange {
  /** 该周周一（ISO 周，周一为第一天） */
  weekStart: string;
}

function assertDateString(value: string, label = 'date'): asserts value is string {
  if (!isValidDate(value)) {
    throw new RangeError(`${label} 必须是有效的 YYYY-MM-DD：收到 "${value}"`);
  }
}

function splitDate(value: string): { year: number; month: number; day: number } {
  const match = DATE_PATTERN.exec(value);
  if (match === null) throw new RangeError(`date 格式必须为 YYYY-MM-DD：收到 "${value}"`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function toUtcDate(value: string): Date {
  assertDateString(value);
  const { year, month, day } = splitDate(value);
  return new Date(Date.UTC(year, month - 1, day));
}

function fromUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** 严格校验 YYYY-MM-DD（同时拒绝 2026-02-30、2026-13-01 等） */
export function isValidDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DATE_PATTERN.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
  );
}

/**
 * 指定时区下此刻的业务日（YYYY-MM-DD）。
 * @param now 当前时刻（Date 或可被 Date 解析的值）
 * @param timeZone IANA 时区，例如 Asia/Shanghai
 */
export function businessDate(now: Date | string | number, timeZone: string): string {
  const instant = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(instant.getTime())) throw new RangeError('now 不是有效的时间点');
  // 先验证时区，避免静默回退到系统时区
  if (typeof timeZone !== 'string' || timeZone.trim() === '') {
    throw new RangeError('timeZone 不能为空');
  }
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(instant);
  const pick = (type: 'year' | 'month' | 'day'): string => {
    const part = parts.find((item) => item.type === type);
    if (part === undefined) throw new RangeError(`时区 ${timeZone} 无法解析 ${type}`);
    return part.value;
  };
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

/** 日期加减天数（跨月、跨年、闰年正确） */
export function addDays(date: string, days: number): string {
  if (!Number.isInteger(days)) throw new RangeError('days 必须是整数');
  const utc = toUtcDate(date);
  return fromUtcDate(new Date(utc.getTime() + days * MS_PER_DAY));
}

/** 两个日期相差的天数（to - from） */
export function diffDays(from: string, to: string): number {
  return Math.round((toUtcDate(to).getTime() - toUtcDate(from).getTime()) / MS_PER_DAY);
}

/** 该日期所在周的周一（ISO 周，周一为第一天） */
export function startOfWeek(date: string): string {
  const dayOfWeek = toUtcDate(date).getUTCDay(); // 0=周日
  const offset = (dayOfWeek + 6) % 7; // 周一=0
  return addDays(date, -offset);
}

/** 以某日为终点的最近 weeks 个自然周（升序，含该日所在周） */
export function weekRange(endDate: string, weeks = 8): WeekRange[] {
  if (!Number.isInteger(weeks) || weeks < 1) throw new RangeError('weeks 必须是正整数');
  const lastWeekStart = startOfWeek(endDate);
  const ranges: WeekRange[] = [];
  for (let index = weeks - 1; index >= 0; index -= 1) {
    const weekStart = addDays(lastWeekStart, -7 * index);
    ranges.push({ weekStart, start: weekStart, end: addDays(weekStart, 6) });
  }
  return ranges;
}

/** 某月（YYYY-MM）的首尾日期 */
export function monthRange(month: string): DateRange {
  const match = MONTH_PATTERN.exec(month);
  if (match === null) throw new RangeError(`month 格式必须为 YYYY-MM：收到 "${month}"`);
  const year = Number(match[1]);
  const monthIndex = Number(match[2]);
  if (monthIndex < 1 || monthIndex > 12) throw new RangeError(`month 月份越界：收到 "${month}"`);
  const start = `${match[1]}-${match[2]}-01`;
  const lastDay = new Date(Date.UTC(year, monthIndex, 0)).getUTCDate();
  return { start, end: `${match[1]}-${match[2]}-${String(lastDay).padStart(2, '0')}` };
}

/** 两个日期是否在同一个月（用于月度筛选） */
export function isSameMonth(left: string, right: string): boolean {
  return left.slice(0, 7) === right.slice(0, 7);
}
