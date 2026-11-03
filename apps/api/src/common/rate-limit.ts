import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { ApiException } from './api-exception.js';
import { APP_CONFIG } from './prisma.module.js';
import type { AppConfig } from './config.js';

/**
 * 进程内固定窗口限流（F08/F09）。
 *
 * 为什么不用 @nestjs/throttler：其 ThrottlerGuard 依赖构造函数参数装饰器元数据，
 * 在 esbuild/tsx 下解析不到 Reflector（见 ADR-0008）。这里用零依赖的首方实现，
 * 在 tsc / tsx / vitest 下行为一致。
 *
 * 边界：
 * - 计数在进程内，多实例部署不共享；本期单机部署可接受，F43 再按部署形态评估。
 * - 键为 IP + 方法 + 路径，避免不同接口互相挤占。
 * - 数值可来自配置（登录/搜索的限额由 .env 控制，测试可调高以验证其他逻辑）。
 */

export const RATE_LIMIT_KEY = 'aiwb:rate-limit';

type ConfigLimitKey = 'RATE_LIMIT_LOGIN_PER_MINUTE' | 'RATE_LIMIT_SEARCH_PER_MINUTE';

export interface RateLimitOptions {
  /** 固定次数，或从配置读取 */
  limit: number | { fromConfig: ConfigLimitKey };
  ttlMs: number;
}

export function RateLimit(options: RateLimitOptions): MethodDecorator {
  return SetMetadata(RATE_LIMIT_KEY, options);
}

interface Bucket {
  count: number;
  resetAt: number;
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly buckets = new Map<string, Bucket>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const options = Reflect.getMetadata(RATE_LIMIT_KEY, context.getHandler()) as
      | RateLimitOptions
      | undefined;
    if (options === undefined) return true;

    const limit =
      typeof options.limit === 'number' ? options.limit : this.config[options.limit.fromConfig];

    const request = context
      .switchToHttp()
      .getRequest<{ ip?: string; url?: string; method?: string }>();
    const path = (request.url ?? '').split('?')[0] ?? '';
    const key = `${request.ip ?? 'unknown'}:${request.method ?? 'GET'}:${path}`;
    const now = Date.now();

    let bucket = this.buckets.get(key);
    if (bucket === undefined || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + options.ttlMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;

    if (bucket.count > limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      throw new ApiException('RATE_LIMITED', `请求过于频繁，请在 ${retryAfterSeconds} 秒后重试`, {
        details: { retryAfterSeconds },
      });
    }
    return true;
  }
}
