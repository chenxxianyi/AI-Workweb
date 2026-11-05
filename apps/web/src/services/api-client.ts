import type { ApiErrorBody, ApiSuccess, ErrorCode, FieldErrors } from '@aiwb/contracts';

/** 客户端错误类别：http（服务端有响应）、network（未到达）、timeout（结果未知）、unknown */
export type ApiErrorKind = 'http' | 'network' | 'timeout' | 'unknown';

export interface ApiErrorInit {
  kind: ApiErrorKind;
  message: string;
  status?: number;
  code?: ErrorCode | 'NETWORK_ERROR' | 'TIMEOUT_ERROR';
  fieldErrors?: FieldErrors;
  currentVersion?: number;
  requestId?: string;
}

/**
 * 请求层错误（F07）。
 * 区分“保存失败”和“结果未知”：超时属于结果未知，不能用新幂等键重试（ADR-0004）。
 */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  readonly code?: ApiErrorInit['code'];
  readonly fieldErrors?: FieldErrors;
  readonly currentVersion?: number;
  readonly requestId?: string;

  constructor(init: ApiErrorInit) {
    super(init.message);
    this.name = 'ApiError';
    this.kind = init.kind;
    this.status = init.status;
    this.code = init.code;
    this.fieldErrors = init.fieldErrors;
    this.currentVersion = init.currentVersion;
    this.requestId = init.requestId;
  }

  /** 会话失效：需要重新登录并保留输入 */
  get isUnauthenticated(): boolean {
    return (
      this.status === 401 || this.code === 'UNAUTHENTICATED' || this.code === 'SESSION_EXPIRED'
    );
  }

  /** 版本冲突：需要进入对比面板（412/409/428） */
  get isConflict(): boolean {
    return (
      this.status === 412 ||
      this.status === 428 ||
      this.code === 'PRECONDITION_FAILED' ||
      this.code === 'PRECONDITION_REQUIRED'
    );
  }

  /** 结果未知：可以提示重试，但必须复用原幂等键 */
  get isUnknownResult(): boolean {
    return this.kind === 'timeout' || this.kind === 'network';
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  rawBody?: BodyInit;
  responseType?: 'json' | 'blob';
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** 幂等键：创建与可重试动作必须传（ADR-0004） */
  idempotencyKey?: string;
  /** 条件写的版本号（If-Match） */
  ifMatch?: number;
  /** 仅持久队列在重新核验身份后使用；服务器仍逐次授权。 */
  verifiedReplay?: boolean;
}
export interface SnapshotPolicy {
  userId?: string;
  allows: (path: string) => boolean;
  read: (path: string) => Promise<unknown | undefined>;
  write: (path: string, data: unknown) => Promise<void>;
  isReadOnly: () => boolean;
  online: () => void;
  invalidate: (status: number) => Promise<void>;
  dispose?: () => void;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function combineSignals(signals: AbortSignal[]): AbortSignal {
  if (signals.length === 1) return signals[0] as AbortSignal;
  const anyOf = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyOf === 'function') return anyOf(signals);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

function isEnvelope(body: unknown): body is ApiSuccess<unknown> {
  return typeof body === 'object' && body !== null && 'requestId' in body && 'data' in body;
}

function isErrorEnvelope(body: unknown): body is { error: ApiErrorBody; requestId?: string } {
  return typeof body === 'object' && body !== null && 'error' in body;
}

/**
 * API 客户端（F07）：同源、cookie 会话、统一信封、错误分类、可取消。
 * 组件不直接调用 fetch；一律经此客户端，便于统一注入 CSRF、超时与错误映射。
 */
export class ApiClient {
  private csrfToken: string | undefined;
  private snapshots: SnapshotPolicy | undefined;
  private principalId: string | null = null;
  setPrincipalId(userId: string | null): void {
    this.principalId = userId;
  }
  setSnapshotPolicy(policy: SnapshotPolicy | undefined): void {
    this.snapshots?.dispose?.();
    this.snapshots = policy;
  }

  constructor(
    private readonly baseUrl: string = '/api/v1',
    private readonly fetchImpl: typeof fetch = fetch.bind(globalThis),
  ) {}

  setCsrfToken(token: string | undefined): void {
    this.csrfToken = token;
  }

  getCsrfToken(): string | undefined {
    return this.csrfToken;
  }

  /** 401 统一回调：让 AuthProvider 弹“登录已过期”，避免每个调用点各写一遍 */
  setUnauthorizedHandler(handler: ((error: ApiError) => void) | undefined): void {
    this.unauthorizedHandler = handler;
  }

  private unauthorizedHandler: ((error: ApiError) => void) | undefined;

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? 'GET';
    const snapshots = this.snapshots;
    const principal = this.principalId;
    const currentSnapshots = () =>
      snapshots ??
      (principal !== null && this.snapshots?.userId === principal ? this.snapshots : undefined);
    if (method !== 'GET' && path.startsWith('/workspaces/') && snapshots?.isReadOnly() && !(options.verifiedReplay && /^\/workspaces\/[0-9a-f-]+\/offline-operations$/.test(path)))
      throw new ApiError({
        kind: 'network',
        message: '当前使用离线只读副本，请恢复连接后保存；输入仍保留。',
      });
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(options.headers ?? {}),
    };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && this.csrfToken !== undefined) {
      headers['X-CSRF-Token'] = this.csrfToken;
    }
    if (options.idempotencyKey !== undefined) {
      headers['Idempotency-Key'] = options.idempotencyKey;
    }
    if (options.ifMatch !== undefined) {
      headers['If-Match'] = `"${options.ifMatch}"`;
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal =
      options.signal === undefined
        ? timeoutSignal
        : combineSignals([options.signal, timeoutSignal]);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        credentials: 'same-origin',
        signal,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        ...(options.rawBody === undefined ? {} : { body: options.rawBody }),
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const cache = currentSnapshots();
      if (method === 'GET' && cache?.allows(path)) {
        const stored = await cache.read(path).catch(() => undefined);
        if (stored !== undefined) return stored as T;
      }
      if (error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name)) {
        // 调用方主动取消（如切换空间）：原样抛出，让上层忽略
        if (options.signal?.aborted === true) throw error;
        throw new ApiError({ kind: 'timeout', message: '请求超时，结果未知，请用同一幂等键重试' });
      }
      throw new ApiError({ kind: 'network', message: '网络不可用，请检查连接后重试' });
    }

    if (response.ok && options.responseType === 'blob') return (await response.blob()) as T;
    const text = await response.text();
    let parsed: unknown = undefined;
    if (text !== '') {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = undefined;
      }
    }

    if (!response.ok) {
      const cache = currentSnapshots();
      if (method === 'GET' && response.status >= 500 && cache?.allows(path)) {
        const stored = await cache.read(path).catch(() => undefined);
        if (stored !== undefined) return stored as T;
      }
      if ([401, 403, 404].includes(response.status) && cache)
        void cache.invalidate(response.status).catch(() => undefined);
      const requestId = response.headers.get('x-request-id') ?? undefined;
      let error: ApiError;
      if (isErrorEnvelope(parsed)) {
        error = new ApiError({
          kind: 'http',
          status: response.status,
          code: parsed.error.code,
          message: parsed.error.message,
          fieldErrors: parsed.error.fieldErrors,
          currentVersion: parsed.error.currentVersion,
          requestId: parsed.requestId ?? requestId,
        });
      } else {
        error = new ApiError({
          kind: 'http',
          status: response.status,
          message: `请求失败（HTTP ${response.status}）`,
          requestId,
        });
      }
      if (error.isUnauthenticated) this.unauthorizedHandler?.(error);
      throw error;
    }

    const result = isEnvelope(parsed) ? parsed.data : parsed;
    if (method === 'GET') {
      const cache = currentSnapshots();
      cache?.online();
      if (cache?.allows(path)) void cache.write(path, result).catch(() => undefined);
    }
    return result as T;
  }

  get<T>(path: string, options: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: 'GET' });
  }

  post<T>(path: string, body: unknown, options: RequestOptions = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: 'POST', body });
  }

  patch<T>(path: string, body: unknown, options: RequestOptions = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: 'PATCH', body });
  }

  del<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: 'DELETE' });
  }
}

/** 应用级单例；测试可构造独立实例注入 mock fetch */
export const apiClient = new ApiClient();
