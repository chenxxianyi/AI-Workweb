import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { config as loadEnvFile } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { bootstrapOwner } from '../src/modules/auth/auth-core.js';

/**
 * F10 验收：空间、成员、邀请与角色权限。
 *   pnpm --filter @aiwb/api test:workspace
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
if (!databaseName.endsWith('_test')) {
  console.error(`拒绝在非测试库上运行：${databaseName}`);
  process.exit(1);
}
console.log(`[workspace-check] 数据库：${databaseName}`);

process.env['DATABASE_URL'] = databaseUrl;
process.env['RATE_LIMIT_LOGIN_PER_MINUTE'] = '100';
process.env['COOKIE_SECURE'] = 'false';

const { AppModule } = await import('../src/app.module.js');
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });

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
  return entries.length === 0 ? undefined : entries.map(([name, value]) => `${name}=${value}`).join('; ');
}

const app: INestApplication = await NestFactory.create(AppModule, { logger: ['error'] });
app.setGlobalPrefix('api/v1');
await app.listen(0, '127.0.0.1');
const address = app.getHttpServer().address() as { port: number };
const base = `http://127.0.0.1:${address.port}/api/v1`;

function call(
  method: string,
  path: string,
  options: { body?: unknown; jar?: Jar; csrf?: string; ifMatch?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const cookie = options.jar === undefined ? undefined : cookieHeader(options.jar);
  if (cookie !== undefined) headers['cookie'] = cookie;
  if (options.csrf !== undefined) headers['x-csrf-token'] = options.csrf;
  if (options.ifMatch !== undefined) headers['if-match'] = `"${options.ifMatch}"`;

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

async function login(email: string, password: string): Promise<{ jar: Jar; csrf: string }> {
  const jar: Jar = {};
  const csrfRes = await call('GET', '/auth/csrf');
  applyCookies(jar, csrfRes.setCookies);
  const csrf = jar['sfs_csrf'] ?? '';
  const loginRes = await call('POST', '/auth/login', { body: { email, password }, jar, csrf });
  if (loginRes.status !== 200) throw new Error(`登录失败：${email} ${loginRes.status}`);
  applyCookies(jar, loginRes.setCookies);
  return { jar, csrf: jar['sfs_csrf'] ?? '' };
}

// ---------------------------------------------------------------- 准备
await prisma.$executeRawUnsafe(
  'TRUNCATE TABLE users, workspaces, workspace_members, workspace_invites, sessions, account_recovery_tokens, audit_events RESTART IDENTITY CASCADE',
);

const OWNER_EMAIL = 'ws-owner@authtest.local';
const OWNER_PASSWORD = 'Workbench-Alpha-Pass-42';
const boot = await bootstrapOwner(prisma, { email: OWNER_EMAIL, displayName: '空间 Owner', password: OWNER_PASSWORD });
check('准备：Owner 与个人空间创建成功', boot.created === true);

const owner = await login(OWNER_EMAIL, OWNER_PASSWORD);

// ---------------------------------------------------------------- 空间列表与创建
const listed = await call('GET', '/workspaces', { jar: owner.jar });
const workspaces = (listed.json['data'] as { workspaces?: { id: string; role: string }[] } | undefined)?.workspaces ?? [];
check('空间列表包含个人空间且角色为 owner', listed.status === 200 && workspaces.length === 1 && workspaces[0]?.role === 'owner');

const personalId = workspaces[0]?.id ?? '';

const noCsrfCreate = await call('POST', '/workspaces', { body: { name: '无 CSRF' }, jar: owner.jar });
check('创建空间缺 CSRF → 403', noCsrfCreate.status === 403 && errorCode(noCsrfCreate) === 'CSRF_INVALID');

const created = await call('POST', '/workspaces', {
  body: { name: '团队空间 A', timezone: 'Asia/Shanghai' },
  jar: owner.jar,
  csrf: owner.csrf,
});
const createdData = created.json['data'] as { id?: string; version?: number } | undefined;
check('创建空间成功（201，版本 1，创建者为 Owner）', created.status === 201 && createdData?.version === 1);
const spaceA = createdData?.id ?? '';

const detail = await call('GET', `/workspaces/${spaceA}`, { jar: owner.jar });
check('读取空间详情', detail.status === 200 && (detail.json['data'] as { role?: string } | undefined)?.role === 'owner');

const randomSpace = await call('GET', '/workspaces/11111111-1111-1111-1111-111111111111', { jar: owner.jar });
check('访问不存在或不是成员的空间 → 404', randomSpace.status === 404 && errorCode(randomSpace) === 'NOT_FOUND');

// ---------------------------------------------------------------- 条件写
const noIfMatch = await call('PATCH', `/workspaces/${spaceA}`, { body: { name: '改名' }, jar: owner.jar, csrf: owner.csrf });
check('PATCH 缺 If-Match → 428', noIfMatch.status === 428 && errorCode(noIfMatch) === 'PRECONDITION_REQUIRED');

const stale = await call('PATCH', `/workspaces/${spaceA}`, {
  body: { name: '改名' },
  jar: owner.jar,
  csrf: owner.csrf,
  ifMatch: '99',
});
check('PATCH 版本过期 → 412 且返回 currentVersion', stale.status === 412 && errorCode(stale) === 'PRECONDITION_FAILED');

const updated = await call('PATCH', `/workspaces/${spaceA}`, {
  body: { name: '团队空间 A（改名）' },
  jar: owner.jar,
  csrf: owner.csrf,
  ifMatch: '1',
});
check('PATCH 正确版本成功并升版', updated.status === 200 && (updated.json['data'] as { version?: number } | undefined)?.version === 2);

// ---------------------------------------------------------------- 成员与邀请
const members = await call('GET', `/workspaces/${spaceA}/members`, { jar: owner.jar });
const memberList = (members.json['data'] as { members?: { userId: string; isLastOwner: boolean }[] } | undefined)?.members ?? [];
check('成员列表仅 1 位 Owner 且标记最后 Owner', members.status === 200 && memberList.length === 1 && memberList[0]?.isLastOwner === true);

const badInvite = await call('POST', `/workspaces/${spaceA}/invitations`, {
  body: { email: 'x@authtest.local', role: 'owner' },
  jar: owner.jar,
  csrf: owner.csrf,
});
check('直接邀请 Owner → 422', badInvite.status === 422);

const invite = await call('POST', `/workspaces/${spaceA}/invitations`, {
  body: { email: 'ws-editor@authtest.local', role: 'editor' },
  jar: owner.jar,
  csrf: owner.csrf,
});
const inviteData = invite.json['data'] as { inviteId?: string; token?: string } | undefined;
check('创建邀请返回一次性令牌', invite.status === 201 && (inviteData?.token ?? '').length > 20);

const inviteList = await call('GET', `/workspaces/${spaceA}/invitations`, { jar: owner.jar });
const invites = (inviteList.json['data'] as { invitations?: Record<string, unknown>[] } | undefined)?.invitations ?? [];
check('邀请列表不回显令牌', inviteList.status === 200 && invites.length === 1 && !JSON.stringify(invites).includes(inviteData?.token ?? 'x'));

// 新用户接受邀请
const accepted = await call('POST', '/auth/invitations/accept', {
  body: { token: inviteData?.token, password: 'Workbench-Beta-Pass-42', displayName: '编辑者' },
});
check('新账号接受邀请成功', accepted.status === 200 && (accepted.json['data'] as { createdUser?: boolean } | undefined)?.createdUser === true);

const replay = await call('POST', '/auth/invitations/accept', { body: { token: inviteData?.token } });
check('邀请令牌不能重复使用 → 404', replay.status === 404);

const editor = await login('ws-editor@authtest.local', 'Workbench-Beta-Pass-42');
const editorSpaces = await call('GET', '/workspaces', { jar: editor.jar });
const editorSpaceList =
  (editorSpaces.json['data'] as { workspaces?: { id?: string; role?: string }[] } | undefined)?.workspaces ?? [];
check(
  '接受邀请后出现在其空间列表且角色为 editor',
  editorSpaceList.length === 1 && editorSpaceList[0]?.id === spaceA && editorSpaceList[0]?.role === 'editor',
);

// ---------------------------------------------------------------- 角色权限
const editorPatch = await call('PATCH', `/workspaces/${spaceA}`, {
  body: { name: '编辑者改名' },
  jar: editor.jar,
  csrf: editor.csrf,
});
check('Editor 修改空间 → 403', editorPatch.status === 403 && errorCode(editorPatch) === 'FORBIDDEN');

const editorInvite = await call('POST', `/workspaces/${spaceA}/invitations`, {
  body: { email: 'other@authtest.local', role: 'viewer' },
  jar: editor.jar,
  csrf: editor.csrf,
});
check('Editor 邀请他人 → 403', editorInvite.status === 403);

const editorMembers = await call('GET', `/workspaces/${spaceA}/members`, { jar: editor.jar });
check('Editor 可读成员列表', editorMembers.status === 200);

// ---------------------------------------------------------------- 最后 Owner 保护
const membersAfterInvite = await call('GET', `/workspaces/${spaceA}/members`, { jar: owner.jar });
const ownerMember = ((membersAfterInvite.json['data'] as { members?: { role: string; version: number; userId: string }[] } | undefined)?.members ?? []).find(
  (member) => member.role === 'owner',
);
const demoteSelf = await call('PATCH', `/workspaces/${spaceA}/members/${ownerMember?.userId ?? ''}`, {
  body: { role: 'viewer' },
  jar: owner.jar,
  csrf: owner.csrf,
  ifMatch: String(ownerMember?.version ?? 1),
});
check('把最后一位 Owner 降级 → 409 LAST_OWNER_PROTECTED', demoteSelf.status === 409 && errorCode(demoteSelf) === 'LAST_OWNER_PROTECTED');

const removeOwner = await call('DELETE', `/workspaces/${spaceA}/members/${ownerMember?.userId ?? ''}`, {
  jar: owner.jar,
  csrf: owner.csrf,
});
check('移除最后一位 Owner → 409', removeOwner.status === 409 && errorCode(removeOwner) === 'LAST_OWNER_PROTECTED');

// ---------------------------------------------------------------- 移除成员与集合失效
const editorMember = ((membersAfterInvite.json['data'] as { members?: { role: string; userId: string }[] } | undefined)?.members ?? []).find(
  (member) => member.role === 'editor',
);
const removeEditor = await call('DELETE', `/workspaces/${spaceA}/members/${editorMember?.userId ?? ''}`, {
  jar: owner.jar,
  csrf: owner.csrf,
});
check('Owner 移除 Editor 成功并吊销会话', removeEditor.status === 200 && ((removeEditor.json['data'] as { revokedSessions?: number } | undefined)?.revokedSessions ?? 0) >= 1);

const editorAfterRemoval = await call('GET', '/workspaces', { jar: editor.jar });
check('被移除成员的会话立即失效（401）', editorAfterRemoval.status === 401);

// ---------------------------------------------------------------- 空间隔离
const otherSpace = await call('POST', '/workspaces', {
  body: { name: '另一个空间' },
  jar: owner.jar,
  csrf: owner.csrf,
});
const otherSpaceId = (otherSpace.json['data'] as { id?: string } | undefined)?.id ?? '';
const viewerInvite = await call('POST', `/workspaces/${otherSpaceId}/invitations`, {
  body: { email: 'ws-viewer@authtest.local', role: 'viewer' },
  jar: owner.jar,
  csrf: owner.csrf,
});
const viewerToken = (viewerInvite.json['data'] as { token?: string } | undefined)?.token ?? '';
await call('POST', '/auth/invitations/accept', {
  body: { token: viewerToken, password: 'Workbench-Gamma-Pass-42', displayName: '只读者' },
});
const viewer = await login('ws-viewer@authtest.local', 'Workbench-Gamma-Pass-42');

const viewerCanRead = await call('GET', `/workspaces/${otherSpaceId}`, { jar: viewer.jar });
check('Viewer 可读所属空间', viewerCanRead.status === 200);

const viewerCrossSpace = await call('GET', `/workspaces/${spaceA}`, { jar: viewer.jar });
check('Viewer 访问未加入的空间 → 404（不泄露存在性）', viewerCrossSpace.status === 404);

const viewerWrite = await call('PATCH', `/workspaces/${otherSpaceId}`, {
  body: { name: 'Viewer 改名' },
  jar: viewer.jar,
  csrf: viewer.csrf,
});
check('Viewer 写入被拒（403）', viewerWrite.status === 403);

const viewerRemoveOther = await call('DELETE', `/workspaces/${otherSpaceId}/members/${ownerMember?.userId ?? ''}`, {
  jar: viewer.jar,
  csrf: viewer.csrf,
});
check('Viewer 移除他人被拒（403）', viewerRemoveOther.status === 403);

// ---------------------------------------------------------------- 清理
await app.close();
await prisma.$executeRawUnsafe(
  'TRUNCATE TABLE users, workspaces, workspace_members, workspace_invites, sessions, account_recovery_tokens, audit_events RESTART IDENTITY CASCADE',
);
await prisma.$disconnect();

const failed = results.filter((item) => !item.ok);
for (const item of results) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.ok ? '' : `  ← ${item.detail ?? ''}`}`);
}
console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
process.exitCode = failed.length === 0 ? 0 : 1;
