import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '../providers/auth-provider';
import { LoadingState } from './states';

/**
 * 路由保护（F11）：未登录跳转登录页并记住原路径；登录中先显示加载态。
 * 注意：这只是界面层的重定向，真正的授权始终由后端守卫完成。
 */
export function ProtectedRoute({ children }: { children: ReactNode }): React.JSX.Element {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return <LoadingState label="正在检查登录状态…" />;
  }
  if (status === 'anonymous') {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }
  return <>{children}</>;
}
