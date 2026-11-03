import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodPipe } from '../../common/zod.pipe.js';
import { CsrfExempt, Public } from '../auth/auth-context.js';
import { RateLimit } from '../../common/rate-limit.js';
import { InviteService } from './invite.service.js';

const acceptSchema = z.strictObject({
  token: z.string().min(20, '邀请令牌格式不正确').max(200),
  password: z.string().min(12, '密码至少 12 个字符').max(128).optional(),
  displayName: z.string().min(1).max(100).optional(),
});

/**
 * 接受邀请（F10）。
 * 公开 + 豁免 CSRF：凭据是邀请令牌本身（持有型），邀请人可能尚未登录。
 * 已有账号只建立成员关系；新账号必须同时设置符合策略的密码。
 */
@Controller('auth/invitations')
export class InviteAcceptController {
  constructor(@Inject(InviteService) private readonly invites: InviteService) {}

  @Public()
  @CsrfExempt()
  @Post('accept')
  @HttpCode(200)
  @RateLimit({ limit: 10, ttlMs: 60_000 })
  async accept(
    @Body(new ZodPipe(acceptSchema)) body: z.infer<typeof acceptSchema>,
  ): Promise<{ data: { workspaceId: string; role: string; createdUser: boolean } }> {
    const result = await this.invites.accept(body.token, {
      ...(body.password === undefined ? {} : { password: body.password }),
      ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
    });
    return {
      data: {
        workspaceId: result.workspaceId,
        role: result.role,
        createdUser: result.createdUser,
      },
    };
  }
}
