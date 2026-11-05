import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { config } from 'dotenv';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
config({ path: path.join(root, '.env'), quiet: true });
const url = process.env.DATABASE_URL_TEST,
  target = url ? new URL(url) : null;
if (
  !target ||
  !['127.0.0.1', 'localhost'].includes(target.hostname) ||
  !target.pathname.endsWith('_test')
)
  throw new Error('仅允许本机独立 *_test 数据库');
const output = path.resolve(root, process.argv[2] ?? '.data/integration');
if (!output.startsWith(root + path.sep)) throw new Error('证据目录须在工作区内');
await fs.mkdir(output, { recursive: true });
const files = [
  'auth-check.ts',
  'auth-http-check.ts',
  'session-check.ts',
  'workspace-check.ts',
  'project-check.ts',
  'task-check.ts',
  'dashboard-check.ts',
  'logs-check.ts',
  'entry-check.ts',
  'revision-check.ts',
  'search-check.ts',
  'usage-check.ts',
  'promote-check.ts',
  'ledger-check.ts',
  'analytics-check.ts',
  'exports-check.ts',
  'imports-preview-check.ts',
  'imports-commit-check.ts',
  'transfer-roundtrip-check.ts',
  'preferences-check.ts',
  'maintenance-check.ts',
  'offline.integration.ts',
  'conflicts.integration.ts',
  'isolation.integration.ts',
  'create-idempotency.integration.ts',
  'weak-network.integration.ts',
];
const results = [];
for (const file of files) {
  const started = Date.now();
  const result = await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        path.join(root, 'node_modules/tsx/dist/cli.mjs'),
        '--tsconfig',
        'tsconfig.test.json',
        'test/' + file,
      ],
      {
        cwd: path.join(root, 'apps/api'),
        env: {
          ...process.env,
          DATABASE_URL: url,
          DATABASE_URL_TEST: url,
          MAINTENANCE_WORKER_ENABLED: 'false',
          TRANSFER_WORKER_ENABLED: 'false',
          LOG_LEVEL: 'error',
        },
        windowsHide: true,
      },
    );
    let log = '';
    child.stdout.on('data', (b) => (log += b));
    child.stderr.on('data', (b) => (log += b));
    child.on('error', (error) => resolve({ code: 1, log: log + '\n' + error.message }));
    child.on('close', (code) => resolve({ code, log }));
  });
  await fs.writeFile(path.join(output, file + '.log'), result.log);
  const row = { file, exitCode: result.code, ms: Date.now() - started };
  results.push(row);
  console.log(JSON.stringify(row));
  if (result.code !== 0) {
    console.error(result.log.slice(-4000));
    break;
  }
}
const report = {
  database: target.pathname.slice(1),
  host: target.hostname,
  startedAt: new Date().toISOString(),
  suites: results.length,
  passed: results.filter((x) => x.exitCode === 0).length,
  expected: files.length,
  results,
};
await fs.writeFile(path.join(output, 'summary.json'), JSON.stringify(report, null, 2));
if (results.length !== files.length || results.some((x) => x.exitCode !== 0)) process.exitCode = 1;
