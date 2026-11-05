import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createTestContext } from './test-context.js';
const ctx = await createTestContext();
let checks = 0;
const check = (v: unknown, n: string) => {
  assert.ok(v, n);
  console.log('PASS ' + ++checks + ' ' + n);
};
try {
  const owner = await ctx.owner('create-idempotency'),
    route = '/workspaces/' + owner.workspaceId + '/projects',
    body = { name: '项目幂等', nextStep: '只建立一次' },
    key = 'same-project-key';
  const pair = await Promise.all([
      ctx.call('POST', route, { ...owner, key, body }),
      ctx.call('POST', route, { ...owner, key, body }),
    ]),
    ids = pair.map((r) => (r.json.data as { id: string }).id);
  check(pair.every((r) => r.status === 201) && ids[0] === ids[1], '项目并发同键返回相同ID');
  check(
    (await ctx.prisma.project.count({ where: { workspaceId: owner.workspaceId } })) === 1,
    '并发只新增一条项目',
  );
  check(
    (await ctx.call('POST', route, { ...owner, key, body: { name: '其他内容' } })).status === 409,
    '同键不同项目内容409',
  );
  const headers = {
    'content-type': 'application/json',
    cookie: Object.entries(owner.jar)
      .map(([k, v]) => k + '=' + v)
      .join('; '),
    'x-csrf-token': owner.csrf,
  };
  check(
    (await fetch(ctx.base + route, { method: 'POST', headers, body: JSON.stringify(body) }))
      .status === 422,
    '项目缺少幂等键422',
  );
  check(
    (await ctx.call('POST', route, { ...owner, key: 'bad key', body })).status === 422,
    '非法键422',
  );
  const space = await Promise.all([
    ctx.call('POST', '/workspaces', { ...owner, key: 'space-key', body: { name: '空间幂等' } }),
    ctx.call('POST', '/workspaces', { ...owner, key: 'space-key', body: { name: '空间幂等' } }),
  ]);
  check(
    space.every((r) => r.status === 201) &&
      (space[0]!.json.data as { id: string }).id === (space[1]!.json.data as { id: string }).id,
    '空间并发同键只创建一个空间',
  );
  check(
    (await ctx.prisma.workspace.count({ where: { name: '空间幂等' } })) === 1,
    '空间创建与Owner成员同事务',
  );
  check(
    (
      await ctx.call('POST', '/workspaces', {
        ...owner,
        key: 'space-key',
        body: { name: '新名称' },
      })
    ).status === 409,
    '空间同键改体409',
  );
  check(
    (
      await fetch(ctx.base + '/workspaces', {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: '无键' }),
      })
    ).status === 422,
    '空间缺少幂等键422',
  );
  let status = 0;
  const droppedKey = 'project-response-dropped',
    proxy = createServer(async (_req, res) => {
      const result = await ctx.call('POST', route, {
        ...owner,
        key: droppedKey,
        body: { name: '提交后丢响应' },
      });
      status = result.status;
      res.destroy();
    });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  let lost = false;
  try {
    await fetch('http://127.0.0.1:' + (proxy.address() as { port: number }).port, {
      method: 'POST',
      body: '{}',
    });
  } catch {
    lost = true;
  } finally {
    await new Promise<void>((resolve, reject) => proxy.close((e) => (e ? reject(e) : resolve())));
  }
  check(lost && status === 201, '真实代理在项目提交后丢弃响应');
  const replay = await ctx.call('POST', route, {
    ...owner,
    key: droppedKey,
    body: { name: '提交后丢响应' },
  });
  check(
    replay.status === 201 &&
      (await ctx.prisma.project.count({
        where: { workspaceId: owner.workspaceId, name: '提交后丢响应' },
      })) === 1,
    '断响应后原键重试不产生第二条',
  );
  console.log(JSON.stringify({ checks, result: 'passed' }));
} finally {
  await ctx.close();
}
