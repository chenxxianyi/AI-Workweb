import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { config as dotenv } from 'dotenv';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const data = path.join(root, '.data');
const require = createRequire(path.join(root, 'apps/api/package.json'));
const { Client } = require('pg');
dotenv({ path: path.join(root, '.env'), quiet: true });
export function safe(p) {
  const value = path.resolve(p);
  if (!value.startsWith(data + path.sep)) throw Error('运行路径必须位于本项目.data');
  return value;
}
export async function read(p) {
  return JSON.parse(await fs.readFile(p, 'utf8'));
}
export async function json(p, v) {
  await fs.mkdir(path.dirname(safe(p)), { recursive: true });
  await fs.writeFile(p, JSON.stringify(v, null, 2), 'utf8');
}
export function run(exe, args, options = {}) {
  const r = spawnSync(exe, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (r.status !== 0)
    throw Error(`${path.basename(exe)}失败(${r.status})：${r.stderr || r.stdout || r.error?.code}`);
  return r.stdout;
}
export function pnpm(args, env = process.env) {
  const command = run('pwsh', ['-NoProfile', '-Command', '(Get-Command pnpm).Source']).trim();
  return command.endsWith('.ps1')
    ? run('pwsh', ['-NoProfile', '-File', command, ...args], { env })
    : run(command, args, { env });
}
export function localUrl(value) {
  const u = new URL(value);
  if (!['localhost', '127.0.0.1'].includes(u.hostname)) throw Error('只支持本机数据库');
  return u;
}
export async function sql(url, text, values = []) {
  localUrl(url);
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await c.query(text, values);
  } finally {
    await c.end();
  }
}
const ident = (s) => {
  if (!/^aiwb_[a-z0-9_]+$/.test(s)) throw Error('数据库/角色名称非法');
  return '"' + s + '"';
};
export const profiles = ['stage', 'production'];
export const profilePath = (p) => {
  if (!profiles.includes(p)) throw Error('仅支持stage/production');
  return path.join(data, 'runtime', p, 'config.json');
};
export async function profile(p) {
  return read(profilePath(p));
}
export async function seal(dir) {
  const files = [];
  async function walk(d) {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) {
        const target = await fs.realpath(p);
        if (!target.startsWith(dir + path.sep)) throw Error('运行包不允许外部链接');
        files.push({ path: path.relative(dir, p), link: path.relative(dir, target) });
      } else if (e.isDirectory()) await walk(p);
      else if (p !== path.join(dir, 'release.json')) {
        const b = await fs.readFile(p);
        files.push({
          path: path.relative(dir, p).replaceAll('\\', '/'),
          bytes: b.length,
          sha256: createHash('sha256').update(b).digest('hex'),
        });
      }
    }
  }
  await walk(dir);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
export async function verifyRelease(id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw Error('版本名称非法');
  const dir = safe(path.join(data, 'releases', id)),
    m = await read(path.join(dir, 'release.json'));
  const actual = await seal(dir);
  if (JSON.stringify(actual) !== JSON.stringify(m.files)) throw Error('运行包完整性核验失败');
  return { dir, manifest: m };
}
export async function packageRelease(id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw Error('版本名称非法');
  const dir = safe(path.join(data, 'releases', id));
  try {
    await fs.access(dir);
    throw Error('版本已存在，拒绝覆盖');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  await fs.mkdir(path.dirname(dir), { recursive: true });
  pnpm([
    '--filter',
    '@aiwb/api',
    'deploy',
    '--legacy',
    '--prod',
    '--ignore-scripts',
    '--store-dir',
    process.env.PNPM_STORE_DIR ?? 'D:\\.pnpm-store',
    dir,
  ]);
  await fs.cp(path.join(root, 'apps/web/dist'), path.join(dir, 'web'), {
    recursive: true,
    filter: (p) => !p.endsWith('.map'),
  });
  // legacy deploy生成的未使用工作区自引用；其余任何外部链接仍由seal拒绝。
  await fs.unlink(path.join(dir, 'node_modules/.pnpm/node_modules/@aiwb/api')).catch((e) => {
    if (e.code !== 'ENOENT') throw e;
  });
  await fs.cp(path.join(root, 'database/prisma/migrations'), path.join(dir, 'migrations'), {
    recursive: true,
  });
  await fs.copyFile(
    path.join(root, 'database/prisma/schema.prisma'),
    path.join(dir, 'schema.prisma'),
  );
  const inventory = [];
  for (const file of await seal(dir)) {
    if (
      !file.link &&
      file.path.endsWith('/package.json') &&
      file.path.startsWith('node_modules/')
    ) {
      try {
        const pkg = await read(path.join(dir, file.path));
        if (pkg.name && pkg.version)
          inventory.push({
            type: 'library',
            name: pkg.name,
            version: pkg.version,
            licenses: pkg.license ? [{ license: { name: String(pkg.license) } }] : [],
          });
      } catch {
        /*非包元数据*/
      }
    }
  }
  await json(path.join(dir, 'sbom.cdx.json'), {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    components: [...new Map(inventory.map((x) => [x.name + '@' + x.version, x])).values()],
  });
  const files = await seal(dir),
    manifest = {
      id,
      createdAt: new Date().toISOString(),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      lockHash: createHash('sha256')
        .update(await fs.readFile(path.join(root, 'pnpm-lock.yaml')))
        .digest('hex'),
      files,
    };
  await json(path.join(dir, 'release.json'), manifest);
  console.log(
    JSON.stringify({
      release: id,
      files: files.length,
      bytes: files.reduce((s, f) => s + (f.bytes ?? 0), 0),
      lockHash: manifest.lockHash,
    }),
  );
  return id;
}
export async function initialize(p) {
  const dest = profilePath(p);
  try {
    await fs.access(dest);
    console.log('配置已存在，未覆盖');
    return;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const admin = localUrl(process.env.DATABASE_URL);
  admin.pathname = '/postgres';
  const db = 'aiwb_' + p,
    owner = db + '_owner',
    runtime = db + '_app',
    ownerPass = randomBytes(32).toString('hex'),
    appPass = randomBytes(32).toString('hex');
  if ((await sql(admin.href, 'SELECT 1 FROM pg_database WHERE datname=$1', [db])).rowCount)
    throw Error('目标库已存在但配置缺失，拒绝接管');
  for (const [role, pass] of [
    [owner, ownerPass],
    [runtime, appPass],
  ])
    await sql(
      admin.href,
      `CREATE ROLE ${ident(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${pass}'`,
    );
  await sql(admin.href, `CREATE DATABASE ${ident(db)} OWNER ${ident(owner)}`);
  const url = (name, pass) => {
    const u = new URL(admin);
    u.pathname = '/' + db;
    u.username = name;
    u.password = pass;
    return u.href;
  };
  const cfg = {
    profile: p,
    port: p === 'production' ? 3000 : 3003,
    origin: 'http://127.0.0.1:' + (p === 'production' ? 3000 : 3003),
    databaseUrl: url(runtime, appPass),
    migrationUrl: url(owner, ownerPass),
    runtimeRole: runtime,
    database: db,
  };
  await json(dest, cfg);
  // Windows ACL: 当前用户与SYSTEM；本机管理员仍有系统级访问能力。
  const user = process.env.USERDOMAIN + '\\' + process.env.USERNAME;
  run('icacls', [
    path.dirname(dest),
    '/inheritance:r',
    '/grant:r',
    user + ':(OI)(CI)F',
    'SYSTEM:(OI)(CI)F',
  ]);
  console.log(
    JSON.stringify({ initialized: p, database: db, port: cfg.port, config: '受限ACL配置已保存' }),
  );
}
export async function migrate(p, id) {
  const c = await profile(p);
  let config = path.join(root, 'prisma7.config.ts');
  if (id) {
    const { dir } = await verifyRelease(id);
    config = path.join(path.dirname(profilePath(p)), 'migration.config.ts');
    await fs.writeFile(
      config,
      `import {defineConfig} from 'prisma/config'; export default defineConfig({schema:${JSON.stringify(path.join(dir, 'schema.prisma'))},migrations:{path:${JSON.stringify(path.join(dir, 'migrations'))}},datasource:{url:process.env.DATABASE_URL}});`,
    );
  }
  run(
    process.execPath,
    [
      path.join(root, 'node_modules/prisma/build/index.js'),
      'migrate',
      'deploy',
      '--config',
      config,
    ],
    { env: { ...process.env, DATABASE_URL: c.migrationUrl } },
  );
  const role = ident(c.runtimeRole);
  await sql(
    c.migrationUrl,
    `GRANT USAGE ON SCHEMA public TO ${role}; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO ${role}; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO ${role};`,
  );
  console.log('迁移完成；运行角色无建库/建角色/超级权限');
}
export async function bootstrap(p, id) {
  const c = await profile(p),
    { dir } = await verifyRelease(id),
    password = randomBytes(24).toString('base64url');
  const env = { ...process.env, DATABASE_URL: c.databaseUrl };
  const output = run(
    process.execPath,
    [
      path.join(dir, 'dist/cli/bootstrap-owner.js'),
      '--email',
      'owner@local.aiwb',
      '--name',
      '本机管理员',
      '--workspace',
      '我的工作台',
      '--timezone',
      'Asia/Shanghai',
      '--password-stdin',
    ],
    { env, input: password + '\n' },
  );
  if (output.includes('已创建 Owner'))
    await fs.writeFile(
      path.join(path.dirname(profilePath(p)), 'credentials.txt'),
      `地址：${c.origin}\n账号：owner@local.aiwb\n初始密码：${password}\n仅保存在受限ACL本机文件；请妥善保管。\n`,
    );
  console.log('Owner初始化完成（无默认密码；凭据只保存在受限文件）');
}
export async function start(p, id) {
  const c = await profile(p);
  await verifyRelease(id);
  const state = path.join(path.dirname(profilePath(p)), 'state.json');
  try {
    const previous = await read(state);
    process.kill(previous.pid, 0);
    throw Error('已有运行状态，请先stop');
  } catch (e) {
    if (!['ENOENT', 'ESRCH'].includes(e.code)) throw e;
  }
  await json(path.join(path.dirname(state), 'launch.json'), { release: id });
  run('pwsh', ['-NoProfile', '-File', path.join(root, 'scripts/native-run.ps1'), p], {
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(c.origin + '/api/v1/health/ready', {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) {
        console.log(JSON.stringify({ started: p, release: id, url: c.origin }));
        return;
      }
    } catch {
      /*启动中*/
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw Error('启动未就绪，检查runtime日志');
}
export async function stop(p) {
  const c = await profile(p),
    file = path.join(path.dirname(profilePath(p)), 'state.json');
  let s;
  try {
    s = await read(file);
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  // 核对PID启动时间与确切入口，拒绝误杀被复用的PID。
  const expected = safe(path.join(data, 'releases', s.release, 'dist/main.js'));
  run('pwsh', [
    '-NoProfile',
    '-File',
    path.join(root, 'scripts/native-stop.ps1'),
    String(s.pid),
    expected,
    s.started,
  ]);
  await fs.rm(file, { force: true });
  console.log('已停止 ' + c.profile);
}
export async function status(p) {
  const c = await profile(p);
  let status = 'down';
  try {
    const r = await fetch(c.origin + '/api/v1/health/ready', { signal: AbortSignal.timeout(2000) });
    if (r.ok) status = 'ready';
  } catch {
    /*离线*/
  }
  const s = await read(path.join(path.dirname(profilePath(p)), 'state.json')).catch(() => null);
  const result = { profile: p, url: c.origin, status, release: s?.release ?? null };
  console.log(JSON.stringify(result));
  return result;
}
export async function smoke(p) {
  const c = await profile(p),
    checks = [];
  for (const [route, expected] of [
    ['/', 200],
    ['/projects/any', 200],
    ['/api/v1/health/ready', 200],
    ['/api/v1/auth/me', 401],
    ['/.env', 404],
    ['/assets/missing.js', 404],
    ['/api/v1/missing', 404],
    ['/__acceptance', 404],
  ]) {
    const r = await fetch(c.origin + route);
    if (r.status !== expected) throw Error(route + ' ' + r.status + ' != ' + expected);
    checks.push({ route, status: r.status });
    if (
      route === '/' &&
      !r.headers.get('content-security-policy')?.includes("frame-ancestors 'none'")
    )
      throw Error('缺少CSP');
  }
  const role = await sql(
    c.databaseUrl,
    'SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user',
  );
  if (Object.values(role.rows[0]).some(Boolean)) throw Error('运行角色权限过大');
  console.log(JSON.stringify({ profile: p, checks, runtimeRoleRestricted: true }));
  return checks;
}
async function cli() {
  const [cmd, p, id] = process.argv.slice(2);
  switch (cmd) {
    case 'package':
      await packageRelease(p);
      break;
    case 'init':
      await initialize(p);
      break;
    case 'migrate':
      await migrate(p, id);
      break;
    case 'bootstrap':
      await bootstrap(p, id);
      break;
    case 'start':
      await start(p, id);
      break;
    case 'stop':
      await stop(p);
      break;
    case 'status':
      await status(p);
      break;
    case 'smoke':
      await smoke(p);
      break;
    case 'verify':
      console.log((await verifyRelease(p)).manifest.id + '完整性通过');
      break;
    default:
      throw Error(
        '用法: node scripts/native.mjs package <版本> | init/migrate/status/stop/smoke <stage|production> | bootstrap/start <环境> <版本> | verify <版本>',
      );
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await cli().catch((e) => {
    console.error(e.message.replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[数据库连接已隐藏]'));
    process.exitCode = 1;
  });
