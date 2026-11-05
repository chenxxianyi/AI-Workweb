import type { OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Injectable,
  Module,
  Param,
  Post,
  Get,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import { z } from 'zod';
import { PrismaService, APP_CONFIG } from '../../common/prisma.module.js';
import type { AppConfig } from '../../common/config.js';
import { ApiException } from '../../common/api-exception.js';
import { requireTransferCapacity } from '../../common/disk-capacity.js';
import { assertIdempotencyKey, runIdempotent } from '../../common/idempotency.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { TransfersModule, TransfersService, jobView } from './transfers.module.js';
import { workspaceContext } from '../workspaces/workspace.guard.js';
import { WorkspaceRoleRequired } from '../workspaces/permissions.js';
import { requireRequestAuth } from '../auth/auth-context.js';
import { scanImport, importRows } from './import-stream.js';
import { ImportCommitService, commitSchema } from './import-commit.js';
import { deterministicId, normalize, tables, types, type EntityType } from './import-format.js';
import type { Prisma, TransferJob, ImportItem } from '../../generated/prisma/client.js';
const namespace = z.string().regex(/^[a-zA-Z0-9:_-]{1,64}$/);
const query = z.strictObject({ sourceNamespace: namespace.optional() });
const maxBytes = 512 * 1024 * 1024,
  maxEntities = 250000;
export interface PlanItem {
  targetId: string;
  action: 'create' | 'update' | 'keep' | 'conflict';
  baseVersion: number | null;
  missing: string[];
  sourceUpdatedAt: string;
}
@Injectable()
export class ImportsService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private active: Promise<unknown> | null = null;
  constructor(
    @Inject(PrismaService) readonly prisma: PrismaService,
    @Inject(TransfersService) readonly transfers: TransfersService,
    @Inject(ImportCommitService) readonly commit: ImportCommitService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}
  onModuleInit() {
    if (process.env['TRANSFER_WORKER_ENABLED'] !== 'false') {
      this.timer = setInterval(() => {
        if (!this.active)
          this.active = this.resume()
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
  async resume() {
    const job = await this.prisma.db.transferJob.findFirst({
      where: {
        type: 'import',
        OR: [
          { state: 'uploaded' },
          { state: 'validating', leaseUntil: { lt: new Date() } },
          { state: 'queued' },
          { state: 'running', leaseUntil: { lt: new Date() } },
        ],
      },
      orderBy: { createdAt: 'asc' },
    });
    if (job) {
      if (job.state === 'queued' || job.state === 'running') await this.commit.apply(job.id);
      else await this.validate(job.id);
    }
  }
  async upload(
    workspaceId: string,
    userId: string,
    sourceNamespace: string | undefined,
    key: string,
    stream: AsyncIterable<Buffer | string>,
    length?: number,
  ) {
    if (length && length > maxBytes) throw new ApiException('PAYLOAD_TOO_LARGE', '文件最多512MiB');
    await requireTransferCapacity(this.transfers.storage, length ?? maxBytes);
    await mkdir(this.transfers.storage, { recursive: true, mode: 0o700 });
    const name = randomUUID() + '.upload.json';
    const handle = await open(this.transfers.path(name), 'wx', 0o600);
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > maxBytes) throw new ApiException('PAYLOAD_TOO_LARGE', '文件最多512MiB');
        hash.update(buffer);
        await handle.writeFile(buffer);
      }
      await handle.sync();
    } catch (error) {
      await handle.close();
      await rm(this.transfers.path(name), { force: true });
      throw error;
    }
    await handle.close();
    const fileHash = hash.digest('hex');
    let jobId: string;
    try {
      const result = await runIdempotent(
        this.prisma.db,
        {
          workspaceId,
          userId,
          scope: 'import.preview',
          key,
          body: { fileHash, sourceNamespace: sourceNamespace ?? null },
        },
        async (tx) => {
          const job = await tx.transferJob.create({
            data: {
              workspaceId,
              actorId: userId,
              type: 'import',
              state: 'uploaded',
              fileRef: name,
              fileHash,
              sourceNamespace: sourceNamespace ?? null,
              expiresAt: new Date(Date.now() + 86400000),
            },
          });
          return { id: job.id };
        },
      );
      jobId = result.data.id;
      if (result.replayed) await rm(this.transfers.path(name), { force: true });
    } catch (error) {
      await rm(this.transfers.path(name), { force: true });
      throw error;
    }
    await this.validate(jobId);
    const job = await this.prisma.db.transferJob.findUniqueOrThrow({ where: { id: jobId } });
    if (job.state === 'failed')
      throw new ApiException(
        (job.errorCode ?? 'VALIDATION_FAILED') as 'VALIDATION_FAILED',
        '导入文件未通过校验',
        { details: { jobId: job.id } },
      );
    return jobView(job);
  }
  async current(type: EntityType, workspaceId: string, id: string) {
    const model = {
      project: this.prisma.db.project,
      task: this.prisma.db.task,
      entry: this.prisma.db.entry,
      log: this.prisma.db.developmentLog,
      ledger: this.prisma.db.ledgerRecord,
    }[type];
    return (
      model.findFirst as unknown as (
        args: unknown,
      ) => Promise<{ id: string; version: number; deletedAt: Date | null } | null>
    )({ where: { workspaceId, id }, select: { id: true, version: true, deletedAt: true } });
  }
  async validate(id: string) {
    const job = await this.prisma.db.transferJob.findUniqueOrThrow({ where: { id } });
    if (
      !['uploaded', 'validating'].includes(job.state) ||
      (job.state === 'validating' && job.leaseUntil && job.leaseUntil > new Date())
    )
      return;
    const lease = new Date(Date.now() + 60000);
    const claimed = await this.prisma.db.transferJob.updateMany({
      where: { id, state: job.state, leaseUntil: job.leaseUntil },
      data: { state: 'validating', leaseUntil: lease, attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) return;
    let token = lease;
    const renew = async () => {
      const next = new Date(Date.now() + 60000);
      const r = await this.prisma.db.transferJob.updateMany({
        where: { id, state: 'validating', leaseUntil: token },
        data: { leaseUntil: next },
      });
      if (r.count !== 1) throw new ApiException('CONFLICT', '校验租约已失效');
      token = next;
    };
    try {
      if (!job.fileRef) throw new ApiException('MALFORMED_REQUEST', '文件不存在');
      const file = this.transfers.path(job.fileRef),
        scanned = await scanImport(file);
      await renew();
      const source = namespace.parse(job.sourceNamespace ?? scanned.metadata['sourceNamespace']);
      await this.prisma.db.importItem.deleteMany({ where: { jobId: id } });
      const maps = await this.prisma.db.importEntityMapping.findMany({
        where: { workspaceId: job.workspaceId, sourceNamespace: source },
      });
      const mapped = new Map(maps.map((m) => [m.entityType + ':' + m.legacyId, m]));
      const seen = new Map<EntityType, Set<string>>(types.map((t) => [t, new Set()]));
      const links = new Map<string, { taskId: string; entryId: string }>();
      let total = 0;
      const counts = { created: 0, updated: 0, kept: 0, conflicts: 0, broken: 0, total: 0 };
      for (const type of types) {
        const occurrences = new Map<string, number>();
        let batch: Prisma.ImportItemCreateManyInput[] = [];
        if (!scanned.keys.has(tables[type])) continue;
        for await (const raw of importRows(file, tables[type])) {
          if (++total > maxEntities) throw new ApiException('PAYLOAD_TOO_LARGE', '最多25万条实体');
          const payload = normalize(type, raw, scanned.version, occurrences);
          if (seen.get(type)!.has(payload.id))
            throw new ApiException('VALIDATION_FAILED', '同一集合存在重复来源id');
          seen.get(type)!.add(payload.id);
          const mapping = mapped.get(type + ':' + payload.id);
          const targetId =
            mapping?.entityId ?? deterministicId(job.workspaceId, source, type, payload.id);
          const current = mapping ? await this.current(type, job.workspaceId, targetId) : null;
          let action: PlanItem['action'] = 'create';
          if (mapping) {
            if (!current || current.deletedAt || current.version !== mapping.lastImportedVersion)
              action = 'conflict';
            else if (
              new Date(payload.updatedAt).getTime() <= (mapping.sourceUpdatedAt?.getTime() ?? 0)
            )
              action = 'keep';
            else action = 'update';
          }
          const plan: PlanItem = {
            targetId,
            action,
            baseVersion: current?.version ?? null,
            missing: [],
            sourceUpdatedAt: payload.updatedAt,
          };
          if (action === 'create') counts.created++;
          else if (action === 'update') counts.updated++;
          else if (action === 'conflict') counts.conflicts++;
          else counts.kept++;
          batch.push({
            jobId: id,
            entityType: type,
            sourceId: payload.id,
            normalizedPayload: payload as unknown as Prisma.InputJsonValue,
            validationResult: plan as unknown as Prisma.InputJsonValue,
            decision: action === 'conflict' ? 'keep_server' : null,
          });
          if (type === 'task')
            for (const entryId of (payload as { entryIds: string[] }).entryIds)
              links.set(JSON.stringify([payload.id, entryId]), { taskId: payload.id, entryId });
          if (batch.length >= 250) {
            await renew();
            await this.prisma.db.importItem.createMany({ data: batch });
            batch = [];
          }
        }
        if (batch.length) await this.prisma.db.importItem.createMany({ data: batch });
        await renew();
      }
      if (scanned.keys.has('taskEntries'))
        for await (const raw of importRows(file, 'taskEntries')) {
          const link = z
            .strictObject({ taskId: z.string().max(200), entryId: z.string().max(200) })
            .parse(raw);
          links.set(JSON.stringify([link.taskId, link.entryId]), link);
          if (links.size > maxEntities)
            throw new ApiException('PAYLOAD_TOO_LARGE', '关系最多25万条');
        }
      for (const link of links.values())
        await this.prisma.db.importItem.create({
          data: {
            jobId: id,
            entityType: 'task_entry',
            sourceId: createHash('sha256').update(JSON.stringify(link)).digest('hex'),
            normalizedPayload: link,
          },
        });
      const reference = async (type: EntityType, sourceId: string) =>
        seen.get(type)!.has(sourceId) ||
        !!(
          mapped.get(type + ':' + sourceId) &&
          (await this.current(type, job.workspaceId, mapped.get(type + ':' + sourceId)!.entityId))
            ?.deletedAt === null
        );
      let cursor: string | undefined;
      while (true) {
        const items: ImportItem[] = await this.prisma.db.importItem.findMany({
          where: { jobId: id },
          orderBy: { id: 'asc' },
          take: 250,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        for (const item of items) {
          const p = item.normalizedPayload as Record<string, unknown>,
            missing: string[] = [];
          for (const [field, type] of [
            ['projectId', 'project'],
            ['entryId', 'entry'],
            ['taskId', 'task'],
          ] as const)
            if (p[field] && !(await reference(type, String(p[field])))) missing.push(field);
          if (missing.length) {
            counts.broken += missing.length;
            await this.prisma.db.importItem.update({
              where: { id: item.id },
              data: { validationResult: { ...((item.validationResult as object) ?? {}), missing } },
            });
          }
        }
        await renew();
        if (items.length < 250) break;
        cursor = items.at(-1)!.id;
      }
      const digest = createHash('sha256').update(job.fileHash! + source);
      cursor = undefined;
      while (true) {
        const items: ImportItem[] = await this.prisma.db.importItem.findMany({
          where: { jobId: id },
          orderBy: [{ entityType: 'asc' }, { sourceId: 'asc' }, { id: 'asc' }],
          take: 250,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        for (const item of items)
          digest.update(
            JSON.stringify([
              item.entityType,
              item.sourceId,
              item.normalizedPayload,
              item.validationResult,
            ]),
          );
        if (items.length < 250) break;
        cursor = items.at(-1)!.id;
      }
      counts.total = total;
      const updated = await this.prisma.db.transferJob.updateMany({
        where: { id, state: 'validating', leaseUntil: token },
        data: {
          state: 'preview_ready',
          baseVersions: {
            workspaceVersion: (
              await this.prisma.db.workspace.findUniqueOrThrow({ where: { id: job.workspaceId } })
            ).version,
          },
          sourceNamespace: source,
          planHash: digest.digest('hex'),
          counts,
          leaseUntil: null,
          errorCode: null,
        },
      });
      if (updated.count !== 1) throw new ApiException('CONFLICT', '计划已失效');
    } catch (error) {
      const code = error instanceof ApiException ? error.code : 'VALIDATION_FAILED';
      await this.prisma.db.transferJob.updateMany({
        where: { id, state: 'validating', leaseUntil: token },
        data: {
          state: 'failed',
          errorCode: code,
          leaseUntil: null,
          counts: {
            validationError:
              error instanceof ApiException
                ? JSON.parse(JSON.stringify(error.getResponse()))
                : { code: 'VALIDATION_FAILED', message: '文件结构或字段校验失败' },
          },
        },
      });
    }
  }
  async items(job: TransferJob, cursor?: string) {
    if (
      cursor &&
      !(await this.prisma.db.importItem.findFirst({ where: { jobId: job.id, id: cursor } }))
    )
      throw new ApiException('MALFORMED_REQUEST', '游标不属于当前预览');
    const rows = await this.prisma.db.importItem.findMany({
      where: { jobId: job.id },
      orderBy: { id: 'asc' },
      take: 101,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    return {
      items: rows.slice(0, 100).map((r) => ({
        id: r.id,
        type: r.entityType,
        sourceId: r.sourceId,
        incoming: r.normalizedPayload,
        plan: r.validationResult,
      })),
      nextCursor: rows.length > 100 ? rows[99]!.id : null,
    };
  }
}
@Controller('workspaces/:workspaceId/imports')
class ImportsController {
  constructor(@Inject(ImportsService) private readonly service: ImportsService) {}
  @Post(':jobId/commit')
  @HttpCode(202)
  @WorkspaceRoleRequired('data.import')
  async commit(
    @Req() req: Request,
    @Param('jobId', new ZodPipe(z.uuid())) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body(new ZodPipe(commitSchema)) body: z.infer<typeof commitSchema>,
  ) {
    return {
      data: await this.service.commit.prepare(
        workspaceContext(req).workspaceId,
        requireRequestAuth(req).userId,
        id,
        body,
        assertIdempotencyKey(key),
      ),
    };
  }
  @Post(':jobId/cancel')
  @WorkspaceRoleRequired('data.import')
  async cancel(@Req() req: Request, @Param('jobId', new ZodPipe(z.uuid())) id: string) {
    return {
      data: await this.service.commit.cancel(
        workspaceContext(req).workspaceId,
        requireRequestAuth(req).userId,
        id,
      ),
    };
  }
  @Get(':jobId/recovery')
  @WorkspaceRoleRequired('data.import')
  async recovery(@Req() req: Request, @Param('jobId', new ZodPipe(z.uuid())) id: string) {
    return {
      data: await this.service.commit.recovery(
        workspaceContext(req).workspaceId,
        requireRequestAuth(req).userId,
        id,
      ),
    };
  }
  @Post('preview')
  @HttpCode(202)
  @WorkspaceRoleRequired('data.import')
  async upload(
    @Req() req: Request,
    @Headers('idempotency-key') key: string | undefined,
    @Query(new ZodPipe(query)) q: z.infer<typeof query>,
  ) {
    if (!String(req.headers['content-type'] ?? '').startsWith('application/octet-stream'))
      throw new ApiException('UNSUPPORTED_MEDIA_TYPE', '使用application/octet-stream上传JSON文件');
    return {
      data: await this.service.upload(
        workspaceContext(req).workspaceId,
        requireRequestAuth(req).userId,
        q.sourceNamespace,
        assertIdempotencyKey(key),
        req,
        Number(req.headers['content-length']) || undefined,
      ),
    };
  }
  @Get(':jobId/items')
  @WorkspaceRoleRequired('data.import')
  async items(
    @Req() req: Request,
    @Param('jobId', new ZodPipe(z.uuid())) id: string,
    @Query('cursor') cursor?: string,
  ) {
    const ws = workspaceContext(req);
    const job = await this.service.transfers.get(
      ws.workspaceId,
      requireRequestAuth(req).userId,
      ws.role,
      id,
    );
    if (cursor && !z.uuid().safeParse(cursor).success)
      throw new ApiException('MALFORMED_REQUEST', '游标无效');
    return { data: await this.service.items(job, cursor) };
  }
}
@Module({
  imports: [TransfersModule],
  controllers: [ImportsController],
  providers: [ImportsService, ImportCommitService],
  exports: [ImportsService, ImportCommitService],
})
export class ImportsModule {}
