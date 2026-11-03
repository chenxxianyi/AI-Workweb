import { PlaceholderPage } from '../../components/placeholder-page';

export function SearchPage(): React.JSX.Element {
  return (
    <PlaceholderPage
      title="全局搜索"
      description="Ctrl/Cmd+K 打开，作用域为当前空间，支持键盘导航与命中字段展示。"
      plannedIn="F22～F23"
      requirements="R14"
    />
  );
}

export function NotFoundPage(): React.JSX.Element {
  return (
    <div style={{ textAlign: 'center', padding: 'var(--space-6) 0' }}>
      <p style={{ fontSize: 'var(--text-2xl)', fontWeight: 700 }}>404</p>
      <p style={{ color: 'var(--text-muted)', marginTop: 'var(--space-2)' }}>页面不存在或已被移除。</p>
      <p style={{ marginTop: 'var(--space-4)' }}>
        <a href="/today">回到今日聚焦</a>
      </p>
    </div>
  );
}
