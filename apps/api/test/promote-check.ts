import assert from 'node:assert/strict';
import { createTestContext } from './test-context.js';
const ctx = await createTestContext();
let checks = 0;
const check = (name: string, ok: boolean): void => {
  assert.ok(ok, name);
  checks++;
  console.log('PASS ' + name);
};
try {
  const owner = await ctx.owner('promote-owner'),
    other = await ctx.owner('promote-other'),
    viewer = await ctx.owner('promote-viewer');
  await ctx.prisma.workspaceMember.create({
    data: { workspaceId: owner.workspaceId, userId: viewer.userId, role: 'viewer' },
  });
  const project = await ctx.prisma.project.create({
    data: {
      workspaceId: owner.workspaceId,
      createdBy: owner.userId,
      name: '关联项目',
      nextStep: '完成验收',
    },
  });
  const task = await ctx.prisma.task.create({
    data: {
      workspaceId: owner.workspaceId,
      createdBy: owner.userId,
      title: '修复SSE断连',
      blocker: '重试会重复写入',
      projectId: project.id,
    },
  });
  const route = '/workspaces/' + owner.workspaceId + '/tasks/' + task.id + '/promote';
  const first = await ctx.call('POST', route, { ...owner, key: 'promote-1', version: 1, body: {} });
  check('沉淀成功201', first.status === 201);
  const result = first.json['data'] as { entryId: string; taskVersion: number };
  const entry = await ctx.prisma.entry.findUniqueOrThrow({ where: { id: result.entryId } });
  check(
    '草稿预填任务与卡点',
    entry.type === 'troubleshoot' &&
      entry.status === 'draft' &&
      entry.body.includes(task.title) &&
      entry.body.includes(task.blocker!),
  );
  check(
    '项目和任务关系一致',
    entry.projectId === project.id &&
      (await ctx.prisma.taskEntry.count({ where: { taskId: task.id, entryId: entry.id } })) === 1,
  );
  check('任务version递增', result.taskVersion === 2);
  const replay = await ctx.call('POST', route, {
    ...owner,
    key: 'promote-1',
    version: 1,
    body: {},
  });
  check(
    '同key重放不新建',
    (replay.json['data'] as { entryId: string; replayed: boolean }).entryId === entry.id &&
      (replay.json['data'] as { replayed: boolean }).replayed,
  );
  const again = await ctx.call('POST', route, {
    ...owner,
    key: 'promote-existing',
    version: 2,
    body: {},
  });
  check(
    '默认再次点击打开已有沉淀',
    (again.json['data'] as { created: boolean }).created === false &&
      (await ctx.prisma.entry.count({ where: { workspaceId: owner.workspaceId } })) === 1,
  );
  check(
    '缺版本428',
    (await ctx.call('POST', route, { ...owner, key: 'no-version', body: {} })).status === 428,
  );
  check(
    '旧版本412',
    (await ctx.call('POST', route, { ...owner, key: 'stale', version: 1, body: {} })).status ===
      412,
  );
  check(
    'Viewer不能沉淀',
    (await ctx.call('POST', route, { ...viewer, key: 'viewer', version: 2, body: {} })).status ===
      403,
  );
  check(
    '跨空间404',
    (
      await ctx.call(
        'POST',
        '/workspaces/' + other.workspaceId + '/tasks/' + task.id + '/promote',
        { ...other, key: 'cross', version: 2, body: {} },
      )
    ).status === 404,
  );
  const taskView = await ctx.call(
    'GET',
    '/workspaces/' + owner.workspaceId + '/tasks/' + task.id,
    owner,
  );
  check(
    '任务可回访知识',
    (taskView.json['data'] as { entries: { id: string }[] }).entries[0]?.id === entry.id,
  );
  const entryView = await ctx.call(
    'GET',
    '/workspaces/' + owner.workspaceId + '/entries/' + entry.id,
    owner,
  );
  check(
    '知识可回访任务',
    (entryView.json['data'] as { taskLinks: { id: string }[] }).taskLinks[0]?.id === task.id,
  );
  await ctx.prisma.$executeRawUnsafe(
    "CREATE OR REPLACE FUNCTION qa_promote_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'qa insertion failure'; END; $$",
  );
  await ctx.prisma.$executeRawUnsafe(
    'CREATE TRIGGER qa_promote_insert BEFORE INSERT ON task_entries FOR EACH ROW EXECUTE FUNCTION qa_promote_fail()',
  );
  const failed = await ctx.call('POST', route, {
    ...owner,
    key: 'rollback',
    version: 2,
    body: { newEntry: true },
  });
  check('关联写失败不成功', failed.status >= 400);
  check(
    '失败无孤立条目且CAS回滚',
    (await ctx.prisma.entry.count({ where: { workspaceId: owner.workspaceId } })) === 1 &&
      (await ctx.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).version === 2,
  );
  await ctx.prisma.$executeRawUnsafe('DROP TRIGGER qa_promote_insert ON task_entries');
  const retried = await ctx.call('POST', route, {
    ...owner,
    key: 'rollback',
    version: 2,
    body: { newEntry: true },
  });
  check(
    '失败重试同key可恢复',
    retried.status === 201 &&
      (await ctx.prisma.entry.count({ where: { workspaceId: owner.workspaceId } })) === 2,
  );
  console.log('合计 ' + checks + ' 项，全部通过');
} finally {
  await ctx.prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS qa_promote_insert ON task_entries');
  await ctx.prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS qa_promote_fail()');
  await ctx.close();
}
