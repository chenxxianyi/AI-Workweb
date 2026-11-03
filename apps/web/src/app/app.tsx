import { RouterProvider } from 'react-router-dom';
import { QueryProvider } from '../providers/query-provider';
import { ThemeProvider } from '../providers/theme-provider';
import { WorkspaceProvider } from '../providers/workspace-provider';
import { router } from './router';

/** 应用根（F07）：主题 → 查询缓存 → 空间上下文 → 路由 */
export function App(): React.JSX.Element {
  return (
    <ThemeProvider>
      <QueryProvider>
        <WorkspaceProvider>
          <RouterProvider router={router} />
        </WorkspaceProvider>
      </QueryProvider>
    </ThemeProvider>
  );
}
