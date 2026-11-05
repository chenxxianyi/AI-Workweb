import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { createPrismaAdapter } from '../src/common/prisma-adapter.js';
import { hashPassword } from '../src/modules/auth/password.js';
loadEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });
const url = process.env['DATABASE_URL_TEST'];
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('Browser fixture requires dedicated *_test database');
const db = new PrismaClient({ adapter: createPrismaAdapter(url) });
const email = 'ui-qa@workbench.test';
const password = 'Disposable-UI-Fixture-2026';
const user = await db.user.upsert({ where: { emailNormalized: email }, create: { emailNormalized: email, displayName: '本机验收', passwordHash: await hashPassword(password) }, update: {} });
let member = await db.workspaceMember.findFirst({ where: { userId: user.id, role: 'owner' } });
if (!member) { const workspace = await db.workspace.create({ data: { name: '本机验收空间', createdBy: user.id } }); member = await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: 'owner' } }); }
const entryIds = ['a2311111-1111-4111-8111-111111111111', 'a2322222-2222-4222-8222-222222222222'];
for (const [index, id] of entryIds.entries()) {
  const data = { workspaceId: member.workspaceId, createdBy: user.id, title: index === 0 ? 'SSE断连重试' : '断连问题排查', summary: '本机浏览器验收使用的合成数据', body: '## 解决方案\n\n保留幂等键，使用指数退避。', type: 'note' as const, status: 'verified' as const };
  await db.entry.upsert({ where: { id }, create: { id, ...data }, update: data });
}
const tag = await db.tag.upsert({ where: { workspaceId_nameNormalized: { workspaceId: member.workspaceId, nameNormalized: '网络' } }, create: { workspaceId: member.workspaceId, nameNormalized: '网络', displayName: '网络' }, update: {} });
for (const entryId of entryIds) await db.entryTag.upsert({ where: { entryId_tagId: { entryId, tagId: tag.id } }, create: { workspaceId: member.workspaceId, entryId, tagId: tag.id }, update: {} });
await db.entryUsage.upsert({ where: { entryId: entryIds[0] }, create: { workspaceId: member.workspaceId, entryId: entryIds[0]!, useCount: 3 }, update: { useCount: 3 } });
console.log(JSON.stringify({ email, password, workspaceId: member.workspaceId, entryIds }));
const projectId = 'a2544444-4444-4444-8444-444444444444';
await db.project.upsert({ where: { id: projectId }, create: { id: projectId, workspaceId: member.workspaceId, createdBy: user.id, name: '本机闭环验收项目', nextStep: '沉淀断连解决方案' }, update: { name: '本机闭环验收项目' } });
const taskId = 'a2533333-3333-4333-8333-333333333333';
const businessDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
await db.task.upsert({ where: { id: taskId }, create: { id: taskId, workspaceId: member.workspaceId, createdBy: user.id, projectId, title: '修复SSE重复提交', blocker: '断连重试产生重复记录', priority: 'p1', status: 'doing', dueDate: new Date(businessDay + 'T00:00:00Z') }, update: {} });
console.log(JSON.stringify({ projectId, taskId }));
await db.$disconnect();
