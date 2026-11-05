import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { createPrismaAdapter } from '../src/common/prisma-adapter.js';
config({ path: resolve('../../.env'), quiet: true });
const url = new URL(process.env['DATABASE_URL_TEST']!);
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.pathname.endsWith('_test'))
  throw new Error('local only');
url.pathname = '/aiwb_perf_test';
const db = new PrismaClient({ adapter: createPrismaAdapter(url.toString()) });
try {
  const report = JSON.parse(
      await readFile(resolve('../../全栈开发任务/验收证据/FS041/job-load.json'), 'utf8'),
    ),
    workspaceId = report.targetWorkspace,
    project = await db.project.findFirstOrThrow({ where: { workspaceId } });
  assert.equal(await db.task.count({ where: { workspaceId, projectId: project.id } }), 50000);
  assert.equal(
    await db.ledgerRecord.count({ where: { workspaceId, projectId: project.id } }),
    50000,
  );
  assert.equal(await db.entryTag.count({ where: { workspaceId } }), 1000);
  const sum = await db.ledgerRecord.aggregate({
    where: { workspaceId },
    _sum: { minutes: true, savedMinutes: true, effect: true },
  });
  assert.deepEqual(sum._sum, { minutes: 500000, savedMinutes: 1000000, effect: 200000 });
  assert.equal(await db.developmentLog.count({ where: { workspaceId } }), 642);
  assert.equal(await db.task.count({ where: { workspaceId, status: 'done' } }), 16666);
  console.log(
    JSON.stringify({
      result: 'passed',
      checks: 6,
      tasksToImportedProject: 50000,
      ledgerToImportedProject: 50000,
      tagRelations: 1000,
      ledgerTotals: sum._sum,
      snapshotLogs: 642,
      doneTasks: 16666,
    }),
  );
} finally {
  await db.$disconnect();
}
