import { Inject, Injectable } from '@nestjs/common';
import { parseEtag } from '@aiwb/contracts';
import { addDays, businessDate } from '@aiwb/domain';
import { ApiException } from '../../common/api-exception.js';
import { PrismaService } from '../../common/prisma.module.js';
import { runIdempotent } from '../../common/idempotency.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { TaskPriority, TaskStatus } from '../../generated/prisma/enums.js';
import { ProjectService } from '../projects/project.service.js';

/**
 * 任务（F14）。
 *
 * 关键规则：
 * - 完成：status=done 时 `doneAt` 由服务器写入；撤销完成（→todo/doing）时清空；
 *   数据库 CHECK 保证 `(status='done') = (done_at IS NOT NULL)` 永远成立；
 * - 改期：dueDate 用 DATE；跨月/跨年/闰年由 `@aiwb/domain` 的 addDays 计算；
 * - 幂等：创建必须带 Idempotency-Key，重复请求只产生一次变化；
 * - 顺延：只处理“业务日昨天”且未完成的任务，dryRun 先给范围，确认后单事务提交；
 * - 活动：任务内容变化会更新所属项目的 last_activity_at（F12 的 touchActivity）。
 */
export interface TaskInput {
  title: string;
  projectId?: string | null;
  priority?: TaskPriority;
  status?: TaskStatus;
  dueDate?: string | null;
  aiContext?: string | null;
  blocker?: string | null;
}

export interface TaskUpdate {
  title?: string;
  projectId?: string | null;
  priority?: TaskPriority;
  status?: TaskStatus;
  dueDate?: string | null;
  shiftDays?: number;
  aiContext?: string | null;
  blocker?: string | null;
}

export interface TaskView {
  entries?: { id: string; title: string }[];
  id: string;
  workspaceId: string;
  projectId: string | null;
  title: string;
  priority: TaskPriority;
  status: TaskStatus;
  dueDate: string | null;
  doneAt: string | null;
  aiContext: string | null;
  blocker: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

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

function assertDueDate(value: string | null | undefined): void {
  if (value === undefined || value === null) return;
  if (!DATE_PATTERN.test(value)) {
    throw new ApiException('VALIDATION_FAILED', '截止日需为 YYYY-MM-DD', {
      fieldErrors: { dueDate: ['需为 YYYY-MM-DD'] },
    });
  }
  // 用 UTC 往返校验真实存在的日期（拒绝 2026-02-30）
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new ApiException('VALIDATION_FAILED', '截止日不是有效日期', {
      fieldErrors: { dueDate: ['不是有效日期'] },
    });
  }
}

function toView(task: {
  id: string;
  workspaceId: string;
  projectId: string | null;
  title: string;
  priority: TaskPriority;
  status: TaskStatus;
  dueDate: Date | null;
  doneAt: Date | null;
  aiContext: string | null;
  blocker: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}): TaskView {
  return {
    id: task.id,
    workspaceId: task.workspaceId,
    projectId: task.projectId,
    title: task.title,
    priority: task.priority,
    status: task.status,
    dueDate: task.dueDate === null ? null : task.dueDate.toISOString().slice(0, 10),
    doneAt: task.doneAt === null ? null : task.doneAt.toISOString(),
    aiContext: task.aiContext,
    blocker: task.blocker,
    version: task.version,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

@Injectable()
export class TaskService {
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

  private async assertProjectInWorkspace(workspaceId: string, projectId: string): Promise<void> {
    const project = await this.db.project.findFirst({
      where: { id: projectId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (project === null) {
      throw new ApiException('VALIDATION_FAILED', '项目不存在或不属于当前空间', {
        fieldErrors: { projectId: ['不存在或不属于当前空间'] },
      });
    }
  }

  async list(
    workspaceId: string,
    filters: { status?: TaskStatus; projectId?: string; dueDate?: string; limit?: number; cursor?: string } = {},
  ): Promise<{ tasks: TaskView[]; nextCursor: string | null; hasMore: boolean }> {
    const limit = Math.min(Math.max(filters.limit ?? 20, 1), 100);
    const cursor = this.decodeCursor(filters.cursor);

    const rows = await this.db.task.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        ...(filters.status === undefined ? {} : { status: filters.status }),
        ...(filters.projectId === undefined ? {} : { projectId: filters.projectId }),
        ...(filters.dueDate === undefined ? {} : { dueDate: new Date(`${filters.dueDate}T00:00:00.000Z`) }),
        ...(cursor === null
          ? {}
          : {
              OR: [
                { updatedAt: { lt: cursor.u } },
                { updatedAt: cursor.u, id: { lt: cursor.i } },
              ],
            }),
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      tasks: page.map(toView),
      hasMore: rows.length > limit,
      nextCursor:
        rows.length > limit && last !== undefined
          ? Buffer.from(JSON.stringify({ u: last.updatedAt.toISOString(), i: last.id }), 'utf8').toString(
              'base64url',
            )
          : null,
    };
  }

  private decodeCursor(cursor: string | undefined): { u: Date; i: string } | null {
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

  async get(workspaceId: string, taskId: string): Promise<TaskView> {
    const task = await this.db.task.findFirst({ where: { id: taskId, workspaceId, deletedAt: null } });
    if (task === null) throw new ApiException('NOT_FOUND', '任务不存在');
    const linked = await this.db.taskEntry.findMany({ where: { workspaceId, taskId, entry: { workspaceId, deletedAt: null } }, select: { entry: { select: { id: true, title: true } } } });
    return { ...toView(task), entries: linked.map((link) => link.entry) };
  }

  async promote(workspaceId: string, userId: string, taskId: string, ifMatch: string | undefined, key: string, newEntry: boolean) {
    const expected = requireIfMatch(ifMatch);
    const result = await runIdempotent(this.db, { workspaceId, userId, scope: 'task.promote:' + taskId, key, body: { taskId, expected, newEntry } }, async (tx) => {
      const task = await tx.task.findFirst({ where: { id: taskId, workspaceId, deletedAt: null } });
      if (task === null) throw new ApiException('NOT_FOUND', '任务不存在');
      if (task.version !== expected) throw new ApiException('PRECONDITION_FAILED', '任务已更新，请刷新', { currentVersion: task.version });
      if (!newEntry) {
        const existing = await tx.taskEntry.findFirst({ where: { workspaceId, taskId, entry: { workspaceId, deletedAt: null } }, orderBy: { createdAt: 'desc' } });
        if (existing) return { entryId: existing.entryId, taskVersion: task.version, created: false };
      }
      const locked = await tx.task.updateMany({ where: { id: taskId, workspaceId, version: expected, deletedAt: null }, data: { version: { increment: 1 } } });
      if (locked.count !== 1) throw new ApiException('PRECONDITION_FAILED', '任务已更新，请刷新');
      const project = task.projectId === null ? null : await tx.project.findFirst({ where: { id: task.projectId, workspaceId, deletedAt: null } });
      const body = '**任务**：' + task.title + '\n\n**卡点**：' + (task.blocker ?? '') + '\n\n**解决方案**：\n';
      if (Buffer.byteLength(body, 'utf8') > 20480) throw new ApiException('PAYLOAD_TOO_LARGE', '沉淀正文超过20KB');
      const entry = await tx.entry.create({ data: { workspaceId, createdBy: userId, projectId: project?.id ?? null, type: 'troubleshoot', status: 'draft', title: [...(task.blocker || task.title)].slice(0, 200).join(''), body, source: 'task', rating: 3 } });
      await tx.taskEntry.create({ data: { workspaceId, taskId, entryId: entry.id } });
      await tx.auditEvent.create({ data: { workspaceId, actorId: userId, action: 'task.promoted', entityType: 'task', entityId: taskId, result: 'success', summary: '任务沉淀为知识：' + entry.id } });
      await this.projects.touchActivity(tx, workspaceId, project?.id ?? null);
      return { entryId: entry.id, taskVersion: expected + 1, created: true };
    });
    return { ...result.data, replayed: result.replayed };
  }

  /** 创建：必须由调用方提供幂等键；重复请求只产生一次变化 */
  async create(
    workspaceId: string,
    actorUserId: string,
    input: TaskInput,
    idempotencyKey: string,
  ): Promise<{ task: TaskView; replayed: boolean }> {
    this.assertCreateInput(input);
    if (input.projectId !== undefined && input.projectId !== null) {
      await this.assertProjectInWorkspace(workspaceId, input.projectId);
    }

    const result = await runIdempotent(
      this.db,
      { userId: actorUserId, workspaceId, scope: 'task.create', key: idempotencyKey, body: input },
      async (tx) => {
        const created = await tx.task.create({
          data: {
            workspaceId,
            createdBy: actorUserId,
            title: input.title.trim(),
            projectId: input.projectId ?? null,
            priority: input.priority ?? 'p2',
            status: input.status ?? 'todo',
            dueDate: input.dueDate === undefined || input.dueDate === null ? null : new Date(`${input.dueDate}T00:00:00.000Z`),
            aiContext: input.aiContext ?? null,
            blocker: input.blocker ?? null,
            doneAt: input.status === 'done' ? new Date() : null,
          },
        });
        await tx.auditEvent.create({
          data: {
            workspaceId,
            actorId: actorUserId,
            action: 'task.created',
            entityType: 'task',
            entityId: created.id,
            result: 'success',
            summary: `创建任务：${created.title}`,
          },
        });
        await this.projects.touchActivity(tx, workspaceId, created.projectId);
        return toView(created);
      },
    );

    return { task: result.data, replayed: result.replayed };
  }

  private assertCreateInput(input: TaskInput): void {
    const title = input.title.trim();
    if (title.length === 0 || title.length > 200) {
      throw new ApiException('VALIDATION_FAILED', '任务标题需为 1～200 个字符', {
        fieldErrors: { title: ['需为 1～200 个字符'] },
      });
    }
    assertDueDate(input.dueDate);
    if (input.aiContext !== undefined && input.aiContext !== null && input.aiContext.length > 4000) {
      throw new ApiException('VALIDATION_FAILED', 'aiContext 最多 4000 个字符', {
        fieldErrors: { aiContext: ['最多 4000 个字符'] },
      });
    }
    if (input.blocker !== undefined && input.blocker !== null && input.blocker.length > 4000) {
      throw new ApiException('VALIDATION_FAILED', 'blocker 最多 4000 个字符', {
        fieldErrors: { blocker: ['最多 4000 个字符'] },
      });
    }
  }

  async update(
    workspaceId: string,
    actorUserId: string,
    taskId: string,
    ifMatch: string | string[] | undefined,
    input: TaskUpdate,
  ): Promise<TaskView> {
    const expected = requireIfMatch(ifMatch);
    if (input.title !== undefined) {
      const title = input.title.trim();
      if (title.length === 0 || title.length > 200) {
        throw new ApiException('VALIDATION_FAILED', '任务标题需为 1～200 个字符', {
          fieldErrors: { title: ['需为 1～200 个字符'] },
        });
      }
    }
    assertDueDate(input.dueDate);
    if (input.shiftDays !== undefined && (!Number.isInteger(input.shiftDays) || Math.abs(input.shiftDays) > 3650)) {
      throw new ApiException('VALIDATION_FAILED', 'shiftDays 需为 -3650～3650 的整数', {
        fieldErrors: { shiftDays: ['需为整数'] },
      });
    }
    if (input.projectId !== undefined && input.projectId !== null) {
      await this.assertProjectInWorkspace(workspaceId, input.projectId);
    }

    return this.db.$transaction(async (tx) => {
      const client = tx as unknown as PrismaClient;
      const current = await client.task.findFirst({
        where: { id: taskId, workspaceId, deletedAt: null },
      });
      if (current === null) throw new ApiException('NOT_FOUND', '任务不存在');
      if (current.version !== expected) {
        throw new ApiException('PRECONDITION_FAILED', '该任务已被其他设备修改', {
          currentVersion: current.version,
        });
      }

      // 改期：优先 shiftDays（按业务日加减），否则用 dueDate 直接设置
      let nextDueDate: Date | null | undefined;
      if (input.shiftDays !== undefined) {
        const timezone = await this.timezoneOf(workspaceId);
        const baseDate =
          current.dueDate === null
            ? businessDate(new Date(), timezone)
            : current.dueDate.toISOString().slice(0, 10);
        nextDueDate = new Date(`${addDays(baseDate, input.shiftDays)}T00:00:00.000Z`);
      } else if (input.dueDate !== undefined) {
        nextDueDate = input.dueDate === null ? null : new Date(`${input.dueDate}T00:00:00.000Z`);
      }

      const nextStatus = input.status ?? current.status;
      // doneAt 与 status 保持一致；已是 done 且未改状态时保留原完成时间
      const nextDoneAt =
        nextStatus === 'done' ? (current.status === 'done' && current.doneAt !== null ? current.doneAt : new Date()) : null;

      const updated = await client.task.updateMany({
        where: { id: taskId, workspaceId, version: expected, deletedAt: null },
        data: {
          ...(input.title === undefined ? {} : { title: input.title.trim() }),
          ...(input.priority === undefined ? {} : { priority: input.priority }),
          ...(input.aiContext === undefined ? {} : { aiContext: input.aiContext }),
          ...(input.blocker === undefined ? {} : { blocker: input.blocker }),
          ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
          ...(nextDueDate === undefined ? {} : { dueDate: nextDueDate }),
          status: nextStatus,
          doneAt: nextDoneAt,
          version: { increment: 1 },
        },
      });
      if (updated.count === 0) throw new ApiException('PRECONDITION_FAILED', '该任务已被其他设备修改');

      const task = await client.task.findUniqueOrThrow({ where: { id: taskId } });
      await client.auditEvent.create({
        data: {
          workspaceId,
          actorId: actorUserId,
          action: 'task.updated',
          entityType: 'task',
          entityId: taskId,
          result: 'success',
          summary: `更新任务：${task.title}（${task.status}）`,
        },
      });
      await this.projects.touchActivity(client, workspaceId, task.projectId);
      return toView(task);
    });
  }

  async remove(
    workspaceId: string,
    actorUserId: string,
    taskId: string,
    ifMatch: string | string[] | undefined,
  ): Promise<void> {
    const expected = requireIfMatch(ifMatch);
    await this.db.$transaction(async (tx) => {
      const client = tx as unknown as PrismaClient;
      const current = await client.task.findFirst({ where: { id: taskId, workspaceId, deletedAt: null } });
      if (current === null) throw new ApiException('NOT_FOUND', '任务不存在');
      if (current.version !== expected) {
        throw new ApiException('PRECONDITION_FAILED', '该任务已被其他设备修改', {
          currentVersion: current.version,
        });
      }
      await client.task.update({
        where: { id: taskId },
        data: { deletedAt: new Date(), version: { increment: 1 } },
      });
      await client.auditEvent.create({
        data: {
          workspaceId,
          actorId: actorUserId,
          action: 'task.deleted',
          entityType: 'task',
          entityId: taskId,
          result: 'success',
          summary: `删除任务（回收站）：${current.title}`,
        },
      });
    });
  }

  /**
   * 昨日顺延：只把“业务日昨天”且未完成的任务改到今天。
   * - dryRun 只统计与返回 id，不写库
   * - 确认时单事务提交；任何一步失败整体回滚
   */
  async postponeYesterday(
    workspaceId: string,
    actorUserId: string,
    dryRun: boolean,
  ): Promise<{ dryRun: boolean; count: number; taskIds: string[]; fromDate: string; toDate: string }> {
    const timezone = await this.timezoneOf(workspaceId);
    const today = businessDate(new Date(), timezone);
    const yesterday = addDays(today, -1);
    const from = new Date(`${yesterday}T00:00:00.000Z`);
    const to = new Date(`${today}T00:00:00.000Z`);

    const targets = await this.db.task.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        status: { not: 'done' },
        dueDate: from,
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });

    const taskIds = targets.map((task) => task.id);
    if (dryRun || taskIds.length === 0) {
      return { dryRun, count: taskIds.length, taskIds, fromDate: yesterday, toDate: today };
    }

    await this.db.$transaction(async (tx) => {
      const client = tx as unknown as PrismaClient;
      const updated = await client.task.updateMany({
        where: {
          workspaceId,
          deletedAt: null,
          status: { not: 'done' },
          dueDate: from,
          id: { in: taskIds },
        },
        data: { dueDate: to, version: { increment: 1 } },
      });
      if (updated.count !== taskIds.length) {
        // 并发修改导致数量不一致：整体回滚，避免部分更新
        throw new ApiException('CONFLICT', '顺延过程中任务被修改，请刷新后重试');
      }
      await client.auditEvent.create({
        data: {
          workspaceId,
          actorId: actorUserId,
          action: 'task.postponed',
          entityType: 'task',
          result: 'success',
          summary: `顺延 ${updated.count} 个昨日任务：${yesterday} → ${today}`,
        },
      });
    });

    return { dryRun: false, count: taskIds.length, taskIds, fromDate: yesterday, toDate: today };
  }
}
