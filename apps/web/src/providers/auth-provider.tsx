import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, apiClient } from '../services/api-client';
import { authApi, ensureCsrfToken, type CurrentUser, type MeResponse, type Membership } from '../services/auth-api';

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

interface AuthContextValue {
  status: AuthStatus;
  user: CurrentUser | null;
  memberships: Membership[];
  preferences: { theme: string };
  /** 会话过期或被吊销：保留当前页面，显示重新登录入口 */
  sessionExpired: boolean;
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
  const bootstrapped = useRef(false);
  // 供 401 回调判断：只有“已登录状态下的 401”才算会话过期
  const statusRef = useRef<AuthStatus>('loading');

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const applyMe = useCallback((next: MeResponse | null) => {
    setMe(next);
    setStatus(next === null ? 'anonymous' : 'authenticated');
    if (next !== null) setSessionExpired(false);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await authApi.me();
      applyMe(next);
    } catch (error) {
      if (error instanceof ApiError && error.isUnauthenticated) {
        applyMe(null);
        return;
      }
      // 网络问题不改变登录态判断，避免离线时被登出
      setStatus((current) => (current === 'loading' ? 'anonymous' : current));
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
      const result = await authApi.login(email, password);
      queryClient.clear(); // 切换账号：丢弃上一个账号的缓存
      applyMe({
        user: result.user,
        memberships: result.memberships,
        preferences: me?.preferences ?? { theme: 'system' },
      });
      // 登录响应只给了 user/memberships，偏好再用 me 补一次（失败不阻断登录）
      void refresh();
    },
    [applyMe, me?.preferences, queryClient, refresh],
  );

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      queryClient.clear();
      applyMe(null);
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
      dismissSessionExpired,
      login,
      logout,
      refresh,
    }),
    [status, me, sessionExpired, dismissSessionExpired, login, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (context === undefined) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return context;
}
