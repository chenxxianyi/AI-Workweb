import { loadDraft } from '../offline/queue';
import { openOfflineDatabase } from '../offline/store';
import { projectsApi, type ProjectInput } from './projects-api';
import { ApiError } from './api-client';
export interface ProjectCreateOperation {
  key: string;
  createdAt: number;
  input: ProjectInput;
}
const name = 'project-create-pending';
async function reserve(userId: string, workspaceId: string, input: ProjectInput) {
  const db = await openOfflineDatabase(),
    scope = userId + ':' + workspaceId;
  return new Promise<{ operation: ProjectCreateOperation; existed: boolean }>((resolve, reject) => {
    const tx = db.transaction('drafts', 'readwrite'),
      store = tx.objectStore('drafts'),
      request = store.get(scope + ':' + name);
    let result: { operation: ProjectCreateOperation; existed: boolean };
    request.onsuccess = () => {
      if (request.result)
        result = { operation: request.result.value as ProjectCreateOperation, existed: true };
      else {
        const operation = { key: crypto.randomUUID(), createdAt: Date.now(), input };
        result = { operation, existed: false };
        store.put({
          id: scope + ':' + name,
          scope,
          userId,
          workspaceId,
          savedAt: Date.now(),
          value: operation,
        });
      }
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? Error('无法保存原提交记录'));
  });
}
async function clearIfSame(userId: string, workspaceId: string, key: string) {
  const db = await openOfflineDatabase(),
    id = userId + ':' + workspaceId + ':' + name;
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction('drafts', 'readwrite'),
      store = tx.objectStore('drafts'),
      request = store.get(id);
    request.onsuccess = () => {
      if (request.result?.value?.key === key) store.delete(id);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
export async function pendingProjectCreate(
  userId: string,
  workspaceId: string,
): Promise<ProjectCreateOperation | null> {
  const row = await loadDraft(userId, workspaceId, name);
  if (!row) return null;
  const value = row.value as ProjectCreateOperation;
  if (
    !value ||
    typeof value.key !== 'string' ||
    typeof value.createdAt !== 'number' ||
    !value.input ||
    typeof value.input.name !== 'string'
  )
    throw Error('本机项目提交记录格式异常，请先导出本机草稿。');
  return value;
}
export function expiredProjectCreate(value: ProjectCreateOperation): boolean {
  return Date.now() - value.createdAt > 7 * 86400000;
}
export async function submitProjectCreate(
  userId: string,
  workspaceId: string,
  input: ProjectInput,
) {
  const { operation, existed } = await reserve(userId, workspaceId, input);
  if (JSON.stringify(operation.input) !== JSON.stringify(input))
    throw Error('上次创建结果尚未确认，请先用原内容确认。');
  if (expiredProjectCreate(operation))
    throw Error('项目提交记录已超过7天，请导出并人工核对，不能自动重发。');
  try {
    const result = await projectsApi.create(workspaceId, operation.input, operation.key);
    await clearIfSame(userId, workspaceId, operation.key);
    return result;
  } catch (error) {
    if (!existed && error instanceof ApiError && error.status === 422)
      await clearIfSame(userId, workspaceId, operation.key);
    throw error;
  }
}
