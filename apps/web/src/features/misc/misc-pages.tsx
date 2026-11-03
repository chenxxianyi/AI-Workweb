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

export function LoginPage(): React.JSX.Element {
  return (
    <div style={{ maxWidth: 420, margin: '0 auto' }}>
      <h1 style={{ fontSize: 'var(--text-xl)', marginBottom: 'var(--space-2)' }}>登录</h1>
      <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', marginBottom: 'var(--space-4)' }}>
        公开注册已关闭。登录、邀请接受与密码恢复在 F09／F11 接入；当前表单不可提交，避免伪造成功。
      </p>
      <form
        aria-describedby="login-disabled-note"
        onSubmit={(event) => {
          event.preventDefault();
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}
      >
        <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>邮箱或用户名</span>
          <input
            type="text"
            name="identifier"
            disabled
            placeholder="F09 后可用"
            style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '0 var(--space-3)', background: 'var(--surface-2)' }}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>密码</span>
          <input
            type="password"
            name="password"
            disabled
            placeholder="F09 后可用"
            style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '0 var(--space-3)', background: 'var(--surface-2)' }}
          />
        </label>
        <button
          type="submit"
          disabled
          style={{
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            padding: 'var(--space-2)',
            background: 'var(--surface-2)',
            color: 'var(--text-faint)',
            cursor: 'not-allowed',
          }}
        >
          登录（尚未开放）
        </button>
      </form>
      <p id="login-disabled-note" style={{ marginTop: 'var(--space-3)', fontSize: 'var(--text-xs)', color: 'var(--text-faint)' }}>
        账号初始化使用服务器命令 bootstrap-owner（F08），不提供默认密码。
      </p>
    </div>
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
