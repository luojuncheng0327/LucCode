import React, { useState, useCallback, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useSettingsStore, type ProviderSummary } from '../store';
import { lucFetch } from '../api';
import { t, PROVIDER_PRESETS } from '../helpers';
import { loadSettingsConfig } from '../actions';
import { ProviderDetail } from './providers/ProviderDetail';
import { AddCustomButton, AddProviderOverlay } from './providers/ProviderList';
import { OtherModelsSection } from './providers/OtherModelsSection';
import { UsageLedgerSection } from './providers/UsageLedgerSection';
import { SettingsSection } from '../components/SettingsSection';
import { ProviderIcon } from '@/ui';
import styles from '../Settings.module.css';

export function ProvidersTab() {
  const { providersSummary, selectedProviderId, settingsConfig } = useSettingsStore(
    useShallow(s => ({ providersSummary: s.providersSummary, selectedProviderId: s.selectedProviderId, settingsConfig: s.settingsConfig }))
  );
  const providers = settingsConfig?.providers || {};
  const [addingProvider, setAddingProvider] = useState(false);

  const loadSummary = useCallback(async () => {
    try {
      const res = await lucFetch('/api/providers/summary');
      const data = await res.json();
      useSettingsStore.setState({ providersSummary: data.providers || {} });
    } catch { /* swallow */ }
  }, []);

  useEffect(() => { loadSummary(); }, [loadSummary]);

  const providerIds = Object.keys(providersSummary);
  const configuredProviderIds = providerIds.filter(id => providersSummary[id].is_configured !== false);
  const setupProviderIds = providerIds.filter(id => providersSummary[id].is_configured === false);
  const selected = selectedProviderId;

  // 分组：OAuth / Coding Plan / API Key
  const oauthProviders = configuredProviderIds.filter(id => providersSummary[id].supports_oauth);
  const codingPlanProviders = configuredProviderIds.filter(id => !providersSummary[id].supports_oauth && providersSummary[id].is_coding_plan);
  const registeredApiKey = configuredProviderIds.filter(id => !providersSummary[id].supports_oauth && !providersSummary[id].is_coding_plan);
  const registeredSet = new Set(configuredProviderIds);

  const unregisteredPresets = PROVIDER_PRESETS.filter(p =>
    !registeredSet.has(p.value) && !oauthProviders.includes(p.value)
  );
  const presetValues = new Set(PROVIDER_PRESETS.map(p => p.value));
  const unregisteredCodingPresets = unregisteredPresets.filter(p => p.value.endsWith('-coding'));
  const unregisteredApiPresets = unregisteredPresets.filter(p => !p.value.endsWith('-coding'));
  const registryOnlyCodingProviders = setupProviderIds.filter(id => !presetValues.has(id) && providersSummary[id].is_coding_plan);
  const registryOnlyApiProviders = setupProviderIds.filter(id => !presetValues.has(id) && !providersSummary[id].supports_oauth && !providersSummary[id].is_coding_plan);
  const customProviders = registeredApiKey.filter(id => !presetValues.has(id));
  const presetProviders = registeredApiKey.filter(id => presetValues.has(id));

  const selectProvider = (id: string) => {
    useSettingsStore.setState({ selectedProviderId: id });
  };

  const renderRegistered = (id: string) => {
    const p = providersSummary[id];
    const preset = PROVIDER_PRESETS.find(pr => pr.value === id);
    const modelCount = (p.models || []).length;
    return (
      <button
        key={id}
        className={`${styles['pv-list-item']}${selected === id  ? ' ' + styles['selected'] : ''}`}
        onClick={() => selectProvider(id)}
      >
        <span className={`${styles['pv-status-dot']}${p.has_credentials  ? ' ' + styles['on'] : ''}`} />
        <ProviderIcon provider={id} className={styles['pv-list-item-icon']} />
        <span className={styles['pv-list-item-name']}>{preset?.label || p.display_name || id}</span>
        <span className={styles['pv-list-item-count']}>{modelCount}</span>
      </button>
    );
  };

  const renderUnregistered = (preset: typeof PROVIDER_PRESETS[0]) => (
    <button
      key={preset.value}
      className={`${styles['pv-list-item']} ${styles['dim']}${selected === preset.value ? ' ' + styles['selected'] : ''}`}
      onClick={() => selectProvider(preset.value)}
    >
      <span className={styles['pv-status-dot']} />
      <ProviderIcon provider={preset.value} className={styles['pv-list-item-icon']} />
      <span className={styles['pv-list-item-name']}>{preset.label}</span>
    </button>
  );

  const renderRegistrySetup = (id: string) => {
    const p = providersSummary[id];
    return (
      <button
        key={id}
        className={`${styles['pv-list-item']} ${styles['dim']}${selected === id ? ' ' + styles['selected'] : ''}`}
        onClick={() => selectProvider(id)}
      >
        <span className={styles['pv-status-dot']} />
        <ProviderIcon provider={id} className={styles['pv-list-item-icon']} />
        <span className={styles['pv-list-item-name']}>{p.display_name || id}</span>
      </button>
    );
  };

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="providers">
      {/* pv-layout：double-column 外壳（sectionBody 透明，pv-layout 保留原视觉） */}
      <SettingsSection variant="double-column">
        <div className={styles['pv-layout']}>
          {/* ── 左栏 ── */}
          <div className={styles['pv-list']}>
            {oauthProviders.length > 0 && (
              <>
                <div className={styles['pv-list-group-label']}>OAuth</div>
                {oauthProviders.map(renderRegistered)}
              </>
            )}

            {(codingPlanProviders.length > 0 || unregisteredCodingPresets.length > 0 || registryOnlyCodingProviders.length > 0) && (
              <>
                <div className={styles['pv-list-group-label']}>Coding Plan</div>
                {codingPlanProviders.map(renderRegistered)}
                {unregisteredCodingPresets.map(renderUnregistered)}
                {registryOnlyCodingProviders.map(renderRegistrySetup)}
              </>
            )}

            <div className={styles['pv-list-group-label']}>API</div>
            {customProviders.map(renderRegistered)}
            {presetProviders.map(renderRegistered)}
            {unregisteredApiPresets.map(renderUnregistered)}
            {registryOnlyApiProviders.map(renderRegistrySetup)}

            <AddCustomButton onClick={() => setAddingProvider(true)} />
          </div>

          {/* ── 右栏：Provider 详情 ── */}
          <div className={styles['pv-detail']}>
            {selected ? (() => {
              const existing = providersSummary[selected];
              const preset = PROVIDER_PRESETS.find(p => p.value === selected);
              const isRegistryOnlySetup = existing?.is_configured === false;
              const summary: ProviderSummary = existing || {
                type: 'api-key' as const,
                auth_type: 'api-key' as const,
                display_name: preset?.label || selected,
                base_url: preset?.url || '',
                api: preset?.api || '',
                api_key: '',
                headers: {},
                models: [],
                custom_models: [],
                has_credentials: false,
                supports_oauth: false,
                can_delete: false,
              };
              return (
                <ProviderDetail
                  key={selected}
                  providerId={selected}
                  summary={summary}
                  providerConfig={providers[selected]}
                  isPresetSetup={!existing || isRegistryOnlySetup}
                  presetInfo={preset || (isRegistryOnlySetup ? {
                    label: summary.display_name || selected,
                    value: selected,
                    url: summary.base_url,
                    api: summary.api,
                    local: summary.auth_type === 'none',
                  } : undefined)}
                  onRefresh={async () => { await loadSettingsConfig(); await loadSummary(); }}
                />
              );
            })() : (
              <div className={styles['pv-empty']}>
                {t('settings.providers.selectHint')}
              </div>
            )}
          </div>

          {/* 新建 overlay 只覆盖白色卡片，不触达外部标题和 OtherModelsSection */}
          {addingProvider && (
            <AddProviderOverlay
              onDone={() => { setAddingProvider(false); loadSummary(); }}
              onCancel={() => setAddingProvider(false)}
            />
          )}
        </div>
      </SettingsSection>

      {/* 全局模型分配：OtherModelsSection 内部结构保持不变，外壳标准化 */}
      <SettingsSection title={t('settings.api.otherModelSection')}>
        <OtherModelsSection providers={providers} />
      </SettingsSection>

      <UsageLedgerSection />
    </div>
  );
}
