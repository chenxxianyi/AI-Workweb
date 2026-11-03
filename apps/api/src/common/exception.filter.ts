import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ApiErrorBody, ErrorCode } from '@aiwb/contracts';
import { ERROR_STATUS } from '@aiwb/contracts';
import { currentRequestId } from './request-context.js';
import { logger } from './logger.js';

/** Prisma 已知错误码 → 业务错误码（避免把 SQL 细节暴露给客户端） */
function mapPrismaCode(code: string | undefined): { status: number; code: ErrorCode } | null {
  switch (code) {
    case 'P2002':
      return { status: 409, code: 'CONFLICT' };
    case 'P2025':
      return { status: 404, code: 'NOT_FOUND' };
    case 'P2003':
    case 'P2014':
      return { status: 422, code: 'VALIDATION_FAILED' };
    case 'P2034':
      return { status: 409, code: 'CONFLICT' };
    default:
      return null;
  }
}

function extractErrorCode(body: unknown): ErrorCode | null {
  if (typeof body !== 'object' || body === null) return null;
  const candidate = (body as { code?: unknown }).code;
  return typeof candidate === 'string' && candidate in ERROR_STATUS ? (candidate as ErrorCode) : null;
}

/**
 * 全局异常过滤器（F06）：所有错误都以统一信封返回。
 * 规则：
 * - 已知 ApiException / HTTP 异常 → 保留状态码与 code
 * - 未知异常 → 500 INTERNAL_ERROR，响应只含通用文案 + requestId
 * - 任何响应都不含堆栈、SQL、连接串、内部路径
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();
    const requestId =
      (response.getHeader('X-Request-Id') as string | undefined) ?? currentRequestId();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let errorBody: ApiErrorBody = {
      code: 'INTERNAL_ERROR',
      message: '服务器内部错误，请稍后重试',
    };

    if (exception instanceof HttpException) {
      const exceptionStatus = exception.getStatus();
      const body = exception.getResponse();
      const explicit = extractErrorCode(
        typeof body === 'object' && body !== null ? body : undefined,
      );

      if (explicit !== null) {
        const source = body as {
          message?: unknown;
          fieldErrors?: unknown;
          details?: unknown;
          currentVersion?: unknown;
        };
        errorBody = {
          code: explicit,
          message: typeof source.message === 'string' ? source.message : exception.message,
          ...(source.fieldErrors !== undefined
            ? { fieldErrors: source.fieldErrors as ApiErrorBody['fieldErrors'] }
            : {}),
          ...(source.details !== undefined
            ? { details: source.details as Record<string, unknown> }
            : {}),
          ...(typeof source.currentVersion === 'number'
            ? { currentVersion: source.currentVersion }
            : {}),
        };
      } else {
        // 框架异常（路由不存在、方法不允许、请求体过大、JSON 语法错误等）
        const mapped = mapFrameworkStatus(exceptionStatus);
        errorBody = { code: mapped.code, message: mapped.message };
      }
      status = exceptionStatus;
    } else {
      const prismaLike = exception as { code?: unknown };
      const mapped =
        typeof prismaLike?.code === 'string' ? mapPrismaCode(prismaLike.code) : null;
      if (mapped !== null) {
        status = mapped.status;
        errorBody = { code: mapped.code, message: prismaMessage(mapped.code) };
      }
    }

    const level = status >= 500 ? 'error' : 'warn';
    logger[level](
      {
        requestId,
        method: request.method,
        path: request.url.split('?')[0],
        status,
        errorCode: errorBody.code,
        ...(status >= 500
          ? { err: { message: (exception as Error)?.message, stack: (exception as Error)?.stack } }
          : {}),
      },
      'http_error',
    );

    if (response.headersSent) return;
    response.status(status).json({ error: errorBody, requestId });
  }
}

function mapFrameworkStatus(status: number): { code: ErrorCode; message: string } {
  switch (status) {
    case 400:
      return { code: 'MALFORMED_REQUEST', message: '请求格式不正确' };
    case 404:
      return { code: 'NOT_FOUND', message: '请求的资源不存在' };
    case 405:
      return { code: 'MALFORMED_REQUEST', message: '不支持的请求方法' };
    case 413:
      return { code: 'PAYLOAD_TOO_LARGE', message: '请求体超过大小限制' };
    case 415:
      return { code: 'UNSUPPORTED_MEDIA_TYPE', message: '不支持的内容类型' };
    case 429:
      return { code: 'RATE_LIMITED', message: '请求过于频繁，请稍后再试' };
    case 503:
      return { code: 'SERVICE_UNAVAILABLE', message: '服务暂不可用，请稍后再试' };
    default:
      return { code: 'INTERNAL_ERROR', message: '服务器内部错误，请稍后重试' };
  }
}

function prismaMessage(code: ErrorCode): string {
  switch (code) {
    case 'CONFLICT':
      return '数据冲突，请刷新后重试';
    case 'NOT_FOUND':
      return '请求的资源不存在';
    case 'VALIDATION_FAILED':
      return '数据校验失败';
    default:
      return '请求处理失败';
  }
}
