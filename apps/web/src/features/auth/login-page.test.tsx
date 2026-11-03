import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ApiError } from '../../services/api-client';

const loginMock = vi.fn();
const authState = {
  status: 'anonymous' as 'loading' | 'authenticated' | 'anonymous',
  user: null,
  memberships: [],
  preferences: { theme: 'system' },
  sessionExpired: false,
  dismissSessionExpired: () => undefined,
  login: loginMock,
  logout: vi.fn(),
  refresh: vi.fn(),
};

vi.mock('../../providers/auth-provider', () => ({
  useAuth: () => authState,
}));

const { LoginPage } = await import('./login-page');

function renderLogin(): void {
  render(
    <MemoryRouter initialEntries={['/login?next=%2Fsettings']}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/settings" element={<p>设置页</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('登录页（F11）', () => {
  beforeEach(() => {
    loginMock.mockReset();
    authState.status = 'anonymous';
  });

  it('空表单给出提示且不调用接口', async () => {
    renderLogin();
    await userEvent.click(screen.getByRole('button', { name: '登录' }));
    expect((await screen.findByRole('alert')).textContent).toContain('请输入邮箱与密码');
    expect(loginMock).not.toHaveBeenCalled();
  });

  it('账号密码错误时显示统一文案并保留输入', async () => {
    loginMock.mockRejectedValue(
      new ApiError({ kind: 'http', status: 401, code: 'AUTH_INVALID_CREDENTIALS', message: '账号或密码不正确' }),
    );
    renderLogin();

    await userEvent.type(screen.getByLabelText('邮箱'), 'owner@example.test');
    await userEvent.type(screen.getByLabelText('密码'), 'Wrong-Password-1');
    await userEvent.click(screen.getByRole('button', { name: '登录' }));

    expect((await screen.findByRole('alert')).textContent).toContain('账号或密码不正确');
    expect((screen.getByLabelText('邮箱') as HTMLInputElement).value).toBe('owner@example.test');
    expect((screen.getByLabelText('密码') as HTMLInputElement).value).toBe('Wrong-Password-1');
  });

  it('提交时去除邮箱首尾空格并跳转到 next', async () => {
    loginMock.mockResolvedValue(undefined);
    renderLogin();

    await userEvent.type(screen.getByLabelText('邮箱'), '  owner@example.test  ');
    await userEvent.type(screen.getByLabelText('密码'), 'Good-Password-42');
    await userEvent.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => {
      expect(loginMock).toHaveBeenCalledWith('owner@example.test', 'Good-Password-42');
    });
    expect(await screen.findByText('设置页')).toBeTruthy();
  });

  it('限流错误原样提示（含重试秒数）', async () => {
    loginMock.mockRejectedValue(
      new ApiError({
        kind: 'http',
        status: 429,
        code: 'RATE_LIMITED',
        message: '请求过于频繁，请在 60 秒后重试',
      }),
    );
    renderLogin();

    await userEvent.type(screen.getByLabelText('邮箱'), 'owner@example.test');
    await userEvent.type(screen.getByLabelText('密码'), 'Good-Password-42');
    await userEvent.click(screen.getByRole('button', { name: '登录' }));

    expect((await screen.findByRole('alert')).textContent).toContain('请在 60 秒后重试');
  });
});
