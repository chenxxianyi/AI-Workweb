import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { root, data, run, pnpm, sql, localUrl, verifyRelease, packageRelease } from './native.mjs';
const evidence = path.resolve(root, process.argv[2] ?? '全栈开发任务/验收证据/FS044');
if (!evidence.startsWith(root + path.sep)) throw Error('证据目录超出工作区');
await fs.mkdir(evidence, { recursive: true });
const candidate = path.join(data, 'candidate.json'),
  steps = [];
await fs.rm(candidate, { force: true });
async function gate(name, fn) {
  const started = Date.now();
  try {
    const output = await fn();
    await fs.writeFile(
      path.join(evidence, name + '.log'),
      typeof output === 'string' ? output : JSON.stringify(output, null, 2),
    );
    steps.push({ name, exitCode: 0, ms: Date.now() - started });
    console.log(name + '通过');
  } catch (e) {
    await fs.writeFile(path.join(evidence, name + '.log'), e.message);
    steps.push({ name, exitCode: 1 });
    throw e;
  }
}
try {
  await gate('toolchain', () => {
    if (!/^v22\./.test(process.version)) throw Error('要求Node22');
    if (process.argv.includes('--probe-failure')) throw Error('故意失败门禁：发布候选不得生成');
    return { node: process.version, pnpm: pnpm(['--version']).trim() };
  });
  const migrations = path.join(root, 'database/prisma/migrations'),
    names = (await fs.readdir(migrations, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort(),
    hashes = {};
  for (const name of names)
    hashes[name] = createHash('sha256')
      .update(await fs.readFile(path.join(migrations, name, 'migration.sql')))
      .digest('hex');
  await gate('migration-immutability', async () => {
    const base = JSON.parse(
      await fs.readFile(path.join(root, 'database/migration-baseline.json'), 'utf8'),
    );
    for (const [name, hash] of Object.entries(base))
      if (hashes[name] !== hash) throw Error('历史迁移改变：' + name);
    return hashes;
  });
  await gate('verify', () => {
    const env={...process.env};delete env.NODE_ENV;
    return pnpm(['verify'], env);
  });
  const admin = localUrl(process.env.DATABASE_URL);
  admin.pathname = '/postgres';
  const db = 'aiwb_ci_' + Date.now() + '_test',
    url = new URL(admin);
  url.pathname = '/' + db;
  await gate('migration-empty-upgrade', async () => {
    await sql(admin.href, `CREATE DATABASE "${db}"`);
    const dir = path.join(data, 'ci', db),
      partial = path.join(dir, 'migrations');
    await fs.mkdir(partial, { recursive: true });
    for (const name of names.slice(0, -1))
      await fs.cp(path.join(migrations, name), path.join(partial, name), { recursive: true });
    await fs.copyFile(
      path.join(migrations, 'migration_lock.toml'),
      path.join(partial, 'migration_lock.toml'),
    );
    const config = path.join(dir, 'prisma.config.ts');
    await fs.writeFile(
      config,
      `import {defineConfig} from 'prisma/config'; export default defineConfig({schema:${JSON.stringify(path.join(root, 'database/prisma/schema.prisma'))},migrations:{path:${JSON.stringify(partial)}},datasource:{url:process.env.DATABASE_URL}});`,
    );
    const env = { ...process.env, DATABASE_URL: url.href, DATABASE_URL_TEST: url.href };
    run(
      process.execPath,
      [
        path.join(root, 'node_modules/prisma/build/index.js'),
        'migrate',
        'deploy',
        '--config',
        config,
      ],
      { env },
    );
    await sql(
      url.href,
      `CREATE TABLE ci_upgrade_probe(id integer PRIMARY KEY, value text NOT NULL); INSERT INTO ci_upgrade_probe VALUES(1,'升级保留数据');`,
    );
    await fs.cp(path.join(migrations, names.at(-1)), path.join(partial, names.at(-1)), {
      recursive: true,
    });
    run(
      process.execPath,
      [
        path.join(root, 'node_modules/prisma/build/index.js'),
        'migrate',
        'deploy',
        '--config',
        config,
      ],
      { env },
    );
    const probe = await sql(url.href, 'SELECT value FROM ci_upgrade_probe WHERE id=1');
    if (probe.rows[0]?.value !== '升级保留数据') throw Error('升级丢失已有记录');
    await sql(url.href, 'DROP TABLE ci_upgrade_probe');
    return {
      database: db,
      emptyBaseline: names.length - 1,
      upgraded: names.length,
      nonemptyProbe: 'retained',
    };
  });
  await gate('integration', () =>
    run(
      process.execPath,
      [
        path.join(root, 'scripts/integration.mjs'),
        path.relative(root, path.join(evidence, 'integration')),
      ],
      { env: { ...process.env, DATABASE_URL_TEST: url.href, DATABASE_URL: url.href } },
    ),
  );
  await gate('secrets', () =>
    run(process.execPath, [path.join(root, 'scripts/security-scan.mjs')]),
  );
  await gate('audit', () => {
    const out = pnpm(['audit', '--prod', '--json']);
    const a = JSON.parse(out);
    if ((a.metadata?.vulnerabilities?.critical ?? 0) + (a.metadata?.vulnerabilities?.high ?? 0) > 0)
      throw Error('高危依赖门禁');
    return out;
  });
  const release =
    process.argv.find((x) => x.startsWith('--release='))?.slice(10) ?? 'local-' + Date.now();
  await gate('artifact', async () => {
    await packageRelease(release);
    const { manifest } = await verifyRelease(release);
    pnpm([
      'install',
      '--frozen-lockfile',
      '--prod=false',
      '--store-dir',
      process.env.PNPM_STORE_DIR ?? 'D:\\.pnpm-store',
    ]);
    return { id: manifest.id, files: manifest.files.length, lockHash: manifest.lockHash };
  });
  await fs.writeFile(
    candidate,
    JSON.stringify(
      { release, createdAt: new Date().toISOString(), steps, migrations: hashes },
      null,
      2,
    ),
  );
  console.log('全部门禁通过，候选已生成');
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await fs.writeFile(
    path.join(evidence, 'pipeline.json'),
    JSON.stringify({ passed: process.exitCode !== 1, steps }, null, 2),
  );
}
