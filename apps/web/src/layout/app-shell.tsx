import { NavLink, Outlet } from 'react-router-dom';
import { useWorkspace } from '../providers/workspace-provider';
import { useTheme } from '../providers/theme-provider';
import { ApiStatusPill } from '../components/api-status-pill';
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

/**
 * 应用壳（F07）：顶栏（空间切换、搜索入口、API 状态、主题）+ 侧边导航 + 主内容 + 移动底部标签栏。
 * 断点见全局样式：<768px 单列底部标签；768–1023px 折叠；≥1024px 侧边 216px。
 */
export function AppShell(): React.JSX.Element {
  const { workspace, workspaces, switchTo } = useWorkspace();
  const { mode, resolved, setMode } = useTheme();

  const toggleTheme = (): void => {
    setMode(mode === 'system' ? (resolved === 'dark' ? 'light' : 'dark') : mode === 'dark' ? 'light' : 'dark');
  };

  return (
    <div className={styles.shell}>
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>

      <header className={styles.topbar}>
        <span className={styles.brand}>AI 编程工作台</span>

        <label className={styles.workspaceSwitch}>
          <span className="sr-only">切换空间</span>
          <select
            className={styles.select}
            value={workspace.id}
            onChange={(event) => {
              switchTo(event.target.value);
            }}
          >
            {workspaces.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
                {item.placeholder === true ? '（占位）' : ''}
              </option>
            ))}
          </select>
        </label>

        <NavLink to="/search" className={styles.searchLink} aria-label="打开全局搜索">
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
      </header>

      <nav className={styles.sidebar} aria-label="主导航">
        {NAV_ITEMS.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) => (isActive ? `${styles.navItem} ${styles.navActive}` : styles.navItem)}
          >
            <Icon />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>

      <main id="main-content" className={styles.main} tabIndex={-1}>
        <Outlet />
      </main>

      <nav className={styles.bottomNav} aria-label="移动端主导航">
        {NAV_ITEMS.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
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
