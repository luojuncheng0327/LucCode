/**
 * API Key 输入框 — password/text 切换
 */
import React, { useState } from 'react';
import styles from '../Settings.module.css';

interface KeyInputProps {
  value: string;
  onChange: (val: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  onBlur?: (event: React.FocusEvent<HTMLDivElement>) => void;
  onReveal?: () => Promise<string | null | undefined>;
  onRevealError?: (err: unknown) => void;
}

export function KeyInput({ value, onChange, placeholder, ariaLabel, onBlur, onReveal, onRevealError }: KeyInputProps) {
  const t = window.t || ((k: string) => k);
  const [visible, setVisible] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [revealedValue, setRevealedValue] = useState<string | null>(null);
  const isTransientSecretVisible = visible && revealedValue !== null;
  const displayValue = isTransientSecretVisible ? revealedValue : value;

  const replaceTransientSecret = (nextValue: string) => {
    const safeValue = revealedValue && nextValue.includes(revealedValue)
      ? nextValue.replace(revealedValue, '')
      : nextValue;
    setRevealedValue(null);
    onChange(safeValue);
  };

  const toggleVisible = async () => {
    if (visible) {
      setVisible(false);
      setRevealedValue(null);
      return;
    }

    if (!onReveal) {
      setVisible(true);
      return;
    }

    setRevealing(true);
    try {
      const revealed = await onReveal();
      if (typeof revealed === 'string') {
        setRevealedValue(revealed);
      }
      setVisible(true);
    } catch (err) {
      onRevealError?.(err);
    } finally {
      setRevealing(false);
    }
  };

  return (
    <div
      className={styles['settings-key-wrapper']}
      onBlur={(event) => {
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
        onBlur?.(event);
      }}
    >
      <input
        className={`${styles['settings-input']} ${styles['settings-key-input']}`}
        type={visible ? 'text' : 'password'}
        value={displayValue}
        readOnly={isTransientSecretVisible}
        data-secret-visible={isTransientSecretVisible ? 'true' : undefined}
        aria-label={ariaLabel}
        onChange={(e) => {
          if (isTransientSecretVisible) {
            replaceTransientSecret(e.target.value);
            return;
          }
          onChange(e.target.value);
        }}
        onCopy={(e) => {
          if (!isTransientSecretVisible) return;
          e.preventDefault();
          e.stopPropagation();
        }}
        onCut={(e) => {
          if (!isTransientSecretVisible) return;
          e.preventDefault();
          e.stopPropagation();
        }}
        onPaste={(e) => {
          if (!isTransientSecretVisible) return;
          e.preventDefault();
          e.stopPropagation();
          replaceTransientSecret(e.clipboardData.getData('text'));
        }}
        onKeyDown={(e) => {
          if (!isTransientSecretVisible) return;
          const key = e.key.toLowerCase();
          if ((e.metaKey || e.ctrlKey) && (key === 'a' || key === 'c' || key === 'x')) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          if (e.metaKey || e.ctrlKey || e.altKey) return;
          if (e.key.length === 1) {
            e.preventDefault();
            e.stopPropagation();
            replaceTransientSecret(e.key);
            return;
          }
          if (e.key === 'Backspace' || e.key === 'Delete') {
            e.preventDefault();
            e.stopPropagation();
            replaceTransientSecret('');
          }
        }}
        placeholder={placeholder}
      />
      <button
        className={styles['settings-key-toggle']}
        type="button"
        disabled={revealing}
        onClick={() => { void toggleVisible(); }}
      >
        {visible ? t('settings.api.hideKey') : t('settings.api.showKey')}
      </button>
    </div>
  );
}
