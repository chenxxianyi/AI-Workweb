import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { ZodPipe } from '../../common/zod.pipe.js';
import { assertIdempotencyKey } from '../../common/idempotency.js';
import { requireRequestAuth } from '../auth/auth-context.js';
import { WorkspaceRoleRequired } from '../workspaces/permissions.js';
import { workspaceContext } from '../workspaces/workspace.guard.js';
import { LedgerService, type LedgerView } from './ledger.service.js';

/**
 * 请求体使用 strictObject：出现 `authorId` 等未知字段会 422，
 * 因此无法伪造作者（作者始终取会话用户）。
 */
const createSchema = z.strictObject({
  recordDate: z.string().max(10),
  projectId: z.uuid().nullish(),
  entryId: z.uuid().nullish(),
  tool: z.string().max(32),
  scene: z.string().max(32),
  minutes: z.number().int(),
  savedMinutes: z.number().int().nullish(),
  effect: z.number().int(),
  note: z.string().max(4000).nullish(),
});

const updateSchema = createSchema.partial();

/** AI使用台账（F26）*/
@Controller('workspaces/:workspaceId/ledger')
export class LedgerController {
  constructor(@Inject(LedgerService) private readonly ledger: LedgerService) {}

  @Get()
  async list(
    @Req() request: Request,
    @Query('projectId') projectId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('tool') tool?: string,
    @Query('scene') scene?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<{ data: Awaited<ReturnType<LedgerService['list']>> }> {
    const context = workspaceContext(request);
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    return {
      data: await this.ledger.list(context.workspaceId, {
        ...(projectId === undefined ? {} : { projectId }),
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to }),
        ...(tool === undefined ? {} : { tool }),
        ...(scene === undefined ? {} : { scene }),
        ...(parsedLimit === undefined || Number.isNaN(parsedLimit) ? {} : { limit: parsedLimit }),
        ...(cursor === undefined ? {} : { cursor }),
      }),
    };
  }

  @Get('summary')
  async summary(
    @Req() request: Request,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('projectId') projectId?: string,
  ): Promise<{ data: Awaited<ReturnType<LedgerService['summary']>> }> {
    const context = workspaceContext(request);
    return {
      data: await this.ledger.summary(context.workspaceId, {
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to }),
        ...(projectId === undefined ? {} : { projectId }),
      }),
    };
  }

  @Post()
  @HttpCode(201)
  @WorkspaceRoleRequired('business.write')
  async create(
    @Req() request: Request,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodPipe(createSchema)) body: z.infer<typeof createSchema>,
  ): Promise<{ data: { record: LedgerView; replayed: boolean } }> {
    const auth = requireRequestAuth(request);
    const context = workspaceContext(request);
    return {
      data: await this.ledger.create(
        context.workspaceId,
        auth.userId,
        {
          recordDate: body.recordDate,
          tool: body.tool,
          scene: body.scene,
          minutes: body.minutes,
          effect: body.effect,
          ...(body.projectId === undefined ? {} : { projectId: body.projectId }),
          ...(body.entryId === undefined ? {} : { entryId: body.entryId }),
          ...(body.savedMinutes === undefined ? {} : { savedMinutes: body.savedMinutes }),
          ...(body.note === undefined ? {} : { note: body.note }),
        },
        assertIdempotencyKey(idempotencyKey),
      ),
    };
  }

  @Get(':recordId')
  async detail(
    @Req() request: Request,
    @Param('recordId') recordId: string,
  ): Promise<{ data: LedgerView }> {
    const context = workspaceContext(request);
    return { data: await this.ledger.get(context.workspaceId, recordId) };
  }

  @Patch(':recordId')
  @WorkspaceRoleRequired('business.write')
  async update(
    @Req() request: Request,
    @Param('recordId') recordId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodPipe(updateSchema)) body: z.infer<typeof updateSchema>,
  ): Promise<{ data: LedgerView }> {
    const auth = requireRequestAuth(request);
    const context = workspaceContext(request);
    return {
      data: await this.ledger.update(context.workspaceId, auth.userId, recordId, ifMatch, body),
    };
  }

  @Delete(':recordId')
  @HttpCode(200)
  @WorkspaceRoleRequired('business.write')
  async remove(
    @Req() request: Request,
    @Param('recordId') recordId: string,
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<{ data: { status: 'deleted' } }> {
    const auth = requireRequestAuth(request);
    const context = workspaceContext(request);
    await this.ledger.remove(context.workspaceId, auth.userId, recordId, ifMatch);
    return { data: { status: 'deleted' } };
  }
}
