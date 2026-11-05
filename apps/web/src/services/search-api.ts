import { apiClient } from './api-client';
import type { EntryStatus, EntryType } from './kb-api';
export interface SearchHit { id: string; title: string; summary: string | null; type: EntryType; status: EntryStatus; tags: string[]; score: number; updatedAt: string }
export interface SearchResult { hits: SearchHit[]; hasMore: boolean; nextCursor: string | null; tookMs: number }
export interface OrganizeResult { top: SearchHit[]; overdueDrafts: number; staleEntries: number }
export interface SearchFilters { q: string; status?: string | undefined; type?: string | undefined; tag?: string | undefined; cursor?: string | undefined }
export const searchApi = {
  entries(workspaceId: string, filters: SearchFilters, signal?: AbortSignal): Promise<SearchResult> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== '') params.set(key, value);
    return apiClient.get<SearchResult>('/workspaces/' + workspaceId + '/search/entries?' + params, { ...(signal ? { signal } : {}) });
  },
  organize(workspaceId: string, signal?: AbortSignal): Promise<OrganizeResult> {
    return apiClient.get<OrganizeResult>('/workspaces/' + workspaceId + '/search/organize', { ...(signal ? { signal } : {}) });
  },
  related(workspaceId: string, entryId: string, signal?: AbortSignal): Promise<SearchHit[]> {
    return apiClient.get<SearchHit[]>('/workspaces/' + workspaceId + '/search/related/' + entryId, { ...(signal ? { signal } : {}) });
  },
};
