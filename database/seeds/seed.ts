import 'dotenv/config';
import { createPrismaClient } from './db.js';
import { seedFixture } from './fixture.js';

/**
 * 显式演示数据种子（F05）。
 * - 只在手工执行 `pnpm db:seed` 时运行；应用启动与空库不会自动灌入。
 * - 幂等：检测到“个人工作台”已存在时直接跳过，不重复创建。
 * - 种子用户口令为占位值（不可登录）；真实账号由 F08 的 bootstrap 命令创建。
 */
const prisma = createPrismaClient();

try {
  const result = await seedFixture(prisma);
  if (result === null) {
    console.log('[seed] 演示数据已存在，跳过（未创建任何记录）');
  } else {
    console.log('[seed] 已创建演示数据：');
    console.log(`  工作空间：个人 ${result.workspaces.personalId} / 团队 ${result.workspaces.teamId}`);
    console.log(
      `  任务 ${result.counts.tasks} · 知识 ${result.counts.entries} · 标签 ${result.counts.tags} · 台账 ${result.counts.ledger} · 日志 ${result.counts.logs}`,
    );
    console.log('  用户：owner/editor/viewer@demo.test（口令占位，F08 后可引导重置）');
  }
} catch (error) {
  console.error('[seed] 失败：', error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
