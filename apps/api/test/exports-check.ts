import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, copyFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createTestContext } from './test-context.js';
import { TransfersService } from '../src/modules/transfers/transfers.module.js';
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
  const owner = await ctx.owner('exports-owner'),
    other = await ctx.owner('exports-other'),
    viewer = await ctx.owner('exports-viewer'),
    editor = await ctx.owner('exports-editor');
  await ctx.prisma.workspaceMember.createMany({
    data: [
      { workspaceId: owner.workspaceId, userId: viewer.userId, role: 'viewer' },
      { workspaceId: owner.workspaceId, userId: editor.userId, role: 'editor' },
    ],
  });
  const project = await ctx.prisma.project.create({
    data: {
      workspaceId: owner.workspaceId,
      createdBy: owner.userId,
      name: '标题: "YAML"\n测试',
      nextStep: '验收',
    },
  });
  const task = await ctx.prisma.task.create({
    data: {
      workspaceId: owner.workspaceId,
      createdBy: owner.userId,
      projectId: project.id,
      title: 'v0',
    },
  });
  const entry = await ctx.prisma.entry.create({
    data: {
      workspaceId: owner.workspaceId,
      createdBy: owner.userId,
      projectId: project.id,
      title: '安全元信息\n---',
      body: 'v0',
    },
  });
  await ctx.prisma.taskEntry.create({
    data: { workspaceId: owner.workspaceId, taskId: task.id, entryId: entry.id },
  });
  await ctx.prisma.entryRevision.create({
    data: {
      workspaceId: owner.workspaceId,
      entryId: entry.id,
      body: '历史',
      savedBy: owner.userId,
      sourceVersion: 1,
    },
  });
  await ctx.prisma.entryUsage.create({
    data: { workspaceId: owner.workspaceId, entryId: entry.id, useCount: 7 },
  });
  await ctx.prisma.developmentLog.createMany({
    data: Array.from({ length: 650 }, (_, i) => ({
      workspaceId: owner.workspaceId,
      authorId: owner.userId,
      logDate: new Date('2026-01-01'),
      text: '导出日志' + i,
    })),
  });
  const route = '/workspaces/' + owner.workspaceId;
  const service = ctx.app.get(TransfersService);
  const result = await ctx.call('POST', route + '/exports', {
    ...owner,
    key: 'export-json-1',
    body: { format: 'json' },
  });
  const id = (result.json['data'] as { id: string }).id;
  check(
    '创建持久排队job',
    result.status === 202 &&
      (await ctx.prisma.transferJob.findUniqueOrThrow({ where: { id } })).state === 'queued',
  );
  const replay = await ctx.call('POST', route + '/exports', {
    ...owner,
    key: 'export-json-1',
    body: { format: 'json' },
  });
  check(
    '同key不重复job',
    (replay.json['data'] as { id: string }).id === id &&
      (await ctx.prisma.transferJob.count()) === 1,
  );
  check(
    'Viewer不能导出',
    (
      await ctx.call('POST', route + '/exports', {
        ...viewer,
        key: 'view',
        body: { format: 'json' },
      })
    ).status === 403,
  );
  check(
    'Editor含回收站拒绝',
    (
      await ctx.call('POST', route + '/exports', {
        ...editor,
        key: 'trash',
        body: { format: 'json', includeTrash: true },
      })
    ).status === 403,
  );
  let running = true,
    edits = 0;
  const writer = (async () => {
    while (running) {
      const v = 'v' + (edits % 2);
      await ctx.prisma.$transaction([
        ctx.prisma.task.update({ where: { id: task.id }, data: { title: v } }),
        ctx.prisma.entry.update({ where: { id: entry.id }, data: { body: v } }),
      ]);
      edits++;
      await new Promise((r) => setTimeout(r, 2));
    }
  })();
  await service.tick();
  running = false;
  await writer;
  const job = await ctx.prisma.transferJob.findUniqueOrThrow({ where: { id } });
  check('worker完整文件后成功', job.state === 'succeeded' && job.fileRef !== null);
  const body = await readFile(service.path(job.fileRef!));
  const json = JSON.parse(body.toString()) as {
    schemaVersion: number;
    tasks: { title: string }[];
    entries: { body: string; revisions: unknown[]; usage: { useCount: number } }[];
    logs: unknown[];
    taskEntries: unknown[];
  };
  check('持续并发编辑下快照一致', edits > 0 && json.tasks[0]?.title === json.entries[0]?.body);
  check(
    '包含全部日志关系修订统计',
    json.logs.length === 650 &&
      json.taskEntries.length === 1 &&
      json.entries[0]?.usage.useCount === 7 &&
      json.entries[0]?.revisions.length === 1,
  );
  check(
    '没有身份/会话/密码密钥字段',
    json.schemaVersion === 2 &&
      !body
        .toString()
        .match(/passwordHash|sessionToken|emailNormalized|createdBy|authorId|savedBy/),
  );
  check('文件hash一致', job.fileHash === createHash('sha256').update(body).digest('hex'));
  const cookies = (jar: Record<string, string>) =>
    Object.entries(jar)
      .map(([k, v]) => k + '=' + encodeURIComponent(v))
      .join('; ');
  check(
    '认证下载实际文件',
    (
      await fetch(ctx.base + route + '/transfers/' + id + '/download', {
        headers: { cookie: cookies(owner.jar) },
      })
    ).status === 200,
  );
  check(
    '跨空间猜job404',
    (await ctx.call('GET', '/workspaces/' + other.workspaceId + '/transfers/' + id, other))
      .status === 404,
  );
  check(
    '同空间非创建Editor404',
    (await ctx.call('GET', route + '/transfers/' + id, editor)).status === 404,
  );
  const md = await ctx.call('POST', route + '/exports', {
    ...owner,
    key: 'md',
    body: { format: 'markdown' },
  });
  await service.tick();
  const mdJob = await ctx.prisma.transferJob.findUniqueOrThrow({
    where: { id: (md.json['data'] as { id: string }).id },
  });
  const mdBody = await readFile(service.path(mdJob.fileRef!), 'utf8');
  check(
    'Markdown安全JSON元信息',
    mdBody.includes('标题: \\"YAML\\"\\n测试'.replaceAll('\\\\', '\\')) ||
      mdBody.includes(JSON.stringify(project.name)),
  );
  const recovery = await ctx.prisma.transferJob.create({
    data: {
      workspaceId: owner.workspaceId,
      actorId: owner.userId,
      type: 'export_json',
      state: 'running',
      attempts: 1,
      leaseUntil: new Date(Date.now() - 10000),
      expiresAt: new Date(Date.now() + 60000),
    },
  });
  await service.tick();
  const recovered = await ctx.prisma.transferJob.findUniqueOrThrow({ where: { id: recovery.id } });
  check(
    '模拟worker重启过期租约可重领',
    recovered.state === 'succeeded' && recovered.attempts === 2,
  );
  await ctx.prisma.transferJob.update({
    where: { id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  await service.cleanup();
  const expired = await ctx.prisma.transferJob.findUniqueOrThrow({ where: { id } });
  check('过期24h清理受控文件', expired.state === 'expired' && expired.fileRef === null);
  const evidence = resolve(process.env['TEST_EVIDENCE_DIR'] ?? '../../.data/export-fixtures');
  await mkdir(evidence, { recursive: true });
  await copyFile(service.path(mdJob.fileRef!), resolve(evidence, 'sample.md'));
  await copyFile(service.path(recovered.fileRef!), resolve(evidence, 'sample.json'));
  console.log('合计 ' + checks + ' 项通过；并发事务编辑次数 ' + edits);
} finally {
  await ctx.close();
}
