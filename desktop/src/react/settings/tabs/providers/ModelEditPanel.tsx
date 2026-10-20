import React, { useState, useEffect, useRef } from 'react';
import { useSettingsStore } from '../../store';
import { t, lookupModelMeta, CONTEXT_PRESETS, OUTPUT_PRESETS } from '../../helpers';
import { lucFetch } from '../../api';
import { ComboInput } from '../../widgets/ComboInput';
import { Toggle } from '@/ui';
import styles from '../../Settings.module.css';

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function firstNumber(meta: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = finiteNumber(meta[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function ModelEditPanel({ modelId, providerId, modelMeta, anchorEl, onClose, onRefresh }: {
  modelId: string;
  providerId: string;
  modelMeta?: Record<string, unknown>;
  anchorEl: HTMLElement | null;
  onClose: () => void;
  onRefresh?: () => Promise<void>;
}) {
  const showToast = useSettingsStore(s => s.showToast);
  const knownMeta: Record<string, any> = lookupModelMeta(modelId, providerId) || {};
  const userMeta: Record<string, unknown> = modelMeta || {};
  const meta: Record<string, any> = {
    ...knownMeta,
    ...userMeta,
  };
  // Resolve aliases inside each ownership layer before falling through to the
  // known catalog. Otherwise known `context`/`maxOutput` can mask a persisted
  // user `contextWindow`/`maxTokens` value after the objects are merged.
  const initialContext = firstNumber(userMeta, ['context', 'contextWindow'])
    ?? firstNumber(knownMeta, ['context', 'contextWindow']);
  const initialMaxOutput = firstNumber(userMeta, ['maxOutput', 'maxTokens', 'maxOutputTokens'])
    ?? firstNumber(knownMeta, ['maxOutput', 'maxTokens', 'maxOutputTokens']);
  const [displayName, setDisplayName] = useState(meta.displayName || meta.name || '');
  const [ctxVal, setCtxVal] = useState(String(initialContext ?? ''));
  const [outVal, setOutVal] = useState(String(initialMaxOutput ?? ''));
  // image 字段对应 Pi SDK Model.input 里是否包含 "image"。
  // 兼容读旧 meta.vision（未迁移到新字段的历史配置）；迁移 #7 之后此 fallback 恒不命中。
  const initialImage = meta.image === true || (meta.image === undefined && meta.vision === true);
  const [image, setImage] = useState<boolean>(initialImage);
  const [video, setVideo] = useState<boolean>(meta.video === true);
  const [audio, setAudio] = useState<boolean>(meta.audio === true);
  const [reasoning, setReasoning] = useState<boolean>(meta.reasoning === true);
  const [dirtyCapabilities, setDirtyCapabilities] = useState<Record<string, boolean>>({});
  const panelRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({});

  useEffect(() => {
    setStyle({
      position: 'fixed',
      left: '50%',
      top: '50%',
      transform: 'translate(-50%, -50%)',
      zIndex: 9999,
      width: 360,
    });
  }, [anchorEl]);

  const save = async () => {
    const entry: Record<string, any> = {};
    const name = displayName.trim();
    const ctx = ctxVal.trim();
    const maxOut = outVal.trim();
    if (name) entry.name = name;
    if (ctx) entry.context = parseInt(ctx);
    if (maxOut) entry.maxOutput = parseInt(maxOut);
    if (dirtyCapabilities.image) entry.image = image;
    if (dirtyCapabilities.video) entry.video = video;
    if (dirtyCapabilities.audio) entry.audio = audio;
    if (dirtyCapabilities.reasoning) entry.reasoning = reasoning;

    try {
      await lucFetch(`/api/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry),
      });
      showToast(t('settings.saved'), 'success');
      await onRefresh?.();
      onClose();
    } catch (err: any) {
      showToast(t('settings.saveFailed') + ': ' + err.message, 'error');
    }
  };

  return (
    <>
    <div className={styles['pv-model-edit-overlay']} onClick={onClose} />
    <div ref={panelRef} className={styles['pv-model-edit-card']} style={style}>
      <div className={styles['pv-model-edit-field']}>
        <label className={styles['pv-model-edit-label']}>ID</label>
        <span className={styles['pv-model-edit-id']}>{modelId}</span>
      </div>
      <div className={styles['pv-model-edit-field']}>
        <label className={styles['pv-model-edit-label']}>{t('settings.api.displayName')}</label>
        <input
          className={styles['settings-input']}
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder={modelId}
        />
      </div>
      <div className={styles['pv-model-edit-row']}>
        <div className={styles['pv-model-edit-field']}>
          <label className={styles['pv-model-edit-label']}>{t('settings.api.contextLength')}</label>
          <ComboInput presets={CONTEXT_PRESETS} value={ctxVal} onChange={setCtxVal} placeholder="131072" />
        </div>
        <div className={styles['pv-model-edit-field']}>
          <label className={styles['pv-model-edit-label']}>{t('settings.api.maxOutput')}</label>
          <ComboInput presets={OUTPUT_PRESETS} value={outVal} onChange={setOutVal} placeholder="65536" />
        </div>
      </div>
      <div className={`${styles['pv-model-edit-row']} ${styles['pv-model-edit-capabilities']}`}>
        <div className={styles['pv-model-edit-field']}>
          <label className={styles['pv-model-edit-label']}>{t('settings.api.vision')}</label>
          <Toggle ariaLabel={t('settings.api.vision')} on={image} onChange={(value) => { setImage(value); setDirtyCapabilities(prev => ({ ...prev, image: true })); }} />
        </div>
        <div className={styles['pv-model-edit-field']}>
          <label className={styles['pv-model-edit-label']}>{t('settings.api.video')}</label>
          <Toggle ariaLabel={t('settings.api.video')} on={video} onChange={(value) => { setVideo(value); setDirtyCapabilities(prev => ({ ...prev, video: true })); }} />
        </div>
        <div className={styles['pv-model-edit-field']}>
          <label className={styles['pv-model-edit-label']}>{t('settings.api.audio')}</label>
          <Toggle ariaLabel={t('settings.api.audio')} on={audio} onChange={(value) => { setAudio(value); setDirtyCapabilities(prev => ({ ...prev, audio: true })); }} />
        </div>
        <div className={styles['pv-model-edit-field']}>
          <label className={styles['pv-model-edit-label']}>{t('settings.api.reasoning')}</label>
          <Toggle ariaLabel={t('settings.api.reasoning')} on={reasoning} onChange={(value) => { setReasoning(value); setDirtyCapabilities(prev => ({ ...prev, reasoning: true })); }} />
        </div>
      </div>
      <div className={styles['pv-model-edit-actions']}>
        <button type="button" className={styles['pv-add-form-btn']} onClick={onClose}>{t('settings.api.cancel')}</button>
        <button type="button" className={`${styles['pv-add-form-btn']} ${styles['primary']}`} onClick={save}>{t('settings.api.save')}</button>
      </div>
    </div>
    </>
  );
}
