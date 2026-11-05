import { Controller, Get, Inject, Injectable, Module, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { businessDate, isValidDate, monthRange, weekRange } from '@aiwb/domain';
import { PrismaService } from '../../common/prisma.module.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { workspaceContext } from '../workspaces/workspace.guard.js';
const monthlyQuery = z.strictObject({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .refine((v) => isValidDate(v + '-01'))
    .optional(),
});
const weeklyQuery = z.strictObject({});
const asDate = (day: string) => new Date(day + 'T00:00:00Z');
@Injectable()
export class AnalyticsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}
  async today(workspaceId: string) {
    const ws = await this.prisma.db.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    return businessDate(new Date(), ws.timezone);
  }
  async monthly(workspaceId: string, month?: string) {
    month ??= (await this.today(workspaceId)).slice(0, 7);
    const range = monthRange(month);
    const groups = await this.prisma.db.ledgerRecord.groupBy({
      by: ['scene'],
      where: {
        workspaceId,
        deletedAt: null,
        recordDate: { gte: asDate(range.start), lte: asDate(range.end) },
      },
      _count: { _all: true },
      _sum: { minutes: true, savedMinutes: true, effect: true },
    });
    const scenes = groups
      .map((g) => ({
        scene: g.scene,
        count: g._count._all,
        minutes: g._sum.minutes ?? 0,
        savedMinutes: g._sum.savedMinutes ?? 0,
        averageEffect: Math.round(((g._sum.effect ?? 0) / g._count._all) * 10) / 10,
      }))
      .sort(
        (a, b) =>
          b.averageEffect - a.averageEffect ||
          b.count - a.count ||
          a.scene.localeCompare(b.scene, 'en'),
      );
    const count = scenes.reduce((s, g) => s + g.count, 0),
      savedMinutes = scenes.reduce((s, g) => s + g.savedMinutes, 0),
      minutes = scenes.reduce((s, g) => s + g.minutes, 0);
    const best = scenes[0];
    return {
      month,
      ...range,
      unit: 'minutes',
      count,
      minutes,
      savedMinutes,
      scenes,
      conclusion: best
        ? `${month}共${count}条记录，节省${savedMinutes}分钟；场景${best.scene}平均效果${best.averageEffect.toFixed(1)}分（${best.count}条）。`
        : `${month}暂无记录，尚不能生成效果结论。`,
    };
  }
  async weekly(workspaceId: string, referenceDate?: string) {
    const today = referenceDate ?? (await this.today(workspaceId)),
      ranges = weekRange(today, 8),
      start = ranges[0]!.start;
    const groups = await this.prisma.db.ledgerRecord.groupBy({
      by: ['recordDate'],
      where: {
        workspaceId,
        deletedAt: null,
        recordDate: { gte: asDate(start), lte: asDate(today) },
      },
      _count: { _all: true },
      _sum: { minutes: true, savedMinutes: true },
    });
    const days = groups.map((g) => ({
      date: g.recordDate.toISOString().slice(0, 10),
      count: g._count._all,
      minutes: g._sum.minutes ?? 0,
      savedMinutes: g._sum.savedMinutes ?? 0,
    }));
    return {
      start,
      end: today,
      unit: 'minutes',
      weeks: ranges.map((r) => ({
        ...r,
        count: days
          .filter((d) => d.date >= r.start && d.date <= r.end)
          .reduce((s, d) => s + d.count, 0),
        minutes: days
          .filter((d) => d.date >= r.start && d.date <= r.end)
          .reduce((s, d) => s + d.minutes, 0),
        savedMinutes: days
          .filter((d) => d.date >= r.start && d.date <= r.end)
          .reduce((s, d) => s + d.savedMinutes, 0),
      })),
    };
  }
}
@Controller('workspaces/:workspaceId/analytics')
class AnalyticsController {
  constructor(@Inject(AnalyticsService) private readonly service: AnalyticsService) {}
  @Get('monthly') async monthly(
    @Req() req: Request,
    @Query(new ZodPipe(monthlyQuery)) q: z.infer<typeof monthlyQuery>,
  ) {
    return { data: await this.service.monthly(workspaceContext(req).workspaceId, q.month) };
  }
  @Get('weekly') async weekly(
    @Req() req: Request,
    @Query(new ZodPipe(weeklyQuery)) _q: z.infer<typeof weeklyQuery>,
  ) {
    return { data: await this.service.weekly(workspaceContext(req).workspaceId) };
  }
}
@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
