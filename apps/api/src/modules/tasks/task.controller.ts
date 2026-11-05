import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { ZodPipe } from '../../common/zod.pipe.js';
import { assertIdempotencyKey } from '../../common/idempotency.js';
import { requireRequestAuth } from '../auth/auth-context.js';
import { WorkspaceRoleRequired } from '../workspaces/permissions.js';
import { workspaceContext } from '../workspaces/workspace.guard.js';
import { TaskService } from './task.service.js';

const prioritySchema = z.enum(['p0', 'p1', 'p2']);
const statusSchema = z.enum(['todo', 'doing', 'done']);

const createSchema = z.strictObject({
  title: z.string().min(1).max(200),
  projectId: z.string().max(64).nullish(),
  priority: prioritySchema.optional(),
  status: statusSchema.optional(),
  dueDate: z.string().max(10).nullish(),
  aiContext: z.string().max(4000).nullish(),
  blocker: z.string().max(4000).nullish(),
});

const updateSchema = z.strictObject({
  title: z.string().min(1).max(200).optional(),
  projectId: z.string().max(64).nullish(),
  priority: prioritySchema.optional(),
  status: statusSchema.optional(),
  dueDate: z.string().max(10).nullish(),
  shiftDays: z.number().int().min(-3650).max(3650).optional(),
  aiContext: z.string().max(4000).nullish(),
  blocker: z.string().max(4000).nullish(),
});

const postponeSchema = z.strictObject({ dryRun: z.boolean().optional() });

/**
 * 任务接口（F14）。
 *
 * - 读：任意成员；写：Editor 及以上
 * - 创建需要 `Idempotency-Key`（重复请求只执行一次）
 * - 更新/删除需要 `If-Match`（缺 428、过期 412）
 * - 昨日顺延：先 `dryRun=true` 预览，再确认提交（单事务）
 */
@Controller('workspaces/:workspaceId/tasks')
export class TaskController {
  constructor(@Inject(TaskService) private readonly tasks: TaskService) {}

  @Post(':taskId/promote')
  @HttpCode(201)
  @WorkspaceRoleRequired('business.write')
  async promote(
    @Req() request: Request, @Param('taskId', new ZodPipe(z.uuid())) taskId: string,
    @Headers('if-match') ifMatch: string | undefined, @Headers('idempotency-key') key: string | undefined,
    @Body(new ZodPipe(z.strictObject({ newEntry: z.boolean().default(false) }))) body: { newEntry: boolean },
  ) {
    return { data: await this.tasks.promote(workspaceContext(request).workspaceId, requireRequestAuth(request).userId, taskId, ifMatch, assertIdempotencyKey(key), body.newEntry) };
  }

  @Get()
  async list(
    @Req() request: Request,
    @Query('status') status?: string,
    @Query('projectId') projectId?: string,
    @Query('dueDate') dueDate?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<{ data: Awaited<ReturnType<TaskService['list']>> }> {
    const context = workspaceContext(request);
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    return {
      data: await this.tasks.list(context.workspaceId, {
        ...(status === 'todo' || status === 'doing' || status === 'done' ? { status } : {}),
        ...(projectId === undefined ? {} : { projectId }),
        ...(dueDate === undefined ? {} : { dueDate }),
        ...(parsedLimit === undefined || Number.isNaN(parsedLimit) ? {} : { limit: parsedLimit }),
        ...(cursor === undefined ? {} : { cursor }),
      }),
    };
  }

  // 注意：静态路由必须在 :taskId 之前声明
  @Post('postpone-yesterday')
  @HttpCode(200)
  @WorkspaceRoleRequired('business.write')
  async postpone(
    @Req() request: Request,
    @Body(new ZodPipe(postponeSchema)) body: z.infer<typeof postponeSchema>,
  ): Promise<{ data: Awaited<ReturnType<TaskService['postponeYesterday']>> }> {
    const auth = requireRequestAuth(request);
    const context = workspaceContext(request);
    return {
      data: await this.tasks.postponeYesterday(context.workspaceId, auth.userId, body.dryRun ?? false),
    };
  }

  @Post()
  @HttpCode(201)
  @WorkspaceRoleRequired('business.write')
  async create(
    @Req() request: Request,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodPipe(createSchema)) body: z.infer<typeof createSchema>,
  ): Promise<{ data: Awaited<ReturnType<TaskService['create']>> }> {
    const auth = requireRequestAuth(request);
    const context = workspaceContext(request);
    return {
      data: await this.tasks.create(
        context.workspaceId,
        auth.userId,
        {
          title: body.title,
          ...(body.projectId === undefined ? {} : { projectId: body.projectId }),
          ...(body.priority === undefined ? {} : { priority: body.priority }),
          ...(body.status === undefined ? {} : { status: body.status }),
          ...(body.dueDate === undefined ? {} : { dueDate: body.dueDate }),
          ...(body.aiContext === undefined ? {} : { aiContext: body.aiContext }),
          ...(body.blocker === undefined ? {} : { blocker: body.blocker }),
        },
        assertIdempotencyKey(idempotencyKey),
      ),
    };
  }

  @Get(':taskId')
  async detail(
    @Req() request: Request,
    @Param('taskId') taskId: string,
  ): Promise<{ data: Awaited<ReturnType<TaskService['get']>> }> {
    const context = workspaceContext(request);
    return { data: await this.tasks.get(context.workspaceId, taskId) };
  }

  @Patch(':taskId')
  @WorkspaceRoleRequired('business.write')
  async update(
    @Req() request: Request,
    @Param('taskId') taskId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodPipe(updateSchema)) body: z.infer<typeof updateSchema>,
  ): Promise<{ data: Awaited<ReturnType<TaskService['update']>> }> {
    const auth = requireRequestAuth(request);
    const context = workspaceContext(request);
    return {
      data: await this.tasks.update(context.workspaceId, auth.userId, taskId, ifMatch, body),
    };
  }

  @Delete(':taskId')
  @HttpCode(200)
  @WorkspaceRoleRequired('business.write')
  async remove(
    @Req() request: Request,
    @Param('taskId') taskId: string,
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<{ data: { status: 'deleted' } }> {
    const auth = requireRequestAuth(request);
    const context = workspaceContext(request);
    await this.tasks.remove(context.workspaceId, auth.userId, taskId, ifMatch);
    return { data: { status: 'deleted' } };
  }
}
