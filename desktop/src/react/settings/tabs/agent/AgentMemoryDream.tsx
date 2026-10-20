import { useEffect, useState } from 'react';
import { Toggle } from '@/ui';
import { t } from '../../helpers';
import { SettingsRow } from '../../components/SettingsRow';
import {
  loadDreamStatus,
  saveDreamAutoEnabled,
  startDream,
  type DreamStatus,
} from './agent-memory-dream-actions';
import { DreamRevisionBrowser } from './DreamRevisionBrowser';
import { dreamErrorText, dreamReportErrorText } from './dream-error-presenter';
import styles from '../../Settings.module.css';

function formatTime(value: string | null | undefined) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function AgentMemoryDream({
  agentId,
  autoEnabled,
}: {
  agentId: string;
  autoEnabled: boolean;
}) {
  const [status, setStatus] = useState<DreamStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingAuto, setSavingAuto] = useState(false);
  const [revisionsOpen, setRevisionsOpen] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    const refresh = async () => {
      try {
        const next = await loadDreamStatus(agentId, controller.signal);
        if (!active) return;
        setStatus(next);
        setError(null);
      } catch (err: unknown) {
        if (!active || controller.signal.aborted) return;
        setError(dreamErrorText(err, 'settings.memory.dream.errors.statusLoadFailed'));
      }
    };

    void refresh();
    return () => {
      active = false;
      controller.abort();
    };
  }, [agentId]);

  useEffect(() => {
    if (status?.status !== 'running') return undefined;
    const controller = new AbortController();
    let inFlight = false;
    const timer = setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await loadDreamStatus(agentId, controller.signal);
        setStatus(next);
        setError(null);
      } catch (err: unknown) {
        if (controller.signal.aborted) return;
        setError(dreamErrorText(err, 'settings.memory.dream.errors.statusLoadFailed'));
      } finally {
        inFlight = false;
      }
    }, 1500);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [agentId, status?.status, status?.runId]);

  const run = async () => {
    try {
      setError(null);
      const next = await startDream(agentId);
      setStatus(next);
    } catch (err: unknown) {
      setError(dreamErrorText(err, 'settings.memory.dream.errors.startFailed'));
    }
  };

  const saveAuto = async (enabled: boolean) => {
    setSavingAuto(true);
    try {
      await saveDreamAutoEnabled(agentId, enabled);
      setError(null);
    } catch (err: unknown) {
      setError(dreamErrorText(err, 'settings.memory.dream.errors.autoSaveFailed'));
    } finally {
      setSavingAuto(false);
    }
  };

  const running = status?.status === 'running';
  const report = status?.lastRun;

  return (
    <div className={styles['memory-dream-panel']}>
      <div className={styles['settings-subsection-header']}>
        <h3 className={styles['settings-subsection-title']}>{t('settings.memory.dream.title')}</h3>
        <span className={styles['settings-subsection-hint']}>{t('settings.memory.dream.hint')}</span>
      </div>

      <SettingsRow
        label={t('settings.memory.dream.autoLabel')}
        hint={t('settings.memory.dream.autoHint')}
        control={(
          <Toggle
            on={autoEnabled}
            onChange={(enabled) => { void saveAuto(enabled); }}
            disabled={savingAuto}
          />
        )}
      />

      <div className={styles['memory-actions-row']}>
        <button
          className={styles['memory-action-btn']}
          disabled={running}
          onClick={() => { void run(); }}
        >
          {running ? t('settings.memory.dream.running') : t('settings.memory.dream.run')}
        </button>
        <button
          className={styles['memory-action-btn']}
          disabled={running}
          onClick={() => setRevisionsOpen(true)}
        >
          {t('settings.memory.dream.restore')}
        </button>
      </div>

      {report?.status === 'succeeded' && (
        <div className={styles['memory-dream-status']} role="status">
          {report.changed === false
            ? t('settings.memory.dream.unchanged', { time: formatTime(report.finishedAt) })
            : report.changed === true
              ? t('settings.memory.dream.success', {
                time: formatTime(report.finishedAt),
                before: report.beforeChars,
                after: report.afterChars,
                merged: report.mergedCount,
                forgotten: report.forgottenCount,
              })
              : t('settings.memory.dream.legacySuccess', {
                time: formatTime(report.finishedAt),
                before: report.beforeChars,
                after: report.afterChars,
              })}
          <button
            className={styles['memory-dream-link']}
            onClick={() => window.dispatchEvent(new Event('luc-view-compiled-memory'))}
          >
            {t('settings.memory.dream.view')}
          </button>
        </div>
      )}
      {(error || report?.status === 'failed') && (
        <div className={styles['memory-dream-error']} role="alert">
          {error || (report ? dreamReportErrorText(report) : t('settings.memory.dream.failed'))}
        </div>
      )}
      <DreamRevisionBrowser
        agentId={agentId}
        open={revisionsOpen}
        onClose={() => setRevisionsOpen(false)}
      />
    </div>
  );
}
