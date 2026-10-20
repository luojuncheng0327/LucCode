import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { getNativeSelectionAnchorRect } from '../../stores/selection-actions';
import type { QuotedSelection } from '../../stores/input-slice';
import { computeFloatingInputPosition } from '../floating-input/position';
import styles from './SelectionQuoteActionSurface.module.css';

const DEFAULT_TOOLBAR_SIZE = { width: 92, height: 32 };
const QUOTE_ACTION_GAP = 12;
const TOOLBAR_CROSS_AXIS_OFFSET = 0;

function getViewportSize() {
  if (typeof window === 'undefined') return { width: 0, height: 0 };
  return {
    width: window.innerWidth || document.documentElement.clientWidth || 0,
    height: window.innerHeight || document.documentElement.clientHeight || 0,
  };
}

function canRefreshAnchorFromNativeSelection(selectionAnchorKind: QuotedSelection['selectionAnchorKind']): boolean {
  return selectionAnchorKind !== 'codemirror';
}

function clearNativeSelectionAfterQuote() {
  if (typeof window === 'undefined') return;
  const selection = window.getSelection?.();
  if (!selection || selection.rangeCount === 0) return;
  selection.removeAllRanges();
}

export function SelectionQuoteActionSurface() {
  const quoteCandidate = useStore(s => s.quoteCandidate);
  const addQuotedSelection = useStore(s => s.addQuotedSelection);
  const clearQuoteCandidate = useStore(s => s.clearQuoteCandidate);
  const requestInputFocus = useStore(s => s.requestInputFocus);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState(() => getViewportSize());
  const [, setScrollTick] = useState(0);
  const [toolbarSize, setToolbarSize] = useState(DEFAULT_TOOLBAR_SIZE);

  useEffect(() => {
    const handleResize = () => setViewport(getViewportSize());
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    let rafId = 0;
    const handleScroll = () => {
      if (rafId) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = 0;
        setScrollTick(tick => tick + 1);
      });
    };
    document.addEventListener('scroll', handleScroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener('scroll', handleScroll, { capture: true });
      if (rafId) window.cancelAnimationFrame(rafId);
    };
  }, []);

  useLayoutEffect(() => {
    if (!quoteCandidate) return undefined;
    const surface = surfaceRef.current;
    if (!surface) return undefined;

    const measure = () => {
      const rect = surface.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      setToolbarSize((current) => {
        if (Math.round(current.width) === Math.round(rect.width)
          && Math.round(current.height) === Math.round(rect.height)) {
          return current;
        }
        return { width: rect.width, height: rect.height };
      });
    };

    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [quoteCandidate]);

  const liveAnchorRect = canRefreshAnchorFromNativeSelection(quoteCandidate?.selectionAnchorKind)
    ? getLiveSelectionAnchorRect(quoteCandidate?.text, viewport)
    : undefined;
  const anchorRect = liveAnchorRect === null ? null : liveAnchorRect ?? quoteCandidate?.anchorRect;
  const position = anchorRect && viewport.width > 0 && viewport.height > 0
    ? computeFloatingInputPosition(
      anchorRect,
      viewport,
      toolbarSize,
      QUOTE_ACTION_GAP,
      16,
      'top',
      TOOLBAR_CROSS_AXIS_OFFSET,
    )
    : null;

  const handleAddQuote = useCallback(() => {
    if (!quoteCandidate) return;
    addQuotedSelection(quoteCandidate);
    clearNativeSelectionAfterQuote();
    clearQuoteCandidate();
    requestInputFocus();
  }, [addQuotedSelection, clearQuoteCandidate, quoteCandidate, requestInputFocus]);

  if (!quoteCandidate || !position) return null;

  const t = window.t ?? ((key: string) => key);
  const actions = [{
    id: 'quote',
    label: t('selection.quoteToChat'),
    onClick: handleAddQuote,
    icon: <QuoteIcon />,
  }];

  return (
    <div
      ref={surfaceRef}
      className={styles.surface}
      data-origin={position.origin}
      data-selection-quote-action="true"
      data-selection-ignore="true"
      style={{ left: `${position.left}px`, top: `${position.top}px` }}
    >
      {actions.map(action => (
        <button
          key={action.id}
          type="button"
          className={styles.button}
          aria-label={action.label}
          onMouseDown={(event) => event.preventDefault()}
          onClick={action.onClick}
        >
          {action.icon}
          <span className={styles.label}>{action.label}</span>
        </button>
      ))}
    </div>
  );
}

function getLiveSelectionAnchorRect(candidateText: string | undefined, viewport: { width: number; height: number }) {
  if (!candidateText) return undefined;
  const sel = window.getSelection();
  const selectionText = sel?.toString().trim();
  if (!sel || sel.rangeCount === 0 || !selectionText) return undefined;
  if (selectionText !== candidateText && !selectionText.startsWith(candidateText)) return undefined;
  const rect = getNativeSelectionAnchorRect(sel);
  if (!rect) return undefined;
  if (rect.bottom < 0 || rect.top > viewport.height || rect.right < 0 || rect.left > viewport.width) {
    return null;
  }
  return {
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

function QuoteIcon() {
  return (
    <svg
      className={styles.icon}
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M7.4 6.2C5.2 7.7 4 9.9 4 12.8V18h5.7v-5.7H7.1c.1-1.6.9-2.8 2.3-3.8l-2-2.3Z" />
      <path d="M16.4 6.2c-2.2 1.5-3.4 3.7-3.4 6.6V18h5.7v-5.7h-2.6c.1-1.6.9-2.8 2.3-3.8l-2-2.3Z" />
    </svg>
  );
}
