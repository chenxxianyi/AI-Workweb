import { describe, expect, it, vi } from 'vitest';
import vm from 'node:vm';
import { serviceWorkerSource } from './service-worker-source';
interface MockEvent {
  request?: { url: string; method: string; mode: string };
  respondWith: ReturnType<typeof vi.fn>;
  waitUntil: ReturnType<typeof vi.fn>;
  data?: unknown;
}
function worker() {
  const listeners: Record<string, (event: MockEvent) => void> = {},
    cache = {
      match: vi.fn().mockResolvedValue(new Response('public shell')),
      addAll: vi.fn().mockResolvedValue(undefined),
    },
    caches = {
      open: vi.fn().mockResolvedValue(cache),
      keys: vi
        .fn()
        .mockResolvedValue([
          'aiwb-shell-v1-old1',
          'aiwb-shell-v1-old2',
          'aiwb-shell-v1-current',
          'other-cache',
        ]),
      delete: vi.fn().mockResolvedValue(true),
    },
    skipWaiting = vi.fn(),
    fetcher = vi.fn().mockResolvedValue(new Response('network'));
  vm.runInNewContext(serviceWorkerSource('current', ['/index.html', '/assets/app-123.js']), {
    URL,
    Set,
    Promise,
    caches,
    fetch: fetcher,
    self: {
      location: { origin: 'http://127.0.0.1' },
      clients: { claim: vi.fn().mockResolvedValue(undefined) },
      skipWaiting,
      addEventListener: (name: string, fn: (event: MockEvent) => void) => {
        listeners[name] = fn;
      },
    },
  });
  return { listeners, caches, cache, skipWaiting };
}
function event(url: string, mode = 'cors', method = 'GET'): MockEvent {
  return { request: { url, method, mode }, respondWith: vi.fn(), waitUntil: vi.fn() };
}
describe('shared app shell cache security', () => {
  it('never intercepts API, invite, login, downloads or writes', () => {
    const w = worker();
    for (const [url, method] of [
      ['/api/v1/auth/me', 'GET'],
      ['/api/v1/workspaces/w/transfers/j/download', 'GET'],
      ['/invite?token=private', 'GET'],
      ['/login', 'GET'],
      ['/api/v1/workspaces/w/logs', 'POST'],
      ['https://other.test/assets/app-123.js', 'GET'],
    ]) {
      const e = event(
        url!.startsWith('http') ? url! : 'http://127.0.0.1' + url,
        'navigate',
        method,
      );
      w.listeners['fetch']!(e);
      expect(e.respondWith).not.toHaveBeenCalled();
    }
    expect(w.caches.open).not.toHaveBeenCalled();
  });
  it('offline navigation gets public index shell only', async () => {
    const w = worker(),
      e = event('http://127.0.0.1/projects/private-id', 'navigate');
    w.listeners['fetch']!(e);
    const response = (await e.respondWith.mock.calls[0]![0]) as Response;
    expect(await response.text()).toBe('public shell');
    expect(w.cache.match).toHaveBeenCalledWith('/index.html');
  });
  it('activation keeps current and previous own cache only', async () => {
    const w = worker(),
      e = event('http://127.0.0.1');
    w.listeners['activate']!(e);
    await e.waitUntil.mock.calls[0]![0];
    expect(w.caches.delete).toHaveBeenCalledTimes(1);
    expect(w.caches.delete).toHaveBeenCalledWith('aiwb-shell-v1-old1');
    expect(w.skipWaiting).not.toHaveBeenCalled();
  });
});
it('previous hashed bundle can be served from retained cache', async () => {
  const w = worker();
  w.caches.keys.mockResolvedValueOnce(['aiwb-shell-v1-old2', 'aiwb-shell-v1-current']);
  w.cache.match.mockResolvedValueOnce(undefined).mockResolvedValueOnce(new Response('old bundle'));
  const e = event('http://127.0.0.1/assets/previous-abcdef12.js');
  w.listeners['fetch']!(e);
  expect(await ((await e.respondWith.mock.calls[0]![0]) as Response).text()).toBe('old bundle');
  expect(w.caches.open).toHaveBeenCalledWith('aiwb-shell-v1-old2');
});
it('failed install removes only its incomplete new cache', async () => {
  const w = worker();
  w.cache.addAll.mockRejectedValueOnce(new Error('offline'));
  const e = event('http://127.0.0.1');
  w.listeners['install']!(e);
  await expect(e.waitUntil.mock.calls[0]![0]).rejects.toThrow('offline');
  expect(w.caches.delete).toHaveBeenCalledWith('aiwb-shell-v1-current');
});
