import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { ApiException } from '../../common/api-exception.js';
import { PrismaService } from '../../common/prisma.module.js';
import { requireRequestAuth } from '../auth/auth-context.js';
import { WORKSPACE_ROLE_KEY, type WorkspaceRole, roleAtLeast } from './permissions.js';

export interface WorkspaceContext {
  workspaceId: string;
  role: WorkspaceRole;
  memberVersion: number;
  workspace: {
    id: string;
    name: string;
    timezone: string;
    status: string;
    version: number;
    createdBy: string;
  };
}

export type WorkspaceRequest = Request & { workspace?: WorkspaceContext };

export function workspaceContext(request: Request): WorkspaceContext {
  const context = (request as WorkspaceRequest).workspace;
  if (context === undefined) throw new ApiException('FORBIDDEN', '缺少空间上下文');
  return context;
}

/**
 * 空间权限守卫（F10）。
 *
 * 规则：
 * - workspaceId 只作为“候选”来自 URL；必须查库确认当前会话用户是该空间的有效成员；
 * - 不是成员（或空间不存在／已停用）一律 404，避免探测其他空间；
 * - 角色不足返回 403（已确认是成员，只是无权限）；
 * - 需要写能力的路由用 @WorkspaceRoleRequired('business.write') 声明角色底线。
 *
 * 说明：路由参数名统一为 `workspaceId`（见 C-10）。
 */
@Injectable()
export class WorkspaceGuard implements CanActivate {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const params = request.params as Record<string, string | undefined>;
    const workspaceId = params['workspaceId'];
    if (workspaceId === undefined) return true; // 非空间路由（如 /workspaces 列表）

    const auth = requireRequestAuth(request);
    const membership = await this.prisma.db.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: auth.userId } },
      include: {
        workspace: {
          select: { id: true, name: true, timezone: true, status: true, version: true, createdBy: true },
        },
      },
    });

    if (membership === null || membership.status !== 'active' || membership.workspace.status !== 'active') {
      throw new ApiException('NOT_FOUND', '空间不存在或无权访问');
    }

    const workspaceContextValue: WorkspaceContext = {
      workspaceId,
      role: membership.role,
      memberVersion: membership.version,
      workspace: membership.workspace,
    };
    (request as WorkspaceRequest).workspace = workspaceContextValue;

    const required = Reflect.getMetadata(WORKSPACE_ROLE_KEY, context.getHandler()) as
      | WorkspaceRole
      | undefined;
    if (required !== undefined && !roleAtLeast(membership.role, required)) {
      throw new ApiException('FORBIDDEN', '当前角色无权执行该操作');
    }
    return true;
  }
}
