import { transaction, type ScopedRecord } from './store';
import { apiClient, ApiError } from '../services/api-client';
import { authApi, ensureCsrfToken } from '../services/auth-api';
export type Operation =
  | { kind: 'log'; payload: { text: string; logDate: string } }
  | {
      kind: 'draft';
      payload: {
        title: string;
        body: string;
        type: 'note' | 'design' | 'adr' | 'troubleshoot' | 'command';
      };
    }
  | {
      kind: 'task-state';
      payload: { id: string; status: 'todo' | 'doing' | 'done'; version: number };
    };
export interface QueuedOperation extends ScopedRecord {
  key: string;
  workspaceVersion: number;
  createdAt: string;
  operation: Operation;
  status: 'pending' | 'unknown' | 'blocked' | 'conflict' | 'expired';
  error?: string;
}
export interface LocalDraft extends ScopedRecord {
  value: unknown;
  baseVersion?: number;
}
export async function records<T extends ScopedRecord>(
  name: 'queue' | 'drafts',
  userId: string,
  workspaceId?: string,
): Promise<T[]> {
  return transaction<T[]>(name, 'readonly', (s) =>
    s
      .index(workspaceId ? 'scope' : 'userId')
      .getAll(workspaceId ? userId + ':' + workspaceId : userId),
  );
}
export async function pendingCount(userId: string) {
  const [queue, drafts] = await Promise.all([records('queue', userId), records('drafts', userId)]);
  return queue.length + drafts.length;
}
export async function persistOperation(
  userId: string,
  workspaceId: string,
  workspaceVersion: number,
  operation: Operation,
  key: string = crypto.randomUUID(),
) {
  const scope = userId + ':' + workspaceId,
    row: QueuedOperation = {
      id: scope + ':' + key,
      scope,
      userId,
      workspaceId,
      key,
      workspaceVersion,
      operation,
      createdAt: new Date().toISOString(),
      savedAt: Date.now(),
      status: 'pending',
    };
  await transaction('queue', 'readwrite', (s) => s.put(row));
  return row;
}
export const deleteLocalRecord = (name: 'queue' | 'drafts', id: string) =>
  transaction(name, 'readwrite', (s) => s.delete(id));
export async function rebaseTaskIntent(
  row: QueuedOperation,
  version: number,
  workspaceVersion: number,
) {
  if (row.status !== 'conflict' || row.operation.kind !== 'task-state')
    throw new Error('只能重新确认已知版本冲突');
  const key = crypto.randomUUID(),
    next: QueuedOperation = {
      ...row,
      id: row.scope + ':' + key,
      key,
      createdAt: new Date().toISOString(),
      savedAt: Date.now(),
      workspaceVersion,
      status: 'pending',
      operation: { kind: 'task-state', payload: { ...row.operation.payload, version } },
    };
  delete next.error;
  await transaction('queue', 'readwrite', (store) => {
    store.delete(row.id);
    return store.put(next);
  });
  return next;
}
export async function saveDraft(
  userId: string,
  workspaceId: string,
  name: string,
  value: unknown,
  baseVersion?: number,
) {
  const scope = userId + ':' + workspaceId;
  await transaction('drafts', 'readwrite', (s) =>
    s.put({
      id: scope + ':' + name,
      userId,
      workspaceId,
      scope,
      value,
      baseVersion,
      savedAt: Date.now(),
    }),
  );
}
export async function loadDraft(userId: string, workspaceId: string, name: string) {
  return transaction<LocalDraft | undefined>('drafts', 'readonly', (s) =>
    s.get(userId + ':' + workspaceId + ':' + name),
  );
}
export function exportLocal(value: unknown, filename = '未同步资料.json') {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
// 并发标签页允许提交相同键；服务器事务幂等保证最多一次。权限每批重新验证，服务器每次仍查库。
export async function syncQueue(
  userId: string,
  workspaceId: string,
  active: () => boolean = () => true,
) {
  const me = await authApi.me();
  if (me.user.id !== userId) throw new Error('当前账号与离线操作不一致，请重新登录原账号');
  const membership = me.memberships.find((m) => m.workspaceId === workspaceId);
  if (!membership || membership.role === 'viewer')
    throw new Error('当前账号已无写入权限；可导出或删除本地意图');
  await ensureCsrfToken(true);
  const rows = await records<QueuedOperation>('queue', userId, workspaceId);
  for (const row of rows.sort((a, b) => a.savedAt - b.savedAt)) {
    if (!active()) return;
    if (row.status === 'blocked' || row.status === 'conflict') continue;
    if (Date.now() - Date.parse(row.createdAt) > 7 * 86400000) {
      row.status = 'expired';
      row.error = '超过7天，不自动提交；请导出并人工核对';
      await transaction('queue', 'readwrite', (s) => s.put(row));
      continue;
    }
    try {
      const path = '/workspaces/' + workspaceId + '/offline-operations';
      const found = await apiClient.get<{ status: string }>(path + '/' + row.key);
      if (!active()) return;
      if (found.status !== 'succeeded')
        await apiClient.post(
          path,
          {
            userId,
            workspaceVersion: row.workspaceVersion,
            createdAt: row.createdAt,
            operation: row.operation,
          },
          { idempotencyKey: row.key, verifiedReplay: true },
        );
      if (active()) await deleteLocalRecord('queue', row.id);
    } catch (error) {
      if (!active()) return;
      row.status =
        error instanceof ApiError && error.isConflict
          ? 'conflict'
          : error instanceof ApiError && (error.status ?? 0) >= 400 && (error.status ?? 0) < 500
            ? 'blocked'
            : 'unknown';
      row.error = error instanceof Error ? error.message : '同步失败';
      await transaction('queue', 'readwrite', (s) => s.put(row));
      if (row.status === 'unknown') break;
    }
  }
}
