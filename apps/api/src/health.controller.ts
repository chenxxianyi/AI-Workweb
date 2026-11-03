import { Controller, Get } from '@nestjs/common';
import type { ApiSuccess } from '@aiwb/contracts';

/** 最小存活检查（F04）。F06 增加请求 ID、统一封装与数据库 readiness。 */
@Controller('health')
export class HealthController {
  @Get('live')
  live(): ApiSuccess<{ status: 'ok'; service: 'api' }> {
    return {
      data: { status: 'ok', service: 'api' },
      requestId: 'bootstrap',
    };
  }
}
