import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../common/prisma.module.js';
import { PrismaService } from '../../common/prisma.module.js';
import type { AppConfig } from '../../common/config.js';
import {
  CSRF_COOKIE_NAME,
  createSessionToken,
  safeEqualString,
  serializeClearedCookie,
  serializeCookie,
  sha256Hex,
} from './session.js';

export interface SessionRecord {
  id: string;
  userId: string;
  csrfTokenHash: string;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  lastSeenAt: Date;
}

export type ResolveFailure = 'NOT_FOUND' | 'REVOKED' | 'IDLE_EXPIRED' | 'ABSOLUTE_EXPIRED';

export type ResolveResult =
  | { ok: true; session: SessionRecord; user: { id: string; email: string; displayName: string; status: string } }
  | { ok: false; reason: ResolveFailure };

/**
 * 会话服务（F09）：创建、解析、滑动续期、CSRF 轮换、吊销、列表。
 * 所有查询都以会话 id／令牌哈希为键，不信任客户端传入的 userId。
 */
@Injectable()
export class SessionService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  get sessionCookieName(): string {
    return this.config.SESSION_COOKIE_NAME;
  }

  private idleMs(): number {
    return this.config.SESSION_IDLE_MINUTES * 60_000;
  }

  private absoluteMs(): number {
    return this.config.SESSION_ABSOLUTE_DAYS * 24 * 60 * 60_000;
  }

  /** 登录成功：新建会话（旧会话保留，支持多设备），同时生成绑定的 CSRF 令牌 */
  async create(
    userId: string,
    userAgent?: string,
  ): Promise<{ sessionId: string; token: string; csrfToken: string; absoluteExpiresAt: Date }> {
    const { token, tokenHash } = createSessionToken();
    const csrfToken = createSessionToken().token;
    const now = Date.now();
    const absoluteExpiresAt = new Date(now + this.absoluteMs());
    const session = await this.prisma.db.session.create({
      data: {
        userId,
        tokenHash,
        csrfTokenHash: sha256Hex(csrfToken),
        idleExpiresAt: new Date(now + this.idleMs()),
        absoluteExpiresAt,
        ...(userAgent === undefined ? {} : { userAgent: userAgent.slice(0, 300) }),
      },
      select: { id: true },
    });
    return { sessionId: session.id, token, csrfToken, absoluteExpiresAt };
  }

  /** 解析会话：区分“不存在／吊销／空闲过期／绝对过期”，供不同错误码使用 */
  async resolve(rawToken: string): Promise<ResolveResult> {
    const tokenHash = sha256Hex(rawToken);
    const session = await this.prisma.db.session.findUnique({
      where: { tokenHash },
      include: { user: { select: { id: true, emailNormalized: true, displayName: true, status: true } } },
    });
    if (session === null) return { ok: false, reason: 'NOT_FOUND' };
    if (session.revokedAt !== null) return { ok: false, reason: 'REVOKED' };

    const now = Date.now();
    if (session.absoluteExpiresAt.getTime() <= now) return { ok: false, reason: 'ABSOLUTE_EXPIRED' };
    if (session.idleExpiresAt.getTime() <= now) return { ok: false, reason: 'IDLE_EXPIRED' };
    if (session.user.status !== 'active') return { ok: false, reason: 'REVOKED' };

    return {
      ok: true,
      session: {
        id: session.id,
        userId: session.userId,
        csrfTokenHash: session.csrfTokenHash,
        idleExpiresAt: session.idleExpiresAt,
        absoluteExpiresAt: session.absoluteExpiresAt,
        lastSeenAt: session.lastSeenAt,
      },
      user: {
        id: session.user.id,
        email: session.user.emailNormalized,
        displayName: session.user.displayName,
        status: session.user.status,
      },
    };
  }

  /**
   * 滑动续期：距上次活跃超过 60 秒才写库，避免每个请求都产生 UPDATE。
   * 空闲过期时间不会超过绝对过期时间。
   */
  async touch(session: SessionRecord): Promise<SessionRecord> {
    const now = Date.now();
    if (now - session.lastSeenAt.getTime() < 60_000) return session;
    const nextIdle = Math.min(now + this.idleMs(), session.absoluteExpiresAt.getTime());
    await this.prisma.db.session.update({
      where: { id: session.id },
      data: { lastSeenAt: new Date(now), idleExpiresAt: new Date(nextIdle) },
    });
    return { ...session, lastSeenAt: new Date(now), idleExpiresAt: new Date(nextIdle) };
  }

  /** 轮换 CSRF 令牌：登录后与 GET /auth/csrf 时调用 */
  async rotateCsrf(sessionId: string): Promise<{ csrfToken: string; expiresAt: Date }> {
    const csrfToken = createSessionToken().token;
    const updated = await this.prisma.db.session.update({
      where: { id: sessionId },
      data: { csrfTokenHash: sha256Hex(csrfToken) },
      select: { absoluteExpiresAt: true },
    });
    return { csrfToken, expiresAt: updated.absoluteExpiresAt };
  }

  async verifyCsrf(session: SessionRecord, presented: string | undefined): Promise<boolean> {
    if (presented === undefined || presented === '') return false;
    return safeEqualString(sha256Hex(presented), session.csrfTokenHash);
  }

  async revoke(sessionId: string): Promise<void> {
    await this.prisma.db.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAll(userId: string, exceptSessionId?: string): Promise<number> {
    const result = await this.prisma.db.session.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptSessionId === undefined ? {} : { id: { not: exceptSessionId } }),
      },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  async listForUser(
    userId: string,
    currentSessionId: string,
  ): Promise<
    {
      id: string;
      current: boolean;
      userAgent: string | null;
      createdAt: Date;
      lastSeenAt: Date;
      idleExpiresAt: Date;
      absoluteExpiresAt: Date;
    }[]
  > {
    const sessions = await this.prisma.db.session.findMany({
      where: { userId, revokedAt: null, absoluteExpiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: 'desc' },
      select: {
        id: true,
        userAgent: true,
        createdAt: true,
        lastSeenAt: true,
        idleExpiresAt: true,
        absoluteExpiresAt: true,
      },
    });
    return sessions.map((session) => ({ ...session, current: session.id === currentSessionId }));
  }

  /** 会话 Cookie（HttpOnly；生产 HTTPS 下加 Secure） */
  sessionCookie(token: string, maxAgeSeconds: number): string {
    return serializeCookie(this.sessionCookieName, token, {
      httpOnly: true,
      secure: this.config.COOKIE_SECURE,
      sameSite: 'Lax',
      maxAgeSeconds,
    });
  }

  clearSessionCookie(): string {
    return serializeClearedCookie(this.sessionCookieName, {
      httpOnly: true,
      secure: this.config.COOKIE_SECURE,
      sameSite: 'Lax',
    });
  }

  /** CSRF Cookie：必须可被前端 JS 读取，才能放进 X-CSRF-Token 头 */
  csrfCookie(token: string, maxAgeSeconds: number): string {
    return serializeCookie(CSRF_COOKIE_NAME, token, {
      httpOnly: false,
      secure: this.config.COOKIE_SECURE,
      sameSite: 'Lax',
      maxAgeSeconds,
    });
  }

  clearCsrfCookie(): string {
    return serializeClearedCookie(CSRF_COOKIE_NAME, {
      httpOnly: false,
      secure: this.config.COOKIE_SECURE,
      sameSite: 'Lax',
    });
  }
}
