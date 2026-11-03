import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { ZodPipe } from '../../common/zod.pipe.js';
import { requireRequestAuth } from '../auth/auth-context.js';
import { WorkspaceRoleRequired } from '../workspaces/permissions.js';
import { workspaceContext } from '../workspaces/workspace.guard.js';
import { ProjectService, type ProjectFilter } from './project.service.js';

const stageSchema = z.enum(['planning', 'developing', 'paused', 'done']);

const createSchema = z.strictObject({
  name: z.string().min(1).max(100),
  repo: z.string().max(300).nullish(),
  stack: z.array(z.string().max(32)).max(10).optional(),
  stage: stageSchema.optional(),
  nextStep: z.string().max(200).optional(),
  progressManual: z.boolean().optional(),
  manualProgress: z.number().int().min(0).max(100).nullish(),
  color: z.string().max(16).nullish(),
});

const updateSchema = createSchema.partial();

/**
 * 项目接口（F12）。
 *
 * - 读取：任意空间成员；写入：Editor 及以上；软删除与归档：Editor 及以上（彻底删除在 F34）
 * - 条件写：PATCH / 删除 / 归档 需要 If-Match（project.version）：缺 428、过期 412
 * - 跨空间或不存在：404（不泄露存在性）
 */
@Controller('workspaces/:workspaceId/projects')
export class ProjectController {
  constructor(@Inject(ProjectService) private readonly projects: ProjectService) {}

  @Get()
  async list(
    @Req() request: Request,
    @Query('filter') filter?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<{ data: Awaited<ReturnType<ProjectService['list']>> }> {
    const context = workspaceContext(request);
    const allowed: ProjectFilter[] = ['active', 'inactive', 'archived', 'all'];
    const parsedFilter = allowed.includes(filter as ProjectFilter) ? (filter as ProjectFilter) : 'active';
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    const result = await this.projects.list(context.workspaceId, {
      filter: parsedFilter,
      ...(q === undefined ? {} : { q }),
      ...(parsedLimit === undefined || Number.isNaN(parsedLimit) ? {} : { limit: parsedLimit }),
      ...(cursor === undefined ? {} : { cursor }),
    });
    return { data: result };
  }

  @Post()
  @HttpCode(201)
  @WorkspaceRoleRequired('business.write')
  async create(
    @Req() request: Request,
    @Body(new ZodPipe(createSchema)) body: z.infer<typeof createSchema>,
  ): Promise<{ data: Awaited<ReturnType<ProjectService['create']>> }> {
    const auth = requireRequestAuth(request);
    const context = workspaceContext(request);
    return {
      data: await this.projects.create(context.workspaceId, auth.userId, {
        name: body.name,
        ...(body.repo === undefined ? {} : { repo: body.repo }),
        ...(body.stack === undefined ? {} : { stack: body.stack }),
        ...(body.stage === undefined ? {} : { stage: body.stage }),
        ...(body.nextStep === undefined ? {} : { nextStep: body.nextStep }),
        ...(body.progressManual === undefined ? {} : { progressManual: body.progressManual }),
        ...(body.manualProgress === undefined ? {} : { manualProgress: body.manualProgress }),
        ...(body.color === undefined ? {} : { color: body.color }),
      }),
    };
  }

  @Get(':projectId')
  async detail(
    @Req() request: Request,
    @Param('projectId') projectId: string,
  ): Promise<{ data: Awaited<ReturnType<ProjectService['get']>> }> {
    const context = workspaceContext(request);
    return { data: await this.projects.get(context.workspaceId, projectId) };
  }

  @Get(':projectId/overview')
  async overview(
    @Req() request: Request,
    @Param('projectId') projectId: string,
  ): Promise<{ data: Record<string, unknown> }> {
    const context = workspaceContext(request);
    return { data: await this.projects.overview(context.workspaceId, projectId) };
  }

  @Patch(':projectId')
  @WorkspaceRoleRequired('business.write')
  async update(
    @Req() request: Request,
    @Param('projectId') projectId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodPipe(updateSchema)) body: z.infer<typeof updateSchema>,
  ): Promise<{ data: Awaited<ReturnType<ProjectService['update']>> }> {
    const auth = requireRequestAuth(request);
    const context = workspaceContext(request);
    return {
      data: await this.projects.update(context.workspaceId, auth.userId, projectId, ifMatch, body),
    };
  }

  @Post(':projectId/archive')
  @HttpCode(200)
  @WorkspaceRoleRequired('business.write')
  async archive(
    @Req() request: Request,
    @Param('projectId') projectId: string,
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<{ data: Awaited<ReturnType<ProjectService['setArchived']>> }> {
    const auth = requireRequestAuth(request);
    const context = workspaceContext(request);
    return {
      data: await this.projects.setArchived(context.workspaceId, auth.userId, projectId, ifMatch, true),
    };
  }

  @Post(':projectId/unarchive')
  @HttpCode(200)
  @WorkspaceRoleRequired('business.write')
  async unarchive(
    @Req() request: Request,
    @Param('projectId') projectId: string,
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<{ data: Awaited<ReturnType<ProjectService['setArchived']>> }> {
    const auth = requireRequestAuth(request);
    const context = workspaceContext(request);
    return {
      data: await this.projects.setArchived(context.workspaceId, auth.userId, projectId, ifMatch, false),
    };
  }

  @Delete(':projectId')
  @HttpCode(200)
  @WorkspaceRoleRequired('business.write')
  async remove(
    @Req() request: Request,
    @Param('projectId') projectId: string,
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<{ data: { status: 'deleted' } }> {
    const auth = requireRequestAuth(request);
    const context = workspaceContext(request);
    await this.projects.remove(context.workspaceId, auth.userId, projectId, ifMatch);
    return { data: { status: 'deleted' } };
  }
}
