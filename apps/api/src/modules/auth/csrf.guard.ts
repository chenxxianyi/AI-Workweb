import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { ApiException } from '../../common/api-exception.js';
import { APP_CONFIG } from '../../common/prisma.module.js';
import type { AppConfig } from '../../common/config.js';
import { CSRF_EXEMPT_KEY, requestAuth } from './auth-context.js';
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  parseCookies,
  safeEqualString,
  sha256Hex,
} from './session.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF 守卫（F09）。
 *
 * 两条路径：
 * 1. 已登录：校验 `X-CSRF-Token` 的 SHA-256 等于会话里的 csrf_token_hash；
 * 2. 未登录（登录等公开写接口）：双提交——请求头必须等于 `sfs_csrf` Cookie 的值。
 *
 * 两条路径都额外校验 Origin／Referer：只要请求带了来源，就必须与 PUBLIC_ORIGIN 同源。
 * 持有型凭据（一次性恢复令牌）用 @CsrfExempt() 豁免，并在文档中说明原因。
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const method = (request.method ?? 'GET').toUpperCase();
    if (SAFE_METHODS.has(method)) return true;
    if (Reflect.getMetadata(CSRF_EXEMPT_KEY, context.getHandler()) === true) return true;
    if (Reflect.getMetadata(CSRF_EXEMPT_KEY, context.getClass()) === true) return true;

    this.assertSameOrigin(request);

    const presented = this.headerValue(request.headers[CSRF_HEADER_NAME]);
    if (presented === undefined || presented === '') {
      throw new ApiException('CSRF_INVALID', '缺少 CSRF 令牌，请刷新页面后重试');
    }

    const auth = requestAuth(request);
    if (auth !== undefined) {
      if (!safeEqualString(sha256Hex(presented), auth.csrfTokenHash)) {
        throw new ApiException('CSRF_INVALID', 'CSRF 令牌无效，请刷新页面后重试');
      }
      return true;
    }

    const cookies = parseCookies(request.headers.cookie);
    const cookieToken = cookies[CSRF_COOKIE_NAME];
    if (cookieToken === undefined || cookieToken === '') {
      throw new ApiException('CSRF_INVALID', '缺少 CSRF Cookie，请刷新页面后重试');
    }
    if (!safeEqualString(sha256Hex(presented), sha256Hex(cookieToken))) {
      throw new ApiException('CSRF_INVALID', 'CSRF 令牌无效，请刷新页面后重试');
    }
    return true;
  }

  private assertSameOrigin(request: Request): void {
    const origin = this.headerValue(request.headers.origin);
    const referer = this.headerValue(request.headers.referer);
    const expected = this.config.PUBLIC_ORIGIN.replace(/\/$/, '');

    if (origin !== undefined) {
      if (origin.replace(/\/$/, '') !== expected) {
        throw new ApiException('CSRF_INVALID', '请求来源不被允许');
      }
      return;
    }
    if (referer !== undefined) {
      let refererOrigin: string;
      try {
        refererOrigin = new URL(referer).origin;
      } catch {
        throw new ApiException('CSRF_INVALID', '请求来源不被允许');
      }
      if (refererOrigin !== expected) {
        throw new ApiException('CSRF_INVALID', '请求来源不被允许');
      }
      return;
    }
    // 没有任何来源头：非浏览器客户端（curl／测试）；凭据仍受 CSRF 令牌保护
  }

  private headerValue(value: string | string[] | undefined): string | undefined {
    if (value === undefined) return undefined;
    return Array.isArray(value) ? value[0] : value;
  }
}
