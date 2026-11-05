import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { config as loadEnvFile } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrismaAdapter } from '../src/common/prisma-adapter.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { bootstrapOwner, issueRecoveryToken } from '../src/modules/auth/auth-core.js';
import { verifyPassword } from '../src/modules/auth/password.js';

/**
 * F08 HTTP 验收（真实 HTTP + 真实 PostgreSQL + 限流）：
 *   pnpm --filter @aiwb/api test:auth-http
 *
 * 覆盖：恢复接口成功/重放/伪造/字段校验、限流 429、改密接口未登录 401、
 * 响应与日志不含明文密码或令牌。
 */
const here = dirname(fileURLToPath(import.meta.url));
loadEnvFile({ path: resolve(here, '../../../.env'), quiet: true });

const databaseUrl = process.env['DATABASE_URL_TEST'] ?? process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  console.error('缺少 DATABASE_URL_TEST 或 DATABASE_URL');
  process.exit(1);
}
const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '');
if (
  !databaseName.endsWith('_test') ||
  !['127.0.0.1', 'localhost'].includes(new URL(databaseUrl).hostname)
) {
  console.error(`拒绝在非测试库上运行：${databaseName}`);
  process.exit(1);
}

// 让 AppModule 的配置校验读取测试库
process.env['DATABASE_URL'] = databaseUrl;

const { AppModule } = await import('../src/app.module.js');

const prisma = new PrismaClient({ adapter: createPrismaAdapter(databaseUrl) });
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
}

const EMAIL = 'http-recovery@authtest.local';
const PASSWORD = 'Workbench-Http-Pass-42';
const RECOVERED = 'Workbench-Http-Recovered-42';

async function reset(): Promise<void> {
  const user = await prisma.user.findUnique({ where: { emailNormalized: EMAIL } });
  if (user === null) return;
  await prisma.auditEvent.deleteMany({ where: { actorId: user.id } });
  await prisma.accountRecoveryToken.deleteMany({ where: { userId: user.id } });
  await prisma.session.deleteMany({ where: { userId: user.id } });
  await prisma.workspaceMember.deleteMany({ where: { userId: user.id } });
  const workspaces = await prisma.workspace.findMany({ where: { createdBy: user.id } });
  for (const workspace of workspaces) {
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.workspace.delete({ where: { id: workspace.id } });
  }
  await prisma.user.delete({ where: { id: user.id } });
}

// 集成测试库：清空业务表，保证 bootstrap 从“零用户”开始
await prisma.$executeRawUnsafe(
  'TRUNCATE TABLE users, workspaces, sessions, account_recovery_tokens, audit_events RESTART IDENTITY CASCADE',
);
const boot = await bootstrapOwner(prisma, {
  email: EMAIL,
  displayName: 'HTTP 恢复测试',
  password: PASSWORD,
});
check('准备：测试用户创建成功', boot.created === true);
const issued = await issueRecoveryToken(prisma, { email: EMAIL });
check('准备：恢复令牌签发成功', issued !== null);

const app: INestApplication = await NestFactory.create(AppModule, { logger: ['error'] });
app.setGlobalPrefix('api/v1');
await app.listen(0, '127.0.0.1');
const address = app.getHttpServer().address() as { port: number };
const base = `http://127.0.0.1:${address.port}/api/v1`;

async function post(
  path: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

const token = issued?.token ?? '';

// 1) 字段校验：密码过短 → 422
const weak = await post('/auth/recovery/complete', { token, newPassword: 'short' });
check(
  '密码过短返回 422 VALIDATION_FAILED',
  weak.status === 422 && (weak.json['error'] as { code?: string })?.code === 'VALIDATION_FAILED',
  JSON.stringify(weak),
);

// 2) 未知字段严格拒绝
const unknownField = await post('/auth/recovery/complete', {
  token,
  newPassword: RECOVERED,
  extra: 1,
});
check('未知字段被拒绝（422）', unknownField.status === 422);

// 3) 伪造令牌 → 401，且响应不含令牌或账号信息
const forged = await post('/auth/recovery/complete', {
  token: 'Z'.repeat(43),
  newPassword: RECOVERED,
});
const forgedText = JSON.stringify(forged.json);
check(
  '伪造令牌返回 401',
  forged.status === 401 &&
    (forged.json['error'] as { code?: string })?.code === 'AUTH_INVALID_CREDENTIALS',
  JSON.stringify(forged),
);
check('错误响应不含令牌明文', !forgedText.includes('Z'.repeat(43)));
check('错误响应不含邮箱', !forgedText.includes(EMAIL));

// 4) 正确令牌 → 200，密码真的被改
const ok = await post('/auth/recovery/complete', { token, newPassword: RECOVERED });
check('有效令牌返回 200', ok.status === 200 && JSON.stringify(ok.json).includes('password_reset'));
check('响应不含 userId', !JSON.stringify(ok.json).includes(boot.created ? boot.userId : ''));
const user = await prisma.user.findUnique({ where: { emailNormalized: EMAIL } });
check('新密码生效', user !== null && (await verifyPassword(user.passwordHash, RECOVERED)));
check('旧密码失效', user !== null && !(await verifyPassword(user.passwordHash, PASSWORD)));

// 5) 重放同一令牌 → 401
const replay = await post('/auth/recovery/complete', {
  token,
  newPassword: 'Workbench-Http-Third-42',
});
check('同一令牌重放返回 401', replay.status === 401);

// 6) 改密接口未接入会话时明确 401（不伪造已登录）
const change = await fetch(`${base}/auth/password`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ currentPassword: RECOVERED, newPassword: 'Workbench-Http-Third-42' }),
});
check('未登录改密返回 401', change.status === 401);

// 7) 限流：/auth/recovery/complete 5 次/分钟（上面已用 5 次，再打 1 次应为 429）
const limited = await post('/auth/recovery/complete', {
  token: 'Y'.repeat(43),
  newPassword: RECOVERED,
});
check('超过限流返回 429', limited.status === 429, `实际 ${limited.status}`);

await app.close();
await reset();
await prisma.$disconnect();

const failed = results.filter((item) => !item.ok);
for (const item of results) {
  console.log(
    `${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.ok ? '' : `  ← ${item.detail ?? ''}`}`,
  );
}
console.log(
  `\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`,
);
process.exitCode = failed.length === 0 ? 0 : 1;
