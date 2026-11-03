import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.module.js';
import type { PrismaClient } from '../../generated/prisma/client.js';

export interface AuditInput {
  workspaceId?: string | null;
  actorId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  requestId?: string;
  result: 'success' | 'failure';
  /** 只允许写不含敏感信息的摘要；禁止写入密码、令牌、正文 */
  summary?: string;
}

/**
 * 审计（F08 最小实现，F34 扩展查询与界面）。
 * 约束：
 * - 不写密码、令牌、会话值、正文；
 * - 与业务变更在同一事务内提交（调用方传 tx）。
 */
@Injectable()
export class AuditService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async record(input: AuditInput, tx?: PrismaClient): Promise<void> {
    const client = tx ?? this.prisma.db;
    await client.auditEvent.create({
      data: {
        workspaceId: input.workspaceId ?? null,
        actorId: input.actorId ?? null,
        action: input.action,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        requestId: input.requestId ?? null,
        result: input.result,
        summary: input.summary ?? null,
      },
    });
  }
}
