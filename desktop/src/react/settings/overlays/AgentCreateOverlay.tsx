import { useState, useEffect, useRef, useCallback } from 'react';
import { useSettingsStore } from '../store';
import { lucFetch } from '../api';
import { t } from '../helpers';
import { switchToAgent } from '../actions';
import { Overlay } from '../../ui';
import styles from '../Settings.module.css';
import { CharacterCardPreviewOverlay, type CharacterCardPlan } from './CharacterCardPreviewOverlay';

export function AgentCreateOverlay() {
  const showToast = useSettingsStore(s => s.showToast);
  const [visible, setVisible] = useState(false);
  const [name, setName] = useState('');
  const [yuan, setYuan] = useState('luc');
  const [creating, setCreating] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [cardPlan, setCardPlan] = useState<CharacterCardPlan | null>(null);
  const [importMemory, setImportMemory] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handler = () => {
      setName('');
      setYuan('luc');
      setCardPlan(null);
      setImportMemory(false);
      setError('');
      setVisible(true);
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener('luc-show-agent-create', handler);
    return () => window.removeEventListener('luc-show-agent-create', handler);
  }, []);

  const close = useCallback(() => {
    setVisible(false);
    setCardPlan(null);
    setImportMemory(false);
    setDragActive(false);
    setError('');
  }, []);

  const create = async () => {
    if (creating) return;
    const trimmed = name.trim();
    if (!trimmed) {
      const message = t('settings.agent.nameRequired');
      setError(message);
      showToast(message, 'error');
      return;
    }

    setCreating(true);
    setError('');
    try {
      const res = await lucFetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, yuan }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      await switchToAgent(data.id);
      close();
      showToast(t('settings.agent.created', { name: data.name }), 'success');
    } catch (err: any) {
      const message = t('settings.agent.createFailed') + ': ' + err.message;
      setError(message);
      showToast(message, 'error');
    } finally {
      setCreating(false);
    }
  };

  const planCardFile = async (file: File | null | undefined) => {
    if (!file || planning || creating) return;
    setPlanning(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await lucFetch('/api/character-cards/plan', {
        method: 'POST',
        body: form,
        timeout: 90_000,
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setCardPlan(data.plan);
      setImportMemory(false);
    } catch (err: any) {
      showToast(t('settings.characterCard.readFailed') + ': ' + err.message, 'error');
    } finally {
      setPlanning(false);
      setDragActive(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const confirmCardImport = async () => {
    if (!cardPlan?.token || creating) return;
    setCreating(true);
    try {
      const res = await lucFetch('/api/character-cards/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: cardPlan.token, importMemory }),
        timeout: 90_000,
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      await switchToAgent(data.agent.id);
      close();
      showToast(t('settings.agent.created', { name: data.agent.name }), 'success');
    } catch (err: any) {
      showToast(t('settings.characterCard.importFailed') + ': ' + err.message, 'error');
    } finally {
      setCreating(false);
    }
  };

  const types = t('yuan.types') || {};
  const entries = Object.entries(types) as [string, any][];

  return (
    <>
    <Overlay
      scope="inline"
      open={visible && !cardPlan}
      onClose={close}
      backdrop="blur"
      closeOnBackdrop={!creating && !planning}
      closeOnEsc={!creating && !planning}
      zIndex={110}
      className={styles['agent-create-card']}
      disableContainerAnimation
    >
        <h3 className={styles['agent-create-title']}>{t('settings.agent.createTitle')}</h3>
        <div className={styles['settings-form-field']}>
          <input
            ref={inputRef}
            className={styles['settings-input']}
            type="text"
            placeholder={t('settings.agent.namePlaceholder')}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError('');
            }}
            disabled={creating}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); create(); }
              if (e.key === 'Escape' && !creating) close();
            }}
          />
        </div>
        {error && <div className={styles['settings-inline-error']} role="alert">{error}</div>}
        <div className={styles['settings-form-field']}>
          <div className="yuan-selector">
            <div className="yuan-chips">
              {entries.map(([key, meta]) => (
                <button
                  key={key}
                  className={`yuan-chip${key === yuan ? ' selected' : ''}`}
                  type="button"
                  disabled={creating || planning}
                  onClick={() => setYuan(key)}
                >
                  <img className="yuan-chip-avatar" src={`assets/${meta.avatar || 'Luc.png'}`} draggable={false} />
                  <div className="yuan-chip-info">
                    <span className="yuan-chip-name">{key}</span>
                    {/* kong 的 label 是为设置页那条 6:1 横幅写的整句，塞进这里 100px
                        的方片会换行撑高整行，所以单独取一句短的；其它 yuan 的描述
                        本来就短，继续读 label。 */}
                    <span className="yuan-chip-desc">
                      {(key === 'kong' ? meta.shortLabel : undefined) || meta.label || ''}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className={styles['settings-form-field']}>
          <input
            ref={fileRef}
            className={styles['character-card-file-input']}
            type="file"
            accept=".zip,.luc-package,.json,.yaml,.yml"
            onChange={(event) => planCardFile(event.target.files?.[0])}
          />
          <button
            type="button"
            className={`${styles['character-card-drop-target']} ${dragActive ? styles['character-card-drop-target-active'] : ''}`}
            disabled={creating || planning}
            onClick={() => fileRef.current?.click()}
            onDragEnter={(event) => {
              event.preventDefault();
              setDragActive(true);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'copy';
            }}
            onDragLeave={(event) => {
              event.preventDefault();
              setDragActive(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              planCardFile(event.dataTransfer.files?.[0]);
            }}
          >
            <span className={styles['character-card-drop-plus']}>+</span>
            <span>{planning ? t('settings.characterCard.readingCard') : t('settings.characterCard.dropOrClick')}</span>
          </button>
        </div>
        <div className={styles['agent-create-actions']}>
          <button className={styles['agent-create-cancel']} onClick={close} disabled={creating || planning}>{t('settings.agent.cancel')}</button>
          <button className={styles['agent-create-confirm']} onClick={create} disabled={creating}>
            {creating ? t('settings.agent.creating') : t('settings.agent.confirm')}
          </button>
        </div>
    </Overlay>
    {visible && cardPlan && (
      <CharacterCardPreviewOverlay
        plan={cardPlan}
        mode="import"
        memoryChecked={importMemory}
        processing={creating}
        onMemoryChange={setImportMemory}
        onConfirm={confirmCardImport}
        onCancel={close}
      />
    )}
    </>
  );
}
