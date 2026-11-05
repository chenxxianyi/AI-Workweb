import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiException } from '../../common/api-exception.js';

export const searchQuerySchema = z.strictObject({
  q: z.string().trim().min(1).refine((value) => [...value].length <= 100, '最多100个字符'),
  status: z.enum(['draft', 'verified', 'archived']).optional(),
  type: z.enum(['note', 'design', 'adr', 'troubleshoot', 'command']).optional(),
  projectId: z.uuid().optional(),
  tag: z.string().trim().min(1).max(32).transform((value) => value.toLowerCase()).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(4096).optional(),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

const cursorSchema = z.strictObject({
  v: z.literal(1), s: z.number(), u: z.iso.datetime(), i: z.uuid(),
  a: z.iso.datetime(), f: z.string().regex(/^[a-f0-9]{64}$/),
});

export function searchFingerprint(workspaceId: string, query: SearchQuery): string {
  return createHash('sha256').update(JSON.stringify({
    workspaceId, q: query.q.toLowerCase(), status: query.status ?? null,
    type: query.type ?? null, projectId: query.projectId ?? null,
    tag: query.tag ?? null, limit: query.limit,
  })).digest('hex');
}

export function decodeSearchCursor(raw: string | undefined, fingerprint: string): z.infer<typeof cursorSchema> | null {
  if (raw === undefined) return null;
  try {
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
    const age = Date.now() - Date.parse(cursor.a);
    if (cursor.f !== fingerprint || age < -60_000 || age > 15 * 60_000) throw new Error('scope or expiry');
    return cursor;
  } catch {
    throw new ApiException('MALFORMED_REQUEST', '搜索游标无效、已过期或筛选条件已改变，请从第一页重新查询');
  }
}

export function encodeSearchCursor(score: number, updatedAt: Date, id: string, asOf: Date, fingerprint: string): string {
  return Buffer.from(JSON.stringify({ v: 1, s: score, u: updatedAt.toISOString(), i: id, a: asOf.toISOString(), f: fingerprint })).toString('base64url');
}

export function escapeLike(term: string): string {
  return term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}
