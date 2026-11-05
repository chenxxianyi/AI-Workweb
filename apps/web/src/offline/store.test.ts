import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  canSnapshot,
  clearPrivateUser,
  disableOfflineSession,
  loadOfflineView,
  readSnapshot,
  saveOfflineView,
  transaction,
  writeSnapshot,
} from './store';
import type { MeResponse } from '../services/auth-api';
const me: MeResponse = {
  user: { id: 'user-a', displayName: '验收账号', email: 'not-stored@example.test' },
  memberships: [
    { workspaceId: 'space-a', name: '验收空间', timezone: 'Asia/Shanghai', role: 'owner' },
  ],
  preferences: { theme: 'dark' },
};
beforeEach(async () => {
  await clearPrivateUser('user-a');
  await clearPrivateUser('user-b');
  localStorage.clear();
});
describe('private IndexedDB snapshots', () => {
  it('same path is isolated by user and workspace', async () => {
    await writeSnapshot('user-a', 'space-a', '/entries', { title: 'private' }, () => true);
    expect((await readSnapshot('user-a', 'space-a', '/entries'))?.data).toEqual({
      title: 'private',
    });
    expect(await readSnapshot('user-b', 'space-a', '/entries')).toBeUndefined();
    expect(await readSnapshot('user-a', 'space-b', '/entries')).toBeUndefined();
  });
  it('deactivated request cannot repopulate after logout', async () => {
    let active = true;
    const pending = writeSnapshot('user-a', 'space-a', '/entries', { title: 'old' }, () => active);
    active = false;
    await clearPrivateUser('user-a');
    await pending;
    expect(await readSnapshot('user-a', 'space-a', '/entries')).toBeUndefined();
  });
  it('logout erases own snapshots but preserves other user scope', async () => {
    await writeSnapshot('user-a', 'space-a', '/entries', { title: 'a' }, () => true);
    await writeSnapshot('user-b', 'space-a', '/entries', { title: 'b' }, () => true);
    await clearPrivateUser('user-a');
    expect(await readSnapshot('user-a', 'space-a', '/entries')).toBeUndefined();
    expect((await readSnapshot('user-b', 'space-a', '/entries'))?.data).toEqual({ title: 'b' });
  });
  it('offline view contains no auth response and grants only Viewer', async () => {
    await saveOfflineView(me);
    const view = await loadOfflineView();
    expect(view?.memberships[0]?.role).toBe('viewer');
    const stored = await transaction<Record<string, unknown>>('meta', 'readonly', (s) =>
      s.get('last-view'),
    );
    expect(JSON.stringify(stored)).not.toMatch(/not-stored@example|token|password|cookie|session/i);
    await disableOfflineSession('user-a');
    expect(await loadOfflineView()).toBeNull();
  });
  it('offline identity fails closed without local marker', async () => {
    await saveOfflineView(me);
    localStorage.removeItem('aiwb.offline-active-user');
    expect(await loadOfflineView()).toBeNull();
  });
  it('authentication, exports, admin and analytics are excluded', () => {
    for (const path of [
      '/auth/me',
      '/users/me/preferences',
      '/workspaces/space-a/invitations',
      '/workspaces/space-a/transfers/id/download',
      '/workspaces/space-a/analytics/monthly',
      '/workspaces/space-a/ledger/summary',
      '/workspaces/space-b/tasks',
    ])
      expect(canSnapshot(path, 'space-a')).toBe(false);
    expect(canSnapshot('/workspaces/space-a/entries?limit=20', 'space-a')).toBe(true);
  });
});
