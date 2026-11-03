import { describe, expect, it } from 'vitest';
import { effectLabel, formatMinutes, groupByDate, shouldSubmitOnEnter } from './ledger-utils';
import type { LedgerRecord } from '../../services/ledger-api';

function record(overrides: Partial<LedgerRecord>): LedgerRecord {
  return {
    id: 'id',
    recordDate: '2026-11-03',
    projectId: null,
    tool: 'claude',
    scene: 'coding',
    minutes: 30,
    savedMinutes: 20,
    effect: 4,
    note: 'note',
    entryId: null,
    authorId: 'u',
    version: 1,
    createdAt: '2026-11-03T00:00:00.000Z',
    updatedAt: '2026-11-03T00:00:00.000Z',
    ...overrides,
  };
}

describe('台账输入与展示（F18）', () => {
  it('普通 Enter 提交；Shift+Enter 换行', () => {
    expect(shouldSubmitOnEnter({ shiftKey: false })).toBe(true);
    expect(shouldSubmitOnEnter({ shiftKey: true })).toBe(false);
  });

  it('输入法组合态（isComposing / keyCode 229）不提交', () => {
    expect(shouldSubmitOnEnter({ shiftKey: false, isComposing: true })).toBe(false);
    expect(shouldSubmitOnEnter({ shiftKey: false, keyCode: 229 })).toBe(false);
    expect(shouldSubmitOnEnter({ shiftKey: true, isComposing: true })).toBe(false);
  });

  it('按日期分组并累计投入与节省', () => {
    const groups = groupByDate([
      record({ id: 'a', minutes: 30, savedMinutes: 10 }),
      record({ id: 'b', minutes: 20, savedMinutes: 5 }),
      record({ id: 'c', recordDate: '2026-11-02', minutes: 60, savedMinutes: 40 }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.records).toHaveLength(2);
    expect(groups[0]?.totalMinutes).toBe(50);
    expect(groups[0]?.totalSavedMinutes).toBe(15);
    expect(groups[1]?.date).toBe('2026-11-02');
  });

  it('分钟展示：不足 60 显示分钟，整小时不显示 0 分钟', () => {
    expect(formatMinutes(45)).toBe('45 分钟');
    expect(formatMinutes(60)).toBe('1 小时');
    expect(formatMinutes(95)).toBe('1 小时 35 分钟');
  });

  it('效果文案覆盖 1～5', () => {
    expect(effectLabel(1)).toBe('几乎没帮助');
    expect(effectLabel(5)).toBe('极大提效');
  });
});
