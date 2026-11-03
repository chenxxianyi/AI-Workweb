// Prisma 7 CLI 配置（由 `prisma init` 模板 + docs/数据库实现约定.md 确定）
// 说明：Prisma 7 起 datasource.url 从 config 注入，schema.prisma 不再写 url。
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'database/prisma/schema.prisma',
  migrations: {
    path: 'database/prisma/migrations',
    seed: 'tsx database/seeds/seed.ts',
  },
  datasource: {
    url: process.env['DATABASE_URL'],
  },
});
