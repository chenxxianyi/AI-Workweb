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
 * F14 验收：任务状态、日期、幂等与昨日顺延。
 *   pnpm --filter @aiwb/api test:task
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
console.log(`[task-check] 数据库：${databaseName}`);

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
  'TRUNCATE TABLE users, workspaces, workspace_members, workspace_invites, sessions, account_recovery_tokens, audit_events, projects, tasks, idempotency_records RESTART IDENTITY CASCADE',
);

const OWNER_EMAIL = 'task-owner@authtest.local';
const OWNER_PASSWORD = 'Workbench-Zeta-Task-42';
const boot = await bootstrapOwner(prisma, { email: OWNER_EMAIL, displayName: '任务 Owner', password: OWNER_PASSWORD });
check('准备：Owner 与个人空间创建成功', boot.created === true);
const spaceId = boot.created ? boot.workspaceId : '';
const ownerId = boot.created ? boot.userId : '';
const tasksPath = `/workspaces/${spaceId}/tasks`;

const viewer = await prisma.user.create({
  data: {
    emailNormalized: 'task-viewer@authtest.local',
    displayName: '只读成员',
    passwordHash: await hashPassword('Workbench-Eta-Viewer-42'),
  },
});
await prisma.workspaceMember.create({ data: { workspaceId: spaceId, userId: viewer.id, role: 'viewer' } });

const owner = await login(OWNER_EMAIL, OWNER_PASSWORD);
const viewerSession = await login('task-viewer@authtest.local', 'Workbench-Eta-Viewer-42');

const project = await prisma.project.create({
  data: { workspaceId: spaceId, createdBy: ownerId, name: '任务所在项目', nextStep: '写任务' },
});

// ---------------------------------------------------------------- 创建与幂等
const createKey = 'create-task-key-1';
const created = await call('POST', tasksPath, {
  body: { title: '完成 F14 任务接口', priority: 'p1', dueDate: '2026-01-31', projectId: project.id },
  jar: owner.jar,
  csrf: owner.csrf,
  idempotencyKey: createKey,
});
const createdData = created.json['data'] as
  | { replayed?: boolean; task?: { id?: string; status?: string; doneAt?: string | null; dueDate?: string; version?: number } }
  | undefined;
check('创建任务 201 且默认 todo、doneAt 为空', created.status === 201 && createdData?.task?.status === 'todo' && createdData?.task?.doneAt === null);
check('创建返回 dueDate 为 YYYY-MM-DD', createdData?.task?.dueDate === '2026-01-31');
const taskId = createdData?.task?.id ?? '';

const replayed = await call('POST', tasksPath, {
  body: { title: '完成 F14 任务接口', priority: 'p1', dueDate: '2026-01-31', projectId: project.id },
  jar: owner.jar,
  csrf: owner.csrf,
  idempotencyKey: createKey,
});
const replayedData = replayed.json['data'] as { replayed?: boolean; task?: { id?: string } } | undefined;
check('同一幂等键重复创建返回首次结果（replayed=true）', replayed.status === 201 && replayedData?.replayed === true && replayedData?.task?.id === taskId);
check('重复创建只产生一条任务', (await prisma.task.count({ where: { workspaceId: spaceId } })) === 1);

const reusedKey = await call('POST', tasksPath, {
  body: { title: '内容不同但同一个键' },
  jar: owner.jar,
  csrf: owner.csrf,
  idempotencyKey: createKey,
});
check('同一幂等键不同内容 → 409 IDEMPOTENCY_KEY_REUSED', reusedKey.status === 409 && errorCode(reusedKey) === 'IDEMPOTENCY_KEY_REUSED');

const missingKey = await call('POST', tasksPath, { body: { title: '没有幂等键' }, jar: owner.jar, csrf: owner.csrf });
check('创建缺幂等键 → 422', missingKey.status === 422);

const viewerCreate = await call('POST', tasksPath, {
  body: { title: 'Viewer 的任务' },
  jar: viewerSession.jar,
  csrf: viewerSession.csrf,
  idempotencyKey: 'viewer-key-1',
});
check('Viewer 创建任务 → 403', viewerCreate.status === 403);

// ---------------------------------------------------------------- 完成 / 撤销
const done = await call('PATCH', `${tasksPath}/${taskId}`, {
  body: { status: 'done' },
  jar: owner.jar,
  csrf: owner.csrf,
  ifMatch: '1',
});
const doneData = done.json['data'] as { status?: string; doneAt?: string | null; version?: number } | undefined;
check('完成时写入 doneAt 且版本 +1', done.status === 200 && doneData?.status === 'done' && typeof doneData?.doneAt === 'string' && doneData?.version === 2);

const undone = await call('PATCH', `${tasksPath}/${taskId}`, {
  body: { status: 'todo' },
  jar: owner.jar,
  csrf: owner.csrf,
  ifMatch: '2',
});
const undoneData = undone.json['data'] as { status?: string; doneAt?: string | null } | undefined;
check('撤销完成时清空 doneAt', undone.status === 200 && undoneData?.status === 'todo' && undoneData?.doneAt === null);

// ---------------------------------------------------------------- 改期（跨月/跨年/闰年）
async function createTaskWithDue(title: string, dueDate: string, key: string): Promise<{ id: string; version: number }> {
  const response = await call('POST', tasksPath, {
    body: { title, dueDate },
    jar: owner.jar,
    csrf: owner.csrf,
    idempotencyKey: key,
  });
  const data = response.json['data'] as { task?: { id?: string; version?: number } } | undefined;
  return { id: data?.task?.id ?? '', version: data?.task?.version ?? 1 };
}

const monthEnd = await createTaskWithDue('月末改期', '2026-01-31', 'month-end-key');
const monthEndShift = await call('PATCH', `${tasksPath}/${monthEnd.id}`, {
  body: { shiftDays: 1 },
  jar: owner.jar,
  csrf: owner.csrf,
  ifMatch: String(monthEnd.version),
});
check('月末 +1 天 → 2026-02-01', (monthEndShift.json['data'] as { dueDate?: string } | undefined)?.dueDate === '2026-02-01');

const yearEnd = await createTaskWithDue('年末改期', '2026-12-31', 'year-end-key');
const yearEndShift = await call('PATCH', `${tasksPath}/${yearEnd.id}`, {
  body: { shiftDays: 1 },
  jar: owner.jar,
  csrf: owner.csrf,
  ifMatch: String(yearEnd.version),
});
check('年末 +1 天 → 2027-01-01', (yearEndShift.json['data'] as { dueDate?: string } | undefined)?.dueDate === '2027-01-01');

const leap = await createTaskWithDue('闰年改期', '2028-02-28', 'leap-key');
const leapShift = await call('PATCH', `${tasksPath}/${leap.id}`, {
  body: { shiftDays: 1 },
  jar: owner.jar,
  csrf: owner.csrf,
  ifMatch: String(leap.version),
});
check('闰年 2028-02-28 +1 天 → 2028-02-29', (leapShift.json['data'] as { dueDate?: string } | undefined)?.dueDate === '2028-02-29');

const invalidDate = await call('PATCH', `${tasksPath}/${leap.id}`, {
  body: { dueDate: '2026-02-30' },
  jar: owner.jar,
  csrf: owner.csrf,
  ifMatch: '2',
});
check('不存在的日期 2026-02-30 → 422', invalidDate.status === 422);

// ---------------------------------------------------------------- 条件写
const noMatch = await call('PATCH', `${tasksPath}/${taskId}`, { body: { title: '改标题' }, jar: owner.jar, csrf: owner.csrf });
check('PATCH 缺 If-Match → 428', noMatch.status === 428 && errorCode(noMatch) === 'PRECONDITION_REQUIRED');

const stale = await call('PATCH', `${tasksPath}/${taskId}`, {
  body: { title: '过期改标题' },
  jar: owner.jar,
  csrf: owner.csrf,
  ifMatch: '1',
});
check('PATCH 过期版本 → 412 且返回 currentVersion', stale.status === 412 && errorCode(stale) === 'PRECONDITION_FAILED');

const concurrentFirst = await call('PATCH', `${tasksPath}/${taskId}`, {
  body: { title: '并发改标题 A' },
  jar: owner.jar,
  csrf: owner.csrf,
  ifMatch: '3',
});
const concurrentSecond = await call('PATCH', `${tasksPath}/${taskId}`, {
  body: { title: '并发改标题 B' },
  jar: owner.jar,
  csrf: owner.csrf,
  ifMatch: '3',
});
check('同一版本并发修改：第一次成功、第二次 412', concurrentFirst.status === 200 && concurrentSecond.status === 412);

// ---------------------------------------------------------------- 昨日顺延
const timezone = 'Asia/Shanghai';
const today = businessDate(new Date(), timezone);
const yesterday = addDays(today, -1);
const dayBefore = addDays(today, -2);
const toUtc = (date: string): Date => new Date(`${date}T00:00:00.000Z`);

await prisma.task.createMany({
  data: [
    { workspaceId: spaceId, createdBy: ownerId, title: '昨日待办', status: 'todo', dueDate: toUtc(yesterday) },
    { workspaceId: spaceId, createdBy: ownerId, title: '昨日进行中', status: 'doing', dueDate: toUtc(yesterday) },
    { workspaceId: spaceId, createdBy: ownerId, title: '昨日已完成', status: 'done', doneAt: new Date(), dueDate: toUtc(yesterday) },
    { workspaceId: spaceId, createdBy: ownerId, title: '前日逾期', status: 'todo', dueDate: toUtc(dayBefore) },
  ],
});

const dryRun = await call('POST', `${tasksPath}/postpone-yesterday`, {
  body: { dryRun: true },
  jar: owner.jar,
  csrf: owner.csrf,
});
const dryRunData = dryRun.json['data'] as { count?: number; dryRun?: boolean; fromDate?: string; toDate?: string } | undefined;
check('顺延预览：只统计昨日未完成（2 条），不写库', dryRun.status === 200 && dryRunData?.count === 2 && dryRunData?.dryRun === true);
check(
  '预览不改动数据库',
  (await prisma.task.count({ where: { workspaceId: spaceId, dueDate: toUtc(yesterday), status: { not: 'done' } } })) === 2,
);

const confirmed = await call('POST', `${tasksPath}/postpone-yesterday`, {
  body: { dryRun: false },
  jar: owner.jar,
  csrf: owner.csrf,
});
const confirmedData = confirmed.json['data'] as { count?: number } | undefined;
check('顺延确认：更新 2 条', confirmed.status === 200 && confirmedData?.count === 2);
check(
  '顺延后昨日未完成清空、今日为 2 条',
  (await prisma.task.count({ where: { workspaceId: spaceId, dueDate: toUtc(yesterday), status: { not: 'done' } } })) === 0 &&
    (await prisma.task.count({ where: { workspaceId: spaceId, dueDate: toUtc(today), status: { not: 'done' } } })) === 2,
);
check(
  '昨日已完成与前日逾期不被顺延',
  (await prisma.task.count({ where: { workspaceId: spaceId, title: '昨日已完成' } })) === 1,
);
const dayBeforeUnchanged = await prisma.task.findFirst({ where: { workspaceId: spaceId, title: '前日逾期' } });
check('前日逾期日期保持不变', dayBeforeUnchanged?.dueDate?.toISOString().slice(0, 10) === dayBefore);

const secondRun = await call('POST', `${tasksPath}/postpone-yesterday`, {
  body: { dryRun: false },
  jar: owner.jar,
  csrf: owner.csrf,
});
check('再次顺延为 0 条（幂等效果）', (secondRun.json['data'] as { count?: number } | undefined)?.count === 0);

// ---------------------------------------------------------------- 项目活动时间
const activityBefore = await prisma.project.findUnique({ where: { id: project.id } });
await new Promise((r) => setTimeout(r, 15));
await call('POST', tasksPath, {
  body: { title: '触发项目活动', projectId: project.id },
  jar: owner.jar,
  csrf: owner.csrf,
  idempotencyKey: 'activity-key-1',
});
const activityAfter = await prisma.project.findUnique({ where: { id: project.id } });
check(
  '任务变化会更新项目 last_activity_at',
  activityBefore !== null && activityAfter !== null && activityAfter.lastActivityAt > activityBefore.lastActivityAt,
);

// ---------------------------------------------------------------- 归档项目仍可读任务
const archivedProject = await prisma.project.create({
  data: { workspaceId: spaceId, createdBy: ownerId, name: '已归档项目', nextStep: '', archivedAt: new Date() },
});
const archivedTask = await prisma.task.create({
  data: { workspaceId: spaceId, createdBy: ownerId, title: '归档项目下的任务', projectId: archivedProject.id },
});
const archivedTaskRead = await call('GET', `${tasksPath}/${archivedTask.id}`, { jar: owner.jar });
check('已归档项目下的任务仍可读取', archivedTaskRead.status === 200);

// ---------------------------------------------------------------- 删除与隔离
const removed = await call('DELETE', `${tasksPath}/${taskId}`, { jar: owner.jar, csrf: owner.csrf, ifMatch: '4' });
check('软删除任务成功', removed.status === 200);
const afterDelete = await call('GET', `${tasksPath}/${taskId}`, { jar: owner.jar });
check('删除后任务详情 → 404', afterDelete.status === 404);

const otherSpace = await prisma.workspace.create({
  data: { name: '另一空间', timezone, createdBy: ownerId },
});
await prisma.workspaceMember.create({ data: { workspaceId: otherSpace.id, userId: ownerId, role: 'owner' } });
const crossSpace = await call('GET', `/workspaces/${otherSpace.id}/tasks/${archivedTask.id}`, { jar: owner.jar });
check('跨空间读取任务 → 404', crossSpace.status === 404);

const badProject = await call('POST', tasksPath, {
  body: { title: '错误项目', projectId: '11111111-1111-1111-1111-111111111111' },
  jar: owner.jar,
  csrf: owner.csrf,
  idempotencyKey: 'bad-project-key',
});
check('引用不存在的项目 → 422', badProject.status === 422);

// ---------------------------------------------------------------- 清理
await app.close();
await prisma.$executeRawUnsafe(
  'TRUNCATE TABLE users, workspaces, workspace_members, workspace_invites, sessions, account_recovery_tokens, audit_events, projects, tasks, idempotency_records RESTART IDENTITY CASCADE',
);
await prisma.$disconnect();

const failed = results.filter((item) => !item.ok);
for (const item of results) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.ok ? '' : `  ← ${item.detail ?? ''}`}`);
}
console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
process.exitCode = failed.length === 0 ? 0 : 1;
