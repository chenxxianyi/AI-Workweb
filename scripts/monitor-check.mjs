import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { root, data, profile, read, stop, start, sql } from './native.mjs';
import { assess, once } from './monitor.mjs';
let checks = 0;
const check = (v, n) => {
  assert.ok(v, n);
  console.log('PASS ' + ++checks + ' ' + n);
};
const healthy = {
    at: Date.now(),
    healthy: true,
    diskRatio: 0.5,
    backupState: 'ok',
    backupAt: new Date().toISOString(),
    oldJobs: 0,
  },
  first = assess({ ...healthy, diskRatio: 0.05, backupState: 'failed', oldJobs: 7 });
check(Object.keys(first.active).length === 3, '磁盘/备份失败/任务积压注入均触发告警');
const duplicate = assess({ ...healthy, diskRatio: 0.05, backupState: 'failed', oldJobs: 7 }, first);
check(duplicate.events.length === 0, '相同故障不重复通知');
check(
  assess(healthy, duplicate).events.filter((e) => e.state === 'resolved').length === 3,
  '三项恢复各一次通知',
);
const state = await read(path.join(data, 'runtime/stage/state.json'));
await once('stage');
await stop('stage');
try {
  await once('stage');
  await once('stage');
  const failed = await once('stage');
  check(!!failed.active.api, '真实停止API连续三次探测触发告警');
  check(
    failed.events.some((e) => e.id === 'api' && e.state === 'firing'),
    '真实告警写入指定本机文件',
  );
  check((await once('stage')).events.length === 0, '真实API持续失败去重');
} finally {
  await start('stage', state.release);
}
check(
  (await once('stage')).events.some((e) => e.id === 'api' && e.state === 'resolved'),
  '真实重启后恢复通知',
);
const cfg = await profile('stage');
check(
  (await sql(cfg.databaseUrl, "SELECT count(*)::int n FROM transfer_jobs WHERE state='queued'"))
    .rows[0].n === 0,
  '实际无遗留排队任务',
);
const alerts = await fs.readFile(path.join(data, 'runtime/stage/alerts.jsonl'), 'utf8');
check(
  !/password|csrfToken|token_hash|postgresql:|cookie|Cookie/.test(alerts),
  '告警文件无密码/令牌/Cookie/连接串',
);
await fs.copyFile(
  path.join(data, 'runtime/stage/alerts.jsonl'),
  path.join(root, '全栈开发任务/验收证据/FS049/alerts-sample.jsonl'),
);
console.log(
  JSON.stringify({
    checks,
    result: 'passed',
    faults: 'API为真实停启；磁盘/备份/积压为状态机输入注入，未填满真实磁盘',
  }),
);
