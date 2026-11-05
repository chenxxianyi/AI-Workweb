export function NotFoundPage(): React.JSX.Element {
  return (
    <div style={{ textAlign: 'center', padding: 'var(--space-6) 0' }}>
      <h1 style={{ fontSize: 'var(--text-2xl)', fontWeight: 700 }}>404 · 页面不存在</h1>
      <p style={{ color: 'var(--text-muted)', marginTop: 'var(--space-2)' }}>页面不存在或已被移除。</p>
      <p style={{ marginTop: 'var(--space-4)' }}>
        <a href="/today">回到今日聚焦</a>
      </p>
    </div>
  );
}
