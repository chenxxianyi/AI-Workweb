import { Module } from '@nestjs/common';
import { SearchController } from './search.controller.js';
import { SearchService } from './search.service.js';

/** 搜索模块（F22）。F23 的全局搜索会复用 SearchService。 */
@Module({
  controllers: [SearchController],
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchModule {}
