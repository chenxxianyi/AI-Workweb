/**
 * 响应封装与 HTTP 头常量（与 docs/api/openapi.yaml 一致）。
 *
 * 成功：{ data, meta?, requestId }
 * 失败：{ error: { code, message, fieldErrors?, currentVersion?, details? }, requestId }
 */
import type { ErrorCode } from './error-codes.js';

export interface FieldErrors {
  [field: string]: string[];
}

export interface PageMeta {
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ApiSuccess<T> {
  data: T;
  meta?: PageMeta;
  requestId: string;
}

export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
  fieldErrors?: FieldErrors;
  /** 412/409 时供前端刷新重试 */
  currentVersion?: number;
  /** 结构化补充（如 planHash、jobId） */
  details?: Record<string, unknown>;
}

export interface ApiError {
  error: ApiErrorBody;
  requestId: string;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

export function isApiError<T>(body: ApiResponse<T>): body is ApiError {
  return typeof body === 'object' && body !== null && 'error' in body;
}

export const HEADERS = {
  requestId: 'X-Request-Id',
  csrf: 'X-CSRF-Token',
  ifMatch: 'If-Match',
  idempotencyKey: 'Idempotency-Key',
  etag: 'ETag',
} as const;

/** ETag 的值形如 "4"，与实体 version 对应 */
export function etagFor(version: number): string {
  return `"${version}"`;
}

/** 解析 If-Match / ETag；非法格式返回 null（调用方按 428 处理） */
export function parseEtag(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const match = /^"?(\d+)"?$/.exec(value.trim());
  if (match === null) return null;
  const version = Number(match[1]);
  return Number.isSafeInteger(version) && version > 0 ? version : null;
}
