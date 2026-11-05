import assert from 'node:assert/strict';
import path from 'node:path';
import { data, profile, read, sql } from './native.mjs';
const cfg = await profile('stage'),
  fixture = await read(path.join(data, 'uat-viewer.json'));
assert.equal(cfg.database, 'aiwb_stage');
assert.equal(
  (await sql(cfg.databaseUrl, 'SELECT email_normalized FROM users WHERE id=$1', [fixture.viewerId]))
    .rows[0]?.email_normalized,
  'browser-qa@local.test',
);
if (process.argv[2] === 'enable-editor') {
  await sql(cfg.migrationUrl, "UPDATE users SET status='active',updated_at=now() WHERE id=$1", [
    fixture.viewerId,
  ]);
  await sql(
    cfg.migrationUrl,
    "UPDATE workspace_members SET status='active',role='editor',updated_at=now() WHERE user_id=$1 AND workspace_id=$2",
    [fixture.viewerId, fixture.workspaceId],
  );
  console.log('仅stage合成账号临时Editor已启用');
} else if (process.argv[2] === 'disable') {
  await sql(cfg.migrationUrl, "UPDATE users SET status='disabled',updated_at=now() WHERE id=$1", [
    fixture.viewerId,
  ]);
  await sql(
    cfg.migrationUrl,
    "UPDATE workspace_members SET status='removed',updated_at=now() WHERE user_id=$1",
    [fixture.viewerId],
  );
  await sql(cfg.migrationUrl, 'UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [
    fixture.viewerId,
  ]);
  console.log('stage临时账号已停用、成员移除、会话撤销');
} else throw Error('enable-editor | disable');
