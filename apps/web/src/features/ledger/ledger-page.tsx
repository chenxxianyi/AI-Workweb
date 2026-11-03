import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EmptyState, ErrorState, LoadingState, Notice, PageHeader } from '../../components/states';
import { useWorkspace } from '../../providers/workspace-provider';
import { describeApiError } from '../../services/auth-api';
import {
  SCENE_OPTIONS,
  TOOL_OPTIONS,
  ledgerApi,
  sceneLabel,
  toolLabel,
  type CreateLedgerInput,
  type LedgerRecord,
} from '../../services/ledger-api';
import { newIdempotencyKey } from '../../services/tasks-api';
import { effectLabel, formatMinutes, groupByDate, shouldSubmitOnEnter } from './ledger-utils';
import styles from './ledger.module.css';

/**
 * AI 台账（F18）。
 *
 * - 输入区是 textarea：Enter 提交、Shift+Enter 换行、输入法候选确认不误提交
 * - 成功才清空输入；失败保留文本与所有字段
 * - 时间线按业务日期分组，支持“加载更多”（游标）与删除（确认 + 焦点恢复）
 */
export function LedgerPage(): React.JSX.Element {
  const { workspace, can } = useWorkspace();
  const workspaceId = workspace?.workspaceId ?? '';
  const queryClient = useQueryClient();
  const writable = can('business.write');

  const [note, setNote] = useState('');
  const [tool, setTool] = useState('claude');
  const [scene, setScene] = useState('coding');
  const [minutes, setMinutes] = useState('30');
  const [savedMinutes, setSavedMinutes] = useState('');
  const [effect, setEffect] = useState('4');
  const [projectId, setProjectId] = useState('');
  const [filters, setFilters] = useState<{ tool: string; scene: string; from: string; to: string }>({
    tool: '',
    scene: '',
    from: '',
    to: '',
  });
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [extraRecords, setExtraRecords] = useState<LedgerRecord[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<LedgerRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const retryKey = useRef<string | null>(null);
  const noteRef = useRef<HTMLTextAreaElement | null>(null);
  const deleteButtonRef = useRef<HTMLButtonElement | null>(null);

  const listQuery = useQuery({
    queryKey: ['ws', workspaceId, 'ledger', filters],
    queryFn: () => ledgerApi.list(workspaceId, { ...filters, limit: 20 }),
    enabled: workspaceId !== '',
  });

  const summaryQuery = useQuery({
    queryKey: ['ws', workspaceId, 'ledger', 'summary', filters.from, filters.to, projectId],
    queryFn: () =>
      ledgerApi.summary(workspaceId, {
        ...(filters.from === '' ? {} : { from: filters.from }),
        ...(filters.to === '' ? {} : { to: filters.to }),
        ...(projectId === '' ? {} : { projectId }),
      }),
    enabled: workspaceId !== '',
  });

  const projectsQuery = useQuery({
    queryKey: ['ws', workspaceId, 'projects', { forLedger: true }],
    queryFn: () => fetchProjectsForSelect(workspaceId),
    enabled: workspaceId !== '',
  });

  // 业务日：与后端一致的“空间今天”，用于新记录的日期
  const dashboardQuery = useQuery({
    queryKey: ['ws', workspaceId, 'dashboard', 'today'],
    queryFn: () => tasksDashboard(workspaceId),
    enabled: workspaceId !== '',
  });
  const businessDate =
    dashboardQuery.data?.businessDate ??
    new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);

  // 第一页游标由查询结果驱动；切换筛选时重置为第一页
  useEffect(() => {
    setExtraRecords([]);
    setNextCursor(listQuery.data?.nextCursor ?? null);
  }, [listQuery.data]);

  const records = useMemo(
    () => [...(listQuery.data?.records ?? []), ...extraRecords],
    [listQuery.data, extraRecords],
  );
  const groups = useMemo(() => groupByDate(records), [records]);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['ws', workspaceId, 'ledger'] });
    void queryClient.invalidateQueries({ queryKey: ['ws', workspaceId, 'project'] });
    void queryClient.invalidateQueries({ queryKey: ['ws', workspaceId, 'projects'] });
  };

  const createMutation = useMutation({
    mutationFn: (input: CreateLedgerInput) => {
      retryKey.current ??= newIdempotencyKey();
      return ledgerApi.create(workspaceId, input, retryKey.current);
    },
    onSuccess: () => {
      retryKey.current = null;
      setNote('');
      setFormError(null);
      invalidate();
      noteRef.current?.focus();
    },
    onError: (error) => setFormError(describeApiError(error)),
  });

  const submit = (): void => {
    setFormError(null);
    const text = note.trim();
    if (text === '') {
      setFormError('请先写下这次用 AI 做了什么');
      return;
    }
    const minutesValue = Number(minutes);
    if (!Number.isInteger(minutesValue) || minutesValue < 1 || minutesValue > 1440) {
      setFormError('投入分钟需为 1～1440 的整数');
      return;
    }
    const savedValue = savedMinutes.trim() === '' ? undefined : Number(savedMinutes);
    if (savedValue !== undefined && (!Number.isInteger(savedValue) || savedValue < 0 || savedValue > 1440)) {
      setFormError('节省分钟需为 0～1440 的整数');
      return;
    }
    createMutation.mutate({
      recordDate: businessDate,
      tool,
      scene,
      minutes: minutesValue,
      effect: Number(effect),
      note: text,
      ...(savedValue === undefined ? {} : { savedMinutes: savedValue }),
      ...(projectId === '' ? {} : { projectId }),
    });
  };

  const loadMore = async (): Promise<void> => {
    if (nextCursor === null) return;
    const page = await ledgerApi.list(workspaceId, { ...filters, limit: 20, cursor: nextCursor });
    setExtraRecords((current) => [...current, ...page.records]);
    setNextCursor(page.nextCursor);
  };

  const removeRecord = async (record: LedgerRecord): Promise<void> => {
    setDeleting(true);
    try {
      await ledgerApi.remove(workspaceId, record);
      setConfirming(null);
      setExtraRecords((current) => current.filter((item) => item.id !== record.id));
      invalidate();
      noteRef.current?.focus();
    } catch (error) {
      setFormError(describeApiError(error));
    } finally {
      setDeleting(false);
    }
  };

  const summary = summaryQuery.data;
  const loading = listQuery.status === 'pending';

  return (
    <>
      <PageHeader
        title="AI 台账"
        description="记录每次用 AI 的投入与节省；默认按业务日期倒序展示。"
        actions={
          summary === undefined ? null : (
            <div className={styles.summary}>
              <span>{summary.count} 条</span>
              <span>投入 {formatMinutes(summary.totalMinutes)}</span>
              <span>节省 {formatMinutes(summary.totalSavedMinutes)}</span>
              <span>{summary.averageEffect === null ? '暂无评分' : `平均效果 ${summary.averageEffect}`}</span>
            </div>
          )
        }
      />

      {summaryQuery.status === 'error' ? (
        <p className={styles.banner} role="alert">
          {describeApiError(summaryQuery.error)}
        </p>
      ) : null}

      <section className={styles.composer} aria-label="新增台账记录">
        <label className={styles.noteField}>
          <span className={styles.label}>用 AI 做了什么（Enter 保存，Shift+Enter 换行）</span>
          <textarea
            ref={noteRef}
            className={styles.textarea}
            value={note}
            rows={3}
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              const native = event.nativeEvent;
              const allowed = shouldSubmitOnEnter({
                shiftKey: event.shiftKey,
                isComposing: native.isComposing,
                keyCode: native.keyCode,
              });
              if (!allowed) {
                // 输入法组合态：交给输入法处理，绝不提交
                return;
              }
              event.preventDefault();
              submit();
            }}
            placeholder="例如：让 Claude 重构了会话守卫，并补了 6 个用例"
            disabled={!writable}
            data-testid="ledger-note"
          />
        </label>

        <div className={styles.fieldRow}>
          <label className={styles.field}>
            <span className={styles.label}>工具</span>
            <select className={styles.input} value={tool} onChange={(event) => setTool(event.target.value)} disabled={!writable}>
              {TOOL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.label}>场景</span>
            <select className={styles.input} value={scene} onChange={(event) => setScene(event.target.value)} disabled={!writable}>
              {SCENE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.label}>投入分钟</span>
            <input
              className={styles.input}
              type="number"
              min={1}
              max={1440}
              value={minutes}
              onChange={(event) => setMinutes(event.target.value)}
              disabled={!writable}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>节省分钟（可空）</span>
            <input
              className={styles.input}
              type="number"
              min={0}
              max={1440}
              value={savedMinutes}
              onChange={(event) => setSavedMinutes(event.target.value)}
              disabled={!writable}
              placeholder="默认等于投入"
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>效果（1～5）</span>
            <select className={styles.input} value={effect} onChange={(event) => setEffect(event.target.value)} disabled={!writable}>
              {[1, 2, 3, 4, 5].map((value) => (
                <option key={value} value={String(value)}>
                  {value} · {effectLabel(value)}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.label}>关联项目（可选）</span>
            <select
              className={styles.input}
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              disabled={!writable || projectsQuery.status !== 'success'}
            >
              <option value="">不关联</option>
              {(projectsQuery.data ?? []).map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        {formError === null ? null : (
          <p className={styles.error} role="alert">
            {formError}
          </p>
        )}

        <div className={styles.composerActions}>
          <button type="button" className={styles.primary} onClick={submit} disabled={!writable || createMutation.isPending}>
            {createMutation.isPending ? '保存中…' : '保存记录'}
          </button>
          {!writable ? <span className={styles.hint}>只读角色，不能新增记录。</span> : null}
        </div>
      </section>

      <div className={styles.toolbar}>
        <label className={styles.field}>
          <span className={styles.label}>工具筛选</span>
          <select
            className={styles.input}
            value={filters.tool}
            onChange={(event) => {
              setExtraRecords([]);
              setNextCursor(null);
              setFilters((current) => ({ ...current, tool: event.target.value }));
            }}
          >
            <option value="">全部</option>
            {TOOL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.label}>场景筛选</span>
          <select
            className={styles.input}
            value={filters.scene}
            onChange={(event) => {
              setExtraRecords([]);
              setNextCursor(null);
              setFilters((current) => ({ ...current, scene: event.target.value }));
            }}
          >
            <option value="">全部</option>
            {SCENE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.label}>从</span>
          <input
            className={styles.input}
            type="date"
            value={filters.from}
            onChange={(event) => {
              setExtraRecords([]);
              setNextCursor(null);
              setFilters((current) => ({ ...current, from: event.target.value }));
            }}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>到</span>
          <input
            className={styles.input}
            type="date"
            value={filters.to}
            onChange={(event) => {
              setExtraRecords([]);
              setNextCursor(null);
              setFilters((current) => ({ ...current, to: event.target.value }));
            }}
          />
        </label>
      </div>

      {loading ? <LoadingState label="加载台账…" /> : null}
      {listQuery.status === 'error' ? (
        <ErrorState
          message={describeApiError(listQuery.error)}
          onRetry={() => {
            void listQuery.refetch();
          }}
        />
      ) : null}

      {!loading && records.length === 0 ? (
        <EmptyState
          title="还没有台账记录"
          description="记录第一条：写下这次用 AI 做了什么、花了多久、省了多少。"
        />
      ) : null}

      {groups.map((group) => (
        <section key={group.date} className={styles.dayGroup} aria-label={group.date}>
          <h2 className={styles.dayTitle}>
            {group.date}
            <span className={styles.dayMeta}>
              {group.records.length} 条 · 投入 {formatMinutes(group.totalMinutes)} · 节省{' '}
              {formatMinutes(group.totalSavedMinutes)}
            </span>
          </h2>
          <ul className={styles.timeline}>
            {group.records.map((record) => (
              <li key={record.id} className={styles.entry} data-ledger-note={record.note ?? ''}>
                <div className={styles.entryHead}>
                  <span className={styles.tag}>{toolLabel(record.tool)}</span>
                  <span className={styles.tagMuted}>{sceneLabel(record.scene)}</span>
                  <span className={styles.entryMeta}>
                    {record.minutes} 分钟 · 节省 {record.savedMinutes} 分钟 · 效果 {record.effect}
                  </span>
                </div>
                {record.note === null ? null : <p className={styles.entryNote}>{record.note}</p>}
                <div className={styles.entryActions}>
                  <button
                    type="button"
                    className={styles.small}
                    disabled={!writable}
                    onClick={() => setConfirming(record)}
                  >
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {nextCursor === null ? null : (
        <div className={styles.loadMore}>
          <button type="button" className={styles.secondary} onClick={() => void loadMore()}>
            加载更多
          </button>
        </div>
      )}

      {confirming === null ? null : (
        <div className={styles.confirm} role="alertdialog" aria-label="确认删除台账记录">
          <p className={styles.confirmTitle}>删除这条记录？</p>
          <p className={styles.hint}>记录会进入回收站（F34 提供恢复），不会影响项目与任务。</p>
          <div className={styles.composerActions}>
            <button
              type="button"
              className={styles.secondary}
              onClick={() => {
                setConfirming(null);
                noteRef.current?.focus();
              }}
            >
              取消
            </button>
            <button
              type="button"
              className={styles.danger}
              ref={deleteButtonRef}
              onClick={() => void removeRecord(confirming)}
              disabled={deleting}
            >
              {deleting ? '删除中…' : '确认删除'}
            </button>
          </div>
        </div>
      )}

      <div style={{ marginTop: 'var(--space-4)' }}>
        <Notice>台账只统计真实记录；「节省」缺省等于「投入」，可按实际情况修改。</Notice>
      </div>
    </>
  );
}

/** 输入默认用今天（业务日，由 /dashboard/today 提供）；拉取失败时退回本地日期 */
async function tasksDashboard(workspaceId: string): Promise<{ businessDate: string }> {
  const { tasksApi } = await import('../../services/tasks-api');
  const dashboard = await tasksApi.dashboard(workspaceId);
  return { businessDate: dashboard.businessDate };
}

async function fetchProjectsForSelect(workspaceId: string): Promise<{ id: string; name: string }[]> {
  const { projectsApi } = await import('../../services/projects-api');
  const result = await projectsApi.list(workspaceId, { filter: 'active', limit: 50 });
  return result.projects.map((project) => ({ id: project.id, name: project.name }));
}
