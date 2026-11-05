import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useAuth } from '../providers/auth-provider';
import { useWorkspace } from '../providers/workspace-provider';
import { apiClient, type SnapshotPolicy } from '../services/api-client';
import { authApi } from '../services/auth-api';
import {
  canSnapshot,
  disableOfflineSession,
  forgetOfflineWorkspace,
  readSnapshot,
  writeSnapshot,
} from './store';
import styles from '../features/settings/settings-page.module.css';
import { requestSafeReload } from './application-update';
const SnapshotContext = createContext<{ content: React.JSX.Element | null; readOnly: boolean }>({
  content: null,
  readOnly: false,
});
export function SnapshotStatus() {
  return useContext(SnapshotContext).content;
}
export function useSnapshotReadOnly() {
  return useContext(SnapshotContext).readOnly;
}
export function SnapshotProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const { user, offlineIdentity, identityVersion } = useAuth(),
    { workspace } = useWorkspace();
  const [usedAt, setUsedAt] = useState<number | null>(null),
    [error, setError] = useState(''),
    [reconnecting, setReconnecting] = useState(false);
  const readOnly = useRef(false),
    scope = useRef('');
  useEffect(() => {
    const userId = user?.id,
      workspaceId = workspace?.workspaceId;
    if (!userId || !workspaceId) {
      apiClient.setSnapshotPolicy(undefined);
      setUsedAt(null);
      return;
    }
    const nextScope = userId + ':' + workspaceId;
    if (scope.current !== nextScope) {
      scope.current = nextScope;
      setUsedAt(null);
      readOnly.current = false;
    }
    let active = true;
    const policy: SnapshotPolicy = {
      userId,
      allows: (path) => canSnapshot(path, workspaceId),
      isReadOnly: () => readOnly.current || offlineIdentity,
      online: () => undefined,
      dispose: () => {
        active = false;
      },
      read: async (path) => {
        const row = await readSnapshot(userId, workspaceId, path);
        if (!active || !row) return undefined;
        readOnly.current = true;
        setUsedAt(row.savedAt);
        return row.data;
      },
      write: async (path, data) => {
        if (active) await writeSnapshot(userId, workspaceId, path, data, () => active);
      },
      invalidate: async (status) => {
        if (status === 401) {
          await disableOfflineSession(userId);
        } else await forgetOfflineWorkspace(userId, workspaceId);
        if (active) {
          setUsedAt(null);
          readOnly.current = false;
        }
      },
    };
    apiClient.setSnapshotPolicy(policy);
    return () => {
      active = false;
      apiClient.setSnapshotPolicy(undefined);
    };
  }, [user?.id, workspace?.workspaceId, offlineIdentity, identityVersion]);
  const reconnect = async () => {
    setReconnecting(true);
    setError('');
    try {
      await authApi.me();
      if (!requestSafeReload()) {
        setError('请先保存当前输入，再重新加载。');
        setReconnecting(false);
      }
    } catch {
      setError('尚未恢复服务器连接，当前副本保持只读。');
      setReconnecting(false);
    }
  };
  const content =
    usedAt !== null || offlineIdentity ? (
      <aside className={styles.section} role="status" aria-label="离线只读状态">
        <strong>离线只读副本</strong>
        <p>
          {usedAt
            ? '当前显示本机副本，更新于' + new Date(usedAt).toLocaleString() + '。'
            : '当前仅使用上次验证的空间视图。'}
          身份和权限待联网核验；未缓存内容不可用，服务器保存不会被冒充成功。
        </p>
        <button className={styles.chip} disabled={reconnecting} onClick={() => void reconnect()}>
          {reconnecting ? '正在验证…' : '恢复连接并重新加载'}
        </button>
        {error ? <p>{error}</p> : null}
      </aside>
    ) : null;
  return (
    <SnapshotContext.Provider value={{ content, readOnly: usedAt !== null || offlineIdentity }}>
      {children}
    </SnapshotContext.Provider>
  );
}
