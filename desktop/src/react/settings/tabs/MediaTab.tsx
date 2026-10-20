import React, { useState, useCallback, useEffect } from 'react';
import { useSettingsStore } from '../store';
import { lucFetch } from '../api';
import { t } from '../helpers';
import { updateSettingsSnapshot } from '../actions';
import { MediaProviderDetail } from './media/MediaProviderDetail';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import { SelectWidget, Toggle } from '@/ui';
import styles from '../Settings.module.css';

interface MediaProvider {
  providerId: string;
  displayName?: string;
  hasCredentials: boolean;
  unavailableReason?: string | null;
  unavailableMessage?: string | null;
  runtimeCapability?: {
    status?: string;
    error?: { code?: string; message?: string } | null;
  } | null;
  models: { id: string; name: string; protocolId?: string; adapterAvailable?: boolean }[];
  availableModels: { id: string; name: string }[];
}

interface MediaConfig {
  defaultImageModel?: { id: string; provider: string };
  defaultVideoModel?: { id: string; provider: string };
  providerDefaults?: Record<string, any>;
}

interface SpeechModel {
  id: string;
  name?: string;
  displayName?: string;
  protocolId?: string;
  adapterAvailable?: boolean;
}

interface SpeechProvider {
  providerId: string;
  displayName?: string;
  hasCredentials: boolean;
  unavailableReason?: string | null;
  models: SpeechModel[];
  availableModels?: { id: string; name: string }[];
}

interface SpeechConfig {
  enabled: boolean;
  defaultModel?: { id: string; provider: string };
}

type SpeechConfigPatch = {
  enabled?: boolean;
  defaultModel?: SpeechConfig['defaultModel'] | null;
};

type MediaSelection =
  | { kind: 'imageGeneration'; providerId: string }
  | { kind: 'videoGeneration'; providerId: string }
  | { kind: 'speechRecognition'; providerId: string };

const LOADING_SELECT_VALUE = '__loading';

function encodeConfigPatch(updates: Partial<MediaConfig>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(updates).map(([key, value]) => [key, value === undefined ? null : value]),
  );
}

function applyConfigPatch(prev: MediaConfig, updates: Partial<MediaConfig>): MediaConfig {
  const next: MediaConfig = { ...prev };
  for (const [key, value] of Object.entries(updates) as Array<[keyof MediaConfig, MediaConfig[keyof MediaConfig]]>) {
    if (value === undefined) delete next[key];
    else next[key] = value as any;
  }
  return next;
}

function encodeSpeechConfigPatch(updates: SpeechConfigPatch): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(updates).map(([key, value]) => [key, value === undefined ? null : value]),
  );
}

function applySpeechConfigPatch(prev: SpeechConfig, updates: SpeechConfigPatch): SpeechConfig {
  const next: SpeechConfig = { ...prev };
  if (typeof updates.enabled === 'boolean') next.enabled = updates.enabled;
  if ('defaultModel' in updates) {
    if (updates.defaultModel) next.defaultModel = updates.defaultModel;
    else delete next.defaultModel;
  }
  return next;
}

function mergeSpeechConfig(prev: SpeechConfig, incoming: any): SpeechConfig {
  const next: SpeechConfig = { ...prev };
  if (typeof incoming?.enabled === 'boolean') next.enabled = incoming.enabled;
  if (incoming && Object.prototype.hasOwnProperty.call(incoming, 'defaultModel')) {
    if (incoming.defaultModel) next.defaultModel = incoming.defaultModel;
    else delete next.defaultModel;
  }
  return next;
}

function speechModelLabel(model: SpeechModel | { id: string; name: string }): string {
  return 'displayName' in model && model.displayName ? model.displayName : model.name || model.id;
}

function getRunnableSpeechModels(provider: SpeechProvider): Array<{ id: string; name: string }> {
  if (!provider.hasCredentials) return [];
  if (Array.isArray(provider.availableModels)) {
    return provider.availableModels.map(model => ({ id: model.id, name: model.name || model.id }));
  }
  return (provider.models || [])
    .filter(model => model.adapterAvailable !== false)
    .map(model => ({ id: model.id, name: speechModelLabel(model) }));
}

function textOrFallback(key: string, fallback: string): string {
  const value = t(key);
  return value === key ? fallback : value;
}

function SpeechProviderDetail({
  providerId,
  provider,
  config,
}: {
  providerId: string;
  provider: SpeechProvider;
  config: SpeechConfig | null;
}) {
  const runnableModels = getRunnableSpeechModels(provider);
  const isDefault = (modelId: string) =>
    config?.defaultModel?.id === modelId && config.defaultModel.provider === providerId;

  return (
    <div className={styles['pv-detail-inner']}>
      <div className={styles['pv-detail-header']}>
        <h2 className={styles['pv-detail-title']}>{provider.displayName || providerId}</h2>
      </div>

      <div className={styles['settings-credential-status']}>
        <span className={`${styles['settings-credential-dot']}${provider.hasCredentials ? ' ' + styles.on : ''}`} />
        {provider.hasCredentials ? t('settings.media.credentialOk') : t('settings.media.credentialMissing')}
      </div>

      <div className={styles['pv-models']}>
        <div className={styles['pv-fav-section']}>
          <div className={styles['pv-fav-title']}>
            {textOrFallback('settings.media.speechModels', '转录模型')}
            <span className={styles['pv-models-count']}>{runnableModels.length}</span>
          </div>
          {runnableModels.length > 0 ? (
            <div className={styles['pv-fav-list']}>
              {runnableModels.map(model => (
                <div key={model.id} className={styles['pv-fav-item']}>
                  <span className={styles['pv-fav-item-name']} title={model.id}>{model.name || model.id}</span>
                  <span className={styles['pv-fav-item-id']}>{model.id}</span>
                  {isDefault(model.id) && (
                    <span className={styles['settings-default-badge']}>
                      {t('settings.media.default')}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className={styles['pv-empty']}>{t('settings.media.noProvider')}</div>
          )}
        </div>
      </div>
    </div>
  );
}

export function MediaTab() {
  const snapshotSpeechConfig = useSettingsStore(s => s.settingsSnapshot.data?.preferences?.speechRecognition);
  const [providers, setProviders] = useState<Record<string, MediaProvider>>({});
  const [config, setConfig] = useState<MediaConfig | null>(null);
  const [imageConfigLoading, setImageConfigLoading] = useState(true);
  const [videoProviders, setVideoProviders] = useState<Record<string, MediaProvider>>({});
  const [videoConfig, setVideoConfig] = useState<MediaConfig | null>(null);
  const [videoConfigLoading, setVideoConfigLoading] = useState(true);
  const [speechProviders, setSpeechProviders] = useState<Record<string, SpeechProvider>>({});
  const [speechConfig, setSpeechConfig] = useState<SpeechConfig | null>(() => (
    snapshotSpeechConfig ? mergeSpeechConfig({ enabled: false }, snapshotSpeechConfig) : null
  ));
  const [speechConfigLoading, setSpeechConfigLoading] = useState(() => !snapshotSpeechConfig);
  const [selected, setSelected] = useState<MediaSelection | null>(null);
  const showToast = useSettingsStore(s => s.showToast);

  useEffect(() => {
    if (!snapshotSpeechConfig) return;
    setSpeechConfig(mergeSpeechConfig({ enabled: false }, snapshotSpeechConfig));
  }, [snapshotSpeechConfig]);

  const loadImageProviders = useCallback(async () => {
    setImageConfigLoading(true);
    try {
      const res = await lucFetch('/api/media/image/providers');
      const data = await res.json();
      const nextProviders = data.providers || {};
      setProviders(nextProviders);
      setConfig(data.config || {});
      setSelected(current => {
        if (current && current.kind !== 'imageGeneration') return current;
        if (current?.kind === 'imageGeneration' && nextProviders[current.providerId]) return current;
        const ids = Object.keys(nextProviders);
        const providerId = ids.find(id => nextProviders[id]?.hasCredentials) || ids[0] || null;
        return providerId ? { kind: 'imageGeneration', providerId } : null;
      });
    } catch {
      setProviders({});
      setConfig({});
    } finally {
      setImageConfigLoading(false);
    }
  }, []);

  const loadVideoProviders = useCallback(async () => {
    setVideoConfigLoading(true);
    try {
      const res = await lucFetch('/api/media/video/providers');
      const data = await res.json();
      const nextProviders = data.providers || {};
      setVideoProviders(nextProviders);
      setVideoConfig(data.config || {});
      setSelected(current => {
        if (current && current.kind !== 'videoGeneration') return current;
        if (current?.kind === 'videoGeneration' && nextProviders[current.providerId]) return current;
        const ids = Object.keys(nextProviders);
        const providerId = ids.find(id => nextProviders[id]?.hasCredentials) || ids[0] || null;
        return providerId ? { kind: 'videoGeneration', providerId } : null;
      });
    } catch {
      setVideoProviders({});
      setVideoConfig({});
    } finally {
      setVideoConfigLoading(false);
    }
  }, []);

  const loadSpeechProviders = useCallback(async () => {
    try {
      const res = await lucFetch('/api/speech-recognition/providers');
      const data = await res.json();
      const nextProviders = data.providers || {};
      setSpeechProviders(nextProviders);
      setSpeechConfig(mergeSpeechConfig({ enabled: false }, data.config || {}));
      setSelected(current => {
        if (current?.kind !== 'speechRecognition') return current;
        if (nextProviders[current.providerId]) return current;
        return null;
      });
    } catch (err: any) {
      setSpeechProviders({});
      showToast(err.message || 'Failed to load speech recognition providers', 'error');
    } finally {
      setSpeechConfigLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    loadImageProviders();
    loadVideoProviders();
    loadSpeechProviders();
    const refreshRuntimeMediaProviders = () => {
      loadImageProviders();
      loadVideoProviders();
    };
    window.addEventListener('focus', refreshRuntimeMediaProviders);
    return () => window.removeEventListener('focus', refreshRuntimeMediaProviders);
  }, [loadImageProviders, loadVideoProviders, loadSpeechProviders]);

  const providerIds = Object.keys(providers);
  const videoProviderIds = Object.keys(videoProviders);
  const speechProviderIds = Object.keys(speechProviders);
  const allImageModels = providerIds.flatMap(pid =>
    (providers[pid].models || []).map(m => ({ ...m, provider: pid }))
  );
  const allVideoModels = videoProviderIds.flatMap(pid =>
    (videoProviders[pid].models || []).map(m => ({ ...m, provider: pid }))
  );
  const allSpeechModels = speechProviderIds.flatMap(pid =>
    getRunnableSpeechModels(speechProviders[pid]).map(m => ({ ...m, provider: pid }))
  );
  const speechEnabled = speechConfig?.enabled === true;
  const speechRecognitionEnabledLabel = textOrFallback('settings.media.speechRecognitionEnabled', '发送语音条时转录');
  const defaultSpeechModelLabel = textOrFallback('settings.media.defaultSpeechModel', '语音条转录模型');
  const selectedImageProviderId = selected?.kind === 'imageGeneration' ? selected.providerId : null;
  const selectedVideoProviderId = selected?.kind === 'videoGeneration' ? selected.providerId : null;
  const selectedSpeechProviderId = selected?.kind === 'speechRecognition' ? selected.providerId : null;
  const imageConfigReady = !imageConfigLoading && config !== null;
  const imageDefaultValue = imageConfigReady && config?.defaultImageModel
    ? `${config.defaultImageModel.provider}/${config.defaultImageModel.id}`
    : imageConfigReady ? '' : LOADING_SELECT_VALUE;
  const videoConfigReady = !videoConfigLoading && videoConfig !== null;
  const videoDefaultValue = videoConfigReady && videoConfig?.defaultVideoModel
    ? `${videoConfig.defaultVideoModel.provider}/${videoConfig.defaultVideoModel.id}`
    : videoConfigReady ? '' : LOADING_SELECT_VALUE;
  const speechConfigReady = !speechConfigLoading && speechConfig !== null;
  const speechDefaultValue = speechConfigReady && speechConfig?.defaultModel
    ? `${speechConfig.defaultModel.provider}/${speechConfig.defaultModel.id}`
    : speechConfigReady ? '' : LOADING_SELECT_VALUE;

  const saveConfig = async (updates: Partial<MediaConfig>) => {
    try {
      const res = await lucFetch('/api/media/image/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: encodeConfigPatch(updates) }),
      });
      const data = await res.json().catch(() => null);
      if (data?.values) setConfig(data.values);
      else setConfig(prev => applyConfigPatch(prev || {}, updates));
      showToast(t('settings.saved'), 'success');
    } catch (err: any) {
      showToast(err.message || 'Save failed', 'error');
    }
  };

  const saveVideoConfig = async (updates: Partial<MediaConfig>) => {
    try {
      const res = await lucFetch('/api/media/video/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: encodeConfigPatch(updates) }),
      });
      const data = await res.json().catch(() => null);
      if (data?.values) setVideoConfig(data.values);
      else setVideoConfig(prev => applyConfigPatch(prev || {}, updates));
      showToast(t('settings.saved'), 'success');
    } catch (err: any) {
      showToast(err.message || 'Save failed', 'error');
    }
  };

  const saveSpeechConfig = async (updates: SpeechConfigPatch) => {
    try {
      const res = await lucFetch('/api/speech-recognition/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: encodeSpeechConfigPatch(updates) }),
      });
      const data = await res.json().catch(() => null);
      setSpeechConfig(prev => {
        const base = prev || { enabled: false };
        const next = data?.config
          ? mergeSpeechConfig(base, data.config)
          : data?.values
            ? mergeSpeechConfig(base, data.values)
            : applySpeechConfigPatch(base, updates);
        updateSettingsSnapshot(snapshot => ({
          ...snapshot,
          preferences: { ...snapshot.preferences, speechRecognition: next },
        }));
        return next;
      });
      showToast(t('settings.saved'), 'success');
    } catch (err: any) {
      showToast(err.message || 'Save failed', 'error');
    }
  };

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="media">
      {/* pv-layout：double-column variant 做外壳，内部 DOM 保留原样 */}
      <SettingsSection variant="double-column">
        <div className={styles['pv-layout']}>
          {/* Left: Provider list */}
          <div className={styles['pv-list']}>
            <div className={styles['pv-list-group-label']}>{t('settings.media.imageGeneration')}</div>
            {providerIds.map(pid => {
              const p = providers[pid];
              return (
                <button
                  key={pid}
                  className={`${styles['pv-list-item']}${selectedImageProviderId === pid ? ' ' + styles['selected'] : ''}${!p.hasCredentials ? ' ' + styles['dim'] : ''}`}
                  onClick={() => setSelected({ kind: 'imageGeneration', providerId: pid })}
                  title={p.unavailableMessage || p.unavailableReason || undefined}
                >
                  <span className={`${styles['pv-status-dot']}${p.hasCredentials ? ' ' + styles['on'] : ''}`} />
                  <span className={styles['pv-list-item-name']}>{p.displayName || pid}</span>
                  <span className={styles['pv-list-item-count']}>{p.models.length}</span>
                </button>
              );
            })}

            <div className={styles['pv-list-divider']} />
            <div className={styles['pv-list-group-label']}>{t('settings.media.videoGeneration')}</div>
            {videoProviderIds.map(pid => {
              const p = videoProviders[pid];
              return (
                <button
                  key={pid}
                  className={`${styles['pv-list-item']}${selectedVideoProviderId === pid ? ' ' + styles['selected'] : ''}${!p.hasCredentials ? ' ' + styles['dim'] : ''}`}
                  onClick={() => setSelected({ kind: 'videoGeneration', providerId: pid })}
                  title={p.unavailableMessage || p.unavailableReason || undefined}
                >
                  <span className={`${styles['pv-status-dot']}${p.hasCredentials ? ' ' + styles['on'] : ''}`} />
                  <span className={styles['pv-list-item-name']}>{p.displayName || pid}</span>
                  <span className={styles['pv-list-item-count']}>{p.models.length}</span>
                </button>
              );
            })}

            <div className={styles['pv-list-divider']} />
            <div className={styles['pv-list-group-label']}>
              {t('settings.media.speechRecognition')}
            </div>
            {speechProviderIds.map(pid => {
              const p = speechProviders[pid];
              const runnableCount = getRunnableSpeechModels(p).length;
              return (
                <button
                  key={pid}
                  type="button"
                  className={`${styles['pv-list-item']}${selectedSpeechProviderId === pid ? ' ' + styles['selected'] : ''}${!p.hasCredentials || runnableCount === 0 ? ' ' + styles['dim'] : ''}`}
                  onClick={() => setSelected({ kind: 'speechRecognition', providerId: pid })}
                  title={p.unavailableReason || undefined}
                >
                  <span className={`${styles['pv-status-dot']}${p.hasCredentials && runnableCount > 0 ? ' ' + styles['on'] : ''}`} />
                  <span className={styles['pv-list-item-name']}>{p.displayName || pid}</span>
                  <span className={styles['pv-list-item-count']}>{runnableCount}</span>
                </button>
              );
            })}

            <div className={styles['pv-list-divider']} />
            <div className={`${styles['pv-list-group-label']} ${styles['pv-list-group-label-muted']}`}>
              {t('settings.media.speechSynthesis')}
            </div>
            <div className={`${styles['pv-list-item']} ${styles['pv-list-item-disabled']}`}>
              <span className={styles['pv-status-dot']} />
              <span className={`${styles['pv-list-item-name']} ${styles['pv-list-item-coming-soon']}`}>
                {t('settings.media.comingSoon')}
              </span>
            </div>
          </div>

          {/* Right: Provider detail */}
          <div className={styles['pv-detail']}>
            {selectedImageProviderId && providers[selectedImageProviderId] ? (
              <MediaProviderDetail
                providerId={selectedImageProviderId}
                provider={providers[selectedImageProviderId]}
                capability="imageGeneration"
                config={config || {}}
                onSaveConfig={saveConfig}
                onRefresh={loadImageProviders}
              />
            ) : selectedVideoProviderId && videoProviders[selectedVideoProviderId] ? (
              <MediaProviderDetail
                providerId={selectedVideoProviderId}
                provider={videoProviders[selectedVideoProviderId]}
                capability="videoGeneration"
                config={videoConfig || {}}
                onSaveConfig={saveVideoConfig}
                onRefresh={loadVideoProviders}
              />
            ) : selectedSpeechProviderId && speechProviders[selectedSpeechProviderId] ? (
              <SpeechProviderDetail
                providerId={selectedSpeechProviderId}
                provider={speechProviders[selectedSpeechProviderId]}
                config={speechConfig}
              />
            ) : (
              <div className={styles['pv-empty']}>
                {t('settings.media.noProvider')}
              </div>
            )}
          </div>
        </div>
      </SettingsSection>

      {/* 全局默认：标准 inline row */}
      <SettingsSection title={t('settings.media.globalDefault')}>
        <SettingsRow
          label={t('settings.media.defaultModel')}
          control={
            <SelectWidget
              value={imageDefaultValue}
              onChange={(val) => {
                if (val === LOADING_SELECT_VALUE) return;
                if (!val) {
                  saveConfig({ defaultImageModel: undefined });
                  return;
                }
                const [provider, ...rest] = val.split('/');
                saveConfig({ defaultImageModel: { id: rest.join('/'), provider } });
              }}
              disabled={!imageConfigReady}
              options={[
                ...(imageConfigReady ? [{ value: '', label: '—' }] : [{ value: LOADING_SELECT_VALUE, label: t('common.loading'), disabled: true }]),
                ...(imageConfigReady && config?.defaultImageModel && !allImageModels.some(m => `${m.provider}/${m.id}` === imageDefaultValue)
                  ? [{
                      value: imageDefaultValue,
                      label: `${config.defaultImageModel.provider} / ${config.defaultImageModel.id}`,
                      disabled: true,
                    }]
                  : []),
                ...(imageConfigReady ? allImageModels.map(m => {
                  const providerHasCredentials = providers[m.provider]?.hasCredentials === true;
                  const adapterAvailable = m.adapterAvailable !== false;
                  const label = `${m.provider} / ${m.name || m.id}`;
                  const unavailableReason = !providerHasCredentials
                    ? providers[m.provider]?.unavailableMessage
                      || providers[m.provider]?.unavailableReason
                      || t('settings.media.credentialMissing')
                    : !adapterAvailable
                      ? t('settings.media.adapterMissing')
                      : '';
                  return {
                    value: `${m.provider}/${m.id}`,
                    label: unavailableReason ? `${label} (${unavailableReason})` : label,
                    disabled: !providerHasCredentials || !adapterAvailable,
                  };
                }) : []),
              ]}
            />
          }
        />
        <SettingsRow
          label={t('settings.media.defaultVideoModel')}
          control={
            <SelectWidget
              value={videoDefaultValue}
              onChange={(val) => {
                if (val === LOADING_SELECT_VALUE) return;
                if (!val) {
                  saveVideoConfig({ defaultVideoModel: undefined });
                  return;
                }
                const [provider, ...rest] = val.split('/');
                saveVideoConfig({ defaultVideoModel: { provider, id: rest.join('/') } });
              }}
              disabled={!videoConfigReady}
              options={[
                ...(videoConfigReady ? [{ value: '', label: '—' }] : [{ value: LOADING_SELECT_VALUE, label: t('common.loading'), disabled: true }]),
                ...(videoConfigReady && videoConfig?.defaultVideoModel && !allVideoModels.some(m => `${m.provider}/${m.id}` === videoDefaultValue)
                  ? [{
                      value: videoDefaultValue,
                      label: `${videoConfig.defaultVideoModel.provider} / ${videoConfig.defaultVideoModel.id}`,
                      disabled: true,
                    }]
                  : []),
                ...(videoConfigReady ? allVideoModels.map(m => {
                  const providerHasCredentials = videoProviders[m.provider]?.hasCredentials === true;
                  const adapterAvailable = m.adapterAvailable !== false;
                  const label = `${m.provider} / ${m.name || m.id}`;
                  const unavailableReason = !providerHasCredentials
                    ? videoProviders[m.provider]?.unavailableMessage
                      || videoProviders[m.provider]?.unavailableReason
                      || t('settings.media.credentialMissing')
                    : !adapterAvailable
                      ? t('settings.media.videoAdapterMissing')
                      : '';
                  return {
                    value: `${m.provider}/${m.id}`,
                    label: unavailableReason ? `${label} (${unavailableReason})` : label,
                    disabled: !providerHasCredentials || !adapterAvailable,
                  };
                }) : []),
              ]}
            />
          }
        />
        <SettingsRow
          label={speechRecognitionEnabledLabel}
          control={
            <Toggle
              ariaLabel={speechRecognitionEnabledLabel}
              on={speechConfig ? speechEnabled : undefined}
              onChange={(enabled) => saveSpeechConfig({ enabled })}
            />
          }
        />
        <SettingsRow
          label={defaultSpeechModelLabel}
          control={
            <SelectWidget
              value={speechDefaultValue}
              onChange={(val) => {
                if (val === LOADING_SELECT_VALUE) return;
                if (!val) {
                  saveSpeechConfig({ defaultModel: undefined });
                  return;
                }
                const [provider, ...rest] = val.split('/');
                saveSpeechConfig({ defaultModel: { id: rest.join('/'), provider } });
              }}
              disabled={!speechConfigReady || !speechEnabled || (allSpeechModels.length === 0 && !speechConfig?.defaultModel)}
              options={[
                ...(speechConfigReady ? [{ value: '', label: '—' }] : [{ value: LOADING_SELECT_VALUE, label: t('common.loading'), disabled: true }]),
                ...(speechConfigReady && speechConfig?.defaultModel && !allSpeechModels.some(m => `${m.provider}/${m.id}` === speechDefaultValue)
                  ? [{
                      value: speechDefaultValue,
                      label: `${speechConfig.defaultModel.provider} / ${speechConfig.defaultModel.id}`,
                      disabled: true,
                    }]
                  : []),
                ...(speechConfigReady && speechEnabled ? allSpeechModels.map(m => ({
                  value: `${m.provider}/${m.id}`,
                  label: `${m.provider} / ${m.name || m.id}`,
                })) : []),
              ]}
            />
          }
        />
      </SettingsSection>
    </div>
  );
}
