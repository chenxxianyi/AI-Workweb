import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ZodPipe } from '../../common/zod.pipe.js';
import { ApiException } from '../../common/api-exception.js';
import { currentRequestId } from '../../common/request-context.js';
import { APP_CONFIG, PrismaService } from '../../common/prisma.module.js';
import type { AppConfig } from '../../common/config.js';
import { RateLimit } from '../../common/rate-limit.js';
import { changePassword, completeRecovery } from './auth-core.js';
import { listMemberships, login } from './login.js';
import { CsrfExempt, Public, requestAuth, requireRequestAuth } from './auth-context.js';
import { CSRF_COOKIE_NAME, createSessionToken } from './session.js';
import { SessionService } from './session.service.js';

const loginSchema = z.strictObject({
  email: z.string().min(3, '请输入邮箱').max(320),
  password: z.string().min(1, '请输入密码').max(128),
});

const recoverySchema = z.strictObject({
  token: z.string().min(20, '恢复令牌格式不正确').max(200),
  newPassword: z.string().min(12, '密码至少 12 个字符').max(128),
});

const passwordSchema = z.strictObject({
  currentPassword: z.string().min(1, '请输入当前密码').max(128),
  newPassword: z.string().min(12, '密码至少 12 个字符').max(128),
});

const CSRF_TTL_SECONDS = 2 * 60 * 60;

/**
 * 认证与会话接口（F08 / F09）。
 *
 * 公开：GET /auth/csrf、POST /auth/login、POST /auth/recovery/complete
 * 需登录：GET /auth/me、GET /auth/sessions、DELETE /auth/sessions/{id}、
 *         DELETE /auth/sessions、PATCH /auth/password、POST /auth/logout
 *
 * 全局守卫保证除 @Public 外都需要有效会话；写请求默认需要 CSRF（见 CsrfGuard）。
 */
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ---------------------------------------------------------------- CSRF

  /**
   * 获取 CSRF 令牌：
   * - 已登录：轮换并绑定到当前会话（数据库只存哈希）
   * - 未登录：双提交 Cookie + 同一令牌返回给前端
   */
  @Public()
  @Get('csrf')
  async csrf(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ data: { csrfToken: string; expiresAt: string } }> {
    const auth = requestAuth(request);
    if (auth !== undefined) {
      const rotated = await this.sessions.rotateCsrf(auth.sessionId);
      const maxAge = Math.max(1, Math.floor((rotated.expiresAt.getTime() - Date.now()) / 1000));
      response.setHeader('Set-Cookie', [this.sessions.csrfCookie(rotated.csrfToken, maxAge)]);
      return { data: { csrfToken: rotated.csrfToken, expiresAt: rotated.expiresAt.toISOString() } };
    }

    const token = createSessionToken().token;
    const expiresAt = new Date(Date.now() + CSRF_TTL_SECONDS * 1000);
    response.setHeader('Set-Cookie', [this.sessions.csrfCookie(token, CSRF_TTL_SECONDS)]);
    return { data: { csrfToken: token, expiresAt: expiresAt.toISOString() } };
  }

  // ---------------------------------------------------------------- 登录 / 退出

  @Public()
  @Post('login')
  @HttpCode(200)
  @RateLimit({ limit: { fromConfig: 'RATE_LIMIT_LOGIN_PER_MINUTE' }, ttlMs: 60_000 })
  async login(
    @Body(new ZodPipe(loginSchema)) body: z.infer<typeof loginSchema>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{
    data: {
      user: { id: string; email: string; displayName: string };
      memberships: Awaited<ReturnType<typeof listMemberships>>;
      csrfToken: string;
      sessionExpiresAt: string;
    };
  }> {
    const user = await login(this.prisma.db, {
      email: body.email,
      password: body.password,
      requestId: currentRequestId(),
    });

    const userAgent = request.headers['user-agent'];
    const created = await this.sessions.create(
      user.id,
      typeof userAgent === 'string' ? userAgent : undefined,
    );
    const maxAge = Math.max(1, Math.floor((created.absoluteExpiresAt.getTime() - Date.now()) / 1000));

    // 登录轮换：写入新的会话 Cookie 与会话绑定的 CSRF Cookie
    response.setHeader('Set-Cookie', [
      this.sessions.sessionCookie(created.token, maxAge),
      this.sessions.csrfCookie(created.csrfToken, maxAge),
    ]);

    const memberships = await listMemberships(this.prisma.db, user.id);
    return {
      data: {
        user,
        memberships,
        csrfToken: created.csrfToken,
        sessionExpiresAt: created.absoluteExpiresAt.toISOString(),
      },
    };
  }

  @Post('logout')
  @HttpCode(200)
  @RateLimit({ limit: 30, ttlMs: 60_000 })
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ data: { status: 'logged_out' } }> {
    const auth = requireRequestAuth(request);
    await this.sessions.revoke(auth.sessionId);
    response.setHeader('Set-Cookie', [
      this.sessions.clearSessionCookie(),
      this.sessions.clearCsrfCookie(),
    ]);
    return { data: { status: 'logged_out' } };
  }

  // ---------------------------------------------------------------- 会话与账号

  @Get('me')
  async me(
    @Req() request: Request,
  ): Promise<{
    data: {
      user: { id: string; email: string; displayName: string };
      memberships: Awaited<ReturnType<typeof listMemberships>>;
      preferences: { theme: string };
    };
  }> {
    const auth = requireRequestAuth(request);
    const user = await this.prisma.db.user.findUnique({
      where: { id: auth.userId },
      select: { id: true, emailNormalized: true, displayName: true },
    });
    if (user === null) throw new ApiException('UNAUTHENTICATED', '登录状态无效，请重新登录');

    const [memberships, preferences] = await Promise.all([
      listMemberships(this.prisma.db, user.id),
      this.prisma.db.userPreference.findUnique({ where: { userId: user.id } }),
    ]);

    return {
      data: {
        user: { id: user.id, email: user.emailNormalized, displayName: user.displayName },
        memberships,
        preferences: { theme: preferences?.theme ?? 'system' },
      },
    };
  }

  @Get('sessions')
  async listSessions(
    @Req() request: Request,
  ): Promise<{
    data: {
      sessions: {
        id: string;
        current: boolean;
        userAgent: string | null;
        createdAt: string;
        lastSeenAt: string;
        idleExpiresAt: string;
        absoluteExpiresAt: string;
      }[];
    };
  }> {
    const auth = requireRequestAuth(request);
    const sessions = await this.sessions.listForUser(auth.userId, auth.sessionId);
    return {
      data: {
        sessions: sessions.map((session) => ({
          id: session.id,
          current: session.current,
          userAgent: session.userAgent,
          createdAt: session.createdAt.toISOString(),
          lastSeenAt: session.lastSeenAt.toISOString(),
          idleExpiresAt: session.idleExpiresAt.toISOString(),
          absoluteExpiresAt: session.absoluteExpiresAt.toISOString(),
        })),
      },
    };
  }

  /** 吊销全部其他会话（保留当前设备） */
  @Delete('sessions')
  @RateLimit({ limit: 10, ttlMs: 60_000 })
  async revokeOtherSessions(
    @Req() request: Request,
  ): Promise<{ data: { revokedSessions: number } }> {
    const auth = requireRequestAuth(request);
    const revoked = await this.sessions.revokeAll(auth.userId, auth.sessionId);
    return { data: { revokedSessions: revoked } };
  }

  /** 吊销自己的某个会话；不属于当前用户时返回 404（避免探测） */
  @Delete('sessions/:id')
  @HttpCode(200)
  @RateLimit({ limit: 20, ttlMs: 60_000 })
  async revokeSession(
    @Req() request: Request,
    @Param('id') sessionId: string,
  ): Promise<{ data: { status: 'revoked'; current: boolean } }> {
    const auth = requireRequestAuth(request);
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
      throw new ApiException('NOT_FOUND', '会话不存在');
    }
    const result = await this.prisma.db.session.updateMany({
      where: { id: sessionId, userId: auth.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) throw new ApiException('NOT_FOUND', '会话不存在');

    return { data: { status: 'revoked', current: sessionId === auth.sessionId } };
  }

  @Patch('password')
  @RateLimit({ limit: 10, ttlMs: 60_000 })
  async changePassword(
    @Req() request: Request,
    @Body(new ZodPipe(passwordSchema)) body: z.infer<typeof passwordSchema>,
  ): Promise<{ data: { status: 'password_changed'; revokedSessions: number } }> {
    const auth = requireRequestAuth(request);
    const result = await changePassword(this.prisma.db, {
      userId: auth.userId,
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
      keepSessionId: auth.sessionId,
      requestId: currentRequestId(),
    });
    return { data: { status: 'password_changed', revokedSessions: result.revokedSessions } };
  }

  // ---------------------------------------------------------------- 恢复（持有型凭据，豁免 CSRF）

  @Public()
  @CsrfExempt()
  @Post('recovery/complete')
  @HttpCode(200)
  @RateLimit({ limit: 5, ttlMs: 60_000 })
  async completeRecovery(
    @Body(new ZodPipe(recoverySchema)) body: z.infer<typeof recoverySchema>,
  ): Promise<{ data: { status: 'password_reset' } }> {
    await completeRecovery(this.prisma.db, {
      token: body.token,
      newPassword: body.newPassword,
      requestId: currentRequestId(),
    });
    return { data: { status: 'password_reset' } };
  }

  /** 供前端读取 Cookie 名称，避免硬编码 */
  @Public()
  @Get('csrf-cookie-name')
  csrfCookieName(): { data: { name: string; sessionCookieName: string } } {
    return {
      data: { name: CSRF_COOKIE_NAME, sessionCookieName: this.config.SESSION_COOKIE_NAME },
    };
  }
}
