import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import {
  root,
  data,
  safe,
  read,
  json,
  run,
  profile,
  profilePath,
  localUrl,
  sql,
} from './native.mjs';
const require = createRequire(path.join(root, 'apps/api/package.json')),
  { Client } = require('pg');
const pgBin = process.env.PG_BIN ?? 'E:/tools/PostgreSQL/17/bin';
const keyPath = (p) => safe(path.join(data, 'backup-keys', p + '.key'));
const backupDir = (p) => safe(path.join(data, 'backups', p));
const backupPath = (p, id) => {
  profilePath(p);
  if (!/^[a-z0-9_-]+$/.test(id)) throw Error('备份ID非法');
  return safe(path.join(backupDir(p), id));
};
async function protect(dir) {
  await fs.mkdir(dir, { recursive: true });
  run('icacls', [
    dir,
    '/inheritance:r',
    '/grant:r',
    process.env.USERDOMAIN + '\\' + process.env.USERNAME + ':(OI)(CI)F',
    'SYSTEM:(OI)(CI)F',
  ]);
}
async function key(p) {
  const file = keyPath(p);
  try {
    return await fs.readFile(file);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    await protect(path.dirname(file));
    const b = randomBytes(32);
    await fs.writeFile(file, b, { flag: 'wx' });
    return b;
  }
}
function connection(url) {
  const u = localUrl(url);
  return {
    args: [
      '-h',
      u.hostname,
      '-p',
      u.port || '5432',
      '-U',
      decodeURIComponent(u.username),
      '-d',
      u.pathname.slice(1),
      '-w',
    ],
    env: { ...process.env, PGPASSWORD: decodeURIComponent(u.password) },
  };
}
function command(name, args, env) {
  const child = spawn(path.join(pgBin, name + '.exe'), args, {
    env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let errors = '';
  child.stderr.on('data', (b) => {
    errors = (errors + b).slice(-2000);
  });
  const done = new Promise((res, rej) => {
    child.once('error', rej);
    child.once('close', (code) =>
      code === 0 ? res() : rej(Error(name + '失败 ' + code + ' ' + errors)),
    );
  });
  done.catch(() => {});
  return { child, done };
}
async function hash(file) {
  const h = createHash('sha256');
  for await (const b of createReadStream(file)) h.update(b);
  return h.digest('hex');
}
export async function fingerprints(c) {
  const tables = (
      await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
    ).rows,
    out = {};
  for (const { tablename: t } of tables) {
    if (!/^[a-zA-Z0-9_]+$/.test(t)) throw Error('表名非法');
    const result = await c.query(
      `SELECT count(*)::text AS count,coalesce(sum(('x'||substr(md5(row_to_json(t)::text),1,15))::bit(60)::bigint),0)::text AS fingerprint FROM public."${t}" t`,
    );
    out[t] = result.rows[0];
  }
  return out;
}
export async function backup(p) {
  const cfg = await profile(p),
    id = Date.now() + '-' + randomBytes(4).toString('hex'),
    dest = backupPath(p, id);
  await protect(backupDir(p));
  const secret = await key(p);
  const c = new Client({ connectionString: cfg.migrationUrl });
  await c.connect();
  const started = Date.now();
  let dumper;
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot = (await c.query('SELECT pg_export_snapshot() AS id')).rows[0].id,
      rows = await fingerprints(c),
      version = (await c.query('SHOW server_version')).rows[0].server_version,
      state = await read(path.join(path.dirname(profilePath(p)), 'state.json')).catch(() => null);
    const header = {
      id,
      profile: p,
      database: cfg.database,
      createdAt: new Date().toISOString(),
      release: state?.release ?? null,
      postgres: version,
      rows,
    };
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', secret, iv);
    cipher.setAAD(Buffer.from(JSON.stringify(header)));
    const conn = connection(cfg.migrationUrl);
    dumper = command(
      'pg_dump',
      [...conn.args, '-Fc', '--no-owner', '--no-acl', '--snapshot=' + snapshot],
      conn.env,
    );
    dumper.child.stdin.end();
    await pipeline(
      dumper.child.stdout,
      cipher,
      createWriteStream(dest + '.partial', { flags: 'wx' }),
    );
    await dumper.done;
    await c.query('COMMIT');
    const file = dest + '.aes';
    await fs.rename(dest + '.partial', file);
    const m = {
      header,
      algorithm: 'AES-256-GCM',
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      sha256: await hash(file),
      bytes: (await fs.stat(file)).size,
      durationMs: Date.now() - started,
    };
    await json(dest + '.json', m);
    await json(path.join(path.dirname(profilePath(p)), 'backup-status.json'), {
      state: 'ok',
      id,
      createdAt: header.createdAt,
      bytes: m.bytes,
      durationMs: m.durationMs,
      description: '本机加密数据库备份完成；最近 ' + header.createdAt,
    });
    console.log(
      JSON.stringify({
        backup: id,
        profile: p,
        bytes: m.bytes,
        durationMs: m.durationMs,
        tables: Object.keys(rows).length,
      }),
    );
    return m;
  } catch (e) {
    dumper?.child.kill();
    await c.query('ROLLBACK').catch(() => {});
    await fs.rm(dest + '.partial', { force: true });
    await json(path.join(path.dirname(profilePath(p)), 'backup-status.json'), {
      state: 'failed',
      description: '最近数据库备份失败，请查看本机运维日志。',
      at: new Date().toISOString(),
    });
    throw e;
  } finally {
    await c.end();
  }
}
export async function restore(p, id, target, { wrongKey = false } = {}) {
  if (!/^aiwb_restore_[a-z0-9_]+_test$/.test(target))
    throw Error('恢复仅允许新建aiwb_restore_*_test隔离库');
  const base = backupPath(p, id),
    m = await read(base + '.json');
  if (m.header.id !== id || m.header.profile !== p || m.algorithm !== 'AES-256-GCM')
    throw Error('备份元数据不匹配');
  if ((await fs.stat(base + '.aes')).size !== m.bytes || (await hash(base + '.aes')) !== m.sha256)
    throw Error('备份大小/校验和不匹配');
  const start = Date.now(),
    temp = safe(
      path.join(
        path.dirname(profilePath(p)),
        'restore-' + randomBytes(8).toString('hex') + '.partial',
      ),
    );
  const decipher = createDecipheriv(
    'aes-256-gcm',
    wrongKey ? randomBytes(32) : await key(p),
    Buffer.from(m.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(m.tag, 'base64'));
  decipher.setAAD(Buffer.from(JSON.stringify(m.header)));
  try {
    await pipeline(
      createReadStream(base + '.aes'),
      decipher,
      createWriteStream(temp, { flags: 'wx' }),
    );
    // 完整GCM验证结束后才允许创建目标库；绝不覆盖既有库。
    const admin = localUrl(process.env.DATABASE_URL);
    admin.pathname = '/postgres';
    if ((await sql(admin.href, 'SELECT 1 FROM pg_database WHERE datname=$1', [target])).rowCount)
      throw Error('恢复目标已存在，拒绝覆盖');
    const cfg = await profile(p),
      owner = decodeURIComponent(localUrl(cfg.migrationUrl).username);
    if (!/^aiwb_[a-z0-9_]+$/.test(owner)) throw Error('迁移角色非法');
    await sql(admin.href, `CREATE DATABASE "${target}" OWNER "${owner}"`);
    const u = localUrl(cfg.migrationUrl);
    u.pathname = '/' + target;
    const conn = connection(u.href),
      restore = command(
        'pg_restore',
        [...conn.args, '--no-owner', '--no-acl', '--exit-on-error'],
        conn.env,
      );
    await pipeline(createReadStream(temp), restore.child.stdin);
    await restore.done;
    const c = new Client({ connectionString: u.href });
    await c.connect();
    try {
      const restored = await fingerprints(c);
      if (JSON.stringify(restored) !== JSON.stringify(m.header.rows))
        throw Error('恢复表计数/行指纹不匹配');
    } finally {
      await c.end();
    }
    const result = {
      restored: target,
      backup: id,
      tables: Object.keys(m.header.rows).length,
      durationMs: Date.now() - start,
      recoveryPoint: m.header.createdAt,
      validated: true,
    };
    console.log(JSON.stringify(result));
    return result;
  } finally {
    await fs.rm(temp, { force: true });
  }
}
export async function retention(p, { apply = false } = {}) {
  const dir = backupDir(p),
    list = [],
    invalid = [];
  for (const name of await fs.readdir(dir).catch(() => []))
    if (/^[a-z0-9_-]+\.json$/.test(name)) {
      try {
        const m = await read(path.join(dir, name)),
          base = backupPath(p, m.header.id);
        if (
          name !== m.header.id + '.json' ||
          m.header.profile !== p ||
          !Number.isFinite(Date.parse(m.header.createdAt)) ||
          (await hash(base + '.aes')) !== m.sha256
        )
          throw Error('无效备份');
        list.push({ id: m.header.id, date: m.header.createdAt });
      } catch {
        invalid.push(name);
      }
    }
  list.sort((a, b) => b.date.localeCompare(a.date));
  const keep = new Set(),
    day = new Set(),
    week = new Set(),
    month = new Set();
  for (const v of list) {
    const time = new Date(v.date),
      d = v.date.slice(0, 10),
      w = Math.floor(time.getTime() / 604800000),
      mo = v.date.slice(0, 7);
    if (!day.has(d) && day.size < 14) {
      keep.add(v.id);
      day.add(d);
    }
    if (!week.has(w) && week.size < 8) {
      keep.add(v.id);
      week.add(w);
    }
    if (!month.has(mo) && month.size < 12) {
      keep.add(v.id);
      month.add(mo);
    }
  }
  const history = await read(path.join(path.dirname(profilePath(p)), 'release-history.json')).catch(
    () => [],
  );
  const pins = await read(path.join(path.dirname(profilePath(p)), 'retention-pins.json')).catch(
    () => [],
  );
  for (const id of [...history.slice(-10).map((event) => event.backup), ...pins])
    if (list.some((v) => v.id === id)) keep.add(id);
  const remove = list.filter((v) => !keep.has(v.id));
  if (apply)
    for (const v of remove) {
      const base = backupPath(p, v.id);
      await fs.rm(base + '.aes');
      await fs.rm(base + '.json');
    }
  const result = {
    policy: '14 daily / 8 weekly / 12 monthly',
    keep: [...keep],
    remove: remove.map((x) => x.id),
    applied: apply,
    invalid,
  };
  console.log(JSON.stringify(result));
  return result;
}
async function cli() {
  const [cmd, p, id, target] = process.argv.slice(2);
  if (cmd === 'create') await backup(p);
  else if (cmd === 'restore') await restore(p, id, target);
  else if (cmd === 'retention') await retention(p, { apply: process.argv.includes('--apply') });
  else
    throw Error(
      '用法: backup.mjs create <stage|production> | restore <环境> <备份ID> <aiwb_restore_*_test> | retention <环境> [--apply]',
    );
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await cli().catch((e) => {
    console.error(e.message.replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[已隐藏]'));
    process.exitCode = 1;
  });
