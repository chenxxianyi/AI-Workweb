import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EmptyState, ErrorState, LoadingState, PageHeader } from '../../components/states';
import { useWorkspace } from '../../providers/workspace-provider';
import { describeApiError } from '../../services/auth-api';
import {
  kbApi,
  type EntryInput,
  type EntryStatus,
  type EntryType,
} from '../../services/kb-api';
import { newIdempotencyKey } from '../../services/tasks-api';
import { STATUS_LABEL, TYPE_LABEL, TYPE_OPTIONS, shouldIgnoreShortcut } from './kb-utils';
import { EntryEditor } from './entry-editor';
import styles from './kb.module.css';

const STATUS_TABS: { value: '' | EntryStatus; label: string }[] = [
  { value: '', label: '全部' },
  { value: 'draft', label: '草稿' },
  { value: 'verified', label: '已验证' },
  { value: 'archived', label: '已归档' },
];

/**
 * 知识库列表（F20）。
 *
 * 筛选状态放在 URL 查询串里：从详情返回时筛选条件不丢（F20-01）。
 * 单键 `n` 在非输入态打开新建面板；在输入框里打字母 N 不会触发（F20-03）。
 */
export function KnowledgePage(): React.JSX.Element {
  const { workspace, can } = useWorkspace();
  const workspaceId = workspace?.workspaceId ?? '';
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const writable = can('business.write');

  const status = (params.get('status') ?? '') as '' | EntryStatus;
  const type = (params.get('type') ?? '') as '' | EntryType;
  const tag = params.get('tag') ?? '';
  const q = params.get('q') ?? '';

  const [composing, setComposing] = useState(false);
  const [formError, setFormError] = useState<unknown>(null);
  const retryKey = useRef<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const filters = useMemo(
    () => ({
      ...(status === '' ? {} : { status }),
      ...(type === '' ? {} : { type }),
      ...(tag === '' ? {} : { tag }),
      ...(q === '' ? {} : { q }),
    }),
    [status, type, tag, q],
  );

  const listQuery = useQuery({
    queryKey: ['ws', workspaceId, 'entries', filters],
    queryFn: ({ signal }) => kbApi.list(workspaceId, { ...filters, limit: 50 }, { signal }),
    enabled: workspaceId !== '',
  });

  const tagsQuery = useQuery({
    queryKey: ['ws', workspaceId, 'tags'],
    queryFn: ({ signal }) => kbApi.tags(workspaceId, { signal }),
    enabled: workspaceId !== '',
  });

  // 单键 N：只有焦点不在输入控件里、且没有打开编辑器时才生效
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== 'n' || event.metaKey || event.ctrlKey || event.altKey) return;
      if (shouldIgnoreShortcut(event.target as HTMLElement)) return;
      if (composing) return;
      if (!writable) return;
      event.preventDefault();
      setFormError(null);
      setComposing(true);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [composing, writable]);

  const createMutation = useMutation({
    mutationFn: (input: EntryInput) => {
      retryKey.current ??= newIdempotencyKey();
      return kbApi.create(workspaceId, input, retryKey.current);
    },
    onSuccess: (entry) => {
      retryKey.current = null;
      setComposing(false);
      setFormError(null);
      void queryClient.invalidateQueries({ queryKey: ['ws', workspaceId, 'entries'] });
      void queryClient.invalidateQueries({ queryKey: ['ws', workspaceId, 'tags'] });
      void queryClient.invalidateQueries({ queryKey: ['ws', workspaceId, 'dashboard'] });
      // 新建后直接进入详情，便于继续补全；返回时带回当前筛选
      navigate(`/kb/${entry.id}`, { state: { from: `/kb?${params.toString()}` } });
    },
    onError: (error) => setFormError(error),
  });

  const updateParams = (next: Record<string, string>): void => {
    const merged = new URLSearchParams(params);
    for (const [key, value] of Object.entries(next)) {
      if (value === '') merged.delete(key);
      else merged.set(key, value);
    }
    setParams(merged, { replace: true });
  };

  const entries = listQuery.data?.entries ?? [];

  return (
    <>
      <PageHeader
        title="知识库"
        description="把踩过的坑和验证过的做法沉淀下来；草稿可以只写一半，转「已验证」前需补全标题、摘要与正文。"
        actions={
          writable ? (
            <button
              type="button"
              className={styles.primary}
              onClick={() => {
                setFormError(null);
                setComposing((value) => !value);
              }}
            >
              {composing ? '收起编辑' : '+ 新建条目（N）'}
            </button>
          ) : (
            <span className={styles.readonly}>只读角色，不能新建或编辑</span>
          )
        }
      />

      {composing ? (
        <section className={styles.panel} aria-label="新建知识条目">
          <h2 className={styles.panelTitle}>新建条目</h2>
          <EntryEditor
            mode="create"
            submitting={createMutation.isPending}
            error={formError}
            onSubmit={(input) => createMutation.mutate(input)}
            onCancel={() => setComposing(false)}
          />
        </section>
      ) : null}

      <div className={styles.toolbar}>
        <div className={styles.tabs} role="tablist" aria-label="状态筛选">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={status === tab.value}
              className={status === tab.value ? `${styles.tab} ${styles.tabActive}` : styles.tab}
              onClick={() => updateParams({ status: tab.value })}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <label className={styles.field}>
          <span className="sr-only">类型</span>
          <select className={styles.input} value={type} onChange={(event) => updateParams({ type: event.target.value })}>
            <option value="">全部类型</option>
            {TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.search}>
          <span className="sr-only">搜索标题、摘要与正文</span>
          <input
            ref={searchRef}
            className={styles.input}
            value={q}
            onChange={(event) => updateParams({ q: event.target.value })}
            placeholder="搜索标题、摘要与正文（输入 n 不触发新建）"
            data-testid="kb-search"
          />
        </label>
      </div>

      {(tagsQuery.data?.tags.length ?? 0) > 0 ? (
        <div className={styles.tags}>
          <button
            type="button"
            className={tag === '' ? styles.chipActive : styles.chip}
            onClick={() => updateParams({ tag: '' })}
          >
            全部标签
          </button>
          {(tagsQuery.data?.tags ?? []).map((item) => (
            <button
              key={item.name}
              type="button"
              className={tag === item.name ? styles.chipActive : styles.chip}
              onClick={() => updateParams({ tag: item.name })}
            >
              #{item.name} <span className={styles.chipCount}>{item.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      {listQuery.status === 'pending' ? <LoadingState label="加载知识条目…" /> : null}
      {listQuery.status === 'error' ? (
        <ErrorState
          message={describeApiError(listQuery.error)}
          onRetry={() => {
            void listQuery.refetch();
          }}
        />
      ) : null}

      {listQuery.status === 'success' && entries.length === 0 ? (
        <EmptyState
          title="还没有知识条目"
          description="先记一条草稿：写下结论、命令或踩坑过程，之后再补摘要并转为已验证。"
        />
      ) : null}

      {entries.length > 0 ? (
        <ul className={styles.list} aria-label="知识条目列表">
          {entries.map((entry) => (
            <li key={entry.id} className={styles.card} data-entry-title={entry.title}>
              <div className={styles.cardHead}>
                <Link
                  className={styles.cardTitle}
                  to={`/kb/${entry.id}`}
                  state={{ from: `/kb?${params.toString()}` }}
                >
                  {entry.title.trim() === '' ? '（未命名草稿）' : entry.title}
                </Link>
                <span className={styles.statusBadge} data-status={entry.status}>
                  {STATUS_LABEL[entry.status]}
                </span>
              </div>
              <p className={styles.meta}>
                {TYPE_LABEL[entry.type]} · 更新于 {entry.updatedAt.slice(0, 10)}
                {entry.bodyBytes > 0 ? ` · ${(entry.bodyBytes / 1024).toFixed(1)} KB` : ''}
              </p>
              {entry.summary === null || entry.summary === '' ? null : (
                <p className={styles.summary}>{entry.summary}</p>
              )}
              {entry.tags.length > 0 ? (
                <div className={styles.cardTags}>
                  {entry.tags.map((name) => (
                    <span key={name} className={styles.tagPill}>
                      #{name}
                    </span>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
