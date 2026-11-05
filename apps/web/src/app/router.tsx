import { lazy, Suspense } from 'react';
import { LoadingState } from '../components/states';
import { createBrowserRouter, Navigate, Outlet } from 'react-router-dom';
import { AppShell } from '../layout/app-shell';
import { ProtectedRoute } from '../components/protected-route';
import { SessionExpiredDialog } from '../components/session-expired-dialog';
const TodayPage = lazy(() =>
  import('../features/today/today-page').then((m) => ({ default: m.TodayPage })),
);
const ProjectsPage = lazy(() =>
  import('../features/projects/projects-page').then((m) => ({ default: m.ProjectsPage })),
);
const ProjectDetailPage = lazy(() =>
  import('../features/projects/project-detail-page').then((m) => ({
    default: m.ProjectDetailPage,
  })),
);
const LedgerPage = lazy(() =>
  import('../features/ledger/ledger-page').then((m) => ({ default: m.LedgerPage })),
);
const KnowledgePage = lazy(() =>
  import('../features/kb/kb-page').then((m) => ({ default: m.KnowledgePage })),
);
const EntryDetailPage = lazy(() =>
  import('../features/kb/entry-detail-page').then((m) => ({ default: m.EntryDetailPage })),
);
const SettingsPage = lazy(() =>
  import('../features/settings/settings-page').then((m) => ({ default: m.SettingsPage })),
);
const LoginPage = lazy(() =>
  import('../features/auth/login-page').then((m) => ({ default: m.LoginPage })),
);
const InviteAcceptPage = lazy(() =>
  import('../features/auth/invite-pages').then((m) => ({ default: m.InviteAcceptPage })),
);
const ResetPasswordPage = lazy(() =>
  import('../features/auth/invite-pages').then((m) => ({ default: m.ResetPasswordPage })),
);
const NotFoundPage = lazy(() =>
  import('../features/misc/misc-pages').then((m) => ({ default: m.NotFoundPage })),
);
import { SearchPage } from '../features/search/search-panel';
const TaskDetailPage = lazy(() =>
  import('../features/tasks/task-detail-page').then((m) => ({ default: m.TaskDetailPage })),
);
const TransfersPage = lazy(() =>
  import('../features/settings/transfers/transfers-page').then((m) => ({
    default: m.TransfersPage,
  })),
);
const MaintenancePage = lazy(() =>
  import('../features/admin/maintenance-page').then((m) => ({ default: m.MaintenancePage })),
);
const TeamPage = lazy(() =>
  import('../features/admin/team-page').then((m) => ({ default: m.TeamPage })),
);
const AuditPage = lazy(() =>
  import('../features/admin/audit-page').then((m) => ({ default: m.AuditPage })),
);
const OfflinePage = lazy(() =>
  import('../offline/offline-page').then((m) => ({ default: m.OfflinePage })),
);

/** 所有路由共用的外层：会话过期对话框需要路由上下文 */
function RootLayout(): React.JSX.Element {
  return (
    <>
      <Suspense fallback={<LoadingState label="正在加载页面…" />}>
        <Outlet />
      </Suspense>
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
          { path: 'offline', element: <OfflinePage /> },
          { path: 'tasks/:taskId', element: <TaskDetailPage /> },
          { path: 'projects', element: <ProjectsPage /> },
          { path: 'projects/:projectId', element: <ProjectDetailPage /> },
          { path: 'ledger', element: <LedgerPage /> },
          { path: 'kb', element: <KnowledgePage /> },
          { path: 'kb/:entryId', element: <EntryDetailPage /> },
          { path: 'settings', element: <SettingsPage /> },
          { path: 'settings/transfers', element: <TransfersPage /> },
          { path: 'settings/maintenance', element: <MaintenancePage /> },
          { path: 'settings/team', element: <TeamPage /> },
          { path: 'settings/audit', element: <AuditPage /> },
          { path: 'search', element: <SearchPage /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
];

export const router = createBrowserRouter(routes);
