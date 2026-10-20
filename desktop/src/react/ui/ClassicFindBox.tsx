import { useEffect, useRef } from 'react';
import styles from './ClassicFindBox.module.css';

function iconPath(kind: 'search' | 'up' | 'down' | 'close'): string {
  if (kind === 'search') return 'M21 21l-4.3-4.3m1.8-5.2a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z';
  if (kind === 'up') return 'M18 15l-6-6-6 6';
  if (kind === 'down') return 'M6 9l6 6 6-6';
  return 'M18 6L6 18M6 6l12 12';
}

function Icon({ kind }: { kind: 'search' | 'up' | 'down' | 'close' }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={iconPath(kind)} />
    </svg>
  );
}

export function ClassicFindBox({
  open,
  query,
  resultIndex,
  resultCount,
  onQueryChange,
  onPrevious,
  onNext,
  onClose,
  placeholder,
  ariaLabel = 'Find',
}: {
  open: boolean;
  query: string;
  resultIndex: number;
  resultCount: number;
  onQueryChange: (query: string) => void;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
  placeholder?: string;
  ariaLabel?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);
  if (!open) return null;
  const countLabel = query ? `${resultCount ? resultIndex + 1 : 0}/${resultCount}` : '0/0';
  return (
    <div className={styles.findBox} role="search">
      <Icon kind="search" />
      <input
        ref={inputRef}
        value={query}
        onChange={event => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            if (event.shiftKey) onPrevious();
            else onNext();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
        }}
        placeholder={placeholder}
        aria-label={ariaLabel}
        data-classic-find-input=""
      />
      <span className={styles.findCount}>{countLabel}</span>
      <button type="button" onClick={onPrevious} aria-label="Previous match"><Icon kind="up" /></button>
      <button type="button" onClick={onNext} aria-label="Next match"><Icon kind="down" /></button>
      <button type="button" onClick={onClose} aria-label="Close find"><Icon kind="close" /></button>
    </div>
  );
}
