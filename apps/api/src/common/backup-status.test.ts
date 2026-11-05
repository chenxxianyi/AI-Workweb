import { afterEach, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { databaseBackupStatus } from './backup-status.js';
let directory: string | undefined;
const before = process.env['BACKUP_STATUS_FILE'];
afterEach(async () => {
  if (before === undefined) delete process.env['BACKUP_STATUS_FILE'];
  else process.env['BACKUP_STATUS_FILE'] = before;
  if (directory) await rm(directory, { recursive: true });
});
it('reports missing, successful, stale, failed and invalid records without exposing filesystem paths', async () => {
  delete process.env['BACKUP_STATUS_FILE'];
  expect((await databaseBackupStatus()).state).toBe('not_configured');
  directory = await mkdtemp(join(tmpdir(), 'aiwb-backup-status-'));
  const file = join(directory, 'status.json');
  process.env['BACKUP_STATUS_FILE'] = file;
  await writeFile(
    file,
    JSON.stringify({
      state: 'ok',
      createdAt: new Date().toISOString(),
      password: 'must-never-return',
    }),
  );
  const current = await databaseBackupStatus();
  expect(current.state).toBe('ok');
  expect(JSON.stringify(current)).not.toContain('must-never-return');
  await writeFile(
    file,
    JSON.stringify({ state: 'ok', createdAt: new Date(Date.now() - 90000000).toISOString() }),
  );
  expect((await databaseBackupStatus()).state).toBe('stale');
  await writeFile(file, JSON.stringify({ state: 'failed' }));
  expect((await databaseBackupStatus()).state).toBe('failed');
  await writeFile(file, JSON.stringify({ state: 'ok', createdAt: 'invalid' }));
  expect((await databaseBackupStatus()).state).toBe('failed');
});
