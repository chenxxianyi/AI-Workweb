import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * 请求上下文（F06）：用 AsyncLocalStorage 传 requestId，
 * 让日志、错误响应、审计在同一请求内拿到同一个标识，不靠参数层层传递。
 */
export interface RequestContext {
  requestId: string;
  userId?: string;
  workspaceId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function currentRequestId(): string {
  return storage.getStore()?.requestId ?? 'r-unknown';
}

/** 外部传入的 requestId 只接受受限字符，避免日志注入 */
export function normalizeRequestId(candidate: string | undefined): string {
  if (candidate !== undefined && /^[A-Za-z0-9._-]{8,64}$/.test(candidate)) return candidate;
  return `r-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}
