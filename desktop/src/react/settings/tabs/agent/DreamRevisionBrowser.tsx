import { useCallback, useEffect, useState } from 'react';
import { Button, Overlay } from '@/ui';
import { t } from '../../helpers';
import {
  loadDreamRevision,
  loadDreamRevisions,
  restoreDream,
  type DreamRevisionDetail,
  type DreamRevisionSummary,
} from './agent-memory-dream-actions';
import styles from './DreamRevisionBrowser.module.css';
import { dreamErrorText } from './dream-error-presenter';

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function DreamRevisionBrowser({
  agentId,
  open,
  onClose,
}: {
  agentId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [revisions, setRevisions] = useState<DreamRevisionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DreamRevisionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const next = await loadDreamRevisions(agentId, signal);
      setRevisions(next);
      setSelectedId((current) => current && next.some((item) => item.revisionId === current)
        ? current
        : next[0]?.revisionId || null);
      setError(null);
    } catch (err: unknown) {
      if (signal?.aborted) return;
      setError(dreamErrorText(err, 'settings.memory.dream.errors.revisionsLoadFailed'));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    if (!open) return undefined;
    const controller = new AbortController();
    setMessage(null);
    setConfirming(false);
    void refresh(controller.signal);
    return () => controller.abort();
  }, [open, refresh]);

  useEffect(() => {
    if (!open || !selectedId) {
      setDetail(null);
      return undefined;
    }
    const controller = new AbortController();
    setDetail(null);
    setDetailLoading(true);
    setConfirming(false);
    void loadDreamRevision(agentId, selectedId, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) {
          setDetail(next);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          setDetail(null);
          setError(dreamErrorText(err, 'settings.memory.dream.errors.revisionLoadFailed'));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [agentId, open, selectedId]);

  const restoreSelected = async () => {
    if (!selectedId) return;
    setRestoring(true);
    try {
      await restoreDream(agentId, selectedId);
      setMessage(t('settings.memory.dream.revisions.restored'));
      setConfirming(false);
      setError(null);
      await refresh();
    } catch (err: unknown) {
      setError(dreamErrorText(err, 'settings.memory.dream.errors.restoreFailed'));
    } finally {
      setRestoring(false);
    }
  };

  const sections = detail ? [
    { key: 'facts', title: t('settings.memory.editableFactsLabel'), body: detail.before.facts },
    { key: 'today', title: t('settings.memory.sections.today'), body: detail.before.today },
  ] : [];

  return (
    <Overlay
      scope="inline"
      open={open}
      onClose={onClose}
      backdrop="blur"
      zIndex={110}
      className={styles.dialog}
      contained
      contentProps={{ role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'dream-revisions-title' }}
    >
      <header className={styles.header}>
        <h3 className={styles.title} id="dream-revisions-title">
          {t('settings.memory.dream.revisions.title')}
        </h3>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('settings.memory.dream.revisions.close')}
        </Button>
      </header>

      <div className={styles.body}>
        <div className={styles.list} aria-label={t('settings.memory.dream.revisions.listLabel')}>
          {loading ? (
            <div className={styles.empty}>{t('settings.memory.dream.revisions.loading')}</div>
          ) : revisions.length === 0 ? (
            <div className={styles.empty}>{t('settings.memory.dream.revisions.empty')}</div>
          ) : revisions.map((revision) => (
            <button
              key={revision.revisionId}
              type="button"
              className={`${styles.revisionButton} ${selectedId === revision.revisionId ? styles.revisionButtonActive : ''}`}
              onClick={() => setSelectedId(revision.revisionId)}
              aria-current={selectedId === revision.revisionId ? 'true' : undefined}
            >
              <span className={styles.revisionTime}>{formatTime(revision.createdAt)}</span>
              <span className={styles.revisionMeta}>
                {t(revision.kind === 'pre_restore'
                  ? 'settings.memory.dream.revisions.preRestore'
                  : revision.trigger === 'automatic'
                    ? 'settings.memory.dream.revisions.automatic'
                    : 'settings.memory.dream.revisions.manual')}
                {' · '}{revision.bodyChars} {t('settings.memory.dream.revisions.characters')}
              </span>
            </button>
          ))}
        </div>

        <div className={styles.detail}>
          {detailLoading ? (
            <div className={styles.empty}>{t('settings.memory.dream.revisions.loading')}</div>
          ) : detail ? (
            <>
              {sections.map((section) => (
                <section className={styles.section} key={section.key}>
                  <h4 className={styles.sectionTitle}>{section.title}</h4>
                  <pre className={styles.sectionBody}>{section.body || t('settings.memory.dream.revisions.noContent')}</pre>
                </section>
              ))}
              <section className={styles.section}>
                <h4 className={styles.sectionTitle}>{t('settings.memory.sections.week')}</h4>
                {detail.before.weekDays.length === 0 ? (
                  <pre className={styles.sectionBody}>{t('settings.memory.dream.revisions.noContent')}</pre>
                ) : detail.before.weekDays.map((day) => (
                  <div className={styles.weekDay} key={day.date}>
                    <span className={styles.weekDate}>{day.date}</span>
                    <pre className={styles.sectionBody}>{day.body || t('settings.memory.dream.revisions.noContent')}</pre>
                  </div>
                ))}
              </section>
              <section className={styles.section}>
                <h4 className={styles.sectionTitle}>{t('settings.memory.sections.longterm')}</h4>
                <pre className={styles.sectionBody}>
                  {detail.before.longterm || t('settings.memory.dream.revisions.noContent')}
                </pre>
              </section>
            </>
          ) : null}
        </div>
      </div>

      {error && <div className={styles.error} role="alert">{error}</div>}
      {message && <div className={styles.message} role="status">{message}</div>}

      <footer className={styles.footer}>
        <span className={styles.confirmText}>
          {confirming ? t('settings.memory.dream.revisions.confirmHint') : ''}
        </span>
        {confirming ? (
          <div className={styles.confirm}>
            <Button size="sm" onClick={() => setConfirming(false)} disabled={restoring}>
              {t('settings.memory.dream.revisions.cancel')}
            </Button>
            <Button variant="primary" size="sm" loading={restoring} onClick={() => { void restoreSelected(); }}>
              {t('settings.memory.dream.revisions.confirmRestore')}
            </Button>
          </div>
        ) : (
          <Button
            variant="primary"
            size="sm"
            disabled={!detail || detail.revisionId !== selectedId || detailLoading}
            onClick={() => setConfirming(true)}
          >
            {t('settings.memory.dream.revisions.restoreThis')}
          </Button>
        )}
      </footer>
    </Overlay>
  );
}
