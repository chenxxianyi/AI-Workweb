import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { parseEtag } from '@aiwb/contracts';
import { businessDate } from '@aiwb/domain';
import { ApiException } from '../../common/api-exception.js';
import { PrismaService } from '../../common/prisma.module.js';
import { runIdempotent } from '../../common/idempotency.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { ProjectService } from '../projects/project.service.js';

/**
 * 开发日志（F17）。
 *
 * - 作者永远是登录用户，请求体里出现 `authorId` 会被 strict schema 拒绝（不可伪造）；
 * - 创建需要 Idempotency-Key：同一操作重试只保存一条，不同操作（不同键）即便内容相同也各自保留；
 * - 游标携带筛选指纹：换了筛选条件再复用旧游标会 422，避免“跨筛选翻页”返回错乱结果；
 * - 所有查询都以 workspaceId 限定，跨空间不可见；
 * - 记录变化会更新所属项目活动时间。
 */

export interface LedgerInput {
  recordDate: string;
  projectId?: string | null;
  tool: string;
  scene: string;
  minutes: number;
  savedMinutes?: number | null;
  effect: number;
  note?: string | null;
  entryId?: string | null;
}

export interface LedgerFilters {
  projectId?: string;
  from?: string;
  to?: string;
  tool?: string;
  scene?: string;
  limit?: number;
  cursor?: string;
}

export interface LedgerView {
  id: string;
  recordDate: string;
  projectId: string | null;
  tool: string;
  scene: string;
  minutes: number;
  savedMinutes: number;
  effect: number;
  note: string | null;
  entryId: string | null;
  authorId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TOOL_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_MINUTES = 1440;

function requireIfMatch(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === '') {
    throw new ApiException('PRECONDITION_REQUIRED', '缺少 If-Match，请携带当前版本号');
  }
  const version = parseEtag(raw);
  if (version === null) {
    throw new ApiException('PRECONDITION_REQUIRED', 'If-Match 格式不正确，请携带当前版本号');
  }
  return version;
}

function parseDate(value: string, field: string): Date {
  if (!DATE_PATTERN.test(value)) {
    throw new ApiException('VALIDATION_FAILED', `${field} 需为 YYYY-MM-DD`, {
      fieldErrors: { [field]: ['需为 YYYY-MM-DD'] },
    });
  }
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new ApiException('VALIDATION_FAILED', `${field} 不是有效日期`, {
      fieldErrors: { [field]: ['不是有效日期'] },
    });
  }
  return date;
}

function assertTool(value: string, field: 'tool' | 'scene'): void {
  if (!TOOL_PATTERN.test(value)) {
    throw new ApiException('VALIDATION_FAILED', `${field} 需为小写标识（字母开头，≤32 位）`, {
      fieldErrors: { [field]: ['格式不正确'] },
    });
  }
}

function toView(record: {
  id: string;
  recordDate: Date;
  projectId: string | null;
  tool: string;
  scene: string;
  minutes: number;
  savedMinutes: number;
  effect: number;
  note: string | null;
  entryId: string | null;
  createdBy: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}): LedgerView {
  return {
    id: record.id,
    recordDate: record.recordDate.toISOString().slice(0, 10),
    projectId: record.projectId,
    tool: record.tool,
    scene: record.scene,
    minutes: record.minutes,
    savedMinutes: record.savedMinutes,
    effect: record.effect,
    note: record.note,
    entryId: record.entryId,
    authorId: record.createdBy,
    version: record.version,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

@Injectable()
export class LedgerService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ProjectService) private readonly projects: ProjectService,
  ) {}

  private get db(): PrismaClient {
    return this.prisma.db;
  }

  private async timezoneOf(workspaceId: string): Promise<string> {
    const workspace = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { timezone: true },
    });
    return workspace?.timezone ?? 'Asia/Shanghai';
  }

  private fingerprint(filters: LedgerFilters): string {
    const normalized = {
      projectId: filters.projectId ?? null,
      from: filters.from ?? null,
      to: filters.to ?? null,
      tool: filters.tool ?? null,
      scene: filters.scene ?? null,
    };
    return createHash('sha256').update(JSON.stringify(normalized), 'utf8').digest('hex').slice(0, 16);
  }

  private encodeCursor(recordDate: Date, createdAt: Date, id: string, fingerprint: string): string {
    return Buffer.from(
      JSON.stringify({ d: recordDate.toISOString().slice(0, 10), c: createdAt.toISOString(), i: id, f: fingerprint }),
      'utf8',
    ).toString('base64url');
  }

  private decodeCursor(cursor: string | undefined, fingerprint: string): { recordDate: Date; createdAt: Date; id: string } | null {
    if (cursor === undefined || cursor === '') return null;
    let parsed: { d?: string; c?: string; i?: string; f?: string };
    try {
      parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as typeof parsed;
    } catch {
      throw new ApiException('MALFORMED_REQUEST', '分页游标无效');
    }
    if (typeof parsed.d !== 'string' || typeof parsed.c !== 'string' || typeof parsed.i !== 'string' || typeof parsed.f !== 'string') {
      throw new ApiException('MALFORMED_REQUEST', '分页游标无效');
    }
    if (parsed.f !== fingerprint) {
      throw new ApiException('MALFORMED_REQUEST', '游标与当前筛选条件不匹配，请从第一页重新开始');
    }
    return { recordDate: new Date(`${parsed.d}T00:00:00.000Z`), createdAt: new Date(parsed.c), id: parsed.i };
  }

  async list(workspaceId: string, filters: LedgerFilters = {}): Promise<{
    records: LedgerView[];
    nextCursor: string | null;
    hasMore: boolean;
  }> {
    const limit = Math.min(Math.max(filters.limit ?? 20, 1), 100);
    const fingerprint = this.fingerprint(filters);
    const cursor = this.decodeCursor(filters.cursor, fingerprint);

    const from = filters.from === undefined ? undefined : parseDate(filters.from, 'from');
    const to = filters.to === undefined ? undefined : parseDate(filters.to, 'to');
    if (from !== undefined && to !== undefined && from > to) {
      throw new ApiException('VALIDATION_FAILED', 'from 不能晚于 to', {
        fieldErrors: { from: ['不能晚于 to'] },
      });
    }

    const rows = await this.db.ledgerRecord.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        ...(filters.projectId === undefined ? {} : { projectId: filters.projectId }),
        ...(filters.tool === undefined ? {} : { tool: filters.tool }),
        ...(filters.scene === undefined ? {} : { scene: filters.scene }),
        ...(from === undefined && to === undefined
          ? {}
          : {
              recordDate: {
                ...(from === undefined ? {} : { gte: from }),
                ...(to === undefined ? {} : { lte: to }),
              },
            }),
        ...(cursor === null
          ? {}
          : {
              OR: [
                { recordDate: { lt: cursor.recordDate } },
                { recordDate: cursor.recordDate, createdAt: { lt: cursor.createdAt } },
                { recordDate: cursor.recordDate, createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }),
      },
      orderBy: [{ recordDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      records: page.map(toView),
      hasMore: rows.length > limit,
      nextCursor:
        rows.length > limit && last !== undefined
          ? this.encodeCursor(last.recordDate, last.createdAt, last.id, fingerprint)
          : null,
    };
  }

  async get(workspaceId: string, recordId: string): Promise<LedgerView> {
    const record = await this.db.ledgerRecord.findFirst({
      where: { id: recordId, workspaceId, deletedAt: null },
    });
    if (record === null) throw new ApiException('NOT_FOUND', '日志记录不存在');
    return toView(record);
  }

  private async assertRefs(workspaceId: string, input: { projectId?: string | null; entryId?: string | null }): Promise<void> {
    if (input.projectId !== undefined && input.projectId !== null) {
      const project = await this.db.project.findFirst({
        where: { id: input.projectId, workspaceId, deletedAt: null },
        select: { id: true },
      });
      if (project === null) {
        throw new ApiException('VALIDATION_FAILED', '项目不存在或不属于当前空间', {
          fieldErrors: { projectId: ['不存在或不属于当前空间'] },
        });
      }
    }
    if (input.entryId !== undefined && input.entryId !== null) {
      const entry = await this.db.entry.findFirst({
        where: { id: input.entryId, workspaceId, deletedAt: null },
        select: { id: true },
      });
      if (entry === null) {
        throw new ApiException('VALIDATION_FAILED', '知识条目不存在或不属于当前空间', {
          fieldErrors: { entryId: ['不存在或不属于当前空间'] },
        });
      }
    }
  }

  private async assertInput(workspaceId: string, input: LedgerInput): Promise<void> {
    const timezone = await this.timezoneOf(workspaceId);
    const recordDate = parseDate(input.recordDate, 'recordDate');
    const today = new Date(`${businessDate(new Date(), timezone)}T00:00:00.000Z`);
    if (recordDate > today) {
      throw new ApiException('VALIDATION_FAILED', '记录日期不能晚于今天', {
        fieldErrors: { recordDate: ['不能晚于今天'] },
      });
    }
    assertTool(input.tool, 'tool');
    assertTool(input.scene, 'scene');
    if (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > MAX_MINUTES) {
      throw new ApiException('VALIDATION_FAILED', `投入分钟需为 1～${MAX_MINUTES} 的整数`, {
        fieldErrors: { minutes: [`需为 1～${MAX_MINUTES} 的整数`] },
      });
    }
    if (input.savedMinutes !== undefined && input.savedMinutes !== null) {
      if (!Number.isInteger(input.savedMinutes) || input.savedMinutes < 0 || input.savedMinutes > MAX_MINUTES) {
        throw new ApiException('VALIDATION_FAILED', `节省分钟需为 0～${MAX_MINUTES} 的整数`, {
          fieldErrors: { savedMinutes: [`需为 0～${MAX_MINUTES} 的整数`] },
        });
      }
    }
    if (!Number.isInteger(input.effect) || input.effect < 1 || input.effect > 5) {
      throw new ApiException('VALIDATION_FAILED', '效果评分需为 1～5 的整数', {
        fieldErrors: { effect: ['需为 1～5 的整数'] },
      });
    }
    if (input.note !== undefined && input.note !== null && input.note.length > 4000) {
      throw new ApiException('VALIDATION_FAILED', '备注最多 4000 个字符', {
        fieldErrors: { note: ['最多 4000 个字符'] },
      });
    }
    await this.assertRefs(workspaceId, { projectId: input.projectId, entryId: input.entryId });
  }

  async create(
    workspaceId: string,
    actorUserId: string,
    input: LedgerInput,
    idempotencyKey: string,
  ): Promise<{ record: LedgerView; replayed: boolean }> {
    await this.assertInput(workspaceId, input);
    const result = await runIdempotent(
      this.db,
      { userId: actorUserId, workspaceId, scope: 'ledger.create', key: idempotencyKey, body: input },
      async (tx) => {
        const created = await tx.ledgerRecord.create({
          data: {
            workspaceId,
            createdBy: actorUserId,
            recordDate: new Date(`${input.recordDate}T00:00:00.000Z`),
            projectId: input.projectId ?? null,
            entryId: input.entryId ?? null,
            tool: input.tool,
            scene: input.scene,
            minutes: input.minutes,
            savedMinutes: input.savedMinutes ?? input.minutes,
            effect: input.effect,
            note: input.note ?? null,
          },
        });
        await tx.auditEvent.create({
          data: {
            workspaceId,
            actorId: actorUserId,
            action: 'ledger.created',
            entityType: 'ledger_record',
            entityId: created.id,
            result: 'success',
            summary: `记录 AI 台账：${created.tool}/${created.scene} ${created.minutes} 分钟`,
          },
        });
        await this.projects.touchActivity(tx, workspaceId, created.projectId);
        return toView(created);
      },
    );
    return { record: result.data, replayed: result.replayed };
  }

  async update(
    workspaceId: string,
    actorUserId: string,
    recordId: string,
    ifMatch: string | string[] | undefined,
    input: Partial<LedgerInput>,
  ): Promise<LedgerView> {
    const expected = requireIfMatch(ifMatch);
    if (input.recordDate !== undefined || input.tool !== undefined || input.scene !== undefined) {
      const current = await this.db.ledgerRecord.findFirst({
        where: { id: recordId, workspaceId, deletedAt: null },
      });
      if (current === null) throw new ApiException('NOT_FOUND', '日志记录不存在');
      await this.assertInput(workspaceId, {
        recordDate: input.recordDate ?? current.recordDate.toISOString().slice(0, 10),
        projectId: input.projectId === undefined ? current.projectId : input.projectId,
        tool: input.tool ?? current.tool,
        scene: input.scene ?? current.scene,
        minutes: input.minutes ?? current.minutes,
        savedMinutes: input.savedMinutes === undefined ? current.savedMinutes : input.savedMinutes,
        effect: input.effect ?? current.effect,
        note: input.note === undefined ? current.note : input.note,
        entryId: input.entryId === undefined ? current.entryId : input.entryId,
      });
    }

    return this.db.$transaction(async (tx) => {
      const client = tx as unknown as PrismaClient;
      const current = await client.ledgerRecord.findFirst({
        where: { id: recordId, workspaceId, deletedAt: null },
      });
      if (current === null) throw new ApiException('NOT_FOUND', '日志记录不存在');
      if (current.version !== expected) {
        throw new ApiException('PRECONDITION_FAILED', '该记录已被其他设备修改', { currentVersion: current.version });
      }
      const updated = await client.ledgerRecord.updateMany({
        where: { id: recordId, workspaceId, version: expected, deletedAt: null },
        data: {
          ...(input.recordDate === undefined ? {} : { recordDate: new Date(`${input.recordDate}T00:00:00.000Z`) }),
          ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
          ...(input.entryId === undefined ? {} : { entryId: input.entryId }),
          ...(input.tool === undefined ? {} : { tool: input.tool }),
          ...(input.scene === undefined ? {} : { scene: input.scene }),
          ...(input.minutes === undefined ? {} : { minutes: input.minutes }),
          ...(input.savedMinutes === undefined ? {} : { savedMinutes: input.savedMinutes ?? input.minutes ?? current.minutes }),
          ...(input.effect === undefined ? {} : { effect: input.effect }),
          ...(input.note === undefined ? {} : { note: input.note }),
          version: { increment: 1 },
        },
      });
      if (updated.count === 0) throw new ApiException('PRECONDITION_FAILED', '该记录已被其他设备修改');

      const record = await client.ledgerRecord.findUniqueOrThrow({ where: { id: recordId } });
      await client.auditEvent.create({
        data: {
          workspaceId,
          actorId: actorUserId,
          action: 'ledger.updated',
          entityType: 'ledger_record',
          entityId: recordId,
          result: 'success',
          summary: `更新 AI 台账：${record.tool}/${record.scene}`,
        },
      });
      await this.projects.touchActivity(client, workspaceId, record.projectId);
      return toView(record);
    });
  }

  async remove(
    workspaceId: string,
    actorUserId: string,
    recordId: string,
    ifMatch: string | string[] | undefined,
  ): Promise<void> {
    const expected = requireIfMatch(ifMatch);
    await this.db.$transaction(async (tx) => {
      const client = tx as unknown as PrismaClient;
      const current = await client.ledgerRecord.findFirst({
        where: { id: recordId, workspaceId, deletedAt: null },
      });
      if (current === null) throw new ApiException('NOT_FOUND', '日志记录不存在');
      if (current.version !== expected) {
        throw new ApiException('PRECONDITION_FAILED', '该记录已被其他设备修改', { currentVersion: current.version });
      }
      await client.ledgerRecord.update({
        where: { id: recordId },
        data: { deletedAt: new Date(), version: { increment: 1 } },
      });
      await client.auditEvent.create({
        data: {
          workspaceId,
          actorId: actorUserId,
          action: 'ledger.deleted',
          entityType: 'ledger_record',
          entityId: recordId,
          result: 'success',
          summary: '删除 AI 台账记录（回收站）',
        },
      });
    });
  }

  /** 汇总：区间内的投入、节省、平均效果与按工具分布 */
  async summary(
    workspaceId: string,
    filters: { from?: string; to?: string; projectId?: string } = {},
  ): Promise<{
    count: number;
    totalMinutes: number;
    totalSavedMinutes: number;
    averageEffect: number | null;
    byTool: { tool: string; minutes: number; count: number }[];
  }> {
    const from = filters.from === undefined ? undefined : parseDate(filters.from, 'from');
    const to = filters.to === undefined ? undefined : parseDate(filters.to, 'to');
    const where = {
      workspaceId,
      deletedAt: null,
      ...(filters.projectId === undefined ? {} : { projectId: filters.projectId }),
      ...(from === undefined && to === undefined
        ? {}
        : { recordDate: { ...(from === undefined ? {} : { gte: from }), ...(to === undefined ? {} : { lte: to }) } }),
    };

    const [aggregate, byToolRows] = await Promise.all([
      this.db.ledgerRecord.aggregate({
        where,
        _count: { _all: true },
        _sum: { minutes: true, savedMinutes: true },
        _avg: { effect: true },
      }),
      this.db.ledgerRecord.groupBy({ by: ['tool'], where, _sum: { minutes: true }, _count: { _all: true } }),
    ]);

    return {
      count: aggregate._count._all,
      totalMinutes: aggregate._sum.minutes ?? 0,
      totalSavedMinutes: aggregate._sum.savedMinutes ?? 0,
      averageEffect: aggregate._avg.effect === null ? null : Math.round(aggregate._avg.effect * 10) / 10,
      byTool: byToolRows
        .map((row) => ({ tool: row.tool, minutes: row._sum.minutes ?? 0, count: row._count._all }))
        .sort((a, b) => b.minutes - a.minutes),
    };
  }
}
