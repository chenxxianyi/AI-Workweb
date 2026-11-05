import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../providers/auth-provider';
import { useWorkspace } from '../providers/workspace-provider';
import { apiClient } from '../services/api-client';
import { useRefreshGuard } from './refresh-guard';
import { useDraftFlush } from './draft-flush';
import { transaction } from './store';
import {
  deleteLocalRecord,
  exportLocal,
  loadDraft,
  persistOperation,
  rebaseTaskIntent,
  records,
  saveDraft,
  syncQueue,
  type LocalDraft,
  type Operation,
  type QueuedOperation,
} from './queue';
import styles from '../features/settings/settings-page.module.css';
export function OfflinePage(): React.JSX.Element {
  const { user } = useAuth(),
    { workspace } = useWorkspace();
  return user && workspace ? (
    <Editor
      key={user.id + workspace.workspaceId}
      userId={user.id}
      workspaceId={workspace.workspaceId}
    />
  ) : (
    <p>请选择空间</p>
  );
}
interface Context {
  workspaceVersion: number;
  businessDate: string;
  canWrite: boolean;
}
function Editor({
  userId,
  workspaceId,
}: {
  userId: string;
  workspaceId: string;
}): React.JSX.Element {
  const [kind, setKind] = useState<Operation['kind']>('log'),
    [text, setText] = useState(''),
    [title, setTitle] = useState(''),
    [taskId, setTaskId] = useState(''),
    [version, setVersion] = useState(1),
    [status, setStatus] = useState<'todo' | 'doing' | 'done'>('done'),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [context, setContext] = useState<Context | null>(null);
  const [taskComparison, setTaskComparison] = useState<{
    row: QueuedOperation;
    server: { title: string; status: string; version: number };
    workspaceVersion: number;
  } | null>(null);
  const dirty = !!text || !!title || (kind === 'task-state' && !!taskId);
  const keepDraft = (
    override: Partial<{
      text: string;
      title: string;
      taskId: string;
      version: number;
      status: 'todo' | 'doing' | 'done';
    }> = {},
  ) => {
    const value = { text, title, taskId, version, status, ...override };
    return value.text || value.title || (kind === 'task-state' && value.taskId)
      ? saveDraft(userId, workspaceId, 'offline-composer:' + kind, value)
      : deleteLocalRecord('drafts', userId + ':' + workspaceId + ':offline-composer:' + kind);
  };
  useRefreshGuard(dirty);
  useDraftFlush(dirty, () => keepDraft());
  const changeKind = async (next: Operation['kind']) => {
    setBusy(true);
    try {
      await keepDraft();
      const draft = await loadDraft(userId, workspaceId, 'offline-composer:' + next),
        v = draft?.value as
          | {
              text?: string;
              title?: string;
              taskId?: string;
              version?: number;
              status?: typeof status;
            }
          | undefined;
      setKind(next);
      setText(v?.text ?? '');
      setTitle(v?.title ?? '');
      setTaskId(v?.taskId ?? '');
      setVersion(v?.version ?? 1);
      setStatus(v?.status ?? 'done');
    } catch {
      setMessage('当前输入未能保存到本机，类型未切换；请先导出。');
    } finally {
      setBusy(false);
    }
  };
  const compare = async (row: QueuedOperation) => {
    if (row.operation.kind !== 'task-state') return;
    try {
      const server = await apiClient.get<{ title: string; status: string; version: number }>(
          '/workspaces/' + workspaceId + '/tasks/' + row.operation.payload.id,
        ),
        fresh = await apiClient.get<Context>(
          '/workspaces/' + workspaceId + '/offline-operations/context',
        );
      setTaskComparison({ row, server, workspaceVersion: fresh.workspaceVersion });
    } catch (error) {
      setMessage((error as Error).message);
    }
  };
  const query = useQuery({
    queryKey: ['user', userId, 'ws', workspaceId, 'offline-intents'],
    queryFn: async () => ({
      queue: await records<QueuedOperation>('queue', userId, workspaceId),
      drafts: await records<LocalDraft>('drafts', userId, workspaceId),
    }),
    refetchInterval: 3000,
  });
  useEffect(() => {
    let active = true;
    void (async () => {
      const stored = await transaction<{ value: Context } | undefined>('meta', 'readonly', (s) =>
        s.get(userId + ':' + workspaceId + ':offline-context'),
      );
      if (active && stored) setContext(stored.value);
      const draft =
        (await loadDraft(userId, workspaceId, 'offline-composer:log')) ??
        (await loadDraft(userId, workspaceId, 'offline-composer'));
      if (active && draft) {
        const value = draft.value as { text: string; title: string };
        setText(value.text);
        setTitle(value.title);
      }
      try {
        const fresh = await apiClient.get<Context>(
          '/workspaces/' + workspaceId + '/offline-operations/context',
        );
        if (active) {
          setContext(fresh);
          await transaction('meta', 'readwrite', (s) =>
            s.put({ id: userId + ':' + workspaceId + ':offline-context', value: fresh }),
          );
        }
      } catch {
        /* 无上下文禁止排队 */
      }
    })().catch(() => setMessage('本机存储不可用，请使用导出当前输入。'));
    return () => {
      active = false;
    };
  }, [userId, workspaceId]);
  const data = () =>
    kind === 'log'
      ? ({ kind, payload: { text, logDate: context?.businessDate ?? '' } } as Operation)
      : kind === 'draft'
        ? ({ kind, payload: { title, body: text, type: 'note' } } as Operation)
        : ({ kind, payload: { id: taskId, status, version } } as Operation);
  const persist = async () => {
    setBusy(true);
    try {
      if (!context?.canWrite) throw new Error('需先联网确认可写空间上下文');
      if (kind !== 'task-state' && !text.trim() && !title.trim()) throw new Error('请填写内容');
      if (kind === 'log' && text.length > 4000) throw new Error('日志最多4000字');
      if (kind === 'draft' && new TextEncoder().encode(text).length > 20480)
        throw new Error('正文最多20480字节');
      if (kind === 'task-state' && (!/^[0-9a-f-]{36}$/.test(taskId) || version < 1))
        throw new Error('请填写任务ID和原版本');
      await persistOperation(userId, workspaceId, context.workspaceVersion, data());
      await deleteLocalRecord('drafts', userId + ':' + workspaceId + ':offline-composer:' + kind);
      if (kind === 'log')
        await deleteLocalRecord('drafts', userId + ':' + workspaceId + ':offline-composer');
      setText('');
      setTitle('');
      setTaskId('');
      setMessage('已持久保存到本机待同步队列，尚未保存到服务器。');
      await query.refetch();
    } catch (error) {
      setMessage((error as Error).message + '；输入仍保留，可导出当前输入。');
    } finally {
      setBusy(false);
    }
  };
  const sync = async () => {
    setBusy(true);
    try {
      await syncQueue(userId, workspaceId);
      setMessage('核验与同步已结束；请检查下方各项状态。');
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
      await query.refetch();
    }
  };
  const changeText = (next: string) => {
    setText(next);
    void keepDraft({ text: next }).catch(() =>
      setMessage('本机存储失败；当前输入未持久保存，请立即导出。'),
    );
  };
  return (
    <>
      <h1>本机草稿与待同步</h1>
      <p>
        这里只排队新日志、新知识草稿和任务状态。超过7天停止自动提交；已有知识正文请在编辑器保留草稿后人工合并。身份权限在同步时重新核验。
      </p>
      <section className={styles.section}>
        <h2>新增离线意图</h2>
        <label>
          操作类型
          <select
            value={kind}
            disabled={busy}
            onChange={(e) => void changeKind(e.target.value as Operation['kind'])}
          >
            <option value="log">新日志</option>
            <option value="draft">新知识草稿</option>
            <option value="task-state">任务状态</option>
          </select>
        </label>
        {kind === 'task-state' ? (
          <>
            <p>从任务详情复制ID及当前版本；提交时仍使用该原版本，冲突不会覆盖。</p>
            <label>
              任务ID
              <input
                value={taskId}
                onChange={(e) => {
                  setTaskId(e.target.value);
                  void keepDraft({ taskId: e.target.value }).catch(() =>
                    setMessage('本机保存失败，请导出当前输入。'),
                  );
                }}
              />
            </label>
            <label>
              原版本
              <input
                type="number"
                min={1}
                value={version}
                onChange={(e) => {
                  setVersion(Number(e.target.value));
                  void keepDraft({ version: Number(e.target.value) }).catch(() =>
                    setMessage('本机保存失败，请导出当前输入。'),
                  );
                }}
              />
            </label>
            <label>
              目标状态
              <select
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value as typeof status);
                  void keepDraft({ status: e.target.value as typeof status }).catch(() =>
                    setMessage('本机保存失败，请导出当前输入。'),
                  );
                }}
              >
                <option value="todo">待办</option>
                <option value="doing">进行中</option>
                <option value="done">完成</option>
              </select>
            </label>
          </>
        ) : (
          <>
            {kind === 'draft' ? (
              <label>
                草稿标题
                <input
                  value={title}
                  maxLength={200}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    void keepDraft({ title: e.target.value }).catch(() =>
                      setMessage('本机存储失败，请导出当前输入。'),
                    );
                  }}
                />
              </label>
            ) : (
              <p>业务日期：{context?.businessDate ?? '尚未取得联网上下文'}</p>
            )}
            <label>
              离线内容
              <textarea
                rows={8}
                value={text}
                onChange={(e) => changeText(e.target.value)}
                style={{ width: '100%' }}
              />
            </label>
          </>
        )}
        <button disabled={busy || !context?.canWrite} onClick={() => void persist()}>
          保存到本机待同步
        </button>{' '}
        <button onClick={() => exportLocal(data())}>导出当前输入</button>
      </section>
      <p role="status">{message}</p>
      <button disabled={busy} onClick={() => void sync()}>
        核验身份并同步队列
      </button>{' '}
      <button onClick={() => exportLocal(query.data ?? {})}>导出本空间未同步资料</button>
      <section className={styles.section}>
        <h2>待同步 {query.data?.queue.length ?? 0} 项</h2>
        {taskComparison ? (
          <section aria-label="任务状态冲突比较">
            <h3>{taskComparison.server.title}</h3>
            <p>
              服务器：{taskComparison.server.status}，版本{taskComparison.server.version}
            </p>
            <p>本地意图：{JSON.stringify(taskComparison.row.operation.payload)}</p>
            <button
              onClick={() => {
                void rebaseTaskIntent(
                  taskComparison.row,
                  taskComparison.server.version,
                  taskComparison.workspaceVersion,
                )
                  .then(() => {
                    setTaskComparison(null);
                    return query.refetch();
                  })
                  .catch((error) => setMessage((error as Error).message));
              }}
            >
              根据服务器新版本重新确认本地状态
            </button>
            <button onClick={() => setTaskComparison(null)}>暂不合并</button>
          </section>
        ) : null}
        {query.data?.queue.map((row) => (
          <article key={row.id}>
            <strong>
              {row.operation.kind} · {row.status === 'pending' ? '待同步' : row.status}
            </strong>
            <p>
              {row.createdAt} · 本地操作 {row.key}
            </p>
            <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {JSON.stringify(row.operation.payload, null, 2)}
            </pre>
            {row.error ? <p role="alert">{row.error}</p> : null}
            {row.status === 'conflict' && row.operation.kind === 'task-state' ? (
              <button onClick={() => void compare(row)}>读取服务器状态并比较</button>
            ) : null}
            <button
              onClick={() => {
                if (confirm('确认删除这条本地意图？尚未同步的内容将丢失。'))
                  void deleteLocalRecord('queue', row.id).then(() => query.refetch());
              }}
            >
              删除本地意图
            </button>
          </article>
        ))}
      </section>
      <section className={styles.section}>
        <h2>本地草稿 {query.data?.drafts.length ?? 0} 项</h2>
        {query.data?.drafts.map((row) => (
          <article key={row.id}>
            <p>
              {row.id.split(':').slice(2).join(':')} · {new Date(row.savedAt).toLocaleString()}
            </p>
            <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {JSON.stringify(row.value, null, 2)}
            </pre>
            <button onClick={() => exportLocal(row)}>导出草稿</button>
            <button
              onClick={() => {
                if (confirm('确认删除本地草稿？'))
                  void deleteLocalRecord('drafts', row.id).then(() => query.refetch());
              }}
            >
              删除草稿
            </button>
          </article>
        ))}
      </section>
    </>
  );
}
