import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { ApiError } from '../services/api-client';
export function activeRefreshInterval(query: {
  state: { status: string; errorUpdateCount: number };
}) {
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return false;
  return query.state.status === 'error'
    ? Math.min(30000 * 2 ** Math.min(query.state.errorUpdateCount, 4), 300000)
    : 30000;
}

/**
 * 服务端状态缓存（F07）。
 * - 4xx 不重试（重试也只会再失败）；5xx 与网络错误重试 2 次并退避
 * - 默认 30 秒新鲜期，窗口聚焦时刷新（ADR-0006：活跃页轮询由页面自行开启）
 * - 失败不静默：错误交给页面渲染 ErrorState
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: true,
        refetchInterval: activeRefreshInterval,
        refetchIntervalInBackground: false,
        retry: (failureCount, error) => {
          if (error instanceof ApiError) {
            if (error.kind === 'http' && (error.status ?? 0) < 500) return false;
          }
          return failureCount < 2;
        },
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
      },
      mutations: { retry: false },
    },
  });
}

export function QueryProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [client] = useState(createQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
