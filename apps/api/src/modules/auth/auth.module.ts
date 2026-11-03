import { Global, Module } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { AuthController } from './auth.controller.js';

/** 认证模块（F08）。F09 起加入会话、CSRF 与登录接口。 */
@Global()
@Module({
  controllers: [AuthController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuthModule {}
