import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { config as loadEnvFile } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrismaAdapter } from '../src/common/prisma-adapter.js';
import { addDays, businessDate, diffDays } from '@aiwb/domain';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { bootstrapOwner } from '../src/modules/auth/auth-core.js';
import { hashPassword } from '../src/modules/auth/password.js';

/**
 * F15 验收：今日紧急聚合与业务日期。
 *   pnpm --filter @aiwb/api test:dashboard
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
console.log(`[dashboard-check] 数据库：${databaseName}`);

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
  options: { body?: unknown; jar?: Jar; csrf?: string; headers?: Record<string, string> } = {},
): Promise<Res> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(options.headers ?? {}),
  };
  const cookie = options.jar === undefined ? undefined : cookieHeader(options.jar);
  if (cookie !== undefined) headers['cookie'] = cookie;
  if (options.csrf !== undefined) headers['x-csrf-token'] = options.csrf;

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
  'TRUNCATE TABLE users, workspaces, workspace_members, workspace_invites, sessions, account_recovery_tokens, audit_events, projects, tasks, entries, entry_tags, entry_usage, entry_revisions, tags, idempotency_records RESTART IDENTITY CASCADE',
);

const OWNER_EMAIL = 'dash-owner@authtest.local';
const OWNER_PASSWORD = 'Workbench-Theta-Dash-42';
const boot = await bootstrapOwner(prisma, {
  email: OWNER_EMAIL,
  displayName: '聚合 Owner',
  password: OWNER_PASSWORD,
});
check('准备：Owner 与个人空间创建成功', boot.created === true);
const spaceId = boot.created ? boot.workspaceId : '';
const ownerId = boot.created ? boot.userId : '';
const path = `/workspaces/${spaceId}/dashboard/today`;

const viewer = await prisma.user.create({
  data: {
    emailNormalized: 'dash-viewer@authtest.local',
    displayName: '只读成员',
    passwordHash: await hashPassword('Workbench-Iota-Viewer-42'),
  },
});
await prisma.workspaceMember.create({
  data: { workspaceId: spaceId, userId: viewer.id, role: 'viewer' },
});

const owner = await login(OWNER_EMAIL, OWNER_PASSWORD);
const viewerSession = await login('dash-viewer@authtest.local', 'Workbench-Iota-Viewer-42');

const timezone = 'Asia/Shanghai';
const now = new Date();
const today = businessDate(now, timezone);
const yesterday = addDays(today, -1);
const toUtc = (date: string): Date => new Date(`${date}T00:00:00.000Z`);

const project = await prisma.project.create({
  data: { workspaceId: spaceId, createdBy: ownerId, name: '聚合项目', nextStep: '' },
});

const taskBase = { workspaceId: spaceId, createdBy: ownerId, projectId: project.id };

const overdue1 = await prisma.task.create({
  data: { ...taskBase, title: '逾期1天', dueDate: toUtc(yesterday) },
});
const overdue5 = await prisma.task.create({
  data: { ...taskBase, title: '逾期5天', dueDate: toUtc(addDays(today, -5)) },
});
const dueToday = await prisma.task.create({
  data: { ...taskBase, title: '今日到期', dueDate: toUtc(today) },
});
const doneYesterday = await prisma.task.create({
  data: {
    ...taskBase,
    title: '昨日已完成',
    status: 'done',
    doneAt: new Date(now.getTime() - 86_400_000),
    dueDate: toUtc(yesterday),
  },
});
await prisma.task.create({
  data: { ...taskBase, title: '今日已完成', status: 'done', doneAt: now, dueDate: toUtc(today) },
});
const stalled4d = await prisma.task.create({
  data: { ...taskBase, title: '停滞4天', status: 'doing' },
});
const stalledAlmost = await prisma.task.create({
  data: { ...taskBase, title: '停滞未满3天', status: 'doing' },
});
const deletedOverdue = await prisma.task.create({
  data: { ...taskBase, title: '已删除逾期', dueDate: toUtc(yesterday), deletedAt: new Date() },
});

// 直接改 updated_at（Prisma 的 @updatedAt 会覆盖写入值，只能走 SQL）
await prisma.$executeRawUnsafe(
  `UPDATE tasks SET updated_at = now() - interval '4 days' WHERE id = $1::uuid`,
  stalled4d.id,
);
await prisma.$executeRawUnsafe(
  `UPDATE tasks SET updated_at = now() - interval '3 days' + interval '2 hours' WHERE id = $1::uuid`,
  stalledAlmost.id,
);

const draft8d = await prisma.entry.create({
  data: {
    workspaceId: spaceId,
    createdBy: ownerId,
    title: '草稿超期8天',
    body: '正文',
    status: 'draft',
    createdAt: new Date(now.getTime() - 8 * 86_400_000),
    projectId: project.id,
  },
});
await prisma.entry.create({
  data: {
    workspaceId: spaceId,
    createdBy: ownerId,
    title: '草稿7天未满',
    body: '正文',
    status: 'draft',
    createdAt: new Date(now.getTime() - 7 * 86_400_000 + 3_600_000),
  },
});
await prisma.entry.create({
  data: {
    workspaceId: spaceId,
    createdBy: ownerId,
    title: '已验证30天',
    body: '正文',
    summary: '摘要',
    status: 'verified',
    createdAt: new Date(now.getTime() - 30 * 86_400_000),
  },
});
await prisma.entry.create({
  data: {
    workspaceId: spaceId,
    createdBy: ownerId,
    title: '已删除草稿',
    body: '正文',
    status: 'draft',
    createdAt: new Date(now.getTime() - 9 * 86_400_000),
    deletedAt: new Date(),
  },
});

// ---------------------------------------------------------------- 主流程
const response = await call('GET', path, { jar: owner.jar });
const data = response.json['data'] as
  | {
      businessDate?: string;
      timezone?: string;
      counts?: Record<string, number>;
      urgent?: {
        overdue?: { id: string; title: string; overdueDays: number | null }[];
        stalled?: { id: string; title: string; stalledDays: number | null }[];
        staleDrafts?: { id: string; title: string; ageDays: number }[];
      };
      urgentCount?: number;
    }
  | undefined;

check('今日接口返回 200', response.status === 200);
check(
  '业务日按空间时区计算',
  data?.businessDate === businessDate(new Date(), timezone) && data?.timezone === timezone,
);

const counts = data?.counts ?? {};
check(
  '逾期阈值 >0 天：只算 2 条（今日到期不算）',
  counts['overdueTasks'] === 2,
  `实际 ${counts['overdueTasks']}`,
);
check(
  '停滞阈值 >3 天：只算 1 条（3 天未满不算）',
  counts['stalledTasks'] === 1,
  `实际 ${counts['stalledTasks']}`,
);
check('草稿超期 >7 天：只算 1 条', counts['staleDrafts'] === 1, `实际 ${counts['staleDrafts']}`);
check('今日到期任务 1 条', counts['todayTasks'] === 1, `实际 ${counts['todayTasks']}`);
check(
  '昨日未完成 1 条',
  counts['yesterdayIncomplete'] === 1,
  `实际 ${counts['yesterdayIncomplete']}`,
);
check('今日完成 1 条', counts['doneToday'] === 1, `实际 ${counts['doneToday']}`);
check(
  '草稿不计入任务总数（openTasks=5）',
  counts['openTasks'] === 5,
  `实际 ${counts['openTasks']}`,
);

const overdueList = data?.urgent?.overdue ?? [];
check(
  '紧急-逾期列表按日期升序且天数正确',
  overdueList.length === 2 &&
    overdueList[0]?.overdueDays === 5 &&
    overdueList[1]?.overdueDays === 1,
);
check(
  '逾期列表不含已完成/已删除/今日到期',
  !overdueList.some(
    (task) =>
      task.title.includes('已完成') || task.title.includes('删除') || task.title === '今日到期',
  ),
);

const stalledList = data?.urgent?.stalled ?? [];
check(
  '紧急-停滞列表只有 1 条且天数 ≥4',
  stalledList.length === 1 && (stalledList[0]?.stalledDays ?? 0) >= 4,
  'list=' +
    JSON.stringify(
      stalledList.map((task) => ({
        title: task.title,
        stalledDays: task.stalledDays,
        status: task.status,
      })),
    ),
);

const draftList = data?.urgent?.staleDrafts ?? [];
check(
  '紧急-草稿列表只有 1 条且年龄 ≥8',
  draftList.length === 1 && (draftList[0]?.ageDays ?? 0) >= 8,
);
check(
  '草稿列表不含已验证/已删除',
  !draftList.some((entry) => entry.title.includes('已验证') || entry.title.includes('删除')),
);

const allIds = [
  ...overdueList.map((task) => task.id),
  ...stalledList.map((task) => task.id),
  ...draftList.map((entry) => entry.id),
];
check(
  '紧急项无重复计数',
  new Set(allIds).size === allIds.length && data?.urgentCount === new Set(allIds).size,
  `urgentCount=${data?.urgentCount}`,
);

// ---------------------------------------------------------------- 时区独立性
const spoofed = await call('GET', path, {
  jar: owner.jar,
  headers: { 'x-client-timezone': 'Pacific/Kiritimati', 'x-timezone': 'America/New_York' },
});
check(
  '客户端时区头不影响共享业务日',
  (spoofed.json['data'] as { businessDate?: string } | undefined)?.businessDate ===
    data?.businessDate,
);

const kiritimati = await prisma.workspace.create({
  data: { name: '基里巴斯空间', timezone: 'Pacific/Kiritimati', createdBy: ownerId },
});
await prisma.workspaceMember.create({
  data: { workspaceId: kiritimati.id, userId: ownerId, role: 'owner' },
});
const kiritimatiRes = await call('GET', `/workspaces/${kiritimati.id}/dashboard/today`, {
  jar: owner.jar,
});
check(
  '不同时区的空间各自计算业务日',
  (kiritimatiRes.json['data'] as { businessDate?: string } | undefined)?.businessDate ===
    businessDate(new Date(), 'Pacific/Kiritimati'),
);

const changedTz = await call('GET', `/workspaces/${spaceId}/dashboard/today`, { jar: owner.jar });
await prisma.workspace.update({ where: { id: spaceId }, data: { timezone: 'Pacific/Kiritimati' } });
const afterTzChange = await call('GET', path, { jar: owner.jar });
check(
  '修改空间时区后业务日随之改变',
  (afterTzChange.json['data'] as { businessDate?: string } | undefined)?.businessDate ===
    businessDate(new Date(), 'Pacific/Kiritimati'),
);
await prisma.workspace.update({ where: { id: spaceId }, data: { timezone } });
check(
  '恢复时区后业务日恢复',
  (changedTz.json['data'] as { businessDate?: string } | undefined)?.businessDate === today,
);

// ---------------------------------------------------------------- 权限与隔离
const viewerRead = await call('GET', path, { jar: viewerSession.jar });
check('Viewer 可读取今日聚合', viewerRead.status === 200);

const otherSpace = await prisma.workspace.create({
  data: { name: '未加入空间', timezone, createdBy: ownerId },
});
const crossSpace = await call('GET', `/workspaces/${otherSpace.id}/dashboard/today`, {
  jar: viewerSession.jar,
});
check('未加入的空间 → 404', crossSpace.status === 404);

// ---------------------------------------------------------------- 清理
await app.close();
await prisma.$executeRawUnsafe(
  'TRUNCATE TABLE users, workspaces, workspace_members, workspace_invites, sessions, account_recovery_tokens, audit_events, projects, tasks, entries, entry_tags, entry_usage, entry_revisions, tags, idempotency_records RESTART IDENTITY CASCADE',
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
