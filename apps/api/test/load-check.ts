import { Client } from 'pg';
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
config({ path: resolve('../../.env'), quiet: true });
const source = process.env['DATABASE_URL_TEST'];
if (!source) throw new Error('test URL required');
const target = new URL(source);
if (!['127.0.0.1', 'localhost'].includes(target.hostname) || !target.pathname.endsWith('_test'))
  throw new Error('local test only');
const adminUrl = new URL(source);
adminUrl.pathname = '/postgres';
const admin = new Client({ connectionString: adminUrl.toString() });
await admin.connect();
const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname='aiwb_perf_test'");
if (!exists.rowCount) await admin.query('CREATE DATABASE aiwb_perf_test');
await admin.end();
target.pathname = '/aiwb_perf_test';
process.env['DATABASE_URL_TEST'] = target.toString();
process.env['DATABASE_URL'] = target.toString();
process.env['LOG_LEVEL'] = 'error';
process.env['TRANSFER_WORKER_ENABLED'] = 'false';
const migration = spawnSync(
  process.execPath,
  [resolve('../../node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
  { cwd: resolve('../..'), env: process.env, encoding: 'utf8', windowsHide: true },
);
if (migration.status !== 0) throw new Error(migration.stderr);
console.log('独立压测库迁移通过');
const { createTestContext } = await import('./test-context.js');
const ctx = await createTestContext();
const evidence = resolve('../../全栈开发任务/验收证据/FS041');
await mkdir(evidence, { recursive: true });
const durationMs = Number(process.env['LOAD_DURATION_MS'] ?? 900000);
if (!Number.isInteger(durationMs) || durationMs < 10000) throw new Error('duration>=10s');
const results: Record<string, number[]> = {},
  errors: Record<string, number> = {},
  cold: Record<string, number> = {},
  samples: unknown[] = [];
let maxRSS = 0,
  maxConnections = 0,
  requests = 0;
try {
  const owners = [];
  for (const label of ['perf-a', 'perf-b']) {
    const owner = await ctx.owner(label),
      w = owner.workspaceId,
      u = owner.userId;
    owners.push(owner);
    const p = await ctx.prisma.project.create({
      data: { workspaceId: w, createdBy: u, name: '压测项目', nextStep: '性能基线' },
    });
    await ctx.prisma
      .$executeRaw`INSERT INTO entries(id,workspace_id,created_by,type,status,title,summary,body,created_at,updated_at) SELECT gen_random_uuid(),${w}::uuid,${u}::uuid,'note'::entry_type,'draft'::entry_status,'中文断连知识'||g,'背景与确定性搜索',repeat('中文长正文与排查命令。',80),now(),now() FROM generate_series(1,10000) g`;
    await ctx.prisma
      .$executeRaw`INSERT INTO tasks(id,workspace_id,created_by,project_id,title,priority,status,due_date,done_at,created_at,updated_at) SELECT gen_random_uuid(),${w}::uuid,${u}::uuid,${p.id}::uuid,'压测任务'||g,'p1'::task_priority,CASE WHEN g%3=0 THEN 'done'::task_status ELSE 'todo'::task_status END,date '2026-11-04'+(g%30),CASE WHEN g%3=0 THEN now() ELSE NULL END,now(),now() FROM generate_series(1,50000) g`;
    await ctx.prisma
      .$executeRaw`INSERT INTO ledger_records(id,workspace_id,created_by,project_id,record_date,tool,scene,minutes,saved_minutes,effect,note,created_at,updated_at) SELECT gen_random_uuid(),${w}::uuid,${u}::uuid,${p.id}::uuid,date '2026-11-04'-(g%90),'claude',CASE WHEN g%2=0 THEN 'coding' ELSE 'debugging' END,10,20,4,'压测台账',now(),now() FROM generate_series(1,50000) g`;
    const tag = await ctx.prisma.tag.create({
      data: { workspaceId: w, nameNormalized: '热门', displayName: '热门' },
    });
    await ctx.prisma
      .$executeRaw`INSERT INTO entry_tags(workspace_id,entry_id,tag_id) SELECT ${w}::uuid,id,${tag.id}::uuid FROM entries WHERE workspace_id=${w}::uuid LIMIT 1000`;
    console.log(
      JSON.stringify({
        dataset: label,
        entries: 10000,
        tasks: 50000,
        ledger: 50000,
        longBodyBytes: Buffer.byteLength('中文长正文与排查命令。'.repeat(80), 'utf8'),
      }),
    );
  }
  await ctx.prisma.$executeRawUnsafe('ANALYZE');
  const routes = [
    ['list', '/tasks?limit=20'],
    ['list', '/entries?limit=20'],
    ['list', '/ledger?limit=20'],
    ['list', '/projects?limit=20'],
    ['aggregate', '/analytics/monthly?month=2026-11'],
    ['aggregate', '/analytics/weekly'],
    ['search', '/search/entries?q=中&limit=20'],
    ['empty-search', '/search/entries?q=未命中随机码999xyz&limit=20'],
  ] as const;
  for (const [name, route] of routes) {
    const started = performance.now();
    const r = await ctx.call('GET', '/workspaces/' + owners[0]!.workspaceId + route, owners[0]!);
    if (r.status !== 200) throw new Error('cold request failed ' + route);
    cold[name + route] = performance.now() - started;
  }
  const explain = await ctx.prisma.$queryRawUnsafe(
    "EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT id FROM tasks WHERE workspace_id='" +
      owners[0]!.workspaceId +
      "'::uuid AND deleted_at IS NULL ORDER BY updated_at DESC,id DESC LIMIT 20",
  );
  await writeFile(resolve(evidence, 'explain.json'), JSON.stringify(explain, null, 2));
  const started = performance.now(),
    cpuStart = process.cpuUsage();
  let batch = 0;
  while (performance.now() - started < durationMs) {
    await Promise.all(
      Array.from({ length: 20 }, async (_, vu) => {
        const owner = owners[vu % 2]!,
          root = '/workspaces/' + owner.workspaceId;
        const write = vu === 18 || vu === 19;
        const [category, route] = routes[(batch + vu) % routes.length]!;
        const name = write ? 'write' : category;
        const at = performance.now();
        try {
          const result = write
            ? await ctx.call('POST', root + '/logs', {
                ...owner,
                key: 'load-' + batch + '-' + vu,
                body: { text: '压测写入 ' + batch + '-' + vu, logDate: '2026-11-04' },
              })
            : await ctx.call('GET', root + route, owner);
          if (result.status < 200 || result.status >= 300)
            errors[name + ':' + result.status] = (errors[name + ':' + result.status] ?? 0) + 1;
        } catch {
          errors[name + ':network'] = (errors[name + ':network'] ?? 0) + 1;
        }
        (results[name] ??= []).push(performance.now() - at);
        requests++;
      }),
    );
    batch++;
    maxRSS = Math.max(maxRSS, process.memoryUsage().rss);
    if (batch % 50 === 0) {
      const stats = await ctx.prisma.$queryRaw<
        { connections: bigint; active: bigint }[]
      >`SELECT count(*) AS connections,count(*) FILTER(WHERE state='active') AS active FROM pg_stat_activity WHERE datname=current_database()`;
      const connections = Number(stats[0]!.connections);
      maxConnections = Math.max(maxConnections, connections);
      samples.push({
        seconds: Math.round((performance.now() - started) / 1000),
        rssMiB: Math.round(process.memoryUsage().rss / 1048576),
        connections,
        active: Number(stats[0]!.active),
      });
      console.log(
        JSON.stringify({
          seconds: Math.round((performance.now() - started) / 1000),
          requests,
          errors: Object.values(errors).reduce((a, b) => a + b, 0),
        }),
      );
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const elapsedMs = performance.now() - started,
    cpu = process.cpuUsage(cpuStart),
    percentile = (values: number[], q: number) =>
      values.slice().sort((a, b) => a - b)[
        Math.min(values.length - 1, Math.ceil(values.length * q) - 1)
      ] ?? 0;
  const metrics = Object.fromEntries(
    Object.entries(results).map(([name, v]) => [
      name,
      {
        count: v.length,
        p50: percentile(v, 0.5),
        p95: percentile(v, 0.95),
        p99: percentile(v, 0.99),
      },
    ]),
  );
  const failures = Object.values(errors).reduce((a, b) => a + b, 0);
  const report = {
    timestamp: new Date().toISOString(),
    database: 'aiwb_perf_test',
    durationMs: elapsedMs,
    concurrentRequestsPerBatch: 20,
    thinkMsBetweenBatches: 200,
    dataset: { spaces: 2, perSpace: { entries: 10000, tasks: 50000, ledger: 50000 } },
    coldClientAndQueryMs: cold,
    requests,
    errors,
    errorRate: failures / requests,
    metrics,
    resources: {
      platform: os.platform(),
      release: os.release(),
      cpu: os.cpus()[0]?.model,
      logicalCores: os.cpus().length,
      hostMemoryGiB: os.totalmem() / 1073741824,
      maxNodeRssMiB: maxRSS / 1048576,
      nodeCPUPercentOneCore: ((cpu.user + cpu.system) / 1000 / elapsedMs) * 100,
      maxDbConnections: maxConnections,
    },
    samples,
  };
  await writeFile(
    resolve(evidence, durationMs >= 900000 ? 'load-final.json' : 'load-baseline.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
  if (
    failures / requests >= 0.01 ||
    Object.entries(metrics).some(
      ([name, m]) => m.p95 > (['list', 'write'].includes(name) ? 300 : 800),
    )
  )
    throw new Error('性能预算未通过，需整改后复测');
} finally {
  await ctx.close();
}
