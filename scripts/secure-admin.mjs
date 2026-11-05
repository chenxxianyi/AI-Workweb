import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { root, data, localUrl, run } from './native.mjs';
const original = localUrl(process.env.DATABASE_URL),
  role = decodeURIComponent(original.username);
if (!/^[a-z][a-z0-9_]*$/.test(role)) throw Error('管理角色名称非法');
const require = createRequire(path.join(root, 'apps/api/package.json')),
  { Client } = require('pg'),
  c = new Client({ connectionString: original.href });
await c.connect();
try {
  const file = path.join(root, '.env'),
    source = await fs.readFile(file, 'utf8'),
    password = randomBytes(32).toString('hex'),
    next = source.replace(/^(DATABASE_URL(?:_TEST)?)=(.*)$/gm, (line, key, value) => {
      const quoted = value.trim().startsWith('"'),
        raw = value.trim().replace(/^['"]|['"]$/g, '');
      try {
        const u = new URL(raw);
        if (
          u.hostname === original.hostname &&
          u.port === original.port &&
          u.username === original.username
        ) {
          u.password = password;
          return key + '=' + (quoted ? '"' + u.href + '"' : u.href);
        }
      } catch {
        /*其他配置不动*/
      }
      return line;
    });
  const temp = path.join(data, 'runtime/production/admin-env-next.tmp');
  await fs.writeFile(temp, next, { flag: 'wx' });
  await c.query(`ALTER ROLE "${role}" PASSWORD '${password}'`);
  try {
    await fs.rename(temp, file);
  } catch (e) {
    await c.query(
      `ALTER ROLE "${role}" PASSWORD '${decodeURIComponent(original.password).replaceAll("'", "''")}'`,
    );
    await fs.rm(temp, { force: true });
    throw e;
  }
  run('icacls', [
    file,
    '/inheritance:r',
    '/grant:r',
    process.env.USERDOMAIN + '\\' + process.env.USERNAME + ':F',
    'SYSTEM:F',
  ]);
  const changed = new URL(original);
  changed.password = password;
  const verify = new Client({ connectionString: changed.href });
  await verify.connect();
  const hba = await verify.query(
    "SELECT type,auth_method FROM pg_hba_file_rules WHERE error IS NULL AND type LIKE 'host%' AND address='127.0.0.1'",
  );
  await verify.end();
  const rejected = new Client({ connectionString: original.href });
  let oldRejected = false;
  try {
    await rejected.connect();
  } catch {
    oldRejected = true;
  } finally {
    await rejected.end().catch(() => {});
  }
  if (!oldRejected) throw Error('旧口令仍可登录，检查pg_hba认证');
  if (hba.rows.some((r) => r.auth_method === 'trust')) throw Error('回环host规则存在trust，需修复');
  console.log(
    JSON.stringify({
      rotated: true,
      oldPasswordRejected: true,
      newPasswordWorks: true,
      envAclRestricted: true,
      hba: hba.rows,
      credentials: '仅保存在受限.env；stage/production独立应用角色不受影响',
    }),
  );
} finally {
  await c.end();
}
