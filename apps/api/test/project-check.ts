import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { config as loadEnvFile } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrismaAdapter } from '../src/common/prisma-adapter.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { bootstrapOwner } from '../src/modules/auth/auth-core.js';
import { hashPassword } from '../src/modules/auth/password.js';

/**
 * F12 验收：项目 CRUD、进度、活动、条件写与详情聚合。
 *   pnpm --filter @aiwb/api test:project
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
console.log(`[project-check] 数据库：${databaseName}`);

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
  options: { body?: unknown; jar?: Jar; csrf?: string; ifMatch?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (method === 'POST' && (path === '/workspaces' || /^\/workspaces\/[^/]+\/projects$/.test(path)))
    headers['idempotency-key'] = globalThis.crypto.randomUUID();
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
  'TRUNCATE TABLE users, workspaces, workspace_members, workspace_invites, sessions, account_recovery_tokens, audit_events, projects, tasks RESTART IDENTITY CASCADE',
);

const OWNER_EMAIL = 'proj-owner@authtest.local';
const OWNER_PASSWORD = 'Workbench-Alpha-Project-42';
const boot = await bootstrapOwner(prisma, {
  email: OWNER_EMAIL,
  displayName: '项目 Owner',
  password: OWNER_PASSWORD,
});
check('准备：Owner 与个人空间创建成功', boot.created === true);
const spaceA = boot.created ? boot.workspaceId : '';
const ownerId = boot.created ? boot.userId : '';

// 第二个空间（同一 Owner），用于跨空间 404
const spaceB = await prisma.workspace.create({
  data: { name: '第二个空间', timezone: 'Asia/Shanghai', createdBy: ownerId },
});
await prisma.workspaceMember.create({
  data: { workspaceId: spaceB.id, userId: ownerId, role: 'owner' },
});

// Viewer 用户（只读）
const viewer = await prisma.user.create({
  data: {
    emailNormalized: 'proj-viewer@authtest.local',
    displayName: '只读成员',
    passwordHash: await hashPassword('Workbench-Beta-Viewer-42'),
  },
});
await prisma.workspaceMember.create({
  data: { workspaceId: spaceA, userId: viewer.id, role: 'viewer' },
});

const owner = await login(OWNER_EMAIL, OWNER_PASSWORD);
const viewerSession = await login('proj-viewer@authtest.local', 'Workbench-Beta-Viewer-42');
const projectsPath = `/workspaces/${spaceA}/projects`;

// ---------------------------------------------------------------- 创建与默认值
const created = await call('POST', projectsPath, {
  body: {
    name: '自动进度项目',
    stage: 'developing',
    nextStep: '完成 F12',
    stack: ['React', 'NestJS'],
  },
  jar: owner.jar,
  csrf: owner.csrf,
});
const createdData = created.json['data'] as
  | { id?: string; progress?: number; progressMode?: string; version?: number; inactive?: boolean }
  | undefined;
check(
  '创建项目 201 且默认进度 0（无任务）',
  created.status === 201 && createdData?.progress === 0 && createdData?.progressMode === 'auto',
);
check(
  '新建项目版本为 1 且未标记无活动',
  createdData?.version === 1 && createdData?.inactive === false,
);
const autoProjectId = createdData?.id ?? '';

const manualZero = await call('POST', projectsPath, {
  body: { name: '手动 0% 项目', progressManual: true, manualProgress: 0 },
  jar: owner.jar,
  csrf: owner.csrf,
});
const manualZeroData = manualZero.json['data'] as
  { id?: string; progress?: number; progressMode?: string } | undefined;
check(
  '手动 0% 项目创建成功且进度为 0',
  manualZero.status === 201 &&
    manualZeroData?.progress === 0 &&
    manualZeroData?.progressMode === 'manual',
);

// ---------------------------------------------------------------- 校验（不落库）
const beforeCount = await prisma.project.count({ where: { workspaceId: spaceA } });
const badRepo = await call('POST', projectsPath, {
  body: { name: '坏仓库', repo: 'not a repo' },
  jar: owner.jar,
  csrf: owner.csrf,
});
check('非法 repo → 422', badRepo.status === 422 && errorCode(badRepo) === 'VALIDATION_FAILED');
const badColor = await call('POST', projectsPath, {
  body: { name: '坏颜色', color: 'red' },
  jar: owner.jar,
  csrf: owner.csrf,
});
check('非法 color → 422', badColor.status === 422);
const newlineNext = await call('POST', projectsPath, {
  body: { name: '多行下一步', nextStep: 'a\nb' },
  jar: owner.jar,
  csrf: owner.csrf,
});
check('下一步含换行 → 422', newlineNext.status === 422);
const manualMissing = await call('POST', projectsPath, {
  body: { name: '手动缺值', progressManual: true },
  jar: owner.jar,
  csrf: owner.csrf,
});
check('手动模式缺进度 → 422', manualMissing.status === 422);
const autoWithManual = await call('POST', projectsPath, {
  body: { name: '自动却给值', progressManual: false, manualProgress: 50 },
  jar: owner.jar,
  csrf: owner.csrf,
});
check('自动模式却带 manualProgress → 422', autoWithManual.status === 422);
const afterCount = await prisma.project.count({ where: { workspaceId: spaceA } });
check('校验失败的请求没有落库', beforeCount === afterCount);

// ---------------------------------------------------------------- 进度规则
await prisma.task.createMany({
  data: [
    {
      workspaceId: spaceA,
      projectId: autoProjectId,
      createdBy: ownerId,
      title: '任务1',
      status: 'done',
      doneAt: new Date(),
    },
    {
      workspaceId: spaceA,
      projectId: autoProjectId,
      createdBy: ownerId,
      title: '任务2',
      status: 'todo',
    },
    {
      workspaceId: spaceA,
      projectId: autoProjectId,
      createdBy: ownerId,
      title: '任务3',
      status: 'todo',
    },
  ],
});
const autoDetail = await call('GET', `${projectsPath}/${autoProjectId}`, { jar: owner.jar });
const autoView = autoDetail.json['data'] as
  { progress?: number; taskCounts?: { total?: number; done?: number } } | undefined;
check(
  '完成 1/3 → 33%',
  autoDetail.status === 200 && autoView?.progress === 33 && autoView?.taskCounts?.total === 3,
);

const manualDetail = await call('GET', `${projectsPath}/${manualZeroData?.id ?? ''}`, {
  jar: owner.jar,
});
check(
  '手动 0% 不被任务影响',
  (manualDetail.json['data'] as { progress?: number } | undefined)?.progress === 0,
);

// 手动 0% 项目加两个已完成任务，仍为 0
await prisma.task.createMany({
  data: [
    {
      workspaceId: spaceA,
      projectId: manualZeroData?.id ?? null,
      createdBy: ownerId,
      title: '已完成A',
      status: 'done',
      doneAt: new Date(),
    },
    {
      workspaceId: spaceA,
      projectId: manualZeroData?.id ?? null,
      createdBy: ownerId,
      title: '已完成B',
      status: 'done',
      doneAt: new Date(),
    },
  ],
});
const manualAgain = await call('GET', `${projectsPath}/${manualZeroData?.id ?? ''}`, {
  jar: owner.jar,
});
check(
  '手动 0% 在任务全完成后仍为 0',
  (manualAgain.json['data'] as { progress?: number } | undefined)?.progress === 0,
);

// ---------------------------------------------------------------- 条件写
const noMatch = await call('PATCH', `${projectsPath}/${autoProjectId}`, {
  body: { nextStep: '新一步' },
  jar: owner.jar,
  csrf: owner.csrf,
});
check(
  'PATCH 缺 If-Match → 428',
  noMatch.status === 428 && errorCode(noMatch) === 'PRECONDITION_REQUIRED',
);

const stale = await call('PATCH', `${projectsPath}/${autoProjectId}`, {
  body: { nextStep: '过期写' },
  jar: owner.jar,
  csrf: owner.csrf,
  ifMatch: '99',
});
const staleError = stale.json['error'] as { code?: string; currentVersion?: number } | undefined;
check(
  'PATCH 过期版本 → 412 且返回 currentVersion',
  stale.status === 412 &&
    staleError?.code === 'PRECONDITION_FAILED' &&
    staleError?.currentVersion === 1,
);

const firstWrite = await call('PATCH', `${projectsPath}/${autoProjectId}`, {
  body: { nextStep: '完成 F12 验收', stage: 'paused' },
  jar: owner.jar,
  csrf: owner.csrf,
  ifMatch: '1',
});
check(
  'PATCH 正确版本成功并升版',
  firstWrite.status === 200 &&
    (firstWrite.json['data'] as { version?: number } | undefined)?.version === 2,
);

const concurrent = await call('PATCH', `${projectsPath}/${autoProjectId}`, {
  body: { nextStep: '并发写' },
  jar: owner.jar,
  csrf: owner.csrf,
  ifMatch: '1',
});
check('并发修改（同一 If-Match）→ 412', concurrent.status === 412);

// 切换回自动模式会清空 manualProgress
const toAuto = await call('PATCH', `${projectsPath}/${manualZeroData?.id ?? ''}`, {
  body: { progressManual: false },
  jar: owner.jar,
  csrf: owner.csrf,
  ifMatch: '1',
});
const toAutoData = toAuto.json['data'] as
  { progressMode?: string; manualProgress?: number | null; progress?: number } | undefined;
check(
  '切回自动模式后按任务计算（2/2 → 100），manualProgress 清空',
  toAuto.status === 200 &&
    toAutoData?.progressMode === 'auto' &&
    toAutoData?.manualProgress === null &&
    toAutoData?.progress === 100,
);

// ---------------------------------------------------------------- 隔离与权限
const crossSpace = await call('GET', `/workspaces/${spaceB.id}/projects/${autoProjectId}`, {
  jar: owner.jar,
});
check('跨空间读取项目详情 → 404', crossSpace.status === 404);

const viewerCreate = await call('POST', projectsPath, {
  body: { name: 'Viewer 项目' },
  jar: viewerSession.jar,
  csrf: viewerSession.csrf,
});
check(
  'Viewer 创建项目 → 403',
  viewerCreate.status === 403 && errorCode(viewerCreate) === 'FORBIDDEN',
);

const viewerList = await call('GET', projectsPath, { jar: viewerSession.jar });
check('Viewer 可读项目列表', viewerList.status === 200);

// ---------------------------------------------------------------- 归档与删除
const archive = await call('POST', `${projectsPath}/${autoProjectId}/archive`, {
  jar: owner.jar,
  csrf: owner.csrf,
  ifMatch: '2',
});
check(
  '归档成功（版本 3）',
  archive.status === 200 &&
    (archive.json['data'] as { archived?: boolean; version?: number } | undefined)?.archived ===
      true,
);

const activeList = await call('GET', projectsPath, { jar: owner.jar });
const activeIds = (
  (activeList.json['data'] as { projects?: { id: string }[] } | undefined)?.projects ?? []
).map((p) => p.id);
check('默认列表不含已归档项目', !activeIds.includes(autoProjectId));

const archivedList = await call('GET', `${projectsPath}?filter=archived`, { jar: owner.jar });
const archivedIds = (
  (archivedList.json['data'] as { projects?: { id: string }[] } | undefined)?.projects ?? []
).map((p) => p.id);
check('归档筛选包含该项目', archivedIds.includes(autoProjectId));

const removeNoMatch = await call('DELETE', `${projectsPath}/${autoProjectId}`, {
  jar: owner.jar,
  csrf: owner.csrf,
});
check('删除缺 If-Match → 428', removeNoMatch.status === 428);

const removed = await call('DELETE', `${projectsPath}/${autoProjectId}`, {
  jar: owner.jar,
  csrf: owner.csrf,
  ifMatch: '3',
});
check('软删除成功', removed.status === 200);
const afterDelete = await call('GET', `${projectsPath}/${autoProjectId}`, { jar: owner.jar });
check('删除后详情 → 404', afterDelete.status === 404);

// ---------------------------------------------------------------- 活动时间与筛选
const staleProject = await call('POST', projectsPath, {
  body: { name: '久未活动项目' },
  jar: owner.jar,
  csrf: owner.csrf,
});
const staleId = (staleProject.json['data'] as { id?: string } | undefined)?.id ?? '';
await prisma.project.update({
  where: { id: staleId },
  data: { lastActivityAt: new Date(Date.now() - 10 * 86_400_000) },
});
const staleDetail = await call('GET', `${projectsPath}/${staleId}`, { jar: owner.jar });
const staleView = staleDetail.json['data'] as
  { inactive?: boolean; inactiveDays?: number } | undefined;
check(
  '10 天未活动 → inactive=true 且天数正确',
  staleView?.inactive === true && staleView?.inactiveDays === 10,
);

const inactiveList = await call('GET', `${projectsPath}?filter=inactive`, { jar: owner.jar });
const inactiveIds = (
  (inactiveList.json['data'] as { projects?: { id: string }[] } | undefined)?.projects ?? []
).map((p) => p.id);
check('inactive 筛选包含久未活动项目', inactiveIds.includes(staleId));

// ---------------------------------------------------------------- 详情聚合
await prisma.ledgerRecord.create({
  data: {
    workspaceId: spaceA,
    createdBy: ownerId,
    recordDate: new Date('2026-11-03T00:00:00.000Z'),
    projectId: staleId,
    tool: 'claude',
    scene: 'coding',
    minutes: 30,
    savedMinutes: 40,
    effect: 4,
  },
});
const overview = await call('GET', `${projectsPath}/${staleId}/overview`, { jar: owner.jar });
const overviewData = overview.json['data'] as
  | {
      project?: { id?: string };
      tasks?: { counts?: { total?: number } };
      entries?: { recent?: unknown[] };
      ledger?: { count?: number; totalSavedMinutes?: number; averageEffect?: number };
    }
  | undefined;
check(
  '详情聚合包含项目、任务计数、知识、台账摘要',
  overview.status === 200 &&
    overviewData?.project?.id === staleId &&
    overviewData?.tasks?.counts?.total === 0 &&
    Array.isArray(overviewData?.entries?.recent) &&
    overviewData?.ledger?.count === 1 &&
    overviewData?.ledger?.totalSavedMinutes === 40 &&
    overviewData?.ledger?.averageEffect === 4,
);

// ---------------------------------------------------------------- 分页
for (let index = 0; index < 3; index += 1) {
  await call('POST', projectsPath, {
    body: { name: `分页项目 ${index}` },
    jar: owner.jar,
    csrf: owner.csrf,
  });
}
const page1 = await call('GET', `${projectsPath}?limit=2`, { jar: owner.jar });
const page1Data = page1.json['data'] as
  { projects?: unknown[]; hasMore?: boolean; nextCursor?: string | null } | undefined;
check(
  'limit=2 返回 2 条且 hasMore=true',
  page1Data?.projects?.length === 2 &&
    page1Data?.hasMore === true &&
    typeof page1Data?.nextCursor === 'string',
);

const page2 = await call('GET', `${projectsPath}?limit=2&cursor=${page1Data?.nextCursor ?? ''}`, {
  jar: owner.jar,
});
const page2Data = page2.json['data'] as { projects?: { id: string }[] } | undefined;
const page1Ids = ((page1Data?.projects ?? []) as { id: string }[]).map((p) => p.id);
check(
  '第二页不重复第一页',
  page2.status === 200 && (page2Data?.projects ?? []).every((p) => !page1Ids.includes(p.id)),
);

// ---------------------------------------------------------------- 清理
await app.close();
await prisma.$executeRawUnsafe(
  'TRUNCATE TABLE users, workspaces, workspace_members, workspace_invites, sessions, account_recovery_tokens, audit_events, projects, tasks, ledger_records RESTART IDENTITY CASCADE',
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
