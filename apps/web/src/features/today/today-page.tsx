import { useQuery } from '@tanstack/react-query';
import { PageHeader, ErrorState, LoadingState, Notice, SkeletonRows } from '../../components/states';
import { apiClient } from '../../services/api-client';

interface HealthReady {
  status: 'ok';
  checks: { database: 'up' };
}

/**
 * 今日聚焦（F07 骨架）。
 * 这里只展示请求层的加载/成功/失败三态与业务占位；紧急聚合与任务操作在 F15/F16 实现。
 */
export function TodayPage(): React.JSX.Element {
  const { status, data, error, refetch } = useQuery({
    queryKey: ['health', 'ready'],
    queryFn: ({ signal }) => apiClient.get<HealthReady>('/health/ready', { signal }),
    retry: false,
  });

  return (
    <>
      <PageHeader
        title="今日聚焦"
        description="业务日按空间时区计算（Asia/Shanghai）。紧急聚合、任务操作与日志在 F15～F18 接入。"
      />

      <Notice>
        当前为 P1 工程骨架：路由、布局、主题与请求层已完成；业务数据尚未接入，页面不会显示“已保存”等成功状态。
      </Notice>

      <section aria-labelledby="api-check" style={{ marginTop: 'var(--space-4)' }}>
        <h2 id="api-check" style={{ fontSize: 'var(--text-lg)', marginBottom: 'var(--space-2)' }}>
          服务连通性
        </h2>
        {status === 'pending' ? <SkeletonRows rows={2} /> : null}
        {status === 'error' ? (
          <ErrorState
            title="无法连接后端服务"
            message={error instanceof Error ? error.message : '未知错误'}
            onRetry={() => {
              void refetch();
            }}
          />
        ) : null}
        {status === 'success' ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
            API 与数据库均可用：{data.checks.database === 'up' ? '数据库就绪' : '数据库状态未知'}
          </div>
        ) : null}
      </section>

      <section aria-labelledby="today-empty" style={{ marginTop: 'var(--space-5)' }}>
        <h2 id="today-empty" style={{ fontSize: 'var(--text-lg)', marginBottom: 'var(--space-2)' }}>
          今日任务
        </h2>
        {status === 'pending' ? <LoadingState label="正在加载今日数据…" /> : null}
        {status !== 'pending' ? (
          <div
            style={{
              border: '1px dashed var(--border-strong)',
              borderRadius: 'var(--radius)',
              padding: 'var(--space-4)',
              background: 'var(--surface)',
              color: 'var(--text-muted)',
              fontSize: 'var(--text-sm)',
            }}
          >
            今日任务列表将在 F16 接入（数据来自 /dashboard/today）。
          </div>
        ) : null}
      </section>
    </>
  );
}
