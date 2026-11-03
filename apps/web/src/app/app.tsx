import { RouterProvider } from 'react-router-dom';
import { QueryProvider } from '../providers/query-provider';
import { ThemeProvider } from '../providers/theme-provider';
import { AuthProvider } from '../providers/auth-provider';
import { WorkspaceProvider } from '../providers/workspace-provider';
import { router } from './router';

/**
 * 应用根（F07/F11）：主题 → 查询缓存 → 认证 → 空间上下文 → 路由。
 * AuthProvider 必须在 WorkspaceProvider 之前：空间列表来自 /auth/me。
 */
export function App(): React.JSX.Element {
  return (
    <ThemeProvider>
      <QueryProvider>
        <AuthProvider>
          <WorkspaceProvider>
            <RouterProvider router={router} />
          </WorkspaceProvider>
        </AuthProvider>
      </QueryProvider>
    </ThemeProvider>
  );
}
