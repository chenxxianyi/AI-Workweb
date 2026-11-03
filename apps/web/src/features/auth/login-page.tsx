import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../providers/auth-provider';
import { describeApiError } from '../../services/auth-api';
import styles from './auth-pages.module.css';

/**
 * 登录页（F11）。
 * - 提交前确保拿到 CSRF 令牌（服务端双提交校验）
 * - 失败时保留输入并显示原因（401/429/422/网络）
 * - 登录成功后回到 `next` 指定的原路径
 */
export function LoginPage(): React.JSX.Element {
  const { status, login } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = params.get('next') ?? '/today';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (status === 'authenticated') navigate(next, { replace: true });
  }, [status, navigate, next]);

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (pending) return;
    setError(null);

    if (email.trim() === '' || password === '') {
      setError('请输入邮箱与密码');
      return;
    }

    setPending(true);
    try {
      await login(email.trim(), password);
      navigate(next, { replace: true });
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <h1 className={styles.title}>登录</h1>
        <p className={styles.hint}>
          个人或小团队私有部署，公开注册已关闭。首次使用请由管理员在服务器执行 bootstrap 命令创建 Owner。
        </p>

        <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
          <label className={styles.field}>
            <span className={styles.label}>邮箱</span>
            <input
              className={styles.input}
              type="email"
              name="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              required
            />
          </label>

          <label className={styles.field}>
            <span className={styles.label}>密码</span>
            <input
              className={styles.input}
              type="password"
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>

          {error === null ? null : (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}

          <button type="submit" className={styles.primary} disabled={pending}>
            {pending ? '登录中…' : '登录'}
          </button>
        </form>

        <p className={styles.footer}>
          忘记密码？由管理员执行 <code>pnpm --filter @aiwb/api auth:recover</code> 签发一次性恢复链接。
        </p>
      </div>
    </div>
  );
}
