import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { createTestContext } from './test-context.js';
import { AnalyticsService } from '../src/modules/ledger/analytics.module.js';
import { sceneStatistics, weeklyStatistics, type AnalyticsRow } from '@aiwb/domain';
const ctx = await createTestContext();
let checks = 0;
const check = (n: string, v: boolean) => {
  assert.ok(v, n);
  checks++;
  console.log('PASS ' + n);
};
try {
  const owner = await ctx.owner('analytics-owner'),
    other = await ctx.owner('analytics-other');
  const route = '/workspaces/' + owner.workspaceId + '/analytics';
  const rows: AnalyticsRow[] = [
    { recordDate: '2025-12-31', scene: 'coding', minutes: 20, savedMinutes: 10, effect: 3 },
    { recordDate: '2026-01-01', scene: 'coding', minutes: 40, savedMinutes: 30, effect: 5 },
    { recordDate: '2026-01-05', scene: 'coding', minutes: 20, savedMinutes: 10, effect: 3 },
    { recordDate: '2026-01-07', scene: 'review', minutes: 10, savedMinutes: 0, effect: 4 },
    { recordDate: '2026-02-01', scene: 'coding', minutes: 30, savedMinutes: 90, effect: 5 },
  ];
  await ctx.prisma.ledgerRecord.createMany({
    data: rows.map((r) => ({
      ...r,
      recordDate: new Date(r.recordDate + 'T00:00:00Z'),
      workspaceId: owner.workspaceId,
      createdBy: owner.userId,
      tool: 'codex',
    })),
  });
  await ctx.prisma.ledgerRecord.create({
    data: {
      workspaceId: owner.workspaceId,
      createdBy: owner.userId,
      recordDate: new Date('2026-01-08T00:00:00Z'),
      scene: 'coding',
      tool: 'other',
      minutes: 1,
      savedMinutes: 999,
      effect: 1,
      deletedAt: new Date(),
    },
  });
  const response = await ctx.call('GET', route + '/monthly?month=2026-01', owner);
  const monthly = response.json['data'] as {
    scenes: ReturnType<typeof sceneStatistics>;
    count: number;
    savedMinutes: number;
    conclusion: string;
  };
  check(
    '场景3/5均分4.0与10/30相加40',
    monthly.scenes.find((s) => s.scene === 'coding')?.averageEffect === 4 &&
      monthly.scenes.find((s) => s.scene === 'coding')?.savedMinutes === 40,
  );
  check(
    'SQL聚合等于纯函数',
    isDeepStrictEqual(
      monthly.scenes,
      sceneStatistics(rows.filter((r) => r.recordDate.startsWith('2026-01'))),
    ),
  );
  check('跨月与软删除不混入', monthly.count === 3 && monthly.savedMinutes === 40);
  check(
    '结论来自同一聚合',
    monthly.conclusion.includes('3条') && monthly.conclusion.includes('40分钟'),
  );
  check(
    '非法月份422',
    (await ctx.call('GET', route + '/monthly?month=2026-13', owner)).status === 422,
  );
  const empty = (await ctx.call('GET', route + '/monthly?month=2025-01', owner)).json[
    'data'
  ] as typeof monthly;
  check(
    '空月稳定无NaN',
    empty.count === 0 &&
      empty.savedMinutes === 0 &&
      empty.scenes.length === 0 &&
      !JSON.stringify(empty).includes('NaN'),
  );
  const cross = (
    await ctx.call(
      'GET',
      '/workspaces/' + other.workspaceId + '/analytics/monthly?month=2026-01',
      other,
    )
  ).json['data'] as typeof monthly;
  check('跨空间隔离', cross.count === 0);
  const service = ctx.app.get(AnalyticsService),
    weekly = await service.weekly(owner.workspaceId, '2026-01-07');
  const pure = weeklyStatistics(rows, '2026-01-07');
  check('八周序列与纯函数一致', JSON.stringify(weekly.weeks) === JSON.stringify(pure));
  check(
    '跨年周始于周一且缺周补零',
    weekly.weeks.length === 8 &&
      weekly.weeks[6]?.start === '2025-12-29' &&
      weekly.weeks[6]?.savedMinutes === 40 &&
      weekly.weeks[0]?.savedMinutes === 0,
  );
  const zero = await service.weekly(other.workspaceId, '2026-01-07');
  check(
    '全零无NaN Infinity',
    zero.weeks.every((w) => w.savedMinutes === 0 && w.count === 0) &&
      !JSON.stringify(zero).match(/NaN|Infinity/),
  );
  check('真实周HTTP可用', (await ctx.call('GET', route + '/weekly', owner)).status === 200);
  check(
    '不能通过参数改工作空间统计锚点',
    (await ctx.call('GET', route + '/weekly?date=2025-01-01', owner)).status === 422,
  );
  console.log('合计 ' + checks + ' 项，全部通过');
} finally {
  await ctx.close();
}
