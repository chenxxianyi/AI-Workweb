import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  read,
  json,
  profilePath,
  profile,
  sql,
  verifyRelease,
  migrate,
  start,
  stop,
  smoke,
} from './native.mjs';
import { backup } from './backup.mjs';
export async function deploy(p, id, { rollback = false } = {}) {
  const cfg = await profile(p),
    { manifest } = await verifyRelease(id),
    runtime = path.dirname(profilePath(p)),
    state = await read(path.join(runtime, 'state.json')).catch(() => null),
    history = await read(path.join(runtime, 'release-history.json')).catch(() => []);
  const expected = new Set(
    manifest.files
      .filter((f) => /^migrations\/[^/]+\/migration.sql$/.test(f.path))
      .map((f) => f.path.split('/')[1]),
  );
  const applied = await sql(
    cfg.migrationUrl,
    'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
  ).catch((e) => {
    if (e.code === '42P01') return { rows: [] };
    throw e;
  });
  if (rollback && applied.rows.some((r) => !expected.has(r.migration_name)))
    throw Error('目标版本不声明当前数据库迁移，拒绝自动代码回退；先评估兼容性');
  const before = await backup(p),
    started = Date.now();
  if (!rollback) await migrate(p, id);
  await stop(p);
  try {
    await start(p, id);
    await smoke(p);
    const event = {
      at: new Date().toISOString(),
      from: state?.release ?? null,
      to: id,
      mode: rollback ? 'code-rollback' : 'deploy',
      backup: before.header.id,
      durationMs: Date.now() - started,
    };
    history.push(event);
    await json(path.join(runtime, 'release-history.json'), history);
    console.log(JSON.stringify(event));
    return event;
  } catch (error) {
    if (state) {
      await stop(p).catch(() => {});
      await start(p, state.release).catch(() => {});
    }
    throw error;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, p, id] = process.argv.slice(2);
  if (!['deploy', 'rollback'].includes(cmd))
    throw Error('用法: release.mjs deploy|rollback stage|production <版本>');
  await deploy(p, id, { rollback: cmd === 'rollback' }).catch((e) => {
    console.error(e.message.replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[已隐藏]'));
    process.exitCode = 1;
  });
}
