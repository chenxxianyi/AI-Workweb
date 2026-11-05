import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { ApiException } from '../../common/api-exception.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { requireRequestAuth } from '../auth/auth-context.js';
import { RateLimit } from '../../common/rate-limit.js';
import { InviteService } from './invite.service.js';
import { WorkspaceRoleRequired } from './permissions.js';
import { workspaceContext } from './workspace.guard.js';
import { assertIdempotencyKey } from '../../common/idempotency.js';
import { WorkspaceService } from './workspace.service.js';

const createWorkspaceSchema = z.strictObject({
  name: z.string().min(1).max(100),
  timezone: z.string().min(1).max(64).optional(),
});

const updateWorkspaceSchema = z.strictObject({
  name: z.string().min(1).max(100).optional(),
  timezone: z.string().min(1).max(64).optional(),
});

const roleSchema = z.strictObject({
  role: z.enum(['owner', 'editor', 'viewer']),
});

const inviteSchema = z.strictObject({
  email: z.string().min(3).max(320),
  role: z.enum(['editor', 'viewer']),
});

/**
 * 空间与成员接口（F10）。
 *
 * 权限：
 * - 列表/创建：任意登录用户；
 * - 读取空间与成员：任意成员（WorkspaceGuard 校验成员关系）；
 * - 修改空间、管理成员与邀请：Owner（@WorkspaceRoleRequired('owner')）。
 *
 * 条件写：PATCH 需要 If-Match（workspace.version / member.version）；缺 428，过期 412。
 */
@Controller('workspaces')
export class WorkspaceController {
  constructor(
    @Inject(WorkspaceService) private readonly workspaces: WorkspaceService,
    @Inject(InviteService) private readonly invites: InviteService,
  ) {}

  @Get()
  async list(
    @Req() request: Request,
  ): Promise<{ data: { workspaces: Awaited<ReturnType<WorkspaceService['listForUser']>> } }> {
    const auth = requireRequestAuth(request);
    return { data: { workspaces: await this.workspaces.listForUser(auth.userId) } };
  }

  @Post()
  @HttpCode(201)
  @RateLimit({ limit: 10, ttlMs: 60_000 })
  async create(
    @Req() request: Request,
    @Headers('idempotency-key') key: string | undefined,
    @Body(new ZodPipe(createWorkspaceSchema)) body: z.infer<typeof createWorkspaceSchema>,
  ): Promise<{ data: { id: string; name: string; timezone: string; version: number } }> {
    const auth = requireRequestAuth(request);
    const workspace = await this.workspaces.create(auth.userId, body, assertIdempotencyKey(key));
    return { data: workspace };
  }

  @Get(':workspaceId')
  async detail(@Req() request: Request): Promise<{
    data: { id: string; name: string; timezone: string; role: string; version: number };
  }> {
    const context = workspaceContext(request);
    return {
      data: {
        id: context.workspace.id,
        name: context.workspace.name,
        timezone: context.workspace.timezone,
        role: context.role,
        version: context.workspace.version,
      },
    };
  }

  @Patch(':workspaceId')
  @WorkspaceRoleRequired('owner')
  async update(
    @Req() request: Request,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodPipe(updateWorkspaceSchema)) body: z.infer<typeof updateWorkspaceSchema>,
  ): Promise<{ data: { id: string; name: string; timezone: string; version: number } }> {
    const auth = requireRequestAuth(request);
    const context = workspaceContext(request);
    return { data: await this.workspaces.update(context.workspaceId, auth.userId, ifMatch, body) };
  }

  @Get(':workspaceId/members')
  async members(
    @Req() request: Request,
  ): Promise<{ data: { members: Awaited<ReturnType<WorkspaceService['listMembers']>> } }> {
    const context = workspaceContext(request);
    return { data: { members: await this.workspaces.listMembers(context.workspaceId) } };
  }

  @Patch(':workspaceId/members/:userId')
  @WorkspaceRoleRequired('owner')
  async changeRole(
    @Req() request: Request,
    @Param('userId') userId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodPipe(roleSchema)) body: z.infer<typeof roleSchema>,
  ): Promise<{ data: { userId: string; role: string; version: number } }> {
    const auth = requireRequestAuth(request);
    const context = workspaceContext(request);
    return {
      data: await this.workspaces.changeRole(
        context.workspaceId,
        auth.userId,
        userId,
        body.role,
        ifMatch,
      ),
    };
  }

  @Delete(':workspaceId/members/:userId')
  async removeMember(
    @Req() request: Request,
    @Param('userId') userId: string,
  ): Promise<{ data: { removed: true; revokedSessions: number } }> {
    const auth = requireRequestAuth(request);
    const context = workspaceContext(request);
    // 允许成员移除自己（退出空间）；移除他人需要 Owner
    if (userId !== auth.userId && context.role !== 'owner') {
      throw new ApiException('FORBIDDEN', '只有 Owner 可以移除其他成员');
    }
    return { data: await this.workspaces.removeMember(context.workspaceId, auth.userId, userId) };
  }

  @Post(':workspaceId/invitations')
  @HttpCode(201)
  @WorkspaceRoleRequired('owner')
  @RateLimit({ limit: 20, ttlMs: 60_000 })
  async createInvite(
    @Req() request: Request,
    @Body(new ZodPipe(inviteSchema)) body: z.infer<typeof inviteSchema>,
  ): Promise<{ data: Awaited<ReturnType<InviteService['create']>> }> {
    const auth = requireRequestAuth(request);
    const context = workspaceContext(request);
    return { data: await this.invites.create(context.workspaceId, auth.userId, body) };
  }

  @Get(':workspaceId/invitations')
  @WorkspaceRoleRequired('owner')
  async listInvites(
    @Req() request: Request,
  ): Promise<{ data: { invitations: Awaited<ReturnType<InviteService['list']>> } }> {
    const context = workspaceContext(request);
    return { data: { invitations: await this.invites.list(context.workspaceId) } };
  }

  @Delete(':workspaceId/invitations/:id')
  @HttpCode(200)
  @WorkspaceRoleRequired('owner')
  async revokeInvite(
    @Req() request: Request,
    @Param('id') id: string,
  ): Promise<{ data: { status: 'revoked' } }> {
    const auth = requireRequestAuth(request);
    const context = workspaceContext(request);
    await this.invites.revoke(context.workspaceId, auth.userId, id);
    return { data: { status: 'revoked' } };
  }
}
