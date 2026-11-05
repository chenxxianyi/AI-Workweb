import type {
  OnModuleDestroy,
  OnModuleInit} from '@nestjs/common';
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  Injectable,
  Module,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseEtag } from '@aiwb/contracts';
import { PrismaService } from '../../common/prisma.module.js';
import { ApiException } from '../../common/api-exception.js';
import { runIdempotent, assertIdempotencyKey } from '../../common/idempotency.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { RateLimit } from '../../common/rate-limit.js';
import { requireRequestAuth } from '../auth/auth-context.js';
import { verifyPassword } from '../auth/password.js';
import { workspaceContext } from '../workspaces/workspace.guard.js';
import { WorkspaceRoleRequired } from '../workspaces/permissions.js';
import { TransfersModule, TransfersService } from '../transfers/transfers.module.js';
import type { Prisma } from '../../generated/prisma/client.js';
const entityType = z.enum(['project', 'task', 'entry', 'log', 'ledger']);
type EntityType = z.infer<typeof entityType>;
const tableNames = {
  project: 'projects',
  task: 'tasks',
  entry: 'entries',
  log: 'development_logs',
  ledger: 'ledger_records',
};
type Row = Record<string, unknown> & {
  id: string;
  version: number;
  deletedAt: Date | null;
  projectId?: string | null;
  entryId?: string | null;
};
type Model = {
  findMany(args: unknown): Promise<Row[]>;
  findFirst(args: unknown): Promise<Row | null>;
  updateMany(args: unknown): Promise<{ count: number }>;
  deleteMany(args: unknown): Promise<{ count: number }>;
};
function model(tx: Prisma.TransactionClient, type: EntityType): Model {
  return {
    project: tx.project,
    task: tx.task,
    entry: tx.entry,
    log: tx.developmentLog,
    ledger: tx.ledgerRecord,
  }[type] as unknown as Model;
}
function version(value: string | undefined) {
  const parsed = value ? parseEtag(value) : null;
  if (parsed === null) throw new ApiException('PRECONDITION_REQUIRED', '需要当前If-Match版本');
  return parsed;
}
const listQuery = z.strictObject({
  type: entityType.default('entry'),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.uuid().optional(),
});
const auditQuery = z.strictObject({
  action: z.string().max(64).optional(),
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const clearSchema = z.strictObject({
  confirmName: z.string().max(100),
  backupAcknowledged: z.literal(true),
  password: z.string().min(1).max(128),
});
@Injectable()
export class MaintenanceService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private active: Promise<unknown> | null = null;
  constructor(
    @Inject(PrismaService) readonly prisma: PrismaService,
    @Inject(TransfersService) readonly transfers: TransfersService,
  ) {}
  onModuleInit() {
    if (process.env['MAINTENANCE_WORKER_ENABLED'] !== 'false') {
      this.timer = setInterval(() => {
        if (!this.active)
          this.active = this.purgeExpired()
            .catch(() => undefined)
            .finally(() => {
              this.active = null;
            });
      }, 3600000);
      this.timer.unref();
    }
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
  private async lock(tx: Prisma.TransactionClient, workspaceId: string, userId: string | null) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId},0))`;
    if (userId) {
      const role = await tx.$queryRaw<
        { role: string }[]
      >`SELECT role FROM workspace_members WHERE workspace_id=${workspaceId}::uuid AND user_id=${userId}::uuid AND status='active' FOR SHARE`;
      if (role[0]?.role !== 'owner') throw new ApiException('FORBIDDEN', '仅Owner可维护空间');
    }
  }
  async list(workspaceId: string, query: z.infer<typeof listQuery>) {
    if (
      query.cursor &&
      !(await model(this.prisma.db, query.type).findFirst({
        where: { id: query.cursor, workspaceId, deletedAt: { not: null } },
      }))
    )
      throw new ApiException('MALFORMED_REQUEST', '回收站游标无效');
    const rows = await model(this.prisma.db, query.type).findMany({
      where: { workspaceId, deletedAt: { not: null } },
      orderBy: [{ deletedAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, query.limit);
    return {
      items: page.map((row) => ({
        id: row.id,
        type: query.type,
        title: row['title'] ?? row['name'] ?? row['text'] ?? row['note'] ?? '台账记录',
        version: row.version,
        deletedAt: row.deletedAt!.toISOString(),
        expiresAt: new Date(row.deletedAt!.getTime() + 30 * 86400000).toISOString(),
      })),
      nextCursor: rows.length > query.limit ? page.at(-1)!.id : null,
    };
  }
  async restore(
    workspaceId: string,
    userId: string,
    type: EntityType,
    id: string,
    expected: number,
  ) {
    return this.prisma.db.$transaction(async (tx) => {
      await this.lock(tx, workspaceId, userId);
      await tx.$queryRawUnsafe(
        'SELECT id FROM ' +
          tableNames[type] +
          ' WHERE workspace_id=$1::uuid AND id=$2::uuid FOR UPDATE',
        workspaceId,
        id,
      );
      const row = await model(tx, type).findFirst({
        where: { id, workspaceId, deletedAt: { not: null } },
      });
      if (!row) throw new ApiException('NOT_FOUND', '回收站对象不存在');
      if (row.version !== expected) throw new ApiException('PRECONDITION_FAILED', '对象版本已变化');
      const warnings: string[] = [],
        data: Record<string, unknown> = { deletedAt: null, version: { increment: 1 } };
      if (
        row.projectId &&
        !(await tx.project.findFirst({
          where: { id: row.projectId, workspaceId, deletedAt: null },
        }))
      ) {
        data['projectId'] = null;
        warnings.push('原项目不存在或已删除，恢复时清除关联。');
      }
      if (
        row.entryId &&
        !(await tx.entry.findFirst({ where: { id: row.entryId, workspaceId, deletedAt: null } }))
      ) {
        data['entryId'] = null;
        warnings.push('原知识不存在或已删除，恢复时清除关联。');
      }
      if (type === 'entry')
        await tx.taskEntry.deleteMany({
          where: { workspaceId, entryId: id, task: { deletedAt: { not: null } } },
        });
      if (type === 'task')
        await tx.taskEntry.deleteMany({
          where: { workspaceId, taskId: id, entry: { deletedAt: { not: null } } },
        });
      const changed = await model(tx, type).updateMany({
        where: { id, workspaceId, version: expected, deletedAt: { not: null } },
        data,
      });
      if (changed.count !== 1) throw new ApiException('PRECONDITION_FAILED', '对象版本已变化');
      await tx.auditEvent.create({
        data: {
          workspaceId,
          actorId: userId,
          action: 'trash.restored',
          entityType: type,
          entityId: id,
          result: 'success',
          summary: '恢复回收站对象；清除失效关系' + warnings.length + '项',
        },
      });
      return { id, type, restored: true, version: expected + 1, warnings };
    });
  }
  private async hard(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    userId: string | null,
    type: EntityType,
    id: string,
    expected: number,
  ) {
    await tx.$queryRawUnsafe(
      'SELECT id FROM ' +
        tableNames[type] +
        ' WHERE workspace_id=$1::uuid AND id=$2::uuid FOR UPDATE',
      workspaceId,
      id,
    );
    const row = await model(tx, type).findFirst({
      where: { workspaceId, id, deletedAt: { not: null } },
    });
    if (!row) throw new ApiException('NOT_FOUND', '回收站对象不存在');
    if (row.version !== expected) throw new ApiException('PRECONDITION_FAILED', '对象版本已变化');
    if (type === 'project') {
      for (const child of ['task', 'entry', 'ledger'] as EntityType[])
        await model(tx, child).updateMany({
          where: { workspaceId, projectId: id },
          data: { projectId: null, version: { increment: 1 } },
        });
    }
    if (type === 'entry') {
      await tx.ledgerRecord.updateMany({
        where: { workspaceId, entryId: id },
        data: { entryId: null, version: { increment: 1 } },
      });
      await tx.taskEntry.deleteMany({ where: { workspaceId, entryId: id } });
      await tx.entryRevision.deleteMany({ where: { workspaceId, entryId: id } });
      await tx.entryUsage.deleteMany({ where: { workspaceId, entryId: id } });
      await tx.entryTag.deleteMany({ where: { workspaceId, entryId: id } });
    }
    if (type === 'task') await tx.taskEntry.deleteMany({ where: { workspaceId, taskId: id } });
    await model(tx, type).deleteMany({
      where: { workspaceId, id, version: expected, deletedAt: { not: null } },
    });
    await tx.auditEvent.create({
      data: {
        workspaceId,
        actorId: userId,
        action: userId ? 'trash.purged' : 'trash.expired',
        entityType: type,
        entityId: id,
        result: 'success',
        summary: userId ? 'Owner确认永久删除' : '回收站30天到期清理',
      },
    });
    return { id, type, deleted: true };
  }
  async remove(
    workspaceId: string,
    userId: string,
    type: EntityType,
    id: string,
    expected: number,
    key: string,
  ) {
    const result = await runIdempotent(
      this.prisma.db,
      { workspaceId, userId, scope: 'trash.purge', key, body: { type, id, expected } },
      async (tx) => {
        await this.lock(tx, workspaceId, userId);
        return this.hard(tx, workspaceId, userId, type, id, expected);
      },
    );
    return { ...result.data, replayed: result.replayed };
  }
  async purgeExpired(now = new Date()) {
    let count = 0;
    for (const type of ['ledger', 'log', 'task', 'entry', 'project'] as EntityType[]) {
      const rows = await model(this.prisma.db, type).findMany({
        where: { deletedAt: { lte: new Date(now.getTime() - 30 * 86400000) } },
        take: 50,
        orderBy: { deletedAt: 'asc' },
      });
      for (const row of rows) {
        try {
          const didPurge = await this.prisma.db.$transaction(async (tx) => {
            await this.lock(tx, String(row['workspaceId']), null);
            const current = await model(tx, type).findFirst({
              where: {
                id: row.id,
                workspaceId: row['workspaceId'],
                deletedAt: { lte: new Date(now.getTime() - 30 * 86400000) },
              },
            });
            if (current)
              await this.hard(tx, String(row['workspaceId']), null, type, row.id, current.version);
            return !!current;
          });
          if (didPurge) count++;
        } catch (error) {
          if (!(error instanceof ApiException)) throw error;
        }
      }
    }
    return { purged: count };
  }
  async clear(
    workspaceId: string,
    userId: string,
    expected: number,
    key: string,
    input: z.infer<typeof clearSchema>,
  ) {
    const user = await this.prisma.db.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await verifyPassword(user.passwordHash, input.password)))
      throw new ApiException('AUTH_INVALID_CREDENTIALS', '重新认证失败');
    const workspace = await this.prisma.db.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
    });
    if (input.confirmName !== workspace.name)
      throw new ApiException('CLEAR_CONFIRMATION_REQUIRED', '空间名称不匹配');
    const backup = await this.transfers.create(
      workspaceId,
      userId,
      'owner',
      { format: 'json', schemaVersion: 2, includeTrash: true },
      'clear-before:' + createHash('sha256').update(key).digest('hex'),
    );
    await this.transfers.tick(backup.id);
    if (
      (await this.prisma.db.transferJob.findUniqueOrThrow({ where: { id: backup.id } })).state !==
      'succeeded'
    )
      throw new ApiException('SERVICE_UNAVAILABLE', '清空前业务快照尚未完成');
    const result = await runIdempotent(
      this.prisma.db,
      {
        workspaceId,
        userId,
        scope: 'workspace.clear',
        key,
        body: { confirmName: input.confirmName, backupAcknowledged: true, expected },
      },
      async (tx) => {
        await this.lock(tx, workspaceId, userId);
        const updated = await tx.workspace.updateMany({
          where: { id: workspaceId, version: expected, status: 'active', name: input.confirmName },
          data: { version: { increment: 1 } },
        });
        if (updated.count !== 1)
          throw new ApiException('PRECONDITION_FAILED', '空间版本已变化，请刷新');
        const counts = {
          projects: await tx.project.count({ where: { workspaceId } }),
          tasks: await tx.task.count({ where: { workspaceId } }),
          entries: await tx.entry.count({ where: { workspaceId } }),
          logs: await tx.developmentLog.count({ where: { workspaceId } }),
          ledger: await tx.ledgerRecord.count({ where: { workspaceId } }),
        };
        await tx.ledgerRecord.deleteMany({ where: { workspaceId } });
        await tx.taskEntry.deleteMany({ where: { workspaceId } });
        await tx.task.deleteMany({ where: { workspaceId } });
        await tx.entryTag.deleteMany({ where: { workspaceId } });
        await tx.entryUsage.deleteMany({ where: { workspaceId } });
        await tx.entryRevision.deleteMany({ where: { workspaceId } });
        await tx.entry.deleteMany({ where: { workspaceId } });
        await tx.developmentLog.deleteMany({ where: { workspaceId } });
        await tx.tag.deleteMany({ where: { workspaceId } });
        await tx.project.deleteMany({ where: { workspaceId } });
        await tx.importEntityMapping.deleteMany({ where: { workspaceId } });
        const audit = await tx.auditEvent.create({
          data: {
            workspaceId,
            actorId: userId,
            action: 'workspace.cleared',
            entityType: 'workspace',
            entityId: workspaceId,
            result: 'success',
            summary: 'Owner重新认证并确认清空空间业务；身份和成员保留',
          },
        });
        return {
          workspaceId,
          counts,
          backupId: backup.id,
          auditEventId: audit.id,
          version: expected + 1,
        };
      },
    );
    return { ...result.data, replayed: result.replayed };
  }
  async audit(workspaceId: string, q: z.infer<typeof auditQuery>) {
    const fingerprint = createHash('sha256')
      .update(workspaceId + ':' + (q.action ?? ''))
      .digest('hex');
    let cursor: { at: string; id: string; f: string } | null = null;
    if (q.cursor) {
      try {
        cursor = z
          .strictObject({ at: z.iso.datetime(), id: z.uuid(), f: z.string() })
          .parse(JSON.parse(Buffer.from(q.cursor, 'base64url').toString()));
        if (cursor.f !== fingerprint) throw new Error('scope');
      } catch {
        throw new ApiException('MALFORMED_REQUEST', '审计游标无效');
      }
    }
    const rows = await this.prisma.db.auditEvent.findMany({
      where: {
        workspaceId,
        ...(q.action ? { action: q.action } : {}),
        ...(cursor
          ? {
              OR: [
                { at: { lt: new Date(cursor.at) } },
                { at: new Date(cursor.at), id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        actorId: true,
        action: true,
        entityType: true,
        entityId: true,
        result: true,
        summary: true,
        at: true,
        requestId: true,
      },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    const page = rows.slice(0, q.limit),
      last = page.at(-1);
    return {
      events: page,
      nextCursor:
        rows.length > q.limit && last
          ? Buffer.from(
              JSON.stringify({ at: last.at.toISOString(), id: last.id, f: fingerprint }),
            ).toString('base64url')
          : null,
    };
  }
}
@Controller('workspaces/:workspaceId')
class MaintenanceController {
  constructor(@Inject(MaintenanceService) readonly service: MaintenanceService) {}
  @Get('trash') @WorkspaceRoleRequired('trash.manage') async list(
    @Req() req: Request,
    @Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>,
  ) {
    return { data: await this.service.list(workspaceContext(req).workspaceId, q) };
  }
  @Post('trash/:type/:id/restore') @WorkspaceRoleRequired('trash.manage') async restore(
    @Req() req: Request,
    @Param('type', new ZodPipe(entityType)) type: EntityType,
    @Param('id', new ZodPipe(z.uuid())) id: string,
    @Headers('if-match') match: string | undefined,
  ) {
    return {
      data: await this.service.restore(
        workspaceContext(req).workspaceId,
        requireRequestAuth(req).userId,
        type,
        id,
        version(match),
      ),
    };
  }
  @Delete('trash/:type/:id') @WorkspaceRoleRequired('trash.manage') async purge(
    @Req() req: Request,
    @Param('type', new ZodPipe(entityType)) type: EntityType,
    @Param('id', new ZodPipe(z.uuid())) id: string,
    @Headers('if-match') match: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body(new ZodPipe(z.strictObject({ confirm: z.literal(true) }))) _body: { confirm: true },
  ) {
    return {
      data: await this.service.remove(
        workspaceContext(req).workspaceId,
        requireRequestAuth(req).userId,
        type,
        id,
        version(match),
        assertIdempotencyKey(key),
      ),
    };
  }
  @Post('maintenance/clear')
  @RateLimit({ limit: 5, ttlMs: 60000 })
  @WorkspaceRoleRequired('clear.workspace')
  async clear(
    @Req() req: Request,
    @Headers('if-match') match: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body(new ZodPipe(clearSchema)) body: z.infer<typeof clearSchema>,
  ) {
    return {
      data: await this.service.clear(
        workspaceContext(req).workspaceId,
        requireRequestAuth(req).userId,
        version(match),
        assertIdempotencyKey(key),
        body,
      ),
    };
  }
  @Get('audit-events') @WorkspaceRoleRequired('audit.read') async audit(
    @Req() req: Request,
    @Query(new ZodPipe(auditQuery)) q: z.infer<typeof auditQuery>,
  ) {
    return { data: await this.service.audit(workspaceContext(req).workspaceId, q) };
  }
}
@Module({
  imports: [TransfersModule],
  controllers: [MaintenanceController],
  providers: [MaintenanceService],
  exports: [MaintenanceService],
})
export class MaintenanceModule {}
