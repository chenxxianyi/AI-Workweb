import type { ReactNode } from 'react';
import styles from './states.module.css';

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}): React.JSX.Element {
  return (
    <header className={styles.header}>
      <div>
        <h1 className={styles.title}>{title}</h1>
        {description === undefined ? null : <p className={styles.description}>{description}</p>}
      </div>
      {actions === undefined ? null : <div className={styles.actions}>{actions}</div>}
    </header>
  );
}

export function LoadingState({ label = '加载中…' }: { label?: string }): React.JSX.Element {
  return (
    <div className={styles.loading} role="status" aria-live="polite">
      <span className={styles.spinner} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function SkeletonRows({ rows = 3 }: { rows?: number }): React.JSX.Element {
  return (
    <div className={styles.skeleton} aria-hidden="true">
      {Array.from({ length: rows }, (_value, index) => (
        <span key={index} className={styles.skeletonRow} />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}): React.JSX.Element {
  return (
    <div className={styles.empty}>
      <p className={styles.emptyTitle}>{title}</p>
      {description === undefined ? null : <p className={styles.description}>{description}</p>}
      {action === undefined ? null : <div className={styles.actions}>{action}</div>}
    </div>
  );
}

export function ErrorState({
  title = '加载失败',
  message,
  requestId,
  onRetry,
}: {
  title?: string;
  message: string;
  requestId?: string;
  onRetry?: () => void;
}): React.JSX.Element {
  return (
    <div className={styles.error} role="alert">
      <p className={styles.errorTitle}>{title}</p>
      <p className={styles.description}>{message}</p>
      {requestId === undefined ? null : (
        <p className={styles.requestId}>
          请求 ID：<code>{requestId}</code>
        </p>
      )}
      {onRetry === undefined ? null : (
        <div className={styles.actions}>
          <button type="button" className={styles.retryButton} onClick={onRetry}>
            重试
          </button>
        </div>
      )}
    </div>
  );
}

export function Notice({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn' | 'danger';
  children: ReactNode;
}): React.JSX.Element {
  return <div className={`${styles.notice} ${styles[tone]}`}>{children}</div>;
}
