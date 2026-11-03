import { Module } from '@nestjs/common';
import { ProjectController } from './project.controller.js';
import { ProjectService } from './project.service.js';

/**
 * 项目模块（F12）。
 * WorkspaceGuard 已在 AppModule 全局注册，负责 workspaceId 的成员关系与角色校验。
 */
@Module({
  controllers: [ProjectController],
  providers: [ProjectService],
  exports: [ProjectService],
})
export class ProjectModule {}
