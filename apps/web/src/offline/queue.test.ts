import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPrivateUser, transaction } from './store';
import {
  loadDraft,
  persistOperation,
  records,
  saveDraft,
  syncQueue,
  type QueuedOperation,
} from './queue';
import { authApi } from '../services/auth-api';
import { apiClient, ApiError } from '../services/api-client';
vi.mock('../services/auth-api', () => ({ authApi: { me: vi.fn() }, ensureCsrfToken: vi.fn() }));
beforeEach(async () => {
  vi.restoreAllMocks();
  await clearPrivateUser('q-user');
  vi.mocked(authApi.me).mockResolvedValue({
    user: { id: 'q-user', displayName: 'q', email: 'q' },
    memberships: [{ workspaceId: 'q-space', name: 'q', role: 'owner', timezone: 'Asia/Shanghai' }],
    preferences: { theme: 'system' },
  });
});
describe('durable offline intent', () => {
  it('persists stable key and isolates account/space after reopening', async () => {
    await persistOperation(
      'q-user',
      'q-space',
      1,
      { kind: 'log', payload: { text: '记录', logDate: '2026-11-04' } },
      'stable-key',
    );
    expect((await records<QueuedOperation>('queue', 'q-user', 'q-space'))[0]?.key).toBe(
      'stable-key',
    );
    expect(await records('queue', 'other', 'q-space')).toEqual([]);
    expect(await records('queue', 'q-user', 'other')).toEqual([]);
  });
  it('preserves body and original version as local draft', async () => {
    await saveDraft('q-user', 'q-space', 'entry:id', { body: '本地正文' }, 3);
    expect((await loadDraft('q-user', 'q-space', 'entry:id'))?.baseVersion).toBe(3);
  });
  it('unknown response checks original key before any resend', async () => {
    await persistOperation(
      'q-user',
      'q-space',
      1,
      { kind: 'log', payload: { text: '记录', logDate: '2026-11-04' } },
      'same',
    );
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue({ status: 'succeeded' }),
      post = vi.spyOn(apiClient, 'post');
    await syncQueue('q-user', 'q-space');
    expect(get.mock.calls[0]?.[0]).toContain('/same');
    expect(post).not.toHaveBeenCalled();
    expect(await records('queue', 'q-user')).toEqual([]);
  });
  it('network failure preserves payload and same idempotency key', async () => {
    await persistOperation(
      'q-user',
      'q-space',
      1,
      { kind: 'draft', payload: { title: '标题', body: '正文', type: 'note' } },
      'fixed',
    );
    vi.spyOn(apiClient, 'get').mockResolvedValue({ status: 'not_found' });
    const post = vi
      .spyOn(apiClient, 'post')
      .mockRejectedValue(new ApiError({ kind: 'network', message: '断网' }));
    await syncQueue('q-user', 'q-space');
    expect(post.mock.calls[0]?.[2]?.idempotencyKey).toBe('fixed');
    expect((await records<QueuedOperation>('queue', 'q-user'))[0]?.status).toBe('unknown');
  });
  it('stale operations are retained without network submission', async () => {
    const row = await persistOperation('q-user', 'q-space', 1, {
      kind: 'log',
      payload: { text: '旧', logDate: '2020-01-01' },
    });
    row.createdAt = '2020-01-01T00:00:00Z';
    await transaction('queue', 'readwrite', (s) => s.put(row));
    const get = vi.spyOn(apiClient, 'get');
    await syncQueue('q-user', 'q-space');
    expect(get).not.toHaveBeenCalled();
    expect((await records<QueuedOperation>('queue', 'q-user'))[0]?.status).toBe('expired');
  });
  it('lost membership or different account prevents writes', async () => {
    await persistOperation('q-user', 'q-space', 1, {
      kind: 'log',
      payload: { text: '旧', logDate: '2026-11-04' },
    });
    vi.mocked(authApi.me).mockResolvedValue({
      user: { id: 'q-user', displayName: 'q', email: 'q' },
      memberships: [],
      preferences: { theme: 'system' },
    });
    const post = vi.spyOn(apiClient, 'post');
    await expect(syncQueue('q-user', 'q-space')).rejects.toThrow('写入权限');
    expect(post).not.toHaveBeenCalled();
  });
  it('quota rejection is propagated so caller retains/export input', async () => {
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    await expect(
      persistOperation('q-user', 'q-space', 1, {
        kind: 'log',
        payload: { text: '待导出', logDate: '2026-11-04' },
      }),
    ).rejects.toThrow('quota');
    put.mockRestore();
  });
});
