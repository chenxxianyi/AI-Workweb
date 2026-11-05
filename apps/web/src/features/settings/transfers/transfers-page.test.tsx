import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { TransfersPage } from './transfers-page';
import { transfersApi } from '../../../services/transfers-api';
import { ApiError } from '../../../services/api-client';
vi.mock('../../../providers/workspace-provider', () => ({
  useWorkspace: () => ({ workspace: { workspaceId: 'transfer-ws' }, can: () => true }),
}));
vi.mock('../../../services/transfers-api', () => ({
  transfersApi: {
    list: vi.fn(),
    export: vi.fn(),
    status: vi.fn(),
    items: vi.fn(),
    commit: vi.fn(),
    cancel: vi.fn(),
  },
  saveBlob: vi.fn(),
}));
function mount(path = '/settings/transfers') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
      >
        <TransfersPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(transfersApi.list).mockResolvedValue({ jobs: [] });
});
describe('transfer confirmation and unknown result', () => {
  it('export timeout retries original key and format', async () => {
    vi.mocked(transfersApi.export)
      .mockRejectedValueOnce(new ApiError({ kind: 'timeout', message: 'unknown' }))
      .mockRejectedValueOnce(new ApiError({ kind: 'timeout', message: 'unknown' }));
    mount();
    fireEvent.click(screen.getByRole('button', { name: '导出 JSON' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: '继续查询原导出操作' }));
    await waitFor(() => expect(transfersApi.export).toHaveBeenCalledTimes(2));
    expect(vi.mocked(transfersApi.export).mock.calls[0]).toEqual(
      vi.mocked(transfersApi.export).mock.calls[1],
    );
  });
  it('preview never commits automatically and cancel only cancels', async () => {
    vi.mocked(transfersApi.status).mockResolvedValue({
      id: 'job',
      type: 'import',
      state: 'preview_ready',
      planHash: 'h',
      counts: { created: 1 },
      errorCode: null,
      fileHash: null,
      expiresAt: null,
    });
    vi.mocked(transfersApi.items).mockResolvedValue({ items: [], nextCursor: null });
    vi.mocked(transfersApi.cancel).mockResolvedValue({});
    mount('/settings/transfers?jobId=job');
    await screen.findByText('当前作业：预览就绪');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '确认导入' }).hasAttribute('disabled')).toBe(true),
    );
    expect(transfersApi.commit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '取消此次导入' }));
    await waitFor(() => expect(transfersApi.cancel).toHaveBeenCalledWith('transfer-ws', 'job'));
    expect(transfersApi.commit).not.toHaveBeenCalled();
  });
  it('known queued job resumes polling without creating another job', async () => {
    vi.mocked(transfersApi.status).mockResolvedValue({
      id: 'known-job',
      type: 'import',
      state: 'queued',
      planHash: 'h',
      counts: null,
      errorCode: null,
      fileHash: null,
      expiresAt: null,
    });
    mount('/settings/transfers?jobId=known-job');
    await screen.findByText('当前作业：等待处理');
    expect(transfersApi.status).toHaveBeenCalledWith('transfer-ws', 'known-job', expect.anything());
    expect(transfersApi.export).not.toHaveBeenCalled();
    expect(transfersApi.commit).not.toHaveBeenCalled();
  });
});
