import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { createTestContext } from './test-context.js';
import { ImportsService } from '../src/modules/transfers/imports.module.js';
import { ImportCommitService } from '../src/modules/transfers/import-commit.js';
import { deterministicId } from '../src/modules/transfers/import-format.js';
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
  const owner = await ctx.owner('commit-owner'),
    other = await ctx.owner('commit-other');
  const service = ctx.app.get(ImportsService),
    commit = ctx.app.get(ImportCommitService),
    route = '/workspaces/' + owner.workspaceId + '/imports';
  const fixture = {
    schema: 1,
    projects: [{ id: 'p', name: '导入项目', stage: '开发', nextStep: '继续' }],
    tasks: [
      {
        id: 't',
        title: '导入任务',
        projectId: 'p',
        priority: 'P1',
        status: 'done',
        entryIds: ['e'],
      },
    ],
    entries: [
      {
        id: 'e',
        title: '导入知识',
        summary: '摘要',
        body: '中文正文',
        type: 'pitfall',
        status: 'verified',
        tags: ['网络'],
        useCount: 4,
        lastUsedAt: 1767225600,
        revisions: [{ body: '历史1', at: 1767225500 }],
        projectId: 'p',
      },
    ],
    logs: [{ date: '2026-01-01', text: '开发进展', at: 1767225600 }],
    ledger: [
      {
        id: 'l',
        date: '2026-01-01',
        tool: 'codex',
        scene: '调试',
        minutes: 20,
        savedMinutes: 30,
        effect: 4,
        projectId: 'p',
        entryId: 'e',
      },
    ],
  };
  const preview = (ns: string, key: string, data: unknown = fixture) =>
    service.upload(owner.workspaceId, owner.userId, ns, key, Readable.from([JSON.stringify(data)]));
  const first = await preview('commit-source', 'one');
  check(
    '错误planHash409',
    (
      await ctx.call('POST', route + '/' + first.id + '/commit', {
        ...owner,
        key: 'bad-plan',
        body: { planHash: '0'.repeat(64), confirm: true },
      })
    ).status === 409,
  );
  const queued = await ctx.call('POST', route + '/' + first.id + '/commit', {
    ...owner,
    key: 'commit-one',
    body: { planHash: first.planHash, confirm: true },
  });
  check(
    '自动备份后排队202',
    queued.status === 202 && !!(queued.json['data'] as { backupId: string }).backupId,
  );
  await ctx.prisma.$executeRawUnsafe('CREATE SEQUENCE qa_import_trigger_hits');
  await ctx.prisma.$executeRawUnsafe(
    "CREATE OR REPLACE FUNCTION qa_import_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM nextval('qa_import_trigger_hits'); RAISE EXCEPTION 'qa import insertion failure'; END; $$",
  );
  await ctx.prisma.$executeRawUnsafe(
    'CREATE TRIGGER qa_import_insert BEFORE INSERT ON ledger_records FOR EACH ROW EXECUTE FUNCTION qa_import_fail()',
  );
  await commit.apply(first.id);
  const faultHit = await ctx.prisma.$queryRawUnsafe<{ is_called: boolean }[]>(
    'SELECT is_called FROM qa_import_trigger_hits',
  );
  check('故障确实发生在最后台账写入阶段', faultHit[0]?.is_called === true);
  check(
    '故障中途没有部分业务或映射',
    (await ctx.prisma.project.count()) === 0 &&
      (await ctx.prisma.task.count()) === 0 &&
      (await ctx.prisma.entry.count()) === 0 &&
      (await ctx.prisma.importEntityMapping.count()) === 0,
  );
  check(
    '失败可见且可重领',
    (await ctx.prisma.transferJob.findUniqueOrThrow({ where: { id: first.id } })).errorCode ===
      'INTERNAL_ERROR',
  );
  await ctx.prisma.$executeRawUnsafe('DROP TRIGGER qa_import_insert ON ledger_records');
  await commit.apply(first.id);
  const done = await ctx.prisma.transferJob.findUniqueOrThrow({ where: { id: first.id } });
  check('同job重领事务成功', done.state === 'succeeded' && done.attempts === 2);
  check(
    '实体关系全部持久化',
    (await ctx.prisma.project.count()) === 1 &&
      (await ctx.prisma.task.count()) === 1 &&
      (await ctx.prisma.entry.count()) === 1 &&
      (await ctx.prisma.developmentLog.count()) === 1 &&
      (await ctx.prisma.ledgerRecord.count()) === 1 &&
      (await ctx.prisma.taskEntry.count()) === 1,
  );
  const entryId = deterministicId(owner.workspaceId, 'commit-source', 'entry', 'e');
  const entry = await ctx.prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
  check(
    '目标作者空间由服务端写入',
    entry.workspaceId === owner.workspaceId &&
      entry.createdBy === owner.userId &&
      entry.originMetadata !== null,
  );
  check(
    'usage与修订持久化',
    (await ctx.prisma.entryUsage.findUniqueOrThrow({ where: { entryId } })).useCount === 4 &&
      (await ctx.prisma.entryRevision.count({ where: { entryId } })) === 1,
  );
  await commit.apply(first.id);
  const replay = await ctx.call('POST', route + '/' + first.id + '/commit', {
    ...owner,
    key: 'commit-one',
    body: { planHash: first.planHash, confirm: true },
  });
  check(
    '同job和同key不重复应用',
    replay.status === 202 &&
      (await ctx.prisma.entry.count()) === 1 &&
      (await ctx.prisma.entry.findUniqueOrThrow({ where: { id: entryId } })).version === 1,
  );
  check(
    '提交后不能取消冒充撤销',
    (await ctx.call('POST', route + '/' + first.id + '/cancel', owner)).status === 409,
  );
  const second = await preview('commit-source', 'two');
  await ctx.call('POST', route + '/' + second.id + '/commit', {
    ...owner,
    key: 'commit-two',
    body: { planHash: second.planHash, confirm: true },
  });
  await commit.apply(second.id);
  check(
    '同来源同文件重复导入不重复实体',
    (await ctx.prisma.entry.count()) === 1 &&
      (await ctx.prisma.developmentLog.count()) === 1 &&
      (await ctx.prisma.taskEntry.count()) === 1,
  );
  const newer = {
    ...fixture,
    entries: [{ ...fixture.entries[0], updatedAt: 1800000000, body: '新版来源', useCount: 2 }],
  };
  const stale = await preview('commit-source', 'stale', newer);
  await ctx.prisma.entry.update({
    where: { id: entryId },
    data: { body: '用户后续编辑', version: { increment: 1 } },
  });
  await ctx.call('POST', route + '/' + stale.id + '/commit', {
    ...owner,
    key: 'stale-commit',
    body: { planHash: stale.planHash, confirm: true },
  });
  await commit.apply(stale.id);
  check(
    '旧预览不覆盖后续编辑',
    (await ctx.prisma.transferJob.findUniqueOrThrow({ where: { id: stale.id } })).errorCode ===
      'PLAN_STALE' &&
      (await ctx.prisma.entry.findUniqueOrThrow({ where: { id: entryId } })).body ===
        '用户后续编辑',
  );
  const conflict = await preview('commit-source', 'conflict', newer);
  await ctx.call('POST', route + '/' + conflict.id + '/commit', {
    ...owner,
    key: 'conflict-keep',
    body: { planHash: conflict.planHash, confirm: true },
  });
  await commit.apply(conflict.id);
  check(
    '冲突默认保留服务器且usage不倒退',
    (await ctx.prisma.entry.findUniqueOrThrow({ where: { id: entryId } })).body ===
      '用户后续编辑' &&
      (await ctx.prisma.entryUsage.findUniqueOrThrow({ where: { entryId } })).useCount === 4,
  );
  const recovery = await ctx.call('GET', route + '/' + first.id + '/recovery', owner);
  const report = recovery.json['data'] as {
    backupId: string;
    items: { id: string; safeToRestore: boolean }[];
  };
  check(
    '恢复报告保护后续编辑',
    !!report.backupId && report.items.find((i) => i.id === entryId)?.safeToRestore === false,
  );
  check(
    '恢复报告跨空间不可读',
    (
      await ctx.call(
        'GET',
        '/workspaces/' + other.workspaceId + '/imports/' + first.id + '/recovery',
        other,
      )
    ).status === 404,
  );
  const cancel = await preview('cancel-source', 'cancel');
  await ctx.call('POST', route + '/' + cancel.id + '/cancel', owner);
  await commit.apply(cancel.id);
  check(
    '提交前取消不写业务',
    (await ctx.prisma.transferJob.findUniqueOrThrow({ where: { id: cancel.id } })).state ===
      'cancelled' && (await ctx.prisma.entry.count()) === 1,
  );
  const moreUsage = await preview('commit-source', 'usage-max', {
    ...fixture,
    entries: [{ ...fixture.entries[0], useCount: 9 }],
  });
  await ctx.call('POST', route + '/' + moreUsage.id + '/commit', {
    ...owner,
    key: 'usage-max-commit',
    body: { planHash: moreUsage.planHash, confirm: true },
  });
  await commit.apply(moreUsage.id);
  check(
    '保留服务器正文时usage仍合并最大值且修订不重复',
    (await ctx.prisma.entryUsage.findUniqueOrThrow({ where: { entryId } })).useCount === 9 &&
      (await ctx.prisma.entry.findUniqueOrThrow({ where: { id: entryId } })).body ===
        '用户后续编辑' &&
      (await ctx.prisma.entryRevision.count({ where: { entryId } })) === 1,
  );
  const revoked = await preview('revoked-source', 'revoked');
  await ctx.call('POST', route + '/' + revoked.id + '/commit', {
    ...owner,
    key: 'revoked-commit',
    body: { planHash: revoked.planHash, confirm: true },
  });
  await ctx.prisma.workspaceMember.update({
    where: { workspaceId_userId: { workspaceId: owner.workspaceId, userId: owner.userId } },
    data: { role: 'editor' },
  });
  await commit.apply(revoked.id);
  check(
    'worker重新核对Owner权限',
    (await ctx.prisma.transferJob.findUniqueOrThrow({ where: { id: revoked.id } })).errorCode ===
      'FORBIDDEN' && (await ctx.prisma.entry.count()) === 1,
  );
  await ctx.prisma.workspaceMember.update({
    where: { workspaceId_userId: { workspaceId: owner.workspaceId, userId: owner.userId } },
    data: { role: 'owner' },
  });
  console.log('合计 ' + checks + ' 项，全部通过');
} finally {
  await ctx.prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS qa_import_insert ON ledger_records');
  await ctx.prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS qa_import_fail()');
  await ctx.prisma.$executeRawUnsafe('DROP SEQUENCE IF EXISTS qa_import_trigger_hits');
  await ctx.close();
}
