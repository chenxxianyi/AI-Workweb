import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError, type SnapshotPolicy } from '../services/api-client';
function policy(): SnapshotPolicy {
  return {
    allows: (path) => path === '/workspaces/ws/entries',
    isReadOnly: () => false,
    online: vi.fn(),
    read: vi.fn().mockResolvedValue({ entries: [{ title: 'local' }] }),
    write: vi.fn().mockResolvedValue(undefined),
    invalidate: vi.fn().mockResolvedValue(undefined),
  };
}
describe('read-only fallback boundaries', () => {
  it('only whitelisted GET can use local copy after network failure', async () => {
    const client = new ApiClient(
        '/api',
        vi.fn().mockRejectedValue(new TypeError('offline')) as typeof fetch,
      ),
      p = policy();
    client.setSnapshotPolicy(p);
    await expect(client.get('/workspaces/ws/entries')).resolves.toEqual({
      entries: [{ title: 'local' }],
    });
    await expect(client.get('/auth/me')).rejects.toBeInstanceOf(ApiError);
    await expect(client.post('/workspaces/ws/entries', { title: 'new' })).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(p.read).toHaveBeenCalledTimes(1);
  });
  it('401 never falls back and clears private session copy', async () => {
    const client = new ApiClient(
        '/api',
        vi
          .fn()
          .mockResolvedValue(
            new Response(
              JSON.stringify({ error: { code: 'SESSION_EXPIRED', message: 'expired' } }),
              { status: 401 },
            ),
          ) as typeof fetch,
      ),
      p = policy();
    client.setSnapshotPolicy(p);
    await expect(client.get('/workspaces/ws/entries')).rejects.toBeInstanceOf(ApiError);
    expect(p.read).not.toHaveBeenCalled();
    expect(p.invalidate).toHaveBeenCalledWith(401);
  });
  it('read-only copy refuses workspace writes before reaching network', async () => {
    const fetcher = vi.fn(),
      client = new ApiClient('/api', fetcher as typeof fetch),
      p = policy();
    p.isReadOnly = () => true;
    client.setSnapshotPolicy(p);
    await expect(client.post('/workspaces/ws/ledger', {})).rejects.toBeInstanceOf(ApiError);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('caller cancellation never exposes fallback data', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = new ApiClient(
        '/api',
        vi.fn().mockRejectedValue(new DOMException('cancel', 'AbortError')) as typeof fetch,
      ),
      p = policy();
    client.setSnapshotPolicy(p);
    await expect(
      client.get('/workspaces/ws/entries', { signal: controller.signal }),
    ).rejects.toBeTruthy();
    expect(p.read).not.toHaveBeenCalled();
  });
});

it('late policy caches first render only for the same authenticated user', async () => {
  let resolveResponse!: (r: Response) => void;
  const request = new Promise<Response>((r) => {
      resolveResponse = r;
    }),
    client = new ApiClient('/api', vi.fn().mockReturnValue(request) as typeof fetch);
  client.setPrincipalId('user-a');
  const pending = client.get('/workspaces/ws/entries');
  const p = policy();
  p.userId = 'user-a';
  client.setSnapshotPolicy(p);
  resolveResponse(new Response(JSON.stringify({ data: { entries: [] }, requestId: 'r-late' })));
  await pending;
  expect(p.write).toHaveBeenCalledWith('/workspaces/ws/entries', { entries: [] });
});
it('old request cannot populate a new account policy', async () => {
  let resolveResponse!: (r: Response) => void;
  const request = new Promise<Response>((r) => {
      resolveResponse = r;
    }),
    client = new ApiClient('/api', vi.fn().mockReturnValue(request) as typeof fetch);
  client.setPrincipalId('user-a');
  const pending = client.get('/workspaces/ws/entries');
  client.setPrincipalId('user-b');
  const p = policy();
  p.userId = 'user-b';
  client.setSnapshotPolicy(p);
  resolveResponse(
    new Response(JSON.stringify({ data: { entries: [{ title: 'old' }] }, requestId: 'r-old' })),
  );
  await pending;
  expect(p.write).not.toHaveBeenCalled();
});
