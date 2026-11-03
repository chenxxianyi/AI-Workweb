import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { ApiException } from '../../common/api-exception.js';
import { PrismaService } from '../../common/prisma.module.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { EntryStatus, EntryType } from '../../generated/prisma/enums.js';

/**
 * 知识搜索（F22）。
 *
 * 排序模型（契约 C-24）：
 *   文本权重：标题 100 / 摘要 60 / 正文 30
 *   状态权重：已验证 +6 / 草稿 +3 / 已归档 -10（降权但不隐藏）
 *   新鲜度：最近 30 天内每天 +0.1（最多 +3）
 * 硬性约束：
 *   - **必须先有文本命中**（WHERE 里包含三段 ILIKE 的 OR），因此“热门但无关”的条目
 *     不可能靠使用次数进入结果（F22-02）
 *   - 查询词参数化并转义 `%` `_` `\`，用户输入不会被当成通配符（F22-02 安全通配）
 *   - 大小写不敏感（ILIKE），中文子串直接匹配（无需分词）
 *   - 全部以 workspace_id 限定，跨空间不可见
 *
 * 性能：先测 ILIKE 全表扫描；1 万条下 p95 若在预算内则不引入 pg_trgm（见验收证据的 EXPLAIN）。
 */

const SEARCH_LIMIT_MAX = 50;
const DEFAULT_LIMIT = 20;

export interface EntrySearchOptions {
  q: string;
  status?: EntryStatus;
  type?: EntryType;
  projectId?: string;
  tag?: string;
  limit?: number;
  cursor?: string;
}

export interface EntrySearchHit {
  id: string;
  title: string;
  summary: string | null;
  type: EntryType;
  status: EntryStatus;
  tags: string[];
  score: number;
  updatedAt: string;
}

export interface EntrySearchResult {
  hits: EntrySearchHit[];
  nextCursor: string | null;
  hasMore: boolean;
  tookMs: number;
}

/** 转义 LIKE 元字符，避免用户输入 `%` `_` 变成通配符 */
export function escapeLike(term: string): string {
  return term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function encodeCursor(score: number, updatedAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ s: score, u: updatedAt.toISOString(), i: id }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): { score: number; updatedAt: Date; id: string } | null {
  if (cursor === undefined || cursor === '') return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      s?: number;
      u?: string;
      i?: string;
    };
    if (typeof parsed.s !== 'number' || typeof parsed.u !== 'string' || typeof parsed.i !== 'string') return null;
    return { score: parsed.s, updatedAt: new Date(parsed.u), id: parsed.i };
  } catch {
    throw new ApiException('MALFORMED_REQUEST', '搜索游标无效');
  }
}

@Injectable()
export class SearchService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private get db(): PrismaClient {
    return this.prisma.db;
  }

  async searchEntries(workspaceId: string, options: EntrySearchOptions): Promise<EntrySearchResult> {
    const started = Date.now();
    const q = options.q.trim();
    if (q === '') {
      throw new ApiException('VALIDATION_FAILED', '搜索词不能为空', { fieldErrors: { q: ['不能为空'] } });
    }
    if ([...q].length > 100) {
      throw new ApiException('VALIDATION_FAILED', '搜索词最多 100 个字符', { fieldErrors: { q: ['最多 100 个字符'] } });
    }

    const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), SEARCH_LIMIT_MAX);
    const cursor = decodeCursor(options.cursor);
    const like = `%${escapeLike(q)}%`;

    const conditions: Prisma.Sql[] = [
      Prisma.sql`workspace_id = ${workspaceId}::uuid`,
      Prisma.sql`deleted_at IS NULL`,
      Prisma.sql`(
        title ILIKE ${like} ESCAPE '\\'
        OR coalesce(summary, '') ILIKE ${like} ESCAPE '\\'
        OR body ILIKE ${like} ESCAPE '\\'
      )`,
    ];
    if (options.status !== undefined) conditions.push(Prisma.sql`status = ${options.status}::entry_status`);
    if (options.type !== undefined) conditions.push(Prisma.sql`type = ${options.type}::entry_type`);
    if (options.projectId !== undefined) conditions.push(Prisma.sql`project_id = ${options.projectId}::uuid`);
    if (options.tag !== undefined && options.tag !== '') {
      conditions.push(
        Prisma.sql`EXISTS (
          SELECT 1 FROM entry_tags et JOIN tags t ON t.id = et.tag_id
          WHERE et.entry_id = entries.id AND t.name_normalized = ${options.tag.trim().toLowerCase()}
        )`,
      );
    }

    const whereSql = Prisma.join(conditions, ' AND ');
    const scoreSql = Prisma.sql`(
      CASE
        WHEN title ILIKE ${like} ESCAPE '\\' THEN 100
        WHEN coalesce(summary, '') ILIKE ${like} ESCAPE '\\' THEN 60
        ELSE 30
      END
      + CASE status WHEN 'verified' THEN 6 WHEN 'draft' THEN 3 ELSE -10 END
      + LEAST(GREATEST(EXTRACT(EPOCH FROM (now() - updated_at)) / 86400.0, 0), 30) * 0.1
    )`;

    const cursorSql =
      cursor === null
        ? Prisma.empty
        : Prisma.sql`WHERE (score, updated_at, id) < (${cursor.score}::numeric, ${cursor.updatedAt}::timestamptz, ${cursor.id}::uuid)`;

    const rows = await this.db.$queryRaw<{ id: string; score: number; updated_at: Date }[]>(Prisma.sql`
      WITH ranked AS (
        SELECT id, updated_at, ${scoreSql} AS score
        FROM entries
        WHERE ${whereSql}
      )
      SELECT id, score, updated_at FROM ranked
      ${cursorSql}
      ORDER BY score DESC, updated_at DESC, id DESC
      LIMIT ${limit + 1}
    `);

    const page = rows.slice(0, limit);
    const ids = page.map((row) => row.id);
    const entries = ids.length === 0 ? [] : await this.db.entry.findMany({ where: { id: { in: ids } } });
    const tags = await this.tagsOf(ids);
    const byId = new Map(entries.map((entry) => [entry.id, entry]));

    const hits: EntrySearchHit[] = page.flatMap((row) => {
      const entry = byId.get(row.id);
      if (entry === undefined) return [];
      return [
        {
          id: entry.id,
          title: entry.title,
          summary: entry.summary,
          type: entry.type,
          status: entry.status,
          tags: tags.get(entry.id) ?? [],
          score: Math.round(Number(row.score) * 100) / 100,
          updatedAt: entry.updatedAt.toISOString(),
        },
      ];
    });

    const last = page.at(-1);
    return {
      hits,
      hasMore: rows.length > limit,
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeCursor(Number(last.score), last.updated_at, last.id)
          : null,
      tookMs: Date.now() - started,
    };
  }

  private async tagsOf(entryIds: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (entryIds.length === 0) return map;
    const rows = await this.db.entryTag.findMany({
      where: { entryId: { in: entryIds } },
      select: { entryId: true, tag: { select: { displayName: true } } },
    });
    for (const row of rows) {
      const list = map.get(row.entryId) ?? [];
      list.push(row.tag.displayName);
      map.set(row.entryId, list);
    }
    return map;
  }

  /** 供验收／运维使用的执行计划说明（只读，不返回数据） */
  async explainSearch(workspaceId: string, q: string): Promise<string> {
    const like = `%${escapeLike(q)}%`;
    const rows = await this.db.$queryRaw<{ "QUERY PLAN": unknown }[]>(Prisma.sql`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
      SELECT id FROM entries
      WHERE workspace_id = ${workspaceId}::uuid
        AND deleted_at IS NULL
        AND (title ILIKE ${like} ESCAPE '\\' OR coalesce(summary, '') ILIKE ${like} ESCAPE '\\' OR body ILIKE ${like} ESCAPE '\\')
      ORDER BY updated_at DESC
      LIMIT 20
    `);
    return rows.map((row) => String(row['QUERY PLAN'])).join('\n');
  }
}
