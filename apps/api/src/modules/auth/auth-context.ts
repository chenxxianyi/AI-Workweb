import { SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import { ApiException } from '../../common/api-exception.js';

/** 公开路由：不需要会话（健康检查、登录、CSRF、恢复） */
export const PUBLIC_KEY = 'aiwb:public';
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_KEY, true);

/** 豁免 CSRF 校验（仅用于持有型凭据的流程，例如一次性恢复令牌） */
export const CSRF_EXEMPT_KEY = 'aiwb:csrf-exempt';
export const CsrfExempt = (): MethodDecorator & ClassDecorator => SetMetadata(CSRF_EXEMPT_KEY, true);

export interface RequestAuth {
  sessionId: string;
  userId: string;
  csrfTokenHash: string;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

/**
 * 认证信息的请求级载体。
 * 用显式交叉类型而不是 module augmentation：@types/express 的
 * express-serve-static-core 在 pnpm 严格依赖下不一定可被应用直接引用。
 */
export type AuthedRequest = Request & { auth?: RequestAuth };

export function setRequestAuth(request: Request, auth: RequestAuth): void {
  (request as AuthedRequest).auth = auth;
}

export function requestAuth(request: Request): RequestAuth | undefined {
  return (request as AuthedRequest).auth;
}

/** 需要登录的路由使用：已由守卫保证存在，缺失说明守卫被绕过 */
export function requireRequestAuth(request: Request): RequestAuth {
  const auth = requestAuth(request);
  if (auth === undefined) throw new ApiException('UNAUTHENTICATED', '请先登录');
  return auth;
}
