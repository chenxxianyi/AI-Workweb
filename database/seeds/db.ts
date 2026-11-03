import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../apps/api/src/generated/prisma/client.js';

/**
 * 数据库客户端工厂（F05）。
 * Prisma 7 使用 driver adapter（@prisma/adapter-pg）而不是内置 Rust 引擎；
 * 连接串统一来自 DATABASE_URL，禁止在代码里硬编码。
 */
export function createPrismaClient(connectionString = process.env['DATABASE_URL']): PrismaClient {
  if (connectionString === undefined || connectionString === '') {
    throw new Error('缺少 DATABASE_URL：请从 .env.example 复制 .env 并填写');
  }
  // 与 apps/api 保持一致：会话时区固定 UTC，避免 timestamptz 读回偏移（见 prisma-adapter.ts 注释）
const adapter = new PrismaPg({ connectionString, options: '-c timezone=UTC' });
  return new PrismaClient({ adapter });
}
