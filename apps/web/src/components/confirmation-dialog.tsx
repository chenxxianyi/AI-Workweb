import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import styles from './confirmation-dialog.module.css';
export function ConfirmationDialog({
  title,
  children,
  onClose,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
}): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null),
    id = useId();
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={id}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2 id={id}>{title}</h2>
      {children}
      <button type="button" disabled={busy} onClick={onClose}>
        取消
      </button>
    </dialog>
  );
}
