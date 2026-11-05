import { config } from 'dotenv';
import { resolve } from 'node:path';
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
config({ path: resolve('../../.env'), quiet: true });
const target = new URL(process.env['DATABASE_URL_TEST']!);
if (!['127.0.0.1', 'localhost'].includes(target.hostname) || !target.pathname.endsWith('_test'))
  throw new Error('local test only');
target.pathname = '/aiwb_perf_test';
process.env['DATABASE_URL'] = target.toString();
process.env['LOG_LEVEL'] = 'error';
process.env['TRANSFER_WORKER_ENABLED'] = 'false';
process.env['MAINTENANCE_WORKER_ENABLED'] = 'false';
process.env['TRANSFER_STORAGE_DIR'] = resolve('../../.data/perf-transfers');
const { NestFactory } = await import('@nestjs/core'),
  { AppModule } = await import('../src/app.module.js'),
  { PrismaService } = await import('../src/common/prisma.module.js'),
  { TransfersService } = await import('../src/modules/transfers/transfers.module.js'),
  { ImportsService } = await import('../src/modules/transfers/imports.module.js'),
  { ImportCommitService } = await import('../src/modules/transfers/import-commit.js');
const app = await NestFactory.create(AppModule, { logger: ['error'] });
await app.init();
const db = app.get(PrismaService).db,
  exports = app.get(TransfersService),
  imports = app.get(ImportsService),
  commit = app.get(ImportCommitService);
let peak = 0;
const timer = setInterval(() => {
  peak = Math.max(peak, process.memoryUsage().rss);
}, 50);
try {
  const user = await db.user.findUniqueOrThrow({
      where: { emailNormalized: 'perf-a@integration.test' },
    }),
    space = await db.workspace.findFirstOrThrow({ where: { createdBy: user.id, name: 'perf-a' } }),
    times: number[] = [];
  let file = '';
  for (let i = 0; i < Number(process.env['EXPORT_SAMPLES'] ?? 3); i++) {
    const at = performance.now(),
      job = await exports.create(
        space.id,
        user.id,
        'owner',
        { format: 'json', includeTrash: false },
        'perf-export-' + Date.now() + '-' + i,
      );
    await exports.tick(job.id);
    const saved = await db.transferJob.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(saved.state, 'succeeded');
    times.push(performance.now() - at);
    file = exports.path(saved.fileRef!);
    console.log(
      JSON.stringify({ phase: 'export', sample: i + 1, ms: times.at(-1), counts: saved.counts }),
    );
  }
  if (process.env['SKIP_IMPORT'] === 'true') {
    await app.close();
    clearInterval(timer);
    process.exit(0);
  }
  const dest = await db.workspace.create({
    data: { createdBy: user.id, name: '完整数据导入压测', timezone: 'Asia/Shanghai' },
  });
  await db.workspaceMember.create({
    data: { workspaceId: dest.id, userId: user.id, role: 'owner' },
  });
  let at = performance.now();
  const preview = await imports.upload(
    dest.id,
    user.id,
    undefined,
    'perf-full-preview-' + Date.now(),
    createReadStream(file),
  );
  const previewMs = performance.now() - at;
  assert.equal(preview.state, 'preview_ready');
  console.log(JSON.stringify({ phase: 'preview', ms: previewMs, counts: preview.counts }));
  at = performance.now();
  await commit.prepare(
    dest.id,
    user.id,
    preview.id,
    { planHash: preview.planHash!, confirm: true, decisions: [] },
    'perf-full-commit',
  );
  const prepareMs = performance.now() - at;
  at = performance.now();
  await commit.apply(preview.id);
  const commitMs = performance.now() - at,
    finished = await db.transferJob.findUniqueOrThrow({ where: { id: preview.id } });
  assert.equal(finished.state, 'succeeded');
  assert.equal(await db.entry.count({ where: { workspaceId: dest.id } }), 10000);
  assert.equal(await db.task.count({ where: { workspaceId: dest.id } }), 50000);
  assert.equal(await db.ledgerRecord.count({ where: { workspaceId: dest.id } }), 50000);
  const sorted = times.slice().sort((a, b) => a - b),
    report = {
      result: 'passed',
      timestamp: new Date().toISOString(),
      export: {
        samples: 3,
        ms: times,
        p50: sorted[1],
        p95: sorted[2],
        p99: sorted[2],
        note: '仅3个大作业样本，不宣称统计稳定性',
      },
      previewMs,
      prepareMs,
      commitMs,
      counts: finished.counts,
      peakRssMiB: peak / 1048576,
      sourceWorkspace: space.id,
      targetWorkspace: dest.id,
      concurrentScenario: '与20并发读写压测共享本机PostgreSQL；不修改两个基准空间的原实体',
    };
  await writeFile(
    resolve('../../全栈开发任务/验收证据/FS041/job-load.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  clearInterval(timer);
  await app.close();
}
