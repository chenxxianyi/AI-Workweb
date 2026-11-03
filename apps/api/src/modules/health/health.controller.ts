import { Controller, Get, Inject } from '@nestjs/common';
import { Public } from '../auth/auth-context.js';
import { PrismaService } from '../../common/prisma.module.js';
import { ApiException } from '../../common/api-exception.js';

/**
 * 健康检查（F06）。
 * - live：只反映进程是否在运行，不依赖数据库（DB 挂了 live 仍应为 200）
 * - ready：检查数据库可用；不可用时 503，且响应不包含连接串、主机、驱动错误详情
 *
 * 注意：构造函数依赖使用显式 `@Inject`，不依赖 `emitDecoratorMetadata`
 * （esbuild/tsx 不生成 design:paramtypes；显式注入让 tsc、tsx、vitest 下行为一致）。
 */
@Public()
@Controller('health')
export class HealthController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get('live')
  live(): { data: { status: 'ok'; service: 'api'; uptimeSeconds: number } } {
    return {
      data: {
        status: 'ok',
        service: 'api',
        uptimeSeconds: Math.round(process.uptime()),
      },
    };
  }

  @Get('ready')
  async ready(): Promise<{ data: { status: 'ok'; checks: { database: 'up' } } }> {
    const databaseReady = await this.prisma.isReady();
    if (!databaseReady) {
      throw new ApiException('SERVICE_UNAVAILABLE', '服务依赖不可用，请稍后再试');
    }
    return { data: { status: 'ok', checks: { database: 'up' } } };
  }
}
