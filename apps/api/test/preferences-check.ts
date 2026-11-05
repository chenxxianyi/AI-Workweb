import assert from 'node:assert/strict';
import { createTestContext } from './test-context.js';
import { PreferencesService, reminderDue } from '../src/modules/preferences/preferences.module.js';
const ctx = await createTestContext();
let checks = 0;
const check = (n: string, v: boolean) => {
  assert.ok(v, n);
  checks++;
  console.log('PASS ' + n);
};
try {
  const owner = await ctx.owner('prefs-owner'),
    other = await ctx.owner('prefs-other'),
    viewer = await ctx.owner('prefs-viewer');
  await ctx.prisma.workspaceMember.create({
    data: { workspaceId: owner.workspaceId, userId: viewer.userId, role: 'viewer' },
  });
  const path = '/workspaces/' + owner.workspaceId + '/preferences',
    service = ctx.app.get(PreferencesService);
  const first = await ctx.call('GET', '/users/me/preferences', owner);
  check(
    '个人偏好默认system版本1',
    (first.json['data'] as { theme: string; version: number }).theme === 'system' &&
      (first.json['data'] as { version: number }).version === 1,
  );
  check(
    '个人偏好缺版本428',
    (await ctx.call('PATCH', '/users/me/preferences', { ...owner, body: { theme: 'dark' } }))
      .status === 428,
  );
  check(
    '主题真实保存跨会话可读',
    (
      await ctx.call('PATCH', '/users/me/preferences', {
        ...owner,
        version: 1,
        body: { theme: 'dark' },
      })
    ).status === 200 &&
      (
        (await ctx.call('GET', '/auth/me', owner)).json['data'] as {
          preferences: { theme: string };
        }
      ).preferences.theme === 'dark',
  );
  check(
    '旧主题版本412',
    (
      await ctx.call('PATCH', '/users/me/preferences', {
        ...owner,
        version: 1,
        body: { theme: 'light' },
      })
    ).status === 412,
  );
  const secondJar: Record<string, string> = {};
  await ctx.call('GET', '/auth/csrf', { jar: secondJar });
  await ctx.call('POST', '/auth/login', {
    jar: secondJar,
    csrf: secondJar['sfs_csrf'],
    body: { email: 'prefs-owner@integration.test', password: 'Disposable-Integration-2026' },
  });
  check(
    '独立Cookie会话读到同一服务器主题',
    (
      (await ctx.call('GET', '/users/me/preferences', { jar: secondJar })).json['data'] as {
        theme: string;
      }
    ).theme === 'dark',
  );
  check(
    '用户间主题不串',
    ((await ctx.call('GET', '/users/me/preferences', other)).json['data'] as { theme: string })
      .theme === 'system',
  );
  check(
    '伪造偏好用户字段422',
    (
      await ctx.call('PATCH', '/users/me/preferences', {
        ...owner,
        version: 2,
        body: { theme: 'dark', userId: other.userId },
      })
    ).status === 422,
  );
  await ctx.prisma.project.createMany({
    data: Array.from({ length: 30 }, (_, i) => ({
      workspaceId: owner.workspaceId,
      createdBy: owner.userId,
      name: '提醒项目' + i,
      nextStep: '继续',
    })),
  });
  check('总数30不提醒', !(await service.space(owner.workspaceId, owner.userId)).reminderEligible);
  await ctx.prisma.project.create({
    data: {
      workspaceId: owner.workspaceId,
      createdBy: owner.userId,
      name: '第31条',
      nextStep: '继续',
    },
  });
  check('总数31提醒', (await service.space(owner.workspaceId, owner.userId)).reminderEligible);
  const claims = await Promise.all([
    ctx.call('POST', path + '/reminder', { ...owner, body: {} }),
    ctx.call('POST', path + '/reminder', { ...owner, body: {} }),
  ]);
  check(
    '并发设备24h只显示一次',
    claims.filter((r) => (r.json['data'] as { show: boolean }).show).length === 1,
  );
  const shown = (
    await ctx.prisma.workspaceUserPreference.findUniqueOrThrow({
      where: { workspaceId_userId: { workspaceId: owner.workspaceId, userId: owner.userId } },
    })
  ).tipShownAt!;
  check(
    '23:59:59不重复，24:00:00允许',
    !(await service.claim(owner.workspaceId, owner.userId, new Date(shown.getTime() + 86399999)))
      .show &&
      (await service.claim(owner.workspaceId, owner.userId, new Date(shown.getTime() + 86400000)))
        .show,
  );
  check(
    '同空间换用户仍独立',
    (await ctx.call('POST', path + '/reminder', { ...viewer, body: {} })).status === 200,
  );
  check(
    '换空间偏好隔离',
    !(await service.space(other.workspaceId, other.userId)).reminderEligible &&
      (await service.space(other.workspaceId, other.userId)).tipShownAt === null,
  );
  const time = new Date('2026-01-01T00:00:00Z');
  check(
    '500/501与30/31纯阈值',
    !reminderDue(30, 500, null, time) &&
      reminderDue(31, 500, null, time) &&
      reminderDue(0, 501, null, time),
  );
  await ctx.prisma.task.createMany({
    data: Array.from({ length: 500 }, (_, i) => ({
      workspaceId: owner.workspaceId,
      createdBy: owner.userId,
      title: '完成任务' + i,
      status: 'done' as const,
      doneAt: new Date(),
    })),
  });
  check(
    '真实已完成500计数',
    (await service.space(owner.workspaceId, owner.userId)).completedTasks === 500,
  );
  await ctx.prisma.task.create({
    data: {
      workspaceId: owner.workspaceId,
      createdBy: owner.userId,
      title: '第501',
      status: 'done',
      doneAt: new Date(),
      dueDate: new Date('2026-01-01'),
    },
  });
  check(
    '真实已完成501计数与整理建议',
    (await service.space(owner.workspaceId, owner.userId)).completedTasks === 501 &&
      (
        await service.claim(
          owner.workspaceId,
          owner.userId,
          new Date(shown.getTime() + 2 * 86400000),
        )
      ).messages.some((m) => m.includes('500')),
  );
  check(
    'Viewer不能改时区',
    (
      await ctx.call('PATCH', '/workspaces/' + owner.workspaceId, {
        ...viewer,
        version: 1,
        body: { timezone: 'UTC' },
      })
    ).status === 403,
  );
  check(
    '非法时区422',
    (
      await ctx.call('PATCH', '/workspaces/' + owner.workspaceId, {
        ...owner,
        version: 1,
        body: { timezone: 'Mars/Nowhere' },
      })
    ).status === 422,
  );
  check(
    'Owner改时区有审计且旧业务日不改',
    (
      await ctx.call('PATCH', '/workspaces/' + owner.workspaceId, {
        ...owner,
        version: 1,
        body: { timezone: 'UTC' },
      })
    ).status === 200 &&
      (await ctx.prisma.auditEvent.count({
        where: { workspaceId: owner.workspaceId, action: 'workspace.updated' },
      })) === 1 &&
      (
        await ctx.prisma.task.findFirstOrThrow({
          where: { workspaceId: owner.workspaceId, title: '第501' },
        })
      ).dueDate
        ?.toISOString()
        .slice(0, 10) === '2026-01-01',
  );
  check(
    '数据库备份与业务导出字段分开',
    (await service.space(owner.workspaceId, owner.userId)).databaseBackup.state ===
      'not_configured' &&
      (await service.space(owner.workspaceId, owner.userId)).lastBusinessExportAt === null,
  );
  check(
    '跨空间无权不可读取',
    (await ctx.call('GET', '/workspaces/' + other.workspaceId + '/preferences', owner)).status ===
      404,
  );
  console.log('合计 ' + checks + ' 项，全部通过');
} finally {
  await ctx.close();
}
