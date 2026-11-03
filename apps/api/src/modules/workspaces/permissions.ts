import { SetMetadata } from '@nestjs/common';

/** 角色（与数据库 member_role 枚举一致） */
export type WorkspaceRole = 'owner' | 'editor' | 'viewer';

const RANK: Record<WorkspaceRole, number> = { viewer: 1, editor: 2, owner: 3 };

export function roleAtLeast(role: WorkspaceRole, required: WorkspaceRole): boolean {
  return RANK[role] >= RANK[required];
}

/** 能力矩阵（方案第 7 节） */
export type Capability =
  | 'workspace.read'
  | 'workspace.update'
  | 'workspace.delete'
  | 'member.manage'
  | 'invite.manage'
  | 'business.write'
  | 'data.export'
  | 'data.import'
  | 'trash.manage'
  | 'audit.read'
  | 'clear.workspace';

const CAPABILITIES: Record<Capability, WorkspaceRole> = {
  'workspace.read': 'viewer',
  'workspace.update': 'owner',
  'workspace.delete': 'owner',
  'member.manage': 'owner',
  'invite.manage': 'owner',
  'business.write': 'editor',
  'data.export': 'editor',
  'data.import': 'owner',
  'trash.manage': 'owner',
  'audit.read': 'owner',
  'clear.workspace': 'owner',
};

export function can(role: WorkspaceRole, capability: Capability): boolean {
  return roleAtLeast(role, CAPABILITIES[capability]);
}

/** 路由声明：访问该路由至少需要什么角色 */
export const WORKSPACE_ROLE_KEY = 'aiwb:workspace-role';
export const WorkspaceRoleRequired = (
  role: WorkspaceRole | Capability,
): MethodDecorator & ClassDecorator =>
  SetMetadata(WORKSPACE_ROLE_KEY, role in CAPABILITIES ? CAPABILITIES[role as Capability] : role);
