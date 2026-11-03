import type { PrismaClient } from '../../apps/api/src/generated/prisma/client.js';

/**
 * 测试/演示 fixture（F05）。
 * 只由显式命令调用（seed 或测试），不在应用启动或空库时自动灌入（需求矩阵：种子数据仅显式导入）。
 */

export interface FixtureOptions {
  /** 标记邮箱域，便于区分测试数据 */
  emailDomain?: string;
  timezone?: string;
}

export interface FixtureResult {
  users: { ownerId: string; editorId: string; viewerId: string };
  workspaces: { personalId: string; teamId: string };
  projects: { mainId: string; migrationId: string; otherSpaceId: string };
  counts: { tasks: number; entries: number; tags: number; ledger: number; logs: number };
}

const PASSWORD_HASH_PLACEHOLDER = '!seed-not-loginable';

/** 业务日（Asia/Shanghai）：种子数据以“今天”为基准，方便演示紧急项 */
export function todayInShanghai(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

function utcDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

export async function seedFixture(
  prisma: PrismaClient,
  options: FixtureOptions = {},
): Promise<FixtureResult | null> {
  const domain = options.emailDomain ?? 'demo.test';
  const timezone = options.timezone ?? 'Asia/Shanghai';

  const existing = await prisma.workspace.findFirst({ where: { name: '个人工作台' } });
  if (existing !== null) return null;

  const owner = await prisma.user.create({
    data: {
      emailNormalized: `owner@${domain}`,
      displayName: '所有者',
      passwordHash: PASSWORD_HASH_PLACEHOLDER,
    },
  });
  const editor = await prisma.user.create({
    data: {
      emailNormalized: `editor@${domain}`,
      displayName: '协作者',
      passwordHash: PASSWORD_HASH_PLACEHOLDER,
    },
  });
  const viewer = await prisma.user.create({
    data: {
      emailNormalized: `viewer@${domain}`,
      displayName: '只读者',
      passwordHash: PASSWORD_HASH_PLACEHOLDER,
    },
  });

  const personal = await prisma.workspace.create({
    data: { name: '个人工作台', timezone, createdBy: owner.id },
  });
  const team = await prisma.workspace.create({
    data: { name: '团队空间', timezone, createdBy: owner.id },
  });

  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: personal.id, userId: owner.id, role: 'owner' },
      { workspaceId: team.id, userId: owner.id, role: 'owner' },
      { workspaceId: team.id, userId: editor.id, role: 'editor' },
      { workspaceId: team.id, userId: viewer.id, role: 'viewer' },
    ],
  });

  const today = todayInShanghai();

  const mainProject = await prisma.project.create({
    data: {
      workspaceId: personal.id,
      createdBy: owner.id,
      name: '工作台全栈版',
      repo: 'local/ai-coding-workbench',
      stack: ['React', 'NestJS', 'PostgreSQL'],
      stage: 'developing',
      nextStep: '完成数据库约束与 fixture（F05）',
      progressManual: false,
    },
  });
  const migrationProject = await prisma.project.create({
    data: {
      workspaceId: personal.id,
      createdBy: owner.id,
      name: '旧数据迁移',
      stack: ['Node', 'PostgreSQL'],
      stage: 'planning',
      nextStep: '整理 schema1 样本',
      progressManual: true,
      manualProgress: 0,
    },
  });
  const otherProject = await prisma.project.create({
    data: {
      workspaceId: team.id,
      createdBy: owner.id,
      name: '团队共享项目',
      stack: ['TypeScript'],
      stage: 'paused',
      nextStep: '等待成员确认范围',
    },
  });

  const tasks = await Promise.all([
    prisma.task.create({
      data: {
        workspaceId: personal.id,
        projectId: mainProject.id,
        createdBy: owner.id,
        title: '补齐数据库约束与 fixture',
        priority: 'p0',
        status: 'doing',
        dueDate: utcDate(shiftDate(today, -2)),
        aiContext: 'Prisma 7 + 审核 SQL 迁移',
      },
    }),
    prisma.task.create({
      data: {
        workspaceId: personal.id,
        projectId: mainProject.id,
        createdBy: owner.id,
        title: '实现 API 基础校验与日志',
        priority: 'p1',
        status: 'todo',
        dueDate: utcDate(today),
      },
    }),
    prisma.task.create({
      data: {
        workspaceId: personal.id,
        projectId: migrationProject.id,
        createdBy: owner.id,
        title: '导出旧版 localStorage 样本',
        priority: 'p1',
        status: 'todo',
        dueDate: utcDate(shiftDate(today, 3)),
        blocker: '需要旧设备上的原始导出',
      },
    }),
    prisma.task.create({
      data: {
        workspaceId: personal.id,
        createdBy: owner.id,
        title: '整理本周技术笔记',
        priority: 'p2',
        status: 'done',
        dueDate: utcDate(shiftDate(today, -1)),
        doneAt: new Date(),
      },
    }),
    prisma.task.create({
      data: {
        workspaceId: team.id,
        projectId: otherProject.id,
        createdBy: owner.id,
        title: '团队空间演示任务',
        priority: 'p2',
        status: 'todo',
      },
    }),
  ]);

  const tagNames = ['幂等', '数据库', '离线'];
  const tags = await Promise.all(
    tagNames.map((name) =>
      prisma.tag.create({
        data: { workspaceId: personal.id, nameNormalized: name, displayName: name },
      }),
    ),
  );

  const adrEntry = await prisma.entry.create({
    data: {
      workspaceId: personal.id,
      createdBy: owner.id,
      type: 'adr',
      status: 'verified',
      title: '断连重试的幂等设计',
      summary: '同一 Idempotency-Key 重试只创建一次，超时视为结果未知。',
      body: '## 结论\n\n断连重试必须复用同一幂等键。\n\n```ts\nawait submit(key); // 重试复用 key\n```\n',
      projectId: mainProject.id,
      tags: {
        create: [
          { workspaceId: personal.id, tagId: tags[0]!.id },
          { workspaceId: personal.id, tagId: tags[2]!.id },
        ],
      },
    },
  });

  const designEntry = await prisma.entry.create({
    data: {
      workspaceId: personal.id,
      createdBy: owner.id,
      type: 'design',
      status: 'verified',
      title: 'PostgreSQL 时区与业务日',
      summary: '业务日期用 DATE，今日按空间时区计算。',
      body: '业务日一律使用 DATE 字段，避免把 2026-11-03 当成 UTC 时刻。\n',
      projectId: mainProject.id,
      tags: { create: [{ workspaceId: personal.id, tagId: tags[1]!.id }] },
    },
  });

  await prisma.entry.create({
    data: {
      workspaceId: personal.id,
      createdBy: owner.id,
      type: 'note',
      status: 'draft',
      title: '待整理：索引优化想法',
      body: '收集中文短词搜索的 EXPLAIN ANALYZE 结果，再决定是否上 pg_trgm。\n',
    },
  });

  await prisma.entryUsage.createMany({
    data: [
      { workspaceId: personal.id, entryId: adrEntry.id, useCount: 7 },
      { workspaceId: personal.id, entryId: designEntry.id, useCount: 2 },
    ],
  });

  const ledger = await Promise.all([
    prisma.ledgerRecord.create({
      data: {
        workspaceId: personal.id,
        createdBy: owner.id,
        recordDate: utcDate(today),
        projectId: mainProject.id,
        tool: 'claude',
        scene: 'coding',
        minutes: 30,
        savedMinutes: 40,
        effect: 4,
        entryId: adrEntry.id,
      },
    }),
    prisma.ledgerRecord.create({
      data: {
        workspaceId: personal.id,
        createdBy: owner.id,
        recordDate: utcDate(today),
        projectId: mainProject.id,
        tool: 'copilot',
        scene: 'review',
        minutes: 20,
        savedMinutes: 15,
        effect: 3,
      },
    }),
    prisma.ledgerRecord.create({
      data: {
        workspaceId: personal.id,
        createdBy: owner.id,
        recordDate: utcDate(shiftDate(today, -8)),
        tool: 'claude',
        scene: 'design',
        minutes: 45,
        savedMinutes: 60,
        effect: 5,
      },
    }),
  ]);

  const logs = await Promise.all([
    prisma.developmentLog.create({
      data: {
        workspaceId: personal.id,
        authorId: owner.id,
        logDate: utcDate(today),
        text: '完成 Prisma schema 与首个迁移，约束负向检查全部通过。',
      },
    }),
    prisma.developmentLog.create({
      data: {
        workspaceId: personal.id,
        authorId: editor.id,
        logDate: utcDate(shiftDate(today, -1)),
        text: '对照需求矩阵补齐 422/412/428 的契约示例。',
      },
    }),
  ]);

  await prisma.taskEntry.create({
    data: { workspaceId: personal.id, taskId: tasks[0]!.id, entryId: adrEntry.id },
  });

  return {
    users: { ownerId: owner.id, editorId: editor.id, viewerId: viewer.id },
    workspaces: { personalId: personal.id, teamId: team.id },
    projects: {
      mainId: mainProject.id,
      migrationId: migrationProject.id,
      otherSpaceId: otherProject.id,
    },
    counts: {
      tasks: tasks.length,
      entries: 3,
      tags: tags.length,
      ledger: ledger.length,
      logs: logs.length,
    },
  };
}
