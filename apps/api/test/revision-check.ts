import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { config as loadEnvFile } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { createPrismaAdapter } from '../src/common/prisma-adapter.js';
import { bootstrapOwner } from '../src/modules/auth/auth-core.js';

/**
 * F21 验收：修订保留 5 条、回滚顺序、并发与事务。
 *   pnpm --filter @aiwb/api test:revision
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
console.log(`[revision-check] 数据库：${databaseName}`);

process.env['DATABASE_URL'] = databaseUrl;
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

const app: INestApplication = await NestFactory.create(AppModule, { logger: ['error'] });
app.setGlobalPrefix('api/v1');
await app.listen(0, '127.0.0.1');
const address = app.getHttpServer().address() as { port: number };
const base = `http://127.0.0.1:${address.port}/api/v1`;

function call(
  method: string,
  path: string,
  options: {
    body?: unknown;
    jar?: Jar;
    csrf?: string;
    ifMatch?: string;
    idempotencyKey?: string;
  } = {},
): Promise<Res> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (method === 'POST' && (path === '/workspaces' || /^\/workspaces\/[^/]+\/projects$/.test(path)))
    headers['idempotency-key'] = globalThis.crypto.randomUUID();
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
    return {
      status: response.status,
      json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
      setCookies,
    };
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

// ---------------------------------------------------------------- 准备
await prisma.$executeRawUnsafe(
  'TRUNCATE TABLE users, workspaces, workspace_members, workspace_invites, sessions, account_recovery_tokens, audit_events, projects, tasks, entries, entry_tags, entry_usage, entry_revisions, tags, ledger_records, idempotency_records RESTART IDENTITY CASCADE',
);

const OWNER_EMAIL = 'rev-owner@authtest.local';
const OWNER_PASSWORD = 'Workbench-Xi-Revision-42';
const boot = await bootstrapOwner(prisma, {
  email: OWNER_EMAIL,
  displayName: '修订 Owner',
  password: OWNER_PASSWORD,
});
check('准备：Owner 与个人空间创建成功', boot.created === true);
const spaceId = boot.created ? boot.workspaceId : '';
const ownerId = boot.created ? boot.userId : '';
const path = `/workspaces/${spaceId}/entries`;
const owner = await login(OWNER_EMAIL, OWNER_PASSWORD);

const created = await call('POST', path, {
  body: { title: '修订测试条目', summary: '摘要', body: 'v1', tags: ['修订'] },
  jar: owner.jar,
  csrf: owner.csrf,
  idempotencyKey: 'rev-create-1',
});
const entryId = (created.json['data'] as { entry?: { id?: string } } | undefined)?.entry?.id ?? '';
check('创建条目', created.status === 201 && entryId !== '');

// ---------------------------------------------------------------- 7 次修改只留 5 版
let version = 1;
for (let index = 2; index <= 8; index += 1) {
  const response = await call('PATCH', `${path}/${entryId}`, {
    body: { body: `v${index}` },
    jar: owner.jar,
    csrf: owner.csrf,
    ifMatch: String(version),
  });
  if (response.status !== 200) throw new Error(`第 ${index} 次修改失败：${response.status}`);
  version += 1;
}

const revisionList = await call('GET', `${path}/${entryId}/revisions`, { jar: owner.jar });
const revisions =
  (
    revisionList.json['data'] as
      { revisions?: { id: string; body: string; savedAt: string }[] } | undefined
  )?.revisions ?? [];
check('连续修改 7 次后只保留最近 5 条修订', revisions.length === 5, `实际 ${revisions.length}`);
check(
  '保留的是 v3～v7（最新在前）',
  revisions.map((revision) => revision.body).join(',') === 'v7,v6,v5,v4,v3',
  revisions.map((revision) => revision.body).join(','),
);

const bodyNow = await call('GET', `${path}/${entryId}`, { jar: owner.jar });
check('当前正文为 v8', (bodyNow.json['data'] as { body?: string } | undefined)?.body === 'v8');

// ---------------------------------------------------------------- 只改标签不新增修订
const tagOnly = await call('PATCH', `${path}/${entryId}`, {
  body: { tags: ['修订', '标签变更'] },
  jar: owner.jar,
  csrf: owner.csrf,
  ifMatch: String(version),
});
version += 1;
const afterTag = await call('GET', `${path}/${entryId}/revisions`, { jar: owner.jar });
check(
  '只改标签不新增正文修订',
  tagOnly.status === 200 &&
    ((afterTag.json['data'] as { revisions?: unknown[] } | undefined)?.revisions?.length ?? 0) ===
      5,
);

// ---------------------------------------------------------------- 回滚
const oldest = revisions[revisions.length - 1];
const restore = await call('POST', `${path}/${entryId}/revisions/${oldest?.id ?? ''}/restore`, {
  jar: owner.jar,
  csrf: owner.csrf,
  ifMatch: String(version),
});
const restoreData = restore.json['data'] as
  { body?: string; version?: number; tags?: string[] } | undefined;
version += 1;
check('回滚成功且正文变为目标修订（v3）', restore.status === 200 && restoreData?.body === 'v3');
check(
  '回滚不改变标签',
  Array.isArray(restoreData?.tags) && (restoreData?.tags ?? []).includes('标签变更'),
);

const afterRestore = await call('GET', `${path}/${entryId}/revisions`, { jar: owner.jar });
const restoredRevisions =
  (afterRestore.json['data'] as { revisions?: { id: string; body: string }[] } | undefined)
    ?.revisions ?? [];
check(
  '回滚前先保存当前正文（v8 成为最新修订）',
  restoredRevisions[0]?.body === 'v8',
  restoredRevisions.map((revision) => revision.body).join(','),
);
check('回滚后修订仍为 5 条（事务内裁剪）', restoredRevisions.length === 5);

// 回滚可再恢复刚才的内容
const restoreBack = await call(
  'POST',
  `${path}/${entryId}/revisions/${restoredRevisions[0]?.id ?? ''}/restore`,
  {
    jar: owner.jar,
    csrf: owner.csrf,
    ifMatch: String(version),
  },
);
version += 1;
check(
  '可以再回滚到“回滚前的内容”（v8）',
  restoreBack.status === 200 &&
    (restoreBack.json['data'] as { body?: string } | undefined)?.body === 'v8',
);

// ---------------------------------------------------------------- 并发回滚
const currentList = await call('GET', `${path}/${entryId}/revisions`, { jar: owner.jar });
const target = ((currentList.json['data'] as { revisions?: { id: string }[] } | undefined)
  ?.revisions ?? [])[1];
const concurrentA = await call('POST', `${path}/${entryId}/revisions/${target?.id ?? ''}/restore`, {
  jar: owner.jar,
  csrf: owner.csrf,
  ifMatch: String(version),
});
const versionAfterA =
  (concurrentA.json['data'] as { version?: number } | undefined)?.version ?? version + 1;
const concurrentB = await call('POST', `${path}/${entryId}/revisions/${target?.id ?? ''}/restore`, {
  jar: owner.jar,
  csrf: owner.csrf,
  ifMatch: String(version),
});
check(
  '并发回滚：第一次成功、第二次 412',
  concurrentA.status === 200 &&
    concurrentB.status === 412 &&
    errorCode(concurrentB) === 'PRECONDITION_FAILED',
);
version = versionAfterA;

// ---------------------------------------------------------------- 错误路径
const noMatch = await call('POST', `${path}/${entryId}/revisions/${target?.id ?? ''}/restore`, {
  jar: owner.jar,
  csrf: owner.csrf,
});
check('回滚缺 If-Match → 428', noMatch.status === 428);

const otherEntry = await call('POST', path, {
  body: { title: '另一个条目', body: 'other' },
  jar: owner.jar,
  csrf: owner.csrf,
  idempotencyKey: 'rev-create-2',
});
const otherId =
  (otherEntry.json['data'] as { entry?: { id?: string } } | undefined)?.entry?.id ?? '';
const foreignRevision = await call(
  'POST',
  `${path}/${otherId}/revisions/${target?.id ?? ''}/restore`,
  {
    jar: owner.jar,
    csrf: owner.csrf,
    ifMatch: '1',
  },
);
check(
  '用别的条目的修订 id 回滚 → 404 REVISION_NOT_FOUND',
  foreignRevision.status === 404 && errorCode(foreignRevision) === 'REVISION_NOT_FOUND',
);

const missing = await call(
  'POST',
  `${path}/${entryId}/revisions/11111111-1111-1111-1111-111111111111/restore`,
  {
    jar: owner.jar,
    csrf: owner.csrf,
    ifMatch: String(version),
  },
);
check('不存在的修订 id → 404', missing.status === 404);

const otherSpace = await prisma.workspace.create({
  data: { name: '另一空间', timezone: 'Asia/Shanghai', createdBy: ownerId },
});
await prisma.workspaceMember.create({
  data: { workspaceId: otherSpace.id, userId: ownerId, role: 'owner' },
});
const crossSpace = await call(
  'POST',
  `/workspaces/${otherSpace.id}/entries/${entryId}/revisions/${target?.id ?? ''}/restore`,
  {
    jar: owner.jar,
    csrf: owner.csrf,
    ifMatch: String(version),
  },
);
check('跨空间回滚 → 404', crossSpace.status === 404);

// ---------------------------------------------------------------- 事务性：目标条目不存在时不留痕
const beforeCount = await prisma.entryRevision.count({ where: { workspaceId: spaceId, entryId } });
const failedRestore = await call(
  'POST',
  `${path}/${entryId}/revisions/11111111-1111-1111-1111-111111111111/restore`,
  {
    jar: owner.jar,
    csrf: owner.csrf,
    ifMatch: String(version),
  },
);
const afterCount = await prisma.entryRevision.count({ where: { workspaceId: spaceId, entryId } });
check(
  '回滚失败不产生“半次恢复”（修订数与正文都不变）',
  failedRestore.status === 404 &&
    beforeCount === afterCount &&
    (await prisma.entry.findUnique({ where: { id: entryId } }))?.version === version,
);

// ---------------------------------------------------------------- 清理
await app.close();
await prisma.$executeRawUnsafe(
  'TRUNCATE TABLE users, workspaces, workspace_members, workspace_invites, sessions, account_recovery_tokens, audit_events, projects, tasks, entries, entry_tags, entry_usage, entry_revisions, tags, ledger_records, idempotency_records RESTART IDENTITY CASCADE',
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
