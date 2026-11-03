import { Body, Controller, HttpCode, Inject, Patch, Post, Req } from '@nestjs/common';
import { RateLimit } from '../../common/rate-limit.js';
import type { Request } from 'express';
import { z } from 'zod';
import { ZodPipe } from '../../common/zod.pipe.js';
import { ApiException } from '../../common/api-exception.js';
import { currentRequestId } from '../../common/request-context.js';
import { PrismaService } from '../../common/prisma.module.js';
import { completeRecovery, changePassword } from './auth-core.js';

const recoverySchema = z.strictObject({
  token: z.string().min(20, '恢复令牌格式不正确').max(200),
  newPassword: z.string().min(12, '密码至少 12 个字符').max(128),
});

const passwordSchema = z.strictObject({
  currentPassword: z.string().min(1, '请输入当前密码').max(128),
  newPassword: z.string().min(12, '密码至少 12 个字符').max(128),
});

/**
 * 认证接口（F08）。
 * - POST /auth/recovery/complete：公开（持有一次性令牌即可），限流 5 次/分钟
 * - PATCH /auth/password：需登录；会话与 CSRF 在 F09 接入，当前由占位守卫拒绝
 *
 * 说明：F08 只落地“初始化 / 改密 / 恢复”能力；登录、会话与 CSRF 在 F09。
 */
@Controller('auth')
export class AuthController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Post('recovery/complete')
  @HttpCode(200)
  @RateLimit({ limit: 5, ttlMs: 60_000 })
  async completeRecovery(
    @Body(new ZodPipe(recoverySchema)) body: z.infer<typeof recoverySchema>,
  ): Promise<{ data: { status: 'password_reset' } }> {
    await completeRecovery(this.prisma.db, {
      token: body.token,
      newPassword: body.newPassword,
      requestId: currentRequestId(),
    });
    // 不返回 userId／邮箱，避免向未认证调用者泄露账号信息
    return { data: { status: 'password_reset' } };
  }

  @Patch('password')
  @RateLimit({ limit: 10, ttlMs: 60_000 })
  async changePassword(
    @Req() request: Request,
    @Body(new ZodPipe(passwordSchema)) body: z.infer<typeof passwordSchema>,
  ): Promise<{ data: { status: 'password_changed'; revokedSessions: number } }> {
    const userId = (request as Request & { auth?: { userId?: string } }).auth?.userId;
    if (userId === undefined) {
      // F09 会用真实会话守卫替换此分支；在此之前明确拒绝，不伪造已登录状态
      throw new ApiException('UNAUTHENTICATED', '会话机制将在 F09 接入，请先用服务器命令重置密码');
    }
    const result = await changePassword(this.prisma.db, {
      userId,
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
      requestId: currentRequestId(),
    });
    return { data: { status: 'password_changed', revokedSessions: result.revokedSessions } };
  }
}
