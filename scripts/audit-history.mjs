import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(root, '全栈开发任务/存档'),
  results = [];
let totalFiles = 0;
for (const cp of (await fs.readdir(base)).filter((n) => /^FS\d{3}$/.test(n)).sort()) {
  const versions = path.join(base, cp, '版本');
  for (const name of await fs.readdir(versions).catch(() => [])) {
    const dir = path.join(versions, name);
    try {
      await fs.access(path.join(dir, '生成失败.txt'));
      results.push({ checkpoint: cp, version: name, state: 'failed-version-preserved' });
      continue;
    } catch {
      /*成功manifest逐项核验*/
    }
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
    if (manifest.checkpoint !== cp) throw Error('历史存档点不符');
    for (const f of manifest.files) {
      const target = path.resolve(dir, f.path);
      if (!target.startsWith(dir + path.sep)) throw Error('历史manifest越界');
      const b = await fs.readFile(target);
      if (b.length !== f.bytes || createHash('sha256').update(b).digest('hex') !== f.sha256)
        throw Error('历史文件损坏 ' + cp + ' ' + name + ' ' + f.path);
      totalFiles++;
    }
    results.push({
      checkpoint: cp,
      version: name,
      state: 'manifest-integrity-passed',
      files: manifest.files.length,
    });
  }
}
const result = {
  versions: results.length,
  files: totalFiles,
  failedPreserved: results.filter((r) => r.state === 'failed-version-preserved').length,
  result: 'passed',
  scope: '所有历史版本机械完整性；历史失败/被替代业务结论不提升为验收通过',
  results,
};
const output = path.resolve(root, process.argv[2] ?? '.data/history-audit.json');
if (!output.startsWith(root + path.sep)) throw Error('输出越界');
await fs.writeFile(output, JSON.stringify(result, null, 2));
console.log(
  JSON.stringify({
    versions: result.versions,
    files: totalFiles,
    failedPreserved: result.failedPreserved,
    result: result.result,
  }),
);
