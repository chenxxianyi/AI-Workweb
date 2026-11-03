import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { ApiException } from '../../common/api-exception.js';
import { APP_CONFIG } from '../../common/prisma.module.js';
import type { AppConfig } from '../../common/config.js';
import { PUBLIC_KEY, setRequestAuth, type RequestAuth } from './auth-context.js';
import { SessionService } from './session.service.js';
import { parseCookies } from './session.js';

/**
 * 会话守卫（F09）：默认所有路由都需要登录，用 @Public() 显式开放。
 *
 * - 从 HttpOnly Cookie 读取不透明令牌 → 查库校验（哈希比对、吊销、空闲/绝对过期）
 * - 校验通过后挂到 request.auth，并做滑动续期（60 秒节流）
 * - 过期与未登录区分：过期返回 SESSION_EXPIRED，无会话返回 UNAUTHENTICATED
 * - 公开路由即使带着失效 Cookie 也放行（登录页仍可获取新的 CSRF 令牌）
 */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const handler = context.getHandler();
    const controller = context.getClass();
    const isPublic =
      Reflect.getMetadata(PUBLIC_KEY, handler) === true ||
      Reflect.getMetadata(PUBLIC_KEY, controller) === true;

    const cookies = parseCookies(request.headers.cookie);
    const rawToken = cookies[this.config.SESSION_COOKIE_NAME];

    if (rawToken === undefined || rawToken === '') {
      if (isPublic) return true;
      throw new ApiException('UNAUTHENTICATED', '请先登录');
    }

    const resolved = await this.sessions.resolve(rawToken);
    if (!resolved.ok) {
      if (isPublic) return true;
      if (resolved.reason === 'IDLE_EXPIRED' || resolved.reason === 'ABSOLUTE_EXPIRED') {
        throw new ApiException('SESSION_EXPIRED', '登录已过期，请重新登录');
      }
      throw new ApiException('UNAUTHENTICATED', '登录状态无效，请重新登录');
    }

    const touched = await this.sessions.touch(resolved.session);
    const auth: RequestAuth = {
      sessionId: touched.id,
      userId: touched.userId,
      csrfTokenHash: touched.csrfTokenHash,
      idleExpiresAt: touched.idleExpiresAt,
      absoluteExpiresAt: touched.absoluteExpiresAt,
    };
    setRequestAuth(request, auth);
    return true;
  }
}
