import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { data, profile, profilePath, read, json, sql } from './native.mjs';
import { backup, retention } from './backup.mjs';
export function assess(snapshot, previous = { failures: 0, active: {} }) {
  const failures = snapshot.healthy ? 0 : previous.failures + 1,
    active = {};
  if (failures >= 3) active.api = { severity: 'critical', message: '连续3次API就绪探测失败' };
  if (snapshot.diskRatio < 0.1)
    active.disk = { severity: 'critical', message: '可用磁盘低于10%，大型传输会被拒绝' };
  else if (snapshot.diskRatio < 0.2)
    active.disk = { severity: 'warning', message: '可用磁盘低于20%' };
  if (snapshot.backupState === 'failed')
    active.backup = { severity: 'critical', message: '最近数据库备份失败' };
  else if (!snapshot.backupAt || snapshot.at - Date.parse(snapshot.backupAt) > 86400000)
    active.backup = { severity: 'warning', message: '没有24小时内的成功数据库备份' };
  if (snapshot.oldJobs > 0)
    active.jobs = {
      severity: 'warning',
      message: '存在超过10分钟的传输队列或超过20分钟的运行任务',
    };
  const events = [];
  for (const [id, value] of Object.entries(active))
    if (!previous.active[id] || previous.active[id].severity !== value.severity)
      events.push({ at: new Date(snapshot.at).toISOString(), id, state: 'firing', ...value });
  for (const id of Object.keys(previous.active))
    if (!active[id])
      events.push({
        at: new Date(snapshot.at).toISOString(),
        id,
        state: 'resolved',
        severity: 'info',
        message: '对应检查已恢复',
      });
  return { failures, active, events };
}
export async function sample(p) {
  const cfg = await profile(p),
    at = Date.now(),
    runtime = path.dirname(profilePath(p)),
    fsInfo = await fs.statfs(data),
    status = await read(path.join(runtime, 'backup-status.json')).catch(() => null);
  let healthy = false,
    latencyMs = null,
    oldJobs = 0;
  try {
    const start = Date.now(),
      r = await fetch(cfg.origin + '/api/v1/health/ready', { signal: AbortSignal.timeout(5000) });
    healthy = r.ok;
    latencyMs = Date.now() - start;
  } catch {
    /*由告警状态记录，不打印内部错误*/
  }
  try {
    oldJobs = (
      await sql(
        cfg.databaseUrl,
        "SELECT count(*)::int n FROM transfer_jobs WHERE (state='queued' AND created_at<now()-interval '10 minutes') OR (state='running' AND created_at<now()-interval '20 minutes')",
      )
    ).rows[0].n;
  } catch {
    healthy = false;
  }
  return {
    at,
    healthy,
    latencyMs,
    diskRatio: Number(fsInfo.bavail) / Number(fsInfo.blocks),
    backupState: status?.state ?? 'missing',
    backupAt: status?.createdAt ?? null,
    oldJobs,
  };
}
export async function once(p) {
  const runtime = path.dirname(profilePath(p)),
    file = path.join(runtime, 'monitor-state.json'),
    previous = await read(file).catch(() => ({ failures: 0, active: {} })),
    snapshot = await sample(p),
    result = assess(snapshot, previous);
  if (result.events.length)
    await fs.appendFile(
      path.join(runtime, 'alerts.jsonl'),
      result.events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    );
  await json(file, {
    ...result,
    events: undefined,
    lastAt: new Date(snapshot.at).toISOString(),
    snapshot,
  });
  await fs.appendFile(path.join(runtime, 'health.jsonl'), JSON.stringify(snapshot) + '\n');
  const obsFile = path.join(runtime, 'observation.json'),
    obs = await read(obsFile).catch(() => ({
      startedAt: new Date(snapshot.at).toISOString(),
      samples: 0,
      failedSamples: 0,
      alertSamples: 0,
      maxGapMs: 0,
      lastAt: null,
    }));
  if (obs.lastAt) obs.maxGapMs = Math.max(obs.maxGapMs, snapshot.at - Date.parse(obs.lastAt));
  obs.lastAt = new Date(snapshot.at).toISOString();
  obs.samples++;
  if (!snapshot.healthy) obs.failedSamples++;
  if (Object.keys(result.active).length) obs.alertSamples++;
  obs.elapsedMs = snapshot.at - Date.parse(obs.startedAt);
  obs.thirtyMinutes = {
    elapsed: obs.elapsedMs >= 1800000,
    coverage: obs.elapsedMs >= 1800000 && obs.samples >= 31 && obs.maxGapMs <= 120000,
  };
  obs.twentyFourHours = {
    elapsed: obs.elapsedMs >= 86400000,
    coverage: obs.elapsedMs >= 86400000 && obs.samples >= 1441 && obs.maxGapMs <= 120000,
  };
  await json(obsFile, obs);
  if (obs.twentyFourHours.elapsed)
    await json(path.join(runtime, 'observation-24h.json'), {
      ...obs,
      result:
        obs.twentyFourHours.coverage && obs.failedSamples === 0 && obs.alertSamples === 0
          ? 'passed'
          : 'needs_review',
      description: '按实际采样间隔/失败/告警判定；休眠或中断不能冒充连续覆盖',
    });
  return { snapshot, active: result.active, events: result.events };
}
async function rotate(p) {
  const dir = path.dirname(profilePath(p));
  for (const name of ['health.jsonl', 'alerts.jsonl']) {
    const file = path.join(dir, name);
    try {
      if ((await fs.stat(file)).size > 10 * 1024 * 1024)
        await fs.rename(file, path.join(dir, name + '.' + Date.now()));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
}
async function watch(p) {
  let stopped = false;
  process.on('SIGTERM', () => {
    stopped = true;
  });
  process.on('SIGINT', () => {
    stopped = true;
  });
  const runtime = path.dirname(profilePath(p)),
    lock = path.join(runtime, 'monitor.lock');
  const handle = await fs.open(lock, 'wx').catch(() => {
    throw Error('巡检锁已存在；先核对monitor-state/PID，确认旧进程结束后再移除锁');
  });
  await handle.writeFile(String(process.pid));
  await handle.close();
  let monitorFailed = false;
  try {
    while (!stopped) {
      try {
        const status = await read(path.join(runtime, 'backup-status.json')).catch(() => null);
        const attempt = await read(path.join(runtime, 'backup-attempt.json')).catch(() => null);
        if (
          (status?.state !== 'ok' || Date.now() - Date.parse(status.createdAt) > 23 * 3600000) &&
          (!attempt || Date.now() - attempt.at > 900000)
        ) {
          await json(path.join(runtime, 'backup-attempt.json'), { at: Date.now() });
          try {
            await backup(p);
            await retention(p, { apply: true });
          } catch {
            /*backup写入失败状态，once统一告警去重；15分钟后重试*/
          }
        }
        await once(p);
        await rotate(p);
        if (monitorFailed) {
          await fs.appendFile(
            path.join(runtime, 'alerts.jsonl'),
            JSON.stringify({
              at: new Date().toISOString(),
              id: 'monitor',
              state: 'resolved',
              severity: 'info',
              message: '本机巡检已恢复',
            }) + '\n',
          );
          monitorFailed = false;
        }
      } catch {
        if (!monitorFailed)
          await fs.appendFile(
            path.join(runtime, 'alerts.jsonl'),
            JSON.stringify({
              at: new Date().toISOString(),
              id: 'monitor',
              state: 'firing',
              severity: 'critical',
              message: '本机巡检或自动备份失败，请手动检查',
            }) + '\n',
          );
        monitorFailed = true;
      }
      await new Promise((r) => setTimeout(r, 60000));
    }
  } finally {
    await fs.rm(lock, { force: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, p] = process.argv.slice(2);
  if (cmd === 'once') console.log(JSON.stringify(await once(p)));
  else if (cmd === 'watch') await watch(p);
  else throw Error('用法: monitor.mjs once|watch stage|production');
}
