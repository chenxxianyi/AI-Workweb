import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { RateLimit } from '../../common/rate-limit.js';
import { workspaceContext } from '../workspaces/workspace.guard.js';
import { SearchService, type EntrySearchResult } from './search.service.js';

/**
 * 知识搜索（F22）。
 * 读操作，任意空间成员可用；按 `RATE_LIMIT_SEARCH_PER_MINUTE` 限流。
 */
@Controller('workspaces/:workspaceId/search')
export class SearchController {
  constructor(@Inject(SearchService) private readonly search: SearchService) {}

  @Get('entries')
  @RateLimit({ limit: { fromConfig: 'RATE_LIMIT_SEARCH_PER_MINUTE' }, ttlMs: 60_000 })
  async entries(
    @Req() request: Request,
    @Query('q') q?: string,
    @Query('status') status?: string,
    @Query('type') type?: string,
    @Query('projectId') projectId?: string,
    @Query('tag') tag?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<{ data: EntrySearchResult }> {
    const context = workspaceContext(request);
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    return {
      data: await this.search.searchEntries(context.workspaceId, {
        q: q ?? '',
        ...(status === 'draft' || status === 'verified' || status === 'archived' ? { status } : {}),
        ...(type === 'note' || type === 'design' || type === 'adr' || type === 'troubleshoot' || type === 'command'
          ? { type }
          : {}),
        ...(projectId === undefined ? {} : { projectId }),
        ...(tag === undefined ? {} : { tag }),
        ...(parsedLimit === undefined || Number.isNaN(parsedLimit) ? {} : { limit: parsedLimit }),
        ...(cursor === undefined ? {} : { cursor }),
      }),
    };
  }
}
