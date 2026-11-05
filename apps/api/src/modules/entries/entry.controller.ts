import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { ZodPipe } from '../../common/zod.pipe.js';
import { assertIdempotencyKey } from '../../common/idempotency.js';
import { requireRequestAuth } from '../auth/auth-context.js';
import { WorkspaceRoleRequired } from '../workspaces/permissions.js';
import { workspaceContext } from '../workspaces/workspace.guard.js';
import { EntryService, type EntryView } from './entry.service.js';

const typeSchema = z.enum(['note', 'design', 'adr', 'troubleshoot', 'command']);
const statusSchema = z.enum(['draft', 'verified', 'archived']);

/** 状态只能通过 /status 接口修改，普通 PATCH 不接受 status 字段（strict 会 422） */
const createSchema = z.strictObject({
  type: typeSchema.optional(),
  title: z.string().max(200).optional(),
  summary: z.string().max(300).nullish(),
  body: z.string().optional(),
  lang: z.string().max(32).nullish(),
  projectId: z.string().max(64).nullish(),
  source: z.string().max(32).nullish(),
  rating: z.number().int().min(1).max(5).nullish(),
  tags: z.array(z.string().max(32)).max(10).optional(),
});

const updateSchema = createSchema.partial();
const statusSchemaBody = z.strictObject({ status: statusSchema });

/** 知识条目（F19） */
@Controller('workspaces/:workspaceId')
export class EntryController {
  constructor(@Inject(EntryService) private readonly entries: EntryService) {}

  @Get('entries')
  async list(
    @Req() request: Request,
    @Query('status') status?: string,
    @Query('type') type?: string,
    @Query('projectId') projectId?: string,
    @Query('tag') tag?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<{ data: Awaited<ReturnType<EntryService['list']>> }> {
    const context = workspaceContext(request);
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    return {
      data: await this.entries.list(context.workspaceId, {
        ...(status === 'draft' || status === 'verified' || status === 'archived' ? { status } : {}),
        ...(type === 'note' || type === 'design' || type === 'adr' || type === 'troubleshoot' || type === 'command'
          ? { type }
          : {}),
        ...(projectId === undefined ? {} : { projectId }),
        ...(tag === undefined ? {} : { tag }),
        ...(q === undefined ? {} : { q }),
        ...(parsedLimit === undefined || Number.isNaN(parsedLimit) ? {} : { limit: parsedLimit }),
        ...(cursor === undefined ? {} : { cursor }),
      }),
    };
  }

  @Get('tags')
  async tags(@Req() request: Request): Promise<{ data: Awaited<ReturnType<EntryService['listTags']>> }> {
    const context = workspaceContext(request);
    return { data: await this.entries.listTags(context.workspaceId) };
  }

  @Post('entries')
  @HttpCode(201)
  @WorkspaceRoleRequired('business.write')
  async create(
    @Req() request: Request,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodPipe(createSchema)) body: z.infer<typeof createSchema>,
  ): Promise<{ data: { entry: EntryView; replayed: boolean } }> {
    const auth = requireRequestAuth(request);
    const context = workspaceContext(request);
    return {
      data: await this.entries.create(context.workspaceId, auth.userId, body, assertIdempotencyKey(idempotencyKey)),
    };
  }

  @Get('entries/:entryId')
  async detail(@Req() request: Request, @Param('entryId') entryId: string): Promise<{ data: EntryView }> {
    const context = workspaceContext(request);
    return { data: await this.entries.get(context.workspaceId, entryId) };
  }

  @Get('entries/:entryId/usage')
  async usage(@Req() request: Request, @Param('entryId', new ZodPipe(z.uuid())) entryId: string) {
    return { data: await this.entries.usage(workspaceContext(request).workspaceId, entryId) };
  }

  @Post('entries/:entryId/usage')
  @HttpCode(200)
  async recordUsage(
    @Req() request: Request, @Param('entryId', new ZodPipe(z.uuid())) entryId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body(new ZodPipe(z.strictObject({}))) _body: Record<string, never>,
  ) {
    const result = await this.entries.recordUsage(workspaceContext(request).workspaceId, requireRequestAuth(request).userId, entryId, assertIdempotencyKey(key));
    return { data: { ...result.data, replayed: result.replayed } };
  }

  @Patch('entries/:entryId')
  @WorkspaceRoleRequired('business.write')
  async update(
    @Req() request: Request,
    @Param('entryId') entryId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodPipe(updateSchema)) body: z.infer<typeof updateSchema>,
  ): Promise<{ data: EntryView }> {
    const auth = requireRequestAuth(request);
    const context = workspaceContext(request);
    return { data: await this.entries.update(context.workspaceId, auth.userId, entryId, ifMatch, body) };
  }

  @Post('entries/:entryId/status')
  @HttpCode(200)
  @WorkspaceRoleRequired('business.write')
  async status(
    @Req() request: Request,
    @Param('entryId') entryId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodPipe(statusSchemaBody)) body: z.infer<typeof statusSchemaBody>,
  ): Promise<{ data: EntryView }> {
    const auth = requireRequestAuth(request);
    const context = workspaceContext(request);
    return { data: await this.entries.setStatus(context.workspaceId, auth.userId, entryId, ifMatch, body.status) };
  }

  @Get('entries/:entryId/revisions')
  async revisions(
    @Req() request: Request,
    @Param('entryId') entryId: string,
  ): Promise<{ data: Awaited<ReturnType<EntryService['revisions']>> }> {
    const context = workspaceContext(request);
    return { data: await this.entries.revisions(context.workspaceId, entryId) };
  }

  @Post('entries/:entryId/revisions/:revisionId/restore')
  @HttpCode(200)
  @WorkspaceRoleRequired('business.write')
  async restore(
    @Req() request: Request,
    @Param('entryId') entryId: string,
    @Param('revisionId') revisionId: string,
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<{ data: EntryView }> {
    const auth = requireRequestAuth(request);
    const context = workspaceContext(request);
    return {
      data: await this.entries.restoreRevision(context.workspaceId, auth.userId, entryId, revisionId, ifMatch),
    };
  }

  @Delete('entries/:entryId')
  @HttpCode(200)
  @WorkspaceRoleRequired('business.write')
  async remove(
    @Req() request: Request,
    @Param('entryId') entryId: string,
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<{ data: { status: 'deleted' } }> {
    const auth = requireRequestAuth(request);
    const context = workspaceContext(request);
    await this.entries.remove(context.workspaceId, auth.userId, entryId, ifMatch);
    return { data: { status: 'deleted' } };
  }
}
