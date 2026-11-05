import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { profile, profilePath } from './native.mjs';
/** 仅操作本机运行环境；不打印密码、Cookie和正文。 */
export async function client(p) {
  const cfg = await profile(p),
    jar = {},
    credentials = await fs.readFile(
      path.join(path.dirname(profilePath(p)), 'credentials.txt'),
      'utf8',
    ),
    password = /初始密码：([^\r\n]+)/.exec(credentials)?.[1];
  let csrf;
  async function call(
    route,
    { method = 'GET', body, version, key = randomUUID(), raw = false, expected } = {},
  ) {
    const r = await fetch(cfg.origin + '/api/v1' + route, {
      method,
      headers: {
        origin: cfg.origin,
        cookie: Object.entries(jar)
          .map(([k, v]) => k + '=' + v)
          .join('; '),
        ...(csrf ? { 'x-csrf-token': csrf } : {}),
        ...(body === undefined
          ? {}
          : { 'content-type': raw ? 'application/octet-stream' : 'application/json' }),
        ...(method === 'GET' ? {} : { 'idempotency-key': key }),
        ...(version === undefined ? {} : { 'if-match': '"' + version + '"' }),
      },
      ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }),
    });
    for (const h of r.headers.getSetCookie()) {
      const pair = h.split(';')[0],
        i = pair.indexOf('=');
      jar[pair.slice(0, i)] = pair.slice(i + 1);
    }
    const text = await r.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    if (expected !== undefined ? r.status !== expected : !r.ok)
      throw Error(`${method} ${route} HTTP${r.status} ${parsed.error?.code ?? ''}`);
    if (parsed.data?.csrfToken) csrf = parsed.data.csrfToken;
    return { status: r.status, data: parsed.data, body: parsed, text, headers: r.headers };
  }
  await call('/auth/csrf');
  await call('/auth/login', { method: 'POST', body: { email: 'owner@local.aiwb', password } });
  const me = (await call('/auth/me')).data;
  return { cfg, jar, call, me, workspaceId: me.memberships[0].workspaceId };
}
export async function waitJob(c, id, states = ['succeeded']) {
  for (let i = 0; i < 120; i++) {
    const job = (await c.call('/workspaces/' + c.workspaceId + '/transfers/' + id)).data;
    if (states.includes(job.state)) return job;
    if (['failed', 'cancelled', 'expired'].includes(job.state))
      throw Error('后台任务失败 ' + job.errorCode);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw Error('后台任务等待超时');
}
