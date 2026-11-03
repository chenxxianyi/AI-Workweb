import { useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorState, LoadingState, PageHeader } from '../../components/states';
import { useWorkspace } from '../../providers/workspace-provider';
import { ApiError } from '../../services/api-client';
import { describeApiError } from '../../services/auth-api';
import { kbApi, type EntryInput, type EntryStatus } from '../../services/kb-api';
import { Markdown } from './markdown';
import { EntryEditor } from './entry-editor';
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
  const { entryId = '' } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { workspace, can } = useWorkspace();
  const workspaceId = workspace?.workspaceId ?? '';
  const queryClient = useQueryClient();
  const writable = can('business.write');

  const from = (location.state as { from?: string } | null)?.from ?? '/kb';
  const [editing, setEditing] = useState(false);
  const [editError, setEditError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const entryQuery = useQuery({
    queryKey: ['ws', workspaceId, 'entry', entryId],
    queryFn: ({ signal }) => kbApi.get(workspaceId, entryId, { signal }),
    enabled: workspaceId !== '' && entryId !== '',
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['ws', workspaceId, 'entry', entryId] });
    void queryClient.invalidateQueries({ queryKey: ['ws', workspaceId, 'entries'] });
    void queryClient.invalidateQueries({ queryKey: ['ws', workspaceId, 'tags'] });
    void queryClient.invalidateQueries({ queryKey: ['ws', workspaceId, 'dashboard'] });
  };

  const updateMutation = useMutation({
    mutationFn: (input: EntryInput) => {
      const entry = entryQuery.data;
      if (entry === undefined) throw new Error('条目尚未加载');
      return kbApi.update(workspaceId, entry, input);
    },
    onSuccess: () => {
      setEditing(false);
      setEditError(null);
      invalidate();
    },
    onError: (error) => setEditError(error),
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

  if (entryQuery.status === 'pending') return <LoadingState label="加载条目…" />;
  if (entryQuery.status === 'error') {
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
              <button type="button" className={styles.secondary} onClick={() => setEditing((value) => !value)}>
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
                  {next === 'verified' ? '标记已验证' : next === 'draft' ? '转为草稿' : next === 'archived' ? '归档' : next}
                </button>
              ))}
              <button type="button" className={styles.danger} onClick={() => setConfirmDelete(true)}>
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
            mode="edit"
            initial={entry}
            submitting={updateMutation.isPending}
            error={editError}
            onSubmit={(input) => updateMutation.mutate(input)}
            onCancel={() => {
              setEditing(false);
              setEditError(null);
            }}
          />
        </section>
      ) : null}

      <article className={styles.reader} data-testid="entry-reader">
        {hasBody ? (
          <Markdown source={entry.body} />
        ) : (
          <p className={styles.muted}>正文还是空的。点击「编辑」写下结论、命令或排错过程。</p>
        )}
      </article>

      {confirmDelete ? (
        <div className={styles.confirm} role="alertdialog" aria-label="确认删除知识条目">
          <p className={styles.confirmTitle}>删除这条知识？</p>
          <p className={styles.muted}>进入回收站后可恢复（F34 提供入口）。</p>
          <div className={styles.actions}>
            <button type="button" className={styles.secondary} onClick={() => setConfirmDelete(false)}>
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
