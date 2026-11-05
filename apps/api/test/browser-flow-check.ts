import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { createPrismaAdapter } from '../src/common/prisma-adapter.js';
config({ path: resolve('../../.env'), quiet: true });
const url = process.env['DATABASE_URL_TEST']!,
  target = new URL(url);
if (!['127.0.0.1', 'localhost'].includes(target.hostname) || !target.pathname.endsWith('_test'))
  throw new Error('local test only');
const db = new PrismaClient({ adapter: createPrismaAdapter(url) });
let checks = 0;
const check = (ok: unknown, label: string) => {
  assert.ok(ok, label);
  console.log('PASS', ++checks, label);
};
try {
  const user = await db.user.findUniqueOrThrow({
      where: { emailNormalized: 'ui-qa@workbench.test' },
    }),
    member = await db.workspaceMember.findFirstOrThrow({
      where: { userId: user.id, workspace: { name: '本机验收空间' } },
    }),
    workspaceId = member.workspaceId;
  const project = await db.project.findFirstOrThrow({
      where: { workspaceId, name: 'F40完整流程项目' },
    }),
    task = await db.task.findFirstOrThrow({ where: { workspaceId, title: 'F40任务沉淀闭环' } }),
    entry = await db.entry.findFirstOrThrow({ where: { workspaceId, title: 'F40任务沉淀闭环' } }),
    ledger = await db.ledgerRecord.findFirstOrThrow({
      where: { workspaceId, note: 'F40浏览器全流程台账' },
    });
  check(!!project.id && !!task.id, '浏览器创建项目与任务真实落库');
  check(
    (await db.taskEntry.count({ where: { taskId: task.id, entryId: entry.id, workspaceId } })) ===
      1,
    '沉淀任务关联唯一',
  );
  check(
    (await db.entryRevision.count({ where: { entryId: entry.id } })) === 1,
    '编辑正文保留一条原修订',
  );
  check(
    (await db.entryUsage.findUniqueOrThrow({ where: { entryId: entry.id } })).useCount === 1,
    '实际复制只计一次',
  );
  check(
    ledger.projectId === project.id && ledger.entryId === entry.id && ledger.savedMinutes === 30,
    '台账关联项目/知识与统计原值一致',
  );
  const jar: Record<string, string> = {},
    base = 'http://127.0.0.1:3001/api/v1';
  async function call(path: string, body?: unknown) {
    const response = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        cookie: Object.entries(jar)
          .map(([k, v]) => k + '=' + encodeURIComponent(v))
          .join('; '),
        'content-type': 'application/json',
        ...(jar['sfs_csrf'] ? { 'x-csrf-token': jar['sfs_csrf'] } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    for (const h of response.headers.getSetCookie()) {
      const p = h.split(';')[0]!,
        i = p.indexOf('=');
      jar[p.slice(0, i)] = decodeURIComponent(p.slice(i + 1));
    }
    return response;
  }
  await call('/auth/csrf');
  check(
    (
      await call('/auth/login', {
        email: 'ui-qa@workbench.test',
        password: 'Disposable-UI-Fixture-2026',
      })
    ).status === 200,
    '独立HTTP客户端登录合成验收账号',
  );
  const job = await db.transferJob.findFirstOrThrow({
    where: { workspaceId, type: 'export_json', actorId: user.id },
    orderBy: { createdAt: 'desc' },
  });
  check(job.state === 'succeeded', '真实后台worker完成浏览器创建的导出');
  const response = await call('/workspaces/' + workspaceId + '/transfers/' + job.id + '/download');
  check(
    response.status === 200 && response.headers.get('cache-control')?.includes('no-store'),
    '受控HTTP下载成功且禁止缓存',
  );
  const data = await response.text();
  await writeFile(resolve('../../全栈开发任务/验收证据/FS040/download.json'), data);
  check(
    data.includes(entry.body.replace(/\n/g, '\\n').replace(/"/g, '\\"').slice(0, 30)) ||
      data.includes('F40中文结论'),
    '导出含真实中文正文',
  );
  check(!/passwordHash|csrfToken|emailNormalized/.test(data), '业务导出不含认证字段');
  console.log(
    JSON.stringify({
      checks,
      result: 'passed',
      workspaceId,
      entryId: entry.id,
      projectId: project.id,
      taskId: task.id,
      ledgerId: ledger.id,
      exportJobId: job.id,
    }),
  );
} finally {
  await db.$disconnect();
}
