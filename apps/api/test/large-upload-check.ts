import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createTestContext } from './test-context.js';
process.env['TRANSFER_WORKER_ENABLED'] = 'false';
process.env['TRANSFER_STORAGE_DIR'] = resolve('../../.data/f41-stream');
const ctx = await createTestContext();
let peak = process.memoryUsage().rss;
const timer = setInterval(() => {
  peak = Math.max(peak, process.memoryUsage().rss);
}, 20);
try {
  const { ImportsService } = await import('../src/modules/transfers/imports.module.js'),
    service = ctx.app.get(ImportsService),
    owner = await ctx.owner('large-upload'),
    initial = process.memoryUsage().rss,
    started = Date.now();
  const chunk = Buffer.alloc(128 * 1024, 32);
  let produced = 0;
  async function* source() {
    for (let i = 0; i < 4097; i++) {
      produced += chunk.length;
      yield chunk;
    }
  }
  let code = '';
  try {
    await service.upload(owner.workspaceId, owner.userId, 'large', 'large-stream', source());
  } catch (error) {
    code = (error as { code?: string }).code ?? '';
  }
  assert.equal(code, 'PAYLOAD_TOO_LARGE');
  assert.equal(
    await ctx.prisma.transferJob.count({ where: { workspaceId: owner.workspaceId } }),
    0,
  );
  assert.equal((await readdir(service.transfers.storage)).length, 0);
  assert.ok(peak - initial < 128 * 1024 * 1024, '流式上传不得整体载入512MiB');
  console.log(
    JSON.stringify({
      result: 'passed',
      producedBytes: produced,
      limitBytes: 512 * 1024 * 1024,
      ms: Date.now() - started,
      peakRssMiB: peak / 1048576,
      rssGrowthMiB: (peak - initial) / 1048576,
      checks: [
        '513thMiB rejected',
        'no job created',
        'partial file deleted',
        'RSS growth below128MiB',
      ],
    }),
  );
} finally {
  clearInterval(timer);
  await ctx.close();
}
