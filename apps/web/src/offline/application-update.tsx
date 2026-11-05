import { useEffect, useState } from 'react';
import styles from '../features/settings/settings-page.module.css';
export function requestSafeReload() {
  if (!window.dispatchEvent(new Event('aiwb:before-refresh', { cancelable: true }))) return false;
  location.reload();
  return true;
}
export function ApplicationUpdate(): React.JSX.Element | null {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
    let active = true;
    void navigator.serviceWorker
      .register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .then((reg) => {
        if (reg.waiting) setWaiting(reg.waiting);
        reg.addEventListener('updatefound', () => {
          const worker = reg.installing;
          worker?.addEventListener('statechange', () => {
            if (active && worker.state === 'installed' && navigator.serviceWorker.controller)
              setWaiting(worker);
          });
        });
      })
      .catch(() => {
        if (active)
          setError('本机应用壳未能缓存，当前无法保证离线打开；正常服务器功能可继续使用。');
      });
    return () => {
      active = false;
    };
  }, []);
  if (!waiting && !error) return null;
  return (
    <aside className={styles.section} aria-label="应用版本更新">
      {waiting ? (
        <>
          <p>已有新版本。请先保存当前输入，再更新应用壳。</p>
          <button
            className={styles.chip}
            onClick={() => {
              if (!window.dispatchEvent(new Event('aiwb:before-refresh', { cancelable: true })))
                return;
              navigator.serviceWorker.addEventListener(
                'controllerchange',
                () => location.reload(),
                { once: true },
              );
              waiting.postMessage({ type: 'ACTIVATE_SAVED_VERSION' });
            }}
          >
            保存后更新应用
          </button>
        </>
      ) : null}
      {error ? <p>{error}</p> : null}
    </aside>
  );
}
