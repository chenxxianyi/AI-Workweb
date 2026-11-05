import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Module,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { businessDate, isValidDate } from '@aiwb/domain';
import { PrismaService } from '../../common/prisma.module.js';
import { ApiException } from '../../common/api-exception.js';
import { assertIdempotencyKey, runIdempotent } from '../../common/idempotency.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { requireRequestAuth } from '../auth/auth-context.js';
import { workspaceContext } from '../workspaces/workspace.guard.js';
import { WorkspaceRoleRequired } from '../workspaces/permissions.js';
const date = z.string().refine(isValidDate);
const operation = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('log'),
    payload: z.strictObject({ text: z.string().trim().min(1).max(4000), logDate: date }),
  }),
  z.strictObject({
    kind: z.literal('draft'),
    payload: z.strictObject({
      title: z.string().max(200),
      body: z.string().refine((v) => Buffer.byteLength(v, 'utf8') <= 20480),
      type: z.enum(['note', 'design', 'adr', 'troubleshoot', 'command']).default('note'),
    }),
  }),
  z.strictObject({
    kind: z.literal('task-state'),
    payload: z.strictObject({
      id: z.uuid(),
      status: z.enum(['todo', 'doing', 'done']),
      version: z.number().int().positive(),
    }),
  }),
]);
const schema = z.strictObject({
  userId: z.uuid(),
  workspaceVersion: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  operation,
});
@Controller('workspaces/:workspaceId/offline-operations')
class OfflineController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}
  @Get('context')
  context(@Req() req: Request) {
    const ctx = workspaceContext(req);
    return {
      data: {
        workspaceVersion: ctx.workspace.version,
        businessDate: businessDate(new Date(), ctx.workspace.timezone),
        canWrite: ctx.role !== 'viewer',
      },
    };
  }
  @Get(':key')
  async result(@Req() req: Request, @Param('key') key: string) {
    const row = await this.prisma.db.idempotencyRecord.findUnique({
      where: {
        userId_workspaceId_scope_key: {
          userId: requireRequestAuth(req).userId,
          workspaceId: workspaceContext(req).workspaceId,
          scope: 'offline.operation',
          key: assertIdempotencyKey(key),
        },
      },
    });
    return {
      data: row ? { status: row.status, result: row.responseRef } : { status: 'not_found' },
    };
  }
  @Post()
  @HttpCode(200)
  @WorkspaceRoleRequired('business.write')
  async apply(
    @Req() req: Request,
    @Headers('idempotency-key') key: string | undefined,
    @Body(new ZodPipe(schema)) body: z.infer<typeof schema>,
  ) {
    const userId = requireRequestAuth(req).userId,
      workspaceId = workspaceContext(req).workspaceId;
    if (body.userId !== userId) throw new ApiException('FORBIDDEN', '离线操作属于另一账号');
    const age = Date.now() - Date.parse(body.createdAt);
    if (age > 7 * 86400000 || age < -300000)
      throw new ApiException('CONFLICT', '离线操作已过期或本机时间错误，请保留草稿并重新确认');
    const result = await runIdempotent(
      this.prisma.db,
      { userId, workspaceId, scope: 'offline.operation', key: assertIdempotencyKey(key), body },
      async (tx) => {
        // 与空间清空、成员撤销串行化；守卫之后的权限变更也不能越过此锁。
        const spaces = await tx.$queryRaw<
          { version: number; status: string }[]
        >`SELECT version,status FROM workspaces WHERE id=${workspaceId}::uuid FOR SHARE`;
        const members = await tx.$queryRaw<
          { role: string; status: string }[]
        >`SELECT role,status FROM workspace_members WHERE workspace_id=${workspaceId}::uuid AND user_id=${userId}::uuid FOR SHARE`;
        if (
          !members[0] ||
          members[0].status !== 'active' ||
          members[0].role === 'viewer' ||
          spaces[0]?.status !== 'active'
        )
          throw new ApiException('FORBIDDEN', '当前身份不能同步到此空间');
        if (spaces[0].version !== body.workspaceVersion)
          throw new ApiException('PLAN_STALE', '空间已变更，请人工核对离线意图');
        const op = body.operation;
        let id: string, version: number;
        if (op.kind === 'log') {
          const row = await tx.developmentLog.create({
            data: {
              workspaceId,
              authorId: userId,
              text: op.payload.text,
              logDate: new Date(op.payload.logDate + 'T00:00:00Z'),
            },
          });
          id = row.id;
          version = row.version;
        } else if (op.kind === 'draft') {
          if (!op.payload.title.trim() && !op.payload.body.trim())
            throw new ApiException('VALIDATION_FAILED', '标题或正文至少填写一项');
          const row = await tx.entry.create({
            data: { workspaceId, createdBy: userId, status: 'draft', ...op.payload },
          });
          id = row.id;
          version = row.version;
        } else {
          const row = await tx.task.findFirst({
            where: { workspaceId, id: op.payload.id, deletedAt: null },
          });
          if (!row) throw new ApiException('NOT_FOUND', '任务已删除');
          if (row.version !== op.payload.version)
            throw new ApiException('PRECONDITION_FAILED', '任务已更新，请比较后重新确认', {
              currentVersion: row.version,
            });
          const changed = await tx.task.updateMany({
            where: { workspaceId, id: row.id, version: row.version, deletedAt: null },
            data: {
              status: op.payload.status,
              doneAt: op.payload.status === 'done' ? new Date() : null,
              version: { increment: 1 },
            },
          });
          if (changed.count !== 1) throw new ApiException('PRECONDITION_FAILED', '任务已更新');
          if (row.projectId)
            await tx.project.updateMany({
              where: { id: row.projectId, workspaceId, deletedAt: null },
              data: { lastActivityAt: new Date() },
            });
          id = row.id;
          version = row.version + 1;
        }
        await tx.auditEvent.create({
          data: {
            workspaceId,
            actorId: userId,
            action: 'offline.' + op.kind,
            entityType: op.kind,
            entityId: id,
            result: 'success',
            summary: '离线操作同步',
          },
        });
        return { id, version, kind: op.kind };
      },
    );
    return { data: { ...result.data, replayed: result.replayed } };
  }
}
@Module({ controllers: [OfflineController] })
export class OfflineModule {}
