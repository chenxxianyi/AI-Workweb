import { useEffect, useState } from 'react';
import { useAuth } from '../providers/auth-provider';
import { describeApiError } from '../services/auth-api';
import { ConfirmationDialog } from './confirmation-dialog';
import styles from './session-expired-dialog.module.css';
/** 在当前页面重新验证同一账号，避免导航卸载尚未提交的表单。 */
export function SessionExpiredDialog(): React.JSX.Element | null {
  const { sessionExpired, dismissSessionExpired, login, user } = useAuth();
  const [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    if (!sessionExpired) {
      setPassword('');
      setOpen(false);
      setError('');
    }
  }, [sessionExpired]);
  if (!sessionExpired) return null;
  return (
    <ConfirmationDialog title="登录已过期" onClose={dismissSessionExpired} busy={busy}>
      <p className={styles.body}>
        当前输入仍保留。重新验证当前账号后可继续；账号权限仍以服务器为准。
      </p>
      {open ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError('');
            void login(email, password)
              .then(() => {
                setPassword('');
                setOpen(false);
              })
              .catch((error) => setError(describeApiError(error)))
              .finally(() => setBusy(false));
          }}
        >
          <label>
            重新登录邮箱
            <input
              type="email"
              autoComplete="username"
              value={email}
              readOnly={!!user?.email && user.email !== '离线只读'}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
          <label>
            当前账号密码
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              required
            />
          </label>
          <button type="submit" className={styles.primary} disabled={busy}>
            {busy ? '验证中…' : '确认重新登录'}
          </button>
        </form>
      ) : (
        <button
          type="button"
          className={styles.primary}
          onClick={() => {
            setEmail(user?.email === '离线只读' ? '' : (user?.email ?? ''));
            setPassword('');
            setError('');
            setOpen(true);
          }}
        >
          重新登录
        </button>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </ConfirmationDialog>
  );
}
