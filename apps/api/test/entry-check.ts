import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { config as loadEnvFile } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { bootstrapOwner } from '../src/modules/auth/auth-core.js';
import { hashPassword } from '../src/modules/auth/password.js';

/**
 * F19 验收：知识条目的状态机、20KB 边界、标签与跨空间关系。
 *   pnpm --filter @aiwb/api test:entry
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
console.log(`[entry-check] 数据库：${databaseName}`);

process.env['DATABASE_URL'] = databaseUrl;
process.env['RATE_LIMIT_LOGIN_PER_MINUTE'] = '100';
process.env['COOKIE_SECURE'] = 'false';

const { AppModule } = await import('../src/app.module.js');
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl, options: '-c timezone=UTC' }) });

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
  options: { body?: unknown; jar?: Jar; csrf?: string; ifMatch?: string; idempotencyKey?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const cookie = options.jar === undefined ? undefined : cookieHeader(options.jar);
  if (cookie !== undefined) headers['cookie'] = cookie;
  if (options.csrf !== undefined) headers['x-csrf-token'] = options.csrf;
  if (options.ifMatch !== undefined) headers['if-match'] = `"${options.ifMatch}"`;
  if (options.idempotencyKey !== undefined) headers['idempotency-key'] = options.idempotencyKey;

  return fetch(`${base}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }).then(async (response) => {
    const text = await response.text();
    const setCookies =
      typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>), setCookies };
  });
}

function errorCode(response: Res): string | undefined {
  return (response.json['error'] as { code?: string } | undefined)?.code;
}

async function login(email: string, password: string): Promise<{ jar: Jar; csrf: string }> {
  const jar: Jar = {};
  const csrfRes = await call('GET', '/auth/csrf');
  applyCookies(jar, csrfRes.setCookies);
  const csrf = jar['sfs_csrf'] ?? '';
  const loginRes = await call('POST', '/auth/login', { body: { email, password }, jar, csrf });
  if (loginRes.status !== 200) throw new Error(`登录失败 ${email}: ${loginRes.status}`);
  applyCookies(jar, loginRes.setCookies);
  return { jar, csrf: jar['sfs_csrf'] ?? '' };
}

/** 构造恰好 N 字节的混合正文：中文 3 字节 + 英文 1 字节 */
function bodyOfBytes(bytes: number): string {
  const chinese = Math.floor(bytes / 3 / 2);
  const rest = bytes - chinese * 3;
  return '知'.repeat(chinese) + 'a'.repeat(rest);
}

// ---------------------------------------------------------------- 准备
await prisma.$executeRawUnsafe(
  'TRUNCATE TABLE users, workspaces, workspace_members, workspace_invites, sessions, account_recovery_tokens, audit_events, projects, tasks, entries, entry_tags, entry_usage, entry_revisions, tags, ledger_records, idempotency_records RESTART IDENTITY CASCADE',
);

const OWNER_EMAIL = 'entry-owner@authtest.local';
const OWNER_PASSWORD = 'Workbench-Mu-Entry-42';
const boot = await bootstrapOwner(prisma, { email: OWNER_EMAIL, displayName: '知识 Owner', password: OWNER_PASSWORD });
check('准备：Owner 与个人空间创建成功', boot.created === true);
const spaceId = boot.created ? boot.workspaceId : '';
const ownerId = boot.created ? boot.userId : '';
const path = `/workspaces/${spaceId}/entries`;

const viewer = await prisma.user.create({
  data: {
    emailNormalized: 'entry-viewer@authtest.local',
    displayName: '只读成员',
    passwordHash: await hashPassword('Workbench-Nu-Viewer-42'),
  },
});
await prisma.workspaceMember.create({ data: { workspaceId: spaceId, userId: viewer.id, role: 'viewer' } });
const owner = await login(OWNER_EMAIL, OWNER_PASSWORD);
const viewerSession = await login('entry-viewer@authtest.local', 'Workbench-Nu-Viewer-42');

const project = await prisma.project.create({
  data: { workspaceId: spaceId, createdBy: ownerId, name: '知识关联项目', nextStep: '' },
});

// ---------------------------------------------------------------- 草稿可缺字段
const draft = await call('POST', path, { body: {}, jar: owner.jar, csrf: owner.csrf, idempotencyKey: 'entry-draft-1' });
const draftData = draft.json['data'] as { entry?: { id?: string; status?: string; title?: string } } | undefined;
check('草稿可只创建空壳（无标题/摘要/正文）', draft.status === 201 && draftData?.entry?.status === 'draft');
const draftId = draftData?.entry?.id ?? '';

// ---------------------------------------------------------------- 20KB 边界
const exact = bodyOfBytes(20480);
const over = bodyOfBytes(20481);
check('构造的边界正文分别为 20480 与 20481 字节', Buffer.byteLength(exact, 'utf8') === 20480 && Buffer.byteLength(over, 'utf8') === 20481);

const atLimit = await call('PATCH', `${path}/${draftId}`, {
  body: { body: exact, title: '边界正文' },
  jar: owner.jar,
  csrf: owner.csrf,
  ifMatch: '1',
});
check('20480 字节正文可保存', atLimit.status === 200 && (atLimit.json['data'] as { bodyBytes?: number } | undefined)?.bodyBytes === 20480);

const tooBig = await call('PATCH', `${path}/${draftId}`, {
  body: { body: over },
  jar: owner.jar,
  csrf: owner.csrf,
  ifMatch: '2',
});
check('20481 字节正文被拒（413 PAYLOAD_TOO_LARGE）', tooBig.status === 413 && errorCode(tooBig) === 'PAYLOAD_TOO_LARGE', `status=${tooBig.status}`);

// ---------------------------------------------------------------- 状态机
const verifiedMissing = await call('POST', `${path}/${draftId}/status`, {
  body: { status: 'verified' },
  jar: owner.jar,
  csrf: owner.csrf,
  ifMatch: '2',
});
const missingError = verifiedMissing.json['error'] as { fieldErrors?: Record<string, string[]> } | undefined;
check(
  '已有标题与正文但缺摘要时转 verified → 422 且指出 summary',
  verifiedMissing.status === 422 &&
    errorCode(verifiedMissing) === 'VALIDATION_FAILED' &&
    missingError?.fieldErrors?.['summary'] !== undefined,
  `status=${verifiedMissing.status} fields=${Object.keys(missingError?.fieldErrors ?? {}).join(',')}`,
);

// 完全空白的草稿：标题、摘要、正文都缺
const blankDraft = await call('POST', path, { body: {}, jar: owner.jar, csrf: owner.csrf, idempotencyKey: 'entry-blank-1' });
const blankId = (blankDraft.json['data'] as { entry?: { id?: string } } | undefined)?.entry?.id ?? '';
const blankVerify = await call('POST', `${path}/${blankId}/status`, {
  body: { status: 'verified' },
  jar: owner.jar,
  csrf: owner.csrf,
  ifMatch: '1',
});
const blankFields = (blankVerify.json['error'] as { fieldErrors?: Record<string, string[]> } | undefined)?.fieldErrors ?? {};
check(
  '空草稿转 verified → 422 且同时指出 title/summary/body',
  blankVerify.status === 422 && ['title', 'summary', 'body'].every((field) => blankFields[field] !== undefined),
  `fields=${Object.keys(blankFields).join(',')}`,
);
// 清理空草稿，避免影响后续计数断言
await call('DELETE', `${path}/${blankId}`, { jar: owner.jar, csrf: owner.csrf, ifMatch: '1' });

const sameState = await call('POST', `${path}/${draftId}/status`, {
  body: { status: 'draft' },
  jar: owner.jar,
  csrf: owner.csrf,
  ifMatch: '2',
});
check('draft → draft 非法转换 → 422 ENTRY_STATE_INVALID', sameState.status === 422 && errorCode(sameState) === 'ENTRY_STATE_INVALID');

const complete = await call('PATCH', `${path}/${draftId}`, {
  body: { title: '会话守卫设计', summary: '记录会话与 CSRF 的取舍', body: '正文内容' },
  jar: owner.jar,
  csrf: owner.csrf,
  ifMatch: '2',
});
check('补全标题/摘要/正文成功', complete.status === 200);

const verify = await call('POST', `${path}/${draftId}/status`, {
  body: { status: 'verified' },
  jar: owner.jar,
  csrf: owner.csrf,
  ifMatch: '3',
});
check('补全后 draft → verified 成功且版本 +1', verify.status === 200 && (verify.json['data'] as { status?: string; version?: number } | undefined)?.status === 'verified' && (verify.json['data'] as { version?: number } | undefined)?.version === 4);

const demote = await call('POST', `${path}/${draftId}/status`, {
  body: { status: 'draft' },
  jar: owner.jar,
  csrf: owner.csrf,
  ifMatch: '4',
});
check('verified → draft 允许（返工）', demote.status === 200);

const archive = await call('POST', `${path}/${draftId}/status`, {
  body: { status: 'archived' },
  jar: owner.jar,
  csrf: owner.csrf,
  ifMatch: '5',
});
check('draft → archived 允许', archive.status === 200);

const archivedToVerified = await call('POST', `${path}/${draftId}/status`, {
  body: { status: 'verified' },
  jar: owner.jar,
  csrf: owner.csrf,
  ifMatch: '6',
});
check('archived → verified 非法 → 422', archivedToVerified.status === 422 && errorCode(archivedToVerified) === 'ENTRY_STATE_INVALID');

const restore = await call('POST', `${path}/${draftId}/status`, {
  body: { status: 'draft' },
  jar: owner.jar,
  csrf: owner.csrf,
  ifMatch: '6',
});
check('archived → draft 恢复成功', restore.status === 200);

// ---------------------------------------------------------------- 标签
const tagged = await call('POST', path, {
  body: {
    type: 'adr',
    title: '用 Prisma 7 的原因',
    summary: 'ADR-0002 摘要',
    body: '正文',
    tags: ['React', ' react ', '#NestJS', 'React'],
    projectId: project.id,
  },
  jar: owner.jar,
  csrf: owner.csrf,
  idempotencyKey: 'entry-tagged-1',
});
const taggedData = tagged.json['data'] as { entry?: { id?: string; tags?: string[] } } | undefined;
check('标签归一化去重（react / nestjs）', tagged.status === 201 && (taggedData?.entry?.tags ?? []).length === 2 && (taggedData?.entry?.tags ?? []).includes('react'));
const taggedId = taggedData?.entry?.id ?? '';

const tagList = await call('GET', `/workspaces/${spaceId}/tags`, { jar: owner.jar });
const tags = (tagList.json['data'] as { tags?: { name: string; count: number }[] } | undefined)?.tags ?? [];
check('标签列表含 react 且计数正确', tags.some((tag) => tag.name === 'react' && tag.count === 1));

const byTag = await call('GET', `${path}?tag=REACT`, { jar: owner.jar });
check('按标签筛选（大小写不敏感）', (byTag.json['data'] as { entries?: { id?: string }[] } | undefined)?.entries?.length === 1);

// ---------------------------------------------------------------- 关系必须同空间
const otherSpace = await prisma.workspace.create({
  data: { name: '另一空间', timezone: 'Asia/Shanghai', createdBy: ownerId },
});
await prisma.workspaceMember.create({ data: { workspaceId: otherSpace.id, userId: ownerId, role: 'owner' } });
const otherProject = await prisma.project.create({
  data: { workspaceId: otherSpace.id, createdBy: ownerId, name: '别空间项目', nextStep: '' },
});

const crossProject = await call('POST', path, {
  body: { title: '跨空间关联', projectId: otherProject.id },
  jar: owner.jar,
  csrf: owner.csrf,
  idempotencyKey: 'entry-cross-project',
});
check('关联别空间项目 → 422', crossProject.status === 422 && errorCode(crossProject) === 'VALIDATION_FAILED');

const crossRead = await call('GET', `/workspaces/${otherSpace.id}/entries/${taggedId}`, { jar: owner.jar });
check('跨空间读取条目 → 404', crossRead.status === 404);

const otherList = await call('GET', `/workspaces/${otherSpace.id}/entries`, { jar: owner.jar });
check('另一空间列表为空', (otherList.json['data'] as { entries?: unknown[] } | undefined)?.entries?.length === 0);

// ---------------------------------------------------------------- 版本快照与条件写
const beforeRevisions = await call('GET', `${path}/${taggedId}/revisions`, { jar: owner.jar });
const revisionsBefore = (beforeRevisions.json['data'] as { revisions?: unknown[] } | undefined)?.revisions?.length ?? 0;

const editBody = await call('PATCH', `${path}/${taggedId}`, {
  body: { body: '新的正文内容' },
  jar: owner.jar,
  csrf: owner.csrf,
  ifMatch: '1',
});
check('修改正文成功', editBody.status === 200);

const afterRevisions = await call('GET', `${path}/${taggedId}/revisions`, { jar: owner.jar });
const revisionsAfter = (afterRevisions.json['data'] as { revisions?: { bodyBytes?: number }[] } | undefined)?.revisions ?? [];
check('修改正文后生成一条版本快照', revisionsAfter.length === revisionsBefore + 1);
check('快照保存的是修改前正文（3 字节）', revisionsAfter[0]?.bodyBytes === Buffer.byteLength('正文', 'utf8'));

const noMatch = await call('PATCH', `${path}/${taggedId}`, { body: { title: '无 If-Match' }, jar: owner.jar, csrf: owner.csrf });
check('PATCH 缺 If-Match → 428', noMatch.status === 428);

const stale = await call('PATCH', `${path}/${taggedId}`, { body: { title: '过期' }, jar: owner.jar, csrf: owner.csrf, ifMatch: '1' });
check('PATCH 过期版本 → 412 且返回 currentVersion', stale.status === 412 && (stale.json['error'] as { currentVersion?: number } | undefined)?.currentVersion === 2);

// ---------------------------------------------------------------- 幂等与权限
const replay = await call('POST', path, {
  body: { type: 'adr', title: '用 Prisma 7 的原因', summary: 'ADR-0002 摘要', body: '正文', tags: ['React', ' react ', '#NestJS', 'React'], projectId: project.id },
  jar: owner.jar,
  csrf: owner.csrf,
  idempotencyKey: 'entry-tagged-1',
});
check('同键重试返回首次结果', (replay.json['data'] as { replayed?: boolean } | undefined)?.replayed === true);
check('同键重试不新增条目', (await prisma.entry.count({ where: { workspaceId: spaceId, deletedAt: null } })) === 2);

const viewerCreate = await call('POST', path, { body: { title: 'Viewer 的条目' }, jar: viewerSession.jar, csrf: viewerSession.csrf, idempotencyKey: 'entry-viewer' });
check('Viewer 创建 → 403', viewerCreate.status === 403);
check('Viewer 可读列表', (await call('GET', path, { jar: viewerSession.jar })).status === 200);

// ---------------------------------------------------------------- 列表筛选与分页
const byType = await call('GET', `${path}?type=adr`, { jar: owner.jar });
check('按类型筛选', (byType.json['data'] as { entries?: { type?: string }[] } | undefined)?.entries?.every((entry) => entry.type === 'adr') === true);

const byQuery = await call('GET', `${path}?q=会话守卫`, { jar: owner.jar });
check('关键词搜索命中标题', ((byQuery.json['data'] as { entries?: unknown[] } | undefined)?.entries?.length ?? 0) === 1);

const page1 = await call('GET', `${path}?limit=1`, { jar: owner.jar });
const page1Data = page1.json['data'] as { entries?: { id: string }[]; hasMore?: boolean; nextCursor?: string | null } | undefined;
check('limit=1 有下一页', page1Data?.entries?.length === 1 && page1Data?.hasMore === true);
const page2 = await call('GET', `${path}?limit=1&cursor=${page1Data?.nextCursor ?? ''}`, { jar: owner.jar });
check('第二页与第一页不同', ((page2.json['data'] as { entries?: { id: string }[] } | undefined)?.entries ?? []).every((entry) => entry.id !== page1Data?.entries?.[0]?.id));

// ---------------------------------------------------------------- 删除
const removed = await call('DELETE', `${path}/${taggedId}`, { jar: owner.jar, csrf: owner.csrf, ifMatch: '2' });
check('软删除成功', removed.status === 200);
check('删除后详情 → 404', (await call('GET', `${path}/${taggedId}`, { jar: owner.jar })).status === 404);

// ---------------------------------------------------------------- 清理
await app.close();
await prisma.$executeRawUnsafe(
  'TRUNCATE TABLE users, workspaces, workspace_members, workspace_invites, sessions, account_recovery_tokens, audit_events, projects, tasks, entries, entry_tags, entry_usage, entry_revisions, tags, ledger_records, idempotency_records RESTART IDENTITY CASCADE',
);
await prisma.$disconnect();

const failed = results.filter((item) => !item.ok);
for (const item of results) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.ok ? '' : `  ← ${item.detail ?? ''}`}`);
}
console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
process.exitCode = failed.length === 0 ? 0 : 1;
