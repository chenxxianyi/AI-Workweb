import { apiClient } from './api-client';
import { ensureCsrfToken } from './auth-api';

/** 知识条目接口（F19 后端 / F20 前端） */

export type EntryStatus = 'draft' | 'verified' | 'archived';
export type EntryType = 'note' | 'design' | 'adr' | 'troubleshoot' | 'command';

export interface Entry {
  id: string;
  type: EntryType;
  title: string;
  summary: string | null;
  body: string;
  lang: string | null;
  projectId: string | null;
  source: string | null;
  status: EntryStatus;
  rating: number | null;
  tags: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
  bodyBytes: number;
}

export interface EntryList {
  entries: Entry[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface EntryInput {
  type?: EntryType;
  title?: string;
  summary?: string | null;
  body?: string;
  lang?: string | null;
  projectId?: string | null;
  source?: string | null;
  rating?: number | null;
  tags?: string[];
}

export interface EntryFilters {
  status?: EntryStatus;
  type?: EntryType;
  projectId?: string;
  tag?: string;
  q?: string;
  limit?: number;
  cursor?: string;
}

export interface EntryRevision {
  id: string;
  body: string;
  bodyBytes: number;
  savedAt: string;
  sourceVersion: number;
  savedBy: string;
}

export interface TagCount {
  name: string;
  count: number;
}

export const kbApi = {
  list: (workspaceId: string, filters: EntryFilters = {}, options: { signal?: AbortSignal } = {}) => {
    const params = new URLSearchParams();
    for (const key of ['status', 'type', 'projectId', 'tag', 'q', 'cursor'] as const) {
      const value = filters[key];
      if (value !== undefined && value !== '') params.set(key, value);
    }
    if (filters.limit !== undefined) params.set('limit', String(filters.limit));
    const query = params.toString() === '' ? '' : `?${params.toString()}`;
    return apiClient.get<EntryList>(`/workspaces/${workspaceId}/entries${query}`, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  },

  get: (workspaceId: string, entryId: string, options: { signal?: AbortSignal } = {}) =>
    apiClient.get<Entry>(`/workspaces/${workspaceId}/entries/${entryId}`, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }),

  tags: (workspaceId: string, options: { signal?: AbortSignal } = {}) =>
    apiClient.get<{ tags: TagCount[] }>(`/workspaces/${workspaceId}/tags`, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }),

  async create(workspaceId: string, input: EntryInput, idempotencyKey: string): Promise<Entry> {
    await ensureCsrfToken();
    const result = await apiClient.post<{ entry: Entry; replayed: boolean }>(
      `/workspaces/${workspaceId}/entries`,
      input,
      { idempotencyKey },
    );
    return result.entry;
  },

  async update(workspaceId: string, entry: Pick<Entry, 'id' | 'version'>, input: EntryInput): Promise<Entry> {
    await ensureCsrfToken();
    return apiClient.patch<Entry>(`/workspaces/${workspaceId}/entries/${entry.id}`, input, {
      ifMatch: entry.version,
    });
  },

  async setStatus(
    workspaceId: string,
    entry: Pick<Entry, 'id' | 'version'>,
    status: EntryStatus,
  ): Promise<Entry> {
    await ensureCsrfToken();
    return apiClient.post<Entry>(
      `/workspaces/${workspaceId}/entries/${entry.id}/status`,
      { status },
      { ifMatch: entry.version },
    );
  },

  async remove(workspaceId: string, entry: Pick<Entry, 'id' | 'version'>): Promise<void> {
    await ensureCsrfToken();
    await apiClient.del<{ status: string }>(`/workspaces/${workspaceId}/entries/${entry.id}`, {
      ifMatch: entry.version,
    });
  },

  revisions: (workspaceId: string, entryId: string, options: { signal?: AbortSignal } = {}) =>
    apiClient.get<{ revisions: EntryRevision[] }>(`/workspaces/${workspaceId}/entries/${entryId}/revisions`, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }),

  async restoreRevision(
    workspaceId: string,
    entry: Pick<Entry, 'id' | 'version'>,
    revisionId: string,
  ): Promise<Entry> {
    await ensureCsrfToken();
    return apiClient.post<Entry>(
      `/workspaces/${workspaceId}/entries/${entry.id}/revisions/${revisionId}/restore`,
      {},
      { ifMatch: entry.version },
    );
  },
};
