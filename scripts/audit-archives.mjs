import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const taskRoot = path.join(root, '全栈开发任务'),
  progress = await fs.readFile(path.join(taskRoot, '任务进度.md'), 'utf8'),
  completed = progress
    .split(/\r?\n/)
    .filter((l) => /^\| F\d{2} \|/.test(l) && l.includes('| 已完成 |')),
  results = [];
let files = 0,
  bytes = 0;
for (const row of completed) {
  const id = row.split('|')[1].trim(),
    cp = 'FS' + id.slice(1).padStart(3, '0'),
    reference = /`([^`]+\/版本\/[^`]+)`/.exec(row)?.[1];
  if (!reference) throw Error(id + '没有完整版本引用');
  const version = path.resolve(root, reference),
    expected = path.join(taskRoot, '存档', cp, '版本') + path.sep;
  if (!version.startsWith(expected)) throw Error(id + '版本越界');
  const raw = await fs.readFile(path.join(version, 'manifest.json')),
    m = JSON.parse(raw),
    seen = new Set();
  if (m.checkpoint !== cp) throw Error('存档点不符');
  for (const f of m.files) {
    const target = path.resolve(version, f.path);
    if (!target.startsWith(version + path.sep) || seen.has(f.path)) throw Error('文件越界/重复');
    seen.add(f.path);
    const relative = f.path.replaceAll('\\', '/');
    if (
      /(?:^|\/)\.env(?:$|\.(?!example$))|(?:^|\/)(?:credentials\.txt|config\.json|backup-keys)(?:$|\/)|\.(?:key|pem|pfx|dump|backup)$/.test(
        relative,
      )
    )
      throw Error('敏感运行文件进入普通快照 ' + relative);
    const body = await fs.readFile(target);
    if (body.length !== f.bytes || createHash('sha256').update(body).digest('hex') !== f.sha256)
      throw Error('损坏 ' + id + ' ' + f.path);
    files++;
    bytes += body.length;
  }
  const attestation = await fs
    .readFile(path.join(version, 'verification.json'), 'utf8')
    .then(JSON.parse)
    .catch(() => null);
  if (
    attestation &&
    (attestation.result !== 'passed' ||
      attestation.manifestSha256 !== createHash('sha256').update(raw).digest('hex'))
  )
    throw Error('核验凭证不符');
  if (attestation) {
    const frozenProgress = await fs.readFile(
      path.join(version, 'files/全栈开发任务/任务进度.md'),
      'utf8',
    );
    const frozenReadme = await fs.readFile(path.join(version, 'files/README.md'), 'utf8');
    const frozenCompleted = frozenProgress
      .split(/\r?\n/)
      .filter((l) => /^\| F\d{2} \|/.test(l) && l.includes('| 已完成 |')).length;
    const ownRow = frozenProgress.split(/\r?\n/).find((l) => l.startsWith('| ' + id + ' |'));
    if (
      !ownRow?.includes('| 已完成 |') ||
      !ownRow.includes(reference) ||
      !frozenReadme.includes(frozenCompleted + '/52')
    )
      throw Error('快照内进度/README不同步 ' + id);
  }
  results.push({
    task: id,
    files: m.files.length,
    version: reference,
    manifestSha256: createHash('sha256').update(raw).digest('hex'),
    verified: true,
  });
}
const result = {
  completed: completed.length,
  files,
  bytes,
  checkedAt: new Date().toISOString(),
  result: 'passed',
  scope: '每个已完成任务进度指针的全部manifest文件；历史失败/被替代版本不自动提升',
  tasks: results,
};
const output = process.argv[2];
if (output) {
  const p = path.resolve(root, output);
  if (!p.startsWith(root + path.sep)) throw Error('输出越界');
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(result, null, 2));
}
console.log(JSON.stringify({ completed: result.completed, files, bytes, result: result.result }));
