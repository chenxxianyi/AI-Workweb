import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

/** CLI 专用 Prisma 客户端（F08）：与运行时同一 adapter，避免两套连接方式 */
export function createCliPrisma(connectionString: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}
