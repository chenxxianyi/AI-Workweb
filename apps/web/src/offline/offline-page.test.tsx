import 'fake-indexeddb/auto';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';
import { OfflinePage } from './offline-page';
import { clearPrivateUser } from './store';
import { records, type QueuedOperation } from './queue';
vi.mock('../providers/auth-provider', () => ({ useAuth: () => ({ user: { id: 'form-user' } }) }));
vi.mock('../providers/workspace-provider', () => ({
  useWorkspace: () => ({ workspace: { workspaceId: 'form-space' } }),
}));
vi.mock('../services/api-client', () => ({
  apiClient: {
    get: vi
      .fn()
      .mockResolvedValue({ workspaceVersion: 1, businessDate: '2026-11-04', canWrite: true }),
  },
}));
function mount() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
    >
      <OfflinePage />
    </QueryClientProvider>,
  );
}
beforeEach(async () => {
  await clearPrivateUser('form-user');
});
it('switching to task queue never deletes a previously written log draft', async () => {
  const view = mount();
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: '保存到本机待同步' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.change(screen.getByLabelText('离线内容'), { target: { value: '仍未排队的日志' } });
  fireEvent.change(screen.getByLabelText('操作类型'), { target: { value: 'task-state' } });
  await screen.findByLabelText('任务ID');
  fireEvent.change(screen.getByLabelText('任务ID'), {
    target: { value: 'a4233333-3333-4333-8333-333333333333' },
  });
  fireEvent.click(screen.getByRole('button', { name: '保存到本机待同步' }));
  await waitFor(async () =>
    expect((await records<QueuedOperation>('queue', 'form-user')).length).toBe(1),
  );
  const drafts = await records('drafts', 'form-user');
  expect(drafts.some((d) => d.id.endsWith('offline-composer:log'))).toBe(true);
  view.unmount();
  mount();
  await waitFor(() =>
    expect((screen.getByLabelText('离线内容') as HTMLTextAreaElement).value).toBe('仍未排队的日志'),
  );
});
