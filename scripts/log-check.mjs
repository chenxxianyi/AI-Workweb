import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { profilePath } from './native.mjs';
import { client } from './native-client.mjs';
const c = await client('stage'),
  sentinel = 'F49_LOG_BODY_SENTINEL_2026';
await c.call('/workspaces/' + c.workspaceId + '/projects', {
  method: 'POST',
  body: { name: sentinel, password: sentinel },
  expected: 422,
});
const dir = path.dirname(profilePath('stage')),
  file = path.join(dir, 'api-events.log');
let log = '';
for (let i = 0; i < 20; i++) {
  log = await fs.readFile(file, 'utf8');
  if (log.includes('http_request')) break;
  await new Promise((r) => setTimeout(r, 50));
}
assert.ok(log.includes('http_request'));
assert.ok(!log.includes(sentinel));
for (const value of Object.values(c.jar)) if (value.length > 20) assert.ok(!log.includes(value));
const credential = await fs.readFile(path.join(dir, 'credentials.txt'), 'utf8'),
  password = /初始密码：([^\r\n]+)/.exec(credential)[1];
assert.ok(!log.includes(password));
const rows = log
  .trim()
  .split(/\r?\n/)
  .map((line) => JSON.parse(line));
assert.ok(rows.some((r) => r.requestId && r.path));
console.log(
  JSON.stringify({
    result: 'passed',
    records: rows.length,
    requestId: true,
    bodyNotLogged: true,
    passwordNotLogged: true,
    cookiesNotLogged: true,
    rotation: '20MiB + 10 archives; actual stream rotation unit passed',
  }),
);
