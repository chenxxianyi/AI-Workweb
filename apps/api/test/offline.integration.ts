import assert from 'node:assert/strict';
import { createTestContext } from './test-context.js';
const ctx = await createTestContext();
let count = 0;
const check = (value: unknown, label: string) => {
  assert.ok(value, label);
  console.log('PASS', ++count, label);
};
try {
  const a = await ctx.owner('offline-a'),
    b = await ctx.owner('offline-b'),
    path = '/workspaces/' + a.workspaceId + '/offline-operations';
  const input = {
    userId: a.userId,
    workspaceVersion: 1,
    createdAt: new Date().toISOString(),
    operation: { kind: 'log', payload: { text: '离线日志一次写入', logDate: '2026-11-04' } },
  };
  const opts = { jar: a.jar, csrf: a.csrf, key: 'offline-log', body: input };
  const [x, y] = await Promise.all([ctx.call('POST', path, opts), ctx.call('POST', path, opts)]);
  check(
    x.status === 200 &&
      y.status === 200 &&
      (await ctx.prisma.developmentLog.count({ where: { workspaceId: a.workspaceId } })) === 1,
    '并发同键只新建一条日志',
  );
  const found = await ctx.call('GET', path + '/offline-log', { jar: a.jar });
  check((found.json.data as { status: string }).status === 'succeeded', '结果未知可以查询原键');
  check(
    (await ctx.call('GET', path + '/offline-log', { jar: b.jar })).status === 404,
    '跨空间读取原键不可见',
  );
  check(
    (
      await ctx.call('POST', path, {
        ...opts,
        body: {
          ...input,
          operation: { kind: 'log', payload: { text: '变更内容', logDate: '2026-11-04' } },
        },
      })
    ).status === 409,
    '同键异体不能覆盖',
  );
  check(
    (
      await ctx.call('POST', path, {
        ...opts,
        key: 'other-user',
        body: { ...input, userId: b.userId },
      })
    ).status === 403,
    '账号切换竞态不能提交另一账号意图',
  );
  check(
    (
      await ctx.call('POST', path, {
        ...opts,
        key: 'expired',
        body: { ...input, createdAt: '2020-01-01T00:00:00Z' },
      })
    ).status === 409,
    '超过7天服务器拒绝重放',
  );
  const draft = await ctx.call('POST', path, {
    ...opts,
    key: 'draft',
    body: {
      ...input,
      operation: {
        kind: 'draft',
        payload: { title: '本机草稿', body: '未验证正文', type: 'note' },
      },
    },
  });
  check(
    draft.status === 200 &&
      (await ctx.prisma.entry.count({ where: { workspaceId: a.workspaceId, status: 'draft' } })) ===
        1,
    '新知识限定为草稿',
  );
  const task = await ctx.prisma.task.create({
    data: { workspaceId: a.workspaceId, createdBy: a.userId, title: '离线状态' },
  });
  const taskInput = {
    ...input,
    operation: { kind: 'task-state', payload: { id: task.id, status: 'done', version: 1 } },
  };
  const changed = await ctx.call('POST', path, { ...opts, key: 'task', body: taskInput });
  check(
    changed.status === 200 &&
      (await ctx.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).version === 2,
    '任务状态CAS与完成时间提交',
  );
  check(
    (await ctx.call('POST', path, { ...opts, key: 'task-old', body: taskInput })).status === 412,
    '离线旧版本不会覆盖新版本',
  );
  await ctx.prisma.workspace.update({
    where: { id: a.workspaceId },
    data: { version: { increment: 1 } },
  });
  check(
    (await ctx.call('POST', path, { ...opts, key: 'before-clear' })).status === 409,
    '空间版本变化阻止旧意图写入',
  );
  await ctx.prisma.workspaceMember.update({
    where: { workspaceId_userId: { workspaceId: a.workspaceId, userId: a.userId } },
    data: { role: 'viewer' },
  });
  check(
    (await ctx.call('POST', path, { ...opts, key: 'revoked' })).status === 403,
    '撤销写权限后不能同步',
  );
  check(
    (await ctx.prisma.developmentLog.count({ where: { workspaceId: a.workspaceId } })) === 1,
    '拒绝路径没有额外业务写入',
  );
  console.log(JSON.stringify({ checks: count, result: 'passed' }));
} finally {
  await ctx.close();
}
