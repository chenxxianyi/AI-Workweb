import 'fake-indexeddb/auto';
import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './auth-provider';
import { authApi, type MeResponse } from '../services/auth-api';
import { clearPrivateUser } from '../offline/store';
import { records, saveDraft } from '../offline/queue';
vi.mock('../services/auth-api', () => ({
  authApi: { me: vi.fn(), login: vi.fn(), logout: vi.fn() },
  ensureCsrfToken: vi.fn().mockResolvedValue('fixture'),
}));
const me: MeResponse = {
  user: { id: 'reauth-user', email: 'reauth@example.test', displayName: 'r' },
  memberships: [
    { workspaceId: 'reauth-space', name: 'r', role: 'owner', timezone: 'Asia/Shanghai' },
  ],
  preferences: { theme: 'system' },
};
function Input() {
  const [value, setValue] = useState('');
  return <input aria-label="编辑中" value={value} onChange={(e) => setValue(e.target.value)} />;
}
function Page() {
  const { user } = useAuth();
  const query = useQuery({
    queryKey: ['ws', 'reauth-space', 'entry'],
    queryFn: () => Promise.resolve({ title: 'server' }),
    enabled: !!user,
  });
  return query.isPending ? <p>加载内容</p> : <Input />;
}
function Controls() {
  const auth = useAuth(),
    [message, setMessage] = useState('');
  return (
    <>
      <p>{auth.status}</p>
      <button
        onClick={() =>
          void auth
            .login('reauth@example.test', 'fixture-password')
            .then(() => setMessage('续登完成'))
            .catch((error) => setMessage((error as Error).message))
        }
      >
        续登
      </button>
      <output>{message}</output>
    </>
  );
}
beforeEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  localStorage.clear();
  await clearPrivateUser('reauth-user');
  vi.mocked(authApi.me).mockResolvedValue(me);
  vi.mocked(authApi.login).mockResolvedValue({
    user: me.user,
    memberships: me.memberships,
    csrfToken: 'fixture',
    sessionExpiresAt: '2026-12-01T00:00:00Z',
  });
  vi.mocked(authApi.logout).mockResolvedValue(undefined);
});
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  client.setQueryData(['ws', 'reauth-space', 'entry'], { title: 'server' });
  render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <Controls />
        <Page />
      </AuthProvider>
    </QueryClientProvider>,
  );
  return client;
}
it('same account reauthentication preserves dirty mounted form and durable drafts without deletion prompt', async () => {
  await saveDraft('reauth-user', 'reauth-space', 'entry:new', { body: '本地正文' });
  const prompt = vi.spyOn(window, 'confirm').mockReturnValue(false),
    client = mount();
  await screen.findByText('authenticated');
  fireEvent.change(screen.getByLabelText('编辑中'), { target: { value: '未提交的项目输入' } });
  fireEvent.click(screen.getByRole('button', { name: '续登' }));
  await screen.findByText('续登完成');
  expect((screen.getByLabelText('编辑中') as HTMLInputElement).value).toBe('未提交的项目输入');
  expect(prompt).not.toHaveBeenCalled();
  expect(await records('drafts', 'reauth-user')).toHaveLength(1);
  expect(client.getQueryData(['ws', 'reauth-space', 'entry'])).toBeDefined();
});
it('cancelling a different account switch revokes the new session and retains old local intentions', async () => {
  await saveDraft('reauth-user', 'reauth-space', 'entry:new', { body: '保留原账号草稿' });
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  vi.mocked(authApi.login).mockResolvedValue({
    user: { id: 'other-user', email: 'other@example.test', displayName: 'other' },
    memberships: [],
    csrfToken: 'fixture',
    sessionExpiresAt: '2026-12-01T00:00:00Z',
  });
  mount();
  await screen.findByText('authenticated');
  fireEvent.click(screen.getByRole('button', { name: '续登' }));
  await screen.findByText(/原账号的本机资料仍保留/);
  await waitFor(() => expect(authApi.logout).toHaveBeenCalledOnce());
  expect(await records('drafts', 'reauth-user')).toHaveLength(1);
  expect(screen.getByText('anonymous')).toBeTruthy();
});
