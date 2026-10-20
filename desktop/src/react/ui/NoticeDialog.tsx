import { useId, useRef, type ReactNode } from 'react';
import { Button } from './Button';
import { Overlay, type OverlayScope } from './Overlay';
import styles from './NoticeDialog.module.css';

export interface NoticeDialogProps {
  open: boolean;
  scope: OverlayScope;
  title: ReactNode;
  children: ReactNode;
  confirmLabel: ReactNode;
  onConfirm: () => void;
  closeOnBackdrop?: boolean;
  closeOnEsc?: boolean;
  zIndex?: number;
}

export function NoticeDialog({
  open,
  scope,
  title,
  children,
  confirmLabel,
  onConfirm,
  closeOnBackdrop = false,
  closeOnEsc = true,
  zIndex,
}: NoticeDialogProps) {
  const titleId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);

  return (
    <Overlay
      open={open}
      scope={scope}
      onClose={onConfirm}
      backdrop="dim"
      closeOnBackdrop={closeOnBackdrop}
      closeOnEsc={closeOnEsc}
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
        <Button variant="primary" onClick={onConfirm} className={styles.action}>
          {confirmLabel}
        </Button>
      </div>
    </Overlay>
  );
}
