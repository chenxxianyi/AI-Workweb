import { ApiException } from '../../common/api-exception.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import {
  createOpaqueToken,
  emailLocalPart,
  hashPassword,
  hashOpaqueToken,
  normalizeEmail,
  validatePasswordPolicy,
  verifyPassword,
} from './password.js';

/**
 * 认证核心（F08）：不依赖 Nest，HTTP 层与 CLI 共用同一实现。
 * 这样 bootstrap／恢复命令与接口走同一段业务与事务逻辑，避免“命令能用、接口不生效”。
 */

export interface BootstrapInput {
  email: string;
  displayName: string;
  password: string;
  workspaceName?: string;
  timezone?: string;
}

export type BootstrapResult =
  | { created: true; userId: string; workspaceId: string }
  | {
      created: false;
      reason: 'USER_EXISTS' | 'OTHER_USERS_EXIST';
      userId?: string;
      workspaceId?: string;
    };

const DEFAULT_WORKSPACE_NAME = '个人工作台';
const RECOVERY_TTL_MINUTES = 30;

function assertPasswordPolicy(password: string, email: string, field: string): void {
  const violations = validatePasswordPolicy(password, emailLocalPart(email));
  if (violations.length > 0) {
    throw new ApiException('VALIDATION_FAILED', '密码不符合要求', {
      fieldErrors: { [field]: violations.map((item) => item.message) },
    });
  }
}

/** 供审计与排查使用：只保留域名，不写完整邮箱 */
function maskEmail(email: string): string {
  const normalized = normalizeEmail(email);
  const at = normalized.indexOf('@');
  if (at === -1) return '***';
  return `***@${normalized.slice(at + 1)}`;
}

export async function bootstrapOwner(
  db: PrismaClient,
  input: BootstrapInput,
): Promise<BootstrapResult> {
  const email = normalizeEmail(input.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new ApiException('VALIDATION_FAILED', '邮箱格式不正确', {
      fieldErrors: { email: ['邮箱格式不正确'] },
    });
  }
  if (input.displayName.trim().length === 0) {
    throw new ApiException('VALIDATION_FAILED', '显示名称不能为空', {
      fieldErrors: { displayName: ['不能为空'] },
    });
  }
  assertPasswordPolicy(input.password, email, 'password');

  return db.$transaction(async (tx) => {
    const client = tx as unknown as PrismaClient;

    const existing = await client.user.findUnique({ where: { emailNormalized: email } });
    if (existing !== null) {
      const membership = await client.workspaceMember.findFirst({
        where: { userId: existing.id },
        orderBy: { joinedAt: 'asc' },
      });
      return {
        created: false,
        reason: 'USER_EXISTS',
        userId: existing.id,
        ...(membership === null ? {} : { workspaceId: membership.workspaceId }),
      };
    }

    const userCount = await client.user.count();
    if (userCount > 0) {
      // 不是首个账号：不在公开路径上自动创建第二个 Owner
      return { created: false, reason: 'OTHER_USERS_EXIST' };
    }

    const passwordHash = await hashPassword(input.password);
    const user = await client.user.create({
      data: {
        emailNormalized: email,
        displayName: input.displayName.trim(),
        passwordHash,
        passwordChangedAt: new Date(),
      },
    });
    const workspace = await client.workspace.create({
      data: {
        name: input.workspaceName?.trim() || DEFAULT_WORKSPACE_NAME,
        timezone: input.timezone ?? 'Asia/Shanghai',
        createdBy: user.id,
      },
    });
    await client.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: user.id, role: 'owner' },
    });
    await client.auditEvent.create({
      data: {
        workspaceId: workspace.id,
        actorId: user.id,
        action: 'account.bootstrap',
        entityType: 'user',
        entityId: user.id,
        result: 'success',
        summary: `初始化 Owner：${maskEmail(email)}`,
      },
    });

    return { created: true, userId: user.id, workspaceId: workspace.id };
  });
}

async function revokeSessions(
  client: PrismaClient,
  userId: string,
  keepSessionId?: string,
): Promise<number> {
  const result = await client.session.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(keepSessionId === undefined ? {} : { id: { not: keepSessionId } }),
    },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

export interface ChangePasswordInput {
  userId: string;
  currentPassword: string;
  newPassword: string;
  workspaceId?: string;
  keepSessionId?: string;
  requestId?: string;
}

export async function changePassword(
  db: PrismaClient,
  input: ChangePasswordInput,
): Promise<{ revokedSessions: number }> {
  const user = await db.user.findUnique({ where: { id: input.userId } });
  if (user === null || user.status !== 'active') {
    throw new ApiException('UNAUTHENTICATED', '登录状态无效，请重新登录');
  }

  const matches = await verifyPassword(user.passwordHash, input.currentPassword);
  if (!matches) {
    await db.auditEvent.create({
      data: {
        workspaceId: input.workspaceId ?? null,
        actorId: user.id,
        action: 'account.password_change',
        entityType: 'user',
        entityId: user.id,
        result: 'failure',
        summary: '当前密码校验失败',
        ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      },
    });
    throw new ApiException('AUTH_INVALID_CREDENTIALS', '当前密码不正确');
  }

  assertPasswordPolicy(input.newPassword, user.emailNormalized, 'newPassword');
  if (input.newPassword === input.currentPassword) {
    throw new ApiException('VALIDATION_FAILED', '新密码不能与当前密码相同', {
      fieldErrors: { newPassword: ['新密码不能与当前密码相同'] },
    });
  }

  const nextHash = await hashPassword(input.newPassword);
  return db.$transaction(async (tx) => {
    const client = tx as unknown as PrismaClient;
    await client.user.update({
      where: { id: user.id },
      data: { passwordHash: nextHash, passwordChangedAt: new Date() },
    });
    const revoked = await revokeSessions(client, user.id, input.keepSessionId);
    await client.auditEvent.create({
      data: {
        workspaceId: input.workspaceId ?? null,
        actorId: user.id,
        action: 'account.password_change',
        entityType: 'user',
        entityId: user.id,
        result: 'success',
        summary: `修改密码，吊销会话 ${revoked} 个`,
        ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      },
    });
    return { revokedSessions: revoked };
  });
}

export interface IssuedRecoveryToken {
  token: string;
  expiresAt: Date;
  userId: string;
}

/**
 * 签发恢复令牌（仅 CLI 调用，不是 HTTP 接口）。
 * 只返回一次明文；数据库存 SHA-256，禁止写入日志。
 */
export async function issueRecoveryToken(
  db: PrismaClient,
  input: { email: string; ttlMinutes?: number },
): Promise<IssuedRecoveryToken | null> {
  const email = normalizeEmail(input.email);
  const user = await db.user.findUnique({ where: { emailNormalized: email } });
  if (user === null || user.status !== 'active') return null;

  const { token, tokenHash } = createOpaqueToken();
  const ttlMinutes = input.ttlMinutes ?? RECOVERY_TTL_MINUTES;
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);

  await db.$transaction(async (tx) => {
    const client = tx as unknown as PrismaClient;
    // 同一用户旧令牌作废，避免多张有效链接
    await client.accountRecoveryToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    await client.accountRecoveryToken.create({
      data: { userId: user.id, tokenHash, expiresAt, createdBy: user.id },
    });
    await client.auditEvent.create({
      data: {
        actorId: user.id,
        action: 'account.recovery_issued',
        entityType: 'user',
        entityId: user.id,
        result: 'success',
        summary: `签发恢复令牌（${ttlMinutes} 分钟，一次性）`,
      },
    });
  });

  return { token, expiresAt, userId: user.id };
}

export interface CompleteRecoveryInput {
  token: string;
  newPassword: string;
  requestId?: string;
}

/** 消费恢复令牌并设置新密码；令牌一次性，成功后吊销全部会话 */
export async function completeRecovery(
  db: PrismaClient,
  input: CompleteRecoveryInput,
): Promise<{ userId: string; revokedSessions: number }> {
  if (typeof input.token !== 'string' || input.token.length < 20) {
    throw new ApiException('AUTH_INVALID_CREDENTIALS', '恢复令牌无效或已过期');
  }
  const tokenHash = hashOpaqueToken(input.token);

  return db.$transaction(async (tx) => {
    const client = tx as unknown as PrismaClient;
    const record = await client.accountRecoveryToken.findFirst({
      where: { tokenHash, usedAt: null, expiresAt: { gt: new Date() } },
    });
    if (record === null) {
      throw new ApiException('AUTH_INVALID_CREDENTIALS', '恢复令牌无效或已过期');
    }

    const user = await client.user.findUnique({ where: { id: record.userId } });
    if (user === null || user.status !== 'active') {
      throw new ApiException('AUTH_INVALID_CREDENTIALS', '恢复令牌无效或已过期');
    }

    assertPasswordPolicy(input.newPassword, user.emailNormalized, 'newPassword');
    const nextHash = await hashPassword(input.newPassword);

    // 条件更新：并发消费同一令牌时只有一次成功
    const consumed = await client.accountRecoveryToken.updateMany({
      where: { id: record.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (consumed.count !== 1) {
      throw new ApiException('AUTH_INVALID_CREDENTIALS', '恢复令牌无效或已过期');
    }

    await client.user.update({
      where: { id: user.id },
      data: { passwordHash: nextHash, passwordChangedAt: new Date() },
    });
    const revoked = await revokeSessions(client, user.id);
    await client.auditEvent.create({
      data: {
        actorId: user.id,
        action: 'account.recovery_completed',
        entityType: 'user',
        entityId: user.id,
        result: 'success',
        summary: `恢复密码，吊销会话 ${revoked} 个`,
        ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      },
    });

    return { userId: user.id, revokedSessions: revoked };
  });
}
