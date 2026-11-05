import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MaintenancePage } from './maintenance-page';
import { apiClient, ApiError } from '../../services/api-client';
import type * as ApiClientModule from '../../services/api-client';
const fixture = vi.hoisted(() => ({ role: 'owner' }));
vi.mock('../../providers/workspace-provider', () => ({
  useWorkspace: () => ({ workspace: { workspaceId: 'space' }, role: fixture.role }),
}));
vi.mock('../../providers/auth-provider', () => ({ useAuth: () => ({ refresh: vi.fn() }) }));
vi.mock('../../services/auth-api', () => ({
  ensureCsrfToken: vi.fn().mockResolvedValue(undefined),
  describeApiError: () => '结果未知',
}));
vi.mock('../../services/api-client', async () => {
  const real = await vi.importActual<typeof ApiClientModule>(
    '../../services/api-client',
  );
  return { ...real, apiClient: { get: vi.fn(), post: vi.fn(), del: vi.fn() } };
});
function mount() {
  render(
    <MemoryRouter>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
      >
        <MaintenancePage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  fixture.role = 'owner';
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
  vi.mocked(apiClient.get).mockImplementation(async (path) =>
    path.includes('/trash')
      ? {
          items: [
            {
              id: 'entry',
              type: 'entry',
              title: '待恢复知识',
              version: 2,
              deletedAt: '2026-01-01T00:00:00Z',
              expiresAt: '2026-01-31T00:00:00Z',
            },
          ],
          nextCursor: null,
        }
      : { id: 'space', name: '测试空间', version: 3 },
  );
});
describe('maintenance destructive action boundary', () => {
  it('Viewer cannot load owner data', () => {
    fixture.role = 'viewer';
    mount();
    expect(screen.getByText('仅Owner可查看和维护本空间管理内容。')).toBeTruthy();
    expect(apiClient.get).not.toHaveBeenCalled();
  });
  it('cancel clear never submits a mutation', async () => {
    mount();
    await screen.findByText('待恢复知识');
    fireEvent.click(screen.getByRole('button', { name: '清空当前空间业务' }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(apiClient.post).not.toHaveBeenCalled();
    expect(apiClient.del).not.toHaveBeenCalled();
  });
  it('permanent removal requires explicit acknowledgement', async () => {
    mount();
    await screen.findByText('待恢复知识');
    fireEvent.click(screen.getByRole('button', { name: '彻底删除' }));
    expect(screen.getByRole('button', { name: '确认永久删除' }).hasAttribute('disabled')).toBe(
      true,
    );
    fireEvent.click(screen.getByLabelText('我已了解：此操作无法从回收站恢复。'));
    expect(screen.getByRole('button', { name: '确认永久删除' }).hasAttribute('disabled')).toBe(
      false,
    );
    expect(apiClient.del).not.toHaveBeenCalled();
  });
  it('unknown clear result retries same operation and version', async () => {
    vi.mocked(apiClient.post).mockRejectedValue(
      new ApiError({ kind: 'timeout', message: 'unknown' }),
    );
    mount();
    await screen.findByText('待恢复知识');
    fireEvent.click(screen.getByRole('button', { name: '清空当前空间业务' }));
    fireEvent.change(screen.getByLabelText('输入空间名称'), { target: { value: '测试空间' } });
    fireEvent.change(screen.getByLabelText('重新输入当前密码'), {
      target: { value: 'Disposable-Fixture-2026' },
    });
    fireEvent.click(screen.getByLabelText('我已检查备份，了解业务清空的范围及不可直接撤销。'));
    fireEvent.click(screen.getByRole('button', { name: '确认清空当前空间' }));
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(1));
    await screen.findByRole('button', { name: '重试原清空操作' });
    expect(screen.getByRole('button', { name: '取消' }).hasAttribute('disabled')).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: '重试原清空操作' }));
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(2));
    expect(vi.mocked(apiClient.post).mock.calls[0]).toEqual(
      vi.mocked(apiClient.post).mock.calls[1],
    );
  });
});
