import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { authApi, describeApiError } from '../../services/auth-api';
import styles from './auth-pages.module.css';

/**
 * 接受邀请（F11）。
 * - 已有账号：只需点“加入”（无需密码）
 * - 新账号：必须同时设置符合策略的密码
 * 令牌一次性；失败给出可复查原因（无效/过期/已是成员）。
 */
export function InviteAcceptPage(): React.JSX.Element {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ createdUser: boolean } | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (pending) return;
    setError(null);
    setPending(true);
    try {
      const result = await authApi.acceptInvitation(token, {
        ...(displayName.trim() === '' ? {} : { displayName: displayName.trim() }),
        ...(password === '' ? {} : { password }),
      });
      setDone({ createdUser: result.createdUser });
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setPending(false);
    }
  };

  if (token === '') {
    return (
      <div className={styles.wrap}>
        <div className={styles.card}>
          <h1 className={styles.title}>邀请链接无效</h1>
          <p className={styles.hint}>链接缺少邀请令牌，请向空间 Owner 索取新的邀请链接。</p>
          <Link className={styles.link} to="/login">
            返回登录
          </Link>
        </div>
      </div>
    );
  }

  if (done !== null) {
    return (
      <div className={styles.wrap}>
        <div className={styles.card}>
          <h1 className={styles.title}>已加入空间</h1>
          <p className={styles.success}>
            {done.createdUser ? '账号已创建，请用刚设置的密码登录。' : '已加入该空间，请登录后使用。'}
          </p>
          <p style={{ marginTop: 'var(--space-4)' }}>
            <Link className={styles.link} to="/login">
              前往登录
            </Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <h1 className={styles.title}>接受邀请</h1>
        <p className={styles.hint}>
          已有账号可直接加入（无需填写密码）；新账号需要设置密码（至少 12 位、包含三类字符）。
        </p>
        <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
          <label className={styles.field}>
            <span className={styles.label}>显示名称（新账号必填）</span>
            <input
              className={styles.input}
              type="text"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="例如：张三"
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>设置密码（新账号必填）</span>
            <input
              className={styles.input}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="至少 12 位"
            />
          </label>
          {error === null ? null : (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <button type="submit" className={styles.primary} disabled={pending}>
            {pending ? '处理中…' : '加入空间'}
          </button>
        </form>
      </div>
    </div>
  );
}

/**
 * 重置密码（F11）：使用 CLI 签发的一次性令牌。
 * 成功后令牌立即作废，账号的全部旧会话被吊销。
 */
export function ResetPasswordPage(): React.JSX.Element {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (pending) return;
    setError(null);
    if (password !== confirm) {
      setError('两次输入的密码不一致');
      return;
    }
    setPending(true);
    try {
      await authApi.completeRecovery(token, password);
      setDone(true);
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setPending(false);
    }
  };

  if (token === '') {
    return (
      <div className={styles.wrap}>
        <div className={styles.card}>
          <h1 className={styles.title}>恢复链接无效</h1>
          <p className={styles.hint}>链接缺少恢复令牌，请让管理员重新签发。</p>
          <Link className={styles.link} to="/login">
            返回登录
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <h1 className={styles.title}>重置密码</h1>
        {done ? (
          <>
            <p className={styles.success}>密码已重置，所有旧会话已失效。请用新密码登录。</p>
            <p style={{ marginTop: 'var(--space-4)' }}>
              <Link className={styles.link} to="/login">
                前往登录
              </Link>
            </p>
          </>
        ) : (
          <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
            <label className={styles.field}>
              <span className={styles.label}>新密码</span>
              <input
                className={styles.input}
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="至少 12 位、包含三类字符"
              />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>确认新密码</span>
              <input
                className={styles.input}
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
              />
            </label>
            {error === null ? null : (
              <p className={styles.error} role="alert">
                {error}
              </p>
            )}
            <button type="submit" className={styles.primary} disabled={pending}>
              {pending ? '提交中…' : '重置密码'}
            </button>
            <p className={styles.footer}>令牌 30 分钟内有效且只能使用一次。</p>
          </form>
        )}
      </div>
    </div>
  );
}
