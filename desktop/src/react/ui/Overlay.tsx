import {
  useEffect,
  useRef,
  useCallback,
  type AriaAttributes,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { useAnimatePresence, type AnimateStage } from '../hooks/use-animate-presence';
import { useWindowSurface } from './window-surface';
import styles from './Overlay.module.css';

type BackdropVariant = 'dim' | 'blur' | 'none';
export type OverlayScope = 'inline' | 'window';

type OverlayContentProps = AriaAttributes & Pick<HTMLAttributes<HTMLDivElement>, 'id' | 'role'> & {
  [attribute: `data-${string}`]: string | number | boolean | null | undefined;
};

export interface OverlayProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Render in place, or portal to the active WindowSurface overlay root. */
  scope: OverlayScope;
  backdrop?: BackdropVariant;
  closeOnEsc?: boolean;
  closeOnBackdrop?: boolean;
  trapFocus?: boolean;
  zIndex?: number;
  /** 应用到内容容器的 class。不提供时使用默认卡片外观 */
  className?: string;
  backdropClassName?: string;
  /** Constrain the overlay to the nearest positioned ancestor instead of the viewport. */
  contained?: boolean;
  duration?: number;
  /** Preferred focus target once the enter transition finishes. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Semantic and data attributes applied to the content container. */
  contentProps?: OverlayContentProps;
  /** 禁用 Overlay 默认的容器进出动画（luc-scale-in / luc-fade-down），让 className 自带的动画接管。 */
  disableContainerAnimation?: boolean;
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function stageClass(stage: AnimateStage, enter: string, exit: string) {
  if (stage === 'enter') return enter;
  if (stage === 'exit') return exit;
  return '';
}

export function Overlay({
  open,
  onClose,
  children,
  scope,
  backdrop = 'dim',
  closeOnEsc = true,
  closeOnBackdrop = true,
  trapFocus = true,
  zIndex = 1000,
  className,
  backdropClassName,
  contained = false,
  duration = 250,
  initialFocusRef,
  contentProps,
  disableContainerAnimation = false,
}: OverlayProps) {
  const surface = useWindowSurface();
  const { mounted, stage } = useAnimatePresence(open, { duration });
  const backdropRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<Element | null>(null);

  useEffect(() => {
    if (mounted) {
      returnFocusRef.current = surface.document.activeElement;
    } else {
      const returnFocus = returnFocusRef.current;
      if (returnFocus && typeof (returnFocus as HTMLElement).focus === 'function') {
        (returnFocus as HTMLElement).focus();
      }
      returnFocusRef.current = null;
    }
  }, [mounted, surface.document]);

  useEffect(() => {
    if (!open || !mounted || !trapFocus) return;
    const el = backdropRef.current;
    if (!el) return;
    const preferred = initialFocusRef?.current;
    if (preferred?.isConnected && preferred.ownerDocument === surface.document) {
      preferred.focus();
      return;
    }
    const first = el.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? el).focus();
  }, [initialFocusRef, mounted, open, surface.document, trapFocus]);

  const stopKeyboardPropagation = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation();
  }, []);

  const handleKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      stopKeyboardPropagation(e);
      if (closeOnEsc) onClose();
      return;
    }
    if (e.key !== 'Tab' || !trapFocus) return;

    stopKeyboardPropagation(e);
    const el = backdropRef.current;
    if (!el) return;
    const nodes = el.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (nodes.length === 0) {
      e.preventDefault();
      el.focus();
      return;
    }

    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const activeElement = surface.document.activeElement;
    if (!el.contains(activeElement)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    } else if (e.shiftKey && activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }, [closeOnEsc, onClose, open, stopKeyboardPropagation, surface.document, trapFocus]);

  const handleBackdropClick = useCallback((e: MouseEvent) => {
    if (closeOnBackdrop && e.target === e.currentTarget) onClose();
  }, [closeOnBackdrop, onClose]);

  if (!mounted) return null;

  const backdropCls = [
    styles.backdrop,
    contained && styles['contained-backdrop'],
    backdrop === 'dim' && styles['backdrop-dim'],
    backdrop === 'blur' && styles['backdrop-blur'],
    stageClass(stage, styles.enter, styles.exit),
    backdropClassName,
  ].filter(Boolean).join(' ');

  const containerCls = [
    styles.container,
    contained && styles['contained-container'],
    !disableContainerAnimation && stageClass(stage, styles['container-enter'], styles['container-exit']),
    className || styles.card,
  ].filter(Boolean).join(' ');

  const overlay = (
    <div
      ref={backdropRef}
      className={backdropCls}
      style={{ zIndex }}
      tabIndex={-1}
      onMouseDown={handleBackdropClick}
      onKeyDown={handleKeyDown}
    >
      <div {...contentProps} className={containerCls}>
        {children}
      </div>
    </div>
  );

  return scope === 'window'
    ? createPortal(overlay, surface.overlayRoot)
    : overlay;
}
