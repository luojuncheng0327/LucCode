/**
 * Bridge state management hook — loads status, saves config, tests platforms.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { useSettingsStore } from '../../store';
import { lucFetch } from '../../api';
import { loadSettingsConfig, updateSettingsSnapshot } from '../../actions';
import { t } from '../../helpers';
import type { BridgePermissionMode, KnownUser } from './BridgeWidgets';
import {
  useBridgeCredentialDrafts,
  type BridgeCredentialFieldValues,
  type StoredBridgeSecrets,
} from './useBridgeSecretDrafts';

// ── Types ──

interface PlatformStatusBase {
  status?: string;
  error?: string;
  enabled?: boolean;
  agentId?: string | null;
}

export interface TelegramStatus extends PlatformStatusBase { token?: string; hasToken?: boolean }
export type FeishuRegion = 'feishu_cn' | 'lark_global';
export interface FeishuStatus extends PlatformStatusBase { appId?: string; appSecret?: string; hasAppSecret?: boolean; region?: FeishuRegion; domain?: string | null }
export interface DingTalkStatus extends PlatformStatusBase {
  corpId?: string;
  clientId?: string;
  clientSecret?: string;
  hasClientSecret?: boolean;
  robotCode?: string;
  apiBaseUrl?: string;
  restBaseUrl?: string;
}
export interface QQStatus extends PlatformStatusBase { appID?: string; appSecret?: string; hasAppSecret?: boolean }
export interface WechatStatus extends PlatformStatusBase { token?: string }

export interface BridgeStatus {
  agentId?: string | null;
  telegram: TelegramStatus;
  feishu: FeishuStatus;
  dingtalk: DingTalkStatus;
  whatsapp: PlatformStatusBase;
  qq: QQStatus;
  wechat: WechatStatus;
  permissionMode: BridgePermissionMode;
  readOnly: boolean;
  receiptEnabled: boolean;
  richStreamingEnabled: boolean;
  knownUsers: { telegram?: KnownUser[]; feishu?: KnownUser[]; dingtalk?: KnownUser[]; whatsapp?: KnownUser[]; qq?: KnownUser[]; wechat?: KnownUser[] };
  owner: { telegram?: string; feishu?: string; dingtalk?: string; whatsapp?: string; qq?: string; wechat?: string };
}

export type BridgePlatform = 'telegram' | 'feishu' | 'dingtalk' | 'whatsapp' | 'qq' | 'wechat';

// WeChat reports `connected` only after its first long-poll succeeds. QR
// confirmation starts that handshake, so keep the settings view reconciled for
// a bounded minute without creating a permanent polling loop.
const WECHAT_STATUS_RECONCILE_INTERVAL_MS = 2_000;
const WECHAT_STATUS_RECONCILE_MAX_ATTEMPTS = 31;

function shouldReconcileWechatStatus(status: BridgeStatus | null) {
  if (!status) return true;
  const wechat = status.wechat;
  return wechat?.enabled === true
    && wechat.status !== 'connected'
    && wechat.status !== 'error';
}

function waitForWechatStatusRetry(signal: AbortSignal) {
  return new Promise<boolean>((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }

    const onAbort = () => {
      window.clearTimeout(timer);
      resolve(false);
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, WECHAT_STATUS_RECONCILE_INTERVAL_MS);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function normalizeFeishuRegion(value: unknown): FeishuRegion {
  return value === 'lark_global' ? 'lark_global' : 'feishu_cn';
}

function normalizeBridgeStatus(data: unknown): BridgeStatus | null {
  if (!data || typeof data !== 'object') return null;
  const value = data as Partial<BridgeStatus>;
  return {
    agentId: value.agentId || null,
    telegram: value.telegram || {},
    feishu: value.feishu || {},
    dingtalk: value.dingtalk || {},
    whatsapp: value.whatsapp || {},
    qq: value.qq || {},
    wechat: value.wechat || {},
    permissionMode: value.permissionMode || (value.readOnly === true ? 'read_only' : 'auto'),
    readOnly: value.readOnly === true,
    receiptEnabled: value.receiptEnabled !== false,
    richStreamingEnabled: value.richStreamingEnabled !== false,
    knownUsers: value.knownUsers || {},
    owner: value.owner || {},
  };
}

function bridgeEditableFields(status: BridgeStatus | null): BridgeCredentialFieldValues {
  return {
    feishuAppId: status?.feishu?.appId || '',
    feishuRegion: normalizeFeishuRegion(status?.feishu?.region),
    dingtalkCorpId: status?.dingtalk?.corpId || '',
    dingtalkClientId: status?.dingtalk?.clientId || '',
    dingtalkRobotCode: status?.dingtalk?.robotCode || '',
    dingtalkApiBaseUrl: status?.dingtalk?.apiBaseUrl || status?.dingtalk?.restBaseUrl || '',
    qqAppId: status?.qq?.appID || '',
  };
}

function hasStoredSecret(flag: unknown, maskedValue: unknown) {
  return typeof flag === 'boolean' ? flag : typeof maskedValue === 'string' && maskedValue.length > 0;
}

function storedBridgeSecrets(status: BridgeStatus | null): StoredBridgeSecrets {
  return {
    telegramToken: hasStoredSecret(status?.telegram?.hasToken, status?.telegram?.token),
    feishuAppSecret: hasStoredSecret(status?.feishu?.hasAppSecret, status?.feishu?.appSecret),
    dingtalkClientSecret: hasStoredSecret(status?.dingtalk?.hasClientSecret, status?.dingtalk?.clientSecret),
    qqAppSecret: hasStoredSecret(status?.qq?.hasAppSecret, status?.qq?.appSecret),
  };
}

export function useBridgeState() {
  // Atomic selectors: only re-render when these specific fields change
  const showToast = useSettingsStore(s => s.showToast);
  const currentAgentId = useSettingsStore(s => s.currentAgentId);
  const settingsSnapshot = useSettingsStore(s => s.settingsSnapshot.data);
  const snapshotBridgeStatus = settingsSnapshot?.agentId === currentAgentId
    ? normalizeBridgeStatus(settingsSnapshot.bridgeStatus)
    : null;
  const snapshotFields = bridgeEditableFields(snapshotBridgeStatus);

  // Selected agent for bridge config (independent of Agent tab selection)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(
    currentAgentId
  );
  const [statusState, setStatusState] = useState<{
    ownerId: string | null;
    value: BridgeStatus | null;
  } | null>(() => snapshotBridgeStatus ? {
    ownerId: currentAgentId,
    value: snapshotBridgeStatus,
  } : null);
  const status = statusState?.ownerId === selectedAgentId ? statusState.value : null;
  const [testingState, setTestingState] = useState<{
    ownerId: string | null;
    platform: BridgePlatform;
    requestId: number;
  } | null>(null);
  const testingPlatform = testingState?.ownerId === selectedAgentId
    ? testingState.platform
    : null;
  const [globalSettingsSaving, setGlobalSettingsSaving] = useState(false);
  const selectedAgentIdRef = useRef(selectedAgentId);
  selectedAgentIdRef.current = selectedAgentId;
  const statusRequestIdRef = useRef(0);
  const testRequestIdRef = useRef(0);
  const liveStatusOwnersRef = useRef(new Set<string>());
  const wechatStatusReconcileAbortRef = useRef<AbortController | null>(null);

  // Sync initial value when store becomes ready (only if null)
  useEffect(() => {
    if (selectedAgentId) return;
    if (currentAgentId) setSelectedAgentId(currentAgentId);
  }, [currentAgentId, selectedAgentId]);

  // AGENTS.public.md — keyed to selectedAgentId
  const initialPublicAgentsMd = settingsSnapshot?.agentId === currentAgentId ? settingsSnapshot.publicAgents || '' : '';
  const [publicAgentsMd, setPublicAgentsMd] = useState(initialPublicAgentsMd);
  const [publicAgentsMdOriginal, setPublicAgentsMdOriginal] = useState(initialPublicAgentsMd);

  const {
    drafts: secretDrafts,
    fields: credentialFields,
    setTelegramToken: setTgToken,
    setFeishuAppSecret: setFsAppSecret,
    setDingTalkClientSecret: setDtClientSecret,
    setQQAppSecret: setQqAppSecret,
    setFeishuAppId: setFsAppId,
    setFeishuRegion: setFsRegion,
    setDingTalkCorpId: setDtCorpId,
    setDingTalkClientId: setDtClientId,
    setDingTalkRobotCode: setDtRobotCode,
    setDingTalkApiBaseUrl: setDtApiBaseUrl,
    setQQAppId: setQqAppId,
    syncStoredSecrets,
    syncCredentialFields,
    captureSubmission,
    captureFieldSubmissions,
    markSubmissionSaved,
    markFieldSubmissionsSaved,
  } = useBridgeCredentialDrafts(
    selectedAgentId,
    storedBridgeSecrets(snapshotBridgeStatus),
    snapshotFields,
  );

  const applyStatus = useCallback((nextStatus: BridgeStatus | null, statusOwnerId: string | null) => {
    setStatusState({ ownerId: statusOwnerId, value: nextStatus });
    syncCredentialFields(statusOwnerId, bridgeEditableFields(nextStatus));
    syncStoredSecrets(statusOwnerId, storedBridgeSecrets(nextStatus));
  }, [syncCredentialFields, syncStoredSecrets]);

  useEffect(() => {
    if (!selectedAgentId) return;
    if (settingsSnapshot?.agentId !== selectedAgentId) return;
    if (liveStatusOwnersRef.current.has(selectedAgentId)) return;
    const nextStatus = normalizeBridgeStatus(settingsSnapshot.bridgeStatus);
    if (!nextStatus) return;
    applyStatus(nextStatus, selectedAgentId);
  }, [applyStatus, selectedAgentId, settingsSnapshot?.agentId, settingsSnapshot?.bridgeStatus]);

  // Fetch AGENTS.public.md for selected agent (abort stale requests on agent switch)
  useEffect(() => {
    if (!selectedAgentId) return;
    if (settingsSnapshot?.agentId === selectedAgentId) {
      const content = settingsSnapshot.publicAgents || '';
      setPublicAgentsMd(content);
      setPublicAgentsMdOriginal(content);
      return;
    }
    const ac = new AbortController();
    lucFetch(`/api/agents/${selectedAgentId}/public-agents-md`, { signal: ac.signal })
      .then(r => r.json())
      .then(data => { setPublicAgentsMd(data.content || ''); setPublicAgentsMdOriginal(data.content || ''); })
      .catch(err => { if (err?.name !== 'AbortError') console.warn('[bridge] fetch public-agents-md failed:', err); });
    return () => ac.abort();
  }, [selectedAgentId, settingsSnapshot]);

  const savePublicAgentsMd = async () => {
    const agentId = selectedAgentId;
    if (!agentId || publicAgentsMd === publicAgentsMdOriginal) return;
    try {
      await lucFetch(`/api/agents/${agentId}/public-agents-md`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: publicAgentsMd }),
      });
      updateSettingsSnapshot(snapshot => (
        snapshot.agentId === agentId ? { ...snapshot, publicAgents: publicAgentsMd } : snapshot
      ));
      setPublicAgentsMdOriginal(publicAgentsMd);
      showToast(t('settings.saved'), 'success');
    } catch (err: unknown) {
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  };

  const fetchStatusForAgent = useCallback(async (
    agentId: string | null,
    signal?: AbortSignal,
  ): Promise<BridgeStatus | null> => {
    // The status endpoint answers for one named agent. Without an id there is
    // no answer to ask for, so skip the request instead of sending one that
    // would be resolved on the server's terms.
    if (!agentId) return null;
    const requestId = ++statusRequestIdRef.current;
    try {
      const res = await lucFetch(`/api/bridge/status?agentId=${encodeURIComponent(agentId)}`, signal ? { signal } : undefined);
      const data = await res.json();
      if (
        signal?.aborted
        || requestId !== statusRequestIdRef.current
        || selectedAgentIdRef.current !== agentId
      ) return null;
      const nextStatus = normalizeBridgeStatus(data);
      if (agentId && nextStatus?.agentId && nextStatus.agentId !== agentId) {
        console.warn('[bridge] ignored status owned by another agent:', nextStatus.agentId);
        return null;
      }
      if (agentId) liveStatusOwnersRef.current.add(agentId);
      applyStatus(nextStatus, agentId);
      return nextStatus;
    } catch (err) {
      if (
        (err as Error)?.name === 'AbortError'
        || requestId !== statusRequestIdRef.current
      ) return null;
      console.error('[bridge] load status failed:', err);
      return null;
    }
  }, [applyStatus]); // explicit agentId keeps request ownership stable across selection changes

  const loadStatus = useCallback(async (signal?: AbortSignal) => {
    await fetchStatusForAgent(selectedAgentIdRef.current, signal);
  }, [fetchStatusForAgent]);

  const reconcileWechatStatus = useCallback(async (
    agentId: string,
    signal: AbortSignal,
  ) => {
    for (let attempt = 0; attempt < WECHAT_STATUS_RECONCILE_MAX_ATTEMPTS; attempt += 1) {
      if (signal.aborted || selectedAgentIdRef.current !== agentId) return;
      const nextStatus = await fetchStatusForAgent(agentId, signal);
      if (
        signal.aborted
        || selectedAgentIdRef.current !== agentId
        || !shouldReconcileWechatStatus(nextStatus)
        || attempt === WECHAT_STATUS_RECONCILE_MAX_ATTEMPTS - 1
      ) return;
      if (!await waitForWechatStatusRetry(signal)) return;
    }
  }, [fetchStatusForAgent]);

  // Auto-fetch when selectedAgentId changes (abort stale on switch)
  useEffect(() => {
    if (!selectedAgentId) return;
    if (settingsSnapshot?.agentId !== selectedAgentId) {
      applyStatus(null, selectedAgentId);
    }
    const ac = new AbortController();
    loadStatus(ac.signal);
    return () => ac.abort();
  }, [applyStatus, selectedAgentId, loadStatus, settingsSnapshot?.agentId]);

  // Reconciliation belongs to the selected Agent. Switching Agent or unmounting
  // cancels both the wait timer and any in-flight request.
  useEffect(() => () => {
    wechatStatusReconcileAbortRef.current?.abort();
    wechatStatusReconcileAbortRef.current = null;
  }, [selectedAgentId]);

  useEffect(() => {
    const handler = () => {
      const agentId = selectedAgentIdRef.current;
      if (!agentId) return;

      wechatStatusReconcileAbortRef.current?.abort();
      const ac = new AbortController();
      wechatStatusReconcileAbortRef.current = ac;
      void reconcileWechatStatus(agentId, ac.signal).finally(() => {
        if (wechatStatusReconcileAbortRef.current === ac) {
          wechatStatusReconcileAbortRef.current = null;
        }
      });
    };
    window.addEventListener('luc-bridge-reload', handler);
    return () => window.removeEventListener('luc-bridge-reload', handler);
  }, [reconcileWechatStatus]);

  const saveBridgeConfig = async (plat: string, credentials: Record<string, string> | null, enabled?: boolean) => {
    // Snapshot agentId at call time to avoid stale closure
    const agentId = selectedAgentId;
    const secretSubmission = captureSubmission(plat, credentials);
    const fieldSubmissions = captureFieldSubmissions(plat, credentials);
    try {
      const agentQuery = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
      await lucFetch(`/api/bridge/config${agentQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: plat, credentials, enabled }),
      });
      markSubmissionSaved(secretSubmission);
      markFieldSubmissionsSaved(fieldSubmissions);
      showToast(t('settings.saved'), 'success');
      // Only reload if user hasn't switched agent during the save (read latest from ref)
      if (selectedAgentIdRef.current === agentId) await loadStatus();
    } catch (err: unknown) {
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  };

  const testPlatform = async (
    plat: BridgePlatform,
    credentials: Record<string, string>,
    useSavedCredentials = false,
  ) => {
    const agentId = selectedAgentId;
    const requestId = ++testRequestIdRef.current;
    setTestingState({ ownerId: agentId, platform: plat, requestId });
    const isCurrentTest = () => (
      testRequestIdRef.current === requestId
      && selectedAgentIdRef.current === agentId
    );
    try {
      const agentQuery = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
      const res = await lucFetch(`/api/bridge/test${agentQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: plat, credentials, useSavedCredentials }),
      });
      const data = await res.json();
      if (!isCurrentTest()) return;
      if (data.ok) {
        const info = plat === 'telegram' ? ` @${data.info?.username || ''}` : '';
        const successText = plat === 'dingtalk' && data.info?.stream?.status === 'not_tested'
          ? t('settings.bridge.dingtalkCredentialTestOk')
          : t('settings.bridge.testOk') + info;
        showToast(successText, 'success');
      } else {
        showToast(t('settings.bridge.testFail') + ': ' + (data.error || ''), 'error');
      }
    } catch (err: unknown) {
      if (isCurrentTest()) {
        showToast(t('settings.bridge.testFail') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
      }
    } finally {
      setTestingState(previous => (
        previous?.requestId === requestId && previous.ownerId === agentId
          ? null
          : previous
      ));
    }
  };

  const setOwner = async (plat: string, userId: string) => {
    const agentId = selectedAgentId;
    try {
      const agentQuery = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
      const res = await lucFetch(`/api/bridge/owner${agentQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: plat, userId: userId || null }),
      });
      const data = await res.json().catch(() => null);
      if (selectedAgentIdRef.current === agentId) {
        const nextStatus = normalizeBridgeStatus(data?.status);
        if (nextStatus) {
          if (agentId) liveStatusOwnersRef.current.add(agentId);
          applyStatus(nextStatus, agentId);
        }
        else await loadStatus();
      }
      showToast(t('settings.bridge.ownerSaved'), 'success');
    } catch {
      showToast(t('settings.saveFailed'), 'error');
    }
  };

  const saveGlobalSettings = async (partial: { permissionMode?: BridgePermissionMode; readOnly?: boolean; receiptEnabled?: boolean; richStreamingEnabled?: boolean }) => {
    setGlobalSettingsSaving(true);
    try {
      const res = await lucFetch('/api/bridge/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(partial),
      });
      const saved = await res.json();
      if (saved.error) throw new Error(saved.error);
      if (typeof saved.permissionMode === 'string' && typeof saved.readOnly === 'boolean' && typeof saved.receiptEnabled === 'boolean' && typeof saved.richStreamingEnabled === 'boolean') {
        setStatusState(prev => prev?.ownerId === selectedAgentId && prev.value ? {
          ownerId: prev.ownerId,
          value: {
            ...prev.value,
            permissionMode: saved.permissionMode,
            readOnly: saved.readOnly,
            receiptEnabled: saved.receiptEnabled,
            richStreamingEnabled: saved.richStreamingEnabled,
          },
        } : prev);
      }
      showToast(t('settings.saved'), 'success');
      await Promise.all([
        loadStatus(),
        loadSettingsConfig(),
      ]);
    } catch (err: unknown) {
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    } finally {
      setGlobalSettingsSaving(false);
    }
  };

  return {
    status, testingPlatform, globalSettingsSaving, showToast, loadStatus,
    selectedAgentId, setSelectedAgentId,
    publicAgentsMd, setPublicAgentsMd, savePublicAgentsMd,
    tgToken: secretDrafts.telegramToken.value,
    tgTokenDraft: secretDrafts.telegramToken,
    setTgToken,
    fsAppId: credentialFields.feishuAppId.value, setFsAppId,
    fsAppSecret: secretDrafts.feishuAppSecret.value,
    fsAppSecretDraft: secretDrafts.feishuAppSecret,
    setFsAppSecret, fsRegion: credentialFields.feishuRegion.value as FeishuRegion, setFsRegion,
    dtCorpId: credentialFields.dingtalkCorpId.value, setDtCorpId,
    dtClientId: credentialFields.dingtalkClientId.value, setDtClientId,
    dtClientSecret: secretDrafts.dingtalkClientSecret.value,
    dtClientSecretDraft: secretDrafts.dingtalkClientSecret,
    setDtClientSecret,
    dtRobotCode: credentialFields.dingtalkRobotCode.value, setDtRobotCode,
    dtApiBaseUrl: credentialFields.dingtalkApiBaseUrl.value, setDtApiBaseUrl,
    qqAppId: credentialFields.qqAppId.value, setQqAppId,
    qqAppSecret: secretDrafts.qqAppSecret.value,
    qqAppSecretDraft: secretDrafts.qqAppSecret,
    setQqAppSecret,
    saveBridgeConfig, testPlatform, setOwner, saveGlobalSettings,
  };
}
