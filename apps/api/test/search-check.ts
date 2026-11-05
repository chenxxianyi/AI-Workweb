import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { config as loadEnvFile } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { createPrismaAdapter } from '../src/common/prisma-adapter.js';
import { bootstrapOwner } from '../src/modules/auth/auth-core.js';

/**
 * F22 验收：中文搜索、排序权重、通配符安全、1 万条性能与 EXPLAIN。
 *   pnpm --filter @aiwb/api test:search
 *
 * 只允许跑在 *_test 数据库（会 TRUNCATE 并写入约 1 万条数据）。
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
console.log(`[search-check] 数据库：${databaseName}`);

process.env['DATABASE_URL'] = databaseUrl;
process.env['RATE_LIMIT_LOGIN_PER_MINUTE'] = '500';
process.env['RATE_LIMIT_SEARCH_PER_MINUTE'] = '500';
process.env['COOKIE_SECURE'] = 'false';
process.env['LOG_LEVEL'] = 'error';

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
  options: { body?: unknown; jar?: Jar; csrf?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (method === 'POST' && (path === '/workspaces' || /^\/workspaces\/[^/]+\/projects$/.test(path)))
    headers['idempotency-key'] = globalThis.crypto.randomUUID();
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

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[index] ?? 0;
}

// ---------------------------------------------------------------- 准备
await prisma.$executeRawUnsafe(
  'TRUNCATE TABLE users, workspaces, workspace_members, workspace_invites, sessions, account_recovery_tokens, audit_events, projects, tasks, entries, entry_tags, entry_usage, entry_revisions, tags, ledger_records, idempotency_records RESTART IDENTITY CASCADE',
);

const OWNER_EMAIL = 'search-owner@authtest.local';
const OWNER_PASSWORD = 'Workbench-Omicron-Search-42';
const boot = await bootstrapOwner(prisma, {
  email: OWNER_EMAIL,
  displayName: '搜索 Owner',
  password: OWNER_PASSWORD,
});
check('准备：Owner 与个人空间创建成功', boot.created === true);
const spaceId = boot.created ? boot.workspaceId : '';
const ownerId = boot.created ? boot.userId : '';
const owner = await login(OWNER_EMAIL, OWNER_PASSWORD);
const path = (q: string, extra = ''): string =>
  `/workspaces/${spaceId}/search/entries?q=${encodeURIComponent(q)}${extra}`;

// 业务数据
const sseEntry = await prisma.entry.create({
  data: {
    workspaceId: spaceId,
    createdBy: ownerId,
    title: 'SSE断连重试',
    summary: '流式接口断线后的重试策略',
    body: '正文：包含退避与幂等键。',
    status: 'verified',
  },
});
const bodyMatchEntry = await prisma.entry.create({
  data: {
    workspaceId: spaceId,
    createdBy: ownerId,
    title: '网络问题排查',
    summary: '与关键词无关的摘要',
    body: '线上出现断连时先看网关日志。',
    status: 'draft',
  },
});
const popularUnrelated = await prisma.entry.create({
  data: {
    workspaceId: spaceId,
    createdBy: ownerId,
    title: '最热门的无关条目',
    summary: '被使用了很多次但内容无关',
    body: '完全无关的内容：配色与字体。',
    status: 'verified',
  },
});
await prisma.entryUsage.create({
  data: {
    workspaceId: spaceId,
    entryId: popularUnrelated.id,
    useCount: 9999,
    lastUsedAt: new Date(),
  },
});
const archivedEntry = await prisma.entry.create({
  data: {
    workspaceId: spaceId,
    createdBy: ownerId,
    title: '断连排查（已归档）',
    summary: '历史排查记录',
    body: '旧方案。',
    status: 'archived',
  },
});

const otherSpace = await prisma.workspace.create({
  data: { name: '另一空间', timezone: 'Asia/Shanghai', createdBy: ownerId },
});
await prisma.workspaceMember.create({
  data: { workspaceId: otherSpace.id, userId: ownerId, role: 'owner' },
});
await prisma.entry.create({
  data: {
    workspaceId: otherSpace.id,
    createdBy: ownerId,
    title: '断连（别的空间）',
    summary: '另一个空间里的同名内容',
    body: '断连',
    status: 'verified',
  },
});

// 1 万条填充数据
const fillers = Array.from({ length: 10_000 }, (_, index) => ({
  workspaceId: spaceId,
  createdBy: ownerId,
  title: `填充条目 ${index + 1}`,
  summary: `与搜索无关的摘要 ${index + 1}`,
  body: `这是一段与关键词无关的正文，编号 ${index + 1}。`,
  status: (index % 3 === 0 ? 'verified' : index % 3 === 1 ? 'draft' : 'archived') as
    'verified' | 'draft' | 'archived',
}));
for (let offset = 0; offset < fillers.length; offset += 2000) {
  await prisma.entry.createMany({ data: fillers.slice(offset, offset + 2000) });
}
const total = await prisma.entry.count({ where: { workspaceId: spaceId } });
check('写入 1 万条以上测试数据', total >= 10_000, `实际 ${total}`);

// ---------------------------------------------------------------- 命中与排序
const hit = await call('GET', path('断连'), { jar: owner.jar });
const hitData = hit.json['data'] as
  { hits?: { title: string; score: number }[]; tookMs?: number } | undefined;
const hitTitles = (hitData?.hits ?? []).map((entry) => entry.title);
check('“断连”命中「SSE断连重试」', hitTitles.includes('SSE断连重试'));
check('“断连”命中正文里的「网络问题排查」', hitTitles.includes('网络问题排查'));
check('“断连”命中已归档条目（降权但不隐藏）', hitTitles.includes('断连排查（已归档）'));
check('无关热门条目不会靠 usage 入选', !hitTitles.includes('最热门的无关条目'));
check('不返回别的空间的条目', !hitTitles.some((title) => title.includes('别的空间')));
check(
  '标题命中排在正文命中之前',
  hitTitles.indexOf('SSE断连重试') < hitTitles.indexOf('网络问题排查'),
);
check(
  '已验证标题命中排在已归档标题命中之前',
  hitTitles.indexOf('SSE断连重试') < hitTitles.indexOf('断连排查（已归档）'),
);
check('结果条数受 limit 限制（默认 20）', (hitData?.hits?.length ?? 0) <= 20);

// 英文大小写
const lower = await call('GET', path('sse'), { jar: owner.jar });
check(
  '英文不区分大小写（sse 命中 SSE）',
  ((lower.json['data'] as { hits?: { title: string }[] } | undefined)?.hits ?? []).some(
    (entry) => entry.title === 'SSE断连重试',
  ),
);

// 安全通配
const percent = await call('GET', path('%'), { jar: owner.jar });
const underscore = await call('GET', path('_'), { jar: owner.jar });
const backslash = await call('GET', path('\\'), { jar: owner.jar });
check(
  '“%”不被当作通配符（0 结果）',
  ((percent.json['data'] as { hits?: unknown[] } | undefined)?.hits?.length ?? -1) === 0,
);
check(
  '“_”不被当作通配符（0 结果）',
  ((underscore.json['data'] as { hits?: unknown[] } | undefined)?.hits?.length ?? -1) === 0,
);
check(
  '“\\”转义后不报错且为 0 结果',
  backslash.status === 200 &&
    ((backslash.json['data'] as { hits?: unknown[] } | undefined)?.hits?.length ?? -1) === 0,
);

// 无结果
const none = await call('GET', path('不存在的搜索词xyz'), { jar: owner.jar });
check(
  '无结果查询返回空数组且状态 200',
  none.status === 200 &&
    ((none.json['data'] as { hits?: unknown[] } | undefined)?.hits?.length ?? -1) === 0,
);

// 分页
const page1 = await call('GET', path('断连', '&limit=1'), { jar: owner.jar });
const page1Data = page1.json['data'] as
  { hits?: { title: string }[]; hasMore?: boolean; nextCursor?: string | null } | undefined;
check('limit=1 返回 1 条且有下一页', page1Data?.hits?.length === 1 && page1Data?.hasMore === true);
const page2 = await call('GET', path('断连', `&limit=1&cursor=${page1Data?.nextCursor ?? ''}`), {
  jar: owner.jar,
});
const page2Title = ((page2.json['data'] as { hits?: { title: string }[] } | undefined)?.hits ??
  [])[0]?.title;
check(
  '第二页与第一页不同',
  page2Title !== page1Data?.hits?.[0]?.title,
  `${page1Data?.hits?.[0]?.title} -> ${page2Title}`,
);

// ---------------------------------------------------------------- 性能（1 万条）
async function measure(query: string, rounds = 20): Promise<{ p95: number; samples: number[] }> {
  await call('GET', path(query), { jar: owner.jar }); // 预热
  const samples: number[] = [];
  for (let index = 0; index < rounds; index += 1) {
    const start = performance.now();
    const measuredResponse = await call('GET', path(query), { jar: owner.jar });
    if (measuredResponse.status !== 200)
      throw new Error('性能查询失败：' + measuredResponse.status);
    samples.push(performance.now() - start);
  }
  return { p95: p95(samples), samples };
}

const shortWord = await measure('断连');
const noResult = await measure('不存在的搜索词xyz');
const english = await measure('sse');

const BUDGET_MS = 300;
console.log(
  '[timing] short=' +
    shortWord.p95.toFixed(1) +
    'ms noResult=' +
    noResult.p95.toFixed(1) +
    'ms english=' +
    english.p95.toFixed(1) +
    'ms',
);
check(
  `1 万条下短词“断连” p95 ≤ ${BUDGET_MS}ms`,
  shortWord.p95 <= BUDGET_MS,
  `p95=${shortWord.p95.toFixed(1)}ms samples=[${shortWord.samples.map((value) => value.toFixed(0)).join(',')}]`,
);
check(
  `1 万条下无结果查询 p95 ≤ ${BUDGET_MS}ms`,
  noResult.p95 <= BUDGET_MS,
  `p95=${noResult.p95.toFixed(1)}ms`,
);
check(
  `1 万条下英文短词 p95 ≤ ${BUDGET_MS}ms`,
  english.p95 <= BUDGET_MS,
  `p95=${english.p95.toFixed(1)}ms`,
);

// EXPLAIN 证据
const explain = await prisma.$queryRaw<{ 'QUERY PLAN': string }[]>`
  EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
  SELECT id FROM entries
  WHERE workspace_id = ${spaceId}::uuid
    AND deleted_at IS NULL
    AND (title ILIKE '%断连%' OR coalesce(summary, '') ILIKE '%断连%' OR body ILIKE '%断连%')
  ORDER BY updated_at DESC
  LIMIT 20
`;
const plan = explain.map((row) => row['QUERY PLAN']).join('\n');
const usesSeqScan = plan.includes('Seq Scan');
const execMs = Number(/Execution Time: ([\d.]+) ms/.exec(plan)?.[1] ?? 'NaN');
check('EXPLAIN 能取得执行计划', plan.length > 0);
check(
  `EXPLAIN 执行时间在预算内（${Number.isNaN(execMs) ? 'n/a' : execMs.toFixed(1)}ms）`,
  Number.isNaN(execMs) || execMs <= BUDGET_MS,
);
check('记录扫描方式（Seq Scan 或索引）', usesSeqScan || plan.includes('Index'));

// ---------------------------------------------------------------- 参数校验与限流
const empty = await call('GET', `/workspaces/${spaceId}/search/entries?q=`, { jar: owner.jar });
check('空搜索词 → 422', empty.status === 422);

const crossSpace = await call(
  'GET',
  `/workspaces/${otherSpace.id}/search/entries?q=${encodeURIComponent('断连')}`,
  { jar: owner.jar },
);
check(
  '别的空间只返回自己的命中（1 条）',
  ((crossSpace.json['data'] as { hits?: unknown[] } | undefined)?.hits?.length ?? -1) === 1,
);

// ---------------------------------------------------------------- 参数、标签、作用域和整理
for (const extra of [
  '&limit=-1',
  '&limit=1.5',
  '&limit=Infinity',
  '&limit=abc',
  '&status=invalid',
  '&type=invalid',
  '&projectId=invalid',
  '&unknown=1',
]) {
  const invalid = await call('GET', path('断连', extra), { jar: owner.jar });
  check('非法参数拒绝 ' + extra, invalid.status === 422);
}
const brokenCursor = await call('GET', path('断连', '&cursor=invalid'), { jar: owner.jar });
check('损坏游标拒绝', brokenCursor.status === 400);
const changedQuery = await call(
  'GET',
  path('sse', '&limit=1&cursor=' + encodeURIComponent(page1Data?.nextCursor ?? '')),
  { jar: owner.jar },
);
check('改变查询不能复用游标', changedQuery.status === 400);
const changedWorkspace = await call(
  'GET',
  `/workspaces/${otherSpace.id}/search/entries?q=${encodeURIComponent('断连')}&limit=1&cursor=${encodeURIComponent(page1Data?.nextCursor ?? '')}`,
  { jar: owner.jar },
);
check('不能跨空间复用游标', changedWorkspace.status === 400);
const longQuery = await call('GET', path('a'.repeat(101)), { jar: owner.jar });
check('超过100字符拒绝', longQuery.status === 422);
const injection = await call('GET', path("%' OR 1=1 --"), { jar: owner.jar });
check(
  '注入输入按字面匹配',
  injection.status === 200 && (injection.json['data'] as { hits: unknown[] }).hits.length === 0,
);
const anonymous = await call('GET', path('断连'));
check('匿名搜索拒绝', anonymous.status === 401);
const tag = await prisma.tag.create({
  data: { workspaceId: spaceId, nameNormalized: '标签独占', displayName: '标签独占' },
});
await prisma.entryTag.createMany({
  data: [sseEntry.id, bodyMatchEntry.id].map((entryId) => ({
    workspaceId: spaceId,
    entryId,
    tagId: tag.id,
  })),
});
const tagged = await call('GET', path('标签独占'), { jar: owner.jar });
check('仅标签命中也能搜索', (tagged.json['data'] as { hits: unknown[] }).hits.length === 2);
const filtered = await call(
  'GET',
  path('断连', '&tag=' + encodeURIComponent('标签独占') + '&status=verified'),
  { jar: owner.jar },
);
check(
  '标签状态交集过滤',
  (filtered.json['data'] as { hits: { id: string }[] }).hits[0]?.id === sseEntry.id &&
    (filtered.json['data'] as { hits: unknown[] }).hits.length === 1,
);
const related = await call('GET', `/workspaces/${spaceId}/search/related/${sseEntry.id}`, {
  jar: owner.jar,
});
check(
  '相关知识排除自身并按共同标签返回',
  (related.json['data'] as { id: string }[])[0]?.id === bodyMatchEntry.id,
);
const oldDate = new Date(Date.now() - 40 * 86400_000);
await prisma.entry.create({
  data: {
    workspaceId: spaceId,
    createdBy: ownerId,
    title: '陈旧草稿',
    body: '',
    createdAt: oldDate,
    updatedAt: oldDate,
  },
});
const organize = await call('GET', `/workspaces/${spaceId}/search/organize`, { jar: owner.jar });
const organizeData = organize.json['data'] as {
  overdueDrafts: number;
  staleEntries: number;
  top: { id: string }[];
};
check(
  '整理汇总使用业务日期与未使用回退',
  organizeData.overdueDrafts === 1 && organizeData.staleEntries === 1,
);
check('常用Top5按使用次数', organizeData.top[0]?.id === popularUnrelated.id);
const oldFreshness = await prisma.entry.create({
  data: {
    workspaceId: spaceId,
    createdBy: ownerId,
    title: '新鲜度测试',
    body: '',
    updatedAt: oldDate,
  },
});
const newFreshness = await prisma.entry.create({
  data: { workspaceId: spaceId, createdBy: ownerId, title: '新鲜度测试', body: '' },
});
const freshness = await call('GET', path('新鲜度测试'), { jar: owner.jar });
check(
  '新内容排在旧内容之前而非反向加分',
  (freshness.json['data'] as { hits: { id: string }[] }).hits[0]?.id === newFreshness.id &&
    oldFreshness.id !== newFreshness.id,
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
console.log(`\n[plan]\n${plan}`);
console.log(
  `\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`,
);
process.exitCode = failed.length === 0 ? 0 : 1;
