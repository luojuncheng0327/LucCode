import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import styles from './SelectWidget.module.css';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  group?: string;
  description?: string;
}

export { styles as selectWidgetStyles };

interface SelectWidgetProps {
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
  popupClassName?: string;
  renderTrigger?: (option: SelectOption | undefined, isOpen: boolean) => React.ReactNode;
  renderOption?: (option: SelectOption, isSelected: boolean) => React.ReactNode;
  /** Custom group-header renderer; defaults to the built-in label */
  renderGroupHeader?: (group: string) => React.ReactNode;
  /** 'comfortable' gives 1.2x row height for avatar-containing options */
  density?: 'compact' | 'comfortable';
  /** Popup horizontal alignment relative to trigger */
  align?: 'start' | 'end';
  /** Skip the built-in trigger chrome (border/padding/bg) so a custom trigger fully owns its look */
  triggerBare?: boolean;
  /** Gap in px between trigger and popup (default 2) */
  offset?: number;
  /** Force the popup min-width in px; defaults to the trigger width */
  popupMinWidth?: number;
  /** Force open direction; 'auto' decides by available space */
  placement?: 'auto' | 'top' | 'bottom';
  /** Guard run before opening; return false to veto (e.g. show a toast instead) */
  onAttemptOpen?: () => boolean;
}

export function SelectWidget({
  options,
  value,
  onChange,
  placeholder,
  disabled,
  className,
  triggerClassName,
  popupClassName,
  renderTrigger,
  renderOption,
  renderGroupHeader,
  density = 'compact',
  align = 'end',
  triggerBare = false,
  offset = 2,
  popupMinWidth,
  placement = 'auto',
  onAttemptOpen,
}: SelectWidgetProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({});
  const [openDirection, setOpenDirection] = useState<'up' | 'down'>('down');

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const openAbove = placement === 'top'
      ? true
      : placement === 'bottom'
        ? false
        : (spaceBelow < 200 && spaceAbove > spaceBelow);
    setOpenDirection(openAbove ? 'up' : 'down');

    setPanelStyle({
      position: 'fixed',
      ...(align === 'start'
        ? { left: rect.left }
        : { right: window.innerWidth - rect.right }),
      minWidth: popupMinWidth ?? rect.width,
      ...(openAbove
        ? { bottom: window.innerHeight - rect.top + offset }
        : { top: rect.bottom + offset }),
      zIndex: 9999,
    });
  }, [open, align, offset, popupMinWidth, placement]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: Event) => {
      const target = e.target as Node | null;
      if (panelRef.current?.contains(target)) return;
      // Only a scroll that can actually move the trigger out from under the popup should close
      // it. A scroll inside some unrelated container — e.g. a background keep-alive chat panel
      // (visibility:hidden but still laid out) collapsing its process-fold/typing-indicator at
      // turn end — fires a capture-phase scroll event here too, but it has no bearing on this
      // popup's trigger position and must not close a dropdown open in another session/surface.
      const trigger = triggerRef.current;
      if (
        trigger
        && target
        && typeof (target as Element | Document).contains === 'function'
        && !(target as Element | Document).contains(trigger)
      ) {
        return;
      }
      close();
    };
    window.addEventListener('scroll', handler, true);
    return () => window.removeEventListener('scroll', handler, true);
  }, [open, close]);

  const current = options.find(o => o.value === value);
  const displayText = current?.label || placeholder || '';
  const isPlaceholder = !current;

  const renderItems = () => {
    const hasGroups = options.some(o => o.group);
    if (!hasGroups) {
      return options.map(item => renderItem(item));
    }

    const groups: Record<string, SelectOption[]> = {};
    for (const o of options) {
      const g = o.group || '';
      if (!groups[g]) groups[g] = [];
      groups[g].push(o);
    }

    return Object.entries(groups).map(([group, items]) => (
      <div key={group || '__none'}>
        {group && (renderGroupHeader ? renderGroupHeader(group) : <div className={styles.groupHeader}>{group}</div>)}
        {items.map(item => renderItem(item, group))}
      </div>
    ));
  };

  const renderItem = (item: SelectOption, group?: string) => {
    const selected = item.value === value;
    return (
      <button
        type="button"
        key={group ? `${group}/${item.value}` : item.value}
        role="option"
        aria-selected={selected}
        className={[
          styles.option,
          selected && styles.selected,
          item.disabled && styles.disabled,
        ].filter(Boolean).join(' ')}
        disabled={item.disabled}
        onClick={() => {
          if (item.disabled) return;
          onChange(item.value);
          close();
        }}
      >
        {renderOption ? renderOption(item, selected) : (
          <>
            <span>{item.label}</span>
            {item.description && <span className={styles.optionDesc}>{item.description}</span>}
          </>
        )}
      </button>
    );
  };

  return (
    <div className={[styles.root, open && styles.open, className].filter(Boolean).join(' ')}>
      <button
        type="button"
        className={[!triggerBare && styles.trigger, triggerClassName].filter(Boolean).join(' ')}
        ref={triggerRef}
        onClick={() => {
          if (disabled) return;
          if (!open && onAttemptOpen && !onAttemptOpen()) return;
          setOpen(!open);
        }}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-open={open}
        title={displayText}
      >
        {renderTrigger ? renderTrigger(current, open) : (
          <>
            <span className={[styles.value, isPlaceholder && styles.placeholder].filter(Boolean).join(' ')}>
              {displayText}
            </span>
            <svg className={styles.arrow} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 6l4 4 4-4" />
            </svg>
          </>
        )}
      </button>
      {open && createPortal(
        <div
          className={[styles.popup, density === 'comfortable' && styles.comfortable, popupClassName].filter(Boolean).join(' ')}
          ref={panelRef}
          style={panelStyle}
          data-select-widget-popup
          data-direction={openDirection}
          data-align={align}
          role="listbox"
        >
          {renderItems()}
        </div>,
        document.body,
      )}
    </div>
  );
}
