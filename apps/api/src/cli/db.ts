import { createPrismaAdapter } from '../common/prisma-adapter.js';
import { PrismaClient } from '../generated/prisma/client.js';

/** CLI 专用 Prisma 客户端（F08）：与运行时同一 adapter，避免两套连接方式 */
export function createCliPrisma(connectionString: string): PrismaClient {
  const adapter = createPrismaAdapter(connectionString);
  return new PrismaClient({ adapter });
}
