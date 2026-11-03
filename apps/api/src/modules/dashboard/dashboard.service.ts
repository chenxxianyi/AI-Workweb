import { Inject, Injectable } from '@nestjs/common';
import { addDays, businessDate, diffDays } from '@aiwb/domain';
import { PrismaService } from '../../common/prisma.module.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { EntryStatus, EntryType, TaskPriority, TaskStatus } from '../../generated/prisma/enums.js';

/**
 * 今日聚合（F15）。
 *
 * 规则（需求 R06）：
 * - 业务日按**空间时区**计算，客户端时区/设备时间不影响结果；
 * - 逾期：`due_date < 今日` 且未完成（今日到期不算逾期，即“逾期 > 0 天”）；
 * - 停滞：`status='doing'` 且 `updated_at` 早于 3 天前（恰好 3 天不算，即“停滞 > 3 天”）；
 * - 草稿超期：`status='draft'` 且 `created_at` 早于 7 天前（恰好 7 天不算）；
 * - 已完成任务不进紧急区；草稿属于知识条目，不计入任务总数；
 * - 同一任务可能同时逾期与停滞：分桶统计保留，`urgentCount` 按 id 去重，避免重复计数。
 */

const STALL_DAYS = 3;
const STALE_DRAFT_DAYS = 7;
const URGENT_LIMIT = 20;

export interface UrgentTask {
  id: string;
  title: string;
  priority: TaskPriority;
  status: TaskStatus;
  dueDate: string | null;
  overdueDays: number | null;
  stalledDays: number | null;
  projectId: string | null;
  version: number;
}

export interface StaleDraft {
  id: string;
  title: string;
  type: EntryType;
  status: EntryStatus;
  ageDays: number;
  projectId: string | null;
  version: number;
}

export interface TodayDashboard {
  businessDate: string;
  timezone: string;
  counts: {
    todayTasks: number;
    overdueTasks: number;
    stalledTasks: number;
    yesterdayIncomplete: number;
    doneToday: number;
    openTasks: number;
    staleDrafts: number;
  };
  urgent: {
    overdue: UrgentTask[];
    stalled: UrgentTask[];
    staleDrafts: StaleDraft[];
  };
  /** 去重后的紧急项数量（逾期 ∪ 停滞 ∪ 草稿超期） */
  urgentCount: number;
}

@Injectable()
export class DashboardService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private get db(): PrismaClient {
    return this.prisma.db;
  }

  async today(workspaceId: string): Promise<TodayDashboard> {
    const workspace = await this.db.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { timezone: true },
    });
    const timezone = workspace.timezone;
    const now = new Date();
    const today = businessDate(now, timezone);
    const yesterday = addDays(today, -1);

    const todayDate = new Date(`${today}T00:00:00.000Z`);
    const yesterdayDate = new Date(`${yesterday}T00:00:00.000Z`);
    const stallCutoff = new Date(now.getTime() - STALL_DAYS * 86_400_000);
    const draftCutoff = new Date(now.getTime() - STALE_DRAFT_DAYS * 86_400_000);

    const [overdueTasks, stalledTasks, staleDraftEntries, counts] = await Promise.all([
      this.db.task.findMany({
        where: { workspaceId, deletedAt: null, status: { not: 'done' }, dueDate: { not: null, lt: todayDate } },
        orderBy: [{ dueDate: 'asc' }, { priority: 'asc' }],
        take: URGENT_LIMIT,
      }),
      this.db.task.findMany({
        where: { workspaceId, deletedAt: null, status: 'doing', updatedAt: { lt: stallCutoff } },
        orderBy: { updatedAt: 'asc' },
        take: URGENT_LIMIT,
      }),
      this.db.entry.findMany({
        where: { workspaceId, deletedAt: null, status: 'draft', createdAt: { lt: draftCutoff } },
        orderBy: { createdAt: 'asc' },
        take: URGENT_LIMIT,
        select: { id: true, title: true, type: true, status: true, createdAt: true, projectId: true, version: true },
      }),
      Promise.all([
        this.db.task.count({ where: { workspaceId, deletedAt: null, status: { not: 'done' }, dueDate: todayDate } }),
        this.db.task.count({ where: { workspaceId, deletedAt: null, status: { not: 'done' }, dueDate: yesterdayDate } }),
        this.db.task.count({ where: { workspaceId, deletedAt: null, status: 'done', doneAt: { gte: todayDate } } }),
        this.db.task.count({ where: { workspaceId, deletedAt: null, status: { not: 'done' } } }),
      ]),
    ]);

    const [todayTasks, yesterdayIncomplete, doneToday, openTasks] = counts;

    const toUrgentTask = (task: (typeof overdueTasks)[number]): UrgentTask => {
      const due = task.dueDate === null ? null : task.dueDate.toISOString().slice(0, 10);
      const overdueDays = due === null ? null : Math.max(0, diffDays(due, today));
      const stalledDays = Math.max(0, diffDays(businessDate(task.updatedAt, timezone), today));
      return {
        id: task.id,
        title: task.title,
        priority: task.priority,
        status: task.status,
        dueDate: due,
        overdueDays: overdueDays !== null && overdueDays > 0 ? overdueDays : null,
        stalledDays: task.status === 'doing' && stalledDays > STALL_DAYS ? stalledDays : null,
        projectId: task.projectId,
        version: task.version,
      };
    };

    const overdue = overdueTasks.map(toUrgentTask);
    const stalled = stalledTasks.map(toUrgentTask);
    const staleDrafts: StaleDraft[] = staleDraftEntries.map((entry) => ({
      id: entry.id,
      title: entry.title,
      type: entry.type,
      status: entry.status,
      ageDays: Math.max(0, diffDays(businessDate(entry.createdAt, timezone), today)),
      projectId: entry.projectId,
      version: entry.version,
    }));

    const urgentIds = new Set<string>([
      ...overdue.map((task) => task.id),
      ...stalled.map((task) => task.id),
      ...staleDrafts.map((entry) => entry.id),
    ]);

    return {
      businessDate: today,
      timezone,
      counts: {
        todayTasks,
        overdueTasks: overdue.length,
        stalledTasks: stalled.length,
        yesterdayIncomplete,
        doneToday,
        openTasks,
        staleDrafts: staleDrafts.length,
      },
      urgent: { overdue, stalled, staleDrafts },
      urgentCount: urgentIds.size,
    };
  }
}
