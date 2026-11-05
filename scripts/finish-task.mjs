import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const specPath = path.resolve(root, process.argv[2] ?? '');
if (!specPath.startsWith(root + path.sep)) throw new Error('Stage spec must be inside workspace');
const spec = JSON.parse(await fs.readFile(specPath, 'utf8'));
if (!/^F[0-5][0-9]$/.test(spec.task)) throw new Error('Invalid task');
const n = Number(spec.task.slice(1));
if ((n < 22 && !([17, 18].includes(n) && spec.correction === true)) || n > 52)
  throw new Error('Only continuation stages or documented F17/F18 corrections');
if (
  !Array.isArray(spec.checks) ||
  spec.checks.length === 0 ||
  spec.checks.some((c) => c.exitCode !== 0)
)
  throw new Error('Checks must have actually passed');
for (const check of spec.checks) {
  const log = path.resolve(root, check.log);
  if (!log.startsWith(root + path.sep)) throw new Error('Evidence outside workspace');
  await fs.access(log);
}
if (spec.cases?.length !== 3 || spec.cases.some((c) => !c.passed))
  throw new Error('Three acceptance cases required');
const cp = 'FS' + String(n).padStart(3, '0');
const taskRoot = path.join(root, '全栈开发任务');
const progressPath = path.join(taskRoot, '任务进度.md');
let progress = await fs.readFile(progressPath, 'utf8');
const originalProgress = progress,
  originalReadme = await fs.readFile(path.join(root, 'README.md'), 'utf8');
for (let prior = 1; prior < n; prior++) {
  const id = 'F' + String(prior).padStart(2, '0');
  const row = progress.split(/\r?\n/).find((l) => l.startsWith('| ' + id + ' |'));
  if (!row?.includes('| 已完成 |')) throw new Error('Predecessor not complete: ' + id);
}
const documents = await fs.readdir(path.join(taskRoot, '任务'));
const taskFile = documents.find((f) => f.startsWith(spec.task + '-'));
if (!taskFile) throw new Error('Task file not found');
const title =
  spec.title ??
  (await fs.readFile(path.join(taskRoot, '任务', taskFile), 'utf8'))
    .split(/\r?\n/)[0]
    .replace(/^# F\d{2} · /, '');
const nextId = n < 52 ? 'F' + String(n + 1).padStart(2, '0') : null;
const nextFile = nextId === null ? null : documents.find((f) => f.startsWith(nextId + '-'));
const now = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  dateStyle: 'short',
  timeStyle: 'medium',
  hour12: false,
}).format(new Date());
const date = now.slice(0, 10);
const git =
  spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout?.trim() ??
  '未建立';
const migrations = (
  await fs.readdir(path.join(root, 'database/prisma/migrations'), { withFileTypes: true })
)
  .filter((e) => e.isDirectory())
  .map((e) => e.name);
const recordPath = path.join(taskRoot, '存档', cp, '存档记录.md');
const originalRecord = await fs.readFile(recordPath, 'utf8');
const versionName =
  now.replaceAll('-', '').replace(' ', '-').replaceAll(':', '') +
  '-' +
  String(new Date().getMilliseconds()).padStart(3, '0') +
  '-' +
  randomBytes(4).toString('hex');
const version = path.join(taskRoot, '存档', cp, '版本', versionName),
  relative = path.relative(root, version).replaceAll(path.sep, '/');
const report = [
  '# ' + cp + ' · ' + spec.task + ' ' + title,
  '',
  '- 验收结论：通过（本机技术验收）',
  '- 时间（Asia/Shanghai）：' + now,
  '- 独立执行文档：[' + spec.task + '](../../任务/' + taskFile + ')',
  '- 范围调整：按ADR-0009本机部署，不使用Docker；Safari和异机灾备为后续扩展。',
  '- Git基准：' + git + '；本步代码以独立文件快照为准，可能包含尚未提交修改。',
  '- 数据库迁移：' + migrations.join('、'),
  '- 实际交付：',
  ...spec.changes.map((c) => '  - ' + c),
  '',
  '## 实测与证据',
  '',
  ...spec.checks.map((c) => '- ' + c.command + '：退出码0；' + c.summary + '；日志：' + c.log),
  '',
  '| 用例 | 实际结果 | 结论 |',
  '|---|---|---|',
  ...spec.cases.map(
    (c, i) =>
      '| ' + spec.task + '-0' + (i + 1) + ' | ' + c.result.replaceAll('|', '／') + ' | 通过 |',
  ),
  '',
  '## 已知边界',
  '',
  ...(spec.limits?.length ? spec.limits : ['本步未发现阻断项；后续任务的验收尚未执行。']).map(
    (l) => '- ' + l,
  ),
  '',
  '- 快照版本路径：' + relative,
  '- SHA-256核验：以版本根verification.json独立核验凭证为准；manifest不含自身与核验凭证。',
  '- 回退：上一通过的FS版本；代码回退不等于数据库回退，恢复数据库前保存当前状态。',
  '- 下一任务：' + (nextFile ? '[' + nextId + '](../../任务/' + nextFile + ')' : '本机版交付完成'),
  '',
].join('\n');
if (spec.correction) {
  const old = await fs.readFile(recordPath, 'utf8');
  const history = path.join(path.dirname(recordPath), '历史记录-原验收.md');
  try {
    await fs.access(history);
  } catch {
    await fs.writeFile(history, old, 'utf8');
  }
}
try {
  await fs.writeFile(recordPath, report, 'utf8');
  progress = progress
    .split(/\r?\n/)
    .map((line) => {
      if (!line.startsWith('| ' + spec.task + ' |')) return line;
      const cells = line.split('|');
      cells[5] = ' 已完成 ';
      cells[7] = ' ' + date + ' ';
      cells[8] = ' `' + relative + '` ';
      return cells.join('|');
    })
    .join('\n');
  const completed = progress
    .split('\n')
    .filter((line) => /^\| F\d{2} \|/.test(line) && line.includes('| 已完成 |')).length;
  const current = [
    '## 当前入口',
    '',
    '- 已完成：' + completed + '/52；本次最新完成' + spec.task + '，独立快照为' + cp + '。',
    '- 当前范围：本机正式部署，不使用Docker，按ADR-0009执行。',
    '- 下一任务：' +
      (nextFile
        ? '[' +
          nextId +
          ' ' +
          nextFile.replace(/^F\d{2}-/, '').replace(/\.md$/, '') +
          '](任务/' +
          nextFile +
          ')'
        : '本机版任务全部完成'),
    '- 下一存档：' + (n < 52 ? 'FS' + String(n + 1).padStart(3, '0') : '无'),
    '- 实际验收和未验证项见各FS记录；不得把后续任务提前标完成。',
    '',
  ].join('\n');
  if (!spec.correction) {
    progress = progress.replace(/## 当前入口[\s\S]*/, current);
    progress = progress.replace(
      /^> 当前状态：.*$/m,
      '> 当前状态：' +
        (n === 52
          ? '本机开发与技术验收完成；24小时观察另行记录。'
          : '本机版本开发中；技术验收与存档已推进至' + spec.task + '。'),
    );
  }
  await fs.writeFile(progressPath, progress, 'utf8');
  const readmePath = path.join(root, 'README.md');
  let readme = await fs.readFile(readmePath, 'utf8');
  const boundary = [
    '## 交付边界（当前阶段）',
    '',
    '- 部署方式：本机Node.js + PostgreSQL，正式构建与原生启停，不使用Docker（ADR-0009）。',
    '- 已完成并归档：' + completed + '/52步；最新为' + spec.task + ' ' + title + '。',
    '- 下一任务：' +
      (nextFile
        ? nextId + ' ' + nextFile.replace(/^F\d{2}-/, '').replace(/\.md$/, '')
        : '本机交付已完成') +
      '。',
    '- Safari实机、异机灾备、公网环境和外部CI为后续扩展，不冒充已经验证。',
    '- 具体证据与每步快照见[任务进度](全栈开发任务/任务进度.md)。',
    '',
  ].join('\n');
  if (!spec.correction)
    readme = readme.replace(/## 交付边界（当前阶段）[\s\S]*?(?=## 历史参考|$)/, boundary);
  await fs.writeFile(readmePath, readme, 'utf8');
  const archive = spawnSync(
    'pwsh',
    [
      '-NoProfile',
      '-File',
      path.join(taskRoot, '工具/保存全栈存档.ps1'),
      '-Checkpoint',
      cp,
      '-Note',
      spec.task + ' ' + title,
      '-VersionName',
      versionName,
    ],
    { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
  );
  if (archive.status !== 0) throw new Error(archive.stderr || archive.stdout);
  const manifestBytes = await fs.readFile(path.join(version, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  for (const item of manifest.files) {
    const body = await fs.readFile(path.join(version, item.path));
    if (
      body.length !== item.bytes ||
      createHash('sha256').update(body).digest('hex') !== item.sha256
    )
      throw new Error('Snapshot hash mismatch: ' + item.path);
  }
  await fs.writeFile(
    path.join(version, 'verification.json'),
    JSON.stringify(
      {
        task: spec.task,
        verifiedAt: new Date().toISOString(),
        files: manifest.files.length,
        manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
        result: 'passed',
        scope: 'all source snapshot files; manifest and this attestation excluded',
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      task: spec.task,
      completed,
      files: manifest.files.length,
      version: relative,
      sha256: 'verified',
      next: nextId,
    }),
  );
} catch (error) {
  await fs.writeFile(progressPath, originalProgress);
  await fs.writeFile(path.join(root, 'README.md'), originalReadme);
  await fs.writeFile(recordPath, originalRecord);
  throw error;
}
