import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { data, profile, sql, stop, start, smoke, read } from './native.mjs';
import { client, waitJob } from './native-client.mjs';
const p = process.argv[2] ?? 'stage';
if (p !== 'stage') throw Error('业务写验收只允许stage');
let checks = 0;
const check = (v, n) => {
  assert.ok(v, n);
  console.log('PASS ' + ++checks + ' ' + n);
};
const c = await client(p),
  base = '/workspaces/' + c.workspaceId;
check(
  Object.keys(c.jar).includes('aiwb_stage') &&
    Object.keys(c.jar).includes('aiwb_stage_csrf') &&
    !Object.keys(c.jar).includes('sfs_csrf'),
  '会话/CSRF Cookie环境独立',
);
check(c.me.user.email === 'owner@local.aiwb', '受限文件凭据可登录');
const project = (
  await c.call(base + '/projects', {
    method: 'POST',
    body: { name: '预发布验收-' + Date.now(), nextStep: '发布后继续开发' },
  })
).data;
check(!!project.id, '真实HTTP创建项目');
const task = (
  await c.call(base + '/tasks', {
    method: 'POST',
    body: { title: '预发布验收任务', projectId: project.id, priority: 'p1' },
  })
).data.task;
check(task.projectId === project.id, '任务关联项目');
const entry = (
  await c.call(base + '/entries', {
    method: 'POST',
    body: {
      title: '预发布验收知识',
      type: 'note',
      summary: '验收摘要',
      body: '中文正文\n```ts\nconst valid = true;\n```',
      projectId: project.id,
      tags: ['验收'],
    },
  })
).data.entry;
check(!!entry.id, '知识正文真实写入');
const ledger = (
  await c.call(base + '/ledger', {
    method: 'POST',
    body: {
      recordDate: '2026-11-05',
      tool: 'other',
      scene: 'coding',
      minutes: 12,
      savedMinutes: 30,
      effect: 4,
      note: '预发布验收台账',
      projectId: project.id,
      entryId: entry.id,
    },
  })
).data.record;
check(ledger.entryId === entry.id, '台账关联知识');
await c.call(base + '/entries/' + entry.id + '/usage', { method: 'POST', body: {} });
const update = (
  await c.call(base + '/entries/' + entry.id, {
    method: 'PATCH',
    version: entry.version,
    body: { body: entry.body + '\n保留修订' },
  })
).data;
check(update.version > entry.version, '条件写与修订');
const missingCsrf = await fetch(c.cfg.origin + '/api/v1' + base + '/projects', {
  method: 'POST',
  headers: {
    origin: c.cfg.origin,
    cookie: Object.entries(c.jar)
      .map(([k, v]) => k + '=' + v)
      .join('; '),
    'content-type': 'application/json',
    'idempotency-key': 'csrf-check',
  },
  body: JSON.stringify({ name: 'CSRF拒绝' }),
});
check(missingCsrf.status === 403, '缺少CSRF写入被拒绝');
// 匿名客户端与另一环境Cookie均不可访问业务。
const cross = await fetch(c.cfg.origin + '/api/v1' + base + '/projects', {
  headers: { cookie: 'aiwb_production=invalid; aiwb_production_csrf=invalid' },
});
check(cross.status === 401, '另一环境Cookie无效');
const exported = (
  await c.call(base + '/exports', { method: 'POST', body: { format: 'json', schemaVersion: 2 } })
).data;
const job = await waitJob(c, exported.id);
check(job.state === 'succeeded', '原生worker完成导出');
const download = await c.call(base + '/transfers/' + job.id + '/download');
check(
  download.text.includes('预发布验收知识') && !download.text.includes('passwordHash'),
  '受控下载包含业务且不含认证字段',
);
const file = path.join(data, 'stage-roundtrip.json');
await fs.writeFile(file, download.text);
const preview = (
  await c.call(base + '/imports/preview', { method: 'POST', body: download.text, raw: true })
).data;
const plan = await waitJob(c, preview.id, ['preview_ready']);
check(!!plan.planHash, '真实流式上传与worker预览');
await c.call(base + '/imports/' + preview.id + '/commit', {
  method: 'POST',
  body: { planHash: plan.planHash, confirm: true, decisions: [] },
});
const done = await waitJob(c, preview.id);
check(done.state === 'succeeded', '实际备份与事务导入完成');
const cfg = await profile(p),
  state = await read(path.join(data, 'runtime', p, 'state.json'));
await stop(p);
await start(p, state.release);
await smoke(p);
const re = await client(p),
  persisted = (await re.call(base + '/projects/' + project.id)).data;
check(persisted.id === project.id || persisted.project?.id === project.id, '停止重启业务数据保留');
check(
  (await sql(cfg.databaseUrl, 'SELECT count(*)::int AS n FROM users')).rows[0].n === 1,
  '预发布仅本机初始化用户，未复制开发账号',
);
await fs.writeFile(
  path.join(data, 'stage-business.json'),
  JSON.stringify(
    {
      projectId: project.id,
      entryId: entry.id,
      taskId: task.id,
      ledgerId: ledger.id,
      workspaceId: c.workspaceId,
      exportFile: file,
      checks,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ checks, result: 'passed', release: state.release }));
