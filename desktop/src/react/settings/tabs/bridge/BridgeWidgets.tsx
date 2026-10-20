/**
 * Bridge small widgets — status indicators and owner selector
 */
import React, { useState } from 'react';
import { t } from '../../helpers';
import { SelectWidget } from '@/ui';
import { PermissionModeIcon } from '../../../components/input/PlanModeButton';
import styles from '../../Settings.module.css';
import bridgeStyles from '../BridgeTab.module.css';

// ── Types ──

export interface KnownUser {
  userId: string;
  name?: string;
  displayName?: string | null;
  fallbackName?: string;
  aliases?: string[];
  principalId?: string;
}

export type BridgePermissionMode = 'auto' | 'operate' | 'read_only';

const BRIDGE_PERMISSION_MODES: BridgePermissionMode[] = ['auto', 'operate', 'read_only'];

function bridgePermissionModeLabelKey(mode: BridgePermissionMode) {
  if (mode === 'auto') return 'settings.bridge.permissionModeAuto';
  if (mode === 'operate') return 'settings.bridge.permissionModeOperate';
  return 'settings.bridge.permissionModeReadOnly';
}

function bridgePermissionModeOption(mode: BridgePermissionMode) {
  return { value: mode, label: t(bridgePermissionModeLabelKey(mode)) };
}

export function BridgePermissionModeSelect({
  value,
  disabled,
  onChange,
}: {
  value: BridgePermissionMode | undefined;
  disabled?: boolean;
  onChange: (mode: BridgePermissionMode) => void;
}) {
  const loading = value === undefined;
  const mode = !loading && BRIDGE_PERMISSION_MODES.includes(value) ? value : 'auto';
  return (
    <SelectWidget
      value={mode}
      disabled={disabled || loading}
      onChange={(next) => {
        if (BRIDGE_PERMISSION_MODES.includes(next as BridgePermissionMode)) {
          onChange(next as BridgePermissionMode);
        }
      }}
      className={bridgeStyles['bridge-permission-select']}
      triggerClassName={`${bridgeStyles['bridge-permission-trigger']} ${bridgeStyles[`bridge-permission-${mode}`]}`}
      options={BRIDGE_PERMISSION_MODES.map(bridgePermissionModeOption)}
      renderTrigger={(option) => {
        const current = (option?.value || mode) as BridgePermissionMode;
        if (loading) {
          return (
            <>
              <span className={bridgeStyles['bridge-permission-value']}>
                <span>{t('common.loading')}</span>
              </span>
              <svg className={bridgeStyles['bridge-permission-arrow']} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 6l4 4 4-4" />
              </svg>
            </>
          );
        }
        return (
          <>
            <span className={bridgeStyles['bridge-permission-value']}>
              <PermissionModeIcon mode={current} />
              <span>{option?.label || t(bridgePermissionModeLabelKey(current))}</span>
            </span>
            <svg className={bridgeStyles['bridge-permission-arrow']} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 6l4 4 4-4" />
            </svg>
          </>
        );
      }}
      renderOption={(option) => {
        const optionMode = option.value as BridgePermissionMode;
        return (
          <span className={`${bridgeStyles['bridge-permission-option']} ${bridgeStyles[`bridge-permission-option-${optionMode}`]}`}>
            <PermissionModeIcon mode={optionMode} />
            <span>{option.label}</span>
          </span>
        );
      }}
    />
  );
}

// ── BridgeStatusDot ──

export function BridgeStatusDot({ status }: { status?: string }) {
  let cls = 'bridge-status-dot';
  const busy = status === undefined || status === 'connecting';
  if (busy) cls += ' bridge-dot-off bridge-dot-loading';
  else if (status === 'connected') cls += ' bridge-dot-ok';
  else if (status === 'error') cls += ' bridge-dot-err';
  else cls += ' bridge-dot-off';
  return <span className={cls} aria-busy={busy ? true : undefined} />;
}

// ── BridgeStatusText ──

export function BridgeStatusText({ status, error }: { status?: string; error?: string }) {
  let text = status === undefined ? t('common.loading') : t('settings.bridge.disconnected');
  if (status === 'connecting') text = t('status.connecting');
  else if (status === 'connected') text = t('settings.bridge.connected');
  else if (status === 'error') text = t('settings.bridge.error') + (error ? `: ${error}` : '');
  return <span className="bridge-status-text">{text}</span>;
}

// ── OwnerSelect ──

interface OwnerSelectProps {
  platform: string;
  users: KnownUser[];
  currentOwner?: string;
  onChange: (userId: string) => void;
}

export function OwnerSelect({ platform, users, currentOwner, onChange }: OwnerSelectProps) {
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);

  const handleChange = (value: string) => {
    if (!value) {
      onChange(value);
      return;
    }
    setPendingUserId(value);
  };

  const confirm = () => {
    if (pendingUserId !== null) {
      onChange(pendingUserId);
      setPendingUserId(null);
    }
  };

  const cancel = () => setPendingUserId(null);
  const optionLabel = (u: KnownUser) => {
    if (platform === 'qq') {
      const displayName = cleanQQOwnerDisplayName(u.displayName || u.name);
      if (displayName) return displayName;
      if (u.fallbackName) return u.fallbackName;
      return `QQ ${shortOwnerId(u.principalId || u.userId)}`;
    }
    if (u.name) return u.name;
    return u.userId;
  };

  return (
    <div className={`${styles['settings-form-field']} ${'bridge-owner-field'}`}>
      <label className={`${styles['settings-form-label']} ${'bridge-owner-label'}`}>{t('settings.bridge.ownerSelect')}</label>
      <p className="bridge-owner-warning">{t('settings.bridge.ownerWarning')}</p>
      <SelectWidget
        value={currentOwner || ''}
        onChange={handleChange}
        disabled={users.length === 0}
        options={[
          { value: '', label: users.length > 0 ? '—' : t('settings.bridge.ownerNone') },
          ...users.map((u) => ({ value: u.userId, label: optionLabel(u) })),
        ]}
      />

      {pendingUserId !== null && (
        <div className={`${styles['memory-confirm-overlay']} ${styles['visible']}`} onClick={(e) => { if (e.target === e.currentTarget) cancel(); }}>
          <div className={styles['memory-confirm-card']}>
            <p className={styles['memory-confirm-text']}>
              {t('settings.bridge.ownerConfirmText')}
            </p>
            <div className={styles['memory-confirm-actions']}>
              <button className={styles['memory-confirm-cancel']} onClick={cancel}>
                {t('settings.bridge.ownerConfirmCancel')}
              </button>
              <button className={styles['memory-confirm-primary']} onClick={confirm}>
                {t('settings.bridge.ownerConfirmSave')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function cleanQQOwnerDisplayName(name?: string | null) {
  const value = typeof name === 'string' ? name.trim() : '';
  if (!value) return null;
  if (value.toLowerCase() === 'user') return null;
  return value;
}

function shortOwnerId(id: string) {
  const value = String(id || '');
  if (value.length <= 8) return value;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
