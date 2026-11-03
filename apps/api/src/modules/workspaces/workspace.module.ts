import { Module } from '@nestjs/common';
import { InviteService } from './invite.service.js';
import { WorkspaceController } from './workspace.controller.js';
import { WorkspaceGuard } from './workspace.guard.js';
import { WorkspaceService } from './workspace.service.js';
import { InviteAcceptController } from './invite.controller.js';

/**
 * 空间与成员模块（F10）。
 * WorkspaceGuard 作为全局守卫在 AppModule 注册（按 URL 中的 workspaceId 校验成员关系）。
 */
@Module({
  controllers: [WorkspaceController, InviteAcceptController],
  providers: [WorkspaceService, InviteService, WorkspaceGuard],
  exports: [WorkspaceService, InviteService, WorkspaceGuard],
})
export class WorkspaceModule {}
