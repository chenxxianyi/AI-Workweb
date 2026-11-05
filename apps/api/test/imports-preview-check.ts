import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createTestContext } from './test-context.js';
import { type PlanItem } from '../src/modules/transfers/imports.module.js';
import { deterministicId } from '../src/modules/transfers/import-format.js';
process.env['TRANSFER_WORKER_ENABLED'] = 'false';
process.env['TRANSFER_STORAGE_DIR'] = resolve('../../.data/transfers-test');
const ctx = await createTestContext();
let checks = 0;
const check = (n: string, v: boolean) => {
  assert.ok(v, n);
  checks++;
  console.log('PASS ' + n);
};
try {
  const owner = await ctx.owner('imports-owner'),
    viewer = await ctx.owner('imports-viewer');
  await ctx.prisma.workspaceMember.create({
    data: { workspaceId: owner.workspaceId, userId: viewer.userId, role: 'viewer' },
  });
  const source = 'legacy-one',
    route = '/workspaces/' + owner.workspaceId + '/imports/preview?sourceNamespace=' + source;
  const fixture = {
    schema: 1,
    projects: [
      { id: 'p1', name: '旧项目', stage: '开发', nextStep: '导入', progressManual: false },
    ],
    tasks: [
      {
        id: 't1',
        title: '旧任务',
        priority: 'P1',
        status: 'doing',
        due: '2026-01-01',
        projectId: 'p1',
        entryIds: ['e1'],
      },
    ],
    entries: [
      {
        id: 'e1',
        type: 'pitfall',
        title: '排查记录',
        summary: '摘要',
        body: '正文',
        status: 'verified',
        tags: ['#Network', 'network'],
        useCount: 4,
        lastUsedAt: 1767225600,
        projectId: 'p1',
        revisions: [{ body: '旧版', at: 1767225500 }],
      },
    ],
    logs: [
      { date: '2026-01-01', text: '缺ID日志', at: 1767225600 },
      { date: '2026-01-01', text: '缺ID日志', at: 1767225600 },
    ],
    ledger: [
      {
        id: 'l1',
        date: '2026-01-01',
        tool: 'claude-code',
        scene: '写功能',
        minutes: 10,
        savedMinutes: 30,
        effect: 5,
        entryId: 'e1',
        projectId: 'missing',
      },
    ],
    settings: { theme: 'dark' },
  };
  const cookies = (jar: Record<string, string>) =>
    Object.entries(jar)
      .map(([k, v]) => k + '=' + encodeURIComponent(v))
      .join('; ');
  async function upload(text: string, key: string, who = owner) {
    const res = await fetch(ctx.base + route, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        cookie: cookies(who.jar),
        'x-csrf-token': who.csrf,
        'idempotency-key': key,
      },
      body: text,
    });
    return {
      status: res.status,
      json: (await res.json()) as {
        data?: {
          id: string;
          state: string;
          planHash: string;
          counts: { created: number; broken: number; conflicts: number };
        };
        error?: { code: string };
      },
    };
  }
  const first = await upload(JSON.stringify(fixture), 'preview-1');
  check(
    '旧schema真实上传预览就绪',
    first.status === 202 && first.json.data?.state === 'preview_ready',
  );
  const id = first.json.data!.id,
    items = await ctx.prisma.importItem.findMany({ where: { jobId: id } });
  check(
    '预览完全不写业务',
    (await ctx.prisma.project.count()) === 0 &&
      (await ctx.prisma.entry.count()) === 0 &&
      (await ctx.prisma.developmentLog.count()) === 0 &&
      (await ctx.prisma.importEntityMapping.count()) === 0,
  );
  check(
    '旧枚举标签映射',
    (
      items.find((i) => i.entityType === 'entry')!.normalizedPayload as {
        type: string;
        tags: string[];
      }
    ).type === 'troubleshoot' &&
      (
        items.find((i) => i.entityType === 'entry')!.normalizedPayload as { tags: string[] }
      ).tags.join(',') === 'network',
  );
  check(
    '无ID同内容日志分别稳定生成',
    items.filter((i) => i.entityType === 'log').length === 2 &&
      new Set(items.filter((i) => i.entityType === 'log').map((i) => i.sourceId)).size === 2,
  );
  check(
    '断链已计入预览',
    first.json.data!.counts.broken === 1 &&
      items.some((i) =>
        (i.validationResult as unknown as PlanItem)?.missing?.includes('projectId'),
      ),
  );
  const second = await upload(JSON.stringify(fixture), 'preview-2');
  check('重复预览计划hash稳定', second.json.data?.planHash === first.json.data?.planHash);
  const replay = await upload(JSON.stringify(fixture), 'preview-1');
  check('同key复用原job', replay.json.data?.id === id);
  check(
    '未知schema拒绝',
    (await upload('{"schemaVersion":99}', 'future')).json.error?.code ===
      'IMPORT_VERSION_UNSUPPORTED',
  );
  check('坏JSON拒绝', (await upload('{', 'bad')).status === 400);
  check(
    '危险键拒绝',
    (await upload('{"schema":1,"projects":[],"__proto__":{}}', 'proto')).status === 400,
  );
  check(
    '正文UTF8超限拒绝',
    (
      await upload(
        JSON.stringify({
          ...fixture,
          entries: [{ ...fixture.entries[0], body: '中'.repeat(7000) }],
        }),
        'long',
      )
    ).status === 422,
  );
  check('Viewer不能预览', (await upload(JSON.stringify(fixture), 'viewer', viewer)).status === 403);
  const targetId = deterministicId(owner.workspaceId, source, 'project', 'p1');
  await ctx.prisma.project.create({
    data: {
      id: targetId,
      workspaceId: owner.workspaceId,
      createdBy: owner.userId,
      name: '用户已经编辑',
      nextStep: '保护',
      version: 2,
    },
  });
  await ctx.prisma.importEntityMapping.create({
    data: {
      workspaceId: owner.workspaceId,
      sourceNamespace: source,
      entityType: 'project',
      legacyId: 'p1',
      entityId: targetId,
      lastImportedVersion: 1,
      sourceUpdatedAt: new Date(0),
    },
  });
  const conflict = await upload(JSON.stringify(fixture), 'conflict');
  check(
    '用户后续编辑默认保留并报告冲突',
    conflict.json.data?.counts.conflicts === 1 &&
      (await ctx.prisma.project.findUniqueOrThrow({ where: { id: targetId } })).name ===
        '用户已经编辑',
  );
  const updated = await ctx.prisma.importItem.findFirstOrThrow({
    where: { jobId: conflict.json.data!.id, entityType: 'project' },
  });
  check(
    '映射目标ID稳定且冲突keep_server',
    (updated.validationResult as unknown as PlanItem).targetId === targetId &&
      updated.decision === 'keep_server',
  );
  const modern = await upload(
    await readFile(resolve('../../全栈开发任务/验收证据/FS029/sample.json'), 'utf8'),
    'modern',
  );
  check(
    '真实schemaVersion2导出文件可完整预览',
    modern.status === 202 && modern.json.data?.state === 'preview_ready',
  );
  console.log('合计 ' + checks + ' 项，全部通过');
} finally {
  await ctx.close();
}
