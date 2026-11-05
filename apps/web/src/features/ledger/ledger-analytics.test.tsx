import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatisticsCharts, type Monthly, type Weekly } from './ledger-analytics';
const monthly: Monthly = {
  month: '2026-01',
  count: 0,
  savedMinutes: 0,
  conclusion: '暂无',
  scenes: [],
};
describe('ledger chart accessible boundaries', () => {
  it('empty month and empty weeks have no fabricated line', () => {
    const { container } = render(
      <StatisticsCharts
        monthly={monthly}
        weekly={{ start: '2026-01-01', end: '2026-01-07', weeks: [] }}
      />,
    );
    expect(screen.getByText('本月没有记录，暂无图形。')).toBeTruthy();
    expect(container.querySelector('polyline')).toBeNull();
  });
  it('one zero point is finite and exposes equivalent text', () => {
    const weekly: Weekly = {
      start: '2026-01-05',
      end: '2026-01-07',
      weeks: [{ weekStart: '2026-01-05', count: 1, savedMinutes: 0 }],
    };
    const { container } = render(
      <StatisticsCharts
        monthly={{
          ...monthly,
          count: 1,
          scenes: [
            {
              scene: 'very-long-scene-label',
              count: 1,
              minutes: 10,
              savedMinutes: 0,
              averageEffect: 4,
            },
          ],
        }}
        weekly={weekly}
      />,
    );
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
    expect(screen.getByText('very-long-scene-label：4.0分 · 1条 · 节省0分钟')).toBeTruthy();
    expect(screen.getByRole('img', { name: '每周节省分钟趋势' })).toBeTruthy();
  });
  it('missing weeks remain visible as zero in text', () => {
    render(
      <StatisticsCharts
        monthly={monthly}
        weekly={{
          start: '2026-01-01',
          end: '2026-01-14',
          weeks: [
            { weekStart: '2026-01-05', count: 0, savedMinutes: 0 },
            { weekStart: '2026-01-12', count: 2, savedMinutes: 40 },
          ],
        }}
      />,
    );
    expect(screen.getByText('周一 2026-01-05：节省0分钟（0条）')).toBeTruthy();
    expect(screen.getByText('周一 2026-01-12：节省40分钟（2条）')).toBeTruthy();
  });
});
