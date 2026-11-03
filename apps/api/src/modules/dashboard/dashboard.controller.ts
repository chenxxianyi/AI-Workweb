import { Controller, Get, Inject, Req } from '@nestjs/common';
import type { Request } from 'express';
import { workspaceContext } from '../workspaces/workspace.guard.js';
import { DashboardService, type TodayDashboard } from './dashboard.service.js';

/**
 * 今日仪表盘（F15）。
 * 只做读取；业务日由服务端按空间时区计算，忽略客户端时区。
 */
@Controller('workspaces/:workspaceId/dashboard')
export class DashboardController {
  constructor(@Inject(DashboardService) private readonly dashboard: DashboardService) {}

  @Get('today')
  async today(@Req() request: Request): Promise<{ data: TodayDashboard }> {
    const context = workspaceContext(request);
    return { data: await this.dashboard.today(context.workspaceId) };
  }
}
