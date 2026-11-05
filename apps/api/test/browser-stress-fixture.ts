import {config} from 'dotenv';
import {resolve} from 'node:path';
import {PrismaClient} from '../src/generated/prisma/client.js';
import {createPrismaAdapter} from '../src/common/prisma-adapter.js';
config({path:resolve('../../.env'),quiet:true});const url=process.env['DATABASE_URL_TEST']!,target=new URL(url);if(!['127.0.0.1','localhost'].includes(target.hostname)||!target.pathname.endsWith('_test'))throw new Error('local test only');const db=new PrismaClient({adapter:createPrismaAdapter(url)});
try{const user=await db.user.findUniqueOrThrow({where:{emailNormalized:'ui-qa@workbench.test'}}),member=await db.workspaceMember.findFirstOrThrow({where:{userId:user.id,role:'owner',workspace:{name:'本机验收空间'}}}),workspaceId=member.workspaceId;
 const projectId='a4211111-1111-4111-8111-111111111111',entryId='a4222222-2222-4222-8222-222222222222',taskId='a4233333-3333-4333-8333-333333333333',ledgerId='a4244444-4444-4444-8444-444444444444';
 const p={workspaceId,createdBy:user.id,name:'长项目'.repeat(33)+'长',nextStep:'下一步验证长内容换行。'.repeat(16).slice(0,200)};await db.project.upsert({where:{id:projectId},create:{id:projectId,...p},update:p});
 const e={workspaceId,createdBy:user.id,projectId,title:'长标题'.repeat(66)+'长长',body:'```ts\n'+('const continuous="'+'x'.repeat(2000)+'";\n').repeat(8)+'```\n\n中文长正文验收。',summary:'中文摘要。'.repeat(60),type:'note' as const};await db.entry.upsert({where:{id:entryId},create:{id:entryId,...e},update:e});
 const t={workspaceId,createdBy:user.id,projectId,title:'长任务'.repeat(66)+'长长',priority:'p0' as const,dueDate:new Date('2026-11-04'),blocker:'长卡点。'.repeat(200)};await db.task.upsert({where:{id:taskId},create:{id:taskId,...t},update:t});
 const l={workspaceId,createdBy:user.id,projectId,entryId,recordDate:new Date('2026-11-04'),tool:'claude',scene:'coding',minutes:12,savedMinutes:30,effect:4,note:'F42长台账内容。'.repeat(400).slice(0,4000)};await db.ledgerRecord.upsert({where:{id:ledgerId},create:{id:ledgerId,...l},update:l});
 const sessions=await db.session.findMany({where:{userId:user.id,revokedAt:null},select:{userAgent:true}});console.log(JSON.stringify({result:'ready',workspaceId,projectId,entryId,taskId,ledgerId,entryBodyBytes:Buffer.byteLength(e.body),titleChars:e.title.length,browserAgents:sessions.map(s=>s.userAgent)}));
}finally{await db.$disconnect();}
