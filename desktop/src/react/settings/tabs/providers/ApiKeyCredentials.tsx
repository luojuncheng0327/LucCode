import React, { useState, useEffect, useRef } from 'react';
import { useSettingsStore, type ProviderSummary } from '../../store';
import { lucFetch } from '../../api';
import { invalidateConfigCache } from '../../../hooks/use-config';
import { t, API_FORMAT_OPTIONS } from '../../helpers';
import { SelectWidget } from '@/ui';
import { KeyInput } from '../../widgets/KeyInput';
import { getApiKeySavePlan } from './api-key-save-plan';
import { parseProviderHeaderLines, ProviderHeadersField, serializeProviderHeaders } from './ProviderHeadersField';
import { isMaskedSecretValue } from '../../../../../../shared/secret-custody.ts';
import styles from '../../Settings.module.css';

interface DiscoveredProviderModel {
  id?: unknown;
  name?: unknown;
  context?: unknown;
  maxOutput?: unknown;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function saveProviderConfigPatch(providerId: string, patch: Record<string, unknown>): Promise<void> {
  const res = await lucFetch('/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providers: { [providerId]: patch } }),
  });
  const data: unknown = await res.json();
  if (
    data
    && typeof data === 'object'
    && 'error' in data
    && typeof data.error === 'string'
    && data.error.trim()
  ) {
    throw new Error(data.error.trim());
  }
  invalidateConfigCache();
}

function shouldDiscoverModelsBeforeSave(providerId: string, api: string, payload: Record<string, unknown>) {
  return payload.seed_default_models === true
    && (providerId === 'gemini' || api === 'google-generative-ai');
}

function compactDiscoveredModel(model: DiscoveredProviderModel): string | Record<string, unknown> | null {
  if (typeof model.id !== 'string' || !model.id.trim()) return null;
  const entry: Record<string, unknown> = { id: model.id };
  if (typeof model.name === 'string' && model.name.trim()) entry.name = model.name;
  if (typeof model.context === 'number' && Number.isFinite(model.context)) entry.context = model.context;
  if (typeof model.maxOutput === 'number' && Number.isFinite(model.maxOutput)) entry.maxOutput = model.maxOutput;
  return Object.keys(entry).length === 1 ? model.id : entry;
}

async function resolveModelsForInitialSave(
  providerId: string,
  plan: ReturnType<typeof getApiKeySavePlan>,
  headers: Record<string, string>,
  includeHeaders: boolean,
): Promise<Record<string, unknown>> {
  const payload = { ...plan.payload };
  if (includeHeaders) payload.headers = headers;
  if (!shouldDiscoverModelsBeforeSave(providerId, plan.api, payload)) return payload;

  try {
    const res = await lucFetch('/api/providers/fetch-models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: providerId,
        base_url: plan.effectiveUrl,
        api: plan.api,
        api_key: plan.key,
        headers,
      }),
    });
    const data = await res.json();
    const models = Array.isArray(data.models)
      ? data.models.map(compactDiscoveredModel).filter(Boolean)
      : [];
    if (!data.error && models.length > 0) {
      payload.models = models;
      delete payload.seed_default_models;
    }
  } catch {
    // Keep seed_default_models as the explicit static fallback for initial setup.
  }

  return payload;
}

export function ApiKeyCredentials({ providerId, summary, providerConfig: _providerConfig, isPresetSetup, presetInfo, onRefresh }: {
  providerId: string;
  summary: ProviderSummary;
  providerConfig?: Record<string, unknown>;
  isPresetSetup?: boolean;
  presetInfo?: { label: string; value: string; url?: string; api?: string; local?: boolean };
  onRefresh: () => Promise<void>;
}) {
  const showToast = useSettingsStore(s => s.showToast);
  const [keyVal, setKeyVal] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const derivedBaseUrl = summary.base_url || presetInfo?.url || '';
  const [urlVal, setUrlVal] = useState(derivedBaseUrl);
  const [urlEdited, setUrlEdited] = useState(false);
  const [headersText, setHeadersText] = useState('');
  const [headersEdited, setHeadersEdited] = useState(false);
  const derivedApi = summary.api || presetInfo?.api || '';
  const [apiVal, setApiVal] = useState(derivedApi);
  const [apiEdited, setApiEdited] = useState(false);
  const apiDraftRevision = useRef(0);

  // 未编辑时，从 summary 同步已保存的 key 到输入框
  useEffect(() => {
    if (!keyEdited) {
      setKeyVal(summary.api_key || '');
    }
  }, [summary.api_key, keyEdited]);

  // 未编辑时，从 summary 同步 base_url
  useEffect(() => {
    if (!urlEdited) setUrlVal(derivedBaseUrl);
  }, [derivedBaseUrl, urlEdited]);

  useEffect(() => {
    if (!headersEdited) setHeadersText(serializeProviderHeaders(summary.headers || {}));
  }, [summary.headers, headersEdited]);

  useEffect(() => {
    if (!apiEdited) {
      setApiVal(derivedApi);
      return;
    }
    if (summary.api === apiVal) setApiEdited(false);
  }, [apiEdited, apiVal, derivedApi, summary.api]);

  const refreshAfterSave = async (shouldReportFailure: () => boolean = () => true): Promise<boolean> => {
    try {
      await onRefresh();
      return true;
    } catch (err: unknown) {
      if (shouldReportFailure()) {
        showToast(t('settings.refreshFailed') + ': ' + errorMessage(err), 'error');
      }
      return false;
    }
  };

  const reportSaveFailure = (err: unknown) => {
    showToast(t('settings.saveFailed') + ': ' + errorMessage(err), 'error');
  };

  const parseHeaders = (): Record<string, string> | null => {
    try {
      return parseProviderHeaderLines(headersText);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(msg, 'error');
      return null;
    }
  };

  const saveApiKeyConfig = async ({
    verify,
    button,
  }: {
    verify: boolean;
    button?: HTMLButtonElement;
  }) => {
    const plan = getApiKeySavePlan({
      keyEdited,
      keyVal,
      urlEdited,
      urlVal,
      derivedBaseUrl,
      isPresetSetup: !!isPresetSetup,
      isLocalPreset: !!presetInfo?.local,
      seedDefaultModels: !!presetInfo && (summary.models?.length ?? 0) === 0,
      api: apiVal,
    });
    if (!plan.shouldSave) return;
    button?.classList.add(styles['spinning']);
    try {
      const headers = parseHeaders();
      if (!headers) return;
      const includeHeaders = headersEdited || Object.keys(headers).length > 0;
      if (verify && plan.shouldVerify) {
        const testRes = await lucFetch('/api/providers/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: providerId, base_url: plan.effectiveUrl, api: plan.api, api_key: plan.key, headers }),
        });
        const testData = await testRes.json();
        if (!testData.ok) {
          showToast(t('settings.providers.verifyFailed'), 'error');
          return;
        }
      }
      const payload = await resolveModelsForInitialSave(providerId, plan, headers, includeHeaders);
      await saveProviderConfigPatch(providerId, payload);
      if (isPresetSetup) useSettingsStore.setState({ selectedProviderId: providerId });
      if (!await refreshAfterSave()) return;
      showToast(plan.shouldVerify ? t('settings.providers.verifySuccess') : t('settings.saved'), 'success');
      setKeyEdited(false);
      if (urlEdited) setUrlEdited(false);
      if (headersEdited) setHeadersEdited(false);
    } catch (err: unknown) {
      reportSaveFailure(err);
    } finally {
      button?.classList.remove(styles['spinning']);
    }
  };

  const [connStatus, setConnStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');

  const revealSavedApiKey = async () => {
    const res = await lucFetch(`/api/providers/${encodeURIComponent(providerId)}/api-key`);
    const data = await res.json();
    return typeof data.api_key === 'string' ? data.api_key : '';
  };

  const verifyOnly = async (btn: HTMLButtonElement) => {
    setConnStatus('testing');
    btn.classList.add(styles['spinning']);
    try {
      const headers = parseHeaders();
      if (!headers) return;
      const testRes = await lucFetch('/api/providers/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: providerId,
          base_url: urlVal.trim() || derivedBaseUrl,
          api: apiVal,
          api_key: isMaskedSecretValue(keyVal) ? undefined : keyVal.trim() || undefined,
          headers,
        }),
      });
      const testData = await testRes.json();
      setConnStatus(testData.ok ? 'ok' : 'fail');
      const detail = typeof testData.error === 'string' && testData.error.trim()
        ? ': ' + testData.error.trim()
        : '';
      showToast(testData.ok ? t('settings.providers.verifySuccess') : t('settings.providers.verifyFailed') + detail, testData.ok ? 'success' : 'error');
    } catch (err: unknown) {
      setConnStatus('fail');
      showToast(t('settings.providers.verifyFailed') + ': ' + errorMessage(err), 'error');
    } finally {
      btn.classList.remove(styles['spinning']);
    }
  };

  return (
    <div className={styles['pv-credentials']}>
      <div className={styles['pv-cred-row']}>
        <span className={styles['pv-cred-label']}>{t('settings.api.apiKey')}</span>
        <div className={styles['pv-cred-key-row']}>
          <KeyInput
            value={keyVal}
            onChange={(v) => { setKeyVal(v); setKeyEdited(true); setConnStatus('idle'); }}
            onBlur={() => {
              if (!keyEdited || isPresetSetup) return;
              void saveApiKeyConfig({ verify: false });
            }}
            onReveal={isMaskedSecretValue(keyVal) ? revealSavedApiKey : undefined}
            onRevealError={(err) => {
              const msg = err instanceof Error ? err.message : String(err);
              showToast(msg, 'error');
            }}
            placeholder={isPresetSetup ? t('settings.providers.setupHint') : ''}
          />
          <button
            className={`${styles['pv-cred-conn-icon']} ${styles[connStatus] || ''}`}
            title={t('settings.providers.verifyConnection')}
            onClick={(e) => {
              if (keyEdited) {
                void saveApiKeyConfig({ verify: true, button: e.currentTarget });
              } else {
                void verifyOnly(e.currentTarget);
              }
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
          </button>
        </div>
      </div>
      <div className={`${styles['pv-cred-row']} ${styles['pv-cred-row-top']}`}>
        <span className={styles['pv-cred-label']}>Headers</span>
        <div className={styles['pv-cred-url-row']}>
          <ProviderHeadersField
            value={headersText}
            onChange={(value) => { setHeadersText(value); setHeadersEdited(true); setConnStatus('idle'); }}
            onBlur={async () => {
              if (!headersEdited || isPresetSetup) return;
              const headers = parseHeaders();
              if (!headers) return;
              try {
                await saveProviderConfigPatch(providerId, { headers });
                if (!await refreshAfterSave()) return;
                setHeadersEdited(false);
                showToast(t('settings.saved'), 'success');
              } catch (err: unknown) {
                reportSaveFailure(err);
              }
            }}
            readOnly={!!isPresetSetup}
          />
        </div>
      </div>
      <div className={styles['pv-cred-row']}>
        <span className={styles['pv-cred-label']}>Base URL</span>
        <div className={styles['pv-cred-url-row']}>
          <input
            className={styles['settings-input']}
            type="text"
            value={urlVal}
            onChange={(e) => { setUrlVal(e.target.value); setUrlEdited(true); }}
            onBlur={async () => {
              if (!urlEdited || isPresetSetup) return;
              const trimmed = urlVal.trim();
              if (trimmed === derivedBaseUrl) { setUrlEdited(false); return; }
              try {
                await saveProviderConfigPatch(providerId, { base_url: trimmed });
                if (!await refreshAfterSave()) return;
                setUrlEdited(false);
                showToast(t('settings.saved'), 'success');
              } catch (err: unknown) {
                reportSaveFailure(err);
              }
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            placeholder="https://api.example.com/v1"
            readOnly={!!isPresetSetup}
          />
        </div>
      </div>
      <div className={styles['pv-cred-row']}>
        <span className={styles['pv-cred-label']}>{t('settings.providers.apiType')}</span>
        <div className={styles['pv-cred-select-wrapper']}>
          <SelectWidget
            className={styles['pv-cred-select']}
            options={API_FORMAT_OPTIONS}
            value={apiVal}
            onChange={async (val) => {
              if (val === apiVal) return;
              const revision = apiDraftRevision.current + 1;
              apiDraftRevision.current = revision;
              setApiVal(val);
              setApiEdited(true);
              setConnStatus('idle');
              if (isPresetSetup) return;
              try {
                await saveProviderConfigPatch(providerId, { api: val });
                if (!await refreshAfterSave(() => apiDraftRevision.current === revision)) return;
                if (apiDraftRevision.current === revision) {
                  showToast(t('settings.saved'), 'success');
                }
              } catch (err: unknown) {
                if (apiDraftRevision.current === revision) reportSaveFailure(err);
              }
            }}
            placeholder="API Format"
          />
        </div>
      </div>
    </div>
  );
}
