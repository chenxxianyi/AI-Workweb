import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';

/**
 * 最小应用壳（F04）。
 * F06 在此基础上补：配置校验、requestId、统一异常与错误封装、结构化日志、readiness 检查与事务入口。
 */
@Module({
  controllers: [HealthController],
})
export class AppModule {}
