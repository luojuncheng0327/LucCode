import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type WheelEvent } from 'react';
import styles from './AutomationPanel.module.css';

export interface AgentTabScrollerItem {
  id: string;
  label: string;
  avatar: ReactNode;
}

interface AgentTabScrollerProps {
  items: AgentTabScrollerItem[];
  activeId: string | null;
  ariaLabel: string;
  previousLabel: string;
  nextLabel: string;
  onSelect: (id: string) => void;
}

function wheelDeltaToPixels(event: WheelEvent<HTMLElement>): number {
  const dominantDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  const lineMode = typeof window.WheelEvent !== 'undefined' ? window.WheelEvent.DOM_DELTA_LINE : 1;
  const pageMode = typeof window.WheelEvent !== 'undefined' ? window.WheelEvent.DOM_DELTA_PAGE : 2;
  if (event.deltaMode === lineMode) return dominantDelta * 32;
  if (event.deltaMode === pageMode) return dominantDelta * event.currentTarget.clientWidth;
  return dominantDelta;
}

function maxScrollLeft(element: HTMLElement) {
  return Math.max(0, element.scrollWidth - element.clientWidth);
}

function clampScrollLeft(element: HTMLElement, value: number) {
  return Math.min(maxScrollLeft(element), Math.max(0, value));
}

function setScrollLeft(element: HTMLElement, value: number) {
  element.scrollLeft = clampScrollLeft(element, value);
}

function focusAfterSelection(element: HTMLElement | undefined) {
  if (!element) return;
  if (typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(() => element.focus());
    return;
  }
  element.focus();
}

function Chevron({ direction }: { direction: 'left' | 'right' }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points={direction === 'left' ? '15 18 9 12 15 6' : '9 18 15 12 9 6'} />
    </svg>
  );
}

export function AgentTabScroller({
  items,
  activeId,
  ariaLabel,
  previousLabel,
  nextLabel,
  onSelect,
}: AgentTabScrollerProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const activeIndex = useMemo(() => items.findIndex(item => item.id === activeId), [activeId, items]);

  const updateScrollState = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const max = maxScrollLeft(scroller);
    setCanScrollLeft(scroller.scrollLeft > 1);
    setCanScrollRight(scroller.scrollLeft < max - 1);
  }, []);

  const centerActiveTab = useCallback(() => {
    const scroller = scrollerRef.current;
    const activeItem = activeId ? itemRefs.current.get(activeId) : null;
    if (!scroller || !activeItem || maxScrollLeft(scroller) <= 0) return;

    const targetLeft = activeItem.offsetLeft - (scroller.clientWidth - activeItem.offsetWidth) / 2;
    setScrollLeft(scroller, targetLeft);
    updateScrollState();
  }, [activeId, updateScrollState]);

  useEffect(() => {
    updateScrollState();
    centerActiveTab();
  }, [centerActiveTab, items.length, updateScrollState]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return undefined;

    scroller.addEventListener('scroll', updateScrollState, { passive: true });
    window.addEventListener('resize', updateScrollState);
    const resizeObserver = typeof window.ResizeObserver === 'function'
      ? new window.ResizeObserver(updateScrollState)
      : null;
    resizeObserver?.observe(scroller);
    updateScrollState();

    return () => {
      scroller.removeEventListener('scroll', updateScrollState);
      window.removeEventListener('resize', updateScrollState);
      resizeObserver?.disconnect();
    };
  }, [updateScrollState]);

  const scrollByPage = useCallback((direction: -1 | 1) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const page = Math.max(96, Math.floor(scroller.clientWidth * 0.72));
    setScrollLeft(scroller, scroller.scrollLeft + page * direction);
    updateScrollState();
  }, [updateScrollState]);

  const handleWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    const scroller = event.currentTarget;
    if (maxScrollLeft(scroller) <= 0) return;

    const delta = wheelDeltaToPixels(event);
    if (delta === 0) return;

    const nextScrollLeft = clampScrollLeft(scroller, scroller.scrollLeft + delta);
    if (nextScrollLeft === scroller.scrollLeft) return;

    event.preventDefault();
    scroller.scrollLeft = nextScrollLeft;
    updateScrollState();
  }, [updateScrollState]);

  const selectByIndex = useCallback((nextIndex: number) => {
    const nextItem = items[nextIndex];
    if (!nextItem) return;
    onSelect(nextItem.id);
    focusAfterSelection(itemRefs.current.get(nextItem.id));
  }, [items, onSelect]);

  const handleTabKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (items.length === 0) return;
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      selectByIndex(Math.min(items.length - 1, index + 1));
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      selectByIndex(Math.max(0, index - 1));
    } else if (event.key === 'Home') {
      event.preventDefault();
      selectByIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      selectByIndex(items.length - 1);
    }
  }, [items.length, selectByIndex]);

  return (
    <div className={styles.agentTabsFrame}>
      <button
        className={styles.agentTabsArrow}
        type="button"
        aria-label={previousLabel}
        title={previousLabel}
        disabled={!canScrollLeft}
        onClick={() => scrollByPage(-1)}
      >
        <Chevron direction="left" />
      </button>
      <div
        className={styles.agentTabsShell}
        data-testid="agent-tab-scroller"
        ref={scrollerRef}
        onWheel={handleWheel}
      >
        <div className={styles.agentTabs} role="tablist" aria-label={ariaLabel}>
          {items.map((item, index) => {
            const active = index === activeIndex;
            return (
              <button
                key={item.id}
                ref={element => {
                  if (element) itemRefs.current.set(item.id, element);
                  else itemRefs.current.delete(item.id);
                }}
                className={styles.agentTab}
                type="button"
                role="tab"
                aria-selected={active}
                data-active={active}
                data-agent-id={item.id}
                tabIndex={active || activeIndex < 0 ? 0 : -1}
                onClick={() => onSelect(item.id)}
                onKeyDown={event => handleTabKeyDown(event, index)}
              >
                <span className={styles.agentTabAvatarWrap} aria-hidden="true">{item.avatar}</span>
                <span className={styles.agentTabName}>{item.label}</span>
              </button>
            );
          })}
        </div>
      </div>
      <button
        className={styles.agentTabsArrow}
        type="button"
        aria-label={nextLabel}
        title={nextLabel}
        disabled={!canScrollRight}
        onClick={() => scrollByPage(1)}
      >
        <Chevron direction="right" />
      </button>
    </div>
  );
}
