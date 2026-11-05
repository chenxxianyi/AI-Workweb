import { apiClient } from './api-client';
import { ensureCsrfToken } from './auth-api';

/** 项目接口（F12 后端 / F13 前端） */

export type ProjectStage = 'planning' | 'developing' | 'paused' | 'done';
export type ProjectFilter = 'active' | 'inactive' | 'archived' | 'all';
export type ProgressMode = 'auto' | 'manual';

export interface Project {
  id: string;
  name: string;
  repo: string | null;
  stack: string[];
  stage: ProjectStage;
  nextStep: string;
  progressMode: ProgressMode;
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

export interface ProjectList {
  projects: Project[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ProjectOverview {
  project: Project;
  tasks: {
    counts: { total: number; done: number };
    recent: {
      id: string;
      title: string;
      status: string;
      priority: string;
      dueDate: string | null;
    }[];
  };
  entries: {
    recent: { id: string; title: string; type: string; status: string; updatedAt: string }[];
  };
  ledger: {
    count: number;
    totalMinutes: number;
    totalSavedMinutes: number;
    averageEffect: number | null;
    recent: {
      id: string;
      recordDate: string;
      tool: string;
      scene: string;
      minutes: number;
      effect: number;
    }[];
  };
}

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

export const STAGE_LABEL: Record<ProjectStage, string> = {
  planning: '规划中',
  developing: '开发中',
  paused: '暂停',
  done: '已完成',
};

export const STAGE_OPTIONS: { value: ProjectStage; label: string }[] = [
  { value: 'planning', label: '规划中' },
  { value: 'developing', label: '开发中' },
  { value: 'paused', label: '暂停' },
  { value: 'done', label: '已完成' },
];

/** 进度展示文案：手动模式明确标注，避免把 0% 误读成“没有进度” */
export function progressLabel(project: Pick<Project, 'progressMode' | 'progress'>): string {
  const suffix = project.progressMode === 'manual' ? '手动' : '自动';
  return `${project.progress}%（${suffix}）`;
}

export function taskSummary(project: Pick<Project, 'taskCounts'>): string {
  const { total, done } = project.taskCounts;
  return total === 0 ? '暂无任务' : `${done}/${total} 任务完成`;
}

export function stackInputToArray(value: string): string[] {
  return value
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

export const projectsApi = {
  list: (
    workspaceId: string,
    options: {
      filter?: ProjectFilter;
      q?: string;
      limit?: number;
      cursor?: string;
      signal?: AbortSignal;
    } = {},
  ) => {
    const params = new URLSearchParams();
    if (options.filter !== undefined) params.set('filter', options.filter);
    if (options.q !== undefined && options.q.trim() !== '') params.set('q', options.q.trim());
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.cursor !== undefined) params.set('cursor', options.cursor);
    const query = params.toString() === '' ? '' : `?${params.toString()}`;
    return apiClient.get<ProjectList>(`/workspaces/${workspaceId}/projects${query}`, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  },

  get: (workspaceId: string, projectId: string) =>
    apiClient.get<Project>(`/workspaces/${workspaceId}/projects/${projectId}`),

  overview: (workspaceId: string, projectId: string, options: { signal?: AbortSignal } = {}) =>
    apiClient.get<ProjectOverview>(`/workspaces/${workspaceId}/projects/${projectId}/overview`, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }),

  async create(workspaceId: string, input: ProjectInput, key: string): Promise<Project> {
    await ensureCsrfToken();
    return apiClient.post<Project>(`/workspaces/${workspaceId}/projects`, input, {
      idempotencyKey: key,
    });
  },

  async update(
    workspaceId: string,
    projectId: string,
    input: Partial<ProjectInput>,
    version: number,
  ): Promise<Project> {
    await ensureCsrfToken();
    return apiClient.patch<Project>(`/workspaces/${workspaceId}/projects/${projectId}`, input, {
      ifMatch: version,
    });
  },

  async archive(workspaceId: string, projectId: string, version: number): Promise<Project> {
    await ensureCsrfToken();
    return apiClient.post<Project>(
      `/workspaces/${workspaceId}/projects/${projectId}/archive`,
      {},
      { ifMatch: version },
    );
  },

  async unarchive(workspaceId: string, projectId: string, version: number): Promise<Project> {
    await ensureCsrfToken();
    return apiClient.post<Project>(
      `/workspaces/${workspaceId}/projects/${projectId}/unarchive`,
      {},
      { ifMatch: version },
    );
  },

  async remove(workspaceId: string, projectId: string, version: number): Promise<void> {
    await ensureCsrfToken();
    await apiClient.del<{ status: string }>(`/workspaces/${workspaceId}/projects/${projectId}`, {
      ifMatch: version,
    });
  },
};
