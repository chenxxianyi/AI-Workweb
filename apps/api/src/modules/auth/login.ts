import { randomBytes } from 'node:crypto';
import { ApiException } from '../../common/api-exception.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { hashPassword, normalizeEmail, verifyPassword } from './password.js';
import { checkLoginLock, clearLoginFailures, recordLoginFailure } from './login-throttle.js';

/**
 * 登录校验（F09）：
 * - 账号不存在与密码错误返回同一错误码／文案，且都执行一次 Argon2 校验，避免通过耗时区分；
 * - 失败次数按账号累计（login-throttle），成功清零；
 * - 成功后写入审计；会话创建由 SessionService 负责（保持职责分离）。
 */

export interface LoginInput {
  email: string;
  password: string;
  requestId?: string;
}

export interface LoginUser {
  id: string;
  email: string;
  displayName: string;
}

let dummyHashPromise: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  // 首次失败登录时生成一次，之后复用；用于让“账号不存在”也付出同样的哈希成本
  dummyHashPromise ??= hashPassword(randomBytes(16).toString('base64url'));
  return dummyHashPromise;
}

const INVALID_MESSAGE = '账号或密码不正确';

function maskEmail(email: string): string {
  const at = email.indexOf('@');
  return at === -1 ? '***' : `***@${email.slice(at + 1)}`;
}

export async function login(db: PrismaClient, input: LoginInput): Promise<LoginUser> {
  const email = normalizeEmail(input.email);

  const lock = checkLoginLock(email);
  if (lock.locked) {
    throw new ApiException('RATE_LIMITED', '登录失败次数过多，请稍后再试', {
      details: { retryAfterSeconds: lock.retryAfterSeconds },
    });
  }

  const user = await db.user.findUnique({ where: { emailNormalized: email } });
  const presentedHash = user?.passwordHash ?? (await dummyHash());
  const passwordMatches = await verifyPassword(presentedHash, input.password);
  const active = user !== null && user.status === 'active';

  if (!active || !passwordMatches) {
    recordLoginFailure(email);
    await db.auditEvent.create({
      data: {
        actorId: user?.id ?? null,
        action: 'account.login',
        entityType: 'user',
        entityId: user?.id ?? null,
        result: 'failure',
        summary: `登录失败：${maskEmail(email)}`,
        ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      },
    });
    throw new ApiException('AUTH_INVALID_CREDENTIALS', INVALID_MESSAGE);
  }

  clearLoginFailures(email);
  await db.auditEvent.create({
    data: {
      actorId: user.id,
      action: 'account.login',
      entityType: 'user',
      entityId: user.id,
      result: 'success',
      summary: `登录成功：${maskEmail(email)}`,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    },
  });

  return { id: user.id, email: user.emailNormalized, displayName: user.displayName };
}

export interface MembershipSummary {
  workspaceId: string;
  name: string;
  timezone: string;
  role: 'owner' | 'editor' | 'viewer';
}

export async function listMemberships(
  db: PrismaClient,
  userId: string,
): Promise<MembershipSummary[]> {
  const memberships = await db.workspaceMember.findMany({
    where: { userId, status: 'active', workspace: { status: 'active' } },
    include: { workspace: { select: { id: true, name: true, timezone: true } } },
    orderBy: { joinedAt: 'asc' },
  });
  return memberships.map((member) => ({
    workspaceId: member.workspace.id,
    name: member.workspace.name,
    timezone: member.workspace.timezone,
    role: member.role,
  }));
}
