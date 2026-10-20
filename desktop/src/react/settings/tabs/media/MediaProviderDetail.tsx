import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useSettingsStore } from '../../store';
import { lucFetch } from '../../api';
import { invalidateConfigCache } from '../../../hooks/use-config';
import { t } from '../../helpers';
import { useAnchoredDropdown } from '../../hooks/useAnchoredDropdown';
import { SelectWidget } from '@/ui';
import styles from '../../Settings.module.css';

interface Props {
  providerId: string;
  provider: {
    displayName?: string;
    hasCredentials: boolean;
    unavailableReason?: string | null;
    unavailableMessage?: string | null;
    runtimeCapability?: {
      status?: string;
      error?: { code?: string; message?: string } | null;
    } | null;
    models: MediaModel[];
    availableModels: { id: string; name: string }[];
  };
  capability?: 'imageGeneration' | 'videoGeneration';
  config: {
    defaultImageModel?: { id: string; provider: string };
    defaultVideoModel?: { id: string; provider: string };
    providerDefaults?: Record<string, any>;
  };
  onSaveConfig: (updates: any) => Promise<void>;
  onRefresh: () => Promise<void>;
}

type JsonSchemaProperty = {
  type?: string | string[];
  enum?: Array<string | number | boolean>;
  default?: any;
  minimum?: number;
  maximum?: number;
  description?: string;
  title?: string;
};

type MediaMode = {
  id: string;
  label?: string;
  parameterSchema?: {
    type?: string;
    properties?: Record<string, JsonSchemaProperty>;
  };
  defaults?: Record<string, any>;
};

type MediaModel = {
  id: string;
  name: string;
  displayName?: string;
  protocolId?: string;
  ratios?: string[];
  resolutions?: string[];
  modes?: MediaMode[];
};

function isPlainObject(value: any): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function modeDefaultsForProvider(defaults: Record<string, any>, modelId: string, modeId: string) {
  return defaults?.models?.[modelId]?.modes?.[modeId] || {};
}

function clearEmptyObject(value: any) {
  if (!isPlainObject(value)) return value;
  for (const key of Object.keys(value)) {
    if (isPlainObject(value[key])) {
      clearEmptyObject(value[key]);
      if (Object.keys(value[key]).length === 0) delete value[key];
    }
  }
  return value;
}

export function MediaProviderDetail({ providerId, provider, capability = 'imageGeneration', config, onSaveConfig, onRefresh }: Props) {
  const showToast = useSettingsStore(s => s.showToast);
  const mediaRoute = capability === 'videoGeneration' ? 'video' : 'image';
  const defaultModel = capability === 'videoGeneration' ? config.defaultVideoModel : config.defaultImageModel;
  const defaults = config.providerDefaults?.[providerId] || {};
  const isDefault = useCallback((modelId: string) =>
    defaultModel?.id === modelId && defaultModel?.provider === providerId,
  [defaultModel?.id, defaultModel?.provider, providerId]);

  const updateDefault = (key: string, value: any) => {
    const current = config.providerDefaults || {};
    const provDefaults = { ...current[providerId], [key]: value };
    onSaveConfig({ providerDefaults: { ...current, [providerId]: provDefaults } });
  };

  const initialDefaultsModelId = provider.models.find(m => isDefault(m.id))?.id || provider.models[0]?.id || '';
  const [defaultsModelId, setDefaultsModelId] = useState(initialDefaultsModelId);
  const defaultsModel = provider.models.find(m => m.id === defaultsModelId) || provider.models[0] || null;
  const modelModes = useMemo(() => (
    Array.isArray(defaultsModel?.modes) ? defaultsModel.modes.filter(m => m?.id) : []
  ), [defaultsModel]);
  const [defaultsModeId, setDefaultsModeId] = useState(modelModes[0]?.id || '');
  const defaultsMode = modelModes.find(m => m.id === defaultsModeId) || modelModes[0] || null;
  const schemaProperties = defaultsMode?.parameterSchema?.properties || {};
  const schemaEntries = Object.entries(schemaProperties);
  const schemaDrivenDefaults = schemaEntries.length > 0;
  const fallbackRatios = Array.isArray(defaultsModel?.ratios) ? defaultsModel.ratios : [];
  const fallbackResolutions = Array.isArray(defaultsModel?.resolutions) ? defaultsModel.resolutions : [];
  const savedModeDefaults = defaultsModel && defaultsMode
    ? modeDefaultsForProvider(defaults, defaultsModel.id, defaultsMode.id)
    : {};

  useEffect(() => {
    const nextModelId = provider.models.find(m => m.id === defaultsModelId)?.id
      || provider.models.find(m => isDefault(m.id))?.id
      || provider.models[0]?.id
      || '';
    if (nextModelId !== defaultsModelId) setDefaultsModelId(nextModelId);
  }, [provider.models, defaultsModelId, defaultModel?.id, defaultModel?.provider, isDefault]);

  useEffect(() => {
    const nextModeId = modelModes.find(m => m.id === defaultsModeId)?.id || modelModes[0]?.id || '';
    if (nextModeId !== defaultsModeId) setDefaultsModeId(nextModeId);
  }, [modelModes, defaultsModeId]);

  const updateModeDefault = (key: string, value: any) => {
    if (!defaultsModel || !defaultsMode) return;
    const current = config.providerDefaults || {};
    const providerDefaults = { ...(current[providerId] || {}) };
    const models = { ...(providerDefaults.models || {}) };
    const modelDefaults = { ...(models[defaultsModel.id] || {}) };
    const modes = { ...(modelDefaults.modes || {}) };
    const modeDefaults = { ...(modes[defaultsMode.id] || {}) };
    if (value === undefined || value === null || value === '') delete modeDefaults[key];
    else modeDefaults[key] = value;
    modes[defaultsMode.id] = modeDefaults;
    modelDefaults.modes = modes;
    models[defaultsModel.id] = modelDefaults;
    providerDefaults.models = models;
    clearEmptyObject(providerDefaults);
    onSaveConfig({ providerDefaults: { ...current, [providerId]: providerDefaults } });
  };

  const renderSchemaControl = (key: string, property: JsonSchemaProperty) => {
    const value = savedModeDefaults[key] ?? '';
    const label = property.title || key;
    const description = property.description || label;
    if (Array.isArray(property.enum)) {
      return (
        <div key={key} className={styles['media-config-field']}>
          <span className={styles['media-config-label']} title={description}>
            {label}
          </span>
          <SelectWidget
            value={value === undefined || value === null ? '' : String(value)}
            onChange={(v) => updateModeDefault(key, v || undefined)}
            options={[
              { value: '', label: t('settings.media.defaultOption') },
              ...property.enum.map(item => ({ value: String(item), label: String(item) })),
            ]}
          />
        </div>
      );
    }
    const isNumber = property.type === 'number' || property.type === 'integer'
      || (Array.isArray(property.type) && (property.type.includes('number') || property.type.includes('integer')));
    return (
      <div key={key} className={styles['media-config-field']}>
        <span className={styles['media-config-label']} title={description}>
          {label}
        </span>
        <input
          className={styles['settings-input']}
          type={isNumber ? 'number' : 'text'}
          min={property.minimum}
          max={property.maximum}
          step={property.type === 'integer' ? 1 : undefined}
          value={value === undefined || value === null ? '' : String(value)}
          placeholder={property.default === undefined ? t('settings.media.defaultOption') : String(property.default)}
          onChange={(event) => {
            const raw = event.currentTarget.value;
            if (!raw) {
              updateModeDefault(key, undefined);
              return;
            }
            updateModeDefault(key, isNumber ? Number(raw) : raw);
          }}
        />
      </div>
    );
  };

  // ── Model add/remove through the native media provider routes ──

  const addModel = async (modelId: string) => {
    try {
      const candidate = allModels.find(m => m.id === modelId) || { id: modelId };
      await lucFetch(`/api/media/${mediaRoute}/providers/${encodeURIComponent(providerId)}/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: candidate }),
      });
      invalidateConfigCache();
      setSearch('');
      setDropdownOpen(false);
      await onRefresh();
    } catch (err: any) {
      showToast(err.message || 'Failed', 'error');
    }
  };

  const removeModel = async (modelId: string) => {
    try {
      await lucFetch(`/api/media/${mediaRoute}/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}`, {
        method: 'DELETE',
      });
      invalidateConfigCache();
      await onRefresh();
    } catch (err: any) {
      showToast(err.message || 'Failed', 'error');
    }
  };

  // ── Dropdown state (same pattern as ProviderModelList) ──

  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [search, setSearch] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeDropdown = useCallback(() => setDropdownOpen(false), []);

  const addedIds = new Set(provider.models.map(m => m.id));
  const allModels = [...provider.models, ...provider.availableModels];
  const trimmedSearch = search.trim();
  const query = trimmedSearch.toLowerCase();
  const filtered = query ? allModels.filter(m => m.id.toLowerCase().includes(query) || (m.name || m.id).toLowerCase().includes(query)) : allModels;
  const hasExactCandidate = allModels.some(m => m.id.toLowerCase() === query);
  const canAddCustom = !!trimmedSearch && !hasExactCandidate && !addedIds.has(trimmedSearch);
  const modelsLabel = capability === 'videoGeneration'
    ? t('settings.media.videoModels')
    : t('settings.media.models');
  const addModelLabel = capability === 'videoGeneration'
    ? t('settings.media.addVideoModel')
    : t('settings.media.addModel');
  const runtimeDiscovered = !!provider.runtimeCapability;
  const statusMessage = provider.hasCredentials
    ? t('settings.media.credentialOk')
    : provider.unavailableMessage
      || provider.runtimeCapability?.error?.message
      || provider.unavailableReason
      || t('settings.media.credentialMissing');

  const panelStyle = useAnchoredDropdown({
    open: dropdownOpen,
    triggerRef,
    panelRef,
    onClose: closeDropdown,
    widthOffset: 80,
  });

  return (
    <div className={styles['pv-detail-inner']}>
      <div className={styles['pv-detail-header']}>
        <h2 className={styles['pv-detail-title']}>{provider.displayName || providerId}</h2>
      </div>

      {/* Credential status */}
      <div className={styles['settings-credential-status']}>
        <span className={`${styles['settings-credential-dot']}${provider.hasCredentials ? ' ' + styles.on : ''}`} />
        {statusMessage}
      </div>

      <div className={styles['pv-models']}>
        {/* Added model list */}
        {provider.models.length > 0 && (
            <div className={styles['pv-fav-section']}>
              <div className={styles['pv-fav-title']}>
              {modelsLabel}
              <span className={styles['pv-models-count']}>{provider.models.length}</span>
            </div>
            <div className={styles['pv-fav-list']}>
              {provider.models.map(m => (
                <div key={m.id} className={styles['pv-fav-item']}>
                  <span className={styles['pv-fav-item-name']} title={m.id}>{m.name || m.id}</span>
                  <span className={styles['pv-fav-item-id']}>{m.id}</span>
                  {isDefault(m.id) && (
                    <span className={styles['settings-default-badge']}>
                      {t('settings.media.default')}
                    </span>
                  )}
                  {!runtimeDiscovered && (
                    <div className={styles['pv-fav-item-actions']}>
                      <button className={styles['pv-fav-item-remove']} onClick={() => removeModel(m.id)} title={t('settings.api.removeModel')}>
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Add model dropdown */}
        {!runtimeDiscovered && (
          <div className={styles['pv-models-action-row']}>
            <button ref={triggerRef} className={styles['pv-model-dropdown-trigger']} onClick={() => setDropdownOpen(!dropdownOpen)}>
              <span>{addModelLabel}</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          </div>
        )}

        {!runtimeDiscovered && dropdownOpen && createPortal(
          <div
            className={styles['pv-model-dropdown-panel']}
            ref={panelRef}
            style={panelStyle}
            data-media-model-dropdown="true"
          >
            <input
              className={styles['pv-model-dropdown-search']}
              type="text"
              placeholder={t('settings.api.searchModel')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
            <div className={styles['pv-model-dropdown-list']}>
              {filtered.map(m => {
                const isAdded = addedIds.has(m.id);
                return (
                  <button
                    key={m.id}
                    className={`${styles['pv-model-dropdown-option']}${isAdded ? ' ' + styles['added'] : ''}`}
                    onClick={() => { if (!isAdded) addModel(m.id); }}
                  >
                    <span className={styles['pv-model-dropdown-option-name']}>{m.name || m.id}</span>
                    {isAdded && <span className={styles['pv-model-dropdown-option-check']}>{'\u2713'}</span>}
                  </button>
                );
              })}
              {filtered.length === 0 && (
                <div className={styles['pv-model-dropdown-empty']}>{t('settings.providers.noModels')}</div>
              )}
              {canAddCustom && (
                <button
                  className={styles['pv-model-dropdown-option']}
                  onClick={() => addModel(trimmedSearch)}
                >
                  <span className={styles['pv-model-dropdown-option-name']}>{trimmedSearch}</span>
                </button>
              )}
            </div>
          </div>,
          document.body,
        )}
      </div>

      {/* Provider-specific defaults */}
      {provider.models.length > 0 && (
        <div className={styles['media-defaults']}>
          <div className={styles['media-defaults-title']}>
            {t('settings.media.providerDefaults')}
          </div>
          {schemaDrivenDefaults ? (
            <div className={styles['media-defaults-stack']}>
              <div className={`${styles['media-config-grid']}${modelModes.length > 1 ? '' : ' ' + styles['media-config-grid-single']}`}>
                <div className={styles['media-config-field']}>
                  <span className={styles['media-config-label']}>
                    {capability === 'videoGeneration' ? t('settings.media.videoModels') : t('settings.media.models')}
                  </span>
                  <SelectWidget
                    value={defaultsModel?.id || ''}
                    onChange={(v) => setDefaultsModelId(v)}
                    options={provider.models.map(model => ({
                      value: model.id,
                      label: model.name || model.id,
                    }))}
                  />
                </div>
                {modelModes.length > 1 && (
                  <div className={styles['media-config-field']}>
                    <span className={styles['media-config-label']}>
                      Mode
                    </span>
                    <SelectWidget
                      value={defaultsMode?.id || ''}
                      onChange={(v) => setDefaultsModeId(v)}
                      options={modelModes.map(mode => ({
                        value: mode.id,
                        label: mode.label || mode.id,
                      }))}
                    />
                  </div>
                )}
              </div>
              <div className={styles['media-config-grid']}>
                {schemaEntries.map(([key, property]) => renderSchemaControl(key, property))}
              </div>
            </div>
          ) : (
            <div className={styles['media-config-grid']}>
              {capability === 'imageGeneration' && fallbackResolutions.length > 0 && (
                <div className={styles['media-config-field']}>
                  <span className={styles['media-config-label']}>
                    {t('settings.media.size')}
                  </span>
                  <SelectWidget
                    value={defaults.resolution || ''}
                    onChange={(v) => updateDefault('resolution', v || undefined)}
                    options={[
                      { value: '', label: t('settings.media.defaultOption') },
                      ...fallbackResolutions.map(item => ({ value: String(item), label: String(item) })),
                    ]}
                  />
                </div>
              )}
              {fallbackRatios.length > 0 && (
                <div className={styles['media-config-field']}>
                  <span className={styles['media-config-label']}>
                    {t('settings.media.aspectRatio')}
                  </span>
                  <SelectWidget
                    value={defaults.aspect_ratio || ''}
                    onChange={(v) => updateDefault('aspect_ratio', v || undefined)}
                    options={[
                      { value: '', label: t('settings.media.defaultOption') },
                      ...fallbackRatios.map(item => ({ value: String(item), label: String(item) })),
                    ]}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
