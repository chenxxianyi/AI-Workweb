import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useWorkspace } from '../../providers/workspace-provider';
import { searchApi, type SearchFilters, type SearchHit } from '../../services/search-api';
import { describeApiError } from '../../services/auth-api';
import { TYPE_OPTIONS, TYPE_LABEL, STATUS_LABEL } from '../kb/kb-utils';
import { EmptyState, ErrorState, LoadingState, PageHeader } from '../../components/states';
import styles from './search.module.css';

export function SearchPanel({ modal = false, onChoose }: { modal?: boolean; onChoose?: () => void }): React.JSX.Element {
  const { workspace, can } = useWorkspace();
  const workspaceId = workspace?.workspaceId ?? '';
  const [params, setParams] = useSearchParams();
  const [local, setLocal] = useState<SearchFilters>({ q: '' });
  const filters: SearchFilters = modal ? local : {
    q: params.get('q') ?? '', status: params.get('status') ?? '',
    type: params.get('type') ?? '', tag: params.get('tag') ?? '', cursor: params.get('cursor') ?? '',
  };
  const [debounced, setDebounced] = useState(filters.q.trim());
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(filters.q.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [filters.q]);
  useEffect(() => { input.current?.focus(); }, []);
  const patch = (changes: Partial<SearchFilters>): void => {
    setActive(0);
    if (modal) setLocal((prior) => ({ ...prior, cursor: undefined, ...changes }));
    else {
      const next = new URLSearchParams(params);
      next.delete('cursor');
      for (const [key, value] of Object.entries(changes)) {
        if (value === undefined || value === '') next.delete(key); else next.set(key, value);
      }
      setParams(next);
    }
  };
  const matching = filters.q.trim() === debounced;
  const query = useQuery({
    queryKey: ['ws', workspaceId, 'search', debounced, filters.status, filters.type, filters.tag, filters.cursor],
    queryFn: ({ signal }) => searchApi.entries(workspaceId, { ...filters, q: debounced }, signal),
    enabled: workspaceId !== '' && debounced !== '' && matching,
    retry: false,
  });
  const organize = useQuery({
    queryKey: ['ws', workspaceId, 'organize'],
    queryFn: ({ signal }) => searchApi.organize(workspaceId, signal),
    enabled: workspaceId !== '' && debounced === '',
  });
  const hits = matching ? query.data?.hits ?? [] : [];
  const choose = (hit: SearchHit): void => {
    onChoose?.();
    navigate('/kb/' + hit.id, { state: { from: '/search?' + new URLSearchParams({ q: debounced, ...(filters.status ? { status: filters.status } : {}), ...(filters.type ? { type: filters.type } : {}), ...(filters.tag ? { tag: filters.tag } : {}), ...(filters.cursor ? { cursor: filters.cursor } : {}) }) } });
  };
  const capture = (): void => { window.dispatchEvent(new CustomEvent('aiwb:open-capture', { detail: { title: filters.q } })); };
  return <section className={styles.panel} aria-label="知识搜索">
    {modal ? null : <PageHeader title="全局搜索" description="搜索当前空间知识；Ctrl/Cmd+K 随时打开搜索，N 快速捕获。" />}
    <label className={styles.field}><span>搜索词</span><input ref={input} aria-label="搜索知识" value={filters.q} maxLength={100}
      onChange={(event) => patch({ q: event.target.value })}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || hits.length === 0) return;
        if (event.key === 'ArrowDown') { event.preventDefault(); setActive((value) => Math.min(value + 1, hits.length - 1)); }
        if (event.key === 'ArrowUp') { event.preventDefault(); setActive((value) => Math.max(value - 1, 0)); }
        if (event.key === 'Enter') { event.preventDefault(); const selected = hits[Math.min(active, hits.length - 1)]; if (selected) choose(selected); }
      }} placeholder="例如：断连、SSE、标签" /></label>
    <div className={styles.filters}>
      <label>状态<select aria-label="搜索状态" value={filters.status ?? ''} onChange={(event) => patch({ status: event.target.value })}>
        <option value="">全部</option><option value="draft">草稿</option><option value="verified">已验证</option><option value="archived">已归档</option>
      </select></label>
      <label>类型<select aria-label="搜索类型" value={filters.type ?? ''} onChange={(event) => patch({ type: event.target.value })}><option value="">全部</option>{TYPE_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      <label>标签<input aria-label="搜索标签" value={filters.tag ?? ''} maxLength={32} onChange={(event) => patch({ tag: event.target.value })} /></label>
    </div>
    {!matching || (debounced !== '' && query.isPending) ? <LoadingState label="搜索中…" /> : null}
    {matching && debounced !== '' && query.isError ? <ErrorState message={describeApiError(query.error)} onRetry={() => void query.refetch()} /> : null}
    {matching && debounced !== '' && query.isSuccess && hits.length === 0 ? <EmptyState title={'没有找到“' + debounced + '”'} action={can('business.write') ? <button onClick={capture}>用它新建草稿</button> : undefined} /> : null}
    {hits.length > 0 ? <>
      <p className={styles.dim}>本页{hits.length}条 · {query.data?.tookMs}ms · ↑↓选择，Enter打开</p>
      <ul className={styles.results} role="listbox" aria-label="搜索结果">{hits.map((hit, index) => <li key={hit.id} role="option" aria-selected={active === index} className={active === index ? styles.active : ''}>
        <Link to={'/kb/' + hit.id} onClick={(event) => { event.preventDefault(); choose(hit); }}>{hit.title || '（未命名草稿）'}</Link>
        <p>{hit.summary || '待补摘要'}</p><small>{TYPE_LABEL[hit.type]} · {STATUS_LABEL[hit.status]} · {hit.tags.join(' · ')}</small>
      </li>)}</ul>
      {query.data?.hasMore ? <button onClick={() => patch({ cursor: query.data?.nextCursor ?? undefined })}>下一页</button> : null}
    </> : null}
    {filters.cursor ? <button onClick={() => patch({ cursor: undefined })}>返回第一页</button> : null}
    {debounced === '' && matching ? <>
      <p className={styles.dim}>输入关键词，或从常用条目开始。</p>
      {organize.isError ? <ErrorState message={describeApiError(organize.error)} onRetry={() => void organize.refetch()} /> : null}
      <p><Link to="/kb?status=draft" onClick={onChoose}>超期草稿 {organize.data?.overdueDrafts ?? 0} 条</Link> · 30天未使用 {organize.data?.staleEntries ?? 0} 条</p>
      <ul className={styles.results} aria-label="常用知识">{organize.data?.top.map((hit) => <li key={hit.id}><Link to={'/kb/' + hit.id} onClick={onChoose}>{hit.title || '（未命名草稿）'}</Link><small>使用{hit.score}次</small></li>)}</ul>
    </> : null}
  </section>;
}

export function SearchPage(): React.JSX.Element { return <SearchPanel />; }

export function OrganizationSummary(): React.JSX.Element {
  const { workspace } = useWorkspace();
  const workspaceId = workspace?.workspaceId ?? '';
  const summary = useQuery({ queryKey: ['ws', workspaceId, 'organize'], queryFn: ({ signal }) => searchApi.organize(workspaceId, signal), enabled: workspaceId !== '' });
  return <aside className={styles.panel} aria-label="知识整理"><p><Link to="/kb?status=draft">超过7天的草稿 {summary.data?.overdueDrafts ?? 0} 条</Link> · 30天未使用 {summary.data?.staleEntries ?? 0} 条 · <Link to="/search">常用知识与全局搜索</Link></p>{summary.isError ? <p role="alert">{describeApiError(summary.error)}</p> : null}</aside>;
}

export function RelatedKnowledge({ entryId }: { entryId: string }): React.JSX.Element | null {
  const { workspace } = useWorkspace();
  const workspaceId = workspace?.workspaceId ?? '';
  const related = useQuery({
    queryKey: ['ws', workspaceId, 'related', entryId],
    queryFn: ({ signal }) => searchApi.related(workspaceId, entryId, signal),
    enabled: workspaceId !== '' && entryId !== '',
  });
  return <aside className={styles.panel}><h2>相关知识</h2>{related.isError ? <p role="alert">{describeApiError(related.error)}</p> : related.isPending ? <p>加载中…</p> : related.data.length === 0 ? <p className={styles.dim}>暂无共享标签的条目。</p> : <ul>{related.data.map((hit) => <li key={hit.id}><Link to={'/kb/' + hit.id}>{hit.title || '（未命名草稿）'}</Link></li>)}</ul>}</aside>;
}
