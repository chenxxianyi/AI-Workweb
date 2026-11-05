import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { root, data, run } from './native.mjs';
const target = process.argv.includes('--test')
  ? path.join(data, 'env-setup-test', Date.now() + '.env')
  : path.join(root, '.env');
await fs.mkdir(path.dirname(target), { recursive: true });
const source = await fs.readFile(path.join(root, '.env.example'), 'utf8'),
  password = randomBytes(32).toString('hex');
const handle = await fs.open(target, 'wx');
await handle.close();
try {
  run('icacls', [
    target,
    '/inheritance:r',
    '/grant:r',
    process.env.USERDOMAIN + '\\' + process.env.USERNAME + ':F',
    'SYSTEM:F',
  ]);
  const result = source.replaceAll('CHANGE_ME_LOCAL_ONLY', password);
  if (result === source) throw Error('模板开发口令标识缺失');
  await fs.writeFile(target, result);
  console.log(
    JSON.stringify({
      created: true,
      defaultPasswordReplaced: true,
      aclRestricted: true,
      test: process.argv.includes('--test'),
      file: path.relative(root, target),
    }),
  );
} catch (e) {
  await fs.rm(target, { force: true });
  throw e;
}
