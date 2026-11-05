import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Injectable,
  Module,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { parseEtag } from '@aiwb/contracts';
import { businessDate, isValidDate } from '@aiwb/domain';
import { PrismaService } from '../../common/prisma.module.js';
import { ApiException } from '../../common/api-exception.js';
import { runIdempotent, assertIdempotencyKey } from '../../common/idempotency.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { workspaceContext } from '../workspaces/workspace.guard.js';
import { WorkspaceRoleRequired } from '../workspaces/permissions.js';
import { requireRequestAuth } from '../auth/auth-context.js';
import type { DevelopmentLog } from '../../generated/prisma/client.js';
const date = z.string().refine(isValidDate, '日期无效');
const create = z.strictObject({
  text: z.string().trim().min(1).max(4000),
  logDate: date.optional(),
});
const filter = z.strictObject({
  date: date.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(2048).optional(),
});
const cursorSchema = z.strictObject({ d: date, c: z.iso.datetime(), i: z.uuid(), f: z.string() });
const view = (row: DevelopmentLog) => ({
  id: row.id,
  logDate: row.logDate.toISOString().slice(0, 10),
  text: row.text,
  authorId: row.authorId,
  version: row.version,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});
@Injectable()
export class LogsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}
  async list(workspaceId: string, query: z.infer<typeof filter>) {
    const fingerprint = createHash('sha256')
      .update(workspaceId + ':' + (query.date ?? ''))
      .digest('hex');
    let cursor: z.infer<typeof cursorSchema> | null = null;
    if (query.cursor) {
      try {
        cursor = cursorSchema.parse(
          JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')),
        );
        if (cursor.f !== fingerprint) throw new Error('scope');
      } catch {
        throw new ApiException('MALFORMED_REQUEST', '日志游标无效，请重新查询');
      }
    }
    const rows = await this.prisma.db.developmentLog.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        ...(query.date ? { logDate: new Date(query.date + 'T00:00:00Z') } : {}),
        ...(cursor
          ? {
              OR: [
                { logDate: { lt: new Date(cursor.d + 'T00:00:00Z') } },
                {
                  logDate: new Date(cursor.d + 'T00:00:00Z'),
                  createdAt: { lt: new Date(cursor.c) },
                },
                {
                  logDate: new Date(cursor.d + 'T00:00:00Z'),
                  createdAt: new Date(cursor.c),
                  id: { lt: cursor.i },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ logDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit),
      last = page.at(-1),
      hasMore = rows.length > query.limit;
    return {
      logs: page.map(view),
      hasMore,
      nextCursor:
        hasMore && last
          ? Buffer.from(
              JSON.stringify({
                d: last.logDate.toISOString().slice(0, 10),
                c: last.createdAt.toISOString(),
                i: last.id,
                f: fingerprint,
              }),
            ).toString('base64url')
          : null,
    };
  }
  async create(workspaceId: string, userId: string, input: z.infer<typeof create>, key: string) {
    const workspace = await this.prisma.db.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
    });
    const logDate = input.logDate ?? businessDate(new Date(), workspace.timezone);
    const result = await runIdempotent(
      this.prisma.db,
      { workspaceId, userId, scope: 'log.create', key, body: input },
      async (tx) => {
        const log = await tx.developmentLog.create({
          data: {
            workspaceId,
            authorId: userId,
            logDate: new Date(logDate + 'T00:00:00Z'),
            text: input.text,
          },
        });
        await tx.auditEvent.create({
          data: {
            workspaceId,
            actorId: userId,
            action: 'log.created',
            entityType: 'log',
            entityId: log.id,
            result: 'success',
            summary: '新增开发日志',
          },
        });
        return view(log);
      },
    );
    return { log: result.data, replayed: result.replayed };
  }
  async change(
    workspaceId: string,
    userId: string,
    id: string,
    ifMatch: string | undefined,
    input: z.infer<typeof create> | null,
  ) {
    const version = ifMatch === undefined ? null : parseEtag(ifMatch);
    if (version === null) throw new ApiException('PRECONDITION_REQUIRED', '日志修改需要If-Match');
    return this.prisma.db.$transaction(async (tx) => {
      const current = await tx.developmentLog.findFirst({
        where: { workspaceId, id, deletedAt: null },
      });
      if (!current) throw new ApiException('NOT_FOUND', '日志不存在');
      if (current.version !== version)
        throw new ApiException('PRECONDITION_FAILED', '日志已更新', {
          currentVersion: current.version,
        });
      const changed = await tx.developmentLog.updateMany({
        where: { workspaceId, id, version, deletedAt: null },
        data: {
          version: { increment: 1 },
          ...(input
            ? {
                text: input.text,
                ...(input.logDate ? { logDate: new Date(input.logDate + 'T00:00:00Z') } : {}),
              }
            : { deletedAt: new Date() }),
        },
      });
      if (changed.count !== 1) throw new ApiException('PRECONDITION_FAILED', '日志已更新');
      await tx.auditEvent.create({
        data: {
          workspaceId,
          actorId: userId,
          action: input ? 'log.updated' : 'log.deleted',
          entityType: 'log',
          entityId: id,
          result: 'success',
          summary: input ? '更新开发日志' : '开发日志进入回收站',
        },
      });
      return input
        ? view(await tx.developmentLog.findUniqueOrThrow({ where: { id } }))
        : { status: 'deleted' };
    });
  }
}
@Controller('workspaces/:workspaceId/logs')
export class LogsController {
  constructor(@Inject(LogsService) private readonly logs: LogsService) {}
  @Get()
  async list(@Req() req: Request, @Query(new ZodPipe(filter)) query: z.infer<typeof filter>) {
    return { data: await this.logs.list(workspaceContext(req).workspaceId, query) };
  }
  @Post()
  @HttpCode(201)
  @WorkspaceRoleRequired('business.write')
  async create(
    @Req() req: Request,
    @Headers('idempotency-key') key: string | undefined,
    @Body(new ZodPipe(create)) body: z.infer<typeof create>,
  ) {
    return {
      data: await this.logs.create(
        workspaceContext(req).workspaceId,
        requireRequestAuth(req).userId,
        body,
        assertIdempotencyKey(key),
      ),
    };
  }
  @Patch(':id')
  @WorkspaceRoleRequired('business.write')
  async update(
    @Req() req: Request,
    @Param('id', new ZodPipe(z.uuid())) id: string,
    @Headers('if-match') version: string | undefined,
    @Body(new ZodPipe(create)) body: z.infer<typeof create>,
  ) {
    return {
      data: await this.logs.change(
        workspaceContext(req).workspaceId,
        requireRequestAuth(req).userId,
        id,
        version,
        body,
      ),
    };
  }
  @Delete(':id')
  @WorkspaceRoleRequired('business.write')
  async remove(
    @Req() req: Request,
    @Param('id', new ZodPipe(z.uuid())) id: string,
    @Headers('if-match') version: string | undefined,
  ) {
    return {
      data: await this.logs.change(
        workspaceContext(req).workspaceId,
        requireRequestAuth(req).userId,
        id,
        version,
        null,
      ),
    };
  }
}
@Module({ controllers: [LogsController], providers: [LogsService], exports: [LogsService] })
export class LogsModule {}
