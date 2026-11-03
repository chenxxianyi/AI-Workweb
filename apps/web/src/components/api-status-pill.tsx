import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../services/api-client';
import { queryKeys } from '../services/query-keys';
import styles from './api-status-pill.module.css';

interface HealthLive {
  status: 'ok';
  service: 'api';
  uptimeSeconds: number;
}

/**
 * API 连通性状态（F07）：真实请求 /health/live，30 秒刷新。
 * 明确区分“检查中 / 已连接 / 不可用”，不把未知状态显示为正常。
 */
export function ApiStatusPill(): React.JSX.Element {
  const { status, data, error, refetch } = useQuery({
    queryKey: queryKeys.healthLive(),
    queryFn: ({ signal }) => apiClient.get<HealthLive>('/health/live', { signal }),
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  if (status === 'pending') {
    return (
      <span className={`${styles.pill} ${styles.checking}`} role="status">
        检查中
      </span>
    );
  }

  if (status === 'error') {
    return (
      <button
        type="button"
        className={`${styles.pill} ${styles.down}`}
        onClick={() => {
          void refetch();
        }}
        title={error instanceof Error ? error.message : 'API 不可用'}
      >
        API 不可用
      </button>
    );
  }

  return (
    <span className={`${styles.pill} ${styles.up}`} title={`API 在线 ${data?.uptimeSeconds ?? 0}s`}>
      已连接
    </span>
  );
}
