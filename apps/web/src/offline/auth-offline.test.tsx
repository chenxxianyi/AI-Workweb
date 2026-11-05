import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from '../providers/auth-provider';
import { authApi,ensureCsrfToken, type MeResponse } from '../services/auth-api';
import { ApiError } from '../services/api-client';
import {
  clearPrivateUser,
  loadOfflineView,
  markPendingServerLogout,
  pendingServerLogout,
  saveOfflineView,
  writeSnapshot,
  readSnapshot,
} from './store';
vi.mock('../services/auth-api', () => ({
  authApi: { me: vi.fn(), logout: vi.fn(), login: vi.fn() },
  ensureCsrfToken: vi.fn().mockResolvedValue('fixture-csrf'),
}));
const me: MeResponse = {
  user: { id: 'auth-user-a', displayName: '离线验收', email: 'not-cached@example.test' },
  memberships: [
    { workspaceId: 'auth-space', name: '空间', timezone: 'Asia/Shanghai', role: 'owner' },
  ],
  preferences: { theme: 'system' },
};
function View() {
  const auth = useAuth();
  return (
    <>
      <p data-testid="auth">
        {auth.status}:{auth.offlineIdentity ? 'offline' : 'online'}:
        {auth.memberships[0]?.role ?? 'none'}
      </p>
      <button onClick={() => void auth.logout()}>logout</button>
      <button onClick={()=>void auth.refresh()}>refresh</button>
    </>
  );
}
function mount() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
    >
      <AuthProvider>
        <View />
      </AuthProvider>
    </QueryClientProvider>,
  );
}
beforeEach(async () => {
  vi.resetAllMocks();
  vi.mocked(ensureCsrfToken).mockResolvedValue('fixture-csrf');
  markPendingServerLogout(false);
  await clearPrivateUser(me.user.id);
  localStorage.clear();
});
describe('offline identity and logout authority', () => {
  it('authoritative membership removal clears that workspace copy',async()=>{vi.mocked(authApi.me).mockResolvedValue(me);mount();await waitFor(()=>expect(screen.getByTestId('auth').textContent).toBe('authenticated:online:owner'));await writeSnapshot(me.user.id,'auth-space','/entries',{title:'old'},()=>true);vi.mocked(authApi.me).mockResolvedValue({...me,memberships:[]});fireEvent.click(screen.getByRole('button',{name:'refresh'}));await waitFor(()=>expect(screen.getByTestId('auth').textContent).toBe('authenticated:online:none'));await waitFor(async()=>expect(await readSnapshot(me.user.id,'auth-space','/entries')).toBeUndefined());});
  it('network failure can restore only projected read-only identity', async () => {
    await saveOfflineView(me);
    vi.mocked(authApi.me).mockRejectedValue(new ApiError({ kind: 'network', message: 'offline' }));
    mount();
    await waitFor(() =>
      expect(screen.getByTestId('auth').textContent).toBe('authenticated:offline:viewer'),
    );
  });
  it('server 401 never restores cached identity', async () => {
    await saveOfflineView(me);
    await writeSnapshot(me.user.id, 'auth-space', '/entries', { title: 'private' }, () => true);
    vi.mocked(authApi.me).mockRejectedValue(
      new ApiError({ kind: 'http', status: 401, message: 'expired' }),
    );
    mount();
    await waitFor(() =>
      expect(screen.getByTestId('auth').textContent).toBe('anonymous:online:none'),
    );
    await waitFor(async () => expect(await loadOfflineView()).toBeNull());
    await waitFor(async () =>
      expect(await readSnapshot(me.user.id, 'auth-space', '/entries')).toBeUndefined(),
    );
  });
  it('offline logout clears data and flushes server logout before next bootstrap', async () => {
    vi.mocked(authApi.me).mockResolvedValue(me);
    vi.mocked(authApi.logout)
      .mockRejectedValueOnce(new ApiError({ kind: 'network', message: 'offline' }))
      .mockResolvedValue(undefined);
    const first = mount();
    await waitFor(() =>
      expect(screen.getByTestId('auth').textContent).toBe('authenticated:online:owner'),
    );
    await writeSnapshot(me.user.id, 'auth-space', '/entries', { title: 'private' }, () => true);
    fireEvent.click(screen.getByRole('button', { name: 'logout' }));
    await waitFor(() =>
      expect(screen.getByTestId('auth').textContent).toBe('anonymous:online:none'),
    );
    expect(pendingServerLogout()).toBe(true);
    expect(await loadOfflineView()).toBeNull();
    expect(await readSnapshot(me.user.id, 'auth-space', '/entries')).toBeUndefined();
    first.unmount();
    vi.mocked(authApi.me).mockClear();
    mount();
    await waitFor(() => expect(pendingServerLogout()).toBe(false));
    expect(authApi.me).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId('auth').textContent).toBe('anonymous:online:none'),
    );
  });
});
