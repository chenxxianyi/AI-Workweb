import { Inject, Injectable } from '@nestjs/common';
import { ApiException } from '../../common/api-exception.js';
import { PrismaService } from '../../common/prisma.module.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import {
  emailLocalPart,
  hashOpaqueToken,
  hashPassword,
  normalizeEmail,
  validatePasswordPolicy,
} from '../auth/password.js';
import { createOpaqueToken } from '../auth/password.js';
import type { WorkspaceRole } from './permissions.js';

const INVITE_TTL_HOURS = 48;

export interface CreatedInvite {
  inviteId: string;
  /** 明文令牌只返回一次；列表接口不再暴露 */
  token: string;
  expiresAt: string;
  email: string;
  role: WorkspaceRole;
}

/**
 * 邀请（F10）。
 *
 * - 令牌 32 字节随机、只存 SHA-256、默认 48 小时、一次性；
 * - 无邮件服务：明文链接只返回一次，由 Owner 手工传递；
 * - 已有账号：只建立成员关系，不重设密码；新账号：必须设置符合策略的密码；
 * - 同一空间对同一邮箱重复邀请会作废旧令牌。
 */
@Injectable()
export class InviteService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private get db(): PrismaClient {
    return this.prisma.db;
  }

  async create(
    workspaceId: string,
    actorUserId: string,
    input: { email: string; role: WorkspaceRole },
  ): Promise<CreatedInvite> {
    if (input.role === 'owner') {
      // 直接邀请 Owner 容易造成权限失配；Owner 转移应走显式接口（后续任务）
      throw new ApiException(
        'VALIDATION_FAILED',
        '邀请不能直接授予 Owner，请先邀请后再转移所有权',
        {
          fieldErrors: { role: ['不能直接邀请 Owner'] },
        },
      );
    }
    const email = normalizeEmail(input.email);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new ApiException('VALIDATION_FAILED', '邮箱格式不正确', {
        fieldErrors: { email: ['邮箱格式不正确'] },
      });
    }

    return this.db.$transaction(async (tx) => {
      const client = tx as unknown as PrismaClient;
      const existingUser = await client.user.findUnique({ where: { emailNormalized: email } });
      if (existingUser !== null) {
        const membership = await client.workspaceMember.findUnique({
          where: { workspaceId_userId: { workspaceId, userId: existingUser.id } },
        });
        if (membership !== null && membership.status === 'active') {
          throw new ApiException('CONFLICT', '该用户已是空间成员');
        }
      }

      // 作废同邮箱的旧邀请
      await client.workspaceInvite.updateMany({
        where: { workspaceId, emailNormalized: email, acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      const { token, tokenHash } = createOpaqueToken();
      const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 3_600_000);
      const invite = await client.workspaceInvite.create({
        data: {
          workspaceId,
          emailNormalized: email,
          role: input.role,
          tokenHash,
          expiresAt,
          invitedBy: actorUserId,
        },
      });
      await client.auditEvent.create({
        data: {
          workspaceId,
          actorId: actorUserId,
          action: 'workspace.invite_created',
          entityType: 'invite',
          entityId: invite.id,
          result: 'success',
          summary: `邀请 ${input.role}：${email.replace(/^[^@]+/, '***')}`,
        },
      });

      return {
        inviteId: invite.id,
        token,
        expiresAt: expiresAt.toISOString(),
        email,
        role: input.role,
      };
    });
  }

  async list(workspaceId: string): Promise<
    {
      id: string;
      email: string;
      role: WorkspaceRole;
      expiresAt: string;
      createdAt: string;
      expired: boolean;
    }[]
  > {
    const invites = await this.db.workspaceInvite.findMany({
      where: { workspaceId, acceptedAt: null, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return invites.map((invite) => ({
      id: invite.id,
      email: invite.emailNormalized,
      role: invite.role,
      expiresAt: invite.expiresAt.toISOString(),
      createdAt: invite.createdAt.toISOString(),
      expired: invite.expiresAt.getTime() <= Date.now(),
    }));
  }

  async revoke(workspaceId: string, actorUserId: string, inviteId: string): Promise<void> {
    const result = await this.db.workspaceInvite.updateMany({
      where: { id: inviteId, workspaceId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) throw new ApiException('NOT_FOUND', '邀请不存在或已失效');
    await this.db.auditEvent.create({
      data: {
        workspaceId,
        actorId: actorUserId,
        action: 'workspace.invite_revoked',
        entityType: 'invite',
        entityId: inviteId,
        result: 'success',
        summary: '撤销邀请',
      },
    });
  }

  /**
   * 接受邀请（公开接口，靠令牌持有证明）。
   * - 已有账号：只加入空间，不改密码；
   * - 新账号：必须设置符合策略的密码并创建账号。
   */
  async accept(
    token: string,
    input: { password?: string; displayName?: string },
  ): Promise<{ workspaceId: string; role: WorkspaceRole; createdUser: boolean; userId: string }> {
    if (typeof token !== 'string' || token.length < 20) {
      throw new ApiException('NOT_FOUND', '邀请链接无效或已过期');
    }
    const tokenHash = hashOpaqueToken(token);

    return this.db.$transaction(async (tx) => {
      const client = tx as unknown as PrismaClient;
      const invite = await client.workspaceInvite.findFirst({
        where: { tokenHash, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      });
      if (invite === null) throw new ApiException('NOT_FOUND', '邀请链接无效或已过期');

      const existingUser = await client.user.findUnique({
        where: { emailNormalized: invite.emailNormalized },
      });

      let userId: string;
      let createdUser = false;

      if (existingUser !== null) {
        userId = existingUser.id;
        const membership = await client.workspaceMember.findUnique({
          where: { workspaceId_userId: { workspaceId: invite.workspaceId, userId } },
        });
        if (membership !== null && membership.status === 'active') {
          throw new ApiException('CONFLICT', '你已经是该空间成员');
        }
        if (membership === null) {
          await client.workspaceMember.create({
            data: { workspaceId: invite.workspaceId, userId, role: invite.role },
          });
        } else {
          await client.workspaceMember.update({
            where: { workspaceId_userId: { workspaceId: invite.workspaceId, userId } },
            data: { role: invite.role, status: 'active', version: { increment: 1 } },
          });
        }
      } else {
        if (input.password === undefined) {
          throw new ApiException('VALIDATION_FAILED', '首次加入需要设置密码', {
            fieldErrors: { password: ['首次加入需要设置密码'] },
          });
        }
        const violations = validatePasswordPolicy(
          input.password,
          emailLocalPart(invite.emailNormalized),
        );
        if (violations.length > 0) {
          throw new ApiException('VALIDATION_FAILED', '密码不符合要求', {
            fieldErrors: { password: violations.map((item) => item.message) },
          });
        }
        const user = await client.user.create({
          data: {
            emailNormalized: invite.emailNormalized,
            displayName:
              input.displayName?.trim() || invite.emailNormalized.split('@')[0] || '成员',
            passwordHash: await hashPassword(input.password),
            passwordChangedAt: new Date(),
          },
        });
        userId = user.id;
        createdUser = true;
        await client.workspaceMember.create({
          data: { workspaceId: invite.workspaceId, userId, role: invite.role },
        });
      }

      const consumed = await client.workspaceInvite.updateMany({
        where: { id: invite.id, acceptedAt: null },
        data: { acceptedAt: new Date() },
      });
      if (consumed.count !== 1) throw new ApiException('NOT_FOUND', '邀请链接无效或已过期');

      await client.auditEvent.create({
        data: {
          workspaceId: invite.workspaceId,
          actorId: userId,
          action: 'workspace.invite_accepted',
          entityType: 'invite',
          entityId: invite.id,
          result: 'success',
          summary: createdUser ? '新账号接受邀请' : '已有账号接受邀请',
        },
      });

      return {
        workspaceId: invite.workspaceId,
        role: invite.role,
        createdUser,
        userId,
      };
    });
  }
}
