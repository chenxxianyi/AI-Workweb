import { createBrowserRouter, Navigate, Outlet } from 'react-router-dom';
import { AppShell } from '../layout/app-shell';
import { ProtectedRoute } from '../components/protected-route';
import { SessionExpiredDialog } from '../components/session-expired-dialog';
import { TodayPage } from '../features/today/today-page';
import { ProjectsPage } from '../features/projects/projects-page';
import { ProjectDetailPage } from '../features/projects/project-detail-page';
import { LedgerPage } from '../features/ledger/ledger-page';
import { KnowledgePage } from '../features/kb/kb-page';
import { SettingsPage } from '../features/settings/settings-page';
import { LoginPage } from '../features/auth/login-page';
import { InviteAcceptPage, ResetPasswordPage } from '../features/auth/invite-pages';
import { NotFoundPage, SearchPage } from '../features/misc/misc-pages';

/** 所有路由共用的外层：会话过期对话框需要路由上下文 */
function RootLayout(): React.JSX.Element {
  return (
    <>
      <Outlet />
      <SessionExpiredDialog />
    </>
  );
}

/**
 * 路由（F07/F11）：
 * 公开：/login、/invite、/reset-password
 * 需登录：/today /projects /kb /ledger /settings /search（经 ProtectedRoute → AppShell）
 * URL 承载视图与筛选；深层链接刷新可用。
 */
export const routes = [
  {
    path: '/',
    element: <RootLayout />,
    children: [
      { index: true, element: <Navigate to="/today" replace /> },
      { path: 'login', element: <LoginPage /> },
      { path: 'invite', element: <InviteAcceptPage /> },
      { path: 'reset-password', element: <ResetPasswordPage /> },
      {
        path: '',
        element: (
          <ProtectedRoute>
            <AppShell />
          </ProtectedRoute>
        ),
        children: [
          { path: 'today', element: <TodayPage /> },
          { path: 'projects', element: <ProjectsPage /> },
          { path: 'projects/:projectId', element: <ProjectDetailPage /> },
          { path: 'ledger', element: <LedgerPage /> },
          { path: 'kb', element: <KnowledgePage /> },
          { path: 'settings', element: <SettingsPage /> },
          { path: 'search', element: <SearchPage /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
];

export const router = createBrowserRouter(routes);
