import assert from 'node:assert/strict';
import { createTestContext } from './test-context.js';
import { requireTransferCapacity, classifyDisk } from '../src/common/disk-capacity.js';
const ctx = await createTestContext();
let checks = 0;
const check = (v: unknown, n: string) => {
  assert.ok(v, n);
  console.log('PASS', ++checks, n);
};
try {
  const response = await fetch(ctx.base + '/auth/me');
  check(response.status === 401, '匿名默认拒绝');
  check(response.headers.get('cache-control') === 'private, no-store', '认证及业务禁止共享缓存');
  check(
    response.headers.get('x-content-type-options') === 'nosniff' &&
      response.headers.get('x-frame-options') === 'DENY',
    '类型嗅探及嵌入保护',
  );
  check(response.headers.get('referrer-policy') === 'no-referrer', '认证路径不发送Referer');
  check(!!response.headers.get('x-request-id'), '请求关联ID存在');
  const login = await ctx.owner('secure-header'),
    origin = await fetch(ctx.base + '/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://untrusted.example' },
      body: JSON.stringify({ email: 'x', password: 'x' }),
    });
  check(origin.status === 403, '跨源写Origin被拒绝');
  const csrf = await fetch(ctx.base + '/auth/csrf');
  const cookies = csrf.headers.getSetCookie().join(';');
  check(
    cookies.includes('SameSite=Lax'),
    'CSRF Cookie按契约SameSite=Lax，写操作额外校验令牌与Origin',
  );
  const view = await ctx.call('GET', '/auth/me', login);
  check(!JSON.stringify(view.json).includes('passwordHash'), '认证响应不含哈希');
  const entry = await ctx.prisma.entry.create({
    data: {
      workspaceId: login.workspaceId,
      createdBy: login.userId,
      title: '列表不返回正文',
      body: 'x'.repeat(20480),
    },
  });
  const list = await ctx.call('GET', '/workspaces/' + login.workspaceId + '/entries', login),
    summary = (list.json.data as { entries: Record<string, unknown>[] }).entries[0]!;
  check(!('body' in summary) && summary['bodyBytes'] === 20480, '知识列表只含摘要和字节数');
  const detail = await ctx.call(
    'GET',
    '/workspaces/' + login.workspaceId + '/entries/' + entry.id,
    login,
  );
  check(
    (detail.json.data as { body: string }).body.length === 20480,
    '知识详情仍完整返回合法20KB正文',
  );
  check(
    classifyDisk(20, 100).status === 'ok' &&
      classifyDisk(19.9, 100).status === 'warning' &&
      classifyDisk(9.9, 100).status === 'critical',
    '磁盘20%提醒/10%拒绝边界',
  );
  const disk = await requireTransferCapacity('../../.data');
  check(disk.status !== 'critical', '本机真实磁盘满足高体积操作余量');
  console.log(JSON.stringify({ checks, result: 'passed', diskFreeRatio: disk.ratio }));
} finally {
  await ctx.close();
}
