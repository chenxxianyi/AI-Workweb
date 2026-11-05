import assert from 'node:assert/strict';
import {createTestContext} from './test-context.js';
const ctx=await createTestContext();let checks=0;
const check=(ok:unknown,label:string)=>{assert.ok(ok,label);console.log('PASS',++checks,label);};
try{
 const a=await ctx.owner('matrix-a'),b=await ctx.owner('matrix-b'),root='/workspaces/'+a.workspaceId,other='/workspaces/'+b.workspaceId;
 const project=await ctx.prisma.project.create({data:{workspaceId:a.workspaceId,createdBy:a.userId,name:'仅A空间',nextStep:''}}),task=await ctx.prisma.task.create({data:{workspaceId:a.workspaceId,createdBy:a.userId,projectId:project.id,title:'仅A任务'}}),entry=await ctx.prisma.entry.create({data:{workspaceId:a.workspaceId,createdBy:a.userId,title:'仅A知识',body:'needle-a'}}),log=await ctx.prisma.developmentLog.create({data:{workspaceId:a.workspaceId,authorId:a.userId,text:'仅A日志',logDate:new Date('2026-11-04')}}),job=await ctx.prisma.transferJob.create({data:{workspaceId:a.workspaceId,actorId:a.userId,type:'export_json',state:'queued',counts:{format:'json'}}});
 const ledger=await ctx.prisma.ledgerRecord.create({data:{workspaceId:a.workspaceId,createdBy:a.userId,note:'仅A台账',tool:'claude',scene:'coding',minutes:1,savedMinutes:0,effect:3,recordDate:new Date('2026-11-04')}});
 const lists=['/projects','/tasks','/entries','/logs','/ledger','/tags','/dashboard/today','/analytics/monthly?month=2026-11','/analytics/weekly','/search/entries?q=needle-a','/transfers','/trash','/audit-events','/preferences','/members','/offline-operations/context'];
 for(const route of lists){check((await ctx.call('GET',root+route)).status===401,'匿名拒绝 '+route);check((await ctx.call('GET',root+route,b)).status===404,'跨空间拒绝 '+route);const own=await ctx.call('GET',other+route,b);check(own.status===200,'本人空空间可读 '+route);check(!JSON.stringify(own.json).includes('仅A'),'空空间不泄露A字段 '+route);}
 const details=['/projects/'+project.id,'/projects/'+project.id+'/overview','/tasks/'+task.id,'/entries/'+entry.id,'/entries/'+entry.id+'/revisions','/search/related/'+entry.id,'/ledger/'+ledger.id,'/transfers/'+job.id,'/transfers/'+job.id+'/download','/imports/'+job.id+'/items','/offline-operations/key-a'];
 for(const route of details){check((await ctx.call('GET',root+route)).status===401,'详情匿名拒绝 '+route);const cross=await ctx.call('GET',other+route,b);check(route.startsWith('/offline-operations/')?cross.status===200&&(cross.json.data as {status:string}).status==='not_found':cross.status===404,'详情跨ID隔离 '+route);}
 await ctx.prisma.workspaceMember.create({data:{workspaceId:a.workspaceId,userId:b.userId,role:'viewer'}});
 for(const route of ['/projects','/tasks','/entries','/logs','/ledger','/exports','/maintenance/clear','/offline-operations'])check((await ctx.call('POST',root+route,{...b,key:'viewer',body:{}})).status===403,'Viewer直接写被拒 '+route);
 check((await ctx.call('POST',root+'/logs',{jar:a.jar,key:'no-csrf',body:{text:'reject'}})).status===403,'缺CSRF直接拒绝');
 await assert.rejects(ctx.prisma.task.create({data:{workspaceId:b.workspaceId,createdBy:b.userId,projectId:project.id,title:'跨空间FK'}}),(error:unknown)=>(error as {code?:string}).code==='P2003');check(true,'跨空间关系约束返回P2003');
 await assert.rejects(ctx.prisma.workspaceMember.create({data:{workspaceId:a.workspaceId,userId:a.userId,role:'owner'}}),(error:unknown)=>(error as {code?:string}).code==='P2002');check(true,'成员唯一约束返回P2002');
 check(await ctx.prisma.developmentLog.count({where:{workspaceId:a.workspaceId}})===1,'拒绝写入无业务副作用');
 console.log(JSON.stringify({checks,result:'passed',resourceLogId:log.id}));
}finally{await ctx.close();}



