import { it, expect } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import { RotatingLog } from './rotating-log.js';
it('serial rotation keeps complete recent records and bounds archive count', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aiwb-log-'));
  try {
    const log = new RotatingLog(join(dir, 'api.log'), 100, 2);
    for (let n = 0; n < 5; n++) log.write(JSON.stringify({ n, text: '测'.repeat(20) }) + '\n');
    log.end();
    await finished(log);
    const files = await readdir(dir);
    expect(files).toHaveLength(3);
    const rows = [];
    for (const file of files)
      rows.push(JSON.parse((await readFile(join(dir, file), 'utf8')).trim()).n);
    expect(rows.sort()).toEqual([2, 3, 4]);
    expect(JSON.parse((await readFile(join(dir, 'api.log'), 'utf8')).trim()).n).toBe(4);
  } finally {
    await rm(dir, { recursive: true });
  }
});
