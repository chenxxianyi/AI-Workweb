import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { backup, restore, retention } from './backup.mjs';
import {
  root,
  data,
  profile,
  sql,
  localUrl,
  json,
  read,
  profilePath,
  verifyRelease,
} from './native.mjs';
let checks = 0;
const check = (v, n) => {
  assert.ok(v, n);
  console.log('PASS ' + ++checks + ' ' + n);
};
const m = await backup('stage'),
  target = 'aiwb_restore_' + Date.now() + '_test';
const result = await restore('stage', m.header.id, target);
check(result.validated, '真实pg_dump加密、pg_restore及全部表行指纹匹配');
check(result.durationMs < 7200000, '恢复RTO小于2小时');
check(Date.now() - new Date(m.header.createdAt).getTime() < 86400000, '恢复点RPO小于24小时');
const cfg = await profile('stage'),
  admin = localUrl(process.env.DATABASE_URL);
admin.pathname = '/' + target;
const rows = await sql(
  admin.href,
  'SELECT (SELECT count(*)::int FROM entry_revisions) revisions,(SELECT count(*)::int FROM entry_usage) usage,(SELECT count(*)::int FROM tasks) tasks,(SELECT count(*)::int FROM ledger_records) ledger',
);
check(
  rows.rows[0].revisions > 0 &&
    rows.rows[0].usage > 0 &&
    rows.rows[0].tasks > 0 &&
    rows.rows[0].ledger > 0,
  '修订/使用/任务/台账恢复非空',
);
const before = (await sql(cfg.databaseUrl, 'SELECT count(*)::text AS n FROM projects')).rows[0].n;
await assert.rejects(() =>
  restore('stage', m.header.id, 'aiwb_restore_wrongkey_test', { wrongKey: true }),
);
check(true, '错误密钥拒绝，未创建恢复库');
const master = new URL(admin);
master.pathname = '/postgres';
check(
  !(await sql(master.href, "SELECT 1 FROM pg_database WHERE datname='aiwb_restore_wrongkey_test'"))
    .rowCount,
  '失败解密未创建目标',
);
const corrupt = 'corrupt-' + Date.now(),
  base = path.join(data, 'backups/stage'),
  b = await fs.readFile(path.join(base, m.header.id + '.aes'));
b[0] ^= 1;
await fs.writeFile(path.join(base, corrupt + '.aes'), b);
await json(path.join(base, corrupt + '.json'), { ...m, header: { ...m.header, id: corrupt } });
await assert.rejects(() => restore('stage', corrupt, 'aiwb_restore_corrupt_test'));
check(true, '损坏备份校验失败，未执行恢复');
await assert.rejects(() => restore('stage', m.header.id, target));
check(true, '拒绝覆盖既有恢复库');
await assert.rejects(() => restore('stage', m.header.id, 'aiwb_production'));
check(true, '拒绝指向正式库');
check(
  (await sql(cfg.databaseUrl, 'SELECT count(*)::text AS n FROM projects')).rows[0].n === before,
  '源库数据未被恢复演练改写',
);
const policy = await retention('stage');
check(policy.keep.includes(m.header.id), '日/周/月保留最近恢复点');
// 在恢复库用受限应用角色运行真实API，核对账号和成员权限。
await sql(
  admin.href,
  `GRANT USAGE ON SCHEMA public TO "${cfg.runtimeRole}"; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO "${cfg.runtimeRole}"; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO "${cfg.runtimeRole}"`,
);
const restoredUrl = localUrl(cfg.databaseUrl);
restoredUrl.pathname = '/' + target;
const state = await read(path.join(data, 'runtime/stage/state.json')),
  { dir } = await verifyRelease(state.release),
  origin = 'http://127.0.0.1:3005';
try {
  await fetch(origin + '/api/v1/health/live', { signal: AbortSignal.timeout(500) });
  throw Error('恢复验收端口3005被占用');
} catch (e) {
  if (e.message === '恢复验收端口3005被占用') throw e;
}
const api = spawn(process.execPath, [path.join(dir, 'dist/main.js')], {
  cwd: path.dirname(profilePath('stage')),
  windowsHide: true,
  stdio: 'ignore',
  env: {
    ...process.env,
    NODE_ENV: 'production',
    DATABASE_URL: restoredUrl.href,
    API_PORT: '3005',
    API_HOST: '127.0.0.1',
    PUBLIC_ORIGIN: origin,
    SESSION_COOKIE_NAME: 'restore_session',
    CSRF_COOKIE_NAME: 'restore_csrf',
    TRANSFER_WORKER_ENABLED: 'false',
    MAINTENANCE_WORKER_ENABLED: 'false',
    LOG_LEVEL: 'error',
    WEB_DIST_DIR: path.join(dir, 'web'),
  },
});
try {
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(origin + '/api/v1/health/ready')).ok) {
        ready = true;
        break;
      }
    } catch {
      /*启动中*/
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  check(ready, '恢复库受限应用角色真实API就绪');
  const jar = {},
    creds = await fs.readFile(
      path.join(path.dirname(profilePath('stage')), 'credentials.txt'),
      'utf8',
    );
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
        ...(csrf ? { 'x-csrf-token': csrf } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    for (const h of r.headers.getSetCookie()) {
      const pair = h.split(';')[0],
        i = pair.indexOf('=');
      jar[pair.slice(0, i)] = pair.slice(i + 1);
    }
    const result = await r.json();
    if (!r.ok) throw Error('恢复API失败 ' + r.status);
    if (result.data?.csrfToken) csrf = result.data.csrfToken;
    return result.data;
  }
  await call('/auth/csrf');
  await call('/auth/login', {
    email: 'owner@local.aiwb',
    password: /初始密码：([^\r\n]+)/.exec(creds)[1],
  });
  const me = await call('/auth/me');
  check(me.memberships[0].role === 'owner', '恢复账号可登录且Owner权限保留');
  check(
    (await call('/workspaces/' + me.memberships[0].workspaceId + '/projects')).projects.length > 0,
    '恢复业务可经真实API读取',
  );
} finally {
  api.kill();
}
const output = {
  checks,
  backup: m.header.id,
  target,
  rtoMs: result.durationMs,
  rpoMs: Date.now() - new Date(m.header.createdAt).getTime(),
  tables: result.tables,
  rows: rows.rows[0],
};
await fs.writeFile(
  path.join(root, '全栈开发任务/验收证据/FS046/restore-result.json'),
  JSON.stringify(output, null, 2),
);
console.log(JSON.stringify(output));
