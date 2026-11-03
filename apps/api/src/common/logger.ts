import type { IncomingMessage, ServerResponse } from 'node:http';
import { pino, type Logger } from 'pino';
import { currentRequestId, normalizeRequestId, runWithRequestContext } from './request-context.js';

/**
 * 结构化日志（F06）。
 * - JSON 行输出，字段固定：level/time/msg/requestId/method/path/status/durationMs
 * - 脱敏：cookie／authorization／password／token 一律不落盘（白名单式裁剪）
 * - 不记录请求体（业务正文可能含敏感内容），只记长度
 */
export const REDACT_PATHS = [
  // 顶层敏感字段（pino 的 "*.key" 只匹配嵌套一层）
  'password',
  'passwordHash',
  'token',
  'tokenHash',
  'csrfToken',
  'cookie',
  'authorization',
  // 嵌套与请求头
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.tokenHash',
  '*.csrfToken',
  'err.config.headers',
  'err.request',
];

export function createLogger(level: string, destination?: NodeJS.WritableStream): Logger {
  const options = {
    level,
    base: { service: 'api' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    formatters: {
      level: (label: string) => ({ level: label }),
    },
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}

export const logger: Logger = createLogger(process.env['LOG_LEVEL'] ?? 'info');

export interface AccessLogRecord {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  contentLength?: number;
}

/** 访问日志：只在响应结束时写一条，带 requestId */
export function createAccessLogMiddleware(log: Logger = logger) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const requestId = normalizeRequestId(
      typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : undefined,
    );
    const startedAt = process.hrtime.bigint();

    res.setHeader('X-Request-Id', requestId);
    runWithRequestContext({ requestId }, () => {
      res.on('finish', () => {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        const record: AccessLogRecord = {
          method: req.method ?? 'UNKNOWN',
          path: (req.url ?? '').split('?')[0] ?? '',
          status: res.statusCode,
          durationMs: Math.round(durationMs * 10) / 10,
          contentLength: Number(res.getHeader('content-length') ?? 0) || undefined,
        };
        log.info({ ...record, requestId }, 'http_request');
      });
      next();
    });
  };
}

export function logWithRequestId(
  log: Logger,
  level: 'info' | 'warn' | 'error',
  message: string,
  fields: Record<string, unknown> = {},
): void {
  log[level]({ ...fields, requestId: currentRequestId() }, message);
}
