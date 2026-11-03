import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../providers/auth-provider';
import styles from './session-expired-dialog.module.css';

/**
 * 会话失效提示（F11）：任意请求返回 401 时出现。
 * - 保留当前页面与输入，只提示重新登录
 * - 登录后回到原路由（`next` 参数）
 * - 允许“稍后再登录”，但不伪造已登录状态
 */
export function SessionExpiredDialog(): React.JSX.Element | null {
  const { sessionExpired, dismissSessionExpired } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  if (!sessionExpired) return null;

  const next = `${location.pathname}${location.search}`;

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="session-expired-title">
      <div className={styles.dialog}>
        <h2 id="session-expired-title" className={styles.title}>
          登录已过期
        </h2>
        <p className={styles.body}>
          你的会话已过期或被其他设备吊销。当前页面的输入不会丢失，重新登录后可继续。
        </p>
        <div className={styles.actions}>
          <button type="button" className={styles.secondary} onClick={dismissSessionExpired}>
            稍后处理
          </button>
          <button
            type="button"
            className={styles.primary}
            onClick={() => {
              dismissSessionExpired();
              navigate(`/login?next=${encodeURIComponent(next)}`);
            }}
          >
            重新登录
          </button>
        </div>
      </div>
    </div>
  );
}
