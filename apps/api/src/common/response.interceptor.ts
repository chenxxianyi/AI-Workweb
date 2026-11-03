import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/**
 * 统一响应封装（F06）：Controller 只返回业务数据，本拦截器补 {data, meta?, requestId}。
 * 已经是信封结构（含 data 与 requestId）的返回值保持原样，避免重复包装。
 */
interface EnvelopeCandidate<T> {
  data: T;
  meta?: unknown;
  requestId?: string;
}

function isEnvelope(value: unknown): value is EnvelopeCandidate<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'data' in value &&
    typeof (value as { requestId?: unknown }).requestId === 'string'
  );
}

@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const response = context.switchToHttp().getResponse<{ getHeader(name: string): unknown }>();
    const requestId = String(response.getHeader('X-Request-Id') ?? 'r-unknown');

    return next.handle().pipe(
      map((value: unknown) => {
        if (isEnvelope(value)) return value;
        if (value === undefined || value === null) {
          return { data: null, requestId };
        }
        if (typeof value === 'object' && value !== null && 'data' in value) {
          const candidate = value as { data: unknown; meta?: unknown };
          return { data: candidate.data, ...(candidate.meta !== undefined ? { meta: candidate.meta } : {}), requestId };
        }
        return { data: value, requestId };
      }),
    );
  }
}
