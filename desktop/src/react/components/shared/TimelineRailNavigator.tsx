import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react';
import styles from './TimelineRailNavigator.module.css';

const TIMELINE_MAX_VISIBLE_ROWS = 10;

export interface TimelineRailItem<TPayload = unknown> {
  id: string;
  label: string;
  markerWidthEm: number;
  labelIndentRem?: number;
  markerWidthScale?: number;
  payload: TPayload;
}

interface Props<TPayload> {
  items: Array<TimelineRailItem<TPayload>>;
  active: boolean;
  activeId: string | null;
  railVisible: boolean;
  side?: 'left' | 'right';
  ariaLabel: string;
  jumpLabel: (item: TimelineRailItem<TPayload>) => string;
  onJump: (item: TimelineRailItem<TPayload>) => void;
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function TimelineRailNavigator<TPayload>({
  items,
  active,
  activeId,
  railVisible,
  side = 'right',
  ariaLabel,
  jumpLabel,
  onJump,
}: Props<TPayload>) {
  const [focusOpen, setFocusOpen] = useState(false);
  const [cardHover, setCardHover] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const hoverCloseTimerRef = useRef<number | null>(null);

  const openHoverCard = useCallback(() => {
    if (hoverCloseTimerRef.current != null) {
      window.clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
    setCardHover(true);
  }, []);

  const closeHoverCardSoon = useCallback(() => {
    if (hoverCloseTimerRef.current != null) window.clearTimeout(hoverCloseTimerRef.current);
    hoverCloseTimerRef.current = window.setTimeout(() => {
      hoverCloseTimerRef.current = null;
      setCardHover(false);
    }, 120);
  }, []);

  const closeHoverCardFromMarker = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && cardRef.current?.contains(nextTarget)) {
      openHoverCard();
      return;
    }
    closeHoverCardSoon();
  }, [closeHoverCardSoon, openHoverCard]);

  useEffect(() => () => {
    if (hoverCloseTimerRef.current != null) {
      window.clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
  }, []);

  const visibleRows = Math.min(items.length, TIMELINE_MAX_VISIBLE_ROWS);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = finiteNumber(list.scrollHeight);
  }, [items.length, visibleRows]);

  if (!active || items.length === 0) return null;

  const cardVars: CSSProperties & { '--timeline-visible-rows': number } = {
    '--timeline-visible-rows': Math.max(1, visibleRows),
  };
  const cardOpen = focusOpen || cardHover;
  const navVisible = railVisible || cardOpen;
  const navClassName = [
    styles.timelineNav,
    side === 'left' ? styles.timelineNavLeft : styles.timelineNavRight,
    navVisible ? styles.timelineNavVisible : '',
    cardOpen ? styles.timelineNavExpanded : '',
  ].filter(Boolean).join(' ');

  return (
    <nav
      className={navClassName}
      aria-label={ariaLabel}
      onBlur={(event) => {
        const nextFocus = event.relatedTarget;
        if (nextFocus instanceof Node && event.currentTarget.contains(nextFocus)) return;
        setFocusOpen(false);
      }}
    >
      <div
        ref={cardRef}
        className={styles.timelineCard}
        style={cardVars}
        onPointerEnter={openHoverCard}
        onPointerLeave={closeHoverCardSoon}
      >
        <div className={styles.timelineList} ref={listRef}>
          {items.map((item) => {
            const selected = item.id === activeId;
            const markerWidthScaleValue = item.markerWidthScale;
            const markerWidthScale = typeof markerWidthScaleValue === 'number'
              && Number.isFinite(markerWidthScaleValue)
              && markerWidthScaleValue > 0
              ? markerWidthScaleValue
              : 1;
            const markerWidthEm = Number.isFinite(item.markerWidthEm) && item.markerWidthEm > 0
              ? item.markerWidthEm * markerWidthScale
              : 1;
            const labelIndentRemValue = item.labelIndentRem;
            const labelIndentRem = typeof labelIndentRemValue === 'number'
              && Number.isFinite(labelIndentRemValue)
              && labelIndentRemValue > 0
              ? labelIndentRemValue
              : 0;
            const markerStyle: CSSProperties & {
              '--timeline-label-indent': string;
              '--timeline-marker-max-width': string;
              '--timeline-marker-width': string;
            } = {
              '--timeline-label-indent': `${labelIndentRem}rem`,
              '--timeline-marker-max-width': `${markerWidthScale}em`,
              '--timeline-marker-width': `${markerWidthEm}em`,
            };
            return (
              <button
                key={item.id}
                type="button"
                className={`${styles.timelineMarker}${selected ? ` ${styles.timelineMarkerActive}` : ''}`}
                style={markerStyle}
                aria-label={jumpLabel(item)}
                title={item.label}
                onFocus={() => setFocusOpen(true)}
                onMouseEnter={openHoverCard}
                onMouseLeave={closeHoverCardFromMarker}
                onClick={() => onJump(item)}
              >
                <span className={styles.timelineLabel}>{item.label}</span>
                <span
                  className={styles.timelineLine}
                  aria-hidden="true"
                  onMouseEnter={openHoverCard}
                />
              </button>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
