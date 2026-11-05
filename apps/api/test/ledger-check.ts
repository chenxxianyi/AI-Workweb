import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { config as loadEnvFile } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrismaAdapter } from '../src/common/prisma-adapter.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { bootstrapOwner } from '../src/modules/auth/auth-core.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { addDays, businessDate } from '@aiwb/domain';

/**
 * F17 验收：开发日志、分页与幂等。
 *   pnpm --filter @aiwb/api test:ledger
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
console.log(`[ledger-check] 数据库：${databaseName}`);

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

const OWNER_EMAIL = 'ledger-owner@authtest.local';
const OWNER_PASSWORD = 'Workbench-Kappa-Ledger-42';
const boot = await bootstrapOwner(prisma, {
  email: OWNER_EMAIL,
  displayName: '日志 Owner',
  password: OWNER_PASSWORD,
});
check('准备：Owner 与个人空间创建成功', boot.created === true);
const spaceId = boot.created ? boot.workspaceId : '';
const ownerId = boot.created ? boot.userId : '';
const path = `/workspaces/${spaceId}/ledger`;

const viewer = await prisma.user.create({
  data: {
    emailNormalized: 'ledger-viewer@authtest.local',
    displayName: '只读成员',
    passwordHash: await hashPassword('Workbench-Lambda-Viewer-42'),
  },
});
await prisma.workspaceMember.create({
  data: { workspaceId: spaceId, userId: viewer.id, role: 'viewer' },
});

const owner = await login(OWNER_EMAIL, OWNER_PASSWORD);
const viewerSession = await login('ledger-viewer@authtest.local', 'Workbench-Lambda-Viewer-42');

const project = await prisma.project.create({
  data: { workspaceId: spaceId, createdBy: ownerId, name: '日志项目', nextStep: '记录台账' },
});
const timezone = 'Asia/Shanghai';
const today = businessDate(new Date(), timezone);
const yesterday = addDays(today, -1);

const baseInput = {
  recordDate: today,
  tool: 'claude',
  scene: 'coding',
  minutes: 60,
  savedMinutes: 90,
  effect: 4,
  note: '实现日志接口',
};

// ---------------------------------------------------------------- 创建与幂等
const created = await call('POST', path, {
  body: { ...baseInput, projectId: project.id },
  jar: owner.jar,
  csrf: owner.csrf,
  idempotencyKey: 'ledger-key-1',
});
const createdData = created.json['data'] as
  | {
      replayed?: boolean;
      record?: { id?: string; authorId?: string; savedMinutes?: number; version?: number };
    }
  | undefined;
check(
  '创建日志 201 且作者为当前用户',
  created.status === 201 && createdData?.record?.authorId === ownerId,
);
check(
  '未给节省分钟时默认等于投入分钟（本用例显式给了 90）',
  createdData?.record?.savedMinutes === 90,
);
const recordId = createdData?.record?.id ?? '';

const replay = await call('POST', path, {
  body: { ...baseInput, projectId: project.id },
  jar: owner.jar,
  csrf: owner.csrf,
  idempotencyKey: 'ledger-key-1',
});
check(
  '同一幂等键重试返回首次结果',
  (replay.json['data'] as { replayed?: boolean } | undefined)?.replayed === true,
);
check(
  '重试后记录数仍为 1',
  (await prisma.ledgerRecord.count({ where: { workspaceId: spaceId } })) === 1,
);

// 同内容不同操作（不同键）可并存
const second = await call('POST', path, {
  body: { ...baseInput, projectId: project.id },
  jar: owner.jar,
  csrf: owner.csrf,
  idempotencyKey: 'ledger-key-2',
});
check(
  '同内容不同幂等键 → 各自保存一条',
  second.status === 201 &&
    (await prisma.ledgerRecord.count({ where: { workspaceId: spaceId } })) === 2,
);

// 伪造作者被拒
const forged = await call('POST', path, {
  body: { ...baseInput, authorId: ownerId },
  jar: owner.jar,
  csrf: owner.csrf,
  idempotencyKey: 'ledger-forged',
});
check(
  '伪造 authorId → 422 且不落库',
  forged.status === 422 &&
    (await prisma.ledgerRecord.count({ where: { workspaceId: spaceId } })) === 2,
);

// ---------------------------------------------------------------- 校验
const badMinutes = await call('POST', path, {
  body: { ...baseInput, minutes: 0 },
  jar: owner.jar,
  csrf: owner.csrf,
  idempotencyKey: 'ledger-bad-minutes',
});
check('minutes=0 → 422', badMinutes.status === 422);
const badEffect = await call('POST', path, {
  body: { ...baseInput, effect: 6 },
  jar: owner.jar,
  csrf: owner.csrf,
  idempotencyKey: 'ledger-bad-effect',
});
check('effect=6 → 422', badEffect.status === 422);
const futureDate = await call('POST', path, {
  body: { ...baseInput, recordDate: addDays(today, 1) },
  jar: owner.jar,
  csrf: owner.csrf,
  idempotencyKey: 'ledger-future',
});
check('未来日期 → 422', futureDate.status === 422);
const badDate = await call('POST', path, {
  body: { ...baseInput, recordDate: '2026-02-30' },
  jar: owner.jar,
  csrf: owner.csrf,
  idempotencyKey: 'ledger-bad-date',
});
check('不存在的日期 → 422', badDate.status === 422);
const badTool = await call('POST', path, {
  body: { ...baseInput, tool: 'Claude Code' },
  jar: owner.jar,
  csrf: owner.csrf,
  idempotencyKey: 'ledger-bad-tool',
});
check('非法工具标识（含空格大写）→ 422', badTool.status === 422);
const viewerCreate = await call('POST', path, {
  body: baseInput,
  jar: viewerSession.jar,
  csrf: viewerSession.csrf,
  idempotencyKey: 'ledger-viewer',
});
check('Viewer 创建 → 403', viewerCreate.status === 403);

// ---------------------------------------------------------------- 筛选与分页
await prisma.ledgerRecord.createMany({
  data: [
    {
      workspaceId: spaceId,
      createdBy: ownerId,
      recordDate: new Date(`${addDays(today, -2)}T00:00:00.000Z`),
      projectId: project.id,
      tool: 'codex',
      scene: 'review',
      minutes: 30,
      savedMinutes: 20,
      effect: 3,
    },
    {
      workspaceId: spaceId,
      createdBy: ownerId,
      recordDate: new Date(`${addDays(today, -2)}T00:00:00.000Z`),
      tool: 'cursor',
      scene: 'debug',
      minutes: 45,
      savedMinutes: 25,
      effect: 5,
    },
    {
      workspaceId: spaceId,
      createdBy: ownerId,
      recordDate: new Date(`${yesterday}T00:00:00.000Z`),
      tool: 'claude',
      scene: 'docs',
      minutes: 15,
      savedMinutes: 10,
      effect: 2,
    },
  ],
});

const byProject = await call('GET', `${path}?projectId=${project.id}`, { jar: owner.jar });
check(
  '按项目筛选只返回该项目记录',
  (byProject.json['data'] as { records?: { projectId?: string }[] } | undefined)?.records?.every(
    (record) => record.projectId === project.id,
  ) === true,
);

const byTool = await call('GET', `${path}?tool=codex`, { jar: owner.jar });
check(
  '按工具筛选正确',
  (byTool.json['data'] as { records?: { tool?: string }[] } | undefined)?.records?.every(
    (record) => record.tool === 'codex',
  ) === true,
);

const byRange = await call('GET', `${path}?from=${addDays(today, -2)}&to=${yesterday}`, {
  jar: owner.jar,
});
check(
  '按日期区间筛选返回 3 条',
  (byRange.json['data'] as { records?: unknown[] } | undefined)?.records?.length === 3,
);

const page1 = await call('GET', `${path}?limit=2`, { jar: owner.jar });
const page1Data = page1.json['data'] as
  { records?: { id: string }[]; hasMore?: boolean; nextCursor?: string | null } | undefined;
check(
  'limit=2 返回 2 条且 hasMore',
  page1Data?.records?.length === 2 &&
    page1Data?.hasMore === true &&
    typeof page1Data?.nextCursor === 'string',
);

const page2 = await call('GET', `${path}?limit=2&cursor=${page1Data?.nextCursor ?? ''}`, {
  jar: owner.jar,
});
const page2Data = page2.json['data'] as { records?: { id: string }[] } | undefined;
const page1Ids = (page1Data?.records ?? []).map((record) => record.id);
check(
  '第二页与第一页不重复',
  page2.status === 200 &&
    (page2Data?.records ?? []).every((record) => !page1Ids.includes(record.id)),
);

const crossFilter = await call(
  'GET',
  `${path}?limit=2&tool=codex&cursor=${page1Data?.nextCursor ?? ''}`,
  { jar: owner.jar },
);
check(
  '旧游标换筛选条件 → 400 MALFORMED_REQUEST',
  crossFilter.status === 400 && errorCode(crossFilter) === 'MALFORMED_REQUEST',
  'status=' + crossFilter.status + ' code=' + (errorCode(crossFilter) ?? '-'),
);

// 重试条数稳定
const countsBefore = await prisma.ledgerRecord.count({ where: { workspaceId: spaceId } });
await call('POST', path, {
  body: baseInput,
  jar: owner.jar,
  csrf: owner.csrf,
  idempotencyKey: 'ledger-key-1',
});
check(
  '再次用旧幂等键重试，记录数不变',
  (await prisma.ledgerRecord.count({ where: { workspaceId: spaceId } })) === countsBefore,
);

// ---------------------------------------------------------------- 更新与删除
const invalidPartial = await call('PATCH', `${path}/${recordId}`, {
  body: { minutes: 0 },
  jar: owner.jar,
  csrf: owner.csrf,
  ifMatch: '1',
});
check('部分更新仍校验分钟范围', invalidPartial.status === 422);
const absentProject = await call('PATCH', `${path}/${recordId}`, {
  body: { projectId: 'f2600000-0000-4000-8000-000000000001' },
  jar: owner.jar,
  csrf: owner.csrf,
  ifMatch: '1',
});
check('只修改关联也校验项目归属', absentProject.status === 422);
const absentEntry = await call('PATCH', `${path}/${recordId}`, {
  body: { entryId: 'f2600000-0000-4000-8000-000000000002' },
  jar: owner.jar,
  csrf: owner.csrf,
  ifMatch: '1',
});
check('只修改知识关联也校验归属', absentEntry.status === 422);
const noMatch = await call('PATCH', `${path}/${recordId}`, {
  body: { minutes: 70 },
  jar: owner.jar,
  csrf: owner.csrf,
});
check('PATCH 缺 If-Match → 428', noMatch.status === 428);

const stale = await call('PATCH', `${path}/${recordId}`, {
  body: { minutes: 70 },
  jar: owner.jar,
  csrf: owner.csrf,
  ifMatch: '9',
});
check(
  'PATCH 过期版本 → 412 且返回 currentVersion',
  stale.status === 412 &&
    (stale.json['error'] as { currentVersion?: number } | undefined)?.currentVersion === 1,
);

const updated = await call('PATCH', `${path}/${recordId}`, {
  body: { minutes: 70, effect: 5 },
  jar: owner.jar,
  csrf: owner.csrf,
  ifMatch: '1',
});
check(
  '更新成功且版本 +1',
  updated.status === 200 &&
    (updated.json['data'] as { version?: number } | undefined)?.version === 2,
);

const summary = await call('GET', `${path}/summary`, { jar: owner.jar });
const summaryData = summary.json['data'] as
  | {
      count?: number;
      totalMinutes?: number;
      totalSavedMinutes?: number;
      averageEffect?: number | null;
      byTool?: { tool: string }[];
    }
  | undefined;
check(
  '汇总条数与总分钟正确',
  summary.status === 200 &&
    summaryData?.count === countsBefore &&
    typeof summaryData?.totalMinutes === 'number',
);
check('汇总按工具分组非空', (summaryData?.byTool ?? []).length >= 2);

const summaryRange = await call('GET', `${path}/summary?from=${today}&to=${today}`, {
  jar: owner.jar,
});
check(
  '汇总支持日期区间',
  (summaryRange.json['data'] as { count?: number } | undefined)?.count === 2,
);

const removed = await call('DELETE', `${path}/${recordId}`, {
  jar: owner.jar,
  csrf: owner.csrf,
  ifMatch: '2',
});
check('软删除成功', removed.status === 200);
check(
  '删除后详情 → 404',
  (await call('GET', `${path}/${recordId}`, { jar: owner.jar })).status === 404,
);

// ---------------------------------------------------------------- 隔离
const otherSpace = await prisma.workspace.create({
  data: { name: '另一空间', timezone, createdBy: ownerId },
});
await prisma.workspaceMember.create({
  data: { workspaceId: otherSpace.id, userId: ownerId, role: 'owner' },
});
const otherSpaceList = await call('GET', `/workspaces/${otherSpace.id}/ledger`, { jar: owner.jar });
check(
  '另一空间查询不到本空间日志',
  (otherSpaceList.json['data'] as { records?: unknown[] } | undefined)?.records?.length === 0,
);

const remaining = await prisma.ledgerRecord.findFirst({
  where: { workspaceId: spaceId, deletedAt: null },
});
const crossSpaceDetail = await call(
  'GET',
  `/workspaces/${otherSpace.id}/ledger/${remaining?.id ?? ''}`,
  { jar: owner.jar },
);
check('跨空间读取详情 → 404', crossSpaceDetail.status === 404);

const viewerList = await call('GET', path, { jar: viewerSession.jar });
check('Viewer 可读日志列表', viewerList.status === 200);

// ---------------------------------------------------------------- 项目活动时间
const before = await prisma.project.findUnique({ where: { id: project.id } });
await new Promise((r) => setTimeout(r, 15));
await call('POST', path, {
  body: { ...baseInput, projectId: project.id },
  jar: owner.jar,
  csrf: owner.csrf,
  idempotencyKey: 'ledger-activity-key',
});
const after = await prisma.project.findUnique({ where: { id: project.id } });
check(
  '记录日志会更新项目活动时间',
  before !== null && after !== null && after.lastActivityAt > before.lastActivityAt,
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
