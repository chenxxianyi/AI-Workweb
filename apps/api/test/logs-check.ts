import assert from 'node:assert/strict';
import { createTestContext } from './test-context.js';
import { businessDate } from '@aiwb/domain';
const ctx = await createTestContext();
let checks = 0;
const check = (name: string, ok: boolean) => {
  assert.ok(ok, name);
  checks++;
  console.log('PASS ' + name);
};
try {
  const owner = await ctx.owner('logs-owner'),
    other = await ctx.owner('logs-other'),
    viewer = await ctx.owner('logs-viewer');
  await ctx.prisma.workspaceMember.create({
    data: { workspaceId: owner.workspaceId, userId: viewer.userId, role: 'viewer' },
  });
  const route = '/workspaces/' + owner.workspaceId + '/logs';
  const first = await ctx.call('POST', route, {
    ...owner,
    key: 'log-1',
    body: { text: '今日修复重试问题' },
  });
  const data = first.json['data'] as {
    log: { id: string; authorId: string; logDate: string; version: number };
    replayed: boolean;
  };
  check('真实日志创建及服务器作者', first.status === 201 && data.log.authorId === owner.userId);
  check('默认工作空间业务日', data.log.logDate === businessDate(new Date(), 'Asia/Shanghai'));
  const replay = await ctx.call('POST', route, {
    ...owner,
    key: 'log-1',
    body: { text: '今日修复重试问题' },
  });
  check(
    '同key重试不重复',
    (replay.json['data'] as typeof data).replayed &&
      (await ctx.prisma.developmentLog.count()) === 1,
  );
  check(
    '同内容不同key可并存',
    (await ctx.call('POST', route, { ...owner, key: 'log-2', body: { text: '今日修复重试问题' } }))
      .status === 201 && (await ctx.prisma.developmentLog.count()) === 2,
  );
  check(
    '拒绝伪造author',
    (
      await ctx.call('POST', route, {
        ...owner,
        key: 'spoof',
        body: { text: 'x', authorId: other.userId },
      })
    ).status === 422,
  );
  check(
    '空白拒绝',
    (await ctx.call('POST', route, { ...owner, key: 'blank', body: { text: '   ' } })).status ===
      422,
  );
  check(
    '长度4001拒绝',
    (await ctx.call('POST', route, { ...owner, key: 'long', body: { text: '中'.repeat(4001) } }))
      .status === 422,
  );
  check(
    '非法日期拒绝',
    (
      await ctx.call('POST', route, {
        ...owner,
        key: 'date',
        body: { text: 'x', logDate: '2026-02-30' },
      })
    ).status === 422,
  );
  check(
    'Viewer只能读',
    (await ctx.call('GET', route, viewer)).status === 200 &&
      (await ctx.call('POST', route, { ...viewer, key: 'viewer', body: { text: 'x' } })).status ===
        403,
  );
  const cross = await ctx.call('GET', '/workspaces/' + other.workspaceId + '/logs', other);
  check('跨空间列表不可见', (cross.json['data'] as { logs: unknown[] }).logs.length === 0);
  const page = await ctx.call('GET', route + '?limit=1', owner);
  const cursor = page.json['data'] as {
    hasMore: boolean;
    nextCursor: string;
    logs: { id: string }[];
  };
  const next = await ctx.call('GET', route + '?limit=1&cursor=' + cursor.nextCursor, owner);
  check(
    '游标分页不重复',
    cursor.hasMore && (next.json['data'] as typeof cursor).logs[0]?.id !== cursor.logs[0]?.id,
  );
  check(
    '游标不能换日期复用',
    (await ctx.call('GET', route + '?date=2026-01-01&cursor=' + cursor.nextCursor, owner))
      .status === 400,
  );
  check(
    '缺少IfMatch拒绝',
    (await ctx.call('PATCH', route + '/' + data.log.id, { ...owner, body: { text: 'edited' } }))
      .status === 428,
  );
  check(
    '条件更新成功',
    (
      await ctx.call('PATCH', route + '/' + data.log.id, {
        ...owner,
        version: 1,
        body: { text: 'edited' },
      })
    ).status === 200,
  );
  check(
    '旧版本拒绝',
    (
      await ctx.call('PATCH', route + '/' + data.log.id, {
        ...owner,
        version: 1,
        body: { text: 'stale' },
      })
    ).status === 412,
  );
  check(
    '跨空间修改404',
    (
      await ctx.call('PATCH', '/workspaces/' + other.workspaceId + '/logs/' + data.log.id, {
        ...other,
        version: 2,
        body: { text: 'x' },
      })
    ).status === 404,
  );
  check(
    '软删除成功',
    (await ctx.call('DELETE', route + '/' + data.log.id, { ...owner, version: 2 })).status ===
      200 &&
      (await ctx.prisma.developmentLog.findUniqueOrThrow({ where: { id: data.log.id } }))
        .deletedAt !== null,
  );
  check(
    '审计记录存在',
    (await ctx.prisma.auditEvent.count({
      where: { workspaceId: owner.workspaceId, entityType: 'log' },
    })) === 4,
  );
  console.log('合计 ' + checks + ' 项，全部通过');
} finally {
  await ctx.close();
}
