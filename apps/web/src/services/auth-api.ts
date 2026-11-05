import { ApiError, apiClient } from './api-client';

/** 认证相关接口（F11）：与后端 /auth/* 一一对应，类型与契约保持一致 */

export type WorkspaceRole = 'owner' | 'editor' | 'viewer';

export interface Membership {
  workspaceId: string;
  name: string;
  timezone: string;
  role: WorkspaceRole;
}

export interface CurrentUser {
  id: string;
  email: string;
  displayName: string;
}

export interface MeResponse {
  user: CurrentUser;
  memberships: Membership[];
  preferences: { theme: string };
}

export interface LoginResult {
  user: CurrentUser;
  memberships: Membership[];
  csrfToken: string;
  sessionExpiresAt: string;
}

export interface SessionInfo {
  id: string;
  current: boolean;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
}

export interface CsrfResponse {
  csrfToken: string;
  expiresAt: string;
}

/**
 * 保证客户端持有可用的 CSRF 令牌。
 * - 优先用内存里的（登录后由服务端轮换）
 * - 内存没有时请求当前同源 GET /auth/csrf，避免读取另一环境的 Cookie
 */
export async function ensureCsrfToken(force = false): Promise<string> {
  const existing = force ? undefined : apiClient.getCsrfToken();
  if (existing !== undefined && existing !== '') {
    apiClient.setCsrfToken(existing);
    return existing;
  }
  const response = await apiClient.get<CsrfResponse>('/auth/csrf');
  apiClient.setCsrfToken(response.csrfToken);
  return response.csrfToken;
}

export const authApi = {
  csrf: () => apiClient.get<CsrfResponse>('/auth/csrf'),
  me: () => apiClient.get<MeResponse>('/auth/me'),

  async login(email: string, password: string): Promise<LoginResult> {
    await ensureCsrfToken();
    const result = await apiClient.post<LoginResult>('/auth/login', { email, password });
    // 登录轮换：服务端已下发新的 CSRF Cookie，内存同步
    apiClient.setCsrfToken(result.csrfToken);
    return result;
  },

  async logout(): Promise<void> {
    await ensureCsrfToken();
    await apiClient.post<{ status: string }>('/auth/logout', {});
    apiClient.setCsrfToken(undefined);
  },

  sessions: () => apiClient.get<{ sessions: SessionInfo[] }>('/auth/sessions'),

  async revokeSession(sessionId: string): Promise<void> {
    await ensureCsrfToken();
    await apiClient.del<{ status: string }>(`/auth/sessions/${sessionId}`);
  },

  async revokeOtherSessions(): Promise<number> {
    await ensureCsrfToken();
    const result = await apiClient.del<{ revokedSessions: number }>('/auth/sessions');
    return result.revokedSessions;
  },

  async acceptInvitation(
    token: string,
    input: { password?: string; displayName?: string },
  ): Promise<{ workspaceId: string; role: WorkspaceRole; createdUser: boolean }> {
    return apiClient.post('/auth/invitations/accept', {
      token,
      ...(input.password === undefined ? {} : { password: input.password }),
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    });
  },

  async completeRecovery(token: string, newPassword: string): Promise<void> {
    await apiClient.post('/auth/recovery/complete', { token, newPassword });
  },

  async changePassword(currentPassword: string, newPassword: string): Promise<number> {
    await ensureCsrfToken();
    const result = await apiClient.patch<{ revokedSessions: number }>('/auth/password', {
      currentPassword,
      newPassword,
    });
    return result.revokedSessions;
  },
};

/** 把 ApiError 转成可直接展示的中文文案（含字段错误与限流提示） */
export function describeApiError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.kind === 'network') return '网络不可用，请检查连接后重试';
    if (error.kind === 'timeout') return '请求超时，结果未知；请重试，不要重复提交';
    if (error.code === 'AUTH_INVALID_CREDENTIALS') return '账号或密码不正确';
    if (error.code === 'RATE_LIMITED') return error.message;
    if (error.fieldErrors !== undefined) {
      const first = Object.values(error.fieldErrors)[0];
      if (first !== undefined && first.length > 0) return first[0] as string;
    }
    return error.message;
  }
  return error instanceof Error ? error.message : '发生未知错误';
}
