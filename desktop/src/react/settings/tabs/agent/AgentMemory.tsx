import React, { useEffect, useState } from 'react';
import { useSettingsStore } from '../../store';
import { t, autoSaveConfig, savePins } from '../../helpers';
import { lucFetch } from '../../api';
import { PinItem } from './AgentPins';
import { SettingsSection } from '../../components/SettingsSection';
import { Toggle } from '@/ui';
import { AgentMemoryDream } from './AgentMemoryDream';
import styles from '../../Settings.module.css';

type MemoryHealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'disabled' | 'unavailable';

type MemoryStepHealth = {
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorMsg: string | null;
  failCount: number;
};

type MemoryHealthPayload = {
  agentId: string;
  status: MemoryHealthStatus;
  reason: string | null;
  enabled: boolean;
  steps: Record<string, MemoryStepHealth>;
  failedSteps: string[];
  maxFailCount: number;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
};

const healthToneByStatus: Record<MemoryHealthStatus, string> = {
  healthy: 'ok',
  degraded: 'attention',
  unhealthy: 'error',
  disabled: 'muted',
  unavailable: 'muted',
};

function formatHealthTime(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function memoryStepLabel(step: string): string {
  const key = `settings.memory.health.steps.${step}`;
  const label = t(key);
  return label === key ? step : label;
}

function formatFailedStepLabels(steps: string[]): string {
  const labels = steps.map(memoryStepLabel);
  if (labels.length <= 1) return labels[0] || '';
  const sepKey = 'settings.memory.health.stepSeparator';
  const separator = t(sepKey);
  return labels.join(separator === sepKey ? ', ' : separator);
}

function pickLastErrorMessage(health: MemoryHealthPayload): string | null {
  for (const step of health.failedSteps) {
    const message = health.steps[step]?.lastErrorMsg;
    if (message) return message;
  }
  return null;
}

function MemoryHealthNotice({ health, error }: {
  health: MemoryHealthPayload | null;
  error: string | null;
}) {
  if (!error && (!health || health.status === 'healthy')) return null;

  const status: MemoryHealthStatus = error ? 'unavailable' : (health?.status || 'unavailable');
  const tone = healthToneByStatus[status];
  const failedStepLabels = health ? formatFailedStepLabels(health.failedSteps) : '';
  const lastErrorAt = formatHealthTime(health?.lastErrorAt || null);
  const lastErrorMessage = health ? pickLastErrorMessage(health) : null;

  return (
    <div className={`${styles['memory-health-strip']} ${styles[`memory-health-${tone}`]}`} role="status">
      <div className={styles['memory-health-main']}>
        <span className={styles['memory-health-dot']} />
        <span className={styles['memory-health-title']}>{t(`settings.memory.health.${status}`)}</span>
      </div>
      <div className={styles['memory-health-detail']}>
        {failedStepLabels && (
          <span>{t('settings.memory.health.failedSteps', { steps: failedStepLabels })}</span>
        )}
        {lastErrorAt && (
          <span>{t('settings.memory.health.lastError', { time: lastErrorAt })}</span>
        )}
        {lastErrorMessage && (
          <span>{t('settings.memory.health.errorMessage', { message: lastErrorMessage })}</span>
        )}
      </div>
    </div>
  );
}

export function MemorySection({ agentId, hasUtilityModel, memoryEnabled, autoDreamEnabled = false, currentPins }: {
  agentId: string | null;
  hasUtilityModel: boolean | undefined;
  memoryEnabled: boolean | undefined;
  autoDreamEnabled?: boolean;
  currentPins: string[];
}) {
  const [pinInput, setPinInput] = useState('');
  const [health, setHealth] = useState<MemoryHealthPayload | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  useEffect(() => {
    if (!agentId || hasUtilityModel !== true || memoryEnabled !== true) {
      setHealth(null);
      setHealthError(null);
      return;
    }

    const controller = new AbortController();
    let active = true;
    setHealthError(null);

    lucFetch(`/api/memories/health?agentId=${encodeURIComponent(agentId)}`, {
      signal: controller.signal,
      timeout: 10_000,
    })
      .then((res) => res.json())
      .then((data: MemoryHealthPayload) => {
        if (!active) return;
        setHealth(data);
      })
      .catch((err) => {
        if (!active || controller.signal.aborted) return;
        setHealth(null);
        setHealthError(err?.message || String(err));
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [agentId, hasUtilityModel, memoryEnabled]);

  const addPin = () => {
    const val = pinInput.trim();
    if (!val) return;
    const newPins = [...currentPins, val];
    useSettingsStore.setState({ currentPins: newPins });
    setPinInput('');
    savePins();
  };

  const deletePin = (index: number) => {
    const newPins = [...currentPins];
    newPins.splice(index, 1);
    useSettingsStore.setState({ currentPins: newPins });
    savePins();
  };

  /* 记忆开关作为 section title 右侧 context（和 WorkTab 的 AgentSelect 作 context 同构）
   * hasUtilityModel=false 时 toggle 禁用，below 显示提示 */
  const utilityModelReady = hasUtilityModel !== undefined;
  const memoryToggleOn = !utilityModelReady ? undefined : hasUtilityModel ? memoryEnabled : false;
  const memoryToggle = (
    <Toggle
      on={memoryToggleOn}
      onChange={(enabled) => {
        if (hasUtilityModel) autoSaveConfig({ memory: { enabled } });
      }}
      disabled={!utilityModelReady || !hasUtilityModel}
      title={utilityModelReady && !hasUtilityModel ? t('settings.memory.needsUtilityModel') : undefined}
    />
  );

  return (
    <SettingsSection title={t('settings.memory.sectionTitle')} context={memoryToggle}>
      <div style={{ padding: 'var(--space-8) var(--space-16)' }}>
        {utilityModelReady && !hasUtilityModel && (
          <p className={styles['settings-inline-note']} style={{ opacity: 0.6, marginTop: 0, marginBottom: 'var(--space-16)' }}>{t('settings.memory.needsUtilityModel')}</p>
        )}

        <div className={hasUtilityModel !== true || memoryEnabled !== true ? 'settings-disabled' : ''}>
          <MemoryHealthNotice health={health} error={healthError} />

          <div className={styles['settings-subsection']}>
            <div className={styles['settings-subsection-header']}>
              <h3 className={styles['settings-subsection-title']}>{t('settings.pins.title')}</h3>
              <span className={styles['settings-subsection-hint']}>{t('settings.pins.hint')}</span>
            </div>
            <div className={styles['pin-list']}>
              {currentPins.length === 0 ? (
                <div className={styles['pin-empty']}>{t('settings.pins.empty')}</div>
              ) : (
                currentPins.map((pin, i) => (
                  <PinItem key={pin} text={pin} index={i} onDelete={deletePin} />
                ))
              )}
            </div>
            <div className={styles['pin-add-row']}>
              <input
                className={`${styles['settings-input']} ${styles['pin-add-input']}`}
                type="text"
                value={pinInput}
                onChange={(e) => setPinInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addPin(); } }}
                placeholder={t('settings.pins.addPlaceholder')}
              />
              <button className={styles['pin-add-btn']} onClick={addPin}>+</button>
            </div>
          </div>

          <div className={styles['settings-subsection']}>
            <div className={styles['settings-subsection-header']}>
              <h3 className={styles['settings-subsection-title']}>{t('settings.memory.compiled')}</h3>
              <span className={styles['settings-subsection-hint']}>{t('settings.memory.compiledHint')}</span>
            </div>
            <button
              className={`${styles['memory-action-btn']} ${styles['compiled-view-btn']}`}
              onClick={() => window.dispatchEvent(new Event('luc-view-compiled-memory'))}
            >
              {t('settings.memory.compiledView')}
            </button>
          </div>

          {agentId && (
            <AgentMemoryDream agentId={agentId} autoEnabled={autoDreamEnabled} />
          )}

          <div className={styles['settings-subsection']}>
            <h3 className={styles['settings-subsection-title']}>{t('settings.memory.allMemories')}</h3>
            <div className={`${styles['memory-actions-row']} ${styles['memory-actions-spaced']}`}>
              <button
                className={styles['memory-action-btn']}
                onClick={() => window.dispatchEvent(new Event('luc-view-memories'))}
              >
                {t('settings.memory.actions.view')}
              </button>
              <button
                className={`${styles['memory-action-btn']} ${styles['danger']}`}
                onClick={() => window.dispatchEvent(new Event('luc-show-clear-confirm'))}
              >
                {t('settings.memory.actions.clear')}
              </button>
            </div>
          </div>
        </div>{/* settings-disabled wrapper */}
      </div>
    </SettingsSection>
  );
}
