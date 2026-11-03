import { createBrowserRouter, Navigate } from 'react-router-dom';
import { AppShell } from '../layout/app-shell';
import { TodayPage } from '../features/today/today-page';
import { ProjectsPage } from '../features/projects/projects-page';
import { KnowledgePage } from '../features/kb/kb-page';
import { LedgerPage } from '../features/ledger/ledger-page';
import { SettingsPage } from '../features/settings/settings-page';
import { LoginPage, NotFoundPage, SearchPage } from '../features/misc/misc-pages';

/**
 * 路由（F07）：URL 承载视图；深层链接刷新可用（vite dev 已开启 history fallback）。
 * 筛选参数（q/type/status/tag/mode）在对应任务实现时接入。
 */
export const routes = [
  { path: '/', element: <Navigate to="/today" replace /> },
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: <AppShell />,
    children: [
      { path: 'today', element: <TodayPage /> },
      { path: 'projects', element: <ProjectsPage /> },
      { path: 'kb', element: <KnowledgePage /> },
      { path: 'ledger', element: <LedgerPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'search', element: <SearchPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

export const router = createBrowserRouter(routes);
