import { describe, expect, it } from 'vitest';
import {
  addDays,
  businessDate,
  diffDays,
  isSameMonth,
  isValidDate,
  monthRange,
  startOfWeek,
  weekRange,
} from './date';

describe('businessDate', () => {
  it('按空间时区判断业务日：Asia/Shanghai 的 23:59 仍是当天', () => {
    expect(businessDate('2026-11-03T15:59:59.000Z', 'Asia/Shanghai')).toBe('2026-11-03');
  });

  it('跨过当地午夜后进入次日', () => {
    expect(businessDate('2026-11-03T16:00:00.000Z', 'Asia/Shanghai')).toBe('2026-11-04');
  });

  it('同一时刻在不同时区可能属于不同业务日', () => {
    // 2026-11-01 美国东部结束夏令时，11-03 为 EST（UTC-5）：04:30Z → 前一日的 23:30
    const instant = '2026-11-03T04:30:00.000Z';
    expect(businessDate(instant, 'America/New_York')).toBe('2026-11-02');
    expect(businessDate(instant, 'Asia/Shanghai')).toBe('2026-11-03');
    expect(businessDate('2026-11-03T05:00:00.000Z', 'America/New_York')).toBe('2026-11-03');
    expect(businessDate('2026-11-03T16:00:00.000Z', 'UTC')).toBe('2026-11-03');
  });

  it('接受 Date 与毫秒时间戳', () => {
    const instant = Date.parse('2026-11-03T20:00:00.000Z');
    expect(businessDate(new Date(instant), 'Asia/Shanghai')).toBe('2026-11-04');
    expect(businessDate(instant, 'UTC')).toBe('2026-11-03');
  });

  it('拒绝无效时间与时区', () => {
    expect(() => businessDate('not-a-date', 'Asia/Shanghai')).toThrow(RangeError);
    expect(() => businessDate('2026-11-03T00:00:00Z', '')).toThrow(RangeError);
  });
});

describe('isValidDate', () => {
  it('接受真实存在的日期（含闰日）', () => {
    expect(isValidDate('2026-11-03')).toBe(true);
    expect(isValidDate('2024-02-29')).toBe(true);
  });

  it('拒绝不存在的日期与错误格式', () => {
    expect(isValidDate('2026-02-30')).toBe(false);
    expect(isValidDate('2026-13-01')).toBe(false);
    expect(isValidDate('2026-2-3')).toBe(false);
    expect(isValidDate(20261103)).toBe(false);
  });
});

describe('addDays / diffDays', () => {
  it('跨月与跨年正确', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('闰年 2 月正确', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2028-02-29', 1)).toBe('2028-03-01');
  });

  it('差值为整数天', () => {
    expect(diffDays('2026-11-01', '2026-11-03')).toBe(2);
    expect(diffDays('2026-11-03', '2026-10-31')).toBe(-3);
    expect(diffDays('2026-11-03', '2026-11-03')).toBe(0);
  });

  it('拒绝非法输入', () => {
    expect(() => addDays('2026-02-30', 1)).toThrow(RangeError);
    expect(() => addDays('2026-11-03', 1.5)).toThrow(RangeError);
  });
});

describe('startOfWeek', () => {
  it('周二回退到本周一', () => {
    expect(startOfWeek('2026-11-03')).toBe('2026-11-02');
  });

  it('周日属于前一个周一', () => {
    expect(startOfWeek('2026-11-08')).toBe('2026-11-02');
  });

  it('周一是自身', () => {
    expect(startOfWeek('2026-11-02')).toBe('2026-11-02');
  });

  it('跨年正确', () => {
    expect(startOfWeek('2027-01-01')).toBe('2026-12-28');
  });
});

describe('weekRange', () => {
  it('返回 8 周升序，最后一周包含给定日期', () => {
    const ranges = weekRange('2026-11-03');
    expect(ranges).toHaveLength(8);
    expect(ranges[7]?.weekStart).toBe('2026-11-02');
    expect(ranges[7]?.end).toBe('2026-11-08');
    expect(ranges[0]?.weekStart).toBe('2026-09-14');
    for (let index = 1; index < ranges.length; index += 1) {
      expect(ranges[index]?.weekStart).toBe(addDays(ranges[index - 1]!.weekStart, 7));
    }
  });

  it('可指定周数并拒绝非法周数', () => {
    expect(weekRange('2026-11-03', 1)).toHaveLength(1);
    expect(() => weekRange('2026-11-03', 0)).toThrow(RangeError);
  });
});

describe('monthRange', () => {
  it('返回月初与月末', () => {
    expect(monthRange('2026-11')).toEqual({ start: '2026-11-01', end: '2026-11-30' });
    expect(monthRange('2026-02')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(monthRange('2028-02')).toEqual({ start: '2028-02-01', end: '2028-02-29' });
  });

  it('拒绝非法月份', () => {
    expect(() => monthRange('2026-13')).toThrow(RangeError);
    expect(() => monthRange('2026-1')).toThrow(RangeError);
  });
});

describe('isSameMonth', () => {
  it('按 YYYY-MM 比较', () => {
    expect(isSameMonth('2026-11-01', '2026-11-30')).toBe(true);
    expect(isSameMonth('2026-11-30', '2026-12-01')).toBe(false);
  });
});
