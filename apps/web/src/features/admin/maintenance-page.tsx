import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../providers/auth-provider';
import { ApiError, apiClient } from '../../services/api-client';
import { describeApiError, ensureCsrfToken } from '../../services/auth-api';
import { newIdempotencyKey } from '../../services/tasks-api';
import { PageHeader, LoadingState, ErrorState } from '../../components/states';
import { ConfirmationDialog } from '../../components/confirmation-dialog';
import { OwnerPage } from './owner-page';
import styles from '../settings/settings-page.module.css';
interface TrashItem {
  id: string;
  type: string;
  title: string;
  version: number;
  deletedAt: string;
  expiresAt: string;
}
interface Space {
  id: string;
  name: string;
  version: number;
}
export function MaintenancePage(): React.JSX.Element {
  return <OwnerPage>{(id) => <Maintenance key={id} workspaceId={id} />}</OwnerPage>;
}
function Maintenance({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const base = '/workspaces/' + workspaceId,
    client = useQueryClient(),
    { refresh } = useAuth();
  const [type, setType] = useState('entry'),
    [cursor, setCursor] = useState<string | undefined>(),
    [purging, setPurging] = useState<TrashItem | null>(null),
    [ackPurge, setAckPurge] = useState(false),
    [clearOpen, setClearOpen] = useState(false),
    [name, setName] = useState(''),
    [password, setPassword] = useState(''),
    [ack, setAck] = useState(false),
    [message, setMessage] = useState('');
  const purgeKey = useRef<string | null>(null),
    clearOp = useRef<{
      key: string;
      version: number;
      body: { confirmName: string; password: string; backupAcknowledged: true };
    } | null>(null);
  const space = useQuery({
    queryKey: ['ws', workspaceId, 'settings'],
    queryFn: () => apiClient.get<Space>(base),
  });
  const query = useQuery({
    queryKey: ['ws', workspaceId, 'trash', type, cursor],
    queryFn: ({ signal }) =>
      apiClient.get<{ items: TrashItem[]; nextCursor: string | null }>(
        base + '/trash?type=' + type + (cursor ? '&cursor=' + cursor : ''),
        { signal },
      ),
  });
  const invalidate = () => {
    void client.invalidateQueries({ queryKey: ['ws', workspaceId] });
    void refresh();
  };
  const restore = useMutation({
    mutationFn: async (item: TrashItem) => {
      await ensureCsrfToken();
      return apiClient.post<{ warnings: string[] }>(
        base + '/trash/' + item.type + '/' + item.id + '/restore',
        {},
        { ifMatch: item.version },
      );
    },
    onSuccess: (r) => {
      setMessage('已恢复。' + r.warnings.join(' '));
      invalidate();
    },
  });
  const purge = useMutation({
    mutationFn: async () => {
      await ensureCsrfToken();
      purgeKey.current ??= newIdempotencyKey();
      return apiClient.del(base + '/trash/' + purging!.type + '/' + purging!.id, {
        body: { confirm: true },
        ifMatch: purging!.version,
        idempotencyKey: purgeKey.current,
      });
    },
    onSuccess: () => {
      setPurging(null);
      purgeKey.current = null;
      setMessage('已永久删除。');
      invalidate();
    },
  });
  const clear = useMutation({
    mutationFn: async () => {
      await ensureCsrfToken();
      clearOp.current ??= {
        key: newIdempotencyKey(),
        version: space.data!.version,
        body: { confirmName: name, password, backupAcknowledged: true },
      };
      const op = clearOp.current;
      return apiClient.post(base + '/maintenance/clear', op.body, {
        ifMatch: op.version,
        idempotencyKey: op.key,
        timeoutMs: 120000,
      });
    },
    onSuccess: () => {
      setClearOpen(false);
      setPassword('');
      setName('');
      setAck(false);
      clearOp.current = null;
      setMessage('当前空间业务已清空，账号、成员与审计保留。');
      invalidate();
    },
    onError: (error) => {
      if (error instanceof ApiError && [401, 403, 412, 422, 428].includes(error.status ?? 0)) {
        clearOp.current = null;
        setAck(false);
        void space.refetch();
      }
    },
  });
  const error = restore.error ?? purge.error ?? clear.error;
  return (
    <>
      <PageHeader
        title="回收站与空间维护"
        description="软删除记录保留30天，到期后有审计地永久清理。恢复时不会复活已删除的父对象。"
      />
      {message ? <p role="status">{message}</p> : null}
      {error ? <p role="alert">{describeApiError(error)}</p> : null}
      <section className={styles.section}>
        <h2>回收站</h2>
        <label className={styles.field}>
          记录类型
          <select
            className={styles.input}
            value={type}
            onChange={(e) => {
              setType(e.target.value);
              setCursor(undefined);
            }}
          >
            {Object.entries({
              project: '项目',
              task: '任务',
              entry: '知识',
              log: '开发日志',
              ledger: 'AI台账',
            }).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {query.isPending ? (
          <LoadingState />
        ) : query.isError ? (
          <ErrorState
            message={describeApiError(query.error)}
            onRetry={() => void query.refetch()}
          />
        ) : query.data.items.length === 0 ? (
          <p>本类回收站为空。</p>
        ) : (
          <ul>
            {query.data.items.map((item) => (
              <li key={item.id}>
                <p style={{ overflowWrap: 'anywhere' }}>{item.title}</p>
                <p>
                  删除于{new Date(item.deletedAt).toLocaleString()}；保留至
                  {new Date(item.expiresAt).toLocaleString()}
                </p>
                <div className={styles.row}>
                  <button
                    className={styles.secondary}
                    disabled={restore.isPending}
                    onClick={() => restore.mutate(item)}
                  >
                    恢复
                  </button>
                  <button
                    className={styles.danger}
                    onClick={() => {
                      setPurging(item);
                      setAckPurge(false);
                      purgeKey.current = null;
                    }}
                  >
                    彻底删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className={styles.row}>
          {cursor ? <button onClick={() => setCursor(undefined)}>第一页</button> : null}
          {query.data?.nextCursor ? (
            <button onClick={() => setCursor(query.data?.nextCursor ?? undefined)}>下一页</button>
          ) : null}
        </div>
      </section>
      <section className={styles.section}>
        <h2>清空当前空间业务</h2>
        <p>
          永久清空当前空间的项目、任务、知识、日志、台账及关联。账号、成员、偏好和审计会保留。提交前自动保存一份业务快照；完整数据库备份仍需单独管理。
        </p>
        <button
          className={styles.danger}
          disabled={!space.data}
          onClick={() => {
            setName('');
            setPassword('');
            setAck(false);
            clearOp.current = null;
            setClearOpen(true);
          }}
        >
          清空当前空间业务
        </button>
      </section>
      {purging ? (
        <ConfirmationDialog
          title="确认永久删除"
          busy={purge.isPending}
          onClose={() => setPurging(null)}
        >
          <p>{purging.title}</p>
          <label>
            <input
              type="checkbox"
              checked={ackPurge}
              onChange={(e) => setAckPurge(e.target.checked)}
            />
            我已了解：此操作无法从回收站恢复。
          </label>
          <button disabled={!ackPurge || purge.isPending} onClick={() => purge.mutate()}>
            确认永久删除
          </button>
        </ConfirmationDialog>
      ) : null}
      {clearOpen ? (
        <ConfirmationDialog
          title={'确认清空 ' + space.data?.name}
          busy={clear.isPending || (clear.error instanceof ApiError && clear.error.isUnknownResult)}
          onClose={() => {
            setClearOpen(false);
            setPassword('');
            clearOp.current = null;
          }}
        >
          <form
            className={styles.form}
            onSubmit={(e) => {
              e.preventDefault();
              if (ack && name === space.data?.name && password) clear.mutate();
            }}
          >
            <label className={styles.field}>
              输入空间名称
              <input
                className={styles.input}
                value={name}
                disabled={clear.isPending || !!clearOp.current}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className={styles.field}>
              重新输入当前密码
              <input
                className={styles.input}
                type="password"
                autoComplete="current-password"
                value={password}
                disabled={clear.isPending || !!clearOp.current}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <label>
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              我已检查备份，了解业务清空的范围及不可直接撤销。
            </label>
            <button
              className={styles.danger}
              type="submit"
              disabled={!ack || name !== space.data?.name || !password || clear.isPending}
            >
              {clear.isPending
                ? '正在保存快照并清空…'
                : clearOp.current
                  ? '重试原清空操作'
                  : '确认清空当前空间'}
            </button>
            {clear.isError ? (
              <p role="alert">{describeApiError(clear.error)}；未知结果请用当前操作重试。</p>
            ) : null}
          </form>
        </ConfirmationDialog>
      ) : null}
    </>
  );
}
