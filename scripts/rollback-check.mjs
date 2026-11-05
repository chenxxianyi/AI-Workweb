import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { data, profile, sql, read, verifyRelease } from './native.mjs';
import { deploy } from './release.mjs';
import { client } from './native-client.mjs';
let checks = 0;
const check = (v, n) => {
  assert.ok(v, n);
  console.log('PASS ' + ++checks + ' ' + n);
};
const cfg = await profile('stage'),
  before = await sql(cfg.databaseUrl, 'SELECT count(*)::text n FROM projects');
await sql(
  cfg.migrationUrl,
  "CREATE TABLE IF NOT EXISTS aiwb_release_compat_probe(id integer PRIMARY KEY,value text); INSERT INTO aiwb_release_compat_probe VALUES(1,'回退保留') ON CONFLICT(id) DO UPDATE SET value=EXCLUDED.value",
);
const forward = await deploy('stage', 'local-v3');
check(forward.to === 'local-v3', '新版本与冻结迁移部署');
let c = await client('stage');
const created = (
  await c.call('/workspaces/' + c.workspaceId + '/projects', {
    method: 'POST',
    body: { name: '回退窗口新增项目-' + Date.now() },
  })
).data;
check(!!created.id, '升级后真实业务新增');
const back = await deploy('stage', 'local-v1f', { rollback: true });
check(back.to === 'local-v1f', '旧前端/API/worker代码回退');
c = await client('stage');
check(
  (await c.call('/workspaces/' + c.workspaceId + '/projects/' + created.id)).data.id === created.id,
  '代码回退保留升级窗口新增数据',
);
check(
  (await sql(cfg.migrationUrl, 'SELECT value FROM aiwb_release_compat_probe WHERE id=1')).rows[0]
    .value === '回退保留',
  '旧API运行于附加表的兼容schema',
);
await deploy('stage', 'local-v3');
check(
  (await sql(cfg.databaseUrl, 'SELECT count(*)::int n FROM projects')).rows[0].n ===
    Number(before.rows[0].n) + 1,
  '再次升级业务数量准确',
);
await sql(cfg.migrationUrl, 'DROP TABLE aiwb_release_compat_probe');
await assert.rejects(() => deploy('stage', 'missing-release', { rollback: true }));
check(
  (await read(path.join(data, 'runtime/stage/state.json'))).release === 'local-v3',
  '无效版本在停止服务前被拒绝',
);
const { manifest } = await verifyRelease('local-v3');
check(
  manifest.files.some((f) => f.path === 'sbom.cdx.json'),
  '版本/迁移/依赖清单可追溯',
);
await fs.writeFile(
  path.join(data, 'rollback-result.json'),
  JSON.stringify({ checks, forward, back, preservedProjectId: created.id }, null, 2),
);
console.log(JSON.stringify({ checks, result: 'passed' }));
