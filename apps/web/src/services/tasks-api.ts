import { apiClient } from './api-client';
import { ensureCsrfToken } from './auth-api';

/** 任务接口（F14 后端 / F16 前端） */

export type TaskPriority = 'p0' | 'p1' | 'p2';
export type TaskStatus = 'todo' | 'doing' | 'done';

export interface Task {
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

export interface TaskList {
  tasks: Task[];
  nextCursor: string | null;
  hasMore: boolean;
}

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
  type: string;
  status: string;
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
  urgent: { overdue: UrgentTask[]; stalled: UrgentTask[]; staleDrafts: StaleDraft[] };
  urgentCount: number;
}

export interface CreateTaskInput {
  title: string;
  priority?: TaskPriority;
  dueDate?: string | null;
  projectId?: string | null;
}

export interface UpdateTaskInput {
  title?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: string | null;
  shiftDays?: number;
  projectId?: string | null;
}

export const PRIORITY_LABEL: Record<TaskPriority, string> = { p0: 'P0', p1: 'P1', p2: 'P2' };

/** 幂等键：同一次提交的重试必须复用同一个键（F16-03） */
export function newIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID !== undefined) return cryptoApi.randomUUID();
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export const tasksApi = {
  list: (
    workspaceId: string,
    options: { status?: TaskStatus; projectId?: string; dueDate?: string; limit?: number; cursor?: string; signal?: AbortSignal } = {},
  ) => {
    const params = new URLSearchParams();
    if (options.status !== undefined) params.set('status', options.status);
    if (options.projectId !== undefined) params.set('projectId', options.projectId);
    if (options.dueDate !== undefined) params.set('dueDate', options.dueDate);
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.cursor !== undefined) params.set('cursor', options.cursor);
    const query = params.toString() === '' ? '' : `?${params.toString()}`;
    return apiClient.get<TaskList>(`/workspaces/${workspaceId}/tasks${query}`, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  },

  dashboard: (workspaceId: string, options: { signal?: AbortSignal } = {}) =>
    apiClient.get<TodayDashboard>(`/workspaces/${workspaceId}/dashboard/today`, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }),

  get: (workspaceId: string, taskId: string) => apiClient.get<Task>(`/workspaces/${workspaceId}/tasks/${taskId}`),

  async create(workspaceId: string, input: CreateTaskInput, idempotencyKey: string): Promise<Task> {
    await ensureCsrfToken();
    const result = await apiClient.post<{ task: Task; replayed: boolean }>(
      `/workspaces/${workspaceId}/tasks`,
      input,
      { idempotencyKey },
    );
    return result.task;
  },

  async update(workspaceId: string, task: Pick<Task, 'id' | 'version'>, input: UpdateTaskInput): Promise<Task> {
    await ensureCsrfToken();
    return apiClient.patch<Task>(`/workspaces/${workspaceId}/tasks/${task.id}`, input, {
      ifMatch: task.version,
    });
  },

  async remove(workspaceId: string, task: Pick<Task, 'id' | 'version'>): Promise<void> {
    await ensureCsrfToken();
    await apiClient.del<{ status: string }>(`/workspaces/${workspaceId}/tasks/${task.id}`, {
      ifMatch: task.version,
    });
  },

  async postponeYesterday(
    workspaceId: string,
    dryRun: boolean,
  ): Promise<{ dryRun: boolean; count: number; taskIds: string[]; fromDate: string; toDate: string }> {
    await ensureCsrfToken();
    return apiClient.post('/workspaces/' + workspaceId + '/tasks/postpone-yesterday', { dryRun });
  },
};
