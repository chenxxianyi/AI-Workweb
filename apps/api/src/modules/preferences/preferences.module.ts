import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Injectable,
  Module,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { parseEtag } from '@aiwb/contracts';
import { PrismaService } from '../../common/prisma.module.js';
import { ApiException } from '../../common/api-exception.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { requireRequestAuth } from '../auth/auth-context.js';
import { workspaceContext } from '../workspaces/workspace.guard.js';
import { databaseBackupStatus } from '../../common/backup-status.js';
const theme = z.strictObject({ theme: z.enum(['system', 'light', 'dark']) });
export function reminderDue(
  total: number,
  completedTasks: number,
  shownAt: Date | null,
  now: Date,
) {
  return (
    (total > 30 || completedTasks > 500) &&
    (!shownAt || now.getTime() - shownAt.getTime() >= 86400000)
  );
}
@Injectable()
export class PreferencesService {
  constructor(@Inject(PrismaService) readonly prisma: PrismaService) {}
  async personal(userId: string) {
    const row = await this.prisma.db.userPreference.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
    return { theme: row.theme, version: row.version };
  }
  async savePersonal(userId: string, ifMatch: string | undefined, input: z.infer<typeof theme>) {
    const version = ifMatch ? parseEtag(ifMatch) : null;
    if (version === null) throw new ApiException('PRECONDITION_REQUIRED', '偏好修改需要If-Match');
    const result = await this.prisma.db.userPreference.updateMany({
      where: { userId, version },
      data: { theme: input.theme, version: { increment: 1 } },
    });
    if (result.count !== 1) throw new ApiException('PRECONDITION_FAILED', '偏好已在其他设备修改');
    return this.personal(userId);
  }
  async space(workspaceId: string, userId: string, now = new Date()) {
    const where = { workspaceId, deletedAt: null };
    const [projects, tasks, entries, logs, ledger, completedTasks] =
      await this.prisma.db.$transaction(
        [
          this.prisma.db.project.count({ where }),
          this.prisma.db.task.count({ where }),
          this.prisma.db.entry.count({ where }),
          this.prisma.db.developmentLog.count({ where }),
          this.prisma.db.ledgerRecord.count({ where }),
          this.prisma.db.task.count({ where: { ...where, status: 'done' } }),
        ],
        { isolationLevel: 'RepeatableRead' },
      );
    const pref = await this.prisma.db.workspaceUserPreference.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    const total = projects + tasks + entries + logs + ledger;
    return {
      total,
      completedTasks,
      tipShownAt: pref?.tipShownAt?.toISOString() ?? null,
      lastBusinessExportAt: pref?.lastBusinessExportAt?.toISOString() ?? null,
      reminderEligible: reminderDue(total, completedTasks, pref?.tipShownAt ?? null, now),
      databaseBackup: await databaseBackupStatus(),
    };
  }
  async claim(workspaceId: string, userId: string, now = new Date()) {
    const stats = await this.space(workspaceId, userId, now);
    return this.prisma.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId + ':' + userId + ':reminder'},0))`;
      const pref = await tx.workspaceUserPreference.findUnique({
        where: { workspaceId_userId: { workspaceId, userId } },
      });
      if (!reminderDue(stats.total, stats.completedTasks, pref?.tipShownAt ?? null, now))
        return { show: false, messages: [] };
      await tx.workspaceUserPreference.upsert({
        where: { workspaceId_userId: { workspaceId, userId } },
        create: { workspaceId, userId, tipShownAt: now },
        update: { tipShownAt: now, version: { increment: 1 } },
      });
      return {
        show: true,
        messages: [
          ...(stats.total > 30
            ? ['当前空间业务记录超过30条，建议导出资料并检查本机数据库备份。']
            : []),
          ...(stats.completedTasks > 500
            ? ['已完成任务超过500条，可归档整理；系统不会自动删除。']
            : []),
        ],
      };
    });
  }
}
@Controller('users/me/preferences')
class UserPreferencesController {
  constructor(@Inject(PreferencesService) readonly service: PreferencesService) {}
  @Get() async get(@Req() req: Request) {
    return { data: await this.service.personal(requireRequestAuth(req).userId) };
  }
  @Patch() async update(
    @Req() req: Request,
    @Headers('if-match') version: string | undefined,
    @Body(new ZodPipe(theme)) body: z.infer<typeof theme>,
  ) {
    return { data: await this.service.savePersonal(requireRequestAuth(req).userId, version, body) };
  }
}
@Controller('workspaces/:workspaceId/preferences')
class SpacePreferencesController {
  constructor(@Inject(PreferencesService) readonly service: PreferencesService) {}
  @Get() async get(@Req() req: Request) {
    return {
      data: await this.service.space(
        workspaceContext(req).workspaceId,
        requireRequestAuth(req).userId,
      ),
    };
  }
  @Post('reminder') @HttpCode(200) async claim(
    @Req() req: Request,
    @Body(new ZodPipe(z.strictObject({}))) _body: Record<string, never>,
  ) {
    return {
      data: await this.service.claim(
        workspaceContext(req).workspaceId,
        requireRequestAuth(req).userId,
      ),
    };
  }
}
@Module({
  controllers: [UserPreferencesController, SpacePreferencesController],
  providers: [PreferencesService],
  exports: [PreferencesService],
})
export class PreferencesModule {}
