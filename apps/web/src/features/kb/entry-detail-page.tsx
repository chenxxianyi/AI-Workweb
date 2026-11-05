import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorState, LoadingState, PageHeader } from '../../components/states';
import { useWorkspace } from '../../providers/workspace-provider';
import { ApiError } from '../../services/api-client';
import { describeApiError } from '../../services/auth-api';
import {
  kbApi,
  type EntryInput,
  type EntryRevision,
  type EntryStatus,
  type Entry,
} from '../../services/kb-api';
import { Markdown } from './markdown';
import { RelatedKnowledge } from '../search/search-panel';
import { EntryCopy } from './entry-copy';
import { EntryEditor } from './entry-editor';
import { useAuth } from '../../providers/auth-provider';
import { deleteLocalRecord } from '../../offline/queue';
import { NEXT_STATUS, STATUS_LABEL, TYPE_LABEL } from './kb-utils';
import styles from './kb.module.css';

/**
 * 知识条目详情（F20）。
 *
 * - 正文用安全的 Markdown 渲染（不执行 HTML、不放行危险协议）
 * - 「返回列表」保留来源筛选（location.state.from）
 * - 编辑用 If-Match；412 时提示并刷新，不静默覆盖
 */
export function EntryDetailPage(): React.JSX.Element {
  const { user } = useAuth();
  const { entryId = '' } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { workspace, can } = useWorkspace();
  const workspaceId = workspace?.workspaceId ?? '';
  const queryClient = useQueryClient();
  const writable = can('business.write');

  const from = (location.state as { from?: string } | null)?.from ?? '/kb';
  const [editing, setEditing] = useState(
    (location.state as { edit?: boolean } | null)?.edit === true,
  );
  const [editError, setEditError] = useState<unknown>(null);
  const [conflictEntry, setConflictEntry] = useState<Entry | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [previewRevision, setPreviewRevision] = useState<EntryRevision | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);

  const entryQuery = useQuery({
    queryKey: ['ws', workspaceId, 'entry', entryId],
    queryFn: ({ signal }) => kbApi.get(workspaceId, entryId, { signal }),
    enabled: workspaceId !== '' && entryId !== '',
  });

  const revisionsQuery = useQuery({
    queryKey: ['ws', workspaceId, 'entry', entryId, 'revisions'],
    queryFn: ({ signal }) => kbApi.revisions(workspaceId, entryId, { signal }),
    enabled: workspaceId !== '' && entryId !== '',
  });

  useEffect(() => {
    if (
      editing &&
      entryQuery.status === 'success' &&
      (location.state as { edit?: boolean } | null)?.edit
    )
      document.querySelector<HTMLTextAreaElement>('[data-testid="entry-body"]')?.focus();
  }, [editing, entryQuery.status, location.state]);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['ws', workspaceId, 'entry', entryId] });
    void queryClient.invalidateQueries({
      queryKey: ['ws', workspaceId, 'entry', entryId, 'revisions'],
    });
    void queryClient.invalidateQueries({ queryKey: ['ws', workspaceId, 'entries'] });
    void queryClient.invalidateQueries({ queryKey: ['ws', workspaceId, 'tags'] });
    void queryClient.invalidateQueries({ queryKey: ['ws', workspaceId, 'dashboard'] });
  };

  const updateMutation = useMutation({
    mutationFn: ({ input, version }: { input: EntryInput; version: number | undefined }) => {
      const entry = entryQuery.data;
      if (entry === undefined) throw new Error('条目尚未加载');
      return kbApi.update(workspaceId, { id: entry.id, version: version ?? entry.version }, input);
    },
    onSuccess: () => {
      if (user) void deleteLocalRecord('drafts', user.id + ':' + workspaceId + ':entry:' + entryId);
      setEditing(false);
      setEditError(null);
      setConflictEntry(null);
      invalidate();
    },
    onError: (error) => {
      setEditError(error);
      if (error instanceof ApiError && error.isConflict)
        void kbApi.get(workspaceId, entryId).then(setConflictEntry).catch(setEditError);
    },
  });

  const statusMutation = useMutation({
    mutationFn: (status: EntryStatus) => {
      const entry = entryQuery.data;
      if (entry === undefined) throw new Error('条目尚未加载');
      return kbApi.setStatus(workspaceId, entry, status);
    },
    onSuccess: () => {
      setActionError(null);
      invalidate();
    },
    onError: (error) => {
      setActionError(describeApiError(error));
      if (error instanceof ApiError && error.isConflict) invalidate();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => {
      const entry = entryQuery.data;
      if (entry === undefined) throw new Error('条目尚未加载');
      return kbApi.remove(workspaceId, entry);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ws', workspaceId, 'entries'] });
      navigate(from, { replace: true });
    },
    onError: (error) => setActionError(describeApiError(error)),
  });

  const restoreMutation = useMutation({
    mutationFn: (revisionId: string) => {
      const entry = entryQuery.data;
      if (entry === undefined) throw new Error('条目尚未加载');
      return kbApi.restoreRevision(workspaceId, entry, revisionId);
    },
    onSuccess: () => {
      setConfirmRestore(false);
      setPreviewRevision(null);
      setActionError(null);
      invalidate();
    },
    onError: (error) => {
      setActionError(describeApiError(error));
      if (error instanceof ApiError && error.isConflict) invalidate();
    },
  });

  if (entryQuery.status === 'pending') return <LoadingState label="加载条目…" />;
  if (entryQuery.status === 'error' && entryQuery.data === undefined) {
    return (
      <ErrorState
        title="无法加载知识条目"
        message={describeApiError(entryQuery.error)}
        onRetry={() => {
          void entryQuery.refetch();
        }}
      />
    );
  }

  if (entryQuery.data === undefined) return <LoadingState />;
  const entry = entryQuery.data;
  // 摘要/正文在草稿阶段可能为空，渲染时给出明确占位而不是空白
  const hasBody = entry.body.trim() !== '';
  const nextStatuses = NEXT_STATUS[entry.status];

  return (
    <>
      <p className={styles.breadcrumb}>
        <Link to={from} data-testid="back-to-list">
          ← 返回列表
        </Link>
      </p>

      <PageHeader
        title={entry.title.trim() === '' ? '（未命名草稿）' : entry.title}
        description={`${TYPE_LABEL[entry.type]} · ${STATUS_LABEL[entry.status]} · 更新于 ${entry.updatedAt.slice(0, 16).replace('T', ' ')}`}
        actions={
          writable ? (
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.secondary}
                onClick={() => setEditing((value) => !value)}
              >
                {editing ? '收起编辑' : '编辑'}
              </button>
              {nextStatuses.map((next) => (
                <button
                  key={next}
                  type="button"
                  className={next === 'verified' ? styles.primary : styles.secondary}
                  onClick={() => statusMutation.mutate(next)}
                  disabled={statusMutation.isPending}
                >
                  {next === 'verified'
                    ? '标记已验证'
                    : next === 'draft'
                      ? '转为草稿'
                      : next === 'archived'
                        ? '归档'
                        : next}
                </button>
              ))}
              <button
                type="button"
                className={styles.danger}
                onClick={() => setConfirmDelete(true)}
              >
                删除
              </button>
            </div>
          ) : (
            <span className={styles.readonly}>只读角色</span>
          )
        }
      />

      {actionError === null ? null : (
        <p className={styles.error} role="alert">
          {actionError}
        </p>
      )}

      {entry.tags.length > 0 ? (
        <div className={styles.tags}>
          {entry.tags.map((name) => (
            <span key={name} className={styles.tagPill}>
              #{name}
            </span>
          ))}
        </div>
      ) : null}

      {entry.summary === null || entry.summary === '' ? (
        <p className={styles.muted}>还没有摘要；转为「已验证」前需要补一句结论。</p>
      ) : (
        <p className={styles.summaryBlock}>{entry.summary}</p>
      )}

      {editing ? (
        <section className={styles.panel} aria-label="编辑知识条目">
          <h2 className={styles.panelTitle}>编辑条目</h2>
          <EntryEditor
            {...(user ? { localScope: { userId: user.id, workspaceId } } : {})}
            mode="edit"
            conflict={conflictEntry}
            initial={entry}
            submitting={updateMutation.isPending}
            error={editError}
            onSubmit={(input, version) => updateMutation.mutate({ input, version })}
            onCancel={() => {
              setEditing(false);
              setEditError(null);
            }}
          />
        </section>
      ) : null}

      {entry.taskLinks?.length ? (
        <section aria-label="来源任务">
          <h2>来源任务</h2>
          {entry.taskLinks.map((task) => (
            <p key={task.id}>
              <Link to={'/tasks/' + task.id}>{task.title}</Link>
            </p>
          ))}
        </section>
      ) : null}
      <EntryCopy key={workspaceId + entry.id} entry={entry} />
      <article className={styles.reader} data-testid="entry-reader">
        {hasBody ? (
          <Markdown source={entry.body} />
        ) : (
          <p className={styles.muted}>正文还是空的。点击「编辑」写下结论、命令或排错过程。</p>
        )}
      </article>

      <RelatedKnowledge entryId={entryId} />

      <section className={styles.history} aria-label="版本历史">
        <h2 className={styles.sectionTitle}>
          版本历史
          <span className={styles.historyCount}>
            最近 {revisionsQuery.data?.revisions.length ?? 0} / 5 条正文修订
          </span>
        </h2>
        {revisionsQuery.status === 'pending' ? <p className={styles.muted}>加载修订…</p> : null}
        {(revisionsQuery.data?.revisions.length ?? 0) === 0 ? (
          <p className={styles.muted}>还没有历史修订；修改正文后会自动保留最近 5 版。</p>
        ) : (
          <ul className={styles.revisionList}>
            {(revisionsQuery.data?.revisions ?? []).map((revision) => (
              <li key={revision.id} className={styles.revisionItem} data-revision-id={revision.id}>
                <span className={styles.revisionTime}>
                  {revision.savedAt.slice(0, 16).replace('T', ' ')}
                </span>
                <span className={styles.revisionMeta}>
                  源版本 v{revision.sourceVersion} · {(revision.bodyBytes / 1024).toFixed(1)} KB
                </span>
                <button
                  type="button"
                  className={styles.small}
                  onClick={() => setPreviewRevision(revision)}
                >
                  预览
                </button>
                <button
                  type="button"
                  className={styles.small}
                  disabled={!writable}
                  onClick={() => {
                    setPreviewRevision(revision);
                    setConfirmRestore(true);
                  }}
                >
                  恢复此版本
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {previewRevision === null ? null : (
        <div className={styles.preview} role="region" aria-label="修订预览">
          <div className={styles.previewHead}>
            <strong>
              预览 {previewRevision.savedAt.slice(0, 16).replace('T', ' ')}（源版本 v
              {previewRevision.sourceVersion}）
            </strong>
            <button type="button" className={styles.small} onClick={() => setPreviewRevision(null)}>
              关闭预览
            </button>
          </div>
          {previewRevision.body.trim() === '' ? (
            <p className={styles.muted}>该修订正文为空。</p>
          ) : (
            <Markdown source={previewRevision.body} />
          )}
        </div>
      )}

      {confirmRestore && previewRevision !== null ? (
        <div className={styles.confirm} role="alertdialog" aria-label="确认恢复版本">
          <p className={styles.confirmTitle}>恢复到这个版本？</p>
          <p className={styles.muted}>
            当前正文会先保存为一条修订（之后仍可再恢复），然后替换为所选版本。
          </p>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.secondary}
              onClick={() => setConfirmRestore(false)}
            >
              取消
            </button>
            <button
              type="button"
              className={styles.primary}
              data-testid="confirm-restore"
              onClick={() => restoreMutation.mutate(previewRevision.id)}
              disabled={restoreMutation.isPending}
            >
              {restoreMutation.isPending ? '恢复中…' : '确认恢复'}
            </button>
          </div>
        </div>
      ) : null}

      {confirmDelete ? (
        <div className={styles.confirm} role="alertdialog" aria-label="确认删除知识条目">
          <p className={styles.confirmTitle}>删除这条知识？</p>
          <p className={styles.muted}>移入回收站后30天内可在设置中恢复。</p>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.secondary}
              onClick={() => setConfirmDelete(false)}
            >
              取消
            </button>
            <button
              type="button"
              className={styles.danger}
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? '删除中…' : '确认删除'}
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
