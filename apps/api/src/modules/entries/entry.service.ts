import { Inject, Injectable } from '@nestjs/common';
import { parseEtag } from '@aiwb/contracts';
import { ApiException } from '../../common/api-exception.js';
import { PrismaService } from '../../common/prisma.module.js';
import { runIdempotent } from '../../common/idempotency.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { EntryStatus, EntryType } from '../../generated/prisma/enums.js';
import { ProjectService } from '../projects/project.service.js';

/**
 * 知识条目（F19）。
 *
 * 状态机（契约 C-22）：
 *   draft → verified   （要求标题、摘要、正文齐全）
 *   verified → draft   （允许降级，便于返工）
 *   draft/verified → archived
 *   archived → draft   （恢复）
 * 其余转换（含原地转换、archived → verified）一律 422 `ENTRY_STATE_INVALID`。
 *
 * 正文上限 20480 字节（UTF-8，按字节而非字符），超出 → 413 `PAYLOAD_TOO_LARGE`。
 * 草稿允许标题/摘要/正文为空，方便先记录再补；转 verified 时统一校验。
 * 标签按空间内名称归一化去重（小写、去空白、≤32 字），每条最多 10 个。
 * 正文变更会把上一版正文写入 entry_revisions，便于回溯。
 */
const BODY_LIMIT_BYTES = 20480;
const MAX_TAGS = 10;
/** 每个条目保留的正文修订条数（F21：7 次修改只留最近 5 版） */
const REVISION_KEEP = 5;
const MAX_TAG_LENGTH = 32;

export interface EntryInput {
  type?: EntryType;
  title?: string;
  summary?: string | null;
  body?: string;
  lang?: string | null;
  projectId?: string | null;
  source?: string | null;
  rating?: number | null;
  tags?: string[];
}

export interface EntryView {
  taskLinks?: { id: string; title: string }[];
  id: string;
  type: EntryType;
  title: string;
  summary: string | null;
  body: string;
  lang: string | null;
  projectId: string | null;
  source: string | null;
  status: EntryStatus;
  rating: number | null;
  tags: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
  bodyBytes: number;
}

const TRANSITIONS: Record<EntryStatus, EntryStatus[]> = {
  draft: ['verified', 'archived'],
  verified: ['draft', 'archived'],
  archived: ['draft'],
};

function requireIfMatch(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === '') {
    throw new ApiException('PRECONDITION_REQUIRED', '缺少 If-Match，请携带当前版本号');
  }
  const version = parseEtag(raw);
  if (version === null) {
    throw new ApiException('PRECONDITION_REQUIRED', 'If-Match 格式不正确，请携带当前版本号');
  }
  return version;
}

export function normalizeTag(raw: string): string {
  return raw.trim().replace(/^#+/, '').replace(/\s+/g, ' ').toLowerCase();
}

function assertBodyBytes(body: string): void {
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > BODY_LIMIT_BYTES) {
    throw new ApiException(
      'PAYLOAD_TOO_LARGE',
      `正文最多 ${BODY_LIMIT_BYTES} 字节（当前 ${bytes} 字节）`,
      {
        fieldErrors: { body: [`最多 ${BODY_LIMIT_BYTES} 字节`] },
      },
    );
  }
}

function assertTags(tags: string[] | undefined): string[] {
  if (tags === undefined) return [];
  if (tags.length > MAX_TAGS) {
    throw new ApiException('VALIDATION_FAILED', `标签最多 ${MAX_TAGS} 个`, {
      fieldErrors: { tags: [`最多 ${MAX_TAGS} 个`] },
    });
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const normalized = normalizeTag(raw);
    if (normalized === '') continue;
    if ([...normalized].length > MAX_TAG_LENGTH) {
      throw new ApiException('VALIDATION_FAILED', `标签最多 ${MAX_TAG_LENGTH} 个字符`, {
        fieldErrors: { tags: [`每个标签最多 ${MAX_TAG_LENGTH} 个字符`] },
      });
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

@Injectable()
export class EntryService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ProjectService) private readonly projects: ProjectService,
  ) {}

  private get db(): PrismaClient {
    return this.prisma.db;
  }

  async usage(
    workspaceId: string,
    entryId: string,
  ): Promise<{ useCount: number; lastUsedAt: string | null }> {
    const entry = await this.db.entry.findFirst({
      where: { workspaceId, id: entryId, deletedAt: null },
    });
    if (entry === null) throw new ApiException('NOT_FOUND', '知识条目不存在');
    const usage = await this.db.entryUsage.findUnique({
      where: { workspaceId_entryId: { workspaceId, entryId } },
    });
    return { useCount: usage?.useCount ?? 0, lastUsedAt: usage?.lastUsedAt.toISOString() ?? null };
  }

  async recordUsage(workspaceId: string, userId: string, entryId: string, key: string) {
    return runIdempotent(
      this.db,
      { workspaceId, userId, scope: 'entry.usage:' + entryId, key, body: { entryId } },
      async (tx) => {
        const entry = await tx.entry.findFirst({
          where: { workspaceId, id: entryId, deletedAt: null },
        });
        if (entry === null) throw new ApiException('NOT_FOUND', '知识条目不存在');
        const usage = await tx.entryUsage.upsert({
          where: { workspaceId_entryId: { workspaceId, entryId } },
          create: { workspaceId, entryId, useCount: 1, lastUsedAt: new Date() },
          update: { useCount: { increment: 1 }, lastUsedAt: new Date() },
        });
        return { useCount: usage.useCount, lastUsedAt: usage.lastUsedAt.toISOString() };
      },
    );
  }

  private async assertProject(
    workspaceId: string,
    projectId: string | null | undefined,
  ): Promise<void> {
    if (projectId === undefined || projectId === null) return;
    const project = await this.db.project.findFirst({
      where: { id: projectId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (project === null) {
      throw new ApiException('VALIDATION_FAILED', '项目不存在或不属于当前空间', {
        fieldErrors: { projectId: ['不存在或不属于当前空间'] },
      });
    }
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

  private toView(
    entry: {
      id: string;
      type: EntryType;
      title: string;
      summary: string | null;
      body: string;
      lang: string | null;
      projectId: string | null;
      source: string | null;
      status: EntryStatus;
      rating: number | null;
      version: number;
      createdAt: Date;
      updatedAt: Date;
    },
    tags: string[],
  ): EntryView {
    return {
      id: entry.id,
      type: entry.type,
      title: entry.title,
      summary: entry.summary,
      body: entry.body,
      lang: entry.lang,
      projectId: entry.projectId,
      source: entry.source,
      status: entry.status,
      rating: entry.rating,
      tags,
      version: entry.version,
      createdAt: entry.createdAt.toISOString(),
      updatedAt: entry.updatedAt.toISOString(),
      bodyBytes: Buffer.byteLength(entry.body, 'utf8'),
    };
  }

  private encodeCursor(updatedAt: Date, id: string): string {
    return Buffer.from(JSON.stringify({ u: updatedAt.toISOString(), i: id }), 'utf8').toString(
      'base64url',
    );
  }

  private decodeCursor(cursor: string | undefined): { u: Date; i: string } | null {
    if (cursor === undefined || cursor === '') return null;
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
        u?: string;
        i?: string;
      };
      if (typeof parsed.u !== 'string' || typeof parsed.i !== 'string') return null;
      return { u: new Date(parsed.u), i: parsed.i };
    } catch {
      throw new ApiException('MALFORMED_REQUEST', '分页游标无效');
    }
  }

  async list(
    workspaceId: string,
    filters: {
      status?: EntryStatus;
      type?: EntryType;
      projectId?: string;
      tag?: string;
      q?: string;
      limit?: number;
      cursor?: string;
    } = {},
  ): Promise<{ entries: Omit<EntryView, 'body'>[]; nextCursor: string | null; hasMore: boolean }> {
    const limit = Math.min(Math.max(filters.limit ?? 20, 1), 100);
    const cursor = this.decodeCursor(filters.cursor);
    const tagName = filters.tag === undefined ? undefined : normalizeTag(filters.tag);

    const rows = await this.db.entry.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        ...(filters.status === undefined ? {} : { status: filters.status }),
        ...(filters.type === undefined ? {} : { type: filters.type }),
        ...(filters.projectId === undefined ? {} : { projectId: filters.projectId }),
        ...(tagName === undefined ? {} : { tags: { some: { tag: { nameNormalized: tagName } } } }),
        ...(filters.q === undefined || filters.q.trim() === ''
          ? {}
          : {
              OR: [
                { title: { contains: filters.q.trim(), mode: 'insensitive' as const } },
                { summary: { contains: filters.q.trim(), mode: 'insensitive' as const } },
                { body: { contains: filters.q.trim(), mode: 'insensitive' as const } },
              ],
            }),
        ...(cursor === null
          ? {}
          : {
              OR: [{ updatedAt: { lt: cursor.u } }, { updatedAt: cursor.u, id: { lt: cursor.i } }],
            }),
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const page = rows.slice(0, limit);
    const tags = await this.tagsOf(page.map((row) => row.id));
    const last = page.at(-1);
    return {
      entries: page.map((row) => {
        const { body: _body, ...summary } = this.toView(row, tags.get(row.id) ?? []);
        return summary;
      }),
      hasMore: rows.length > limit,
      nextCursor:
        rows.length > limit && last !== undefined
          ? this.encodeCursor(last.updatedAt, last.id)
          : null,
    };
  }

  async get(workspaceId: string, entryId: string): Promise<EntryView> {
    const entry = await this.db.entry.findFirst({
      where: { id: entryId, workspaceId, deletedAt: null },
    });
    if (entry === null) throw new ApiException('NOT_FOUND', '知识条目不存在');
    const tags = await this.tagsOf([entry.id]);
    const taskLinks = await this.db.taskEntry.findMany({
      where: { workspaceId, entryId, task: { workspaceId, deletedAt: null } },
      select: { task: { select: { id: true, title: true } } },
    });
    return {
      ...this.toView(entry, tags.get(entry.id) ?? []),
      taskLinks: taskLinks.map((link) => link.task),
    };
  }

  private assertCreateInput(input: EntryInput): void {
    if (input.title !== undefined && [...input.title].length > 200) {
      throw new ApiException('VALIDATION_FAILED', '标题最多 200 个字符', {
        fieldErrors: { title: ['最多 200 个字符'] },
      });
    }
    if (input.summary !== undefined && input.summary !== null && [...input.summary].length > 300) {
      throw new ApiException('VALIDATION_FAILED', '摘要最多 300 个字符', {
        fieldErrors: { summary: ['最多 300 个字符'] },
      });
    }
    if (input.body !== undefined) assertBodyBytes(input.body);
    if (
      input.rating !== undefined &&
      input.rating !== null &&
      (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5)
    ) {
      throw new ApiException('VALIDATION_FAILED', '评分需为 1～5 的整数', {
        fieldErrors: { rating: ['需为 1～5'] },
      });
    }
  }

  private async syncTags(
    client: PrismaClient,
    workspaceId: string,
    entryId: string,
    tags: string[],
  ): Promise<void> {
    await client.entryTag.deleteMany({ where: { entryId } });
    for (const normalized of tags) {
      const tag = await client.tag.upsert({
        where: { workspaceId_nameNormalized: { workspaceId, nameNormalized: normalized } },
        create: { workspaceId, nameNormalized: normalized, displayName: normalized },
        update: {},
      });
      await client.entryTag.create({ data: { workspaceId, entryId, tagId: tag.id } });
    }
  }

  async create(
    workspaceId: string,
    actorUserId: string,
    input: EntryInput,
    idempotencyKey: string,
  ): Promise<{ entry: EntryView; replayed: boolean }> {
    this.assertCreateInput(input);
    const tags = assertTags(input.tags);
    await this.assertProject(workspaceId, input.projectId);

    const result = await runIdempotent(
      this.db,
      { userId: actorUserId, workspaceId, scope: 'entry.create', key: idempotencyKey, body: input },
      async (tx) => {
        const created = await tx.entry.create({
          data: {
            workspaceId,
            createdBy: actorUserId,
            type: input.type ?? 'note',
            title: input.title ?? '',
            summary: input.summary ?? null,
            body: input.body ?? '',
            lang: input.lang ?? null,
            projectId: input.projectId ?? null,
            source: input.source ?? null,
            rating: input.rating ?? null,
            status: 'draft',
          },
        });
        await this.syncTags(tx, workspaceId, created.id, tags);
        await tx.auditEvent.create({
          data: {
            workspaceId,
            actorId: actorUserId,
            action: 'entry.created',
            entityType: 'entry',
            entityId: created.id,
            result: 'success',
            summary: `创建知识条目：${created.title === '' ? '（未命名草稿）' : created.title}`,
          },
        });
        await this.projects.touchActivity(tx, workspaceId, created.projectId);
        return created.id;
      },
    );

    return { entry: await this.get(workspaceId, result.data), replayed: result.replayed };
  }

  async update(
    workspaceId: string,
    actorUserId: string,
    entryId: string,
    ifMatch: string | string[] | undefined,
    input: EntryInput,
  ): Promise<EntryView> {
    const expected = requireIfMatch(ifMatch);
    this.assertCreateInput(input);
    const tags = input.tags === undefined ? undefined : assertTags(input.tags);
    await this.assertProject(workspaceId, input.projectId);

    await this.db.$transaction(async (tx) => {
      const client = tx as unknown as PrismaClient;
      const current = await client.entry.findFirst({
        where: { id: entryId, workspaceId, deletedAt: null },
      });
      if (current === null) throw new ApiException('NOT_FOUND', '知识条目不存在');
      if (current.version !== expected) {
        throw new ApiException('PRECONDITION_FAILED', '该条目已被其他设备修改', {
          currentVersion: current.version,
        });
      }

      // 正文变化前保存上一版，便于回溯；只改标签/标题不产生正文修订
      if (input.body !== undefined && input.body !== current.body) {
        await client.entryRevision.create({
          data: {
            workspaceId,
            entryId,
            body: current.body,
            savedBy: actorUserId,
            sourceVersion: current.version,
          },
        });
        await this.trimRevisions(client, workspaceId, entryId);
      }

      const updated = await client.entry.updateMany({
        where: { id: entryId, workspaceId, version: expected, deletedAt: null },
        data: {
          ...(input.type === undefined ? {} : { type: input.type }),
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.summary === undefined ? {} : { summary: input.summary }),
          ...(input.body === undefined ? {} : { body: input.body }),
          ...(input.lang === undefined ? {} : { lang: input.lang }),
          ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
          ...(input.source === undefined ? {} : { source: input.source }),
          ...(input.rating === undefined ? {} : { rating: input.rating }),
          version: { increment: 1 },
        },
      });
      if (updated.count === 0)
        throw new ApiException('PRECONDITION_FAILED', '该条目已被其他设备修改');

      if (tags !== undefined) await this.syncTags(client, workspaceId, entryId, tags);
      await client.auditEvent.create({
        data: {
          workspaceId,
          actorId: actorUserId,
          action: 'entry.updated',
          entityType: 'entry',
          entityId: entryId,
          result: 'success',
          summary: '更新知识条目',
        },
      });
      await this.projects.touchActivity(
        client,
        workspaceId,
        input.projectId === undefined ? current.projectId : input.projectId,
      );
    });

    return this.get(workspaceId, entryId);
  }

  /** 状态转换：显式接口，避免普通编辑顺手改状态绕过校验 */
  async setStatus(
    workspaceId: string,
    actorUserId: string,
    entryId: string,
    ifMatch: string | string[] | undefined,
    next: EntryStatus,
  ): Promise<EntryView> {
    const expected = requireIfMatch(ifMatch);
    await this.db.$transaction(async (tx) => {
      const client = tx as unknown as PrismaClient;
      const current = await client.entry.findFirst({
        where: { id: entryId, workspaceId, deletedAt: null },
      });
      if (current === null) throw new ApiException('NOT_FOUND', '知识条目不存在');
      if (current.version !== expected) {
        throw new ApiException('PRECONDITION_FAILED', '该条目已被其他设备修改', {
          currentVersion: current.version,
        });
      }
      if (!TRANSITIONS[current.status].includes(next)) {
        throw new ApiException('ENTRY_STATE_INVALID', `不允许从 ${current.status} 转换到 ${next}`, {
          details: { from: current.status, to: next, allowed: TRANSITIONS[current.status] },
        });
      }
      if (next === 'verified') {
        const missing: Record<string, string[]> = {};
        if (current.title.trim() === '') missing['title'] = ['转已验证前必须填写标题'];
        if (current.summary === null || current.summary.trim() === '')
          missing['summary'] = ['转已验证前必须填写摘要'];
        if (current.body.trim() === '') missing['body'] = ['转已验证前必须填写正文'];
        if (Object.keys(missing).length > 0) {
          throw new ApiException('VALIDATION_FAILED', '转为已验证前需补全标题、摘要与正文', {
            fieldErrors: missing,
          });
        }
      }

      const updated = await client.entry.updateMany({
        where: { id: entryId, workspaceId, version: expected, deletedAt: null },
        data: { status: next, version: { increment: 1 } },
      });
      if (updated.count === 0)
        throw new ApiException('PRECONDITION_FAILED', '该条目已被其他设备修改');
      await client.auditEvent.create({
        data: {
          workspaceId,
          actorId: actorUserId,
          action: 'entry.status_changed',
          entityType: 'entry',
          entityId: entryId,
          result: 'success',
          summary: `知识条目状态：${current.status} → ${next}`,
        },
      });
    });

    return this.get(workspaceId, entryId);
  }

  async remove(
    workspaceId: string,
    actorUserId: string,
    entryId: string,
    ifMatch: string | string[] | undefined,
  ): Promise<void> {
    const expected = requireIfMatch(ifMatch);
    await this.db.$transaction(async (tx) => {
      const client = tx as unknown as PrismaClient;
      const current = await client.entry.findFirst({
        where: { id: entryId, workspaceId, deletedAt: null },
      });
      if (current === null) throw new ApiException('NOT_FOUND', '知识条目不存在');
      if (current.version !== expected) {
        throw new ApiException('PRECONDITION_FAILED', '该条目已被其他设备修改', {
          currentVersion: current.version,
        });
      }
      await client.entry.update({
        where: { id: entryId },
        data: { deletedAt: new Date(), version: { increment: 1 } },
      });
      await client.auditEvent.create({
        data: {
          workspaceId,
          actorId: actorUserId,
          action: 'entry.deleted',
          entityType: 'entry',
          entityId: entryId,
          result: 'success',
          summary: '删除知识条目（回收站）',
        },
      });
    });
  }

  /** 每个条目只保留最近 5 条正文修订（契约 C-23）；裁剪与写入在同一事务内 */
  private async trimRevisions(
    client: PrismaClient,
    workspaceId: string,
    entryId: string,
  ): Promise<void> {
    const keep = await client.entryRevision.findMany({
      where: { workspaceId, entryId },
      orderBy: { savedAt: 'desc' },
      take: REVISION_KEEP,
      select: { id: true },
    });
    const keepIds = keep.map((row) => row.id);
    await client.entryRevision.deleteMany({
      where: { workspaceId, entryId, id: { notIn: keepIds } },
    });
  }

  async revisions(
    workspaceId: string,
    entryId: string,
  ): Promise<{
    revisions: {
      id: string;
      body: string;
      bodyBytes: number;
      savedAt: string;
      sourceVersion: number;
      savedBy: string;
    }[];
  }> {
    const entry = await this.db.entry.findFirst({
      where: { id: entryId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (entry === null) throw new ApiException('NOT_FOUND', '知识条目不存在');
    const rows = await this.db.entryRevision.findMany({
      where: { workspaceId, entryId },
      orderBy: { savedAt: 'desc' },
      take: REVISION_KEEP,
    });
    return {
      revisions: rows.map((row) => ({
        id: row.id,
        body: row.body,
        bodyBytes: Buffer.byteLength(row.body, 'utf8'),
        savedAt: row.savedAt.toISOString(),
        sourceVersion: row.sourceVersion,
        savedBy: row.savedBy,
      })),
    };
  }

  /**
   * 回滚到指定修订（F21）。
   *
   * 顺序很重要（F21-03）：
   * 1. 校验 If-Match，过期直接 412（并发回滚不会覆盖更新版本）
   * 2. **先把当前正文存为新修订**（保证“回滚后还能再回到刚才的内容”）
   * 3. 再把正文替换为目标修订内容，版本 +1
   * 4. 裁剪到最近 5 条
   * 以上全部在同一事务中，任一步失败整体回滚，不会出现“半次恢复”。
   */
  async restoreRevision(
    workspaceId: string,
    actorUserId: string,
    entryId: string,
    revisionId: string,
    ifMatch: string | string[] | undefined,
  ): Promise<EntryView> {
    const expected = requireIfMatch(ifMatch);

    await this.db.$transaction(async (tx) => {
      const client = tx as unknown as PrismaClient;
      const current = await client.entry.findFirst({
        where: { id: entryId, workspaceId, deletedAt: null },
      });
      if (current === null) throw new ApiException('NOT_FOUND', '知识条目不存在');
      if (current.version !== expected) {
        throw new ApiException('PRECONDITION_FAILED', '该条目已被其他设备修改', {
          currentVersion: current.version,
        });
      }

      const revision = await client.entryRevision.findFirst({
        where: { id: revisionId, entryId, workspaceId },
      });
      if (revision === null)
        throw new ApiException('REVISION_NOT_FOUND', '修订不存在或不属于该条目');

      // 先保留当前正文
      await client.entryRevision.create({
        data: {
          workspaceId,
          entryId,
          body: current.body,
          savedBy: actorUserId,
          sourceVersion: current.version,
        },
      });
      await this.trimRevisions(client, workspaceId, entryId);

      const updated = await client.entry.updateMany({
        where: { id: entryId, workspaceId, version: expected, deletedAt: null },
        data: { body: revision.body, version: { increment: 1 } },
      });
      if (updated.count === 0)
        throw new ApiException('PRECONDITION_FAILED', '该条目已被其他设备修改');

      await client.auditEvent.create({
        data: {
          workspaceId,
          actorId: actorUserId,
          action: 'entry.revision_restored',
          entityType: 'entry',
          entityId: entryId,
          result: 'success',
          summary: `回滚正文到修订（源版本 ${revision.sourceVersion}）`,
        },
      });
    });

    return this.get(workspaceId, entryId);
  }

  async listTags(workspaceId: string): Promise<{ tags: { name: string; count: number }[] }> {
    const tags = await this.db.tag.findMany({
      where: { workspaceId },
      select: { displayName: true, _count: { select: { entries: true } } },
      orderBy: { displayName: 'asc' },
    });
    return { tags: tags.map((tag) => ({ name: tag.displayName, count: tag._count.entries })) };
  }
}
