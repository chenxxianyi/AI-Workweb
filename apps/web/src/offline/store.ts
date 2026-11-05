import type { MeResponse } from '../services/auth-api';
export interface ScopedRecord {
  id: string;
  userId: string;
  workspaceId: string;
  scope: string;
  savedAt: number;
}
export interface Snapshot extends ScopedRecord {
  path: string;
  data: unknown;
}
const databaseName = 'aiwb-private-v1',
  activeKey = 'aiwb.offline-active-user';
let opening: Promise<IDBDatabase> | null = null;
export async function openOfflineDatabase(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) throw new Error('本机离线存储不可用');
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      for (const name of ['snapshots', 'drafts', 'queue']) {
        const store = request.result.createObjectStore(name, { keyPath: 'id' });
        store.createIndex('scope', 'scope');
        store.createIndex('userId', 'userId');
      }
      request.result.createObjectStore('meta', { keyPath: 'id' });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      opening = null;
      reject(request.error);
    };
    request.onblocked = () => {
      opening = null;
      reject(new Error('请关闭旧页面后重试离线存储'));
    };
  });
  return opening;
}
export async function transaction<T>(
  name: string,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openOfflineDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, mode),
      request = action(tx.objectStore(name));
    let result: T;
    request.onsuccess = () => {
      result = request.result;
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error ?? request.error);
    tx.onabort = () => reject(tx.error ?? new Error('本机存储事务中止'));
  });
}
export async function readSnapshot(userId: string, workspaceId: string, path: string) {
  const row = await transaction<Snapshot | undefined>('snapshots', 'readonly', (store) =>
    store.get(userId + ':' + workspaceId + ':' + path),
  );
  return row && row.savedAt >= Date.now() - 7 * 86400000 ? row : undefined;
}
export async function writeSnapshot(
  userId: string,
  workspaceId: string,
  path: string,
  data: unknown,
  active: () => boolean,
) {
  const serialized = JSON.stringify(data);
  if (!serialized || serialized.length > 1024 * 1024) return;
  const db = await openOfflineDatabase();
  if (!active()) return;
  const scope = userId + ':' + workspaceId;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('snapshots', 'readwrite'),
      store = tx.objectStore('snapshots');
    store.put({
      id: scope + ':' + path,
      userId,
      workspaceId,
      scope,
      path,
      data,
      savedAt: Date.now(),
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  const rows = await transaction<Snapshot[]>('snapshots', 'readonly', (store) =>
    store.index('scope').getAll(scope),
  );
  if (rows.length > 50)
    for (const old of rows.sort((a, b) => b.savedAt - a.savedAt).slice(50))
      await transaction('snapshots', 'readwrite', (store) => store.delete(old.id));
}
async function removeByIndex(storeName: string, index: string, key: string) {
  const db = await openOfflineDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite'),
      store = tx.objectStore(storeName),
      request = store.index(index).openKeyCursor(IDBKeyRange.only(key));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        store.delete(cursor.primaryKey);
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
export async function clearSnapshots(userId: string, workspaceId?: string) {
  await removeByIndex(
    'snapshots',
    workspaceId ? 'scope' : 'userId',
    workspaceId ? userId + ':' + workspaceId : userId,
  );
}
export async function clearPrivateUser(userId: string) {
  try {
    if (localStorage.getItem(activeKey) === userId) localStorage.removeItem(activeKey);
  } catch {
    /* 无法读取标记时离线身份也不可用。 */
  }
  for (const name of ['snapshots', 'drafts', 'queue']) await removeByIndex(name, 'userId', userId);
  const current = await transaction<{ userId: string } | undefined>('meta', 'readonly', (store) =>
    store.get('last-view'),
  );
  if (current?.userId === userId)
    await transaction('meta', 'readwrite', (store) => store.delete('last-view'));
}
export async function saveOfflineView(me: MeResponse, active: () => boolean = () => true) {
  const view = {
    id: 'last-view',
    userId: me.user.id,
    displayName: me.user.displayName,
    spaces: me.memberships.map((m) => ({
      workspaceId: m.workspaceId,
      name: m.name,
      timezone: m.timezone,
    })),
    savedAt: Date.now(),
  };
  await openOfflineDatabase();
  if (!active()) return;
  await transaction('meta', 'readwrite', (store) => store.put(view));
  try {
    if (active()) localStorage.setItem(activeKey, me.user.id);
  } catch {
    /* 标记不能保存时不启用离线身份。 */
  }
}
export async function loadOfflineView(): Promise<MeResponse | null> {
  let active: string | null;
  try {
    active = localStorage.getItem(activeKey);
  } catch {
    return null;
  }
  if (!active) return null;
  const view = await transaction<
    | {
        userId: string;
        displayName: string;
        spaces: { workspaceId: string; name: string; timezone: string }[];
        savedAt: number;
      }
    | undefined
  >('meta', 'readonly', (store) => store.get('last-view'));
  if (!view || view.userId !== active || view.savedAt < Date.now() - 86400000) return null;
  return {
    user: { id: view.userId, displayName: view.displayName, email: '离线只读' },
    memberships: view.spaces.map((m) => ({ ...m, role: 'viewer' })),
    preferences: { theme: 'system' },
  };
}
export async function forgetOfflineWorkspace(userId: string, workspaceId: string) {
  await clearSnapshots(userId, workspaceId);
  const view = await transaction<Record<string, unknown> | undefined>('meta', 'readonly', (store) =>
    store.get('last-view'),
  );
  if (view?.['userId'] === userId) {
    view['spaces'] = (view['spaces'] as { workspaceId: string }[]).filter(
      (m) => m.workspaceId !== workspaceId,
    );
    await transaction('meta', 'readwrite', (store) => store.put(view));
  }
}
export function canSnapshot(path: string, workspaceId: string) {
  const pathname = path.split('?')[0] ?? '';
  const prefix = '/workspaces/' + workspaceId;
  if (!pathname.startsWith(prefix + '/')) return false;
  const rest = pathname.slice(prefix.length);
  return (
    /^\/(projects|tasks|entries)(\/[0-9a-f-]{36})?$/.test(rest) ||
    ['/dashboard/today', '/logs', '/ledger'].includes(rest)
  );
}
export function activeOfflineUser(): string | null {
  try {
    return localStorage.getItem(activeKey);
  } catch {
    return null;
  }
}
export async function disableOfflineSession(userId: string) {
  try {
    if (localStorage.getItem(activeKey) === userId) localStorage.removeItem(activeKey);
  } catch {
    /* 读取失败时关闭离线身份。 */
  }
  await clearSnapshots(userId);
  const current = await transaction<{ userId: string } | undefined>('meta', 'readonly', (store) =>
    store.get('last-view'),
  );
  if (current?.userId === userId)
    await transaction('meta', 'readwrite', (store) => store.delete('last-view'));
}
const pendingLogoutKey = 'aiwb.pending-server-logout';
export function pendingServerLogout(): boolean {
  try {
    if (localStorage.getItem(pendingLogoutKey) === '1') return true;
  } catch {
    /* cookie标记仍可用。 */
  }
  return (
    typeof document !== 'undefined' &&
    document.cookie.split(';').some((p) => p.trim() === 'aiwb_logout_pending=1')
  );
}
export function markPendingServerLogout(pending: boolean) {
  try {
    if (pending) localStorage.setItem(pendingLogoutKey, '1');
    else localStorage.removeItem(pendingLogoutKey);
  } catch {
    /* 只读缓存异常不阻断本机退出。 */
  }
  if (typeof document !== 'undefined')
    document.cookie =
      'aiwb_logout_pending=' +
      (pending ? '1' : '') +
      '; Path=/; SameSite=Strict; Max-Age=' +
      (pending ? '604800' : '0');
}
