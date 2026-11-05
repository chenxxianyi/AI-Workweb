import { PrismaPg } from '@prisma/adapter-pg';

/**
 * 统一的 PostgreSQL 适配器工厂（F17 修复）。
 *
 * 背景：Prisma 7 的 `@prisma/adapter-pg` 在读取 `timestamptz` 时会丢掉偏移量，
 * 把数据库会话时区下的“本地时刻”当成 UTC。会话时区为 Asia/Shanghai 时，
 * 读到的所有时间戳都会比真实值晚 8 小时（已用 `select now()` 实测：8:04Z 读成 16:04Z）。
 *
 * 影响面：会话过期、`done_at` 的“今日完成”边界、`last_activity_at` 的“几天未活动”、
 * 幂等记录过期等所有基于时刻的判断。
 *
 * 处理：连接会话固定 `timezone=UTC`，让 Postgres 以 `+00` 输出，适配器解析即正确。
 * 业务日的“空间时区”语义在应用层显式计算（`@aiwb/domain` 的 businessDate），不受此设置影响。
 */
export function createPrismaAdapter(connectionString: string): PrismaPg {
  return new PrismaPg({
    connectionString,
    options: '-c timezone=UTC',
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  });
}
