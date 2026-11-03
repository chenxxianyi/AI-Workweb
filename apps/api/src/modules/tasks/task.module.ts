import { Module } from '@nestjs/common';
import { ProjectModule } from '../projects/project.module.js';
import { TaskController } from './task.controller.js';
import { TaskService } from './task.service.js';

/**
 * 任务模块（F14）。
 * 依赖 ProjectModule：任务变化时更新项目活动时间（ProjectService.touchActivity）。
 */
@Module({
  imports: [ProjectModule],
  controllers: [TaskController],
  providers: [TaskService],
  exports: [TaskService],
})
export class TaskModule {}
