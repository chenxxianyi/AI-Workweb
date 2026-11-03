import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, PrismaModule } from './common/prisma.module.js';
import { RateLimitGuard } from './common/rate-limit.js';
import { AllExceptionsFilter } from './common/exception.filter.js';
import { ResponseEnvelopeInterceptor } from './common/response.interceptor.js';
import { createAccessLogMiddleware } from './common/logger.js';
import { HealthController } from './modules/health/health.controller.js';
import { AuthModule } from './modules/auth/auth.module.js';

/**
 * 应用根模块。
 *
 * F06 的横切能力（访问日志、统一信封、异常过滤）注册在模块上而不是 main.ts，
 * 这样 CLI 启动的进程、集成测试与未来的 worker 都走同一套行为，不会出现
 * “生产有信封、测试没有”的差异（F08 实测发现并修正）。
 */
@Module({
  imports: [ConfigModule, PrismaModule, AuthModule],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(createAccessLogMiddleware()).forRoutes('*');
  }
}
