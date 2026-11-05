import { apiClient } from './api-client';
import { ensureCsrfToken } from './auth-api';
export interface TransferJob {
  id: string;
  type: string;
  state: string;
  counts: Record<string, unknown> | null;
  errorCode: string | null;
  planHash: string | null;
  fileHash: string | null;
  expiresAt: string | null;
}
export interface ImportPlanItem {
  id: string;
  type: string;
  sourceId: string;
  incoming?:Record<string,unknown>;
  plan: {
    action?: string;
    targetId?: string;
    baseVersion?: number | null;
    missing?: string[];
  } | null;
}
export interface Decision {
  entityType: string;
  sourceId: string;
  action: 'apply_import' | 'keep_server' | 'skip';
}
export const transfersApi = {
  list: (ws: string, signal?: AbortSignal) =>
    apiClient.get<{ jobs: TransferJob[] }>(`/workspaces/${ws}/transfers`, { signal }),
  status: (ws: string, id: string, signal?: AbortSignal) =>
    apiClient.get<TransferJob>(`/workspaces/${ws}/transfers/${id}`, { signal }),
  items: (ws: string, id: string, cursor?: string) =>
    apiClient.get<{ items: ImportPlanItem[]; nextCursor: string | null }>(
      `/workspaces/${ws}/imports/${id}/items${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`,
    ),
  async export(ws: string, format: 'json' | 'markdown', key: string) {
    await ensureCsrfToken();
    return apiClient.post<TransferJob>(
      `/workspaces/${ws}/exports`,
      { format },
      { idempotencyKey: key },
    );
  },
  async preview(ws: string, file: File, source: string, key: string) {
    await ensureCsrfToken();
    return apiClient.request<TransferJob>(
      `/workspaces/${ws}/imports/preview${source ? '?sourceNamespace=' + encodeURIComponent(source) : ''}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        rawBody: file,
        idempotencyKey: key,
        timeoutMs: 120000,
      },
    );
  },
  async commit(ws: string, id: string, planHash: string, decisions: Decision[], key: string) {
    await ensureCsrfToken();
    return apiClient.post(
      `/workspaces/${ws}/imports/${id}/commit`,
      { planHash, confirm: true, decisions },
      { idempotencyKey: key, timeoutMs: 120000 },
    );
  },
  async cancel(ws: string, id: string) {
    await ensureCsrfToken();
    return apiClient.post(`/workspaces/${ws}/imports/${id}/cancel`, {});
  },
  download: (ws: string, id: string) =>
    apiClient.get<Blob>(`/workspaces/${ws}/transfers/${id}/download`, {
      responseType: 'blob',
      timeoutMs: 120000,
    }),
  recovery: (ws: string, id: string) =>
    apiClient.get<unknown>(`/workspaces/${ws}/imports/${id}/recovery`),
};
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
