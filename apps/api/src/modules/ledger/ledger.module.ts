import { Module } from '@nestjs/common';
import { ProjectModule } from '../projects/project.module.js';
import { LedgerController } from './ledger.controller.js';
import { LedgerService } from './ledger.service.js';

/** 开发日志模块（F17）。依赖 ProjectModule：日志变化更新项目活动时间。 */
@Module({
  imports: [ProjectModule],
  controllers: [LedgerController],
  providers: [LedgerService],
  exports: [LedgerService],
})
export class LedgerModule {}
