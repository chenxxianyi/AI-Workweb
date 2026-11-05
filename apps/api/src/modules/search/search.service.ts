import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { ApiException } from '../../common/api-exception.js';
import { PrismaService } from '../../common/prisma.module.js';
import {
  decodeSearchCursor, encodeSearchCursor, escapeLike, searchFingerprint,
  searchQuerySchema, type SearchQuery,
} from './search-query.js';
import type { EntryStatus, EntryType } from '../../generated/prisma/enums.js';
export { escapeLike } from './search-query.js';

export interface EntrySearchHit {
  id: string; title: string; summary: string | null; type: EntryType; status: EntryStatus;
  tags: string[]; score: number; updatedAt: string;
}
export interface EntrySearchResult {
  hits: EntrySearchHit[]; nextCursor: string | null; hasMore: boolean; tookMs: number;
}

/** All candidate, hydration and relation queries enforce the workspace and soft-delete boundary. */
@Injectable()
export class SearchService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async searchEntries(workspaceId: string, input: Omit<SearchQuery, 'limit'> & { limit?: number }): Promise<EntrySearchResult> {
    const started = Date.now();
    const parsed = searchQuerySchema.safeParse(input);
    if (!parsed.success) throw new ApiException('VALIDATION_FAILED', '搜索参数无效');
    const query = parsed.data;
    const fingerprint = searchFingerprint(workspaceId, query);
    const cursor = decodeSearchCursor(query.cursor, fingerprint);
    const asOf = cursor === null ? new Date() : new Date(cursor.a);
    const like = '%' + escapeLike(query.q) + '%';
    const prefix = escapeLike(query.q) + '%';
    const tagMatch = Prisma.sql`EXISTS (
      SELECT 1 FROM entry_tags et JOIN tags t ON t.id = et.tag_id AND t.workspace_id = et.workspace_id
      WHERE et.entry_id = e.id AND et.workspace_id = e.workspace_id
        AND t.name_normalized ILIKE ${like} ESCAPE '\\'
    )`;
    const conditions = [
      Prisma.sql`e.workspace_id = ${workspaceId}::uuid`,
      Prisma.sql`e.deleted_at IS NULL`,
      Prisma.sql`(e.title ILIKE ${like} ESCAPE '\\'
        OR coalesce(e.summary, '') ILIKE ${like} ESCAPE '\\'
        OR e.body ILIKE ${like} ESCAPE '\\' OR ${tagMatch})`,
    ];
    if (query.status !== undefined) conditions.push(Prisma.sql`e.status = ${query.status}::entry_status`);
    if (query.type !== undefined) conditions.push(Prisma.sql`e.type = ${query.type}::entry_type`);
    if (query.projectId !== undefined) conditions.push(Prisma.sql`e.project_id = ${query.projectId}::uuid`);
    if (query.tag !== undefined) conditions.push(Prisma.sql`EXISTS (
      SELECT 1 FROM entry_tags et JOIN tags t ON t.id = et.tag_id AND t.workspace_id = et.workspace_id
      WHERE et.entry_id = e.id AND et.workspace_id = e.workspace_id AND t.name_normalized = ${query.tag}
    )`);
    const score = Prisma.sql`(
      (CASE WHEN lower(e.title) = lower(${query.q}) THEN 100
        WHEN e.title ILIKE ${prefix} ESCAPE '\\' THEN 80
        WHEN e.title ILIKE ${like} ESCAPE '\\' THEN 60
        WHEN ${tagMatch} THEN 40
        WHEN coalesce(e.summary, '') ILIKE ${like} ESCAPE '\\' THEN 20 ELSE 10 END
      + CASE WHEN u.last_used_at >= ${asOf}::timestamptz - interval '7 days' THEN 2 ELSE 0 END
      + LEAST(coalesce(u.use_count, 0), 10) * 0.2
      + CASE WHEN e.updated_at >= ${asOf}::timestamptz - interval '7 days' THEN 1 ELSE 0 END)
      * CASE WHEN e.status = 'archived' THEN 0.5 ELSE 1 END
    )`;
    const cursorSql = cursor === null ? Prisma.empty : Prisma.sql`
      WHERE (score, updated_at, id) < (${cursor.s}::numeric, ${new Date(cursor.u)}::timestamptz, ${cursor.i}::uuid)`;
    const rows = await this.prisma.db.$queryRaw<{ id: string; score: number; updated_at: Date }[]>(Prisma.sql`
      WITH ranked AS (
        SELECT e.id, e.updated_at, ${score} AS score FROM entries e
        LEFT JOIN entry_usage u ON u.entry_id = e.id AND u.workspace_id = e.workspace_id
        WHERE ${Prisma.join(conditions, ' AND ')}
      )
      SELECT id, score, updated_at FROM ranked ${cursorSql}
      ORDER BY score DESC, updated_at DESC, id DESC LIMIT ${query.limit + 1}
    `);
    const page = rows.slice(0, query.limit);
    const entries = await this.prisma.db.entry.findMany({
      where: { workspaceId, deletedAt: null, id: { in: page.map((row) => row.id) } },
      include: { tags: { where: { workspaceId }, include: { tag: true } } },
    });
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const hits = page.flatMap((row): EntrySearchHit[] => {
      const entry = byId.get(row.id);
      return entry === undefined ? [] : [{
        id: entry.id, title: entry.title, summary: entry.summary, type: entry.type, status: entry.status,
        tags: entry.tags.map((tag) => tag.tag.displayName).sort(),
        score: Number(row.score), updatedAt: entry.updatedAt.toISOString(),
      }];
    });
    const last = page.at(-1);
    const hasMore = rows.length > query.limit;
    return {
      hits, hasMore, tookMs: Date.now() - started,
      nextCursor: hasMore && last !== undefined
        ? encodeSearchCursor(Number(last.score), last.updated_at, last.id, asOf, fingerprint) : null,
    };
  }

  async related(workspaceId: string, entryId: string): Promise<EntrySearchHit[]> {
    const entry = await this.prisma.db.entry.findFirst({ where: { workspaceId, id: entryId, deletedAt: null } });
    if (entry === null) throw new ApiException('NOT_FOUND', '知识条目不存在');
    const candidates = await this.prisma.db.$queryRaw<{ id: string; shared: bigint }[]>(Prisma.sql`
      SELECT e.id, count(*) AS shared
      FROM entry_tags own_tags JOIN entry_tags common_tags
        ON common_tags.tag_id = own_tags.tag_id AND common_tags.workspace_id = own_tags.workspace_id
      JOIN entries e ON e.id = common_tags.entry_id AND e.workspace_id = common_tags.workspace_id
      WHERE own_tags.workspace_id = ${workspaceId}::uuid AND own_tags.entry_id = ${entryId}::uuid
        AND e.id <> ${entryId}::uuid AND e.deleted_at IS NULL
      GROUP BY e.id ORDER BY shared DESC, e.updated_at DESC, e.id DESC LIMIT 3
    `);
    const entries = await this.prisma.db.entry.findMany({
      where: { workspaceId, deletedAt: null, id: { in: candidates.map((row) => row.id) } },
      include: { tags: { where: { workspaceId }, include: { tag: true } } },
    });
    return candidates.flatMap((row) => {
      const found = entries.find((candidate) => candidate.id === row.id);
      return found === undefined ? [] : [{
        id: found.id, title: found.title, summary: found.summary, type: found.type, status: found.status,
        tags: found.tags.map((tag) => tag.tag.displayName).sort(),
        score: Number(row.shared), updatedAt: found.updatedAt.toISOString(),
      }];
    });
  }

  async organize(workspaceId: string): Promise<{ top: EntrySearchHit[]; overdueDrafts: number; staleEntries: number }> {
    const workspace = await this.prisma.db.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    const counts = await this.prisma.db.$queryRaw<{ drafts: bigint; stale: bigint }[]>(Prisma.sql`
      SELECT count(*) FILTER (WHERE e.status = 'draft'
        AND (now() AT TIME ZONE ${workspace.timezone})::date - (e.created_at AT TIME ZONE ${workspace.timezone})::date > 7) AS drafts,
      count(*) FILTER (WHERE e.status IN ('draft','verified')
        AND (now() AT TIME ZONE ${workspace.timezone})::date
          - (coalesce(u.last_used_at, e.created_at) AT TIME ZONE ${workspace.timezone})::date >= 30) AS stale
      FROM entries e LEFT JOIN entry_usage u ON u.entry_id = e.id AND u.workspace_id = e.workspace_id
      WHERE e.workspace_id = ${workspaceId}::uuid AND e.deleted_at IS NULL
    `);
    const usages = await this.prisma.db.entryUsage.findMany({
      where: { workspaceId, entry: { deletedAt: null, workspaceId } },
      orderBy: [{ useCount: 'desc' }, { lastUsedAt: 'desc' }, { entryId: 'desc' }], take: 5,
      include: { entry: { include: { tags: { where: { workspaceId }, include: { tag: true } } } } },
    });
    return {
      overdueDrafts: Number(counts[0]?.drafts ?? 0), staleEntries: Number(counts[0]?.stale ?? 0),
      top: usages.map(({ entry, useCount }) => ({
        id: entry.id, title: entry.title, summary: entry.summary, type: entry.type, status: entry.status,
        tags: entry.tags.map((tag) => tag.tag.displayName).sort(), score: useCount,
        updatedAt: entry.updatedAt.toISOString(),
      })),
    };
  }
}
