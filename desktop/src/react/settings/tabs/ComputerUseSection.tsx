import { useCallback, useEffect, useMemo, useState } from 'react';
import { lucFetch } from '../api';
import { t } from '../helpers';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import { Toggle } from '@/ui';
import { useSettingsStore } from '../store';
import { updateSettingsSnapshot } from '../actions';
import styles from '../Settings.module.css';

interface ComputerProviderStatus {
  providerId: string;
  status?: {
    available?: boolean;
    reason?: string;
    error?: string;
    permissions?: Array<{ name?: string; granted?: boolean }>;
  };
}

interface ComputerUseStatusResponse {
  selectedProviderId?: string | null;
  status?: {
    enabled?: boolean;
    activeLease?: {
      leaseId?: string;
      agentId?: string | null;
      appId?: string | null;
    } | null;
    providers?: ComputerProviderStatus[];
  } | null;
  settings?: {
    enabled?: boolean;
    app_approvals?: Array<{ providerId: string; appId: string; appName?: string }>;
  };
}

function StatusText({ ok, text }: { ok: boolean; text: string }) {
  return (
    <span style={{
      color: ok ? 'var(--accent)' : 'var(--text-muted)',
      fontSize: '0.78rem',
      whiteSpace: 'nowrap',
      maxWidth: 280,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    }}>
      {text}
    </span>
  );
}

function rememberComputerUseSnapshot(data: ComputerUseStatusResponse) {
  updateSettingsSnapshot((snapshot) => ({
    ...snapshot,
    preferences: {
      ...snapshot.preferences,
      computerUse: data,
    },
  }));
}

export function ComputerUseSection() {
  const snapshotComputerUse = useSettingsStore(
    (state) => state.settingsSnapshot?.data?.preferences?.computerUse as ComputerUseStatusResponse | undefined,
  );
  const [data, setData] = useState<ComputerUseStatusResponse | null>(() => snapshotComputerUse || null);
  const [loading, setLoading] = useState(() => !snapshotComputerUse);
  const [saving, setSaving] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const showToast = useSettingsStore((state) => state.showToast);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await lucFetch('/api/preferences/computer-use');
      const body = await res.json();
      setData(body);
      rememberComputerUseSnapshot(body);
    } catch (err) {
      console.warn('[computer-use] load status failed:', err);
      const latestSnapshot = useSettingsStore.getState().settingsSnapshot?.data?.preferences?.computerUse as ComputerUseStatusResponse | undefined;
      setData(latestSnapshot || null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!snapshotComputerUse) return;
    setData(snapshotComputerUse);
    setLoading(false);
  }, [snapshotComputerUse]);

  useEffect(() => {
    load();
  }, [load]);

  const selectedProvider = useMemo(() => {
    const id = data?.selectedProviderId || null;
    return data?.status?.providers?.find((provider) => provider.providerId === id) || null;
  }, [data]);

  // data 未到位时传 undefined 给 Toggle，走加载态；加载完成后用真实 boolean。
  const enabled = data ? data.settings?.enabled === true : undefined;
  const available = selectedProvider?.status?.available === true;
  const availabilityIssue = selectedProvider?.status?.reason || selectedProvider?.status?.error || '';
  const permissions = selectedProvider?.status?.permissions || [];
  const permissionText = permissions.length > 0
    ? permissions.map((p) => `${p.name || 'permission'}:${p.granted ? 'ok' : 'missing'}`).join(' · ')
    : t('settings.computerUse.permissionsEmpty');
  const approvals = data?.settings?.app_approvals || [];
  const approvalsText = approvals.length > 0
    ? approvals.map((item) => item.appName || item.appId).join(' · ')
    : t('settings.computerUse.approvalsEmpty');
  const activeLease = data?.status?.activeLease;
  const activeLeaseText = activeLease
    ? activeLease.appId || activeLease.agentId || activeLease.leaseId || t('settings.computerUse.active')
    : t('settings.computerUse.idle');

  const saveEnabled = async (next: boolean) => {
    if (!data) return;
    setSaving(true);
    try {
      const res = await lucFetch('/api/preferences/computer-use', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { enabled: next } }),
      });
      const body = await res.json();
      const nextData = {
        ...(data || {}),
        settings: {
          ...(data?.settings || {}),
          ...(body.settings || {}),
        },
      };
      setData(nextData);
      rememberComputerUseSnapshot(nextData);
      await load();
    } catch (err: unknown) {
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    } finally {
      setSaving(false);
    }
  };

  const requestPermissions = async () => {
    setRequesting(true);
    try {
      await lucFetch('/api/preferences/computer-use/request-permissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: data?.selectedProviderId || undefined }),
      });
      await load();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      showToast(`${t('settings.computerUse.requestPermissionsFailed')}: ${message}`, 'error');
    } finally {
      setRequesting(false);
    }
  };

  const refreshButton = (
    <button
      className={styles['settings-save-btn-sm']}
      onClick={load}
      disabled={loading}
      style={{ minWidth: 72 }}
    >
      {t('settings.computerUse.refresh')}
    </button>
  );

  const permissionsButton = (
    <button
      className={styles['settings-save-btn-sm']}
      onClick={requestPermissions}
      disabled={requesting || loading}
      style={{ minWidth: 120 }}
    >
      {t('settings.computerUse.requestPermissions')}
    </button>
  );

  return (
    <SettingsSection
      title={t('settings.computerUse.title')}
      description={t('settings.computerUse.description')}
      context={refreshButton}
    >
      <SettingsSection.Warning data-testid="computer-use-experimental-warning">
        {t('settings.computerUse.experimentalWarning')}
      </SettingsSection.Warning>
      <SettingsRow
        label={t('settings.computerUse.enabled')}
        hint={t('settings.computerUse.enabledHint')}
        control={<Toggle on={enabled} onChange={(next) => saveEnabled(next)} disabled={saving} />}
      />
      <SettingsRow
        label={t('settings.computerUse.provider')}
        control={<StatusText ok={!!data?.selectedProviderId} text={data?.selectedProviderId || '-'} />}
      />
      <SettingsRow
        label={t('settings.computerUse.availability')}
        hint={availabilityIssue || undefined}
        control={<StatusText ok={available} text={available ? t('settings.computerUse.available') : t('settings.computerUse.unavailable')} />}
      />
      <SettingsRow
        label={t('settings.computerUse.permissions')}
        hint={t('settings.computerUse.permissionsHint')}
        control={permissionsButton}
      />
      <SettingsRow
        label={t('settings.computerUse.permissionsStatus')}
        control={<StatusText ok={permissions.every((p) => p.granted !== false)} text={permissionText} />}
      />
      <SettingsRow
        label={t('settings.computerUse.approvals')}
        control={<StatusText ok={approvals.length > 0} text={approvalsText} />}
      />
      <SettingsRow
        label={t('settings.computerUse.activeSession')}
        control={<StatusText ok={!activeLease} text={activeLeaseText} />}
      />
    </SettingsSection>
  );
}
