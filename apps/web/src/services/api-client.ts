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
    return this.status === 401 || this.code === 'UNAUTHENTICATED' || this.code === 'SESSION_EXPIRED';
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
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** 幂等键：创建与可重试动作必须传（ADR-0004） */
  idempotencyKey?: string;
  /** 条件写的版本号（If-Match） */
  ifMatch?: number;
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

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? 'GET';
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
      options.signal === undefined ? timeoutSignal : combineSignals([options.signal, timeoutSignal]);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        credentials: 'same-origin',
        signal,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        // 调用方主动取消（如切换空间）：原样抛出，让上层忽略
        if (options.signal?.aborted === true) throw error;
        throw new ApiError({ kind: 'timeout', message: '请求超时，结果未知，请用同一幂等键重试' });
      }
      throw new ApiError({ kind: 'network', message: '网络不可用，请检查连接后重试' });
    }

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
      const requestId = response.headers.get('x-request-id') ?? undefined;
      if (isErrorEnvelope(parsed)) {
        throw new ApiError({
          kind: 'http',
          status: response.status,
          code: parsed.error.code,
          message: parsed.error.message,
          fieldErrors: parsed.error.fieldErrors,
          currentVersion: parsed.error.currentVersion,
          requestId: parsed.requestId ?? requestId,
        });
      }
      throw new ApiError({
        kind: 'http',
        status: response.status,
        message: `请求失败（HTTP ${response.status}）`,
        requestId,
      });
    }

    if (isEnvelope(parsed)) return parsed.data as T;
    return parsed as T;
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
