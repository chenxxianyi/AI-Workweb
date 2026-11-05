import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createTestContext } from './test-context.js';
import { TransfersService } from '../src/modules/transfers/transfers.module.js';
import { ImportsService } from '../src/modules/transfers/imports.module.js';
import { ImportCommitService } from '../src/modules/transfers/import-commit.js';
process.env['TRANSFER_WORKER_ENABLED'] = 'false';
process.env['TRANSFER_STORAGE_DIR'] = resolve('../../.data/transfers-test');
const ctx = await createTestContext();
let checks = 0;
const check = (n: string, v: boolean) => {
  assert.ok(v, n);
  checks++;
  console.log('PASS ' + n);
};
try {
  const source = await ctx.owner('roundtrip-source'),
    target = await ctx.owner('roundtrip-target'),
    exports = ctx.app.get(TransfersService),
    imports = ctx.app.get(ImportsService),
    commit = ctx.app.get(ImportCommitService);
  const project = await ctx.prisma.project.create({
    data: {
      workspaceId: source.workspaceId,
      createdBy: source.userId,
      name: '往返项目',
      nextStep: '保留业务字段',
      stack: ['TypeScript'],
      repo: 'https://example.test/repo',
      progressManual: true,
      manualProgress: 45,
      color: '#123456',
    },
  });
  const task = await ctx.prisma.task.create({
    data: {
      workspaceId: source.workspaceId,
      createdBy: source.userId,
      projectId: project.id,
      title: '中文往返任务',
      priority: 'p0',
      status: 'done',
      dueDate: new Date('2026-01-01'),
      doneAt: new Date('2026-01-01T03:00:00Z'),
      aiContext: '上下文',
      blocker: '卡点',
    },
  });
  const entry = await ctx.prisma.entry.create({
    data: {
      workspaceId: source.workspaceId,
      createdBy: source.userId,
      projectId: project.id,
      title: '往返知识',
      summary: '摘要',
      body: '## 中文\n<script>保持原文不执行</script>\n```ts\nconst a=1\n```',
      type: 'design',
      status: 'verified',
      lang: 'typescript',
      source: 'manual',
      rating: 4,
      originMetadata: { legacySource: 'old-file' },
    },
  });
  await ctx.prisma.taskEntry.create({
    data: { workspaceId: source.workspaceId, taskId: task.id, entryId: entry.id },
  });
  const tag = await ctx.prisma.tag.create({
    data: { workspaceId: source.workspaceId, displayName: '网络', nameNormalized: '网络' },
  });
  await ctx.prisma.entryTag.create({
    data: { workspaceId: source.workspaceId, entryId: entry.id, tagId: tag.id },
  });
  await ctx.prisma.entryUsage.create({
    data: {
      workspaceId: source.workspaceId,
      entryId: entry.id,
      useCount: 17,
      lastUsedAt: new Date('2026-01-02T03:00:00Z'),
    },
  });
  await ctx.prisma.entryRevision.createMany({
    data: [1, 2].map((n) => ({
      workspaceId: source.workspaceId,
      entryId: entry.id,
      savedBy: source.userId,
      body: '历史正文' + n,
      savedAt: new Date('2026-01-0' + n + 'T00:00:00Z'),
      sourceVersion: n,
    })),
  });
  await ctx.prisma.developmentLog.createMany({
    data: [1, 2].map(() => ({
      workspaceId: source.workspaceId,
      authorId: source.userId,
      logDate: new Date('2026-01-01'),
      text: '相同日志文本',
    })),
  });
  await ctx.prisma.ledgerRecord.create({
    data: {
      workspaceId: source.workspaceId,
      createdBy: source.userId,
      projectId: project.id,
      entryId: entry.id,
      recordDate: new Date('2026-01-01'),
      tool: 'codex',
      scene: 'review',
      minutes: 20,
      savedMinutes: 0,
      effect: 3,
      note: '保持全零节省',
    },
  });
  async function exportJSON(ws: typeof source, key: string) {
    const job = await exports.create(
      ws.workspaceId,
      ws.userId,
      'owner',
      { format: 'json', schemaVersion: 2, includeTrash: false },
      key,
    );
    await exports.tick(job.id);
    const row = await ctx.prisma.transferJob.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(row.state, 'succeeded');
    const text = await readFile(exports.path(row.fileRef!), 'utf8');
    return { text, data: JSON.parse(text) as Record<string, unknown> };
  }
  const before = await exportJSON(source, 'roundtrip-before');
  const preview = await imports.upload(
    target.workspaceId,
    target.userId,
    undefined,
    'roundtrip-preview',
    Readable.from([before.text]),
  );
  const ns = 'workspace:' + source.workspaceId;
  await commit.prepare(
    target.workspaceId,
    target.userId,
    preview.id,
    { planHash: preview.planHash!, confirm: true, decisions: [] },
    'roundtrip-commit',
  );
  await commit.apply(preview.id);
  check(
    '空目标空间导入完成',
    (await ctx.prisma.transferJob.findUniqueOrThrow({ where: { id: preview.id } })).state ===
      'succeeded',
  );
  const after = await exportJSON(target, 'roundtrip-after'),
    maps = await ctx.prisma.importEntityMapping.findMany({
      where: { workspaceId: target.workspaceId, sourceNamespace: ns },
    }),
    reverse = new Map(maps.map((m) => [m.entityId, m.legacyId]));
  const business = (r: Record<string, unknown>, remap: boolean) => {
    const {
      id,
      createdAt: _ca,
      updatedAt: _ua,
      version: _v,
      originMetadata: _om,
      lastActivityAt: _la,
      ...fields
    } = r;
    return {
      id: remap ? reverse.get(String(id)) : id,
      ...fields,
      ...('projectId' in fields
        ? {
            projectId: fields['projectId']
              ? remap
                ? reverse.get(String(fields['projectId']))
                : fields['projectId']
              : null,
          }
        : {}),
      ...('entryId' in fields
        ? {
            entryId: fields['entryId']
              ? remap
                ? reverse.get(String(fields['entryId']))
                : fields['entryId']
              : null,
          }
        : {}),
    };
  };
  for (const table of ['projects', 'tasks', 'entries', 'logs', 'ledger']) {
    const a = (before.data[table] as Record<string, unknown>[])
        .map((r) => business(r, false))
        .sort((a, b) => String(a.id).localeCompare(String(b.id))),
      b = (after.data[table] as Record<string, unknown>[])
        .map((r) => business(r, true))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    assert.deepEqual(b, a);
    check(table + '全部业务字段逐项一致', true);
  }
  const links = (after.data['taskEntries'] as { taskId: string; entryId: string }[]).map((l) => ({
    taskId: reverse.get(l.taskId),
    entryId: reverse.get(l.entryId),
  }));
  assert.deepEqual(links, before.data['taskEntries']);
  check('任务知识关系映射无断链', true);
  const sourceEntries = before.data['entries'] as {
      id: string;
      createdAt: string;
      updatedAt: string;
    }[],
    targetEntry = await ctx.prisma.entry.findFirstOrThrow({
      where: { workspaceId: target.workspaceId },
    });
  const origin = targetEntry.originMetadata as {
    sourceCreatedAt: string;
    sourceUpdatedAt: string;
    legacySource: string;
  };
  check(
    '来源时间及原来源元信息保留',
    origin.sourceCreatedAt === sourceEntries[0]!.createdAt &&
      origin.sourceUpdatedAt === sourceEntries[0]!.updatedAt &&
      origin.legacySource === 'old-file',
  );
  check(
    'ID版本与服务器时间单独重建',
    targetEntry.id !== entry.id &&
      targetEntry.version === 1 &&
      targetEntry.createdAt >= entry.createdAt &&
      targetEntry.createdBy === target.userId,
  );
  const again = await imports.upload(
    target.workspaceId,
    target.userId,
    undefined,
    'roundtrip-repeat-preview',
    Readable.from([before.text]),
  );
  await commit.prepare(
    target.workspaceId,
    target.userId,
    again.id,
    { planHash: again.planHash!, confirm: true, decisions: [] },
    'roundtrip-repeat-commit',
  );
  await commit.apply(again.id);
  check(
    '重复往返无重复日志实体关系与修订',
    (await ctx.prisma.developmentLog.count({ where: { workspaceId: target.workspaceId } })) === 2 &&
      (await ctx.prisma.taskEntry.count({ where: { workspaceId: target.workspaceId } })) === 1 &&
      (await ctx.prisma.entryRevision.count({ where: { workspaceId: target.workspaceId } })) === 2,
  );
  console.log(
    '合计 ' +
      checks +
      ' 项，全部通过；排除运行字段id/version/服务器创建更新时间/job状态，逐项比较其余全部业务值。',
  );
} finally {
  await ctx.close();
}
