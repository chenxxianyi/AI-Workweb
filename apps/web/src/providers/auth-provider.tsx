import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, apiClient } from '../services/api-client';
import {
  authApi,
  ensureCsrfToken,
  type CurrentUser,
  type MeResponse,
  type Membership,
} from '../services/auth-api';
import {
  activeOfflineUser,
  clearPrivateUser,
  disableOfflineSession,
  forgetOfflineWorkspace,
  loadOfflineView,
  saveOfflineView,
  markPendingServerLogout,
  pendingServerLogout,
} from '../offline/store';
import { pendingCount } from '../offline/queue';
import { flushActiveDrafts } from '../offline/draft-flush';

let flushingLogout: Promise<void> | null = null;
async function finishPendingLogout() {
  if (!pendingServerLogout()) return;
  flushingLogout ??= (async () => {
    await ensureCsrfToken(true);
    try {
      await authApi.logout();
    } catch (error) {
      if (!(error instanceof ApiError && error.isUnauthenticated)) throw error;
    }
    markPendingServerLogout(false);
  })().finally(() => {
    flushingLogout = null;
  });
  return flushingLogout;
}

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

interface AuthContextValue {
  status: AuthStatus;
  user: CurrentUser | null;
  memberships: Membership[];
  preferences: { theme: string };
  /** 会话过期或被吊销：保留当前页面，显示重新登录入口 */
  sessionExpired: boolean;
  offlineIdentity: boolean;
  connectionUnavailable: boolean;
  identityVersion: number;
  dismissSessionExpired: () => void;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/**
 * 认证状态（F11）。
 *
 * - 启动时调用 /auth/me 判断登录态；401 视为未登录（不弹过期框）
 * - 任意请求 401 时置 sessionExpired，界面显示重新登录入口，保留当前路由与输入
 * - 登录成功后刷新 me，并清理上一个账号的查询缓存
 */
export function AuthProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [me, setMe] = useState<MeResponse | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [offlineIdentity, setOfflineIdentity] = useState(false);
  const [connectionUnavailable, setConnectionUnavailable] = useState(false);
  const [identityVersion, setIdentityVersion] = useState(0);
  const meRef = useRef<MeResponse | null>(null),
    identityEpoch = useRef(0);
  const bootstrapped = useRef(false);
  // 供 401 回调判断：只有“已登录状态下的 401”才算会话过期
  const statusRef = useRef<AuthStatus>('loading');

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const applyMe = useCallback((next: MeResponse | null, offline = false) => {
    apiClient.setPrincipalId(next?.user.id ?? null);
    const previous = meRef.current;
    if (next && !offline && previous?.user.id === next.user.id) {
      const removed = previous.memberships.filter(
        (old) => !next.memberships.some((m) => m.workspaceId === old.workspaceId),
      );
      if (removed.length) apiClient.setSnapshotPolicy(undefined);
      for (const old of removed)
        void forgetOfflineWorkspace(previous.user.id, old.workspaceId).catch(() => undefined);
    }
    meRef.current = next;
    const epoch = ++identityEpoch.current;
    setIdentityVersion(epoch);
    setOfflineIdentity(offline);
    if (!offline) setConnectionUnavailable(false);
    if (next && !offline)
      void saveOfflineView(next, () => identityEpoch.current === epoch).catch(() => undefined);
    setMe(next);
    setStatus(next === null ? 'anonymous' : 'authenticated');
    if (next !== null) setSessionExpired(false);
  }, []);

  const refresh = useCallback(async () => {
    if (pendingServerLogout()) {
      try {
        await finishPendingLogout();
        applyMe(null);
      } catch {
        applyMe(null);
        setConnectionUnavailable(true);
      }
      return;
    }
    try {
      const next = await authApi.me();
      applyMe(next);
    } catch (error) {
      if (error instanceof ApiError && error.isUnauthenticated) {
        const previous = meRef.current?.user.id ?? activeOfflineUser();
        if (previous) void disableOfflineSession(previous).catch(() => undefined);
        applyMe(null);
        return;
      }
      setConnectionUnavailable(true);
      if (meRef.current) {
        setOfflineIdentity(true);
        return;
      }
      const stored = await loadOfflineView().catch(() => null);
      if (stored) applyMe(stored, true);
      else setStatus('anonymous');
    }
  }, [applyMe]);

  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;

    apiClient.setUnauthorizedHandler((error) => {
      // 启动探测与登录页的 401 属于“未登录”，不弹过期框；
      // 只有已登录会话被吊销/过期时才提示重新登录。
      if (error.status === 401 && statusRef.current === 'authenticated') {
        setSessionExpired(true);
      }
    });

    void ensureCsrfToken().catch(() => undefined);
    void refresh();
  }, [refresh]);

  const login = useCallback(
    async (email: string, password: string) => {
      await finishPendingLogout();
      await flushActiveDrafts();
      const previous = meRef.current?.user.id ?? activeOfflineUser();
      const result = await authApi.login(email, password);
      if (
        previous &&
        previous !== result.user.id &&
        (await pendingCount(previous).catch(() => 0)) > 0 &&
        !confirm(
          '当前账号有未同步资料。切换账号会清除这些资料。取消可先到“本机草稿与待同步”导出；确定将永久删除。',
        )
      ) {
        markPendingServerLogout(true);
        try {
          await authApi.logout();
          markPendingServerLogout(false);
        } catch {
          /* 下次登录前必须完成服务器退出。 */
        }
        apiClient.setSnapshotPolicy(undefined);
        queryClient.clear();
        applyMe(null);
        throw new Error('已取消账号切换，原账号的本机资料仍保留；请重新登录原账号后导出。');
      }
      markPendingServerLogout(false);
      apiClient.setSnapshotPolicy(undefined);
      if (previous && previous !== result.user.id)
        await clearPrivateUser(previous).catch(() => undefined);
      if (previous !== result.user.id) queryClient.clear();
      applyMe({
        user: result.user,
        memberships: result.memberships,
        preferences: { theme: 'system' },
      });
      if (previous === result.user.id) void queryClient.invalidateQueries();
      // 登录响应只给了 user/memberships，偏好再用 me 补一次（失败不阻断登录）
      void refresh();
    },
    [applyMe, queryClient, refresh],
  );

  const logout = useCallback(async () => {
    await flushActiveDrafts();
    const previous = meRef.current?.user.id ?? activeOfflineUser();
    if (
      previous &&
      (await pendingCount(previous).catch(() => 0)) > 0 &&
      !confirm(
        '存在尚未同步的草稿或队列。退出会永久清除。取消可先到“本机草稿与待同步”导出；确定将删除并退出。',
      )
    )
      throw new Error('已取消退出，请先导出未同步资料');
    ++identityEpoch.current;
    apiClient.setSnapshotPolicy(undefined);
    markPendingServerLogout(true);
    try {
      await authApi.logout();
      markPendingServerLogout(false);
    } catch (error) {
      if (error instanceof ApiError && error.isUnauthenticated) markPendingServerLogout(false);
    } finally {
      if (previous) await clearPrivateUser(previous).catch(() => undefined);
      queryClient.clear();
      applyMe(null);
      if (pendingServerLogout()) setConnectionUnavailable(true);
      setSessionExpired(false);
    }
  }, [applyMe, queryClient]);

  const dismissSessionExpired = useCallback(() => setSessionExpired(false), []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user: me?.user ?? null,
      memberships: me?.memberships ?? [],
      preferences: me?.preferences ?? { theme: 'system' },
      sessionExpired,
      offlineIdentity,
      connectionUnavailable,
      identityVersion,
      dismissSessionExpired,
      login,
      logout,
      refresh,
    }),
    [
      status,
      me,
      sessionExpired,
      offlineIdentity,
      connectionUnavailable,
      identityVersion,
      dismissSessionExpired,
      login,
      logout,
      refresh,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (context === undefined) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return context;
}
