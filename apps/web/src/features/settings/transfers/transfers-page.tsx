import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { useWorkspace } from '../../../providers/workspace-provider';
import { ApiError } from '../../../services/api-client';
import { describeApiError } from '../../../services/auth-api';
import { newIdempotencyKey } from '../../../services/tasks-api';
import {
  saveBlob,
  transfersApi,
  type Decision,
  type TransferJob,
} from '../../../services/transfers-api';
import { PageHeader, ErrorState, LoadingState } from '../../../components/states';
import styles from '../settings-page.module.css';
const stateLabels: Record<string, string> = {
  uploaded: '已接收',
  validating: '校验中',
  preview_ready: '预览就绪',
  queued: '等待处理',
  running: '处理中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
  expired: '已过期',
};
const finished = new Set(['preview_ready', 'succeeded', 'failed', 'cancelled', 'expired']);
export function TransfersPage(): React.JSX.Element {
  const { workspace, can } = useWorkspace();
  return (
    <TransferPanel
      key={workspace?.workspaceId ?? ''}
      workspaceId={workspace?.workspaceId ?? ''}
      canExport={can('data.export')}
      canImport={can('data.import')}
    />
  );
}
function TransferPanel({
  workspaceId,
  canExport,
  canImport,
}: {
  workspaceId: string;
  canExport: boolean;
  canImport: boolean;
}): React.JSX.Element {
  const [params, setParams] = useSearchParams(),
    jobId = params.get('jobId') ?? '';
  const [file, setFile] = useState<File | null>(null),
    [source, setSource] = useState('');
  const previewOperation = useRef<{ file: File; source: string; key: string } | null>(null),
    exportOperation = useRef<{ format: 'json' | 'markdown'; key: string } | null>(null);
  const client = useQueryClient();
  const choose = (id: string) => {
    setParams({ jobId: id });
    void client.invalidateQueries({ queryKey: ['ws', workspaceId, 'transfers'] });
  };
  const jobs = useQuery({
    queryKey: ['ws', workspaceId, 'transfers'],
    queryFn: ({ signal }) => transfersApi.list(workspaceId, signal),
    enabled: !!workspaceId,
    refetchInterval: 5000,
  });
  const exported = useMutation({
    mutationFn: (format: 'json' | 'markdown') => {
      exportOperation.current ??= { format, key: newIdempotencyKey() };
      return transfersApi.export(
        workspaceId,
        exportOperation.current.format,
        exportOperation.current.key,
      );
    },
    onSuccess: (job) => {
      exportOperation.current = null;
      choose(job.id);
    },
    onError: (e) => {
      if (e instanceof ApiError && !e.isUnknownResult) exportOperation.current = null;
    },
  });
  const preview = useMutation({
    mutationFn: () => {
      if (!previewOperation.current) {
        if (!file) throw new Error('请选择JSON文件');
        if (file.size > 512 * 1024 * 1024) throw new Error('文件最多512MiB');
        previewOperation.current = { file, source, key: newIdempotencyKey() };
      }
      const op = previewOperation.current;
      return transfersApi.preview(workspaceId, op.file, op.source, op.key);
    },
    onSuccess: (job) => {
      previewOperation.current = null;
      choose(job.id);
    },
    onError: (e) => {
      if (e instanceof ApiError && !e.isUnknownResult) previewOperation.current = null;
    },
  });
  return (
    <>
      <PageHeader
        title="导入与导出"
        description="导出业务资料用于迁移；导入先预览，确认后才合并。数据库备份在本机运维中单独管理。"
      />
      <p>
        <Link to="/settings">返回设置</Link>
      </p>
      <section className={styles.section}>
        <h2>导出资料</h2>
        <div className={styles.row}>
          <button
            className={styles.primary}
            disabled={!canExport || exported.isPending || !!exportOperation.current}
            onClick={() => exported.mutate('json')}
          >
            导出 JSON
          </button>
          <button
            className={styles.secondary}
            disabled={!canExport || exported.isPending || !!exportOperation.current}
            onClick={() => exported.mutate('markdown')}
          >
            导出 Markdown
          </button>
        </div>
        {!canExport ? <p>当前角色没有导出权限。</p> : null}
        {exported.isError ? (
          <p role="alert">
            {describeApiError(exported.error)}
            {exportOperation.current ? (
              <button onClick={() => exported.mutate(exportOperation.current!.format)}>
                继续查询原导出操作
              </button>
            ) : null}
          </p>
        ) : null}
      </section>
      <section className={styles.section}>
        <h2>导入业务 JSON</h2>
        <p>
          可导入旧版和当前版本。账号、权限和本机偏好不会从文件中覆盖。冲突默认保留服务器，断开的关联将留空。
        </p>
        <div className={styles.form}>
          <label className={styles.field}>
            选择 JSON 文件
            <input
              type="file"
              accept=".json,application/json"
              disabled={!canImport || preview.isPending || !!previewOperation.current}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <label className={styles.field}>
            来源标识（同一个旧库始终使用相同标识）
            <input
              className={styles.input}
              value={source}
              maxLength={64}
              placeholder="旧版文件必填，例如 my-old-workbench"
              disabled={!canImport || preview.isPending || !!previewOperation.current}
              onChange={(e) => setSource(e.target.value)}
            />
          </label>
          <button
            className={styles.primary}
            disabled={!canImport || !file || preview.isPending}
            onClick={() => preview.mutate()}
          >
            {preview.isPending
              ? '正在上传并校验…'
              : previewOperation.current
                ? '继续原文件预览'
                : '生成导入预览'}
          </button>
        </div>
        {!canImport ? <p>只有Owner可以导入。</p> : null}
        {preview.isError ? (
          <p role="alert">
            {describeApiError(preview.error)}；结果未知时继续原操作，不会另建重复导入。
          </p>
        ) : null}
      </section>
      {jobId ? (
        <JobPanel
          key={jobId}
          workspaceId={workspaceId}
          id={jobId}
          canImport={canImport}
          onChanged={() => void jobs.refetch()}
        />
      ) : null}
      <section className={styles.section}>
        <h2>最近作业</h2>
        <p>刷新或重新登录后，可从这里继续查看进度。</p>
        {jobs.isPending ? (
          <LoadingState />
        ) : jobs.isError ? (
          <ErrorState message={describeApiError(jobs.error)} onRetry={() => void jobs.refetch()} />
        ) : jobs.data.jobs.length === 0 ? (
          <p>暂无传输作业。</p>
        ) : (
          <ul>
            {jobs.data.jobs.map((job) => (
              <li key={job.id}>
                <button className={styles.chip} onClick={() => choose(job.id)}>
                  {job.type === 'import'
                    ? '导入'
                    : job.type === 'export_json'
                      ? 'JSON导出'
                      : 'Markdown导出'}{' '}
                  · {stateLabels[job.state] ?? job.state} · {job.id.slice(0, 8)}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
function JobPanel({
  workspaceId,
  id,
  canImport,
  onChanged,
}: {
  workspaceId: string;
  id: string;
  canImport: boolean;
  onChanged: () => void;
}): React.JSX.Element {
  const job = useQuery({
    queryKey: ['ws', workspaceId, 'transfer', id],
    queryFn: ({ signal }) => transfersApi.status(workspaceId, id, signal),
    refetchInterval: (q) => (q.state.data && finished.has(q.state.data.state) ? false : 1500),
  });
  const client=useQueryClient();
  useEffect(()=>{if(job.data?.state==='succeeded'&&job.data.type==='import')void client.invalidateQueries({queryKey:['ws',workspaceId]});},[job.data?.state,job.data?.type,client,workspaceId]);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({}),
    [confirmed, setConfirmed] = useState(false),
    [cursor, setCursor] = useState<string | undefined>();
  const operation = useRef<{ key: string; planHash: string; decisions: Decision[] } | null>(null);
  const items = useQuery({
    queryKey: ['ws', workspaceId, 'transfer-items', id, cursor],
    queryFn: () => transfersApi.items(workspaceId, id, cursor),
    enabled: canImport && job.data?.type === 'import' && job.data.state === 'preview_ready',
  });
  const refresh = () => {
    void job.refetch();
    onChanged();
  };
  const commit = useMutation({
    mutationFn: () => {
      operation.current ??= {
        key: newIdempotencyKey(),
        planHash: job.data!.planHash!,
        decisions: Object.values(decisions),
      };
      const op = operation.current;
      return transfersApi.commit(workspaceId, id, op.planHash, op.decisions, op.key);
    },
    onSuccess: refresh,
  });
  const cancel = useMutation({
    mutationFn: () => transfersApi.cancel(workspaceId, id),
    onSuccess: refresh,
  });
  const download = useMutation({
    mutationFn: async () => {
      const blob = await transfersApi.download(workspaceId, id);
      saveBlob(blob, 'workbench-' + id + (job.data?.type === 'export_json' ? '.json' : '.md'));
    },
  });
  const recovery = useMutation({
    mutationFn: async () =>
      saveBlob(
        new Blob([JSON.stringify(await transfersApi.recovery(workspaceId, id), null, 2)], {
          type: 'application/json',
        }),
        'import-recovery-' + id + '.json',
      ),
  });
  if (job.isPending) return <LoadingState />;
  if (job.isError)
    return <ErrorState message={describeApiError(job.error)} onRetry={() => void job.refetch()} />;
  const current = job.data,
    error = commit.error ?? cancel.error ?? download.error ?? recovery.error;
  return (
    <section className={styles.section} aria-label="传输作业详情">
      <h2>当前作业：{stateLabels[current.state] ?? current.state}</h2>
      <p style={{ overflowWrap: 'anywhere' }}>编号 {id}</p>
      {current.expiresAt ? <p>结果保留至 {new Date(current.expiresAt).toLocaleString()}</p> : null}
      <Counts job={current} />
      {current.errorCode ? (
        <p role="alert">作业未完成：{current.errorCode}；请检查报告，旧预览失效后需重新预览。</p>
      ) : null}
      {current.type === 'import' && current.state === 'preview_ready' && canImport ? (
        <>
          <p>请核对新增、更新、保留、冲突和断链。确认前不会修改业务数据。</p>
          {items.isPending ? (
            <LoadingState />
          ) : items.isError ? (
            <ErrorState
              message={describeApiError(items.error)}
              onRetry={() => void items.refetch()}
            />
          ) : (
            <>
              <ul>
                {items.data.items.map((item) => (
                  <li key={item.id} style={{ overflowWrap: 'anywhere' }}>
                    {({project:'项目',task:'任务',entry:'知识',log:'日志',ledger:'台账',task_entry:'任务知识关联'} as Record<string,string>)[item.type]??item.type} · {String(item.incoming?.['title']??item.incoming?.['name']??item.incoming?.['text']??item.incoming?.['note']??'关联记录')} · {({create:'新增',update:'更新',keep:'保留',conflict:'冲突'} as Record<string,string>)[item.plan?.action??'']??'关系'}
                    <details><summary>查看导入内容与来源编号</summary><p>{item.sourceId}</p><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{String(item.incoming?.['body']??item.incoming?.['text']??item.incoming?.['note']??'')}{item.incoming?.['summary']?'\n摘要：'+String(item.incoming['summary']):''}</pre></details>
                    {item.plan?.missing?.length ? '；断链：' + item.plan.missing.join(',') : ''}
                    {item.plan?.action === 'conflict' ? (
                      <label>
                        冲突处理
                        <select
                          className={styles.input}
                          aria-label={'处理冲突 ' + item.sourceId}
                          disabled={commit.isPending || !!operation.current}
                          value={decisions[item.id]?.action ?? 'keep_server'}
                          onChange={(e) =>
                            setDecisions((s) => ({
                              ...s,
                              [item.id]: {
                                entityType: item.type,
                                sourceId: item.sourceId,
                                action: e.target.value as Decision['action'],
                              },
                            }))
                          }
                        >
                          <option value="keep_server">保留服务器</option>
                          <option value="apply_import">应用导入（覆盖当前业务内容）</option>
                          <option value="skip">跳过</option>
                        </select>
                      </label>
                    ) : null}
                  </li>
                ))}
              </ul>
              <div className={styles.row}>
                {cursor ? <button onClick={() => setCursor(undefined)}>预览第一页</button> : null}
                {items.data.nextCursor ? (
                  <button onClick={() => setCursor(items.data.nextCursor ?? undefined)}>
                    预览下一页
                  </button>
                ) : null}
              </div>
            </>
          )}
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={commit.isPending}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            我已检查预览，确认合并；提交前会自动保存业务快照。
          </label>
          <div className={styles.row}>
            <button
              className={styles.primary}
              disabled={!confirmed || commit.isPending || items.isPending || items.isError}
              onClick={() => commit.mutate()}
            >
              {commit.isPending ? '正在确认…' : operation.current ? '继续原确认操作' : '确认导入'}
            </button>
            <button
              className={styles.secondary}
              disabled={commit.isPending || cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              取消此次导入
            </button>
          </div>
        </>
      ) : null}
      {current.type === 'import' && current.state === 'queued' && canImport ? (
        <button className={styles.secondary} onClick={() => cancel.mutate()}>
          取消排队导入
        </button>
      ) : null}
      {current.state === 'succeeded' && current.type !== 'import' ? (
        <button
          className={styles.primary}
          disabled={download.isPending}
          onClick={() => download.mutate()}
        >
          {download.isPending ? '下载中…' : '下载文件'}
        </button>
      ) : null}
      {current.type === 'import' && current.state === 'succeeded' && canImport ? (
        <button
          className={styles.secondary}
          disabled={recovery.isPending}
          onClick={() => recovery.mutate()}
        >
          下载导入恢复报告
        </button>
      ) : null}
      {error ? (
        <p role="alert">{describeApiError(error)}；保留当前作业编号，可重试或继续查询。</p>
      ) : null}
      <button className={styles.chip} onClick={refresh}>
        刷新当前作业
      </button>
    </section>
  );
}
function Counts({ job }: { job: TransferJob }): React.JSX.Element {
  const counts = job.counts;
  if (!counts) return <p>等待统计结果。</p>;
  return (
    <dl>
      {Object.entries(counts).map(([key, value]) => (
        <div key={key}>
          <dt>
            {(
              {
                created: '新增',
                updated: '更新',
                kept: '保留',
                conflicts: '冲突',
                broken: '断链',
                total: '实体总数',
                applied: '实际导入',
                projects: '项目',
                tasks: '任务',
                entries: '知识',
                logs: '日志',
                ledger: '台账',
                taskEntries: '任务知识关联',
                backupId: '导入前快照编号',
                validationError: '校验报告',
              } as Record<string, string>
            )[key] ?? key}
          </dt>
          <dd style={{ marginLeft: 16, overflowWrap: 'anywhere' }}>
            {key==='applied'&&value&&typeof value==='object'?Object.entries(value).map(([k,v])=>(({created:'新增',updated:'更新',kept:'保留',links:'关联'} as Record<string,string>)[k]??k)+' '+String(v)).join('，'):typeof value === 'object' ? JSON.stringify(value) : String(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}
