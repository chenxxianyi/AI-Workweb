import { Inject, Injectable } from '@nestjs/common';
import { parseEtag } from '@aiwb/contracts';
import { businessDate, diffDays, projectProgress } from '@aiwb/domain';
import { ApiException } from '../../common/api-exception.js';
import { runIdempotent } from '../../common/idempotency.js';
import { PrismaService } from '../../common/prisma.module.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { ProjectStage } from '../../generated/prisma/enums.js';

/**
 * 项目（F12）。
 *
 * 进度规则（需求矩阵 R03/R04）：
 * - 手动模式：直接取 manual_progress，0 是合法值，不能被自动值覆盖；
 * - 自动模式：完成数 / 有效任务数，四舍五入；没有任务时为 0；
 * - 无活动 ≥ 7 天按空间时区的业务日计算，不自动改动项目内容。
 *
 * 所有写入都带 workspaceId 边界；读取不存在／已删除／已归档的项目按 404 处理，
 * 跨空间 id 与不存在 id 不可区分，避免探测。
 */

const MAX_STACK_ITEMS = 10;
const MAX_STACK_ITEM_LENGTH = 32;
const REPO_PATTERN = /^(https?:\/\/[^\s]+|[\w.-]+\/[\w.-]+)$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export interface ProjectInput {
  name: string;
  repo?: string | null;
  stack?: string[];
  stage?: ProjectStage;
  nextStep?: string;
  progressManual?: boolean;
  manualProgress?: number | null;
  color?: string | null;
}

export interface ProjectView {
  id: string;
  name: string;
  repo: string | null;
  stack: string[];
  stage: ProjectStage;
  nextStep: string;
  progressMode: 'auto' | 'manual';
  progress: number;
  manualProgress: number | null;
  color: string | null;
  archived: boolean;
  archivedAt: string | null;
  lastActivityAt: string;
  inactiveDays: number;
  inactive: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  taskCounts: { total: number; done: number };
}

export type ProjectFilter = 'active' | 'inactive' | 'archived' | 'all';

export interface ListOptions {
  filter?: ProjectFilter;
  q?: string;
  limit?: number;
  cursor?: string;
}

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

function assertRepo(repo: string | null | undefined): void {
  if (repo === undefined || repo === null) return;
  if (repo.length > 300 || !REPO_PATTERN.test(repo)) {
    throw new ApiException('VALIDATION_FAILED', '仓库地址需为 http(s) 链接或 owner/name 形式', {
      fieldErrors: { repo: ['需为 http(s) 链接或 owner/name 形式'] },
    });
  }
}

function assertColor(color: string | null | undefined): void {
  if (color === undefined || color === null) return;
  if (!COLOR_PATTERN.test(color)) {
    throw new ApiException('VALIDATION_FAILED', '颜色需为 #RRGGBB 形式', {
      fieldErrors: { color: ['需为 #RRGGBB 形式'] },
    });
  }
}

function assertStack(stack: string[] | undefined): void {
  if (stack === undefined) return;
  if (stack.length > MAX_STACK_ITEMS) {
    throw new ApiException('VALIDATION_FAILED', `技术栈最多 ${MAX_STACK_ITEMS} 项`, {
      fieldErrors: { stack: [`最多 ${MAX_STACK_ITEMS} 项`] },
    });
  }
  for (const item of stack) {
    if (item.trim().length === 0 || item.length > MAX_STACK_ITEM_LENGTH) {
      throw new ApiException('VALIDATION_FAILED', `技术栈每项 1～${MAX_STACK_ITEM_LENGTH} 个字符`, {
        fieldErrors: { stack: [`每项 1～${MAX_STACK_ITEM_LENGTH} 个字符`] },
      });
    }
  }
}

function assertNextStep(nextStep: string | undefined): void {
  if (nextStep === undefined) return;
  if (nextStep.includes('\n') || nextStep.length > 200) {
    throw new ApiException('VALIDATION_FAILED', '下一步需为单行文本且不超过 200 个字符', {
      fieldErrors: { nextStep: ['需为单行文本且不超过 200 个字符'] },
    });
  }
}

function assertProgressMode(
  progressManual: boolean | undefined,
  manualProgress: number | null | undefined,
): void {
  if (progressManual === true) {
    if (manualProgress === undefined || manualProgress === null) {
      throw new ApiException('VALIDATION_FAILED', '手动进度模式需要提供 0～100 的进度值', {
        fieldErrors: { manualProgress: ['手动模式必填'] },
      });
    }
    if (!Number.isInteger(manualProgress) || manualProgress < 0 || manualProgress > 100) {
      throw new ApiException('VALIDATION_FAILED', '手动进度需为 0～100 的整数', {
        fieldErrors: { manualProgress: ['需为 0～100 的整数'] },
      });
    }
  }
  if (progressManual === false && manualProgress !== undefined && manualProgress !== null) {
    throw new ApiException('VALIDATION_FAILED', '自动进度模式下不能提供 manualProgress', {
      fieldErrors: { manualProgress: ['自动模式应为空'] },
    });
  }
}

/** 编码游标：只为稳定分页，客户端不解析 */
function encodeCursor(lastActivityAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ u: lastActivityAt.toISOString(), i: id }), 'utf8').toString(
    'base64url',
  );
}

function decodeCursor(cursor: string | undefined): { u: Date; i: string } | null {
  if (cursor === undefined || cursor === '') return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      u?: string;
      i?: string;
    };
    if (typeof parsed.u !== 'string' || typeof parsed.i !== 'string') return null;
    return { u: new Date(parsed.u), i: parsed.i };
  } catch {
    throw new ApiException('MALFORMED_REQUEST', '分页游标无效');
  }
}

@Injectable()
export class ProjectService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private get db(): PrismaClient {
    return this.prisma.db;
  }

  /** 供任务／知识／台账模块在内容变化时调用，更新项目活动时间 */
  async touchActivity(
    client: PrismaClient,
    workspaceId: string,
    projectId: string | null,
  ): Promise<void> {
    if (projectId === null) return;
    await client.project.updateMany({
      where: { id: projectId, workspaceId, deletedAt: null },
      data: { lastActivityAt: new Date() },
    });
  }

  private async taskCounts(
    workspaceId: string,
    projectIds: string[],
  ): Promise<Map<string, { total: number; done: number }>> {
    const counts = new Map<string, { total: number; done: number }>();
    if (projectIds.length === 0) return counts;
    const grouped = await this.db.task.groupBy({
      by: ['projectId', 'status'],
      where: { workspaceId, deletedAt: null, projectId: { in: projectIds } },
      _count: { _all: true },
    });
    for (const row of grouped) {
      if (row.projectId === null) continue;
      const entry = counts.get(row.projectId) ?? { total: 0, done: 0 };
      entry.total += row._count._all;
      if (row.status === 'done') entry.done += row._count._all;
      counts.set(row.projectId, entry);
    }
    return counts;
  }

  private toView(
    project: {
      id: string;
      name: string;
      repo: string | null;
      stack: string[];
      stage: ProjectStage;
      nextStep: string;
      progressManual: boolean;
      manualProgress: number | null;
      color: string | null;
      archivedAt: Date | null;
      lastActivityAt: Date;
      version: number;
      createdAt: Date;
      updatedAt: Date;
    },
    counts: { total: number; done: number },
    timezone: string,
  ): ProjectView {
    const progress = projectProgress(
      project.progressManual,
      project.manualProgress,
      counts.total,
      counts.done,
    );
    const today = businessDate(new Date(), timezone);
    const inactiveDays = Math.max(
      0,
      diffDays(businessDate(project.lastActivityAt, timezone), today),
    );

    return {
      id: project.id,
      name: project.name,
      repo: project.repo,
      stack: project.stack,
      stage: project.stage,
      nextStep: project.nextStep,
      progressMode: project.progressManual ? 'manual' : 'auto',
      progress,
      manualProgress: project.manualProgress,
      color: project.color,
      archived: project.archivedAt !== null,
      archivedAt: project.archivedAt?.toISOString() ?? null,
      lastActivityAt: project.lastActivityAt.toISOString(),
      inactiveDays,
      inactive: inactiveDays >= 7,
      version: project.version,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
      taskCounts: counts,
    };
  }

  private async timezoneOf(workspaceId: string): Promise<string> {
    const workspace = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { timezone: true },
    });
    return workspace?.timezone ?? 'Asia/Shanghai';
  }

  async list(
    workspaceId: string,
    options: ListOptions = {},
  ): Promise<{ projects: ProjectView[]; nextCursor: string | null; hasMore: boolean }> {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const filter = options.filter ?? 'active';
    const cursor = decodeCursor(options.cursor);

    const where = {
      workspaceId,
      deletedAt: null,
      ...(filter === 'archived'
        ? { archivedAt: { not: null } }
        : filter === 'all'
          ? {}
          : { archivedAt: null }),
      ...(options.q !== undefined && options.q.trim() !== ''
        ? { name: { contains: options.q.trim(), mode: 'insensitive' as const } }
        : {}),
      ...(cursor === null
        ? {}
        : {
            OR: [
              { lastActivityAt: { lt: cursor.u } },
              { lastActivityAt: cursor.u, id: { lt: cursor.i } },
            ],
          }),
    };

    const rows = await this.db.project.findMany({
      where,
      orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const page = rows.slice(0, limit);
    const counts = await this.taskCounts(
      workspaceId,
      page.map((row) => row.id),
    );
    const timezone = await this.timezoneOf(workspaceId);
    let projects = page.map((row) =>
      this.toView(row, counts.get(row.id) ?? { total: 0, done: 0 }, timezone),
    );

    if (filter === 'inactive') projects = projects.filter((project) => project.inactive);

    const last = page.at(-1);
    return {
      projects,
      hasMore: rows.length > limit,
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeCursor(last.lastActivityAt, last.id)
          : null,
    };
  }

  async create(
    workspaceId: string,
    actorUserId: string,
    input: ProjectInput,
    key: string,
  ): Promise<ProjectView> {
    const name = input.name.trim();
    if (name.length === 0 || name.length > 100) {
      throw new ApiException('VALIDATION_FAILED', '项目名称需为 1～100 个字符', {
        fieldErrors: { name: ['需为 1～100 个字符'] },
      });
    }
    assertRepo(input.repo);
    assertColor(input.color);
    assertStack(input.stack);
    assertNextStep(input.nextStep);
    assertProgressMode(input.progressManual, input.manualProgress);

    const timezone = await this.timezoneOf(workspaceId);
    const result = await runIdempotent(
      this.db,
      { userId: actorUserId, workspaceId, scope: 'project.create', key, body: input },
      async (client) => {
        const project = await client.project.create({
          data: {
            workspaceId,
            createdBy: actorUserId,
            name,
            repo: input.repo ?? null,
            stack: input.stack ?? [],
            stage: input.stage ?? 'planning',
            nextStep: input.nextStep ?? '',
            progressManual: input.progressManual ?? false,
            manualProgress: input.progressManual === true ? (input.manualProgress ?? 0) : null,
            color: input.color ?? null,
          },
        });
        await client.auditEvent.create({
          data: {
            workspaceId,
            actorId: actorUserId,
            action: 'project.created',
            entityType: 'project',
            entityId: project.id,
            result: 'success',
            summary: `创建项目：${project.name}`,
          },
        });
        return this.toView(project, { total: 0, done: 0 }, timezone);
      },
    );

    return result.data;
  }

  async get(workspaceId: string, projectId: string): Promise<ProjectView> {
    const project = await this.db.project.findFirst({
      where: { id: projectId, workspaceId, deletedAt: null },
    });
    if (project === null) throw new ApiException('NOT_FOUND', '项目不存在');
    const counts = await this.taskCounts(workspaceId, [project.id]);
    return this.toView(
      project,
      counts.get(project.id) ?? { total: 0, done: 0 },
      await this.timezoneOf(workspaceId),
    );
  }

  async update(
    workspaceId: string,
    actorUserId: string,
    projectId: string,
    ifMatch: string | string[] | undefined,
    input: Partial<ProjectInput>,
  ): Promise<ProjectView> {
    const expected = requireIfMatch(ifMatch);
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (name.length === 0 || name.length > 100) {
        throw new ApiException('VALIDATION_FAILED', '项目名称需为 1～100 个字符', {
          fieldErrors: { name: ['需为 1～100 个字符'] },
        });
      }
    }
    assertRepo(input.repo);
    assertColor(input.color);
    assertStack(input.stack);
    assertNextStep(input.nextStep);
    assertProgressMode(input.progressManual, input.manualProgress);

    const updated = await this.db.$transaction(async (tx) => {
      const client = tx as unknown as PrismaClient;
      const current = await client.project.findFirst({
        where: { id: projectId, workspaceId, deletedAt: null },
        select: { version: true, progressManual: true, manualProgress: true },
      });
      if (current === null) throw new ApiException('NOT_FOUND', '项目不存在');
      if (current.version !== expected) {
        throw new ApiException('PRECONDITION_FAILED', '该项目已被其他设备修改', {
          currentVersion: current.version,
        });
      }

      // 手动模式切换：从自动切到手动时必须给出进度；从手动切到自动时清空 manual_progress
      const nextManual = input.progressManual ?? current.progressManual;
      const nextManualProgress =
        nextManual === true ? (input.manualProgress ?? current.manualProgress ?? 0) : null;

      const result = await client.project.updateMany({
        where: { id: projectId, workspaceId, version: expected, deletedAt: null },
        data: {
          ...(input.name === undefined ? {} : { name: input.name.trim() }),
          ...(input.repo === undefined ? {} : { repo: input.repo }),
          ...(input.stack === undefined ? {} : { stack: input.stack }),
          ...(input.stage === undefined ? {} : { stage: input.stage }),
          ...(input.nextStep === undefined ? {} : { nextStep: input.nextStep }),
          ...(input.color === undefined ? {} : { color: input.color }),
          progressManual: nextManual,
          manualProgress: nextManualProgress,
          lastActivityAt: new Date(),
          version: { increment: 1 },
        },
      });
      if (result.count === 0) {
        throw new ApiException('PRECONDITION_FAILED', '该项目已被其他设备修改');
      }
      const project = await client.project.findUniqueOrThrow({ where: { id: projectId } });
      await client.auditEvent.create({
        data: {
          workspaceId,
          actorId: actorUserId,
          action: 'project.updated',
          entityType: 'project',
          entityId: projectId,
          result: 'success',
          summary: `更新项目：${project.name}`,
        },
      });
      return project;
    });

    const counts = await this.taskCounts(workspaceId, [updated.id]);
    return this.toView(
      updated,
      counts.get(updated.id) ?? { total: 0, done: 0 },
      await this.timezoneOf(workspaceId),
    );
  }

  async setArchived(
    workspaceId: string,
    actorUserId: string,
    projectId: string,
    ifMatch: string | string[] | undefined,
    archived: boolean,
  ): Promise<ProjectView> {
    const expected = requireIfMatch(ifMatch);
    return this.db
      .$transaction(async (tx) => {
        const client = tx as unknown as PrismaClient;
        const current = await client.project.findFirst({
          where: { id: projectId, workspaceId, deletedAt: null },
          select: { version: true },
        });
        if (current === null) throw new ApiException('NOT_FOUND', '项目不存在');
        if (current.version !== expected) {
          throw new ApiException('PRECONDITION_FAILED', '该项目已被其他设备修改', {
            currentVersion: current.version,
          });
        }
        const result = await client.project.updateMany({
          where: { id: projectId, workspaceId, version: expected, deletedAt: null },
          data: {
            archivedAt: archived ? new Date() : null,
            version: { increment: 1 },
            ...(archived ? {} : { lastActivityAt: new Date() }),
          },
        });
        if (result.count === 0)
          throw new ApiException('PRECONDITION_FAILED', '该项目已被其他设备修改');
        const project = await client.project.findUniqueOrThrow({ where: { id: projectId } });
        await client.auditEvent.create({
          data: {
            workspaceId,
            actorId: actorUserId,
            action: archived ? 'project.archived' : 'project.unarchived',
            entityType: 'project',
            entityId: projectId,
            result: 'success',
            summary: `${archived ? '归档' : '取消归档'}项目：${project.name}`,
          },
        });
        return project;
      })
      .then(async (project) => {
        const counts = await this.taskCounts(workspaceId, [project.id]);
        return this.toView(
          project,
          counts.get(project.id) ?? { total: 0, done: 0 },
          await this.timezoneOf(workspaceId),
        );
      });
  }

  /** 软删除（进入回收站，F34 处理恢复）；项目下的任务/知识不删除，界面上标注原项目已删除 */
  async remove(
    workspaceId: string,
    actorUserId: string,
    projectId: string,
    ifMatch: string | string[] | undefined,
  ): Promise<void> {
    const expected = requireIfMatch(ifMatch);
    await this.db.$transaction(async (tx) => {
      const client = tx as unknown as PrismaClient;
      const current = await client.project.findFirst({
        where: { id: projectId, workspaceId, deletedAt: null },
        select: { version: true, name: true },
      });
      if (current === null) throw new ApiException('NOT_FOUND', '项目不存在');
      if (current.version !== expected) {
        throw new ApiException('PRECONDITION_FAILED', '该项目已被其他设备修改', {
          currentVersion: current.version,
        });
      }
      const result = await client.project.updateMany({
        where: { id: projectId, workspaceId, version: expected, deletedAt: null },
        data: { deletedAt: new Date(), version: { increment: 1 } },
      });
      if (result.count === 0)
        throw new ApiException('PRECONDITION_FAILED', '该项目已被其他设备修改');
      await client.auditEvent.create({
        data: {
          workspaceId,
          actorId: actorUserId,
          action: 'project.deleted',
          entityType: 'project',
          entityId: projectId,
          result: 'success',
          summary: `删除项目（回收站）：${current.name}`,
        },
      });
    });
  }

  /** 详情聚合：项目 + 任务计数与最近任务 + 最近知识 + 台账摘要 */
  async overview(workspaceId: string, projectId: string): Promise<Record<string, unknown>> {
    const project = await this.get(workspaceId, projectId);
    const [recentTasks, recentEntries, ledgerAgg, recentLedger] = await Promise.all([
      this.db.task.findMany({
        where: { workspaceId, projectId, deletedAt: null },
        orderBy: [{ status: 'asc' }, { dueDate: 'asc' }, { createdAt: 'desc' }],
        take: 5,
        select: {
          id: true,
          title: true,
          status: true,
          priority: true,
          dueDate: true,
          version: true,
        },
      }),
      this.db.entry.findMany({
        where: { workspaceId, projectId, deletedAt: null },
        orderBy: { updatedAt: 'desc' },
        take: 5,
        select: { id: true, title: true, type: true, status: true, updatedAt: true },
      }),
      this.db.ledgerRecord.aggregate({
        where: { workspaceId, projectId, deletedAt: null },
        _count: { _all: true },
        _sum: { minutes: true, savedMinutes: true },
        _avg: { effect: true },
      }),
      this.db.ledgerRecord.findMany({
        where: { workspaceId, projectId, deletedAt: null },
        orderBy: { recordDate: 'desc' },
        take: 5,
        select: {
          id: true,
          recordDate: true,
          tool: true,
          scene: true,
          minutes: true,
          effect: true,
        },
      }),
    ]);

    return {
      project,
      tasks: {
        counts: project.taskCounts,
        recent: recentTasks.map((task) => ({
          ...task,
          dueDate: task.dueDate?.toISOString().slice(0, 10) ?? null,
        })),
      },
      entries: {
        recent: recentEntries.map((entry) => ({
          ...entry,
          updatedAt: entry.updatedAt.toISOString(),
        })),
      },
      ledger: {
        count: ledgerAgg._count._all,
        totalMinutes: ledgerAgg._sum.minutes ?? 0,
        totalSavedMinutes: ledgerAgg._sum.savedMinutes ?? 0,
        averageEffect:
          ledgerAgg._avg.effect === null ? null : Math.round(ledgerAgg._avg.effect * 10) / 10,
        recent: recentLedger.map((record) => ({
          ...record,
          recordDate: record.recordDate.toISOString().slice(0, 10),
        })),
      },
    };
  }
}
