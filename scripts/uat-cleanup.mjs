import assert from 'node:assert/strict';
import path from 'node:path';
import { data, profile, read, sql } from './native.mjs';
const cfg = await profile('stage'),
  v = await read(path.join(data, 'uat-viewer.json')),
  rows = await sql(cfg.databaseUrl, 'SELECT email_normalized FROM users WHERE id=$1', [v.viewerId]);
assert.equal(rows.rows[0]?.email_normalized, 'browser-qa@local.test');
const origin = cfg.origin,
  jar = {};
let csrf;
async function call(route, body) {
  const r = await fetch(origin + '/api/v1' + route, {
    method: body ? 'POST' : 'GET',
    headers: {
      origin,
      cookie: Object.entries(jar)
        .map(([k, v]) => k + '=' + v)
        .join('; '),
      'content-type': 'application/json',
      'idempotency-key': 'viewer-permission-check',
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  for (const h of r.headers.getSetCookie()) {
    const pair = h.split(';')[0],
      i = pair.indexOf('=');
    jar[pair.slice(0, i)] = pair.slice(i + 1);
  }
  const b = await r.json();
  if (b.data?.csrfToken) csrf = b.data.csrfToken;
  return r.status;
}
await call('/auth/csrf');
assert.equal(
  await call('/auth/login', {
    email: 'browser-qa@local.test',
    password: 'Disposable-UI-Fixture-2026',
  }),
  200,
);
assert.equal(await call('/workspaces/' + v.workspaceId + '/projects', { name: '只读拒绝' }), 403);
console.log('PASS Viewer真实写请求403');
await sql(cfg.migrationUrl, "UPDATE users SET status='disabled',updated_at=now() WHERE id=$1;", [
  v.viewerId,
]);
await sql(cfg.migrationUrl, 'UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [v.viewerId]);
await sql(
  cfg.migrationUrl,
  "UPDATE workspace_members SET status='removed',updated_at=now() WHERE user_id=$1",
  [v.viewerId],
);
assert.equal(await call('/auth/me'), 401);
console.log('PASS 临时Viewer已停用，成员移除，会话撤销，原会话401；仅保留验收审计');
