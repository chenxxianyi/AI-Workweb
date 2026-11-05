import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { createTestContext } from './test-context.js';
import { MaintenanceService } from '../src/modules/maintenance/maintenance.module.js';
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
  const owner = await ctx.owner('maintenance-owner'),
    other = await ctx.owner('maintenance-other'),
    viewer = await ctx.owner('maintenance-viewer');
  await ctx.prisma.workspaceMember.create({
    data: { workspaceId: owner.workspaceId, userId: viewer.userId, role: 'viewer' },
  });
  const base = '/workspaces/' + owner.workspaceId,
    service = ctx.app.get(MaintenanceService);
  const p = await ctx.prisma.project.create({
    data: {
      workspaceId: owner.workspaceId,
      createdBy: owner.userId,
      name: '删除父项目',
      nextStep: '维护',
      deletedAt: new Date(),
      version: 2,
    },
  });
  const task = await ctx.prisma.task.create({
    data: {
      workspaceId: owner.workspaceId,
      createdBy: owner.userId,
      title: '恢复任务',
      projectId: p.id,
      deletedAt: new Date(),
      version: 2,
    },
  });
  const entry = await ctx.prisma.entry.create({
    data: {
      workspaceId: owner.workspaceId,
      createdBy: owner.userId,
      title: '恢复知识',
      body: '正文不应进入审计-SENTINEL',
      projectId: p.id,
      deletedAt: new Date(),
      version: 2,
    },
  });
  await ctx.prisma.taskEntry.create({
    data: { workspaceId: owner.workspaceId, taskId: task.id, entryId: entry.id },
  });
  check(
    'Viewer不能读回收站或审计',
    (await ctx.call('GET', base + '/trash', viewer)).status === 403 &&
      (await ctx.call('GET', base + '/audit-events', viewer)).status === 403,
  );
  check(
    '恢复缺IfMatch428',
    (await ctx.call('POST', base + '/trash/task/' + task.id + '/restore', { ...owner, body: {} }))
      .status === 428,
  );
  const restored = await ctx.call('POST', base + '/trash/task/' + task.id + '/restore', {
    ...owner,
    version: 2,
    body: {},
  });
  check(
    '恢复任务不复活已删项目',
    restored.status === 201 &&
      (await ctx.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).projectId === null &&
      (await ctx.prisma.project.findUniqueOrThrow({ where: { id: p.id } })).deletedAt !== null,
  );
  check('恢复清除无效知识关系', (await ctx.prisma.taskEntry.count()) === 0);
  check(
    '恢复知识清除失效项目',
    (
      await ctx.call('POST', base + '/trash/entry/' + entry.id + '/restore', {
        ...owner,
        version: 2,
        body: {},
      })
    ).status === 201 &&
      (await ctx.prisma.entry.findUniqueOrThrow({ where: { id: entry.id } })).projectId === null,
  );
  const child = await ctx.prisma.task.create({
    data: {
      workspaceId: owner.workspaceId,
      createdBy: owner.userId,
      title: '保留子任务',
      projectId: p.id,
    },
  });
  const ledger = await ctx.prisma.ledgerRecord.create({
    data: {
      workspaceId: owner.workspaceId,
      createdBy: owner.userId,
      recordDate: new Date('2026-01-01'),
      projectId: p.id,
      entryId: entry.id,
      tool: 'codex',
      scene: 'review',
      minutes: 10,
      savedMinutes: 20,
      effect: 4,
    },
  });
  check(
    '硬删必须确认',
    (
      await ctx.call('DELETE', base + '/trash/project/' + p.id, {
        ...owner,
        key: 'unconfirmed',
        version: 2,
        body: { confirm: false },
      })
    ).status === 422,
  );
  const removed = await ctx.call('DELETE', base + '/trash/project/' + p.id, {
    ...owner,
    key: 'purge-project',
    version: 2,
    body: { confirm: true },
  });
  check(
    '硬删父项目保留子记录并置空引用',
    removed.status === 200 &&
      (await ctx.prisma.task.findUniqueOrThrow({ where: { id: child.id } })).projectId === null &&
      (await ctx.prisma.task.findUniqueOrThrow({ where: { id: child.id } })).version === 2 &&
      (await ctx.prisma.ledgerRecord.findUniqueOrThrow({ where: { id: ledger.id } })).projectId ===
        null,
  );
  check(
    '硬删同key可重放',
    (
      await ctx.call('DELETE', base + '/trash/project/' + p.id, {
        ...owner,
        key: 'purge-project',
        version: 2,
        body: { confirm: true },
      })
    ).status === 200,
  );
  await ctx.prisma.entryUsage.create({
    data: { workspaceId: owner.workspaceId, entryId: entry.id, useCount: 2 },
  });
  await ctx.prisma.entryRevision.create({
    data: {
      workspaceId: owner.workspaceId,
      entryId: entry.id,
      savedBy: owner.userId,
      body: '历史',
      sourceVersion: 1,
    },
  });
  await ctx.prisma.entry.update({
    where: { id: entry.id },
    data: { deletedAt: new Date(), version: { increment: 1 } },
  });
  check(
    '硬删知识清理计数修订并解除台账引用',
    (
      await ctx.call('DELETE', base + '/trash/entry/' + entry.id, {
        ...owner,
        key: 'purge-entry',
        version: 4,
        body: { confirm: true },
      })
    ).status === 200 &&
      (await ctx.prisma.entryUsage.count()) === 0 &&
      (await ctx.prisma.entryRevision.count()) === 0 &&
      (await ctx.prisma.ledgerRecord.findUniqueOrThrow({ where: { id: ledger.id } })).entryId ===
        null,
  );
  const now = new Date(),
    deadline = new Date(now.getTime() - 30 * 86400000);
  await ctx.prisma.developmentLog.createMany({
    data: [
      {
        workspaceId: owner.workspaceId,
        authorId: owner.userId,
        logDate: new Date('2026-01-01'),
        text: '到期',
        deletedAt: deadline,
      },
      {
        workspaceId: owner.workspaceId,
        authorId: owner.userId,
        logDate: new Date('2026-01-01'),
        text: '未到期',
        deletedAt: new Date(deadline.getTime() + 1),
      },
    ],
  });
  check(
    '恰好30天清理，差1ms保留',
    (await service.purgeExpired(now)).purged === 1 &&
      (await ctx.prisma.developmentLog.count({ where: { workspaceId: owner.workspaceId } })) ===
        1 &&
      (await ctx.prisma.auditEvent.count({
        where: { workspaceId: owner.workspaceId, action: 'trash.expired' },
      })) === 1,
  );
  check(
    '最后Owner降权/移除受保护',
    (
      await ctx.call('PATCH', base + '/members/' + owner.userId, {
        ...owner,
        version: 1,
        body: { role: 'viewer' },
      })
    ).status === 409 &&
      (await ctx.call('DELETE', base + '/members/' + owner.userId, owner)).status === 409,
  );
  const invite = await ctx.call('POST', base + '/invitations', {
    ...owner,
    body: { email: 'invite-maintenance@integration.test', role: 'viewer' },
  });
  const token = (invite.json['data'] as { token: string }).token;
  check(
    '邀请列表不暴露token',
    invite.status === 201 &&
      !JSON.stringify((await ctx.call('GET', base + '/invitations', owner)).json).includes(token),
  );
  const foreign = await ctx.prisma.project.create({
    data: {
      workspaceId: other.workspaceId,
      createdBy: other.userId,
      name: '其他空间保留',
      nextStep: '不动',
    },
  });
  const imports = ctx.app.get(ImportsService),
    commit = ctx.app.get(ImportCommitService);
  const preview = await imports.upload(
    owner.workspaceId,
    owner.userId,
    'before-clear',
    'old-preview',
    Readable.from([
      JSON.stringify({
        schema: 1,
        projects: [{ id: 'old-create', name: '不得清空后复活', stage: '开发', nextStep: '停止' }],
      }),
    ]),
  );
  await commit.prepare(
    owner.workspaceId,
    owner.userId,
    preview.id,
    { planHash: preview.planHash!, confirm: true, decisions: [] },
    'queue-before-clear',
  );
  const clearBody = {
    confirmName: 'maintenance-owner',
    backupAcknowledged: true,
    password: 'Disposable-Integration-2026',
  };
  await ctx.prisma.project.create({
    data: {
      workspaceId: owner.workspaceId,
      createdBy: owner.userId,
      name: '清空回滚项目',
      nextStep: '保留',
    },
  });
  await ctx.prisma.$executeRawUnsafe('CREATE SEQUENCE qa_clear_trigger_hits');
  await ctx.prisma.$executeRawUnsafe(
    "CREATE OR REPLACE FUNCTION qa_clear_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM nextval('qa_clear_trigger_hits'); RAISE EXCEPTION 'qa final delete failure'; END; $$",
  );
  await ctx.prisma.$executeRawUnsafe(
    'CREATE TRIGGER qa_clear_delete BEFORE DELETE ON projects FOR EACH ROW EXECUTE FUNCTION qa_clear_fail()',
  );
  let rolledBack = false;
  try {
    await service.clear(owner.workspaceId, owner.userId, 1, 'clear-rollback', clearBody);
  } catch {
    rolledBack = true;
  }
  const faultHits = await ctx.prisma.$queryRawUnsafe<{ is_called: boolean }[]>(
    'SELECT is_called FROM qa_clear_trigger_hits',
  );
  check(
    '清空故障确实发生于最后项目删除且全部回滚',
    rolledBack &&
      faultHits[0]?.is_called === true &&
      (await ctx.prisma.task.count({ where: { workspaceId: owner.workspaceId } })) === 2 &&
      (await ctx.prisma.ledgerRecord.count({ where: { workspaceId: owner.workspaceId } })) === 1 &&
      (await ctx.prisma.workspace.findUniqueOrThrow({ where: { id: owner.workspaceId } }))
        .version === 1,
  );
  await ctx.prisma.$executeRawUnsafe('DROP TRIGGER qa_clear_delete ON projects');
  check(
    '清空未确认备份拒绝',
    (
      await ctx.call('POST', base + '/maintenance/clear', {
        ...owner,
        key: 'clear-ack',
        version: 1,
        body: { ...clearBody, backupAcknowledged: false },
      })
    ).status === 422,
  );
  check(
    '清空重新认证失败不改变业务',
    (
      await ctx.call('POST', base + '/maintenance/clear', {
        ...owner,
        key: 'clear-password',
        version: 1,
        body: { ...clearBody, password: 'wrong-password' },
      })
    ).status === 401 &&
      (await ctx.prisma.task.count({ where: { workspaceId: owner.workspaceId } })) === 2,
  );
  check(
    '清空名称不符拒绝',
    (
      await ctx.call('POST', base + '/maintenance/clear', {
        ...owner,
        key: 'clear-name',
        version: 1,
        body: { ...clearBody, confirmName: 'wrong' },
      })
    ).status === 422,
  );
  const clear = await ctx.call('POST', base + '/maintenance/clear', {
    ...owner,
    key: 'clear-good',
    version: 1,
    body: clearBody,
  });
  check(
    '只清空当前空间业务',
    clear.status === 201 &&
      (await ctx.prisma.task.count({ where: { workspaceId: owner.workspaceId } })) === 0 &&
      (await ctx.prisma.ledgerRecord.count({ where: { workspaceId: owner.workspaceId } })) === 0 &&
      (await ctx.prisma.project.count({ where: { id: foreign.id } })) === 1,
  );
  check(
    '账号成员空间审计保留',
    (await ctx.prisma.user.count()) === 3 &&
      (await ctx.prisma.workspaceMember.count({ where: { workspaceId: owner.workspaceId } })) ===
        2 &&
      (await ctx.prisma.workspace.count()) === 3 &&
      (await ctx.prisma.auditEvent.count({
        where: { workspaceId: owner.workspaceId, action: 'workspace.cleared' },
      })) === 1,
  );
  await commit.apply(preview.id);
  check(
    '清空前排队导入计划失效不能复活数据',
    (await ctx.prisma.transferJob.findUniqueOrThrow({ where: { id: preview.id } })).errorCode ===
      'PLAN_STALE' &&
      (await ctx.prisma.project.count({ where: { workspaceId: owner.workspaceId } })) === 0,
  );
  const post = await ctx.prisma.project.create({
    data: {
      workspaceId: owner.workspaceId,
      createdBy: owner.userId,
      name: '清空后新数据',
      nextStep: '保留',
    },
  });
  const replay = await ctx.call('POST', base + '/maintenance/clear', {
    ...owner,
    key: 'clear-good',
    version: 1,
    body: clearBody,
  });
  check(
    '清空原key重放不删除之后新数据',
    replay.status === 201 &&
      (replay.json['data'] as { replayed: boolean }).replayed &&
      (await ctx.prisma.project.count({ where: { id: post.id } })) === 1,
  );
  const audit = await ctx.call('GET', base + '/audit-events?limit=1', owner);
  const cursor = (audit.json['data'] as { nextCursor: string }).nextCursor;
  check(
    '审计筛选绑定分页',
    (
      await ctx.call(
        'GET',
        base + '/audit-events?limit=1&action=trash.restored&cursor=' + cursor,
        owner,
      )
    ).status === 400,
  );
  const all = JSON.stringify((await ctx.call('GET', base + '/audit-events?limit=100', owner)).json);
  check(
    '审计无密码令牌和整篇正文',
    !all.includes(clearBody.password) &&
      !all.includes(token) &&
      !all.includes('正文不应进入审计-SENTINEL') &&
      !all.includes('passwordHash'),
  );
  console.log('合计 ' + checks + ' 项，全部通过；破坏性检查仅运行于已验证的本机*_test数据库。');
} finally {
  await ctx.prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS qa_clear_delete ON projects');
  await ctx.prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS qa_clear_fail()');
  await ctx.prisma.$executeRawUnsafe('DROP SEQUENCE IF EXISTS qa_clear_trigger_hits');
  await ctx.close();
}
