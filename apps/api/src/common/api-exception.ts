import { HttpException, HttpStatus } from '@nestjs/common';
import { ERROR_STATUS, type ErrorCode, type FieldErrors } from '@aiwb/contracts';

/**
 * 业务异常（F06）：把稳定错误码与 HTTP 状态绑定在一起。
 * Service 层只抛 ApiException，Controller/Filter 不再各自拼响应体。
 */
export class ApiException extends HttpException {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    options: {
      status?: number;
      fieldErrors?: FieldErrors;
      details?: Record<string, unknown>;
      currentVersion?: number;
      cause?: unknown;
    } = {},
  ) {
    super(
      {
        code,
        message,
        fieldErrors: options.fieldErrors,
        details: options.details,
        currentVersion: options.currentVersion,
      },
      options.status ?? ERROR_STATUS[code] ?? HttpStatus.INTERNAL_SERVER_ERROR,
      { cause: options.cause },
    );
    this.name = 'ApiException';
  }
}

export function isApiException(error: unknown): error is ApiException {
  return error instanceof ApiException;
}
