import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Injectable,
  Module,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { APP_CONFIG, PrismaService } from '../../common/prisma.module.js';
import type { AppConfig } from '../../common/config.js';
import { ApiException } from '../../common/api-exception.js';
import { requireTransferCapacity } from '../../common/disk-capacity.js';
import { assertIdempotencyKey, runIdempotent } from '../../common/idempotency.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { workspaceContext } from '../workspaces/workspace.guard.js';
import { WorkspaceRoleRequired } from '../workspaces/permissions.js';
import { requireRequestAuth } from '../auth/auth-context.js';
import type { TransferJob } from '../../generated/prisma/client.js';
const requestSchema = z.strictObject({
  format: z.enum(['json', 'markdown']),
  schemaVersion: z.literal(2).default(2),
  includeTrash: z.boolean().default(false),
});
const leaseMs = 60_000;
export function jobView(job: TransferJob) {
  return {
    id: job.id,
    type: job.type,
    state: job.state,
    counts: job.counts,
    errorCode: job.errorCode,
    fileHash: job.fileHash,
    planHash: job.planHash,
    attempts: job.attempts,
    createdAt: job.createdAt.toISOString(),
    expiresAt: job.expiresAt?.toISOString() ?? null,
  };
}
@Injectable()
export class TransfersService implements OnModuleInit, OnModuleDestroy {
  readonly storage: string;
  private timer?: ReturnType<typeof setInterval>;
  private active: Promise<void> | null = null;
  constructor(
    @Inject(PrismaService) readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.storage = resolve(config.TRANSFER_STORAGE_DIR);
  }
  onModuleInit() {
    if (process.env['TRANSFER_WORKER_ENABLED'] !== 'false') {
      this.timer = setInterval(() => {
        if (!this.active)
          this.active = this.tick()
            .catch(() => undefined)
            .finally(() => {
              this.active = null;
            });
      }, this.config.WORKER_POLL_INTERVAL_MS);
      this.timer.unref();
    }
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
  path(name: string) {
    if (basename(name) !== name || !/^[-a-zA-Z0-9.]+$/.test(name))
      throw new ApiException('NOT_FOUND', '传输文件不存在');
    return resolve(this.storage, name);
  }
  async get(workspaceId: string, userId: string, role: string, id: string) {
    const job = await this.prisma.db.transferJob.findFirst({ where: { workspaceId, id } });
    if (!job || (job.actorId !== userId && role !== 'owner'))
      throw new ApiException('NOT_FOUND', '作业不存在');
    return job;
  }
  async create(
    workspaceId: string,
    userId: string,
    role: string,
    input: z.infer<typeof requestSchema>,
    key: string,
  ) {
    if (input.includeTrash && role !== 'owner')
      throw new ApiException('FORBIDDEN', '含回收站导出仅Owner可执行');
    await requireTransferCapacity(this.storage);
    const result = await runIdempotent(
      this.prisma.db,
      { workspaceId, userId, scope: 'export.create', key, body: input },
      async (tx) => {
        const job = await tx.transferJob.create({
          data: {
            workspaceId,
            actorId: userId,
            type: input.format === 'json' ? 'export_json' : 'export_markdown',
            state: 'queued',
            baseVersions: { includeTrash: input.includeTrash },
            expiresAt: new Date(Date.now() + 86400000),
          },
        });
        await tx.auditEvent.create({
          data: {
            workspaceId,
            actorId: userId,
            action: 'export.queued',
            entityType: 'transfer',
            entityId: job.id,
            result: 'success',
            summary: '业务导出排队',
          },
        });
        return jobView(job);
      },
    );
    return { ...result.data, replayed: result.replayed };
  }
  async tick(jobId?: string) {
    await this.cleanup();
    await this.prisma.db.transferJob.updateMany({
      where: {
        type: { in: ['export_json', 'export_markdown'] },
        state: 'running',
        attempts: { gte: 3 },
        leaseUntil: { lt: new Date() },
      },
      data: { state: 'failed', errorCode: 'EXPORT_ATTEMPTS_EXHAUSTED', leaseUntil: null },
    });
    const now = new Date();
    const candidate = await this.prisma.db.transferJob.findFirst({
      where: {
        ...(jobId ? { id: jobId } : {}),
        type: { in: ['export_json', 'export_markdown'] },
        attempts: { lt: 3 },
        OR: [{ state: 'queued' }, { state: 'running', leaseUntil: { lt: now } }],
      },
      orderBy: { createdAt: 'asc' },
    });
    if (!candidate) return;
    await requireTransferCapacity(this.storage);
    const token = new Date(Date.now() + leaseMs);
    const claimed = await this.prisma.db.transferJob.updateMany({
      where: {
        id: candidate.id,
        state: candidate.state,
        leaseUntil: candidate.leaseUntil,
        attempts: candidate.attempts,
      },
      data: { state: 'running', leaseUntil: token, attempts: { increment: 1 }, errorCode: null },
    });
    if (claimed.count !== 1) return;
    const name = randomUUID() + (candidate.type === 'export_json' ? '.json' : '.md'),
      part = name + '.part';
    await mkdir(this.storage, { recursive: true, mode: 0o700 });
    const handle = await open(this.path(part), 'wx', 0o600);
    const hash = createHash('sha256');
    let lastLease = token;
    const write = async (value: string) => {
      hash.update(value);
      await handle.writeFile(value, 'utf8');
    };
    const renew = async () => {
      const updated = new Date(Date.now() + leaseMs);
      const owned = await this.prisma.db.transferJob.updateMany({
        where: { id: candidate.id, state: 'running', leaseUntil: lastLease },
        data: { leaseUntil: updated },
      });
      if (owned.count !== 1) throw new Error('LEASE_LOST');
      lastLease = updated;
    };
    try {
      const includeTrash =
        (candidate.baseVersions as { includeTrash?: boolean } | null)?.includeTrash === true;
      const counts: Record<string, number> = {};
      const markdown = candidate.type === 'export_markdown';
      await this.prisma.db.$transaction(
        async (tx) => {
          const ws = await tx.workspace.findUniqueOrThrow({ where: { id: candidate.workspaceId } });
          if (markdown)
            await write(
              '# 工作空间业务资料\n\n' +
                JSON.stringify({
                  schemaVersion: 2,
                  exportedAt: new Date().toISOString(),
                  name: ws.name,
                  timezone: ws.timezone,
                }) +
                '\n\n',
            );
          else
            await write(
              '{"schemaVersion":2,"exportedAt":' +
                JSON.stringify(new Date().toISOString()) +
                ',"sourceNamespace":' +
                JSON.stringify('workspace:' + ws.id) +
                ',"timezone":' +
                JSON.stringify(ws.timezone),
            );
          const where = { workspaceId: ws.id, ...(includeTrash ? {} : { deletedAt: null }) };
          const tables = [
            ['projects', tx.project, {}],
            ['tasks', tx.task, { project: { select: { id: true, deletedAt: true } } }],
            ['logs', tx.developmentLog, {}],
            [
              'entries',
              tx.entry,
              {
                project: { select: { id: true, deletedAt: true } },
                tags: { include: { tag: true } },
                usage: true,
                revisions: { orderBy: { savedAt: 'desc' }, take: 5 },
              },
            ],
            [
              'ledger',
              tx.ledgerRecord,
              {
                project: { select: { id: true, deletedAt: true } },
                entry: { select: { id: true, deletedAt: true } },
              },
            ],
          ] as const;
          for (const [table, model, include] of tables) {
            counts[table] = 0;
            if (!markdown) await write(',' + JSON.stringify(table) + ':[');
            let cursor: string | undefined;
            while (true) {
              // Delegate union is widened only at this internal, fixed table list.
              const rows = await (
                model.findMany as unknown as (args: unknown) => Promise<Record<string, unknown>[]>
              )({
                where,
                include,
                orderBy: { id: 'asc' },
                take: 250,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
              });
              for (const row of rows) {
                const {
                  workspaceId: _ws,
                  createdBy: _by,
                  authorId: _author,
                  project,
                  entry,
                  tags,
                  revisions,
                  usage,
                  ...data
                } = row;
                const dateField =
                  table === 'logs'
                    ? 'logDate'
                    : table === 'ledger'
                      ? 'recordDate'
                      : table === 'tasks'
                        ? 'dueDate'
                        : null;
                if (dateField && data[dateField] instanceof Date)
                  data[dateField] = (data[dateField] as Date).toISOString().slice(0, 10);
                if (!includeTrash && project && (project as { deletedAt: Date | null }).deletedAt)
                  data['projectId'] = null;
                if (!includeTrash && entry && (entry as { deletedAt: Date | null }).deletedAt)
                  data['entryId'] = null;
                if (table === 'entries') {
                  data['tags'] = (tags as { tag: { displayName: string } }[]).map(
                    (t) => t.tag.displayName,
                  );
                  data['revisions'] = (
                    revisions as { body: string; savedAt: Date; sourceVersion: number }[]
                  ).map((r) => ({
                    body: r.body,
                    savedAt: r.savedAt.toISOString(),
                    sourceVersion: r.sourceVersion,
                  }));
                  data['usage'] = usage
                    ? {
                        useCount: (usage as { useCount: number }).useCount,
                        lastUsedAt: (usage as { lastUsedAt: Date }).lastUsedAt.toISOString(),
                      }
                    : null;
                }
                if (markdown) {
                  await write(
                    '## ' +
                      table +
                      ' ' +
                      JSON.stringify(data['title'] ?? data['name'] ?? data['id']) +
                      '\n\n元信息：' +
                      JSON.stringify({ ...data, body: undefined }) +
                      '\n\n' +
                      (typeof data['body'] === 'string' ? data['body'] : '') +
                      '\n\n',
                  );
                } else {
                  if (counts[table]! > 0) await write(',');
                  await write(JSON.stringify(data));
                }
                counts[table]!++;
              }
              await renew();
              if (rows.length < 250) break;
              cursor = String(rows.at(-1)!['id']);
            }
            if (!markdown) await write(']');
          }
          if (!markdown) {
            await write(',"taskEntries":[');
            let cursor: { taskId: string; entryId: string } | undefined;
            let count = 0;
            while (true) {
              const links = await tx.taskEntry.findMany({
                where: {
                  workspaceId: ws.id,
                  ...(includeTrash
                    ? {}
                    : { task: { deletedAt: null }, entry: { deletedAt: null } }),
                },
                select: { taskId: true, entryId: true },
                orderBy: [{ taskId: 'asc' }, { entryId: 'asc' }],
                take: 250,
                ...(cursor ? { cursor: { taskId_entryId: cursor }, skip: 1 } : {}),
              });
              for (const link of links) {
                if (count++) await write(',');
                await write(JSON.stringify(link));
              }
              await renew();
              if (links.length < 250) break;
              cursor = links.at(-1)!;
            }
            await write(']}');
            counts['taskEntries'] = count;
          }
        },
        { isolationLevel: 'RepeatableRead', timeout: 120_000, maxWait: 5000 },
      );
      await handle.sync();
      await handle.close();
      await rename(this.path(part), this.path(name));
      const saved = await this.prisma.db.$transaction(async (tx) => {
        const result = await tx.transferJob.updateMany({
          where: { id: candidate.id, state: 'running', leaseUntil: lastLease },
          data: {
            state: 'succeeded',
            fileRef: name,
            fileHash: hash.digest('hex'),
            counts,
            leaseUntil: null,
            expiresAt: new Date(Date.now() + 86400000),
          },
        });
        if (result.count === 1) {
          await tx.workspaceUserPreference.upsert({
            where: {
              workspaceId_userId: { workspaceId: candidate.workspaceId, userId: candidate.actorId },
            },
            create: {
              workspaceId: candidate.workspaceId,
              userId: candidate.actorId,
              lastBusinessExportAt: new Date(),
            },
            update: { lastBusinessExportAt: new Date(), version: { increment: 1 } },
          });
          await tx.auditEvent.create({
            data: {
              workspaceId: candidate.workspaceId,
              actorId: candidate.actorId,
              action: 'export.succeeded',
              entityType: 'transfer',
              entityId: candidate.id,
              result: 'success',
              summary: '业务导出完成',
            },
          });
        }
        return result.count;
      });
      if (saved !== 1) await rm(this.path(name), { force: true });
    } catch {
      await handle.close().catch(() => undefined);
      await rm(this.path(part), { force: true });
      await rm(this.path(name), { force: true });
      await this.prisma.db.transferJob.updateMany({
        where: { id: candidate.id, state: 'running', leaseUntil: lastLease },
        data: {
          state: candidate.attempts + 1 < 3 ? 'queued' : 'failed',
          errorCode: 'EXPORT_FAILED',
          leaseUntil: null,
        },
      });
    }
  }
  async cleanup() {
    const jobs = await this.prisma.db.transferJob.findMany({
      where: {
        state: { in: ['succeeded', 'failed', 'cancelled', 'preview_ready'] },
        expiresAt: { lt: new Date() },
      },
      take: 100,
    });
    for (const job of jobs) {
      if (job.fileRef) await rm(this.path(job.fileRef), { force: true });
      if (job.type === 'import')
        await this.prisma.db.importItem.deleteMany({ where: { jobId: job.id } });
      await this.prisma.db.transferJob.updateMany({
        where: { id: job.id, state: job.state },
        data: { state: 'expired', fileRef: null, baseVersions: undefined },
      });
    }
    // Abandoned partial files are never downloadable; reclaim after 24 hours.
    for (const entry of await readdir(this.storage, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile() || !entry.name.endsWith('.part')) continue;
      const target = this.path(entry.name),
        info = await stat(target);
      if (info.mtimeMs < Date.now() - 86400000) await rm(target, { force: true });
    }
  }
  async download(job: TransferJob, res: Response) {
    if (
      job.type === 'import' ||
      job.state !== 'succeeded' ||
      !job.fileRef ||
      !job.expiresAt ||
      job.expiresAt < new Date()
    )
      throw new ApiException('TRANSFER_STATE_INVALID', '文件尚未就绪或已过期');
    const file = this.path(job.fileRef);
    try {
      await stat(file);
    } catch {
      throw new ApiException('NOT_FOUND', '文件不存在或已清理');
    }
    res.setHeader(
      'Content-Type',
      job.type === 'export_json'
        ? 'application/json; charset=utf-8'
        : 'text/markdown; charset=utf-8',
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="workbench-' +
        job.id +
        (job.type === 'export_json' ? '.json' : '.md') +
        '"',
    );
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    await pipeline(createReadStream(file), res);
  }
}
@Controller('workspaces/:workspaceId')
class TransfersController {
  constructor(@Inject(TransfersService) private readonly service: TransfersService) {}
  @Get('transfers')
  async list(@Req() req: Request) {
    const ws = workspaceContext(req);
    return {
      data: {
        jobs: (
          await this.service.prisma.db.transferJob.findMany({
            where: {
              workspaceId: ws.workspaceId,
              ...(ws.role === 'owner' ? {} : { actorId: requireRequestAuth(req).userId }),
            },
            orderBy: { createdAt: 'desc' },
            take: 30,
          })
        ).map(jobView),
      },
    };
  }
  @Post('exports')
  @HttpCode(202)
  @WorkspaceRoleRequired('data.export')
  async create(
    @Req() req: Request,
    @Headers('idempotency-key') key: string | undefined,
    @Body(new ZodPipe(requestSchema)) body: z.infer<typeof requestSchema>,
  ) {
    const ws = workspaceContext(req);
    return {
      data: await this.service.create(
        ws.workspaceId,
        requireRequestAuth(req).userId,
        ws.role,
        body,
        assertIdempotencyKey(key),
      ),
    };
  }
  @Get('transfers/:jobId')
  async status(@Req() req: Request, @Param('jobId', new ZodPipe(z.uuid())) id: string) {
    const ws = workspaceContext(req);
    return {
      data: jobView(
        await this.service.get(ws.workspaceId, requireRequestAuth(req).userId, ws.role, id),
      ),
    };
  }
  @Get('transfers/:jobId/download')
  async download(
    @Req() req: Request,
    @Param('jobId', new ZodPipe(z.uuid())) id: string,
    @Res() res: Response,
  ) {
    const ws = workspaceContext(req);
    await this.service.download(
      await this.service.get(ws.workspaceId, requireRequestAuth(req).userId, ws.role, id),
      res,
    );
  }
}
@Module({
  controllers: [TransfersController],
  providers: [TransfersService],
  exports: [TransfersService],
})
export class TransfersModule {}
