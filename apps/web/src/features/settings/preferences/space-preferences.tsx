import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useWorkspace } from '../../../providers/workspace-provider';
import { useAuth } from '../../../providers/auth-provider';
import { apiClient } from '../../../services/api-client';
import { describeApiError, ensureCsrfToken } from '../../../services/auth-api';
import { ErrorState, LoadingState } from '../../../components/states';
import styles from '../settings-page.module.css';
interface SpacePreference {
  total: number;
  completedTasks: number;
  reminderEligible: boolean;
  tipShownAt: string | null;
  lastBusinessExportAt: string | null;
  databaseBackup: { state: string; description: string };
}
const endpoint = (id: string) => '/workspaces/' + id + '/preferences';
export function SpaceReminder(): React.JSX.Element | null {
  const { workspace } = useWorkspace(),
    { user } = useAuth();
  return workspace && user ? (
    <Reminder key={user.id + workspace.workspaceId} id={workspace.workspaceId} />
  ) : null;
}
function Reminder({ id }: { id: string }): React.JSX.Element | null {
  const started = useRef(false),
    [messages, setMessages] = useState<string[]>([]);
  const data = useQuery({
    queryKey: ['ws', id, 'preferences'],
    queryFn: ({ signal }) => apiClient.get<SpacePreference>(endpoint(id), { signal }),
    staleTime: 60000,
  });
  const claim = useMutation({
    mutationFn: async () => {
      await ensureCsrfToken();
      return apiClient.post<{ show: boolean; messages: string[] }>(endpoint(id) + '/reminder', {});
    },
    onSuccess: (r) => {
      if (r.show) setMessages(r.messages);
    },
  });
  useEffect(() => {
    if (data.data?.reminderEligible && !started.current) {
      started.current = true;
      claim.mutate();
    }
  }, [data.data?.reminderEligible, claim]);
  if (!messages.length) return null;
  return (
    <aside className={styles.section} aria-label="资料整理提醒">
      <p>{messages.join(' ')}</p>
      <Link to="/settings/transfers">查看导出与迁移</Link>
      <button className={styles.chip} onClick={() => setMessages([])}>
        知道了
      </button>
    </aside>
  );
}
export function SpacePreferences(): React.JSX.Element {
  const { workspace, role } = useWorkspace();
  return (
    <Preferences
      key={workspace?.workspaceId ?? ''}
      id={workspace?.workspaceId ?? ''}
      owner={role === 'owner'}
    />
  );
}
function Preferences({ id, owner }: { id: string; owner: boolean }): React.JSX.Element {
  const client = useQueryClient(),
    { refresh } = useAuth();
  const [timezone, setTimezone] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [quota, setQuota] = useState('正在检查本地草稿容量…');
  const data = useQuery({
    queryKey: ['ws', id, 'preferences'],
    queryFn: ({ signal }) => apiClient.get<SpacePreference>(endpoint(id), { signal }),
    enabled: !!id,
  });
  const workspace = useQuery({
    queryKey: ['ws', id, 'settings'],
    queryFn: () => apiClient.get<{ timezone: string; version: number }>('/workspaces/' + id),
    enabled: !!id,
  });
  const save = useMutation({
    mutationFn: async () => {
      await ensureCsrfToken();
      return apiClient.patch(
        '/workspaces/' + id,
        { timezone: timezone || workspace.data!.timezone },
        { ifMatch: workspace.data!.version },
      );
    },
    onSuccess: () => {
      setConfirmed(false);
      void client.invalidateQueries({ queryKey: ['ws', id] });
      void refresh();
    },
  });
  useEffect(() => {
    let alive = true;
    if (navigator.storage?.estimate)
      void navigator.storage
        .estimate()
        .then((r) => {
          if (alive)
            setQuota(
              `浏览器本地占用约${Math.round((r.usage ?? 0) / 1024)} KiB，可用配额约${Math.round((r.quota ?? 0) / 1024 / 1024)} MiB；只影响本地草稿，不是服务器容量。`,
            );
        })
        .catch(() => {
          if (alive) setQuota('浏览器无法估算本地容量；正常服务器保存不受此检查影响。');
        });
    else setQuota('浏览器未提供本地容量估算；正常服务器保存不受影响。');
    return () => {
      alive = false;
    };
  }, []);
  return (
    <>
      <section className={styles.section}>
        <h2>空间时区</h2>
        {workspace.isPending ? (
          <LoadingState />
        ) : workspace.isError ? (
          <ErrorState
            message={describeApiError(workspace.error)}
            onRetry={() => void workspace.refetch()}
          />
        ) : (
          <div className={styles.form}>
            <label className={styles.field}>
              IANA时区
              <input
                className={styles.input}
                value={timezone || workspace.data.timezone}
                disabled={!owner || save.isPending}
                onChange={(e) => setTimezone(e.target.value)}
                placeholder="Asia/Shanghai"
                maxLength={64}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                disabled={!owner || save.isPending}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              我已了解：时区会改变今日与统计边界，不会改写已有业务日期。
            </label>
            <button
              className={styles.primary}
              disabled={!owner || !confirmed || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? '保存中…' : '确认修改时区'}
            </button>
            {!owner ? <p>仅Owner可修改空间时区。</p> : null}
            {save.isSuccess ? <p role="status">时区已保存。</p> : null}
            {save.isError ? <p role="alert">{describeApiError(save.error)}</p> : null}
          </div>
        )}
      </section>
      <section className={styles.section}>
        <h2>容量与备份状态</h2>
        {data.isPending ? (
          <LoadingState />
        ) : data.isError ? (
          <ErrorState message={describeApiError(data.error)} onRetry={() => void data.refetch()} />
        ) : (
          <>
            <p>
              业务记录 {data.data.total} 条；已完成任务 {data.data.completedTasks}{' '}
              条。系统仅提醒整理，不会自动删除。
            </p>
            <p>
              你在本空间最近业务导出：
              {data.data.lastBusinessExportAt
                ? new Date(data.data.lastBusinessExportAt).toLocaleString()
                : '尚无成功导出记录'}
              。
            </p>
            <p>数据库备份：{data.data.databaseBackup.description}</p>
          </>
        )}
        <p>{quota}</p>
      </section>
    </>
  );
}
