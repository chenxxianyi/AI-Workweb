import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ApiError } from '../services/api-client';
import { describeApiError } from '../services/auth-api';

const authState = {
  status: 'anonymous' as 'loading' | 'authenticated' | 'anonymous',
  user: null,
  memberships: [],
  preferences: { theme: 'system' },
  sessionExpired: false,
  dismissSessionExpired: () => undefined,
  login: vi.fn(),
  logout: vi.fn(),
  refresh: vi.fn(),
};

vi.mock('../providers/auth-provider', () => ({
  useAuth: () => authState,
}));

const { ProtectedRoute } = await import('../components/protected-route');

describe('describeApiError（F11）', () => {
  it('网络错误与超时给出可操作文案', () => {
    expect(describeApiError(new ApiError({ kind: 'network', message: 'x' }))).toContain('网络不可用');
    expect(describeApiError(new ApiError({ kind: 'timeout', message: 'x' }))).toContain('结果未知');
  });

  it('优先展示字段错误', () => {
    const error = new ApiError({
      kind: 'http',
      status: 422,
      code: 'VALIDATION_FAILED',
      message: '请求字段校验失败',
      fieldErrors: { email: ['邮箱格式不正确'] },
    });
    expect(describeApiError(error)).toBe('邮箱格式不正确');
  });

  it('未登录与限流按契约文案', () => {
    expect(
      describeApiError(new ApiError({ kind: 'http', status: 401, code: 'AUTH_INVALID_CREDENTIALS', message: 'x' })),
    ).toBe('账号或密码不正确');
    expect(
      describeApiError(new ApiError({ kind: 'http', status: 429, code: 'RATE_LIMITED', message: '请稍后再试' })),
    ).toBe('请稍后再试');
  });
});

describe('ProtectedRoute（F11）', () => {
  it('未登录时跳转登录并带上原路径', () => {
    authState.status = 'anonymous';
    render(
      <MemoryRouter initialEntries={['/settings?tab=security']}>
        <Routes>
          <Route
            path="/settings"
            element={
              <ProtectedRoute>
                <p>受保护内容</p>
              </ProtectedRoute>
            }
          />
          <Route path="/login" element={<p>登录页</p>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('登录页')).toBeTruthy();
    expect(screen.queryByText('受保护内容')).not.toBeTruthy();
  });

  it('已登录时渲染内容', () => {
    authState.status = 'authenticated';
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <Routes>
          <Route
            path="/settings"
            element={
              <ProtectedRoute>
                <p>受保护内容</p>
              </ProtectedRoute>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('受保护内容')).toBeTruthy();
  });

  it('检查登录状态时显示加载态而不是空页面', () => {
    authState.status = 'loading';
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <Routes>
          <Route
            path="/settings"
            element={
              <ProtectedRoute>
                <p>受保护内容</p>
              </ProtectedRoute>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole('status').textContent).toContain('正在检查登录状态');
  });
});
