import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from './api-client';

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

describe('ApiClient 请求层', () => {
  it('成功响应按信封解包，只返回 data', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: { status: 'ok' }, requestId: 'r-1' }));
    const client = new ApiClient('/api/v1', fetchMock as unknown as typeof fetch);

    await expect(client.get<{ status: string }>('/health/live')).resolves.toEqual({ status: 'ok' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/health/live',
      expect.objectContaining({ method: 'GET', credentials: 'same-origin' }),
    );
  });

  it('422 映射为 ApiError，保留 code 与 fieldErrors', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        {
          error: {
            code: 'VALIDATION_FAILED',
            message: '请求字段校验失败',
            fieldErrors: { title: ['不能为空'] },
          },
          requestId: 'r-2',
        },
        { status: 422, headers: { 'x-request-id': 'r-2' } },
      ),
    );
    const client = new ApiClient('/api/v1', fetchMock as unknown as typeof fetch);

    const error = await client.post('/workspaces/w/tasks', {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.kind).toBe('http');
    expect(apiError.status).toBe(422);
    expect(apiError.code).toBe('VALIDATION_FAILED');
    expect(apiError.fieldErrors?.['title']).toEqual(['不能为空']);
    expect(apiError.requestId).toBe('r-2');
  });

  it('412 被识别为冲突', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        { error: { code: 'PRECONDITION_FAILED', message: '已被修改', currentVersion: 9 }, requestId: 'r-3' },
        { status: 412 },
      ),
    );
    const client = new ApiClient('/api/v1', fetchMock as unknown as typeof fetch);

    const error = (await client.patch('/workspaces/w/tasks/t', {}, { ifMatch: 8 }).catch((e: unknown) => e)) as ApiError;
    expect(error.isConflict).toBe(true);
    expect(error.currentVersion).toBe(9);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/workspaces/w/tasks/t',
      expect.objectContaining({ headers: expect.objectContaining({ 'If-Match': '"8"' }) }),
    );
  });

  it('401 被识别为未认证', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: { code: 'SESSION_EXPIRED', message: '登录已过期' }, requestId: 'r-4' }, { status: 401 }),
    );
    const client = new ApiClient('/api/v1', fetchMock as unknown as typeof fetch);

    const error = (await client.get('/auth/me').catch((e: unknown) => e)) as ApiError;
    expect(error.isUnauthenticated).toBe(true);
  });

  it('无信封的 500 也给出稳定错误', async () => {
    const fetchMock = vi.fn(async () => new Response('boom', { status: 500 }));
    const client = new ApiClient('/api/v1', fetchMock as unknown as typeof fetch);

    const error = (await client.get('/x').catch((e: unknown) => e)) as ApiError;
    expect(error.kind).toBe('http');
    expect(error.status).toBe(500);
    expect(error.message).toContain('500');
  });

  it('网络失败标记为 network（结果未知）', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const client = new ApiClient('/api/v1', fetchMock as unknown as typeof fetch);

    const error = (await client.get('/x').catch((e: unknown) => e)) as ApiError;
    expect(error.kind).toBe('network');
    expect(error.isUnknownResult).toBe(true);
  });

  it('超时（未由调用方取消）标记为 timeout', async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    });
    const client = new ApiClient('/api/v1', fetchMock as unknown as typeof fetch);

    const error = (await client.get('/x').catch((e: unknown) => e)) as ApiError;
    expect(error.kind).toBe('timeout');
    expect(error.isUnknownResult).toBe(true);
  });

  it('调用方用自己的 signal 取消时原样抛出 AbortError', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    const client = new ApiClient('/api/v1', fetchMock as unknown as typeof fetch);

    const error = await client.get('/x', { signal: controller.signal }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DOMException);
  });

  it('写请求带 CSRF 与幂等键', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: { id: 't1' }, requestId: 'r-5' }, { status: 201 }));
    const client = new ApiClient('/api/v1', fetchMock as unknown as typeof fetch);
    client.setCsrfToken('csrf-123');

    await client.post('/workspaces/w/tasks', { title: 'x' }, { idempotencyKey: 'key-1' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/workspaces/w/tasks',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-CSRF-Token': 'csrf-123',
          'Idempotency-Key': 'key-1',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ title: 'x' }),
      }),
    );
  });
});
