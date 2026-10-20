import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSettingsStore } from '../store';
import { lucFetch } from '../api';
import { t } from '../helpers';
import { updateSettingsSnapshot } from '../actions';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import { SelectWidget, Toggle } from '@/ui';
import {
  normalizeBrowserPreferences,
  type BrowserAgentOpenBehavior,
  type BrowserPreferences,
} from '../../../../../shared/browser-preferences.ts';
import styles from '../Settings.module.css';

function browserBehaviorForControl(value: BrowserAgentOpenBehavior): 'current_tab' | 'new_tab' {
  return value === 'new_tab' ? 'new_tab' : 'current_tab';
}

export function BrowserTab() {
  const snapshotBrowser = useSettingsStore(s => s.settingsSnapshot.data?.preferences?.browser);
  const showToast = useSettingsStore(s => s.showToast);
  const [prefs, setPrefs] = useState<BrowserPreferences | null>(() => {
    const snapshot = useSettingsStore.getState().settingsSnapshot.data?.preferences?.browser;
    return snapshot ? normalizeBrowserPreferences(snapshot) : null;
  });
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    if (snapshotBrowser) {
      setPrefs(normalizeBrowserPreferences(snapshotBrowser));
      return undefined;
    }
    let alive = true;
    lucFetch('/api/preferences/browser')
      .then(res => res.json())
      .then((data) => {
        if (!alive) return;
        setPrefs(normalizeBrowserPreferences(data?.browser));
      })
      .catch((err) => {
        if (!alive) return;
        showToast(t('settings.saveFailed') + ': ' + (err?.message || String(err)), 'error');
      });
    return () => {
      alive = false;
    };
  }, [showToast, snapshotBrowser]);

  const behaviorOptions = useMemo(() => ([
    { value: 'current_tab', label: t('settings.browser.agentOpenBehaviorCurrentTab') },
    { value: 'new_tab', label: t('settings.browser.agentOpenBehaviorNewTab') },
  ]), []);

  const saveBrowserPreferences = useCallback(async (patch: Partial<BrowserPreferences>) => {
    if (!prefs) return;
    const previous = prefs;
    const next = normalizeBrowserPreferences({ ...prefs, ...patch });
    setPrefs(next);
    setSaving(true);
    try {
      const res = await lucFetch('/api/preferences/browser', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ browser: next }),
      });
      const data = await res.json();
      if (data?.error) throw new Error(data.error);
      const saved = normalizeBrowserPreferences(data?.browser);
      setPrefs(saved);
      updateSettingsSnapshot(snapshot => ({
        ...snapshot,
        preferences: { ...snapshot.preferences, browser: saved },
      }));
    } catch (err: any) {
      setPrefs(previous);
      showToast(t('settings.saveFailed') + ': ' + (err?.message || String(err)), 'error');
    } finally {
      setSaving(false);
    }
  }, [prefs, showToast]);

  const clearCookies = useCallback(async () => {
    setClearing(true);
    try {
      const res = await lucFetch('/api/preferences/browser/clear-cookies', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) throw new Error(data?.error || res.statusText || 'Failed');
      showToast(t('settings.browser.clearCookiesSuccess'), 'success');
    } catch (err: any) {
      showToast(t('settings.saveFailed') + ': ' + (err?.message || String(err)), 'error');
    } finally {
      setClearing(false);
    }
  }, [showToast]);

  const agentOpenBehavior = browserBehaviorForControl(prefs?.agentOpenBehavior || 'current_tab');

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="browser">
      <SettingsSection title={t('settings.browser.cookiesTitle')}>
        <SettingsRow
          label={t('settings.browser.acceptCookies')}
          hint={t('settings.browser.acceptCookiesHint')}
          control={
            <Toggle
              on={prefs?.acceptCookies !== false}
              onChange={(on) => void saveBrowserPreferences({ acceptCookies: on })}
              ariaLabel={t('settings.browser.acceptCookies')}
              disabled={saving || !prefs}
            />
          }
        />
        <SettingsRow
          label={t('settings.browser.clearCookies')}
          hint={t('settings.browser.clearCookiesHint')}
          control={
            <button
              type="button"
              className={styles['quick-chat-reset-button']}
              onClick={() => void clearCookies()}
              disabled={clearing}
            >
              {clearing ? t('common.loading') : t('settings.browser.clearCookiesButton')}
            </button>
          }
        />
      </SettingsSection>

      <SettingsSection title={t('settings.browser.agentTitle')}>
        <SettingsRow
          label={t('settings.browser.agentOpenBehavior')}
          hint={t('settings.browser.agentOpenBehaviorHint')}
          control={
            <SelectWidget
              options={behaviorOptions}
              value={agentOpenBehavior}
              onChange={(value) => void saveBrowserPreferences({
                agentOpenBehavior: value === 'new_tab' ? 'new_tab' : 'current_tab',
              })}
              placeholder={t('common.loading')}
              disabled={saving || !prefs}
            />
          }
        />
      </SettingsSection>
    </div>
  );
}
