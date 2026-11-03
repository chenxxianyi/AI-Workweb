import { createHash } from 'node:crypto';
import { ApiException } from './api-exception.js';
import type { PrismaClient } from '../generated/prisma/client.js';

/**
 * 幂等键（F14，ADR-0004）。
 *
 * 作用域：user + workspace + action scope + key。
 * - 同一 key + 同一请求体：返回首次结果（不重复执行）
 * - 同一 key + 不同请求体：409 IDEMPOTENCY_KEY_REUSED
 * - 首次执行在事务内占位，业务变更与结果记录同事务提交
 * - 记录保留 7 天（过期后由后台清理任务处理，F34）
 */
export interface IdempotencyInput {
  userId: string;
  workspaceId: string;
  scope: string;
  key: string;
  body: unknown;
}

export interface IdempotentResult<T> {
  data: T;
  replayed: boolean;
}

const RETENTION_MS = 7 * 24 * 3_600_000;

export function hashRequestBody(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? null), 'utf8').digest('hex');
}

export function assertIdempotencyKey(key: string | string[] | undefined): string {
  const raw = Array.isArray(key) ? key[0] : key;
  if (raw === undefined || raw.trim() === '') {
    throw new ApiException('VALIDATION_FAILED', '创建类请求需要 Idempotency-Key 头', {
      fieldErrors: { 'Idempotency-Key': ['必填'] },
    });
  }
  if (raw.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(raw)) {
    throw new ApiException('VALIDATION_FAILED', 'Idempotency-Key 格式不正确（≤128 位字母数字与 ._:-）', {
      fieldErrors: { 'Idempotency-Key': ['格式不正确'] },
    });
  }
  return raw;
}

export async function runIdempotent<T>(
  db: PrismaClient,
  input: IdempotencyInput,
  action: (tx: PrismaClient) => Promise<T>,
): Promise<IdempotentResult<T>> {
  const requestHash = hashRequestBody(input.body);
  const scopeKey = {
    userId: input.userId,
    workspaceId: input.workspaceId,
    scope: input.scope,
    key: input.key,
  };

  const existing = await db.idempotencyRecord.findUnique({
    where: { userId_workspaceId_scope_key: scopeKey },
  });

  if (existing !== null) {
    if (existing.requestHash !== requestHash) {
      throw new ApiException('IDEMPOTENCY_KEY_REUSED', '同一幂等键对应了不同的请求内容');
    }
    if (existing.responseRef !== null) {
      return { data: existing.responseRef as T, replayed: true };
    }
    // 上一次执行未完成（进程中断）：视为结果未知，要求客户端用同一 key 重试
    throw new ApiException('CONFLICT', '该请求正在处理中，请稍后用同一幂等键重试');
  }

  try {
    return await db.$transaction(async (tx) => {
      const client = tx as unknown as PrismaClient;
      await client.idempotencyRecord.create({
        data: {
          ...scopeKey,
          requestHash,
          status: 'in_progress',
          expiresAt: new Date(Date.now() + RETENTION_MS),
        },
      });
      const data = await action(client);
      await client.idempotencyRecord.update({
        where: { userId_workspaceId_scope_key: scopeKey },
        data: { status: 'succeeded', responseRef: data as never },
      });
      return { data, replayed: false };
    });
  } catch (error) {
    // 并发同 key：唯一约束冲突 → 回读首次结果
    const code = (error as { code?: string }).code;
    if (code === 'P2002') {
      const record = await db.idempotencyRecord.findUnique({
        where: { userId_workspaceId_scope_key: scopeKey },
      });
      if (record !== null && record.requestHash !== requestHash) {
        throw new ApiException('IDEMPOTENCY_KEY_REUSED', '同一幂等键对应了不同的请求内容');
      }
      if (record !== null && record.responseRef !== null) {
        return { data: record.responseRef as T, replayed: true };
      }
      throw new ApiException('CONFLICT', '该请求正在处理中，请稍后用同一幂等键重试');
    }
    throw error;
  }
}
