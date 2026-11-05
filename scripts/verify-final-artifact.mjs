import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { data, profile, profilePath, verifyRelease, read, localUrl } from './native.mjs';
const id = process.argv[2] ?? 'local-final-v5',
  { dir, manifest } = await verifyRelease(id),
  secrets = [];
for (const p of ['stage', 'production']) {
  const cfg = await profile(p);
  secrets.push(
    Buffer.from(decodeURIComponent(localUrl(cfg.databaseUrl).password)),
    Buffer.from(decodeURIComponent(localUrl(cfg.migrationUrl).password)),
  );
  const credential = await fs.readFile(
    path.join(path.dirname(profilePath(p)), 'credentials.txt'),
    'utf8',
  );
  secrets.push(Buffer.from(/初始密码：([^\r\n]+)/.exec(credential)[1]));
  secrets.push(await fs.readFile(path.join(data, 'backup-keys', p + '.key')));
}
secrets.push(Buffer.from(decodeURIComponent(localUrl(process.env.DATABASE_URL).password)));
let count = 0;
for (const file of manifest.files) {
  if (file.link) continue;
  const body = await fs.readFile(path.join(dir, file.path));
  for (const secret of secrets)
    if (secret.length >= 20 && body.includes(secret))
      throw Error('运行包含实际私密值：' + file.path);
  count++;
}
const stage = await read(path.join(data, 'runtime/stage/state.json')),
  production = await read(path.join(data, 'runtime/production/state.json'));
if (stage.release !== id || production.release !== id) throw Error('部署版本不一致');
const result = {
  release: id,
  manifestSha256: createHash('sha256')
    .update(await fs.readFile(path.join(dir, 'release.json')))
    .digest('hex'),
  files: manifest.files.length,
  contentScanned: count,
  realSecretMatches: 0,
  stageAndProductionSame: true,
  sha256: 'verified',
  scope: '核对实际应用/迁移/Owner/管理口令和备份密钥；只输出统计，不输出任何值',
};
console.log(JSON.stringify(result));
