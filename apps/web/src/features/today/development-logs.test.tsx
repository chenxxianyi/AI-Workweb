import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DevelopmentLogs } from './development-logs';
import { apiClient } from '../../services/api-client';
vi.mock('../../providers/workspace-provider', () => ({
  useWorkspace: () => ({ workspace: { workspaceId: 'logs-space' }, can: () => true }),
}));
vi.mock('../../services/auth-api', () => ({
  ensureCsrfToken: vi.fn().mockResolvedValue(undefined),
  describeApiError: () => '保存失败',
}));
vi.mock('../../services/api-client', () => ({
  ApiError: class extends Error {},
  apiClient: { get: vi.fn(), post: vi.fn(), del: vi.fn() },
}));
function mount() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
    >
      <DevelopmentLogs />
    </QueryClientProvider>,
  );
  return screen.getByLabelText('开发日志内容');
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(apiClient.get).mockResolvedValue({ logs: [], hasMore: false, nextCursor: null });
  vi.mocked(apiClient.post).mockResolvedValue({});
});
describe('development log keyboard and persistence feedback', () => {
  it('IME confirmation, Shift+Enter and empty input never submit', () => {
    const input = mount();
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.change(input, { target: { value: '中文' } });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(apiClient.post).not.toHaveBeenCalled();
  });
  it('Enter submits once and clears only after success', async () => {
    const input = mount();
    fireEvent.change(input, { target: { value: '今日进展' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(''));
    expect(vi.mocked(apiClient.post).mock.calls[0]?.[1]).toEqual({ text: '今日进展' });
  });
  it('failure retains text and retry keeps original idempotency key', async () => {
    vi.mocked(apiClient.post).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({});
    const input = mount();
    fireEvent.change(input, { target: { value: '保留草稿' } });
    fireEvent.click(screen.getByRole('button', { name: '保存日志' }));
    await screen.findByRole('alert');
    expect((input as HTMLTextAreaElement).value).toBe('保留草稿');
    fireEvent.click(screen.getByRole('button', { name: '保存日志' }));
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(2));
    expect(vi.mocked(apiClient.post).mock.calls[0]?.[2]).toEqual(
      vi.mocked(apiClient.post).mock.calls[1]?.[2],
    );
  });
});
