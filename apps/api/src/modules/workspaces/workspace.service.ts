import { Inject, Injectable } from '@nestjs/common';
import { ApiException } from '../../common/api-exception.js';
import { PrismaService } from '../../common/prisma.module.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { parseEtag } from '@aiwb/contracts';
import type { WorkspaceRole } from './permissions.js';

export interface WorkspaceSummary {
  id: string;
  name: string;
  timezone: string;
  role: WorkspaceRole;
  version: number;
  memberVersion: number;
}

export interface MemberSummary {
  userId: string;
  displayName: string;
  email: string;
  role: WorkspaceRole;
  status: string;
  joinedAt: string;
  version: number;
  isLastOwner: boolean;
}

function requireIfMatch(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === '') {
    throw new ApiException('PRECONDITION_REQUIRED', '缺少 If-Match，请携带当前版本号');
  }
  const version = parseEtag(raw);
  if (version === null) {
    throw new ApiException('PRECONDITION_REQUIRED', 'If-Match 格式不正确，请携带当前版本号');
  }
  return version;
}

/**
 * 空间与成员（F10）。
 *
 * - 所有查询都以 workspaceId + 会话用户为起点；不信任客户端传入的角色或 userId；
 * - 角色变更与移除在事务内 `FOR UPDATE` 锁住成员集合，防止并发移除最后一位 Owner；
 * - 移除成员会吊销其会话（下一次请求即失效）。
 */
@Injectable()
export class WorkspaceService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private get db(): PrismaClient {
    return this.prisma.db;
  }

  async listForUser(userId: string): Promise<WorkspaceSummary[]> {
    const memberships = await this.db.workspaceMember.findMany({
      where: { userId, status: 'active', workspace: { status: 'active' } },
      include: { workspace: { select: { id: true, name: true, timezone: true, version: true } } },
      orderBy: { joinedAt: 'asc' },
    });
    return memberships.map((member) => ({
      id: member.workspace.id,
      name: member.workspace.name,
      timezone: member.workspace.timezone,
      role: member.role,
      version: member.workspace.version,
      memberVersion: member.version,
    }));
  }

  async create(
    userId: string,
    input: { name: string; timezone?: string },
  ): Promise<{ id: string; name: string; timezone: string; version: number }> {
    const name = input.name.trim();
    if (name.length === 0 || name.length > 100) {
      throw new ApiException('VALIDATION_FAILED', '空间名称需为 1～100 个字符', {
        fieldErrors: { name: ['需为 1～100 个字符'] },
      });
    }
    const timezone = input.timezone ?? 'Asia/Shanghai';
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
    } catch {
      throw new ApiException('VALIDATION_FAILED', '时区不是合法的 IANA 名称', {
        fieldErrors: { timezone: ['不是合法的 IANA 时区'] },
      });
    }

    return this.db.$transaction(async (tx) => {
      const client = tx as unknown as PrismaClient;
      const workspace = await client.workspace.create({
        data: { name, timezone, createdBy: userId },
      });
      await client.workspaceMember.create({
        data: { workspaceId: workspace.id, userId, role: 'owner' },
      });
      await client.auditEvent.create({
        data: {
          workspaceId: workspace.id,
          actorId: userId,
          action: 'workspace.created',
          entityType: 'workspace',
          entityId: workspace.id,
          result: 'success',
          summary: `创建空间：${name}`,
        },
      });
      return {
        id: workspace.id,
        name: workspace.name,
        timezone: workspace.timezone,
        version: workspace.version,
      };
    });
  }

  async update(
    workspaceId: string,
    actorUserId: string,
    ifMatch: string | string[] | undefined,
    input: { name?: string; timezone?: string },
  ): Promise<{ id: string; name: string; timezone: string; version: number }> {
    const expected = requireIfMatch(ifMatch);
    const data: { name?: string; timezone?: string; version: { increment: number } } = {
      version: { increment: 1 },
    };

    if (input.name !== undefined) {
      const name = input.name.trim();
      if (name.length === 0 || name.length > 100) {
        throw new ApiException('VALIDATION_FAILED', '空间名称需为 1～100 个字符', {
          fieldErrors: { name: ['需为 1～100 个字符'] },
        });
      }
      data.name = name;
    }
    if (input.timezone !== undefined) {
      try {
        new Intl.DateTimeFormat('en-CA', { timeZone: input.timezone });
      } catch {
        throw new ApiException('VALIDATION_FAILED', '时区不是合法的 IANA 名称', {
          fieldErrors: { timezone: ['不是合法的 IANA 时区'] },
        });
      }
      data.timezone = input.timezone;
    }

    return this.db.$transaction(async (tx) => {
      const client = tx as unknown as PrismaClient;
      const updated = await client.workspace.updateMany({
        where: { id: workspaceId, version: expected, status: 'active' },
        data,
      });
      if (updated.count === 0) {
        const current = await client.workspace.findUnique({ where: { id: workspaceId } });
        if (current === null) throw new ApiException('NOT_FOUND', '空间不存在');
        throw new ApiException('PRECONDITION_FAILED', '该空间已被其他设备修改', {
          currentVersion: current.version,
        });
      }
      const workspace = await client.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
      await client.auditEvent.create({
        data: {
          workspaceId,
          actorId: actorUserId,
          action: 'workspace.updated',
          entityType: 'workspace',
          entityId: workspaceId,
          result: 'success',
          summary: `更新空间设置（时区 ${workspace.timezone}）`,
        },
      });
      return {
        id: workspace.id,
        name: workspace.name,
        timezone: workspace.timezone,
        version: workspace.version,
      };
    });
  }

  async listMembers(workspaceId: string): Promise<MemberSummary[]> {
    const members = await this.db.workspaceMember.findMany({
      where: { workspaceId },
      include: { user: { select: { id: true, displayName: true, emailNormalized: true } } },
      orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
    });
    const owners = members.filter((member) => member.role === 'owner' && member.status === 'active');
    return members.map((member) => ({
      userId: member.user.id,
      displayName: member.user.displayName,
      email: member.user.emailNormalized,
      role: member.role,
      status: member.status,
      joinedAt: member.joinedAt.toISOString(),
      version: member.version,
      isLastOwner:
        member.role === 'owner' && member.status === 'active' && owners.length === 1,
    }));
  }

  /** 事务内锁住成员集合后统计有效 Owner 数，避免并发移除最后一位 Owner */
  private async lockAndCountOwners(client: PrismaClient, workspaceId: string): Promise<number> {
    await client.$queryRaw`SELECT user_id FROM workspace_members WHERE workspace_id = ${workspaceId}::uuid FOR UPDATE`;
    return client.workspaceMember.count({
      where: { workspaceId, role: 'owner', status: 'active' },
    });
  }

  async changeRole(
    workspaceId: string,
    actorUserId: string,
    targetUserId: string,
    role: WorkspaceRole,
    ifMatch: string | string[] | undefined,
  ): Promise<{ userId: string; role: WorkspaceRole; version: number }> {
    const expected = requireIfMatch(ifMatch);
    return this.db.$transaction(async (tx) => {
      const client = tx as unknown as PrismaClient;
      const ownerCount = await this.lockAndCountOwners(client, workspaceId);

      const target = await client.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
      });
      if (target === null || target.status !== 'active') {
        throw new ApiException('NOT_FOUND', '成员不存在');
      }
      if (target.version !== expected) {
        throw new ApiException('PRECONDITION_FAILED', '成员信息已被其他设备修改', {
          currentVersion: target.version,
        });
      }
      if (target.role === 'owner' && role !== 'owner' && ownerCount <= 1) {
        throw new ApiException('LAST_OWNER_PROTECTED', '至少需要保留一位 Owner');
      }

      const updated = await client.workspaceMember.updateMany({
        where: { workspaceId, userId: targetUserId, version: expected },
        data: { role, version: { increment: 1 } },
      });
      if (updated.count === 0) {
        throw new ApiException('PRECONDITION_FAILED', '成员信息已被其他设备修改');
      }
      await client.auditEvent.create({
        data: {
          workspaceId,
          actorId: actorUserId,
          action: 'workspace.member_role_changed',
          entityType: 'user',
          entityId: targetUserId,
          result: 'success',
          summary: `角色 ${target.role} → ${role}`,
        },
      });
      return { userId: targetUserId, role, version: target.version + 1 };
    });
  }

  async removeMember(
    workspaceId: string,
    actorUserId: string,
    targetUserId: string,
  ): Promise<{ removed: true; revokedSessions: number }> {
    return this.db.$transaction(async (tx) => {
      const client = tx as unknown as PrismaClient;
      const ownerCount = await this.lockAndCountOwners(client, workspaceId);

      const target = await client.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
      });
      if (target === null || target.status !== 'active') {
        throw new ApiException('NOT_FOUND', '成员不存在');
      }
      if (target.role === 'owner' && ownerCount <= 1) {
        throw new ApiException('LAST_OWNER_PROTECTED', '至少需要保留一位 Owner');
      }

      await client.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId, userId: targetUserId } } });
      // 移除后该用户的会话立即失效（下一次请求 401）
      const revoked = await client.session.updateMany({
        where: { userId: targetUserId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await client.auditEvent.create({
        data: {
          workspaceId,
          actorId: actorUserId,
          action: 'workspace.member_removed',
          entityType: 'user',
          entityId: targetUserId,
          result: 'success',
          summary: `移除成员并吊销会话 ${revoked.count} 个`,
        },
      });
      return { removed: true as const, revokedSessions: revoked.count };
    });
  }
}
