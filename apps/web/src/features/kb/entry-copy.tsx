import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../../services/api-client';
import { ensureCsrfToken, describeApiError } from '../../services/auth-api';
import { copyText } from '../../services/clipboard';
import { newIdempotencyKey } from '../../services/tasks-api';
import { useWorkspace } from '../../providers/workspace-provider';
import type { Entry } from '../../services/kb-api';
import styles from './kb.module.css';

export interface EntryUsage { useCount: number; lastUsedAt: string | null }
export function EntryCopy({ entry }: { entry: Entry }): React.JSX.Element {
  const { workspace } = useWorkspace();
  const workspaceId = workspace?.workspaceId ?? '';
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const endpoint = '/workspaces/' + workspaceId + '/entries/' + entry.id + '/usage';
  const key = ['ws', workspaceId, 'usage', entry.id];
  const usage = useQuery({ queryKey: key, queryFn: ({ signal }) => apiClient.get<EntryUsage>(endpoint, { signal }), enabled: workspaceId !== '' });
  const record = async (operationKey: string): Promise<void> => {
    await ensureCsrfToken();
    const result = await apiClient.post<EntryUsage>(endpoint, {}, { idempotencyKey: operationKey });
    client.setQueryData(key, result);
    void client.invalidateQueries({ queryKey: ['ws', workspaceId, 'organize'] });
    setPendingKey(null); setMessage('已复制，使用记录已保存。');
  };
  const copy = async (): Promise<void> => {
    if (busy) return;
    setBusy(true); setMessage('');
    try {
      if (!await copyText(entry.body)) { setMessage('复制失败，请选中正文手动复制。'); return; }
      const operationKey = newIdempotencyKey();
      setPendingKey(operationKey);
      try { await record(operationKey); }
      catch (error) { setMessage('已复制，但使用记录尚未保存：' + describeApiError(error)); }
    } finally { setBusy(false); }
  };
  const retry = async (): Promise<void> => {
    if (!pendingKey || busy) return;
    setBusy(true);
    try { await record(pendingKey); }
    catch (error) { setMessage('已复制，统计重试未完成：' + describeApiError(error)); }
    finally { setBusy(false); }
  };
  return <section className={styles.panel} aria-label="复制与使用统计">
    <button type="button" className={styles.secondary} onClick={() => void copy()} disabled={busy || pendingKey !== null}>{busy ? '处理中…' : '复制正文'}</button>
    {pendingKey ? <><button type="button" className={styles.secondary} onClick={() => void retry()} disabled={busy}>重试保存统计</button><button type="button" onClick={() => { setPendingKey(null); setMessage('本次统计未确认保存。'); }}>忽略本次统计</button></> : null}
    <span> 使用 {usage.data?.useCount ?? 0} 次{usage.data?.lastUsedAt ? ' · 最近使用 ' + usage.data.lastUsedAt.slice(0, 16).replace('T', ' ') : ''}</span>
    {message ? <p role="status">{message}</p> : null}
    {usage.isError ? <p role="alert">使用统计暂时不可读，仍可复制正文。</p> : null}
  </section>;
}
