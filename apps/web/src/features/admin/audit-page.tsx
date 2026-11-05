import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../../services/api-client';
import { describeApiError } from '../../services/auth-api';
import { PageHeader, ErrorState, LoadingState } from '../../components/states';
import { OwnerPage } from './owner-page';
import styles from '../settings/settings-page.module.css';
interface Event {
  id: string;
  at: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  actorId: string | null;
  result: string;
  summary: string | null;
  requestId: string | null;
}
export function AuditPage(): React.JSX.Element {
  return <OwnerPage>{(id) => <Audit key={id} workspaceId={id} />}</OwnerPage>;
}
function Audit({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const [action, setAction] = useState(''),
    [input, setInput] = useState(''),
    [cursor, setCursor] = useState<string | undefined>();
  const query = useQuery({
    queryKey: ['ws', workspaceId, 'audit', action, cursor],
    queryFn: ({ signal }) =>
      apiClient.get<{ events: Event[]; nextCursor: string | null }>(
        '/workspaces/' +
          workspaceId +
          '/audit-events?' +
          new URLSearchParams({ ...(action ? { action } : {}), ...(cursor ? { cursor } : {}) }),
        { signal },
      ),
  });
  return (
    <>
      <PageHeader
        title="操作审计"
        description="仅Owner可查看当前空间的操作摘要；不记录密码、令牌和整篇正文。"
      />
      <form
        className={styles.row}
        onSubmit={(e) => {
          e.preventDefault();
          setAction(input);
          setCursor(undefined);
        }}
      >
        <label className={styles.field}>
          操作筛选（留空显示全部）
          <input
            className={styles.input}
            maxLength={64}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="例如 trash.restored"
          />
        </label>
        <button className={styles.primary}>查询</button>
      </form>
      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState message={describeApiError(query.error)} onRetry={() => void query.refetch()} />
      ) : query.data.events.length === 0 ? (
        <p>暂无审计记录。</p>
      ) : (
        <ol>
          {query.data.events.map((event) => (
            <li key={event.id} className={styles.section}>
              <p>
                {new Date(event.at).toLocaleString()} · {event.action} · {event.result}
              </p>
              <p>{event.summary}</p>
              <p style={{ overflowWrap: 'anywhere' }}>
                对象：{event.entityType ?? '—'} {event.entityId ?? ''}；操作者：
                {event.actorId ?? '系统'}
                {event.requestId ? '；请求号：' + event.requestId : ''}
              </p>
            </li>
          ))}
        </ol>
      )}
      <div className={styles.row}>
        {cursor ? <button onClick={() => setCursor(undefined)}>第一页</button> : null}
        {query.data?.nextCursor ? (
          <button onClick={() => setCursor(query.data?.nextCursor ?? undefined)}>下一页</button>
        ) : null}
      </div>
    </>
  );
}
