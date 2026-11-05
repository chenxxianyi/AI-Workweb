import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { createPrismaAdapter } from '../src/common/prisma-adapter.js';
config({ path: resolve('../../.env'), quiet: true });
const url = process.env['DATABASE_URL_TEST']!,
  target = new URL(url);
if (!['127.0.0.1', 'localhost'].includes(target.hostname) || !target.pathname.endsWith('_test'))
  throw new Error('local test only');
const db = new PrismaClient({ adapter: createPrismaAdapter(url) });
let checks = 0;
const check = (ok: unknown, label: string) => {
  assert.ok(ok, label);
  console.log('PASS', ++checks, label);
};
try {
  const exported = JSON.parse(
    await readFile(resolve('../../全栈开发任务/验收证据/FS040/download.json'), 'utf8'),
  );
  const job = await db.transferJob.findFirstOrThrow({
    where: { type: 'import', sourceNamespace: exported.sourceNamespace },
    orderBy: { createdAt: 'desc' },
  });
  check(job.state === 'succeeded', '浏览器确认后真实worker导入完成');
  const maps = await db.importEntityMapping.findMany({
      where: { workspaceId: job.workspaceId, sourceNamespace: exported.sourceNamespace },
    }),
    mapped = (type: string, id: string) =>
      maps.find((m) => m.entityType === type && m.legacyId === id)?.entityId;
  check(maps.length === 8, '8个实体建立稳定来源映射');
  const original = exported.entries.find((r: { title: string }) => r.title === 'F40任务沉淀闭环'),
    entry = await db.entry.findUniqueOrThrow({ where: { id: mapped('entry', original.id)! } });
  check(
    entry.body === original.body &&
      entry.title === original.title &&
      entry.summary === original.summary,
    '浏览器往返正文标题摘要完全一致',
  );
  const revision = await db.entryRevision.findMany({ where: { entryId: entry.id } });
  check(revision.length === 1 && revision[0]!.body.includes('**任务**'), '修订原文往返保留');
  check(
    (await db.entryUsage.findUniqueOrThrow({ where: { entryId: entry.id } })).useCount === 1,
    '使用次数往返为1',
  );
  const sourceTask = exported.tasks.find((r: { title: string }) => r.title === 'F40任务沉淀闭环');
  check(
    (await db.taskEntry.count({
      where: {
        workspaceId: job.workspaceId,
        taskId: mapped('task', sourceTask.id)!,
        entryId: entry.id,
      },
    })) === 1,
    '任务知识关联往返完整',
  );
  const sourceLedger = exported.ledger.find(
      (r: { note: string }) => r.note === 'F40浏览器全流程台账',
    ),
    ledger = await db.ledgerRecord.findUniqueOrThrow({
      where: { id: mapped('ledger', sourceLedger.id)! },
    });
  check(
    ledger.entryId === entry.id && ledger.projectId === mapped('project', sourceLedger.projectId),
    '台账两种关联映射完整',
  );
  check(
    ledger.minutes === 12 && ledger.savedMinutes === 30 && ledger.effect === 4,
    '统计数值往返未改变',
  );
  console.log(JSON.stringify({ checks, result: 'passed', jobId: job.id }));
} finally {
  await db.$disconnect();
}
