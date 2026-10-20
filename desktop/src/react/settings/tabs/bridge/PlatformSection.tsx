/**
 * Generic platform configuration section for Bridge settings.
 * Eliminates per-platform copy-paste by accepting credential fields declaratively.
 */
import React, { useRef } from 'react';
import { t } from '../../helpers';
import { SelectWidget, Toggle, type SelectOption } from '@/ui';
import { KeyInput } from '../../widgets/KeyInput';
import { BridgeStatusDot, BridgeStatusText, OwnerSelect } from './BridgeWidgets';
import type { KnownUser } from './BridgeWidgets';
import { SettingsSection } from '../../components/SettingsSection';
import { SettingsRow } from '../../components/SettingsRow';
import styles from '../../Settings.module.css';

// ── Types ──

export interface CredentialField {
  key: string;
  label: string;
  type: 'text' | 'secret' | 'select';
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  options?: SelectOption[];
}

interface PlatformSectionProps {
  platform: string;
  title: string;
  status?: { status?: string; error?: string; enabled?: boolean };
  credentialFields: CredentialField[];
  onToggle: (enabled: boolean) => void;
  onTest: () => void;
  testing: boolean;
  hint?: string;
  ownerUsers?: KnownUser[];
  currentOwner?: string;
  onOwnerChange?: (userId: string) => void;
  onCredentialBlur?: () => void;
  children?: React.ReactNode;
}

export function PlatformSection({
  title,
  status,
  credentialFields,
  onToggle,
  onTest,
  testing,
  hint,
  ownerUsers,
  currentOwner,
  onOwnerChange,
  onCredentialBlur,
  platform,
  children,
}: PlatformSectionProps) {
  const lastFieldIndex = credentialFields.length - 1;
  const skipNextCredentialBlurRef = useRef(false);

  const handleCredentialBlur = (event: React.FocusEvent<HTMLElement>) => {
    const nextTarget = event.relatedTarget;
    if (
      nextTarget instanceof Element
      && nextTarget.closest('[data-bridge-test-control="true"]')
    ) {
      skipNextCredentialBlurRef.current = false;
      return;
    }
    if (skipNextCredentialBlurRef.current) {
      skipNextCredentialBlurRef.current = false;
      return;
    }
    onCredentialBlur?.();
  };

  const markTestIntent = () => {
    // Pointer activation moves focus out of the input before click. Skip that
    // one blur-save so a candidate credential is tested before it can replace
    // the currently working saved credential.
    skipNextCredentialBlurRef.current = true;
  };

  const handleTest = () => {
    skipNextCredentialBlurRef.current = false;
    onTest();
  };

  // status === undefined 表示 b.status 还没加载完，Toggle 走加载态；
  // 加载完成但本平台未配置时 status.enabled 可能是 false/undefined，统一显示关。
  const toggleOn = status === undefined ? undefined : !!status.enabled;

  /** 状态点 + 文字 + Toggle 作为 section 右上角 context */
  const statusContext = (
    <div className="bridge-platform-header" style={{ margin: 0 }}>
      <BridgeStatusDot status={status?.status} />
      <BridgeStatusText status={status?.status} error={status?.error} />
      <Toggle on={toggleOn} onChange={onToggle} ariaLabel={`${title}: ${t('settings.bridge.connectionToggle')}`} />
    </div>
  );

  return (
    <SettingsSection title={title} context={statusContext}>
      {credentialFields.map((field, idx) => {
        const isLast = idx === lastFieldIndex;
        const input = field.type === 'select' ? (
          <SelectWidget
            value={field.value}
            onChange={field.onChange}
            options={field.options || []}
          />
        ) : field.type === 'secret' ? (
          <div className="bridge-input-row">
            <KeyInput
              value={field.value}
              onChange={field.onChange}
              placeholder={field.placeholder || ''}
              ariaLabel={field.label}
              onBlur={handleCredentialBlur}
            />
            {isLast && (
              <button
                className="bridge-test-btn"
                disabled={testing}
                aria-label={`${title}: ${t('settings.bridge.test')}`}
                data-bridge-test-control="true"
                onPointerDown={markTestIntent}
                onClick={handleTest}
              >
                {testing ? '...' : t('settings.bridge.test')}
              </button>
            )}
          </div>
        ) : isLast ? (
          <div className="bridge-input-row">
            <input
              className={styles['settings-input']}
              type="text"
              value={field.value}
              aria-label={field.label}
              onChange={(e) => field.onChange(e.target.value)}
              onBlur={handleCredentialBlur}
            />
            <button
              className="bridge-test-btn"
              disabled={testing}
              aria-label={`${title}: ${t('settings.bridge.test')}`}
              data-bridge-test-control="true"
              onPointerDown={markTestIntent}
              onClick={handleTest}
            >
              {testing ? '...' : t('settings.bridge.test')}
            </button>
          </div>
        ) : (
          <input
            className={styles['settings-input']}
            type="text"
            value={field.value}
            aria-label={field.label}
            onChange={(e) => field.onChange(e.target.value)}
            onBlur={handleCredentialBlur}
          />
        );

        return (
          <SettingsRow
            key={field.key}
            label={field.label}
            hint={isLast && hint ? hint : undefined}
            layout="stacked"
            control={input}
          />
        );
      })}

      {/* 无凭据（如 WhatsApp）：只显示 hint */}
      {credentialFields.length === 0 && hint && (
        <div style={{
          padding: 'var(--space-8) var(--space-16)',
          fontSize: '0.7rem',
          color: 'var(--text-muted)',
          lineHeight: 1.4,
        }}>
          {hint}
        </div>
      )}

      {children}

      {ownerUsers && onOwnerChange && (
        <div style={{
          padding: 'var(--space-8) var(--space-16)',
          borderTop: '1px solid var(--border)',
        }}>
          <OwnerSelect
            platform={platform}
            users={ownerUsers}
            currentOwner={currentOwner}
            onChange={onOwnerChange}
          />
        </div>
      )}
    </SettingsSection>
  );
}
