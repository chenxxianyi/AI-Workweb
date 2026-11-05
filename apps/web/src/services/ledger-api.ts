import { apiClient } from './api-client';
import { ensureCsrfToken } from './auth-api';

/** AI 台账接口（F17 后端 / F18 前端） */

export interface LedgerRecord {
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

export interface LedgerList {
  records: LedgerRecord[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface LedgerSummary {
  count: number;
  totalMinutes: number;
  totalSavedMinutes: number;
  averageEffect: number | null;
  byTool: { tool: string; minutes: number; count: number }[];
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

export interface CreateLedgerInput {
  recordDate: string;
  projectId?: string | null;
  entryId?: string | null;
  tool: string;
  scene: string;
  minutes: number;
  savedMinutes?: number | null;
  effect: number;
  note?: string | null;
}

export const TOOL_OPTIONS = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'copilot', label: 'Copilot' },
  { value: 'other', label: '其他工具' },
];

export const SCENE_OPTIONS = [
  { value: 'coding', label: '编码' },
  { value: 'review', label: '评审' },
  { value: 'debug', label: '排查' },
  { value: 'docs', label: '文档' },
  { value: 'research', label: '调研' },
  { value: 'other', label: '其他场景' },
];

export function toolLabel(value: string): string {
  return TOOL_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

export function sceneLabel(value: string): string {
  return SCENE_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

export const ledgerApi = {
  list: (workspaceId: string, filters: LedgerFilters = {}) => {
    const params = new URLSearchParams();
    for (const key of ['projectId', 'from', 'to', 'tool', 'scene', 'cursor'] as const) {
      const value = filters[key];
      if (value !== undefined && value !== '') params.set(key, value);
    }
    if (filters.limit !== undefined) params.set('limit', String(filters.limit));
    const query = params.toString() === '' ? '' : `?${params.toString()}`;
    return apiClient.get<LedgerList>(`/workspaces/${workspaceId}/ledger${query}`);
  },

  summary: (
    workspaceId: string,
    filters: { from?: string; to?: string; projectId?: string } = {},
  ) => {
    const params = new URLSearchParams();
    if (filters.from !== undefined && filters.from !== '') params.set('from', filters.from);
    if (filters.to !== undefined && filters.to !== '') params.set('to', filters.to);
    if (filters.projectId !== undefined && filters.projectId !== '')
      params.set('projectId', filters.projectId);
    const query = params.toString() === '' ? '' : `?${params.toString()}`;
    return apiClient.get<LedgerSummary>(`/workspaces/${workspaceId}/ledger/summary${query}`);
  },

  async create(
    workspaceId: string,
    input: CreateLedgerInput,
    idempotencyKey: string,
  ): Promise<LedgerRecord> {
    await ensureCsrfToken();
    const result = await apiClient.post<{ record: LedgerRecord; replayed: boolean }>(
      `/workspaces/${workspaceId}/ledger`,
      input,
      { idempotencyKey },
    );
    return result.record;
  },

  async remove(workspaceId: string, record: Pick<LedgerRecord, 'id' | 'version'>): Promise<void> {
    await ensureCsrfToken();
    await apiClient.del<{ status: string }>(`/workspaces/${workspaceId}/ledger/${record.id}`, {
      ifMatch: record.version,
    });
  },
  async update(
    workspaceId: string,
    record: Pick<LedgerRecord, 'id' | 'version'>,
    input: CreateLedgerInput,
  ): Promise<LedgerRecord> {
    await ensureCsrfToken();
    return apiClient.patch<LedgerRecord>(`/workspaces/${workspaceId}/ledger/${record.id}`, input, {
      ifMatch: record.version,
    });
  },
};
