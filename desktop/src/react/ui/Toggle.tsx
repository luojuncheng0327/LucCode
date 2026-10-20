import React from 'react';
import styles from './Toggle.module.css';

export interface ToggleProps {
  on: boolean | undefined;
  onChange: (on: boolean) => void;
  label?: string;
  ariaLabel?: string;
  title?: string;
  disabled?: boolean;
}

export function Toggle({ on, onChange, label, ariaLabel, title, disabled = false }: ToggleProps) {
  const loading = on === undefined;
  const visualOn = on === true;
  const effectiveDisabled = disabled || loading;
  const className = [
    'luc-toggle',
    visualOn ? 'on' : '',
    loading ? 'loading' : '',
  ].filter(Boolean).join(' ');
  return (
    <div className={styles.root}>
      <button
        className={className}
        type="button"
        disabled={effectiveDisabled}
        aria-label={ariaLabel || label}
        title={title}
        aria-busy={loading || undefined}
        role="switch"
        aria-checked={loading ? 'mixed' : visualOn}
        onClick={(e) => {
          e.stopPropagation();
          if (loading) return;
          onChange(!visualOn);
        }}
      />
      {label && <span className="luc-toggle-label">{label}</span>}
    </div>
  );
}
