import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createPrismaAdapter } from '../src/common/prisma-adapter.js';
import { config as loadEnvFile } from 'dotenv';
import { PrismaClient } from '../src/generated/prisma/client.js';
import {
  bootstrapOwner,
  changePassword,
  completeRecovery,
  issueRecoveryToken,
} from '../src/modules/auth/auth-core.js';
import { hashOpaqueToken, verifyPassword } from '../src/modules/auth/password.js';
import { ApiException } from '../src/common/api-exception.js';

/**
 * F08 验收脚本（真实 PostgreSQL）：
 *   pnpm --filter @aiwb/api test:auth
 *
 * 覆盖：bootstrap 幂等、密码策略、改密吊销会话、恢复令牌一次性、
 * 明文密码/令牌不落库不入审计、CLI 端到端。
 */

const here = dirname(fileURLToPath(import.meta.url));
loadEnvFile({ path: resolve(here, '../../../.env'), quiet: true });

// 集成测试会对业务表做 TRUNCATE：只允许跑在独立的 *_test 数据库上，防止误清开发/生产数据
const databaseUrl = process.env['DATABASE_URL_TEST'] ?? process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  console.error('缺少 DATABASE_URL_TEST 或 DATABASE_URL');
  process.exit(1);
}
const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '');
if (!databaseName.endsWith('_test')) {
  console.error(`拒绝在非测试库上运行：${databaseName}（要求库名以 _test 结尾）`);
  process.exit(1);
}
console.log(`[auth-check] 数据库：${databaseName}（集成测试库）`);

const prisma = new PrismaClient({ adapter: createPrismaAdapter(databaseUrl) });
const DOMAIN = 'authtest.local';
const EMAILS = [`owner@${DOMAIN}`, `second@${DOMAIN}`, `cli@${DOMAIN}`];
const results: { name: string; ok: boolean; detail?: string }[] = [];

function check(name: string, condition: boolean, detail?: string): void {
  results.push({ name, ok: condition, ...(detail === undefined ? {} : { detail }) });
}

async function truncateTestDatabase(): Promise<void> {
  // 测试库专用：清空业务表，保证 bootstrap 从“零用户”开始
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE users, workspaces, sessions, account_recovery_tokens, audit_events RESTART IDENTITY CASCADE',
  );
}

async function cleanup(): Promise<void> {
  const users = await prisma.user.findMany({ where: { emailNormalized: { in: EMAILS } } });
  const userIds = users.map((user) => user.id);
  if (userIds.length === 0) return;
  await prisma.auditEvent.deleteMany({ where: { actorId: { in: userIds } } });
  await prisma.accountRecoveryToken.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.workspaceMember.deleteMany({ where: { userId: { in: userIds } } });
  const workspaces = await prisma.workspace.findMany({ where: { createdBy: { in: userIds } } });
  for (const workspace of workspaces) {
    await prisma.taskEntry.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.entryTag.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.entryRevision.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.entryUsage.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.ledgerRecord.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.entry.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.task.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.tag.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.developmentLog.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.project.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.workspace.delete({ where: { id: workspace.id } });
  }
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function expectApiError(
  fn: () => Promise<unknown>,
  expectedCode: string,
  name: string,
): Promise<void> {
  try {
    await fn();
    check(name, false, '未抛出错误');
  } catch (error) {
    if (error instanceof ApiException) {
      check(name, error.code === expectedCode, `实际 ${error.code}，期望 ${expectedCode}`);
    } else {
      check(name, false, `非 ApiException：${(error as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------- A. CLI 端到端
await truncateTestDatabase();

const cliPath = resolve(here, '../src/cli/bootstrap-owner.ts');
const cliPassword = 'Workbench-Strong-Pass-42';
const cliRun = spawnSync(
  process.execPath,
  ['--import', 'tsx', cliPath, '--email', `cli@${DOMAIN}`, '--name', 'CLI 用户', '--password-stdin'],
  { input: `${cliPassword}\n`, encoding: 'utf8', env: { ...process.env, DATABASE_URL: databaseUrl } },
);

check('CLI bootstrap 退出码 0', cliRun.status === 0, `stdout=${cliRun.stdout} stderr=${cliRun.stderr}`);
check('CLI 输出不含明文密码', !`${cliRun.stdout}${cliRun.stderr}`.includes(cliPassword));

const cliUser = await prisma.user.findUnique({ where: { emailNormalized: `cli@${DOMAIN}` } });
check('CLI 创建了用户', cliUser !== null);
check(
  'CLI 创建的用户可用输入密码登录校验通过',
  cliUser !== null && (await verifyPassword(cliUser.passwordHash, cliPassword)),
);
check(
  '哈希为 argon2id 且参数符合冻结值',
  cliUser !== null && /^\$argon2id\$v=19\$m=65536,t=7,p=1\$/.test(cliUser.passwordHash),
  cliUser?.passwordHash.slice(0, 40),
);
if (cliUser !== null) {
  const cliMembership = await prisma.workspaceMember.findFirst({
    where: { userId: cliUser.id },
    include: { workspace: true },
  });
  check('CLI 创建了个人空间并成为 Owner', cliMembership?.role === 'owner');
} else {
  check('CLI 创建了个人空间并成为 Owner', false, 'CLI 未创建用户');
}

// ---------------------------------------------------------------- B. 服务层：bootstrap 幂等
await cleanup();

const ownerPassword = 'Workbench-Primary-Pass-42';
const first = await bootstrapOwner(prisma, {
  email: `owner@${DOMAIN}`,
  displayName: '测试 Owner',
  password: ownerPassword,
});
check('首次 bootstrap 创建成功', first.created === true);

const second = await bootstrapOwner(prisma, {
  email: `owner@${DOMAIN}`,
  displayName: '测试 Owner',
  password: ownerPassword,
});
check('同邮箱重复 bootstrap 不重复创建', second.created === false && second.reason === 'USER_EXISTS');

const third = await bootstrapOwner(prisma, {
  email: `second@${DOMAIN}`,
  displayName: '第二人',
  password: 'Backup-Strong-Pass-42',
});
check('库中已有用户时拒绝创建第二个 Owner', third.created === false && third.reason === 'OTHER_USERS_EXIST');

const userCount = await prisma.user.count({ where: { emailNormalized: { in: EMAILS } } });
const owner = await prisma.user.findUnique({ where: { emailNormalized: `owner@${DOMAIN}` } });
check('用户数仍为 1', userCount === 1, `实际 ${userCount}`);
check('bootstrap 写入审计', (await prisma.auditEvent.count({ where: { action: 'account.bootstrap' } })) === 1);

await expectApiError(
  () =>
    bootstrapOwner(prisma, {
      email: 'weak@authtest.local',
      displayName: '弱密码',
      password: 'Ab1!',
    }),
  'VALIDATION_FAILED',
  '弱密码被策略拒绝',
);

// ---------------------------------------------------------------- C. 改密与吊销
const ownerId = owner?.id ?? '';
await prisma.session.createMany({
  data: [1, 2].map((index) => ({
    userId: ownerId,
    tokenHash: `testhash-${index}-${Date.now()}`,
    csrfTokenHash: `testcsrf-${index}`,
    idleExpiresAt: new Date(Date.now() + 3600_000),
    absoluteExpiresAt: new Date(Date.now() + 86400_000),
  })),
});
check('已插入 2 条测试会话', (await prisma.session.count({ where: { userId: ownerId, revokedAt: null } })) === 2);

await expectApiError(
  () =>
    changePassword(prisma, {
      userId: ownerId,
      currentPassword: 'Wrong-Password-1',
      newPassword: 'Workbench-Secondary-Pass-42',
    }),
  'AUTH_INVALID_CREDENTIALS',
  '当前密码错误时拒绝改密',
);
check(
  '密码错误时不吊销会话',
  (await prisma.session.count({ where: { userId: ownerId, revokedAt: null } })) === 2,
);
check(
  '密码错误写入失败审计',
  (await prisma.auditEvent.count({ where: { action: 'account.password_change', result: 'failure' } })) === 1,
);

const newPassword = 'Workbench-Secondary-Pass-42';
const changed = await changePassword(prisma, {
  userId: ownerId,
  currentPassword: ownerPassword,
  newPassword,
});
check('改密成功并吊销全部旧会话', changed.revokedSessions === 2);
const afterChange = await prisma.user.findUnique({ where: { id: ownerId } });
check('新密码可校验通过', afterChange !== null && (await verifyPassword(afterChange.passwordHash, newPassword)));
check('旧密码失效', afterChange !== null && !(await verifyPassword(afterChange.passwordHash, ownerPassword)));
check(
  '改密成功审计中不含明文密码',
  (await prisma.auditEvent.count({
    where: {
      action: 'account.password_change',
      result: 'success',
      OR: [{ summary: { contains: newPassword } }, { summary: { contains: ownerPassword } }],
    },
  })) === 0,
);

await expectApiError(
  () =>
    changePassword(prisma, {
      userId: ownerId,
      currentPassword: newPassword,
      newPassword,
    }),
  'VALIDATION_FAILED',
  '新旧密码相同时拒绝',
);

// ---------------------------------------------------------------- D. 恢复令牌
await prisma.session.create({
  data: {
    userId: ownerId,
    tokenHash: `testhash-restore-${Date.now()}`,
    csrfTokenHash: 'testcsrf-restore',
    idleExpiresAt: new Date(Date.now() + 3600_000),
    absoluteExpiresAt: new Date(Date.now() + 86400_000),
  },
});

const issued = await issueRecoveryToken(prisma, { email: `owner@${DOMAIN}` });
check('签发恢复令牌成功', issued !== null);
const rawToken = issued?.token ?? '';

const stored = issued === null ? null : await prisma.accountRecoveryToken.findFirst({ where: { userId: ownerId } });
check('数据库只存令牌哈希', stored !== null && stored.tokenHash === hashOpaqueToken(rawToken));
check('数据库不含明文令牌', stored !== null && stored.tokenHash !== rawToken);
check(
  '审计不含明文令牌',
  (await prisma.auditEvent.count({ where: { summary: { contains: rawToken } } })) === 0,
);

const recoveredPassword = 'Workbench-Recovered-Pass-42';
const recovery = await completeRecovery(prisma, { token: rawToken, newPassword: recoveredPassword });
check('恢复成功并吊销全部会话', recovery.revokedSessions === 1);
const afterRecovery = await prisma.user.findUnique({ where: { id: ownerId } });
check(
  '恢复后的新密码可用',
  afterRecovery !== null && (await verifyPassword(afterRecovery.passwordHash, recoveredPassword)),
);
check(
  '令牌被标记为已使用',
  (await prisma.accountRecoveryToken.count({ where: { id: stored?.id ?? '', usedAt: { not: null } } })) === 1,
);

await expectApiError(
  () => completeRecovery(prisma, { token: rawToken, newPassword: 'Workbench-Another-Pass-42' }),
  'AUTH_INVALID_CREDENTIALS',
  '同一令牌第二次使用被拒绝',
);

await expectApiError(
  () => completeRecovery(prisma, { token: 'x'.repeat(43), newPassword: 'Workbench-Another-Pass-42' }),
  'AUTH_INVALID_CREDENTIALS',
  '伪造令牌被拒绝',
);

const expiredToken = 'expired-token-for-test-0123456789';
await prisma.accountRecoveryToken.create({
  data: {
    userId: ownerId,
    tokenHash: hashOpaqueToken(expiredToken),
    expiresAt: new Date(Date.now() - 60_000),
    createdBy: ownerId,
  },
});
await expectApiError(
  () => completeRecovery(prisma, { token: expiredToken, newPassword: 'Workbench-Another-Pass-42' }),
  'AUTH_INVALID_CREDENTIALS',
  '过期令牌被拒绝',
);

// ---------------------------------------------------------------- E. 清理与汇总
await cleanup();

const failed = results.filter((item) => !item.ok);
for (const item of results) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.ok ? '' : `  ← ${item.detail ?? ''}`}`);
}
console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);

await prisma.$disconnect();
process.exitCode = failed.length === 0 ? 0 : 1;
