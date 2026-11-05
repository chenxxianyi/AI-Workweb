import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../providers/auth-provider';
import { useWorkspace } from '../providers/workspace-provider';
import { useTheme } from '../providers/theme-provider';
import { ApiStatusPill } from '../components/api-status-pill';
import { GlobalTools } from '../features/search/global-tools';
import { SpaceReminder } from '../features/settings/preferences/space-preferences';
import { SnapshotStatus } from '../offline/snapshot-provider';
import { ApplicationUpdate } from '../offline/application-update';
import {
  KnowledgeIcon,
  LedgerIcon,
  MoonIcon,
  ProjectsIcon,
  SearchIcon,
  SettingsIcon,
  SunIcon,
  TodayIcon,
} from '../components/icons';
import styles from './app-shell.module.css';

const NAV_ITEMS = [
  { to: '/today', label: '今日聚焦', Icon: TodayIcon },
  { to: '/projects', label: '项目雷达', Icon: ProjectsIcon },
  { to: '/kb', label: '知识库', Icon: KnowledgeIcon },
  { to: '/ledger', label: 'AI 台账', Icon: LedgerIcon },
  { to: '/settings', label: '设置', Icon: SettingsIcon },
] as const;

const ROLE_LABEL: Record<string, string> = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' };
const canCapture = (role: string | null): boolean => role === 'owner' || role === 'editor';

/**
 * 应用壳（F07 / F11）：顶栏（空间切换、搜索入口、API 状态、主题、账号）+ 侧边导航 + 主内容 + 移动底部标签栏。
 * 空间与角色来自真实 /auth/me；角色只做界面提示，权限边界在后端守卫。
 */
export function AppShell(): React.JSX.Element {
  const { workspace, workspaces, role, switchTo } = useWorkspace();
  const { user, logout } = useAuth();
  const { mode, resolved, setMode } = useTheme();
  const navigate = useNavigate();
  const [loggingOut, setLoggingOut] = useState(false),[logoutError,setLogoutError]=useState('');

  const toggleTheme = (): void => {
    setMode(mode === 'system' ? (resolved === 'dark' ? 'light' : 'dark') : mode === 'dark' ? 'light' : 'dark');
  };

  const doLogout = async (): Promise<void> => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await logout();
      navigate('/login', { replace: true });
    } catch(error) {
      setLogoutError((error as Error).message);
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <div className={styles.shell}>
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>

      <header className={styles.topbar}>
        {logoutError?<p role="alert">{logoutError}</p>:null}
        <span className={styles.brand}>AI 编程工作台</span>

        <label className={styles.workspaceSwitch}>
          <span className="sr-only">切换空间</span>
          <select
            className={styles.select}
            value={workspace?.workspaceId ?? ''}
            onChange={(event) => {
              switchTo(event.target.value);
            }}
            disabled={workspaces.length <= 1}
          >
            {workspaces.map((item) => (
              <option key={item.workspaceId} value={item.workspaceId}>
                {item.name}（{ROLE_LABEL[item.role] ?? item.role}）
              </option>
            ))}
          </select>
        </label>

        {role === 'viewer' ? (
          <span className={styles.readonlyBadge} title="当前空间为只读角色，写操作会被后端拒绝">
            只读
          </span>
        ) : null}

        <button type="button" className={styles.iconButton} aria-label="快速捕获" title="快速捕获（N）" onClick={() => window.dispatchEvent(new Event('aiwb:open-capture'))} disabled={!canCapture(role)}><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg></button>
        <NavLink to="/search" className={styles.searchLink} aria-label="打开全局搜索" onClick={(event) => { event.preventDefault(); window.dispatchEvent(new Event('aiwb:open-search')); }}>
          <SearchIcon />
          <span className={styles.searchLabel}>搜索</span>
          <kbd className={styles.kbd}>Ctrl K</kbd>
        </NavLink>

        <ApiStatusPill />

        <button
          type="button"
          className={styles.iconButton}
          onClick={toggleTheme}
          aria-label={`切换主题（当前：${resolved === 'dark' ? '深色' : '浅色'}）`}
          title="切换主题"
        >
          {resolved === 'dark' ? <SunIcon /> : <MoonIcon />}
        </button>

        <div className={styles.account}>
          <span className={styles.userName} title={user?.email}>
            {user?.displayName ?? '未登录'}
          </span>
          <button
            type="button"
            className={styles.logoutButton}
            onClick={() => void doLogout()}
            disabled={loggingOut}
          >
            {loggingOut ? '退出中…' : '退出'}
          </button>
        </div>
      </header>

      <nav className={styles.sidebar} aria-label="主导航">
        <NavLink to="/offline">本机草稿与待同步</NavLink>
        {NAV_ITEMS.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            aria-label={label}
            className={({ isActive }) => (isActive ? `${styles.navItem} ${styles.navActive}` : styles.navItem)}
          >
            <Icon />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>

      <GlobalTools key={(user?.id??'')+workspace?.workspaceId} userId={user?.id}/>
      <main id="main-content" className={styles.main} tabIndex={-1}>
        <SnapshotStatus />
        <ApplicationUpdate />
        <SpaceReminder />
        <Outlet />
      </main>

      <nav className={styles.bottomNav} aria-label="移动端主导航">
        {NAV_ITEMS.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            aria-label={label}
            className={({ isActive }) => (isActive ? `${styles.bottomItem} ${styles.navActive}` : styles.bottomItem)}
          >
            <Icon />
            <span>{label.slice(0, 2)}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
