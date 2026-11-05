import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { data, root, profile, read, sql, stop, start, smoke } from './native.mjs';
import { client, waitJob } from './native-client.mjs';
import { backup } from './backup.mjs';
const cfg = await profile('production'),
  stage = await profile('stage'),
  c = await client('production'),
  other = await client('stage'),
  base = '/workspaces/' + c.workspaceId;
let checks = 0;
const check = (v, n) => {
  assert.ok(v, n);
  console.log('PASS ' + ++checks + ' ' + n);
};
check(
  cfg.database !== stage.database &&
    cfg.databaseUrl !== stage.databaseUrl &&
    c.me.user.id !== other.me.user.id,
  '正式/预发布独立库、角色、账号标识',
);
check(
  c.jar.aiwb_production && c.jar.aiwb_production_csrf && !c.jar.aiwb_stage,
  '正式环境会话与CSRF Cookie独立',
);
const foreign = await fetch(cfg.origin + '/api/v1/auth/me', {
  headers: {
    cookie: Object.entries(other.jar)
      .map(([k, v]) => k + '=' + v)
      .join('; '),
  },
});
check(foreign.status === 401, '预发布Cookie在正式环境401');
await c.call('/workspaces/' + other.workspaceId + '/projects', { expected: 404 });
check(true, '正式Owner不能读取预发布空间标识');
const state = await read(path.join(data, 'runtime/production/state.json')),
  stageState = await read(path.join(data, 'runtime/stage/state.json'));
check(
  state.release === stageState.release && state.release === (process.argv[2] ?? 'local-final-v5'),
  '正式与已验收stage使用同一不可变包',
);
const project = (
  await c.call(base + '/projects', {
    method: 'POST',
    body: { name: '发布技术验收-' + Date.now(), nextStep: '验证后移入回收站' },
  })
).data;
const key = randomUUID(),
  request = {
    method: 'POST',
    key,
    body: {
      title: '正式发布验收任务',
      projectId: project.id,
      priority: 'p1',
      status: 'doing',
      dueDate: '2026-11-05',
    },
  };
const task = (await c.call(base + '/tasks', request)).data.task,
  replayed = (await c.call(base + '/tasks', request)).data;
check(replayed.task.id === task.id && replayed.replayed, '真实任务写入幂等重试只一次');
const promoted = (
  await c.call(base + '/tasks/' + task.id + '/promote', {
    method: 'POST',
    version: task.version,
    body: { newEntry: false },
  })
).data;
check(!!promoted.entryId, '任务沉淀真实知识');
let entry = (await c.call(base + '/entries/' + promoted.entryId)).data;
entry = (
  await c.call(base + '/entries/' + entry.id, {
    method: 'PATCH',
    version: entry.version,
    body: {
      title: '正式发布验收知识',
      summary: '发布验收用合成记录，验证后回收',
      body: '中文正文\n```ts\nconst production=true;\n```',
    },
  })
).data;
entry = (
  await c.call(base + '/entries/' + entry.id + '/status', {
    method: 'POST',
    version: entry.version,
    body: { status: 'verified' },
  })
).data;
check(entry.status === 'verified', '知识编辑与验证状态通过');
await c.call(base + '/entries/' + entry.id + '/usage', { method: 'POST', body: {} });
const record = (
  await c.call(base + '/ledger', {
    method: 'POST',
    body: {
      recordDate: '2026-11-05',
      tool: 'other',
      scene: 'coding',
      minutes: 10,
      savedMinutes: 20,
      effect: 4,
      note: '发布技术验收，稍后可恢复回收',
      projectId: project.id,
      entryId: entry.id,
    },
  })
).data.record;
check(record.entryId === entry.id, '台账关联知识与项目');
await c.call(base + '/analytics/monthly?month=2026-11');
await c.call(base + '/analytics/weekly');
check(
  (
    await sql(
      cfg.databaseUrl,
      'SELECT sum(saved_minutes)::int n FROM ledger_records WHERE workspace_id=$1 AND deleted_at IS NULL',
      [c.workspaceId],
    )
  ).rows[0].n === 20,
  '统计原值20分钟一致',
);
const exported = (await c.call(base + '/exports', { method: 'POST', body: { format: 'json' } }))
  .data;
await waitJob(c, exported.id);
const file = await c.call(base + '/transfers/' + exported.id + '/download');
check(
  file.text.includes('正式发布验收知识') && !file.text.includes('passwordHash'),
  '正式worker导出和受控下载通过',
);
await stop('production');
await start('production', state.release);
await smoke('production');
const again = await client('production');
check(
  (await again.call(base + '/projects/' + project.id)).data.id === project.id,
  '正式服务重启持久化通过',
);
// 只将本脚本刚创建的合成实体软删除，留在可恢复回收站与审计。
for (const [route, id] of [
  ['ledger', record.id],
  ['tasks', task.id],
  ['entries', entry.id],
  ['projects', project.id],
]) {
  const current = (await again.call(base + '/' + route + '/' + id)).data;
  await again.call(base + '/' + route + '/' + id, { method: 'DELETE', version: current.version });
}
check(
  (await again.call(base + '/projects')).data.projects.length === 0,
  '正常业务列表清空验收记录，回收站可恢复',
);
check(
  (await sql(cfg.databaseUrl, 'SELECT count(*)::int n FROM users')).rows[0].n === 1,
  '正式库仅初始化Owner，不含临时Viewer或开发账号',
);
const point = await backup('production');
const report = {
  checks,
  release: state.release,
  url: cfg.origin,
  backup: point.header.id,
  temporaryEntities: { project: project.id, task: task.id, entry: entry.id, ledger: record.id },
  cleanup: '仅软删除本脚本合成记录，审计和回收站保留',
  result: 'passed',
};
await fs.writeFile(
  path.join(root, '全栈开发任务/验收证据/FS050/production-result.json'),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report));
