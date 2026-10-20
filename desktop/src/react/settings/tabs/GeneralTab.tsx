import React, { useCallback, useEffect, useState } from 'react';
import { useSettingsStore } from '../store';
import { lucFetch } from '../api';
import { autoSaveConfig, t } from '../helpers';
import { loadSettingsConfig, updateSettingsSnapshot } from '../actions';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import { SelectWidget, Toggle } from '@/ui';
import { readConfigBoolean } from '../resource-state';
import type { AutoLaunchStatus } from '../../types';
import {
  normalizeNotificationPreferences as normalizeSharedNotificationPreferences,
  normalizeBackgroundCompletionNotificationMode,
  normalizeChatCompletionNotificationMode,
} from '../../../../../shared/notification-preferences.ts';
import {
  DEFAULT_QUICK_CHAT_REUSE_TIMEOUT_MINUTES,
  DEFAULT_QUICK_CHAT_SHORTCUT,
  normalizeQuickChatPreferences,
} from '../../../../../shared/quick-chat-preferences.ts';
import styles from '../Settings.module.css';

type ChatCompletionNotificationMode = 'never' | 'when_unfocused' | 'when_session_unfocused';
type BackgroundCompletionNotificationMode = 'never' | 'when_unfocused' | 'always';

interface NotificationPreferences {
  chatCompletion: ChatCompletionNotificationMode;
  scheduledTaskCompletion: BackgroundCompletionNotificationMode;
  patrolCompletion: BackgroundCompletionNotificationMode;
}

interface QuickChatPreferences {
  shortcut: string;
  reuseTimeoutMinutes: number;
}

function formatShortcut(shortcut: string): string[] {
  return String(shortcut || DEFAULT_QUICK_CHAT_SHORTCUT)
    .split('+')
    .map(part => part.trim())
    .filter(Boolean);
}

function keyLabel(key: string): string {
  if (key === 'CommandOrControl') return navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl';
  if (key === 'Control') return 'Ctrl';
  if (key === 'Alt') return navigator.platform.toLowerCase().includes('mac') ? '⌥' : 'Alt';
  if (key === 'Shift') return 'Shift';
  if (key === 'Space') return 'Space';
  return key.length === 1 ? key.toUpperCase() : key;
}

function keyFromEvent(event: KeyboardEvent): string | null {
  if (event.key === 'Escape') return null;
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return null;

  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push('CommandOrControl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');

  const rawKey = keyTokenFromKeyboardEvent(event);
  if (!rawKey) return null;
  const key = rawKey.length === 1 ? rawKey.toUpperCase() : rawKey;
  const isFunctionKey = /^F([1-9]|1[0-9]|2[0-4])$/.test(key);
  if (parts.length === 0 && !isFunctionKey) return null;
  parts.push(key);
  return parts.join('+');
}

function keyTokenFromKeyboardEvent(event: KeyboardEvent): string | null {
  if (event.code === 'Space' || event.key === ' ' || event.key === '\u00A0' || event.key === 'Spacebar') {
    return 'Space';
  }
  const keyMap: Record<string, string> = {
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Enter: 'Enter',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Delete: 'Delete',
  };
  if (keyMap[event.code]) return keyMap[event.code];
  if (keyMap[event.key]) return keyMap[event.key];
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3);
  if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(event.code)) return event.code;
  const key = event.key || '';
  return key.length === 1 ? key : key || null;
}

function ShortcutKeycaps({ shortcut }: { shortcut: string }) {
  return (
    <span className={styles['shortcut-keycaps']}>
      {formatShortcut(shortcut).map((part) => (
        <span key={part} className={styles['shortcut-keycap']}>{keyLabel(part)}</span>
      ))}
    </span>
  );
}

function ShortcutRecorder({
  value,
  loading,
  recording,
  saving,
  onStart,
  onRestoreDefault,
}: {
  value: string;
  loading?: boolean;
  recording: boolean;
  saving: boolean;
  onStart: () => void;
  onRestoreDefault: () => void;
}) {
  return (
    <div className={styles['quick-chat-shortcut-control']}>
      <button
        type="button"
        className={`${styles['quick-chat-shortcut-button']} ${recording ? styles['recording'] : ''}`}
        aria-label={t('settings.general.quickChat.shortcut')}
        onClick={onStart}
        disabled={saving || loading}
      >
        {recording ? t('settings.general.quickChat.recording') : loading ? t('common.loading') : <ShortcutKeycaps shortcut={value} />}
      </button>
      <button
        type="button"
        className={styles['quick-chat-reset-button']}
        onClick={onRestoreDefault}
        disabled={saving || loading || value === DEFAULT_QUICK_CHAT_SHORTCUT}
      >
        {t('settings.general.quickChat.restoreDefault')}
      </button>
    </div>
  );
}

function ReuseTimeoutInput({
  value,
  saving,
  onChange,
}: {
  value: number | null;
  saving: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div className={styles['quick-chat-timeout-control']}>
      <input
        className={styles['quick-chat-timeout-input']}
        type="number"
        min={0}
        max={120}
        step={1}
        inputMode="numeric"
        aria-label={t('settings.general.quickChat.reuseTimeout')}
        value={typeof value === 'number' && Number.isFinite(value) ? value : ''}
        disabled={saving}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
      <span className={styles['quick-chat-timeout-unit']}>{t('settings.general.quickChat.minutes')}</span>
    </div>
  );
}

function normalizeChatCompletionMode(value: unknown): ChatCompletionNotificationMode {
  return normalizeChatCompletionNotificationMode(value) as ChatCompletionNotificationMode;
}

function normalizeBackgroundCompletionMode(value: unknown): BackgroundCompletionNotificationMode {
  return normalizeBackgroundCompletionNotificationMode(value) as BackgroundCompletionNotificationMode;
}

function normalizeNotificationPreferences(value: unknown): NotificationPreferences {
  return normalizeSharedNotificationPreferences(value) as NotificationPreferences;
}

export function GeneralTab() {
  const luc = window.luc;
  const settingsConfig = useSettingsStore(s => s.settingsConfig);
  const snapshotQuickChat = useSettingsStore(s => s.settingsSnapshot.data?.preferences?.quickChat);
  const snapshotNotifications = useSettingsStore(s => s.settingsSnapshot.data?.preferences?.notifications);
  const showToast = useSettingsStore(s => s.showToast);
  const [autoLaunch, setAutoLaunch] = useState<AutoLaunchStatus | null>(null);
  const [autoLaunchSaving, setAutoLaunchSaving] = useState(false);
  const [keepAwakeSaving, setKeepAwakeSaving] = useState(false);
  const [quickChatPrefs, setQuickChatPrefs] = useState<QuickChatPreferences | null>(() => {
    const snapshot = useSettingsStore.getState().settingsSnapshot.data?.preferences?.quickChat;
    return snapshot ? normalizeQuickChatPreferences(snapshot) : null;
  });
  const [quickChatSaving, setQuickChatSaving] = useState(false);
  const [quickChatRecording, setQuickChatRecording] = useState(false);
  const [notificationSaving, setNotificationSaving] = useState(false);
  const [notificationPrefs, setNotificationPrefs] = useState<NotificationPreferences | null>(() => {
    const snapshot = useSettingsStore.getState().settingsSnapshot.data?.preferences?.notifications;
    return snapshot ? normalizeNotificationPreferences(snapshot) : null;
  });
  const keepAwake = readConfigBoolean(settingsConfig, cfg => cfg.keep_awake, false);

  useEffect(() => {
    let alive = true;
    luc?.getAutoLaunchStatus?.()
      .then((status) => {
        if (alive && status) setAutoLaunch(status);
      })
      .catch(() => {
        if (alive) setAutoLaunch(null);
      });
    return () => {
      alive = false;
    };
  }, [luc]);

  useEffect(() => {
    if (snapshotQuickChat) {
      setQuickChatPrefs(normalizeQuickChatPreferences(snapshotQuickChat));
      return undefined;
    }
    let alive = true;
    lucFetch('/api/preferences/quick-chat')
      .then(res => res.json())
      .then((data) => {
        if (!alive) return;
        setQuickChatPrefs(normalizeQuickChatPreferences(data?.quickChat));
      })
      .catch((err) => {
        if (!alive) return;
        showToast(t('settings.saveFailed') + ': ' + (err?.message || String(err)), 'error');
      });
    return () => {
      alive = false;
    };
  }, [showToast, snapshotQuickChat]);

  useEffect(() => {
    if (snapshotNotifications) {
      setNotificationPrefs(normalizeNotificationPreferences(snapshotNotifications));
      return undefined;
    }
    let alive = true;
    lucFetch('/api/preferences/notifications')
      .then(res => res.json())
      .then((data) => {
        if (!alive) return;
        setNotificationPrefs(normalizeNotificationPreferences(data?.notifications));
      })
      .catch((err) => {
        if (!alive) return;
        showToast(t('settings.saveFailed') + ': ' + (err?.message || String(err)), 'error');
      });
    return () => {
      alive = false;
    };
  }, [showToast, snapshotNotifications]);

  const saveQuickChatPreferences = useCallback(async (
    patch: Partial<QuickChatPreferences>,
    options: { reloadShortcut?: boolean; eventName?: string } = {},
  ) => {
    if (!quickChatPrefs) return;
    const previous = quickChatPrefs;
    const next = normalizeQuickChatPreferences({ ...quickChatPrefs, ...patch });
    setQuickChatPrefs(next);
    setQuickChatSaving(true);
    try {
      const res = await lucFetch('/api/preferences/quick-chat', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quickChat: next }),
      });
      const data = await res.json();
      if (data?.error) throw new Error(data.error);
      const saved = normalizeQuickChatPreferences(data?.quickChat);
      setQuickChatPrefs(saved);
      updateSettingsSnapshot(snapshot => ({
        ...snapshot,
        preferences: { ...snapshot.preferences, quickChat: saved },
      }));
      if (options.reloadShortcut) {
        const registration = await luc?.quickChatReloadShortcut?.();
        if (registration && registration.ok === false) {
          throw new Error(registration.error || t('settings.general.quickChat.registrationFailed'));
        }
      }
      if (options.eventName) luc?.settingsChanged?.(options.eventName, { quickChat: saved });
    } catch (err: any) {
      setQuickChatPrefs(previous);
      try {
        await lucFetch('/api/preferences/quick-chat', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ quickChat: previous }),
        });
        if (options.reloadShortcut) await luc?.quickChatReloadShortcut?.();
      } catch {}
      showToast(t('settings.saveFailed') + ': ' + (err?.message || String(err)), 'error');
    } finally {
      setQuickChatSaving(false);
    }
  }, [luc, quickChatPrefs, showToast]);

  const saveQuickChatShortcut = useCallback((shortcut: string) => saveQuickChatPreferences(
    { shortcut },
    { reloadShortcut: true, eventName: 'quick-chat-shortcut-changed' },
  ), [saveQuickChatPreferences]);

  const saveQuickChatReuseTimeout = useCallback((reuseTimeoutMinutes: number) => saveQuickChatPreferences(
    { reuseTimeoutMinutes },
    { eventName: 'quick-chat-preferences-changed' },
  ), [saveQuickChatPreferences]);

  useEffect(() => {
    if (!quickChatRecording) return undefined;
    const handler = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        setQuickChatRecording(false);
        return;
      }
      const shortcut = keyFromEvent(event);
      if (!shortcut) return;
      setQuickChatRecording(false);
      void saveQuickChatShortcut(shortcut);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [quickChatRecording, saveQuickChatShortcut]);

  const handleAutoLaunchToggle = useCallback(async (on: boolean) => {
    if (!luc?.setAutoLaunchEnabled) return;
    const previous = autoLaunch;
    setAutoLaunchSaving(true);
    try {
      const next = await luc.setAutoLaunchEnabled(on);
      setAutoLaunch(next || previous);
    } catch {
      setAutoLaunch(previous);
    } finally {
      setAutoLaunchSaving(false);
    }
  }, [autoLaunch, luc]);

  const handleKeepAwakeToggle = useCallback(async (on: boolean) => {
    if (!luc?.setKeepAwakeEnabled) return;
    const previous = keepAwake === true;
    setKeepAwakeSaving(true);
    try {
      const saved = await autoSaveConfig({ keep_awake: on }, { silent: true });
      if (saved === false) return;
      await luc.setKeepAwakeEnabled(on);
    } catch (err: any) {
      if (previous !== on) {
        await autoSaveConfig({ keep_awake: previous }, { silent: true });
        await loadSettingsConfig();
      }
      showToast(t('settings.saveFailed') + ': ' + (err?.message || String(err)), 'error');
    } finally {
      setKeepAwakeSaving(false);
    }
  }, [luc, keepAwake, showToast]);

  const saveNotificationPreference = useCallback(async (
    key: keyof NotificationPreferences,
    value: string,
  ) => {
    if (!notificationPrefs) return;
    const previous = notificationPrefs;
    const next = {
      ...notificationPrefs,
      [key]: key === 'chatCompletion'
        ? normalizeChatCompletionMode(value)
        : normalizeBackgroundCompletionMode(value),
    };
    setNotificationPrefs(next);
    setNotificationSaving(true);
    try {
      const res = await lucFetch('/api/preferences/notifications', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notifications: { [key]: next[key] } }),
      });
      const data = await res.json();
      if (data?.error) throw new Error(data.error);
      const saved = normalizeNotificationPreferences(data?.notifications);
      setNotificationPrefs(saved);
      updateSettingsSnapshot(snapshot => ({
        ...snapshot,
        preferences: { ...snapshot.preferences, notifications: saved },
      }));
    } catch (err: any) {
      setNotificationPrefs(previous);
      showToast(t('settings.saveFailed') + ': ' + (err?.message || String(err)), 'error');
    } finally {
      setNotificationSaving(false);
    }
  }, [notificationPrefs, showToast]);

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="general">
      <SettingsSection title={t('settings.general.startup.title')}>
        {autoLaunch?.supported && (
          <SettingsRow
            label={t('settings.general.launchAtLogin')}
            control={
              <Toggle
                on={autoLaunch.openAtLogin}
                onChange={handleAutoLaunchToggle}
                ariaLabel={t('settings.general.launchAtLogin')}
                disabled={autoLaunchSaving}
              />
            }
          />
        )}
        <SettingsRow
          label={t('settings.general.keepAwake')}
          control={
            <Toggle
              on={keepAwake}
              onChange={handleKeepAwakeToggle}
              ariaLabel={t('settings.general.keepAwake')}
              disabled={keepAwakeSaving || !luc?.setKeepAwakeEnabled}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title={t('settings.general.quickChat.title')}>
        <SettingsRow
          label={t('settings.general.quickChat.shortcut')}
          hint={t('settings.general.quickChat.shortcutHint')}
          control={
            <ShortcutRecorder
              value={quickChatPrefs?.shortcut || ''}
              loading={!quickChatPrefs}
              recording={quickChatRecording}
              saving={quickChatSaving || !quickChatPrefs}
              onStart={() => setQuickChatRecording(true)}
              onRestoreDefault={() => void saveQuickChatShortcut(DEFAULT_QUICK_CHAT_SHORTCUT)}
            />
          }
        />
        <SettingsRow
          label={t('settings.general.quickChat.reuseTimeout')}
          hint={t('settings.general.quickChat.reuseTimeoutHint')}
          control={
            <ReuseTimeoutInput
              value={quickChatPrefs?.reuseTimeoutMinutes ?? null}
              saving={quickChatSaving || !quickChatPrefs}
              onChange={(value) => void saveQuickChatReuseTimeout(value)}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title={t('settings.general.notifications.title')}>
        <SettingsRow
          data-testid="chat-completion-notification-row"
          label={t('settings.general.notifications.chatCompletion')}
          control={
            <SelectWidget
              options={[
                { value: 'never', label: t('settings.general.notifications.never') },
                { value: 'when_unfocused', label: t('settings.general.notifications.whenUnfocused') },
                { value: 'when_session_unfocused', label: t('settings.general.notifications.whenSessionUnfocused') },
              ]}
              value={notificationPrefs?.chatCompletion || ''}
              onChange={(value) => void saveNotificationPreference('chatCompletion', value)}
              placeholder={t('common.loading')}
              disabled={notificationSaving || !notificationPrefs}
            />
          }
        />
        <SettingsRow
          data-testid="scheduled-task-completion-notification-row"
          label={t('settings.general.notifications.scheduledTaskCompletion')}
          control={
            <SelectWidget
              options={[
                { value: 'never', label: t('settings.general.notifications.never') },
                { value: 'when_unfocused', label: t('settings.general.notifications.whenUnfocused') },
                { value: 'always', label: t('settings.general.notifications.always') },
              ]}
              value={notificationPrefs?.scheduledTaskCompletion || ''}
              onChange={(value) => void saveNotificationPreference('scheduledTaskCompletion', value)}
              placeholder={t('common.loading')}
              disabled={notificationSaving || !notificationPrefs}
            />
          }
        />
        <SettingsRow
          data-testid="patrol-completion-notification-row"
          label={t('settings.general.notifications.patrolCompletion')}
          control={
            <SelectWidget
              options={[
                { value: 'never', label: t('settings.general.notifications.never') },
                { value: 'when_unfocused', label: t('settings.general.notifications.whenUnfocused') },
                { value: 'always', label: t('settings.general.notifications.always') },
              ]}
              value={notificationPrefs?.patrolCompletion || ''}
              onChange={(value) => void saveNotificationPreference('patrolCompletion', value)}
              placeholder={t('common.loading')}
              disabled={notificationSaving || !notificationPrefs}
            />
          }
        />
      </SettingsSection>
    </div>
  );
}
