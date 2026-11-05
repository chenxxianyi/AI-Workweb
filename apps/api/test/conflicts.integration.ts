import assert from 'node:assert/strict';
import { createTestContext } from './test-context.js';
const ctx = await createTestContext();
let checks = 0;
function check(value: unknown, label: string) {
  assert.ok(value, label);
  console.log('PASS', ++checks, label);
}
try {
  const a = await ctx.owner('two-device'),
    root = '/workspaces/' + a.workspaceId;
  const created = await ctx.call('POST', root + '/entries', {
    ...a,
    key: 'create-both',
    body: { title: '双方原稿', body: '原正文' },
  });
  const entry = (created.json.data as { entry: { id: string } }).entry,
    path = root + '/entries/' + entry.id;
  const [ra, rb] = await Promise.all([ctx.call('GET', path, a), ctx.call('GET', path, a)]);
  const va = (ra.json.data as { version: number }).version,
    vb = (rb.json.data as { version: number }).version;
  check(va === vb, '两个独立读请求取得同版本');
  check(
    (await ctx.call('PATCH', path, { ...a, version: va, body: { body: '设备A已提交' } })).status ===
      200,
    'A首先保存成功',
  );
  check(
    (await ctx.call('PATCH', path, { ...a, version: vb, body: { body: '设备B仍在编辑' } }))
      .status === 412,
    'B旧版本被拒绝',
  );
  const fresh = (await ctx.call('GET', path, a)).json.data as { version: number; body: string };
  check(fresh.body === '设备A已提交', '412未覆盖A正文');
  check(
    (
      await ctx.call('PATCH', path, {
        ...a,
        version: fresh.version,
        body: { body: '人工合并：设备A已提交+设备B仍在编辑' },
      })
    ).status === 200,
    '明确人工合并基于服务器新版本成功',
  );
  const current = (await ctx.call('GET', path, a)).json.data as { version: number };
  const concurrent = await Promise.all([
    ctx.call('PATCH', path, { ...a, version: current.version, body: { body: 'C' } }),
    ctx.call('PATCH', path, { ...a, version: current.version, body: { body: 'D' } }),
  ]);
  check(
    concurrent
      .map((r) => r.status)
      .sort()
      .join(',') === '200,412',
    '同版本并发写仅一个成功',
  );
  check(
    (await ctx.prisma.entryRevision.count({ where: { entryId: entry.id } })) === 3,
    '成功的正文更新各保留一次修订，失败无修订',
  );
  console.log(JSON.stringify({ checks, result: 'passed' }));
} finally {
  await ctx.close();
}
