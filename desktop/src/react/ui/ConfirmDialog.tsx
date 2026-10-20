import { useId, useRef, type ReactNode } from 'react';
import { Button } from './Button';
import { Overlay, type OverlayScope } from './Overlay';
import styles from './ConfirmDialog.module.css';

export interface ConfirmDialogProps {
  open: boolean;
  scope: OverlayScope;
  title: ReactNode;
  children: ReactNode;
  confirmLabel: ReactNode;
  cancelLabel: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
  confirmTone?: 'default' | 'danger';
  busy?: boolean;
  closeOnBackdrop?: boolean;
  closeOnEsc?: boolean;
  zIndex?: number;
}

export function ConfirmDialog({
  open,
  scope,
  title,
  children,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  confirmTone = 'default',
  busy = false,
  closeOnBackdrop = false,
  closeOnEsc = true,
  zIndex,
}: ConfirmDialogProps) {
  const titleId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);

  return (
    <Overlay
      open={open}
      scope={scope}
      onClose={onCancel}
      backdrop="dim"
      closeOnBackdrop={closeOnBackdrop && !busy}
      closeOnEsc={closeOnEsc && !busy}
      zIndex={zIndex}
      className={styles.dialog}
      initialFocusRef={titleRef}
      contentProps={{
        role: 'dialog',
        'aria-modal': true,
        'aria-labelledby': titleId,
      }}
    >
      <h2 ref={titleRef} id={titleId} tabIndex={-1} className={styles.title}>
        {title}
      </h2>
      <div className={styles.body}>
        {children}
      </div>
      <div className={styles.actions}>
        <Button variant="secondary" onClick={onCancel} disabled={busy} className={styles.action}>
          {cancelLabel}
        </Button>
        <Button
          variant={confirmTone === 'danger' ? 'danger' : 'primary'}
          onClick={onConfirm}
          loading={busy}
          className={styles.action}
        >
          {confirmLabel}
        </Button>
      </div>
    </Overlay>
  );
}
