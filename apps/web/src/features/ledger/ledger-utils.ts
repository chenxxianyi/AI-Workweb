import type { LedgerRecord } from '../../services/ledger-api';

/**
 * 日志输入的键盘判定（F18）。
 *
 * 中文输入法在候选框里按 Enter 是“确认候选”，不能当成提交：
 * - `nativeEvent.isComposing` 为真（标准方式）
 * - `keyCode === 229`（Safari/旧版 Chromium 在组合期间上报的 legacy 值）
 * - 按住 Shift 时 Enter 表示换行
 */
export function shouldSubmitOnEnter(event: {
  shiftKey: boolean;
  isComposing?: boolean | undefined;
  keyCode?: number | undefined;
}): boolean {
  if (event.shiftKey) return false;
  if (event.isComposing === true) return false;
  if (event.keyCode === 229) return false;
  return true;
}

export interface DateGroup {
  date: string;
  records: LedgerRecord[];
  totalMinutes: number;
  totalSavedMinutes: number;
}

/** 时间线按记录日期分组，保持传入顺序（服务端已按日期倒序） */
export function groupByDate(records: LedgerRecord[]): DateGroup[] {
  const groups: DateGroup[] = [];
  for (const record of records) {
    const last = groups.at(-1);
    if (last !== undefined && last.date === record.recordDate) {
      last.records.push(record);
      last.totalMinutes += record.minutes;
      last.totalSavedMinutes += record.savedMinutes;
      continue;
    }
    groups.push({
      date: record.recordDate,
      records: [record],
      totalMinutes: record.minutes,
      totalSavedMinutes: record.savedMinutes,
    });
  }
  return groups;
}

/** 分钟展示：超过 60 分显示小时 + 分钟 */
export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`;
}

/** 效果评分文案（1～5） */
export function effectLabel(effect: number): string {
  const labels: Record<number, string> = { 1: '几乎没帮助', 2: '略有帮助', 3: '有帮助', 4: '明显提效', 5: '极大提效' };
  return labels[effect] ?? `${effect}`;
}
