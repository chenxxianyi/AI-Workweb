import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { config as loadEnvFile } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createPrismaAdapter } from '../src/common/prisma-adapter.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { bootstrapOwner } from '../src/modules/auth/auth-core.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { sha256Hex } from '../src/modules/auth/session.js';

/**
 * F09 验收：服务器会话、登录/退出、CSRF、会话管理与重启存活。
 *   pnpm --filter @aiwb/api test:session
 *
 * 只允许跑在 *_test 数据库（会 TRUNCATE）。
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
console.log(`[session-check] 数据库：${databaseName}`);

process.env['DATABASE_URL'] = databaseUrl;
// 让限流不干扰会话用例（登录锁定另测）
process.env['RATE_LIMIT_LOGIN_PER_MINUTE'] = '100';
process.env['COOKIE_SECURE'] = 'false';

const { AppModule } = await import('../src/app.module.js');

const prisma = new PrismaClient({ adapter: createPrismaAdapter(databaseUrl) });

const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
}

interface Res {
  status: number;
  json: Record<string, unknown>;
  setCookies: string[];
}

type Jar = Record<string, string>;

function applyCookies(jar: Jar, setCookies: string[]): void {
  for (const header of setCookies) {
    const [pair] = header.split(';');
    const index = pair?.indexOf('=') ?? -1;
    if (pair === undefined || index <= 0) continue;
    const name = pair.slice(0, index);
    const value = decodeURIComponent(pair.slice(index + 1));
    if (value === '') delete jar[name];
    else jar[name] = value;
  }
}

function cookieHeader(jar: Jar): string | undefined {
  const entries = Object.entries(jar);
  return entries.length === 0
    ? undefined
    : entries.map(([name, value]) => `${name}=${value}`).join('; ');
}

async function createApp(): Promise<{ app: INestApplication; base: string }> {
  const app = await NestFactory.create(AppModule, { logger: ['error'] });
  app.setGlobalPrefix('api/v1');
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as { port: number };
  return { app, base: `http://127.0.0.1:${address.port}/api/v1` };
}

function call(
  base: string,
  method: string,
  path: string,
  options: {
    body?: unknown;
    jar?: Jar;
    csrf?: string;
    origin?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<Res> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(options.headers ?? {}),
  };
  const cookie = options.jar === undefined ? undefined : cookieHeader(options.jar);
  if (cookie !== undefined) headers['cookie'] = cookie;
  if (options.csrf !== undefined) headers['x-csrf-token'] = options.csrf;
  if (options.origin !== undefined) headers['origin'] = options.origin;

  return fetch(`${base}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }).then(async (response) => {
    const text = await response.text();
    const setCookies =
      typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    return {
      status: response.status,
      json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
      setCookies,
    };
  });
}

function errorCode(response: Res): string | undefined {
  const error = response.json['error'] as { code?: string } | undefined;
  return error?.code;
}

// ---------------------------------------------------------------- 准备
await prisma.$executeRawUnsafe(
  'TRUNCATE TABLE users, workspaces, sessions, account_recovery_tokens, audit_events RESTART IDENTITY CASCADE',
);

const EMAIL = 'session-owner@authtest.local';
const PASSWORD = 'Workbench-Session-Pass-42';
const boot = await bootstrapOwner(prisma, {
  email: EMAIL,
  displayName: '会话测试 Owner',
  password: PASSWORD,
});
check('准备：Owner 创建成功', boot.created === true);

const secondUserEmail = 'session-second@authtest.local';
const secondUser = await prisma.user.create({
  data: {
    emailNormalized: secondUserEmail,
    displayName: '第二用户',
    passwordHash: await hashPassword('Workbench-Second-Pass-42'),
  },
});

let { app, base } = await createApp();
const jar: Jar = {};

// ---------------------------------------------------------------- CSRF 获取
const csrfRes = await call(base, 'GET', '/auth/csrf');
const csrfTokenFromBody =
  (csrfRes.json['data'] as { csrfToken?: string } | undefined)?.csrfToken ?? '';
applyCookies(jar, csrfRes.setCookies);
check('GET /auth/csrf 返回令牌并下发 Cookie', csrfRes.status === 200 && csrfTokenFromBody !== '');
check('CSRF Cookie 与响应体令牌一致', jar['sfs_csrf'] === csrfTokenFromBody);
check(
  'CSRF Cookie 非 HttpOnly（前端需可读）',
  csrfRes.setCookies.some(
    (header) => header.startsWith('sfs_csrf=') && !header.includes('HttpOnly'),
  ),
);

// ---------------------------------------------------------------- 登录失败路径
const noCsrf = await call(base, 'POST', '/auth/login', {
  body: { email: EMAIL, password: PASSWORD },
  jar,
});
check(
  '登录缺 CSRF 头 → 403 CSRF_INVALID',
  noCsrf.status === 403 && errorCode(noCsrf) === 'CSRF_INVALID',
);

const badOrigin = await call(base, 'POST', '/auth/login', {
  body: { email: EMAIL, password: PASSWORD },
  jar,
  csrf: csrfTokenFromBody,
  origin: 'https://evil.example',
});
check('登录来源不匹配 → 403', badOrigin.status === 403 && errorCode(badOrigin) === 'CSRF_INVALID');

const wrongCsrf = await call(base, 'POST', '/auth/login', {
  body: { email: EMAIL, password: PASSWORD },
  jar,
  csrf: 'not-the-token',
});
check('CSRF 令牌不匹配 → 403', wrongCsrf.status === 403 && errorCode(wrongCsrf) === 'CSRF_INVALID');

const wrongPassword = await call(base, 'POST', '/auth/login', {
  body: { email: EMAIL, password: 'Wrong-Password-99' },
  jar,
  csrf: csrfTokenFromBody,
});
const unknownUser = await call(base, 'POST', '/auth/login', {
  body: { email: 'nobody@authtest.local', password: 'Wrong-Password-99' },
  jar,
  csrf: csrfTokenFromBody,
});
check(
  '错误密码与不存在账号返回同一错误（不泄露账号存在性）',
  wrongPassword.status === 401 &&
    unknownUser.status === 401 &&
    JSON.stringify(wrongPassword.json['error']) === JSON.stringify(unknownUser.json['error']),
);
check(
  '登录失败不下发会话 Cookie',
  !wrongPassword.setCookies.some((header) => header.startsWith('sfs_session=')),
);

// ---------------------------------------------------------------- 登录成功
const login = await call(base, 'POST', '/auth/login', {
  body: { email: EMAIL, password: PASSWORD },
  jar,
  csrf: csrfTokenFromBody,
  origin: 'http://127.0.0.1:5173',
});
applyCookies(jar, login.setCookies);
const loginData = login.json['data'] as
  | {
      user?: {
        id?: string;
        email?: string;
        displayName?: string;
        passwordHash?: string;
        role?: string;
      };
      memberships?: { role?: string; workspaceId?: string }[];
      csrfToken?: string;
      sessionExpiresAt?: string;
    }
  | undefined;

check('登录成功返回 200', login.status === 200);
check(
  '登录响应含 user / memberships / csrfToken / sessionExpiresAt',
  loginData?.user?.email === EMAIL &&
    Array.isArray(loginData?.memberships) &&
    loginData?.memberships?.[0]?.role === 'owner' &&
    typeof loginData?.csrfToken === 'string' &&
    typeof loginData?.sessionExpiresAt === 'string',
);
check(
  '登录响应不含密码哈希或角色字段',
  !JSON.stringify(loginData?.user).includes('argon2') &&
    loginData?.user?.passwordHash === undefined &&
    loginData?.user?.role === undefined,
);

const sessionCookieHeader =
  login.setCookies.find((header) => header.startsWith('sfs_session=')) ?? '';
check(
  '会话 Cookie 带 HttpOnly 与 SameSite=Lax，开发环境不带 Secure',
  sessionCookieHeader.includes('HttpOnly') &&
    sessionCookieHeader.includes('SameSite=Lax') &&
    !sessionCookieHeader.includes('Secure'),
);
check(
  'Cookie 中不含角色或密码（只有不透明令牌）',
  !/(owner|editor|viewer|argon2|password)/i.test(sessionCookieHeader) &&
    jar['sfs_session'] !== undefined &&
    jar['sfs_session'] !== PASSWORD,
);
check(
  '登录后 CSRF 令牌已轮换',
  jar['sfs_csrf'] !== undefined && jar['sfs_csrf'] !== csrfTokenFromBody,
);

const sessionCsrf = jar['sfs_csrf'] ?? '';

// ---------------------------------------------------------------- me / 会话列表
const meNoCookie = await call(base, 'GET', '/auth/me', {});
check(
  '未登录访问 /auth/me → 401 UNAUTHENTICATED',
  meNoCookie.status === 401 && errorCode(meNoCookie) === 'UNAUTHENTICATED',
);

const me = await call(base, 'GET', '/auth/me', { jar });
const meData = me.json['data'] as
  | {
      user?: { email?: string };
      memberships?: { role?: string }[];
      preferences?: { theme?: string };
    }
  | undefined;
check(
  '已登录 /auth/me 返回用户与空间',
  me.status === 200 &&
    meData?.user?.email === EMAIL &&
    meData?.memberships?.[0]?.role === 'owner' &&
    meData?.preferences?.theme === 'system',
);

const sessions1 = await call(base, 'GET', '/auth/sessions', { jar });
const sessions1Data = sessions1.json['data'] as
  { sessions?: { id: string; current: boolean }[] } | undefined;
check(
  '会话列表含当前会话',
  sessions1.status === 200 &&
    (sessions1Data?.sessions ?? []).filter((item) => item.current).length === 1,
);

// ---------------------------------------------------------------- 改密（CSRF 与当前会话保留）
const changeNoCsrf = await call(base, 'PATCH', '/auth/password', {
  body: { currentPassword: PASSWORD, newPassword: 'Workbench-Updated-Pass-42' },
  jar,
});
check(
  '改密缺 CSRF → 403',
  changeNoCsrf.status === 403 && errorCode(changeNoCsrf) === 'CSRF_INVALID',
);

const changeWrongCsrf = await call(base, 'PATCH', '/auth/password', {
  body: { currentPassword: PASSWORD, newPassword: 'Workbench-Updated-Pass-42' },
  jar,
  csrf: 'wrong-token',
});
check('改密 CSRF 错误 → 403', changeWrongCsrf.status === 403);

const changed = await call(base, 'PATCH', '/auth/password', {
  body: { currentPassword: PASSWORD, newPassword: 'Workbench-Updated-Pass-42' },
  jar,
  csrf: sessionCsrf,
});
check('改密成功（保留当前会话）', changed.status === 200);
const meAfterChange = await call(base, 'GET', '/auth/me', { jar });
check('改密后当前会话仍有效', meAfterChange.status === 200);

const oldPasswordLogin = await call(base, 'POST', '/auth/login', {
  body: { email: EMAIL, password: PASSWORD },
  jar,
  csrf: sessionCsrf,
});
check('旧密码无法再登录', oldPasswordLogin.status === 401);

const newPasswordLogin = await call(base, 'POST', '/auth/login', {
  body: { email: EMAIL, password: 'Workbench-Updated-Pass-42' },
  jar,
  csrf: sessionCsrf,
});
const secondJar: Jar = {};
applyCookies(secondJar, newPasswordLogin.setCookies);
check(
  '新密码可登录（第二设备）',
  newPasswordLogin.status === 200 && secondJar['sfs_session'] !== undefined,
);

const sessions2 = await call(base, 'GET', '/auth/sessions', { jar });
const sessions2Data = sessions2.json['data'] as
  { sessions?: { id: string; current: boolean }[] } | undefined;
check(
  '两台设备各自有会话',
  (sessions2Data?.sessions ?? []).length === 2 &&
    (sessions2Data?.sessions ?? []).filter((item) => item.current).length === 1,
);

// ---------------------------------------------------------------- 吊销其他会话
const otherSession = (sessions2Data?.sessions ?? []).find((item) => !item.current);
const revokedOther = await call(
  base,
  'DELETE',
  `/auth/sessions/${otherSession?.id ?? '00000000-0000-0000-0000-000000000000'}`,
  {
    jar,
    csrf: sessionCsrf,
  },
);
check('吊销其他会话成功', revokedOther.status === 200);

const secondDeviceAfterRevoke = await call(base, 'GET', '/auth/me', { jar: secondJar });
check('被吊销的会话立即失效（401）', secondDeviceAfterRevoke.status === 401);

const revokeUnknown = await call(
  base,
  'DELETE',
  '/auth/sessions/11111111-1111-1111-1111-111111111111',
  {
    jar,
    csrf: sessionCsrf,
  },
);
check('吊销不存在的会话 → 404', revokeUnknown.status === 404);

// ---------------------------------------------------------------- 过期 / 吊销 / 重启
async function insertSession(options: {
  idleExpiresAt: Date;
  revokedAt?: Date;
  absoluteExpiresAt?: Date;
  userId?: string;
}): Promise<string> {
  const rawToken = randomBytes(32).toString('base64url');
  await prisma.session.create({
    data: {
      userId: options.userId ?? (boot.created ? boot.userId : secondUser.id),
      tokenHash: sha256Hex(rawToken),
      csrfTokenHash: sha256Hex('csrf-for-test'),
      idleExpiresAt: options.idleExpiresAt,
      absoluteExpiresAt: options.absoluteExpiresAt ?? new Date(Date.now() + 86_400_000),
      ...(options.revokedAt === undefined ? {} : { revokedAt: options.revokedAt }),
    },
  });
  return rawToken;
}

const expiredToken = await insertSession({ idleExpiresAt: new Date(Date.now() - 60_000) });
const expiredRes = await call(base, 'GET', '/auth/me', { jar: { sfs_session: expiredToken } });
check(
  '空闲过期会话 → 401 SESSION_EXPIRED',
  expiredRes.status === 401 && errorCode(expiredRes) === 'SESSION_EXPIRED',
);

const revokedToken = await insertSession({
  idleExpiresAt: new Date(Date.now() + 60_000),
  revokedAt: new Date(),
});
const revokedRes = await call(base, 'GET', '/auth/me', { jar: { sfs_session: revokedToken } });
check(
  '已吊销会话 → 401 UNAUTHENTICATED',
  revokedRes.status === 401 && errorCode(revokedRes) === 'UNAUTHENTICATED',
);

const absoluteExpiredToken = await insertSession({
  idleExpiresAt: new Date(Date.now() + 60_000),
  absoluteExpiresAt: new Date(Date.now() - 1_000),
});
const absoluteRes = await call(base, 'GET', '/auth/me', {
  jar: { sfs_session: absoluteExpiredToken },
});
check(
  '绝对过期会话 → 401 SESSION_EXPIRED',
  absoluteRes.status === 401 && errorCode(absoluteRes) === 'SESSION_EXPIRED',
);

// 重启：关闭应用后用同一个 Cookie 访问新进程
await app.close();
({ app, base } = await createApp());
const afterRestart = await call(base, 'GET', '/auth/me', { jar });
check('服务重启后合法会话仍有效', afterRestart.status === 200);

// ---------------------------------------------------------------- 退出
const logout = await call(base, 'POST', '/auth/logout', { jar, csrf: sessionCsrf });
applyCookies(jar, logout.setCookies);
check(
  '退出返回 200 并清除 Cookie',
  logout.status === 200 &&
    logout.setCookies.some(
      (header) => header.startsWith('sfs_session=') && header.includes('Max-Age=0'),
    ),
);
const afterLogout = await call(base, 'GET', '/auth/me', { jar });
check('退出后会话失效（401）', afterLogout.status === 401);

// ---------------------------------------------------------------- 生产 Cookie 标记
process.env['COOKIE_SECURE'] = 'true';
const secureApp = await createApp();
const secureJar: Jar = {};
const secureCsrfRes = await call(secureApp.base, 'GET', '/auth/csrf');
applyCookies(secureJar, secureCsrfRes.setCookies);
const secureLogin = await call(secureApp.base, 'POST', '/auth/login', {
  body: { email: EMAIL, password: 'Workbench-Updated-Pass-42' },
  jar: secureJar,
  csrf: secureJar['sfs_csrf'],
});
applyCookies(secureJar, secureLogin.setCookies);
const secureSessionHeader =
  secureLogin.setCookies.find((header) => header.startsWith('sfs_session=')) ?? '';
check(
  'COOKIE_SECURE=true 时会话 Cookie 带 Secure + HttpOnly',
  secureLogin.status === 200 &&
    secureSessionHeader.includes('Secure') &&
    secureSessionHeader.includes('HttpOnly'),
);
await secureApp.app.close();
process.env['COOKIE_SECURE'] = 'false';

// ---------------------------------------------------------------- 登录失败锁定
const lockEmail = 'lock-target@authtest.local';
await prisma.user.create({
  data: {
    emailNormalized: lockEmail,
    displayName: '锁定目标',
    passwordHash: await hashPassword('Workbench-Lock-Pass-42'),
  },
});
const lockCsrf = await call(base, 'GET', '/auth/csrf');
const lockJar: Jar = {};
applyCookies(lockJar, lockCsrf.setCookies);
const lockToken = lockJar['sfs_csrf'] ?? '';

for (let attempt = 1; attempt <= 5; attempt += 1) {
  await call(base, 'POST', '/auth/login', {
    body: { email: lockEmail, password: 'Definitely-Wrong-42' },
    jar: lockJar,
    csrf: lockToken,
  });
}
const locked = await call(base, 'POST', '/auth/login', {
  body: { email: lockEmail, password: 'Workbench-Lock-Pass-42' },
  jar: lockJar,
  csrf: lockToken,
});
const lockedError = locked.json['error'] as
  { code?: string; details?: { retryAfterSeconds?: number } } | undefined;
check(
  '连续 5 次失败后即使密码正确也返回 429（含 retryAfterSeconds）',
  locked.status === 429 &&
    lockedError?.code === 'RATE_LIMITED' &&
    (lockedError?.details?.retryAfterSeconds ?? 0) > 0,
);

await app.close();
await prisma.$executeRawUnsafe(
  'TRUNCATE TABLE users, workspaces, sessions, account_recovery_tokens, audit_events RESTART IDENTITY CASCADE',
);
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
