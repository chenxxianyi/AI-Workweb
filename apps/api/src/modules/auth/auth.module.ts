import { Global, Module } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { AuthController } from './auth.controller.js';
import { CsrfGuard } from './csrf.guard.js';
import { SessionAuthGuard } from './session.guard.js';
import { SessionService } from './session.service.js';

/**
 * 认证模块（F08/F09）：
 * - 服务：会话、审计
 * - 守卫：SessionAuthGuard（默认全部路由需登录）、CsrfGuard（写请求校验）
 * 两者在 AppModule 用 APP_GUARD 注册为全局守卫，顺序在限流之后。
 */
@Global()
@Module({
  controllers: [AuthController],
  providers: [AuditService, SessionService, SessionAuthGuard, CsrfGuard],
  exports: [AuditService, SessionService, SessionAuthGuard, CsrfGuard],
})
export class AuthModule {}
