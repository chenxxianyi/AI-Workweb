import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { ZodPipe } from '../../common/zod.pipe.js';
import { RateLimit } from '../../common/rate-limit.js';
import { workspaceContext } from '../workspaces/workspace.guard.js';
import { SearchService, type EntrySearchResult } from './search.service.js';
import { searchQuerySchema, type SearchQuery } from './search-query.js';

@Controller('workspaces/:workspaceId/search')
export class SearchController {
  constructor(@Inject(SearchService) private readonly search: SearchService) {}

  @Get('entries')
  @RateLimit({ limit: { fromConfig: 'RATE_LIMIT_SEARCH_PER_MINUTE' }, ttlMs: 60_000 })
  async entries(@Req() request: Request, @Query(new ZodPipe(searchQuerySchema)) query: SearchQuery): Promise<{ data: EntrySearchResult }> {
    return { data: await this.search.searchEntries(workspaceContext(request).workspaceId, query) };
  }

  @Get('related/:entryId')
  async related(@Req() request: Request, @Param('entryId', new ZodPipe(z.uuid())) entryId: string): Promise<{ data: Awaited<ReturnType<SearchService['related']>> }> {
    return { data: await this.search.related(workspaceContext(request).workspaceId, entryId) };
  }

  @Get('organize')
  async organize(@Req() request: Request): Promise<{ data: Awaited<ReturnType<SearchService['organize']>> }> {
    return { data: await this.search.organize(workspaceContext(request).workspaceId) };
  }
}
