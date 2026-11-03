import { useCallback, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EmptyState, ErrorState, LoadingState, PageHeader, SkeletonRows } from '../../components/states';
import { useWorkspace } from '../../providers/workspace-provider';
import { ApiError } from '../../services/api-client';
import { describeApiError } from '../../services/auth-api';
import {
  PRIORITY_LABEL,
  newIdempotencyKey,
  tasksApi,
  type CreateTaskInput,
  type Task,
  type TaskPriority,
  type UrgentTask,
} from '../../services/tasks-api';
import styles from './today.module.css';

/**
 * 今日聚焦（F16）。
 *
 * - 数据来自 `/dashboard/today` 与任务列表（不缓存假数据）
 * - 完成/撤销/改期都以服务器结果为准：失败不显示成功，并保留输入
 * - 创建使用幂等键：超时后重试复用同一个键，避免重复新建
 * - 412 冲突时提示“已被其他设备修改”，并读取最新版本
 */
export function TodayPage(): React.JSX.Element {
  const { workspace, can } = useWorkspace();
  const workspaceId = workspace?.workspaceId ?? '';
  const queryClient = useQueryClient();

  const dashboardQuery = useQuery({
    queryKey: ['ws', workspaceId, 'dashboard', 'today'],
    queryFn: ({ signal }) => tasksApi.dashboard(workspaceId, { signal }),
    enabled: workspaceId !== '',
  });

  const businessDate = dashboardQuery.data?.businessDate;

  const todayTasksQuery = useQuery({
    queryKey: ['ws', workspaceId, 'tasks', { dueDate: businessDate }],
    queryFn: ({ signal }) =>
      tasksApi.list(workspaceId, { dueDate: businessDate, limit: 100, signal }),
    enabled: workspaceId !== '' && businessDate !== undefined,
  });

  const yesterday = useMemo(() => {
    if (businessDate === undefined) return undefined;
    const [year, month, day] = businessDate.split('-').map(Number) as [number, number, number];
    const date = new Date(Date.UTC(year, month - 1, day - 1));
    return date.toISOString().slice(0, 10);
  }, [businessDate]);

  const yesterdayTasksQuery = useQuery({
    queryKey: ['ws', workspaceId, 'tasks', { dueDate: yesterday }],
    queryFn: ({ signal }) => tasksApi.list(workspaceId, { dueDate: yesterday, limit: 100, signal }),
    enabled: workspaceId !== '' && yesterday !== undefined,
  });

  const invalidateAll = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['ws', workspaceId, 'dashboard'] });
    void queryClient.invalidateQueries({ queryKey: ['ws', workspaceId, 'tasks'] });
    void queryClient.invalidateQueries({ queryKey: ['ws', workspaceId, 'projects'] });
    void queryClient.invalidateQueries({ queryKey: ['ws', workspaceId, 'project'] });
  }, [queryClient, workspaceId]);

  // ---------------------------------------------------------------- 快速添加
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('p2');
  const [formError, setFormError] = useState<string | null>(null);
  const retryKey = useRef<string | null>(null);

  const createMutation = useMutation({
    mutationFn: (input: CreateTaskInput) => {
      retryKey.current ??= newIdempotencyKey();
      return tasksApi.create(workspaceId, input, retryKey.current);
    },
    onSuccess: () => {
      retryKey.current = null;
      setTitle('');
      setFormError(null);
      invalidateAll();
    },
    onError: (error) => {
      setFormError(describeApiError(error));
    },
  });

  const submitTask = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setFormError(null);
    if (title.trim() === '') {
      setFormError('请填写任务标题');
      return;
    }
    if (businessDate === undefined) {
      setFormError('业务日尚未加载完成，请稍后重试');
      return;
    }
    createMutation.mutate({ title: title.trim(), priority, dueDate: businessDate });
  };

  // ---------------------------------------------------------------- 完成 / 撤销 / 改期
  const [actionError, setActionError] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ task: Task } | null>(null);

  const completeMutation = useMutation({
    mutationFn: (task: Pick<Task, 'id' | 'version'>) => tasksApi.update(workspaceId, task, { status: 'done' }),
    onSuccess: (updated) => {
      setActionError(null);
      setUndo({ task: updated });
      invalidateAll();
      window.setTimeout(() => {
        setUndo((current) => (current?.task.id === updated.id ? null : current));
      }, 8000);
    },
    onError: (error) => {
      setActionError(describeApiError(error));
      if (error instanceof ApiError && error.isConflict) invalidateAll();
    },
  });

  const undoMutation = useMutation({
    mutationFn: (task: Task) => tasksApi.update(workspaceId, task, { status: 'todo' }),
    onSuccess: () => {
      setUndo(null);
      invalidateAll();
    },
    onError: (error) => {
      setActionError(describeApiError(error));
      if (error instanceof ApiError && error.isConflict) invalidateAll();
    },
  });

  const rescheduleMutation = useMutation({
    mutationFn: ({ task, dueDate }: { task: Pick<Task, 'id' | 'version'>; dueDate: string }) =>
      tasksApi.update(workspaceId, task, { dueDate }),
    onSuccess: () => {
      setActionError(null);
      invalidateAll();
    },
    onError: (error) => {
      setActionError(describeApiError(error));
      if (error instanceof ApiError && error.isConflict) invalidateAll();
    },
  });

  // ---------------------------------------------------------------- 昨日顺延
  const [postponePreview, setPostponePreview] = useState<{ count: number; fromDate: string; toDate: string } | null>(
    null,
  );
  const postponeMutation = useMutation({
    mutationFn: (dryRun: boolean) => tasksApi.postponeYesterday(workspaceId, dryRun),
    onSuccess: (result) => {
      if (result.dryRun) {
        setPostponePreview({ count: result.count, fromDate: result.fromDate, toDate: result.toDate });
        return;
      }
      setPostponePreview(null);
      setActionError(null);
      invalidateAll();
    },
    onError: (error) => setActionError(describeApiError(error)),
  });

  if (dashboardQuery.status === 'pending') return <LoadingState label="加载今日数据…" />;
  if (dashboardQuery.status === 'error') {
    return (
      <ErrorState
        title="无法加载今日数据"
        message={describeApiError(dashboardQuery.error)}
        onRetry={() => {
          void dashboardQuery.refetch();
        }}
      />
    );
  }

  const dashboard = dashboardQuery.data;
  const todayTasks = todayTasksQuery.data?.tasks ?? [];
  const yesterdayIncomplete = (yesterdayTasksQuery.data?.tasks ?? []).filter((task) => task.status !== 'done');
  const writable = can('business.write');

  return (
    <>
      <PageHeader
        title="今日聚焦"
        description={`业务日 ${dashboard.businessDate}（${dashboard.timezone}）· 紧急 ${dashboard.urgentCount} 项 · 未完成 ${dashboard.counts.openTasks} 项`}
      />

      {actionError === null ? null : (
        <p className={styles.banner} role="alert">
          {actionError}
        </p>
      )}

      {undo === null ? null : (
        <div className={styles.undoBar} role="status">
          <span>已完成「{undo.task.title}」</span>
          <button
            type="button"
            className={styles.undoButton}
            onClick={() => undoMutation.mutate(undo.task)}
            disabled={undoMutation.isPending}
          >
            撤销
          </button>
        </div>
      )}

      <section className={styles.quickAdd} aria-label="快速添加任务">
        <form className={styles.quickForm} onSubmit={submitTask}>
          <label className={styles.grow}>
            <span className="sr-only">任务标题</span>
            <input
              className={styles.input}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="新增今日任务（Enter 保存）"
              disabled={!writable}
            />
          </label>
          <label>
            <span className="sr-only">优先级</span>
            <select
              className={styles.select}
              value={priority}
              onChange={(event) => setPriority(event.target.value as TaskPriority)}
              disabled={!writable}
            >
              <option value="p0">P0</option>
              <option value="p1">P1</option>
              <option value="p2">P2</option>
            </select>
          </label>
          <button type="submit" className={styles.primary} disabled={!writable || createMutation.isPending}>
            {createMutation.isPending ? '添加中…' : '添加'}
          </button>
        </form>
        {formError === null ? null : (
          <p className={styles.error} role="alert">
            {formError}
          </p>
        )}
        {!writable ? <p className={styles.hint}>当前角色为只读，不能新增或修改任务。</p> : null}
      </section>

      <section className={styles.section} aria-labelledby="urgent-heading">
        <h2 id="urgent-heading" className={styles.sectionTitle}>
          紧急区 <span className={styles.count}>{dashboard.urgentCount}</span>
        </h2>
        {dashboard.urgentCount === 0 ? (
          <EmptyState title="今天没有紧急项" description="逾期、停滞与草稿超期会出现在这里。" />
        ) : (
          <div className={styles.list}>
            {dashboard.urgent.overdue.map((task) => (
              <UrgentRow
                key={`overdue-${task.id}`}
                task={task}
                reason={`逾期 ${task.overdueDays ?? 0} 天`}
                tone="danger"
                onComplete={() => completeMutation.mutate({ id: task.id, version: task.version })}
                onReschedule={(dueDate) => rescheduleMutation.mutate({ task: { id: task.id, version: task.version }, dueDate })}
                busy={completeMutation.isPending || rescheduleMutation.isPending || !writable}
              />
            ))}
            {dashboard.urgent.stalled.map((task) => (
              <UrgentRow
                key={`stalled-${task.id}`}
                task={task}
                reason={`停滞 ${task.stalledDays ?? 0} 天`}
                tone="warn"
                onComplete={() => completeMutation.mutate({ id: task.id, version: task.version })}
                onReschedule={(dueDate) => rescheduleMutation.mutate({ task: { id: task.id, version: task.version }, dueDate })}
                busy={completeMutation.isPending || rescheduleMutation.isPending || !writable}
              />
            ))}
            {dashboard.urgent.staleDrafts.map((entry) => (
              <div key={`draft-${entry.id}`} className={styles.row}>
                <span className={styles.badgeDraft}>草稿</span>
                <span className={styles.title}>{entry.title}</span>
                <span className={styles.meta}>创建 {entry.ageDays} 天未补摘要</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className={styles.columns}>
        <section className={styles.section} aria-labelledby="today-heading">
          <h2 id="today-heading" className={styles.sectionTitle}>
            今日任务 <span className={styles.count}>{dashboard.counts.todayTasks}</span>
          </h2>
          {todayTasksQuery.status === 'pending' ? <SkeletonRows rows={2} /> : null}
          {todayTasks.length === 0 && todayTasksQuery.status === 'success' ? (
            <EmptyState title="今天还没有任务" description="用上方的输入框添加第一条。" />
          ) : (
            <div className={styles.list}>
              {todayTasks.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  onComplete={() => completeMutation.mutate(task)}
                  onReschedule={(dueDate) => rescheduleMutation.mutate({ task, dueDate })}
                  busy={completeMutation.isPending || rescheduleMutation.isPending || !writable}
                />
              ))}
            </div>
          )}
        </section>

        <section className={styles.section} aria-labelledby="yesterday-heading">
          <h2 id="yesterday-heading" className={styles.sectionTitle}>
            昨天未完成 <span className={styles.count}>{yesterdayIncomplete.length}</span>
          </h2>
          {yesterdayIncomplete.length === 0 ? (
            <EmptyState title="昨天没有遗留任务" description="若有未完成任务，可一次性顺延到今天。" />
          ) : (
            <>
              <div className={styles.list}>
                {yesterdayIncomplete.map((task) => (
                  <div key={task.id} className={styles.row}>
                    <span className={styles.badge}>{PRIORITY_LABEL[task.priority]}</span>
                    <span className={styles.title}>{task.title}</span>
                    <span className={styles.meta}>{task.dueDate}</span>
                  </div>
                ))}
              </div>
              {writable ? (
                <div className={styles.postpone}>
                  {postponePreview === null ? (
                    <button
                      type="button"
                      className={styles.secondary}
                      onClick={() => postponeMutation.mutate(true)}
                      disabled={postponeMutation.isPending}
                    >
                      顺延到今日（先预览）
                    </button>
                  ) : (
                    <div className={styles.preview} role="dialog" aria-label="确认顺延">
                      <p className={styles.previewText}>
                        将把 {postponePreview.count} 项从 {postponePreview.fromDate} 顺延到 {postponePreview.toDate}。
                        更早逾期与已完成任务不受影响。
                      </p>
                      <div className={styles.previewActions}>
                        <button type="button" className={styles.secondary} onClick={() => setPostponePreview(null)}>
                          取消
                        </button>
                        <button
                          type="button"
                          className={styles.primary}
                          onClick={() => postponeMutation.mutate(false)}
                          disabled={postponeMutation.isPending}
                        >
                          确认顺延
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ) : null}
            </>
          )}
        </section>
      </div>
    </>
  );
}

function TaskRow({
  task,
  onComplete,
  onReschedule,
  busy,
}: {
  task: Task;
  onComplete: () => void;
  onReschedule: (dueDate: string) => void;
  busy: boolean;
}): React.JSX.Element {
  const [rescheduling, setRescheduling] = useState(false);
  const [dueDate, setDueDate] = useState(task.dueDate ?? '');

  return (
    <div className={styles.row} data-task-title={task.title}>
      <span className={`${styles.badge} ${styles[`p${task.priority}`]}`}>{PRIORITY_LABEL[task.priority]}</span>
      <span className={styles.title}>{task.title}</span>
      {task.status === 'doing' ? <span className={styles.badgeMuted}>进行中</span> : null}
      {rescheduling ? (
        <span className={styles.reschedule}>
          <input
            className={styles.dateInput}
            type="date"
            value={dueDate}
            onChange={(event) => setDueDate(event.target.value)}
            aria-label="新的截止日"
          />
          <button
            type="button"
            className={styles.smallPrimary}
            onClick={() => {
              if (dueDate !== '') {
                onReschedule(dueDate);
                setRescheduling(false);
              }
            }}
            disabled={busy}
          >
            保存
          </button>
          <button type="button" className={styles.small} onClick={() => setRescheduling(false)}>
            取消
          </button>
        </span>
      ) : (
        <span className={styles.rowActions}>
          <button type="button" className={styles.small} onClick={() => setRescheduling(true)} disabled={busy}>
            改期
          </button>
          <button type="button" className={styles.smallPrimary} onClick={onComplete} disabled={busy}>
            完成
          </button>
        </span>
      )}
    </div>
  );
}

function UrgentRow({
  task,
  reason,
  tone,
  onComplete,
  onReschedule,
  busy,
}: {
  task: UrgentTask;
  reason: string;
  tone: 'danger' | 'warn';
  onComplete: () => void;
  onReschedule: (dueDate: string) => void;
  busy: boolean;
}): React.JSX.Element {
  const [rescheduling, setRescheduling] = useState(false);
  const [dueDate, setDueDate] = useState(task.dueDate ?? '');

  return (
    <div className={styles.row} data-task-title={task.title}>
      <span className={tone === 'danger' ? styles.badgeDanger : styles.badgeWarn}>{reason}</span>
      <span className={styles.title}>{task.title}</span>
      {rescheduling ? (
        <span className={styles.reschedule}>
          <input
            className={styles.dateInput}
            type="date"
            value={dueDate}
            onChange={(event) => setDueDate(event.target.value)}
            aria-label="新的截止日"
          />
          <button
            type="button"
            className={styles.smallPrimary}
            onClick={() => {
              if (dueDate !== '') {
                onReschedule(dueDate);
                setRescheduling(false);
              }
            }}
            disabled={busy}
          >
            保存
          </button>
          <button type="button" className={styles.small} onClick={() => setRescheduling(false)}>
            取消
          </button>
        </span>
      ) : (
        <span className={styles.rowActions}>
          <button type="button" className={styles.small} onClick={() => setRescheduling(true)} disabled={busy}>
            改期
          </button>
          <button type="button" className={styles.smallPrimary} onClick={onComplete} disabled={busy}>
            完成
          </button>
        </span>
      )}
    </div>
  );
}
