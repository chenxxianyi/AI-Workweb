import { RouterProvider } from 'react-router-dom';
import { QueryProvider } from '../providers/query-provider';
import { ServerThemeProvider } from '../providers/server-theme-provider';
import { AuthProvider } from '../providers/auth-provider';
import { WorkspaceProvider } from '../providers/workspace-provider';
import { router } from './router';
import { SnapshotProvider } from '../offline/snapshot-provider';

/**
 * 应用根（F07/F11）：主题 → 查询缓存 → 认证 → 空间上下文 → 路由。
 * AuthProvider 必须在 WorkspaceProvider 之前：空间列表来自 /auth/me。
 */
export function App(): React.JSX.Element {
  return (
    <QueryProvider>
      <AuthProvider>
        <ServerThemeProvider>
          <WorkspaceProvider>
            <SnapshotProvider>
              <RouterProvider router={router} />
            </SnapshotProvider>
          </WorkspaceProvider>
        </ServerThemeProvider>
      </AuthProvider>
    </QueryProvider>
  );
}
