import 'dotenv/config';
import { createPrismaClient } from './db.js';

/**
 * 数据库连通性冒烟（F05）：验证 Prisma 7 driver adapter + 生成的 client 能真实读写。
 * 只读查询，不修改数据；用于部署后自检与 CI 的数据库可用性检查。
 */
const prisma = createPrismaClient();

try {
  const [users, workspaces, projects, tasks, entries, ledger] = await Promise.all([
    prisma.user.count(),
    prisma.workspace.count(),
    prisma.project.count(),
    prisma.task.count(),
    prisma.entry.count(),
    prisma.ledgerRecord.count(),
  ]);

  const sample = await prisma.entry.findFirst({
    where: { status: 'verified' },
    select: {
      title: true,
      summary: true,
      version: true,
      tags: { select: { tag: { select: { displayName: true } } } },
      usage: { select: { useCount: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  const tasksByStatus = await prisma.task.groupBy({
    by: ['status'],
    _count: { _all: true },
  });

  console.log(
    JSON.stringify(
      {
        counts: { users, workspaces, projects, tasks, entries, ledger },
        sampleEntry: sample,
        tasksByStatus: tasksByStatus.map((row) => ({ status: row.status, count: row._count._all })),
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error('[smoke] 数据库读写失败：', error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
