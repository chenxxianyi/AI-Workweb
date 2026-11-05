import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { PrismaService } from '../../common/prisma.module.js';
import { ApiException } from '../../common/api-exception.js';
import { runIdempotent } from '../../common/idempotency.js';
import { TransfersService } from './transfers.module.js';
import { types, normalize, type EntityType } from './import-format.js';
import { normalizeTag } from '../entries/entry.service.js';
import type { PlanItem } from './imports.module.js';
import type { Prisma } from '../../generated/prisma/client.js';
export const commitSchema = z.strictObject({
  planHash: z.string().regex(/^[a-f0-9]{64}$/),
  confirm: z.literal(true),
  decisions: z
    .array(
      z.strictObject({
        entityType: z.enum(types),
        sourceId: z.string().max(200),
        action: z.enum(['apply_import', 'keep_server', 'skip']),
      }),
    )
    .max(250000)
    .default([]),
});
type CommitInput = z.infer<typeof commitSchema>;
type Row = Record<string, unknown> & { id: string; version: number; deletedAt: Date | null };
type Delegate = {
  findFirst(args: unknown): Promise<Row | null>;
  create(args: unknown): Promise<Row>;
  updateMany(args: unknown): Promise<{ count: number }>;
};
const dbTable = {
  project: 'projects',
  task: 'tasks',
  entry: 'entries',
  log: 'development_logs',
  ledger: 'ledger_records',
};
function model(tx: Prisma.TransactionClient, type: EntityType): Delegate {
  return {
    project: tx.project,
    task: tx.task,
    entry: tx.entry,
    log: tx.developmentLog,
    ledger: tx.ledgerRecord,
  }[type] as unknown as Delegate;
}
const json = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const instant = (v: unknown) => (v ? new Date(String(v)) : null);
const day = (v: unknown) => (v ? new Date(String(v) + 'T00:00:00Z') : null);
async function mergeEntryHistory(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  actorId: string,
  entryId: string,
  usage: unknown,
  revisions: unknown,
  before: Row | null,
  nextBody: unknown,
) {
  if (usage) {
    const u = usage as { useCount: number; lastUsedAt: string };
    await tx.$executeRaw`INSERT INTO entry_usage(workspace_id,entry_id,use_count,last_used_at) VALUES(${workspaceId}::uuid,${entryId}::uuid,${u.useCount},${new Date(u.lastUsedAt)}) ON CONFLICT(entry_id) DO UPDATE SET use_count=GREATEST(entry_usage.use_count,EXCLUDED.use_count),last_used_at=GREATEST(entry_usage.last_used_at,EXCLUDED.last_used_at)`;
  }
  const existing = await tx.entryRevision.findMany({
    where: { workspaceId: workspaceId, entryId: entryId },
  });
  const merged = [
    ...existing.map((r) => ({
      body: r.body,
      savedAt: r.savedAt,
      sourceVersion: r.sourceVersion,
    })),
    ...(revisions as { body: string; savedAt: string; sourceVersion: number }[]).map((r) => ({
      ...r,
      savedAt: new Date(r.savedAt),
    })),
    ...(before && before['body'] !== nextBody
      ? [
          {
            body: String(before['body']),
            savedAt: new Date(),
            sourceVersion: before.version,
          },
        ]
      : []),
  ];
  const unique = new Map(
    merged.map((r) => [
      createHash('sha256').update(r.body).digest('hex') + ':' + r.savedAt.toISOString(),
      r,
    ]),
  );
  const latest = [...unique.values()]
    .sort((a, b) => b.savedAt.getTime() - a.savedAt.getTime() || a.body.localeCompare(b.body))
    .slice(0, 5);
  await tx.entryRevision.deleteMany({
    where: { workspaceId: workspaceId, entryId: entryId },
  });
  if (latest.length)
    await tx.entryRevision.createMany({
      data: latest.map((r) => ({
        ...r,
        workspaceId: workspaceId,
        entryId: entryId,
        savedBy: actorId,
      })),
    });
}
@Injectable()
export class ImportCommitService {
  constructor(
    @Inject(PrismaService) readonly prisma: PrismaService,
    @Inject(TransfersService) readonly transfers: TransfersService,
  ) {}
  async prepare(workspaceId: string, userId: string, id: string, input: CommitInput, key: string) {
    const job = await this.transfers.get(workspaceId, userId, 'owner', id);
    if (job.type !== 'import') throw new ApiException('TRANSFER_STATE_INVALID', '不是导入作业');
    let backupId = (job.baseVersions as { backupId?: string } | null)?.backupId;
    if (job.state === 'preview_ready') {
      if (!job.expiresAt || job.expiresAt < new Date() || job.planHash !== input.planHash)
        throw new ApiException('PLAN_STALE', '预览过期或计划不匹配，请重新预览');
      const backup = await this.transfers.create(
        workspaceId,
        userId,
        'owner',
        { format: 'json', schemaVersion: 2, includeTrash: true },
        'import-before:' + id,
      );
      backupId = backup.id;
      await this.transfers.tick(backupId);
      const saved = await this.prisma.db.transferJob.findUniqueOrThrow({ where: { id: backupId } });
      if (saved.state !== 'succeeded')
        throw new ApiException('SERVICE_UNAVAILABLE', '导入前备份尚未完成，请重试');
    }
    const result = await runIdempotent(
      this.prisma.db,
      { workspaceId, userId, scope: 'import.commit', key, body: { id, ...input } },
      async (tx) => {
        const found = await tx.transferJob.findFirst({
          where: { id, workspaceId, type: 'import' },
        });
        if (!found || found.state !== 'preview_ready')
          throw new ApiException('TRANSFER_STATE_INVALID', '当前状态不能确认导入');
        if (!found.expiresAt || found.expiresAt < new Date() || found.planHash !== input.planHash)
          throw new ApiException('PLAN_STALE', '计划已失效');
        const updated = await tx.transferJob.updateMany({
          where: { id, state: 'preview_ready', planHash: input.planHash },
          data: {
            state: 'queued',
            baseVersions: json({
              backupId,
              decisions: input.decisions,
              planHash: input.planHash,
              workspaceVersion: (found.baseVersions as { workspaceVersion?: number } | null)
                ?.workspaceVersion,
            }),
            errorCode: null,
            attempts: 0,
          },
        });
        if (updated.count !== 1) throw new ApiException('CONFLICT', '作业已被其他请求处理');
        return { id, state: 'queued', backupId };
      },
    );
    return { ...result.data, replayed: result.replayed };
  }
  async apply(id: string) {
    const job = await this.prisma.db.transferJob.findUniqueOrThrow({ where: { id } });
    if (
      job.type !== 'import' ||
      !(
        job.state === 'queued' ||
        (job.state === 'running' && job.leaseUntil && job.leaseUntil < new Date())
      )
    )
      return;
    if (job.attempts >= 3) {
      await this.prisma.db.transferJob.updateMany({
        where: { id, state: job.state, leaseUntil: job.leaseUntil },
        data: { state: 'failed', errorCode: 'INTERNAL_ERROR', leaseUntil: null },
      });
      return;
    }
    const lease = new Date(Date.now() + 60000);
    const claimed = await this.prisma.db.transferJob.updateMany({
      where: { id, state: job.state, leaseUntil: job.leaseUntil },
      data: { state: 'running', leaseUntil: lease, attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) return;
    try {
      await this.prisma.db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM transfer_jobs WHERE id=${id}::uuid FOR UPDATE`;
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${job.workspaceId},0))`;
          const currentJob = await tx.transferJob.findUniqueOrThrow({ where: { id } });
          if (
            currentJob.state !== 'running' ||
            currentJob.leaseUntil?.getTime() !== lease.getTime()
          )
            throw new ApiException('CONFLICT', '作业已被取消或租约失效');
          const owners = await tx.$queryRaw<
            { id: string }[]
          >`SELECT user_id AS id FROM workspace_members WHERE workspace_id=${job.workspaceId}::uuid AND user_id=${job.actorId}::uuid AND role='owner' AND status='active' FOR SHARE`;
          const spaces = await tx.$queryRaw<
            { id: string }[]
          >`SELECT id FROM workspaces WHERE id=${job.workspaceId}::uuid AND status='active' FOR SHARE`;
          if (!owners.length || !spaces.length)
            throw new ApiException('FORBIDDEN', '导入者已无Owner权限或空间停用');
          if (!job.expiresAt || job.expiresAt < new Date())
            throw new ApiException('PLAN_STALE', '计划已过期，请重新预览');
          const options = job.baseVersions as {
            backupId: string;
            decisions: CommitInput['decisions'];
            planHash: string;
            workspaceVersion?: number;
          };
          const latestClear = await tx.auditEvent.findFirst({
              where: { workspaceId: job.workspaceId, action: 'workspace.cleared' },
              orderBy: { at: 'desc' },
            }),
            workspaceEpoch = await tx.workspace.findUniqueOrThrow({
              where: { id: job.workspaceId },
            });
          if (
            (latestClear && latestClear.at > job.createdAt) ||
            (options.workspaceVersion !== undefined &&
              options.workspaceVersion !== workspaceEpoch.version)
          )
            throw new ApiException('PLAN_STALE', '空间已清空或设置已变化，请重新预览');
          if (options.planHash !== job.planHash)
            throw new ApiException('PLAN_STALE', '计划摘要不匹配');
          const decisions = new Map<string, string>();
          for (const d of options.decisions) {
            const key = d.entityType + ':' + d.sourceId;
            if (decisions.has(key)) throw new ApiException('VALIDATION_FAILED', '重复冲突决策');
            decisions.set(key, d.action);
          }
          const mapped = await tx.importEntityMapping.findMany({
            where: { workspaceId: job.workspaceId, sourceNamespace: job.sourceNamespace! },
          });
          const ids = new Map(mapped.map((m) => [m.entityType + ':' + m.legacyId, m.entityId]));
          const plans = await tx.importItem.findMany({
            where: { jobId: id, entityType: { in: [...types] } },
            orderBy: [{ entityType: 'asc' }, { sourceId: 'asc' }],
          });
          const previous = new Map<string, Row | null>();
          // Lock and validate all touched versions before applying any business write.
          for (const item of plans) {
            const type = item.entityType as EntityType,
              plan = item.validationResult as unknown as PlanItem;
            await tx.$queryRawUnsafe(
              'SELECT id FROM ' +
                dbTable[type] +
                ' WHERE workspace_id=$1::uuid AND id=$2::uuid FOR UPDATE',
              job.workspaceId,
              plan.targetId,
            );
            const row = await model(tx, type).findFirst({
              where: { workspaceId: job.workspaceId, id: plan.targetId },
            });
            previous.set(item.id, row);
            if (plan.baseVersion === null ? row !== null : row?.version !== plan.baseVersion)
              throw new ApiException('PLAN_STALE', '预览后数据已变化，请重新预览');
            const key = type + ':' + item.sourceId,
              choice = decisions.get(key);
            if (choice === 'apply_import' && row?.deletedAt)
              throw new ApiException('PLAN_STALE', '不能通过导入复活回收站对象');
            const action =
              choice === 'keep_server' || choice === 'skip'
                ? 'keep'
                : choice === 'apply_import'
                  ? 'apply'
                  : plan.action === 'create' || plan.action === 'update'
                    ? 'apply'
                    : 'keep';
            if (action === 'apply' || (row && !row.deletedAt)) ids.set(key, plan.targetId);
          }
          for (const key of decisions.keys())
            if (!plans.some((p) => p.entityType + ':' + p.sourceId === key))
              throw new ApiException('VALIDATION_FAILED', '决策引用不存在的计划项');
          const resolveRef = async (type: EntityType, sourceId: unknown) => {
            if (!sourceId) return null;
            const target = ids.get(type + ':' + String(sourceId));
            if (!target) return null;
            const row = await model(tx, type).findFirst({
              where: { id: target, workspaceId: job.workspaceId, deletedAt: null },
            });
            return row ? target : null;
          };
          const applied: Record<string, number> = { created: 0, updated: 0, kept: 0, links: 0 };
          const touched = new Set<string>();
          for (const type of ['project', 'task', 'entry', 'log', 'ledger'] as EntityType[]) {
            for (const item of plans.filter((p) => p.entityType === type)) {
              const plan = item.validationResult as unknown as PlanItem,
                choice = decisions.get(type + ':' + item.sourceId),
                before = previous.get(item.id) ?? null;
              const skip =
                choice === 'keep_server' ||
                choice === 'skip' ||
                (choice !== 'apply_import' &&
                  (plan.action === 'keep' || plan.action === 'conflict'));
              if (skip) {
                if (type === 'entry' && before && !before.deletedAt && choice !== 'skip') {
                  const support = item.normalizedPayload as unknown as {
                    usage: unknown;
                    revisions: unknown;
                  };
                  const oldUsage = await tx.entryUsage.findFirst({
                      where: { workspaceId: job.workspaceId, entryId: plan.targetId },
                    }),
                    oldRevisions = await tx.entryRevision.findMany({
                      where: { workspaceId: job.workspaceId, entryId: plan.targetId },
                    });
                  await mergeEntryHistory(
                    tx,
                    job.workspaceId,
                    job.actorId,
                    plan.targetId,
                    support.usage,
                    support.revisions,
                    null,
                    before['body'],
                  );
                  await tx.importItem.update({
                    where: { id: item.id },
                    data: {
                      beforeImage: json({
                        statsOnly: true,
                        usage: oldUsage,
                        revisions: oldRevisions,
                      }),
                      appliedVersion: before.version,
                    },
                  });
                }
                applied['kept']!++;
                continue;
              }
              const payload = normalize(
                type,
                item.normalizedPayload,
                2,
                new Map(),
              ) as unknown as Record<string, unknown>;
              const {
                id: _sourceId,
                createdAt,
                updatedAt,
                originMetadata,
                deletedAt,
                usage,
                revisions,
                tags,
                entryIds: _entryIds,
                ...fields
              } = payload;
              const data: Record<string, unknown> = {
                ...fields,
                deletedAt: deletedAt ? new Date() : null,
                originMetadata: {
                  ...((originMetadata as object) ?? {}),
                  sourceNamespace: job.sourceNamespace,
                  sourceId: item.sourceId,
                  sourceCreatedAt: createdAt,
                  sourceUpdatedAt: updatedAt,
                },
              };
              if ('projectId' in data)
                data['projectId'] = await resolveRef('project', data['projectId']);
              if ('entryId' in data) data['entryId'] = await resolveRef('entry', data['entryId']);
              if (type === 'task') {
                data['dueDate'] = day(data['dueDate']);
                data['doneAt'] = instant(data['doneAt']);
              }
              if (type === 'project') {
                data['archivedAt'] = instant(data['archivedAt']);
                data['lastActivityAt'] = new Date();
              }
              if (type === 'log') data['logDate'] = day(data['logDate']);
              if (type === 'ledger') data['recordDate'] = day(data['recordDate']);
              let beforeImage: unknown = before;
              if (before && type === 'entry')
                beforeImage = {
                  ...before,
                  tags: await tx.entryTag.findMany({
                    where: { workspaceId: job.workspaceId, entryId: before.id },
                    include: { tag: true },
                  }),
                  usage: await tx.entryUsage.findFirst({
                    where: { workspaceId: job.workspaceId, entryId: before.id },
                  }),
                  revisions: await tx.entryRevision.findMany({
                    where: { workspaceId: job.workspaceId, entryId: before.id },
                  }),
                };
              if (before) {
                const updated = await model(tx, type).updateMany({
                  where: {
                    id: plan.targetId,
                    workspaceId: job.workspaceId,
                    version: plan.baseVersion,
                    deletedAt: null,
                  },
                  data: { ...data, version: { increment: 1 } },
                });
                if (updated.count !== 1) throw new ApiException('PLAN_STALE', '目标版本已变化');
                applied['updated']!++;
              } else {
                await model(tx, type).create({
                  data: {
                    ...data,
                    id: plan.targetId,
                    workspaceId: job.workspaceId,
                    ...(type === 'log' ? { authorId: job.actorId } : { createdBy: job.actorId }),
                  },
                });
                applied['created']!++;
              }
              const version = (plan.baseVersion ?? 0) + 1;
              if (type === 'entry') {
                await tx.entryTag.deleteMany({
                  where: { workspaceId: job.workspaceId, entryId: plan.targetId },
                });
                for (const name of tags as string[]) {
                  const normalized = normalizeTag(name);
                  const tag = await tx.tag.upsert({
                    where: {
                      workspaceId_nameNormalized: {
                        workspaceId: job.workspaceId,
                        nameNormalized: normalized,
                      },
                    },
                    create: {
                      workspaceId: job.workspaceId,
                      nameNormalized: normalized,
                      displayName: name,
                    },
                    update: {},
                  });
                  await tx.entryTag.create({
                    data: { workspaceId: job.workspaceId, entryId: plan.targetId, tagId: tag.id },
                  });
                }
                await mergeEntryHistory(
                  tx,
                  job.workspaceId,
                  job.actorId,
                  plan.targetId,
                  usage,
                  revisions,
                  before,
                  data['body'],
                );
              }
              const key = {
                workspaceId: job.workspaceId,
                sourceNamespace: job.sourceNamespace!,
                entityType: type,
                legacyId: item.sourceId,
              };
              const oldMapping = mapped.find(
                (m) => m.entityType === type && m.legacyId === item.sourceId,
              );
              await tx.importEntityMapping.upsert({
                where: { workspaceId_sourceNamespace_entityType_legacyId: key },
                create: {
                  ...key,
                  entityId: plan.targetId,
                  sourceUpdatedAt: new Date(String(updatedAt)),
                  lastImportedVersion: version,
                },
                update: {
                  entityId: plan.targetId,
                  sourceUpdatedAt: new Date(String(updatedAt)),
                  lastImportedVersion: version,
                },
              });
              await tx.importItem.update({
                where: { id: item.id },
                data: {
                  beforeImage: json({ entity: beforeImage, mapping: oldMapping ?? null }),
                  appliedVersion: version,
                },
              });
              if (data['projectId']) touched.add(String(data['projectId']));
              if (before?.['projectId']) touched.add(String(before['projectId']));
            }
          }
          const links = await tx.importItem.findMany({
            where: { jobId: id, entityType: 'task_entry' },
          });
          for (const link of links) {
            const p = link.normalizedPayload as { taskId: string; entryId: string },
              taskId = await resolveRef('task', p.taskId),
              entryId = await resolveRef('entry', p.entryId);
            if (!taskId || !entryId) continue;
            const keepRelation = (type: EntityType, sourceId: string) => {
              const decision = decisions.get(type + ':' + sourceId),
                p = plans.find((p) => p.entityType === type && p.sourceId === sourceId)
                  ?.validationResult as unknown as PlanItem | undefined;
              return (
                decision === 'skip' ||
                decision === 'keep_server' ||
                (p?.action === 'conflict' && decision !== 'apply_import')
              );
            };
            if (keepRelation('task', p.taskId) || keepRelation('entry', p.entryId)) continue;
            const created = await tx.taskEntry.createMany({
              data: [{ workspaceId: job.workspaceId, taskId, entryId }],
              skipDuplicates: true,
            });
            applied['links']! += created.count;
            await tx.importItem.update({
              where: { id: link.id },
              data: { beforeImage: json({ taskId, entryId, existed: created.count === 0 }) },
            });
          }
          if (touched.size)
            await tx.project.updateMany({
              where: { workspaceId: job.workspaceId, id: { in: [...touched] }, deletedAt: null },
              data: { lastActivityAt: new Date() },
            });
          await tx.auditEvent.create({
            data: {
              workspaceId: job.workspaceId,
              actorId: job.actorId,
              action: 'import.succeeded',
              entityType: 'transfer',
              entityId: id,
              result: 'success',
              summary:
                '导入完成，新增' +
                applied['created'] +
                '，更新' +
                applied['updated'] +
                '，保留' +
                applied['kept'],
            },
          });
          await tx.transferJob.update({
            where: { id },
            data: {
              state: 'succeeded',
              counts: json({ ...(job.counts as object), applied, backupId: options.backupId }),
              leaseUntil: null,
              errorCode: null,
            },
          });
        },
        { timeout: 900000, maxWait: 10000 },
      );
    } catch (error) {
      const code = error instanceof ApiException ? error.code : 'INTERNAL_ERROR';
      const retry = !(error instanceof ApiException) && job.attempts + 1 < 3;
      await this.prisma.db.transferJob.updateMany({
        where: { id, state: 'running', leaseUntil: lease },
        data: { state: retry ? 'queued' : 'failed', leaseUntil: null, errorCode: code },
      });
    }
  }
  async cancel(workspaceId: string, userId: string, id: string) {
    const job = await this.transfers.get(workspaceId, userId, 'owner', id);
    if (job.type !== 'import') throw new ApiException('TRANSFER_STATE_INVALID', '不是导入');
    const r = await this.prisma.db.transferJob.updateMany({
      where: { id, state: { in: ['uploaded', 'validating', 'preview_ready', 'queued'] } },
      data: { state: 'cancelled', leaseUntil: null },
    });
    if (r.count !== 1)
      throw new ApiException(
        'TRANSFER_STATE_INVALID',
        '已提交或正在提交，不能取消；请查看恢复报告',
      );
    return { id, state: 'cancelled' };
  }
  async recovery(workspaceId: string, userId: string, id: string) {
    const job = await this.transfers.get(workspaceId, userId, 'owner', id);
    const items = await this.prisma.db.importItem.findMany({
      where: { jobId: id, appliedVersion: { not: null } },
    });
    const results = [];
    for (const item of items) {
      const plan = item.validationResult as unknown as PlanItem;
      const current = await model(this.prisma.db, item.entityType as EntityType).findFirst({
        where: { id: plan.targetId, workspaceId },
      });
      results.push({
        type: item.entityType,
        id: plan.targetId,
        appliedVersion: item.appliedVersion,
        currentVersion: current?.version ?? null,
        safeToRestore: item.entityType !== 'entry' && current?.version === item.appliedVersion,
        beforeImage: item.beforeImage,
      });
    }
    return {
      id,
      state: job.state,
      backupId: (job.baseVersions as { backupId?: string } | null)?.backupId ?? null,
      items: results,
      relations: (
        await this.prisma.db.importItem.findMany({ where: { jobId: id, entityType: 'task_entry' } })
      )
        .map((i) => i.beforeImage)
        .filter(Boolean),
      notice:
        'safeToRestore仅为业务版本检查；知识含独立使用计数，需人工核对且不能降低计数。恢复需重算活动与派生统计。业务导出不替代数据库备份，取消不等于撤销。',
    };
  }
}
