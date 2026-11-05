import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { apiClient } from '../../services/api-client';
import { sceneLabel } from '../../services/ledger-api';
import { describeApiError } from '../../services/auth-api';
import { ErrorState, LoadingState } from '../../components/states';
import styles from './ledger.module.css';
export interface Monthly {
  month: string;
  count: number;
  savedMinutes: number;
  conclusion: string;
  scenes: {
    scene: string;
    count: number;
    minutes: number;
    savedMinutes: number;
    averageEffect: number;
  }[];
}
export interface Weekly {
  start: string;
  end: string;
  weeks: { weekStart: string; count: number; savedMinutes: number }[];
}
export function StatisticsCharts({
  monthly,
  weekly,
}: {
  monthly: Monthly;
  weekly: Weekly;
}): React.JSX.Element {
  const max = Math.max(1, ...weekly.weeks.map((w) => w.savedMinutes));
  const points = weekly.weeks
    .map(
      (w, i) =>
        `${30 + (weekly.weeks.length === 1 ? 130 : (i * 260) / Math.max(1, weekly.weeks.length - 1))},${140 - (w.savedMinutes / max) * 110}`,
    )
    .join(' ');
  return (
    <div className={styles.charts}>
      <figure>
        <figcaption>{monthly.month} 场景效果均分（1–5分）</figcaption>
        {monthly.scenes.length === 0 ? (
          <p>本月没有记录，暂无图形。</p>
        ) : (
          <svg
            role="img"
            aria-label="按场景平均效果评分"
            viewBox={`0 0 320 ${monthly.scenes.length * 42 + 10}`}
          >
            {monthly.scenes.map((s, i) => (
              <g key={s.scene}>
                <title>
                  {sceneLabel(s.scene)}：{s.averageEffect.toFixed(1)}分，{s.count}条
                </title>
                <text x={0} y={i * 42 + 20} fill="var(--text)" fontSize={12}>
                  {sceneLabel(s.scene).slice(0, 10)}
                </text>
                <rect
                  x={95}
                  y={i * 42 + 5}
                  width={(s.averageEffect / 5) * 175}
                  height={22}
                  rx={3}
                  fill="var(--primary)"
                />
                <text x={280} y={i * 42 + 20} fontSize={12} fill="var(--text)">
                  {s.averageEffect.toFixed(1)}
                </text>
              </g>
            ))}
          </svg>
        )}
        <ul>
          {monthly.scenes.map((s) => (
            <li key={s.scene}>
              {sceneLabel(s.scene)}：{s.averageEffect.toFixed(1)}分 · {s.count}条 · 节省
              {s.savedMinutes}分钟
            </li>
          ))}
        </ul>
      </figure>
      <figure>
        <figcaption>最近八周节省时长（分钟）</figcaption>
        <p>
          {weekly.start} 至 {weekly.end}，含本周
        </p>
        {weekly.weeks.length === 0 || weekly.weeks.every((w) => w.count === 0) ? (
          <p>尚无周记录，暂无趋势线。</p>
        ) : (
          <svg role="img" aria-label="每周节省分钟趋势" viewBox="0 0 320 175">
            <line x1={30} x2={290} y1={140} y2={140} stroke="var(--border-strong)" />
            <text x={0} y={35} fontSize={10} fill="var(--text-muted)">
              {max}
            </text>
            <text x={10} y={145} fontSize={10} fill="var(--text-muted)">
              0
            </text>
            <polyline points={points} fill="none" stroke="var(--primary)" strokeWidth={3} />
            {weekly.weeks.map((w, i) => (
              <circle
                key={w.weekStart}
                cx={
                  30 +
                  (weekly.weeks.length === 1
                    ? 130
                    : (i * 260) / Math.max(1, weekly.weeks.length - 1))
                }
                cy={140 - (w.savedMinutes / max) * 110}
                r={4}
                fill="var(--primary)"
              >
                <title>
                  {w.weekStart}：{w.savedMinutes}分钟
                </title>
              </circle>
            ))}
          </svg>
        )}
        <ul>
          {weekly.weeks.map((w) => (
            <li key={w.weekStart}>
              周一 {w.weekStart}：节省{w.savedMinutes}分钟（{w.count}条）
            </li>
          ))}
        </ul>
      </figure>
    </div>
  );
}
export function LedgerAnalytics({
  workspaceId,
  businessDate,
}: {
  workspaceId: string;
  businessDate: string;
}): React.JSX.Element {
  const [selected, setSelected] = useState('');
  const month = selected || businessDate.slice(0, 7);
  const monthly = useQuery({
    queryKey: ['ws', workspaceId, 'ledger', 'monthly', month],
    queryFn: ({ signal }) =>
      apiClient.get<Monthly>(`/workspaces/${workspaceId}/analytics/monthly?month=${month}`, {
        signal,
      }),
    enabled: !!workspaceId,
  });
  const weekly = useQuery({
    queryKey: ['ws', workspaceId, 'ledger', 'weekly'],
    queryFn: ({ signal }) =>
      apiClient.get<Weekly>(`/workspaces/${workspaceId}/analytics/weekly`, { signal }),
    enabled: !!workspaceId,
  });
  return (
    <section className={styles.composer} aria-label="台账统计">
      <h2>台账统计</h2>
      <label className={styles.field}>
        统计月份
        <input
          className={styles.input}
          type="month"
          value={month}
          onChange={(e) => setSelected(e.target.value)}
        />
      </label>
      {monthly.isError || weekly.isError ? (
        <ErrorState
          message={describeApiError(monthly.error ?? weekly.error)}
          onRetry={() => {
            void monthly.refetch();
            void weekly.refetch();
          }}
        />
      ) : monthly.isPending || weekly.isPending ? (
        <LoadingState />
      ) : (
        <>
          <p aria-live="polite">{monthly.data.conclusion}</p>
          <StatisticsCharts monthly={monthly.data} weekly={weekly.data} />
        </>
      )}
    </section>
  );
}
