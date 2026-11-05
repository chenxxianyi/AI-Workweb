import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useWorkspace } from '../../providers/workspace-provider';
import { ApiError, apiClient } from '../../services/api-client';
import { describeApiError, ensureCsrfToken } from '../../services/auth-api';
import { newIdempotencyKey, type Task } from '../../services/tasks-api';
import { ErrorState, LoadingState, PageHeader } from '../../components/states';
interface TaskDetail extends Task {
  entries?: { id: string; title: string }[];
}
export function PromoteTaskButton({
  taskId,
  version,
  newEntry = false,
  label = '沉淀',
}: {
  taskId: string;
  version?: number;
  newEntry?: boolean;
  label?: string;
}): React.JSX.Element {
  const { workspace, can } = useWorkspace();
  const workspaceId = workspace?.workspaceId ?? '';
  const operation = useRef<{ key: string; version: number } | null>(null);
  const navigate = useNavigate();
  const client = useQueryClient();
  const [error, setError] = useState('');
  const mutation = useMutation({
    mutationFn: async () => {
      await ensureCsrfToken();
      if (operation.current === null) {
        const currentVersion =
          version ??
          (await apiClient.get<TaskDetail>('/workspaces/' + workspaceId + '/tasks/' + taskId))
            .version;
        operation.current = { key: newIdempotencyKey(), version: currentVersion };
      }
      return apiClient.post<{ entryId: string }>(
        '/workspaces/' + workspaceId + '/tasks/' + taskId + '/promote',
        { newEntry },
        { ifMatch: operation.current.version, idempotencyKey: operation.current.key },
      );
    },
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: ['ws', workspaceId] });
      navigate('/kb/' + result.entryId, { state: { from: '/tasks/' + taskId, edit: true } });
    },
    onError: (reason) => {
      setError(describeApiError(reason));
      if (reason instanceof ApiError && reason.isConflict) {
        operation.current = null;
        void client.invalidateQueries({ queryKey: ['ws', workspaceId] });
      }
    },
  });
  return can('business.write') ? (
    <span>
      <button
        type="button"
        disabled={mutation.isPending}
        onClick={() => {
          setError('');
          mutation.mutate();
        }}
      >
        {mutation.isPending ? '沉淀中…' : label}
      </button>
      {error ? <small role="alert">{error}</small> : null}
    </span>
  ) : (
    <Link to={'/tasks/' + taskId}>查看</Link>
  );
}
export function TaskDetailPage(): React.JSX.Element {
  const { taskId = '' } = useParams();
  const { workspace } = useWorkspace();
  const workspaceId = workspace?.workspaceId ?? '';
  const query = useQuery({
    queryKey: ['ws', workspaceId, 'task', taskId],
    queryFn: ({ signal }) =>
      apiClient.get<TaskDetail>('/workspaces/' + workspaceId + '/tasks/' + taskId, { signal }),
    enabled: workspaceId !== '' && taskId !== '',
  });
  if (query.isPending) return <LoadingState />;
  if (query.isError && query.data === undefined)
    return (
      <ErrorState message={describeApiError(query.error)} onRetry={() => void query.refetch()} />
    );
  if (query.data === undefined) return <LoadingState />;
  const task = query.data;
  return (
    <>
      <p>
        <Link to="/today">返回今日聚焦</Link>
      </p>
      <PageHeader
        title={task.title}
        description={
          task.priority.toUpperCase() + ' · ' + task.status + ' · ' + (task.dueDate ?? '无截止日')
        }
        actions={
          <PromoteTaskButton
            taskId={task.id}
            version={task.version}
            label={task.entries?.length ? '查看已有沉淀' : '一键沉淀知识'}
          />
        }
      />
      <p>
        任务ID：<code>{task.id}</code>；当前版本：{task.version}。
        <Link to="/offline">在本机队列记录离线状态变更</Link>
      </p>
      <section>
        <h2>卡点</h2>
        <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {task.blocker || '暂无卡点，可先沉淀任务过程。'}
        </p>
        {task.projectId ? <Link to={'/projects/' + task.projectId}>所属项目</Link> : null}
      </section>
      <section>
        <h2>关联知识</h2>
        {task.entries?.length ? (
          <>
            <ul>
              {task.entries.map((entry) => (
                <li key={entry.id}>
                  <Link to={'/kb/' + entry.id}>{entry.title || '未命名草稿'}</Link>
                </li>
              ))}
            </ul>
            <PromoteTaskButton
              taskId={task.id}
              version={task.version}
              newEntry
              label="再沉淀一条（新建）"
            />
          </>
        ) : (
          <p>还没有沉淀，点击上方按钮生成预填草稿。</p>
        )}
      </section>
    </>
  );
}
