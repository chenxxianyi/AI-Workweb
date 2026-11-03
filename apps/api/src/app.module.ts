import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, PrismaModule } from './common/prisma.module.js';
import { RateLimitGuard } from './common/rate-limit.js';
import { AllExceptionsFilter } from './common/exception.filter.js';
import { ResponseEnvelopeInterceptor } from './common/response.interceptor.js';
import { createAccessLogMiddleware } from './common/logger.js';
import { HealthController } from './modules/health/health.controller.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { WorkspaceModule } from './modules/workspaces/workspace.module.js';
import { ProjectModule } from './modules/projects/project.module.js';
import { TaskModule } from './modules/tasks/task.module.js';
import { DashboardModule } from './modules/dashboard/dashboard.module.js';
import { LedgerModule } from './modules/ledger/ledger.module.js';
import { WorkspaceGuard } from './modules/workspaces/workspace.guard.js';
import { CsrfGuard } from './modules/auth/csrf.guard.js';
import { SessionAuthGuard } from './modules/auth/session.guard.js';

/**
 * 应用根模块。
 *
 * 横切能力（F06/F08/F09）注册在模块上，保证 CLI 启动、集成测试与生产一致：
 * - APP_FILTER / APP_INTERCEPTOR：统一错误信封与成功信封
 * - APP_GUARD 顺序：限流 → 会话（默认需登录）→ CSRF（写请求）
 * - 中间件：访问日志（含 requestId）
 *
 * 公开路由用 `@Public()` 显式开放；写请求默认校验 CSRF，持有型凭据用 `@CsrfExempt()`。
 */
@Module({
  imports: [ConfigModule, PrismaModule, AuthModule, WorkspaceModule, ProjectModule, TaskModule, DashboardModule, LedgerModule],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: SessionAuthGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: WorkspaceGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(createAccessLogMiddleware()).forRoutes('*');
  }
}
