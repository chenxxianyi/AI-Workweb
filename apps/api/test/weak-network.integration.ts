import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {NestFactory} from '@nestjs/core';
import type {INestApplication} from '@nestjs/common';
import {createTestContext} from './test-context.js';
import {TransfersService} from '../src/modules/transfers/transfers.module.js';
process.env['TRANSFER_WORKER_ENABLED']='false';
const ctx=await createTestContext();let checks=0,restarted:INestApplication|undefined;
const check=(ok:unknown,label:string)=>{assert.ok(ok,label);console.log('PASS',++checks,label);};
try{
 const owner=await ctx.owner('response-drop'),root='/workspaces/'+owner.workspaceId+'/offline-operations',key='drop-after-commit',input={userId:owner.userId,workspaceVersion:1,createdAt:new Date().toISOString(),operation:{kind:'log',payload:{text:'提交成功后丢响应',logDate:'2026-11-04'}}};
 let upstreamStatus=0;
 const proxy=createServer(async(req,res)=>{try{for await(const _ of req){void _;}const result=await ctx.call('POST',root,{...owner,key,body:input});upstreamStatus=result.status;res.destroy();}catch{res.destroy();}});
 await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 const port=(proxy.address() as {port:number}).port;let dropped=false;
 try{await fetch('http://127.0.0.1:'+port,{method:'POST',body:JSON.stringify(input)});}catch{dropped=true;}finally{await new Promise<void>((resolve,reject)=>proxy.close(err=>err?reject(err):resolve()));}
 check(dropped&&upstreamStatus===200,'真实HTTP代理在服务器提交后断开客户端响应');
 check(await ctx.prisma.developmentLog.count({where:{workspaceId:owner.workspaceId}})===1,'客户端未收到响应但数据库已有一条');
 const status=await ctx.call('GET',root+'/'+key,owner);check((status.json.data as {status:string}).status==='succeeded','查询原键确认已完成');
 const replay=await ctx.call('POST',root,{...owner,key,body:input});check(replay.status===200&&(replay.json.data as {replayed:boolean}).replayed,'同键重试返回首次结果');
 check(await ctx.prisma.developmentLog.count({where:{workspaceId:owner.workspaceId}})===1,'断响应重试没有第二条记录');
 const transfer=ctx.app.get(TransfersService),job=await transfer.create(owner.workspaceId,owner.userId,'owner',{format:'json',includeTrash:false},'restart-export');
 await ctx.prisma.transferJob.update({where:{id:job.id},data:{state:'running',leaseUntil:new Date(Date.now()-1000),attempts:1}});
 await ctx.app.close();
 const {AppModule}=await import('../src/app.module.js');restarted=await NestFactory.create(AppModule,{logger:['error']});await restarted.init();
 const recovered=restarted.get(TransfersService);await recovered.tick(job.id);const saved=await ctx.prisma.transferJob.findUniqueOrThrow({where:{id:job.id}});
 check(saved.state==='succeeded'&&saved.attempts===2,'重建API与worker实例后恢复持久化过期租约');
 check((await readFile(recovered.path(saved.fileRef!),'utf8')).includes('提交成功后丢响应'),'重启后导出文件含此前已提交日志');
 console.log(JSON.stringify({checks,result:'passed',note:'租约时间在测试库缩短，实例实际关闭重建；未等待生产60秒'}));
}finally{await restarted?.close();await ctx.close();}
