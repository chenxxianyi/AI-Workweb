import { Module } from '@nestjs/common';
import { ProjectModule } from '../projects/project.module.js';
import { EntryController } from './entry.controller.js';
import { EntryService } from './entry.service.js';

/** 知识条目模块（F19）。依赖 ProjectModule：条目关联项目时更新项目活动时间。 */
@Module({
  imports: [ProjectModule],
  controllers: [EntryController],
  providers: [EntryService],
  exports: [EntryService],
})
export class EntryModule {}
