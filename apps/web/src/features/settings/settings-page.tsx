import { PlaceholderPage } from '../../components/placeholder-page';
import { useTheme } from '../../providers/theme-provider';

export function SettingsPage(): React.JSX.Element {
  const { mode, resolved, setMode } = useTheme();

  return (
    <PlaceholderPage
      title="设置"
      description="个人偏好、空间时区、成员与邀请、回收站、导入导出、会话与安全。"
      plannedIn="F33～F34"
      requirements="R21、R22、R01"
    >
      <section
        aria-labelledby="theme-setting"
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          padding: 'var(--space-4)',
        }}
      >
        <h2 id="theme-setting" style={{ fontSize: 'var(--text-lg)', marginBottom: 'var(--space-2)' }}>
          外观（已可用）
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', marginBottom: 'var(--space-3)' }}>
          当前：{mode === 'system' ? `跟随系统（${resolved === 'dark' ? '深色' : '浅色'}）` : mode === 'dark' ? '深色' : '浅色'}。
          偏好先保存在本机，F33 接入服务端同步。
        </p>
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          {(
            [
              ['system', '跟随系统'],
              ['light', '浅色'],
              ['dark', '深色'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                setMode(value);
              }}
              aria-pressed={mode === value}
              style={{
                border: `1px solid ${mode === value ? 'var(--primary)' : 'var(--border)'}`,
                background: mode === value ? 'var(--primary-soft)' : 'var(--surface)',
                color: mode === value ? 'var(--primary-ink)' : 'var(--text)',
                borderRadius: 'var(--radius-sm)',
                padding: 'var(--space-1) var(--space-3)',
                cursor: 'pointer',
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </section>
    </PlaceholderPage>
  );
}
