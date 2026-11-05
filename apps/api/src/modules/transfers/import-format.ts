import { z } from 'zod';
import { createHash } from 'node:crypto';
import { isValidDate } from '@aiwb/domain';
import { ApiException } from '../../common/api-exception.js';
import { normalizeTag } from '../entries/entry.service.js';
export const types = ['project', 'task', 'entry', 'log', 'ledger'] as const;
export type EntityType = (typeof types)[number];
export const tables = {
  project: 'projects',
  task: 'tasks',
  entry: 'entries',
  log: 'logs',
  ledger: 'ledger',
} as const;
const id = z.string().min(1).max(200),
  text = (n: number) => z.string().max(n),
  date = z.string().refine(isValidDate),
  optionalDate = date.nullable().default(null);
const body = z.string().refine((v) => Buffer.byteLength(v, 'utf8') <= 20480, '正文超过20480字节');
const timestamp = z.string().datetime({ offset: true });
const common = {
  id,
  updatedAt: timestamp,
  createdAt: timestamp,
  deletedAt: timestamp.nullable().default(null),
  originMetadata: z.record(z.string(), z.unknown()).nullish(),
};
const project = z
  .object({
    ...common,
    name: text(100).min(1),
    repo: text(300).nullable().default(null),
    stack: z.array(text(100)).max(50).default([]),
    stage: z.enum(['planning', 'developing', 'paused', 'done']),
    nextStep: text(300),
    progressManual: z.boolean().default(false),
    manualProgress: z.number().int().min(0).max(100).nullable().default(null),
    color: text(16).nullable().default(null),
    archivedAt: timestamp.nullable().default(null),
  })
  .refine((v) => v.progressManual ? v.manualProgress !== null : v.manualProgress === null, '进度模式与手动数值不一致');
const task = z
  .object({
    ...common,
    title: text(200).min(1),
    projectId: id.nullable().default(null),
    priority: z.enum(['p0', 'p1', 'p2']),
    status: z.enum(['todo', 'doing', 'done']),
    dueDate: optionalDate,
    aiContext: text(4000).nullable().default(null),
    blocker: text(4000).nullable().default(null),
    doneAt: timestamp.nullable().default(null),
    entryIds: z.array(id).max(250000).default([]),
  })
  .refine((v) => (v.status === 'done') === (v.doneAt !== null), '任务状态与doneAt不一致');
const entry = z
  .object({
    ...common,
    title: text(200),
    summary: text(300).nullable().default(null),
    body,
    type: z.enum(['note', 'design', 'adr', 'troubleshoot', 'command']),
    status: z.enum(['draft', 'verified', 'archived']),
    lang: text(32).nullable().default(null),
    source: text(32).nullable().default(null),
    rating: z.number().int().min(1).max(5).nullable().default(null),
    projectId: id.nullable().default(null),
    tags: z.array(text(32).min(1)).max(10).default([]),
    usage: z
      .object({ useCount: z.number().int().min(0).max(2147483647), lastUsedAt: timestamp })
      .nullable()
      .default(null),
    revisions: z
      .array(
        z.object({ body, savedAt: timestamp, sourceVersion: z.number().int().min(1).default(1) }),
      )
      .max(5)
      .default([]),
  })
  .refine(
    (v) => v.status !== 'verified' || !!(v.title.trim() && v.summary?.trim() && v.body.trim()),
    '已验证知识需要标题摘要正文',
  );
const log = z.object({ ...common, logDate: date, text: text(4000).min(1) });
const ledger = z.object({
  ...common,
  recordDate: date,
  projectId: id.nullable().default(null),
  entryId: id.nullable().default(null),
  tool: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  scene: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  minutes: z.number().int().min(1).max(1440),
  savedMinutes: z.number().int().min(0).max(1440),
  effect: z.number().int().min(1).max(5),
  note: text(4000).nullable().default(null),
});
export const schemas = { project, task, entry, log, ledger };
export type Payload = { [K in EntityType]: z.infer<(typeof schemas)[K]> }[EntityType];
export function deterministicId(
  workspaceId: string,
  namespace: string,
  type: string,
  legacyId: string,
) {
  const h = createHash('sha256')
    .update(JSON.stringify([workspaceId, namespace, type, legacyId]))
    .digest();
  h[6] = (h[6]! & 15) | 80;
  h[8] = (h[8]! & 63) | 128;
  const s = h.toString('hex').slice(0, 32);
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
const iso = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v)
    ? new Date(v * 1000).toISOString()
    : typeof v === 'string'
      ? v
      : '1970-01-01T00:00:00.000Z';
const nullable = (v: unknown) => (v === '' || v === undefined ? null : v);
export function normalize(
  type: EntityType,
  raw: unknown,
  version: 1 | 2,
  occurrences: Map<string, number>,
): Payload {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new ApiException('VALIDATION_FAILED', '实体必须为对象');
  const r = { ...raw } as Record<string, unknown>;
  r['createdAt'] = iso(r['createdAt']);
  r['updatedAt'] = iso(r['updatedAt']);
  if (version === 1) {
    for (const key of [
      'projectId',
      'entryId',
      'dueDate',
      'summary',
      'repo',
      'lang',
      'source',
      'color',
      'note',
      'aiContext',
      'blocker',
      'rating',
    ])
      if (key in r) r[key] = nullable(r[key]);
    if (type === 'project') {
      r['stage'] =
        (
          {
            构思: 'planning',
            开发: 'developing',
            维护: 'developing',
            暂停: 'paused',
            归档: 'done',
          } as Record<string, string>
        )[String(r['stage'])] ?? r['stage'];
      r['nextStep'] ??= '';
      if (r['progressManual']) r['manualProgress'] = r['progress'];
    }
    if (type === 'task') {
      r['priority'] = String(r['priority'] ?? 'p2').toLowerCase();
      r['dueDate'] = nullable(r['due']);
      r['doneAt'] = r['doneAt'] ? iso(r['doneAt']) : null;
      if(r['status']==='done'&&!r['doneAt'])r['doneAt']=r['updatedAt'];
    }
    if (type === 'entry') {
      const legacyType = r['type'];
      r['type'] =
        (
          {
            prompt: 'note',
            snippet: 'command',
            pitfall: 'troubleshoot',
            decision: 'adr',
          } as Record<string, string>
        )[String(legacyType)] ?? legacyType;
      r['status'] = r['status'] === 'deprecated' ? 'archived' : r['status'];
      r['originMetadata'] = { ...((r['originMetadata'] as object) ?? {}), legacyType };
      r['usage'] = { useCount: r['useCount'] ?? 0, lastUsedAt: iso(r['lastUsedAt']) };
      r['revisions'] = Array.isArray(r['revisions'])
        ? r['revisions'].map((v: { body: string; at: number }) => ({
            body: v.body,
            savedAt: iso(v.at),
            sourceVersion: 1,
          }))
        : [];
    }
    if (type === 'log') {
      r['logDate'] = r['date'];
      r['createdAt'] = iso(r['at']);
      r['updatedAt'] = iso(r['at']);
      if (!r['id']) {
        const hash = createHash('sha256')
          .update(JSON.stringify([r['date'], r['text'], r['at'] ?? 0]))
          .digest('hex');
        const count = occurrences.get(hash) ?? 0;
        occurrences.set(hash, count + 1);
        r['id'] = 'log:' + hash + ':' + count;
      }
    }
    if (type === 'ledger') {
      r['recordDate'] = r['date'];
      r['savedMinutes'] ??= r['minutes'];
      r['scene'] =
        (
          {
            读代码: 'research',
            写功能: 'coding',
            调试: 'debug',
            重构: 'coding',
            测试: 'review',
            文档: 'docs',
            学习: 'research',
          } as Record<string, string>
        )[String(r['scene'])] ?? r['scene'];
    }
  }
  if (type === 'entry' && Array.isArray(r['tags']))
    r['tags'] = [...new Set(r['tags'].map((v) => normalizeTag(String(v))))];
  const parsed = schemas[type].safeParse(r);
  if (!parsed.success)
    throw new ApiException('VALIDATION_FAILED', type + '实体格式错误', {
      details: {
        issues: parsed.error.issues
          .map((i) => ({ path: i.path.join('.'), message: i.message }))
          .slice(0, 10),
      },
    });
  return parsed.data;
}
