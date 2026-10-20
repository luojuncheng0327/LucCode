import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import styles from './Tooltip.module.css';

/** 统一的 tooltip 出现延迟(ms)。所有 <Tooltip> 默认走这个值,避免各处出现时间不一致。 */
const DEFAULT_DELAY_MS = 500;

export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right';
export type TooltipAlign = 'start' | 'center' | 'end';
export type TooltipVariant = 'compact' | 'panel';

export interface TooltipTriggerProps {
  ref: (node: HTMLElement | null) => void;
  'aria-describedby'?: string;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onFocus: () => void;
  onBlur: () => void;
}

interface TooltipProps {
  content: ReactNode;
  children: ReactNode | ((props: TooltipTriggerProps) => ReactNode);
  id?: string;
  disabled?: boolean;
  delayMs?: number;
  placement?: TooltipPlacement;
  align?: TooltipAlign;
  variant?: TooltipVariant;
  anchorClassName?: string;
}

interface TooltipPosition {
  top: number;
  left: number;
  placement: TooltipPlacement;
}

function hasTooltipContent(content: ReactNode) {
  return content !== null && content !== undefined && content !== false && content !== '';
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

function choosePlacement(
  preferred: TooltipPlacement,
  anchorRect: DOMRect,
  panelWidth: number,
  panelHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  viewportPadding: number,
  gap: number,
): TooltipPlacement {
  if (preferred === 'top') {
    if (anchorRect.top - panelHeight - gap >= viewportPadding) return 'top';
    if (anchorRect.bottom + panelHeight + gap <= viewportHeight - viewportPadding) return 'bottom';
    return 'top';
  }
  if (preferred === 'bottom') {
    if (anchorRect.bottom + panelHeight + gap <= viewportHeight - viewportPadding) return 'bottom';
    if (anchorRect.top - panelHeight - gap >= viewportPadding) return 'top';
    return 'bottom';
  }
  if (preferred === 'left') {
    if (anchorRect.left - panelWidth - gap >= viewportPadding) return 'left';
    if (anchorRect.right + panelWidth + gap <= viewportWidth - viewportPadding) return 'right';
    return 'left';
  }
  if (anchorRect.right + panelWidth + gap <= viewportWidth - viewportPadding) return 'right';
  if (anchorRect.left - panelWidth - gap >= viewportPadding) return 'left';
  return 'right';
}

function alignedCrossAxis(
  align: TooltipAlign,
  anchorStart: number,
  anchorSize: number,
  panelSize: number,
) {
  if (align === 'start') return anchorStart;
  if (align === 'end') return anchorStart + anchorSize - panelSize;
  return anchorStart + (anchorSize - panelSize) / 2;
}

export function Tooltip({
  content,
  children,
  id,
  disabled = false,
  delayMs = DEFAULT_DELAY_MS,
  placement = 'top',
  align = 'center',
  variant = 'compact',
  anchorClassName,
}: TooltipProps) {
  const reactId = useId();
  const tooltipId = id || `luc-tooltip-${reactId}`;
  const anchorRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<TooltipPosition | null>(null);
  const available = !disabled && hasTooltipContent(content);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const show = useCallback(() => {
    if (!available) return;
    clearTimer();
    if (delayMs > 0) {
      timerRef.current = window.setTimeout(() => {
        setOpen(true);
        timerRef.current = null;
      }, delayMs);
      return;
    }
    setOpen(true);
  }, [available, clearTimer, delayMs]);

  const hide = useCallback(() => {
    clearTimer();
    setOpen(false);
  }, [clearTimer]);

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!open || !anchor || !panel) return;

    const anchorRect = anchor.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const viewportPadding = 8;
    const gap = variant === 'panel' ? 8 : 7;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const panelWidth = panelRect.width || Math.min(160, viewportWidth - viewportPadding * 2);
    const panelHeight = panelRect.height || 28;
    const resolvedPlacement = choosePlacement(
      placement,
      anchorRect,
      panelWidth,
      panelHeight,
      viewportWidth,
      viewportHeight,
      viewportPadding,
      gap,
    );

    let top = 0;
    let left = 0;
    if (resolvedPlacement === 'top' || resolvedPlacement === 'bottom') {
      left = alignedCrossAxis(align, anchorRect.left, anchorRect.width, panelWidth);
      top = resolvedPlacement === 'top'
        ? anchorRect.top - panelHeight - gap
        : anchorRect.bottom + gap;
    } else {
      top = alignedCrossAxis(align, anchorRect.top, anchorRect.height, panelHeight);
      left = resolvedPlacement === 'left'
        ? anchorRect.left - panelWidth - gap
        : anchorRect.right + gap;
    }

    setPosition({
      top: clamp(top, viewportPadding, Math.max(viewportPadding, viewportHeight - panelHeight - viewportPadding)),
      left: clamp(left, viewportPadding, Math.max(viewportPadding, viewportWidth - panelWidth - viewportPadding)),
      placement: resolvedPlacement,
    });
  }, [align, open, placement, variant]);

  useLayoutEffect(() => {
    updatePosition();
  }, [updatePosition]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!available) setOpen(false);
  }, [available]);

  useEffect(() => () => clearTimer(), [clearTimer]);

  const triggerProps = useMemo<TooltipTriggerProps>(() => ({
    ref: (node: HTMLElement | null) => {
      anchorRef.current = node;
    },
    'aria-describedby': open ? tooltipId : undefined,
    onMouseEnter: show,
    onMouseLeave: hide,
    onFocus: show,
    onBlur: hide,
  }), [hide, open, show, tooltipId]);

  const anchor = typeof children === 'function'
    ? children(triggerProps)
    : (
      <span className={[styles.anchor, anchorClassName].filter(Boolean).join(' ')} {...triggerProps}>
        {children}
      </span>
    );

  const tooltip = open && available && typeof document !== 'undefined'
    ? createPortal(
      <div
        id={tooltipId}
        ref={panelRef}
        role="tooltip"
        className={[styles.tooltip, styles[`variant-${variant}`]].filter(Boolean).join(' ')}
        data-placement={position?.placement || placement}
        style={{
          top: position?.top ?? 0,
          left: position?.left ?? 0,
          visibility: position ? 'visible' : 'hidden',
        }}
      >
        {content}
      </div>,
      document.body,
    )
    : null;

  return (
    <>
      {anchor}
      {tooltip}
    </>
  );
}
