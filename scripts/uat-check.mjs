import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { profile, sql, root, data } from './native.mjs';
import { client, waitJob } from './native-client.mjs';
const c = await client('stage'),
  cfg = await profile('stage'),
  base = '/workspaces/' + c.workspaceId,
  namespace = 'f48-legacy-' + Date.now(),
  folder = path.join(root, '全栈开发任务/验收证据/FS048');
await fs.mkdir(folder, { recursive: true });
let checks = 0;
const check = (v, n) => {
  assert.ok(v, n);
  console.log('PASS ' + ++checks + ' ' + n);
};
const fixture = {
  schema: 1,
  projects: [
    { id: 'p1', name: 'F48旧项目', stage: '开发', nextStep: '核对迁移', progressManual: false },
  ],
  tasks: [
    {
      id: 't1',
      title: 'F48旧任务',
      priority: 'P1',
      status: 'doing',
      due: '2026-01-01',
      projectId: 'p1',
      entryIds: ['e1'],
    },
  ],
  entries: [
    {
      id: 'e1',
      type: 'pitfall',
      title: 'F48排查记录',
      summary: '中文摘要',
      body: '旧正文\n```ts\nconst valid=true\n```',
      status: 'verified',
      tags: ['#Network', 'network'],
      useCount: 4,
      lastUsedAt: 1767225600,
      projectId: 'p1',
      revisions: [{ body: '旧修订', at: 1767225500 }],
    },
  ],
  logs: [
    { date: '2026-01-01', text: '同日重复日志', at: 1767225600 },
    { date: '2026-01-01', text: '同日重复日志', at: 1767225600 },
  ],
  ledger: [
    {
      id: 'l1',
      date: '2026-01-01',
      tool: 'claude-code',
      scene: '写功能',
      minutes: 10,
      savedMinutes: 30,
      effect: 5,
      entryId: 'e1',
      projectId: 'missing',
    },
  ],
  settings: { theme: 'dark' },
};
const source = JSON.stringify(fixture),
  started = Date.now();
await fs.writeFile(path.join(folder, 'legacy-sample.json'), JSON.stringify(fixture, null, 2));
async function preview() {
  const job = (
    await c.call(base + '/imports/preview?sourceNamespace=' + namespace, {
      method: 'POST',
      raw: true,
      body: source,
    })
  ).data;
  return waitJob(c, job.id, ['preview_ready']);
}
const initial = (await sql(cfg.databaseUrl, 'SELECT count(*)::int n FROM entries')).rows[0].n,
  plan = await preview();
check(
  (await sql(cfg.databaseUrl, 'SELECT count(*)::int n FROM entries')).rows[0].n === initial,
  '旧数据预览不写业务',
);
check(plan.counts.broken > 0, '断链在预览中报告');
await c.call(base + '/imports/' + plan.id + '/commit', {
  method: 'POST',
  body: { planHash: plan.planHash, confirm: true, decisions: [] },
});
await waitJob(c, plan.id);
const maps = (
    await sql(
      cfg.databaseUrl,
      'SELECT entity_type,legacy_id,entity_id FROM import_entity_mappings WHERE source_namespace=$1 AND workspace_id=$2',
      [namespace, c.workspaceId],
    )
  ).rows,
  map = (type, id) => maps.find((r) => r.entity_type === type && r.legacy_id === id)?.entity_id;
check(maps.length === 6, '6个旧实体建立稳定来源映射');
const project = (await c.call(base + '/projects/' + map('project', 'p1'))).data,
  entry = (await c.call(base + '/entries/' + map('entry', 'e1'))).data,
  task = (await c.call(base + '/tasks/' + map('task', 't1'))).data;
check(
  project.stage === 'developing' && task.priority === 'p1' && task.projectId === project.id,
  '旧中文枚举/优先级/项目关系正确',
);
check(
  entry.type === 'troubleshoot' &&
    entry.tags.length === 1 &&
    entry.tags[0] === 'network' &&
    entry.body === fixture.entries[0].body,
  '类型/标签去重/中文正文逐字段一致',
);
check(
  (await sql(cfg.databaseUrl, 'SELECT use_count FROM entry_usage WHERE entry_id=$1', [entry.id]))
    .rows[0].use_count === 4,
  '使用次数4保持',
);
check(
  (await sql(cfg.databaseUrl, 'SELECT body FROM entry_revisions WHERE entry_id=$1', [entry.id]))
    .rows[0].body === '旧修订',
  '修订原文保持',
);
check(
  (
    await sql(
      cfg.databaseUrl,
      'SELECT count(*)::int n FROM task_entries WHERE task_id=$1 AND entry_id=$2',
      [task.id, entry.id],
    )
  ).rows[0].n === 1,
  '任务知识关系唯一',
);
const ledger = (
  await sql(cfg.databaseUrl, 'SELECT * FROM ledger_records WHERE id=$1', [map('ledger', 'l1')])
).rows[0];
check(
  ledger.project_id === null &&
    ledger.entry_id === entry.id &&
    ledger.saved_minutes === 30 &&
    ledger.scene === 'coding',
  '断链转空/知识关联/台账数值及场景保持',
);
check(maps.filter((m) => m.entity_type === 'log').length === 2, '同日同文日志按发生次数保留两条');
await c.call(base + '/entries/' + entry.id, {
  method: 'PATCH',
  version: entry.version,
  body: { body: 'F48服务器已编辑，冲突时保留' },
});
const again = await preview();
check(again.counts.conflicts > 0, '重复导入发现服务器编辑冲突');
await c.call(base + '/imports/' + again.id + '/commit', {
  method: 'POST',
  body: {
    planHash: again.planHash,
    confirm: true,
    decisions: [{ entityType: 'entry', sourceId: 'e1', action: 'keep_server' }],
  },
});
await waitJob(c, again.id);
check(
  (await c.call(base + '/entries/' + entry.id)).data.body === 'F48服务器已编辑，冲突时保留',
  '显式保留服务器决策生效',
);
check(
  (
    await sql(
      cfg.databaseUrl,
      'SELECT count(*)::int n FROM import_entity_mappings WHERE source_namespace=$1',
      [namespace],
    )
  ).rows[0].n === 6,
  '再次导入不重复创建实体',
);
const preferences = (await c.call(base + '/preferences')).data;
check(preferences.databaseBackup.state === 'ok', '真实设置接口显示本机数据库备份已完成');
// 临时Viewer仅用于本机合成数据浏览验收，不可进入production。
const require = createRequire(path.join(root, 'apps/api/package.json')),
  argon2 = require('argon2'),
  viewerId = randomUUID();
await sql(
  cfg.migrationUrl,
  "INSERT INTO users(id,email_normalized,display_name,password_hash,updated_at) VALUES($1,'browser-qa@local.test','临时浏览验收',$2,now())",
  [viewerId, await argon2.hash('Disposable-UI-Fixture-2026')],
);
await sql(
  cfg.migrationUrl,
  "INSERT INTO workspace_members(workspace_id,user_id,role,status,joined_at) VALUES($1,$2,'viewer','active',now())",
  [c.workspaceId, viewerId],
);
await fs.writeFile(
  path.join(data, 'uat-viewer.json'),
  JSON.stringify({ viewerId, workspaceId: c.workspaceId }),
);
const report = {
  checks,
  namespace,
  sourceSha256: createHash('sha256').update(source).digest('hex'),
  durationMs: Date.now() - started,
  release: 'local-v3',
  signoff: '执行者技术验收，不代签真实用户业务验收',
};
await fs.writeFile(path.join(folder, 'uat-result.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
