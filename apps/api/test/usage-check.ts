import assert from 'node:assert/strict';
import { createTestContext } from './test-context.js';
const ctx = await createTestContext();
let checks = 0;
const check = (label: string, condition: boolean): void => {
  assert.ok(condition, label);
  checks++;
  console.log('PASS ' + label);
};
try {
  const owner = await ctx.owner('usage-owner');
  const other = await ctx.owner('usage-other');
  const viewer = await ctx.owner('usage-viewer');
  await ctx.prisma.workspaceMember.create({
    data: { workspaceId: owner.workspaceId, userId: viewer.userId, role: 'viewer' },
  });
  const entry = await ctx.prisma.entry.create({
    data: {
      workspaceId: owner.workspaceId,
      createdBy: owner.userId,
      title: '复制原文',
      body: '<tag> & 代码',
    },
  });
  const route = '/workspaces/' + owner.workspaceId + '/entries/' + entry.id + '/usage';
  const before = await ctx.call('GET', route, owner);
  check('未使用统计为0', (before.json['data'] as { useCount: number }).useCount === 0);
  const first = await ctx.call('POST', route, { ...viewer, key: 'usage-1', body: {} });
  check('Viewer允许受限使用事件', first.status === 200);
  const replay = await ctx.call('POST', route, { ...viewer, key: 'usage-1', body: {} });
  check(
    '重试不重复计数',
    (replay.json['data'] as { useCount: number; replayed: boolean }).useCount === 1 &&
      (replay.json['data'] as { replayed: boolean }).replayed,
  );
  const parallel = await Promise.all([
    ctx.call('POST', route, { ...owner, key: 'usage-parallel', body: {} }),
    ctx.call('POST', route, { ...owner, key: 'usage-parallel', body: {} }),
  ]);
  check(
    '并发同key都返回一致结果',
    parallel.every((result) => result.status === 200),
  );
  check(
    '并发只增加一次',
    (await ctx.prisma.entryUsage.findUniqueOrThrow({ where: { entryId: entry.id } })).useCount ===
      2,
  );
  const invalid = await ctx.call('POST', route, {
    ...viewer,
    key: 'bad',
    body: { useCount: 9000, body: '篡改' },
  });
  check('不可借使用事件篡改字段', invalid.status === 422);
  check('无key拒绝', (await ctx.call('POST', route, { ...owner, body: {} })).status === 422);
  check(
    '跨空间拒绝',
    (
      await ctx.call(
        'POST',
        '/workspaces/' + other.workspaceId + '/entries/' + entry.id + '/usage',
        { ...other, key: 'cross', body: {} },
      )
    ).status === 404,
  );
  const unchanged = await ctx.prisma.entry.findUniqueOrThrow({ where: { id: entry.id } });
  check(
    '统计不变更正文版本',
    unchanged.version === entry.version &&
      unchanged.updatedAt.getTime() === entry.updatedAt.getTime() &&
      unchanged.body === entry.body,
  );
  const read = await ctx.call('GET', route, owner);
  check(
    '统计和时间可查询',
    (read.json['data'] as { useCount: number; lastUsedAt: string }).useCount === 2 &&
      !!(read.json['data'] as { lastUsedAt: string }).lastUsedAt,
  );
  await ctx.prisma.entry.update({ where: { id: entry.id }, data: { deletedAt: new Date() } });
  check(
    '已删除条目不能使用',
    (await ctx.call('POST', route, { ...owner, key: 'deleted', body: {} })).status === 404,
  );
  check(
    '匿名使用拒绝',
    (await ctx.call('POST', route, { key: 'anonymous', body: {} })).status === 401,
  );
  console.log('合计 ' + checks + ' 项，全部通过');
} finally {
  await ctx.close();
}
