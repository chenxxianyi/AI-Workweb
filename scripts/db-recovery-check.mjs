import assert from 'node:assert/strict';
import path from 'node:path';
import {
  profile,
  profilePath,
  localUrl,
  sql,
  json,
  read,
  data,
  stop,
  start,
  smoke,
} from './native.mjs';
import { backup, restore } from './backup.mjs';
import { client } from './native-client.mjs';
// 仅在stage彩排：停写、保留当前副本、恢复到新库、切换再切回，绝不覆盖源库。
const p = 'stage',
  cfg = await profile(p),
  state = await read(path.join(data, 'runtime', p, 'state.json')),
  point = await backup(p),
  target = 'aiwb_restore_switch_' + Date.now() + '_test';
const session = await client(p),
  newProject = (
    await session.call('/workspaces/' + session.workspaceId + '/projects', {
      method: 'POST',
      body: { name: '恢复点之后新增-' + Date.now() },
    })
  ).data;
await stop(p);
let switched = false;
try {
  const current = await backup(p);
  await json(path.join(path.dirname(profilePath(p)), 'recovery-original-config.json'), cfg);
  await restore(p, point.header.id, target);
  const admin = localUrl(process.env.DATABASE_URL);
  admin.pathname = '/' + target;
  await sql(
    admin.href,
    `GRANT USAGE ON SCHEMA public TO "${cfg.runtimeRole}"; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO "${cfg.runtimeRole}"; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO "${cfg.runtimeRole}"; UPDATE sessions SET revoked_at=now() WHERE revoked_at IS NULL; UPDATE transfer_jobs SET state='expired',lease_until=NULL WHERE state NOT IN ('cancelled','failed','expired');`,
  );
  const runtime = localUrl(cfg.databaseUrl),
    migration = localUrl(cfg.migrationUrl);
  runtime.pathname = '/' + target;
  migration.pathname = '/' + target;
  await json(profilePath(p), {
    ...cfg,
    database: target,
    databaseUrl: runtime.href,
    migrationUrl: migration.href,
  });
  switched = true;
  await start(p, state.release);
  await smoke(p);
  const recovered = await client(p);
  await recovered.call('/workspaces/' + recovered.workspaceId + '/projects/' + newProject.id, {
    expected: 404,
  });
  assert.equal(
    (
      await sql(cfg.databaseUrl, 'SELECT count(*)::int n FROM projects WHERE id=$1', [
        newProject.id,
      ])
    ).rows[0].n,
    1,
  );
  console.log(
    JSON.stringify({
      result: 'passed',
      restoredDatabase: target,
      recoveryBackup: point.header.id,
      currentBackup: current.header.id,
      lateProjectPreservedInOriginal: true,
      oldSessionsRevoked: true,
      oldTransferFilesExpired: true,
      lossWindow: '恢复点之后新增不在恢复库；已保留原库与当前完整备份，需业务导出核对后合并',
    }),
  );
} finally {
  if (switched) await stop(p);
  await json(profilePath(p), cfg);
  await start(p, state.release);
}
const c = await client(p);
assert.equal(
  (await c.call('/workspaces/' + c.workspaceId + '/projects/' + newProject.id)).data.id,
  newProject.id,
);
console.log('PASS 已切回原库，恢复点之后新增记录仍可读，未丢失源数据');
