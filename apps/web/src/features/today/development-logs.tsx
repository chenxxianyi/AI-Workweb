import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useWorkspace } from '../../providers/workspace-provider';
import { ApiError, apiClient } from '../../services/api-client';
import { describeApiError, ensureCsrfToken } from '../../services/auth-api';
import { newIdempotencyKey } from '../../services/tasks-api';
import { shouldSubmitOnEnter } from '../ledger/ledger-utils';
import { ErrorState, LoadingState } from '../../components/states';
import styles from './today.module.css';
import { useRefreshGuard } from '../../offline/refresh-guard';
interface Log {
  id: string;
  logDate: string;
  text: string;
  authorId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}
interface LogPage {
  logs: Log[];
  hasMore: boolean;
  nextCursor: string | null;
}
export function DevelopmentLogs(): React.JSX.Element {
  const { workspace, can } = useWorkspace();
  const workspaceId = workspace?.workspaceId ?? '';
  const [text, setText] = useState(''),
    [date, setDate] = useState(''),
    [cursor, setCursor] = useState<string | null>(null),
    [deleting, setDeleting] = useState<string | null>(null);
  const operation = useRef<{ key: string; input: { text: string; logDate?: string } } | null>(null);
  useRefreshGuard(!!text);
  const composing = useRef(false),
    input = useRef<HTMLTextAreaElement>(null);
  const client = useQueryClient();
  const endpoint = '/workspaces/' + workspaceId + '/logs';
  const query = useQuery({
    queryKey: ['ws', workspaceId, 'logs', date, cursor],
    queryFn: ({ signal }) =>
      apiClient.get<LogPage>(
        endpoint +
          '?' +
          new URLSearchParams({ ...(date ? { date } : {}), ...(cursor ? { cursor } : {}) }),
        { signal },
      ),
    enabled: workspaceId !== '',
  });
  const save = useMutation({
    mutationFn: async () => {
      await ensureCsrfToken();
      operation.current ??= {
        key: newIdempotencyKey(),
        input: { text: text.trim(), ...(date ? { logDate: date } : {}) },
      };
      return apiClient.post(endpoint, operation.current.input, {
        idempotencyKey: operation.current.key,
      });
    },
    onSuccess: () => {
      setText('');
      operation.current = null;
      setCursor(null);
      requestAnimationFrame(() => input.current?.focus());
      void client.invalidateQueries({ queryKey: ['ws', workspaceId, 'logs'] });
    },
    onError: (error) => {
      if (error instanceof ApiError && (error.status === 422 || error.status === 413))
        operation.current = null;
    },
  });
  const remove = useMutation({
    mutationFn: async (log: Log) => {
      await ensureCsrfToken();
      return apiClient.del(endpoint + '/' + log.id, { ifMatch: log.version });
    },
    onSuccess: () => {
      setDeleting(null);
      void client.invalidateQueries({ queryKey: ['ws', workspaceId, 'logs'] });
    },
  });
  return (
    <section className={styles.section} aria-label="开发日志">
      <h2>开发日志</h2>
      <label>
        日期（留空默认今日，列表显示全部）
        <input
          type="date"
          className={styles.input}
          value={date}
          onChange={(event) => {
            setDate(event.target.value);
            setCursor(null);
          }}
          aria-label="日志日期"
        />
      </label>
      {can('business.write') ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (text.trim() && !save.isPending) save.mutate();
          }}
        >
          <label className="sr-only" htmlFor="development-log-text">
            开发日志内容
          </label>
          <textarea
            ref={input}
            id="development-log-text"
            className={styles.input}
            style={{ height: 'auto', minHeight: 100 }}
            rows={3}
            maxLength={4000}
            value={text}
            onChange={(event) => setText(event.target.value)}
            disabled={save.isPending}
            placeholder="记录今天的进展、卡点或下一步；Enter保存，Shift+Enter换行"
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                shouldSubmitOnEnter({
                  shiftKey: event.shiftKey,
                  isComposing: composing.current || event.nativeEvent.isComposing,
                  keyCode: event.nativeEvent.keyCode,
                })
              ) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <button
            type="submit"
            className={styles.primary}
            disabled={save.isPending || !text.trim()}
          >
            {save.isPending ? '保存中…' : '保存日志'}
          </button>
        </form>
      ) : (
        <p>当前空间只读。</p>
      )}
      {save.isError ? <p role="alert">{describeApiError(save.error)}；输入仍保留。</p> : null}
      {remove.isError ? <p role="alert">{describeApiError(remove.error)}</p> : null}
      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState message={describeApiError(query.error)} onRetry={() => void query.refetch()} />
      ) : query.data.logs.length === 0 ? (
        <p>还没有开发日志，先记录一条进展。</p>
      ) : (
        <ol>
          {query.data.logs.map((log) => (
            <li key={log.id}>
              <time>
                {log.logDate} · {log.createdAt.slice(11, 16)}
              </time>
              <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{log.text}</p>
              {can('business.write') ? (
                deleting === log.id ? (
                  <span>
                    将日志移入回收站？
                    <button onClick={() => remove.mutate(log)} disabled={remove.isPending}>
                      确认删除
                    </button>
                    <button onClick={() => setDeleting(null)}>取消</button>
                  </span>
                ) : (
                  <button onClick={() => setDeleting(log.id)}>删除日志</button>
                )
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {query.data?.hasMore ? (
        <button onClick={() => setCursor(query.data?.nextCursor ?? null)}>下一页日志</button>
      ) : null}
      {cursor ? <button onClick={() => setCursor(null)}>日志第一页</button> : null}
    </section>
  );
}
