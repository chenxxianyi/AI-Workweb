import { Module } from '@nestjs/common';
import { ConfigModule, PrismaModule } from './common/prisma.module.js';
import { HealthController } from './modules/health/health.controller.js';

/**
 * 应用根模块（F06）。
 * F07 之后按模块加入 auth/workspaces/projects/tasks/logs/entries/ledger/transfers/preferences/audit。
 */
@Module({
  imports: [ConfigModule, PrismaModule],
  controllers: [HealthController],
})
export class AppModule {}
