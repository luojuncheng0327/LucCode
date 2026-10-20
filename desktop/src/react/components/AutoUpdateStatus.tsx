import React from 'react';
import type { AutoUpdateState, ReleaseDigest } from '../types';
import { Overlay } from '../ui/Overlay';
import { digestLocale, digestText, kindLabel } from './shared/release-digest-text';
import styles from './AutoUpdateStatus.module.css';

interface AutoUpdateStatusProps {
  state: AutoUpdateState | null;
  agentName?: string;
  onInstall?: () => void | Promise<unknown>;
  /**
   * 'shell'（默认既有行为）= electron-updater 的"重启更新"语义：装好后
   * 需要重启进程才生效，按钮文案与手动重启提示保持原样。
   * 'train' = 列车更新的"刷新即生效"语义：按钮文案是"更新"，
   * 不需要重启提示——即使不点，也会在下次自然启动时自动生效，用一句不同
   * 的提示语说明这点，而不是复用壳更新"退出不会自动安装"的措辞。
   */
  variant: 'shell' | 'train';
}

const t = (key: string, vars?: Record<string, string | number>) => window.t?.(key, vars) ?? key;

function percentOf(state: AutoUpdateState): number {
  const rawPercent = state.progress?.percent ?? 0;
  return Math.max(0, Math.min(100, Math.round(rawPercent)));
}

function InstallIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 2v6h-6" />
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M3 22v-6h6" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    </svg>
  );
}

function hasVisibleDigest(digest: ReleaseDigest | null | undefined): digest is ReleaseDigest {
  return Boolean(digest && (!digest.noUserFacingChanges || digest.items.length > 0));
}

function ReleaseDigestEntry({ digest }: { digest: ReleaseDigest | null | undefined }) {
  const [open, setOpen] = React.useState(false);
  if (!hasVisibleDigest(digest)) return null;

  const locale = digestLocale();
  const titleId = `release-digest-${digest.tag || digest.version || 'current'}`;

  return (
    <>
      <button type="button" className={styles.digestTrigger} onClick={() => setOpen(true)}>
        {t('settings.about.updateDigestCta')}
      </button>
      <Overlay
        scope="inline"
        open={open}
        onClose={() => setOpen(false)}
        className={styles.digestDialog}
        zIndex={1400}
      >
        <section role="dialog" aria-modal="true" aria-labelledby={titleId} className={styles.digestPanel}>
          <div className={styles.digestHeader}>
            <div>
              <div className={styles.digestEyebrow}>{digest.tag}</div>
              <h2 id={titleId} className={styles.digestTitle}>{t('settings.about.updateDigestTitle')}</h2>
            </div>
            <button type="button" className={styles.digestClose} onClick={() => setOpen(false)}>
              {t('settings.about.updateDigestClose')}
            </button>
          </div>

          <p className={styles.digestSummary}>{digestText(digest.summary, locale)}</p>

          <div className={styles.digestList}>
            {digest.items.map((item, index) => (
              <article key={item.id || `${item.kind}-${index}`} className={styles.digestItem}>
                <div className={styles.digestItemMeta}>
                  <span className={styles.digestKind}>{kindLabel(item.kind)}</span>
                </div>
                <h3 className={styles.digestItemTitle}>{digestText(item.title, locale)}</h3>
                <p className={styles.digestItemSummary}>{digestText(item.summary, locale)}</p>
                {item.details.length > 0 && (
                  <ul className={styles.digestDetails}>
                    {item.details.map((detail, detailIndex) => (
                      <li key={detailIndex}>{digestText(detail, locale)}</li>
                    ))}
                  </ul>
                )}
              </article>
            ))}
          </div>
        </section>
      </Overlay>
    </>
  );
}

export function AutoUpdateStatus({ state, agentName = 'Luc', onInstall, variant }: AutoUpdateStatusProps) {
  if (!state || state.status === 'idle') {
    return null;
  }

  if (state.status === 'downloading') {
    const percent = percentOf(state);
    return (
      <div className={styles.root}>
        <div className={styles.column}>
          <div className={styles.downloadHeader}>
            <span className={styles.message}>
              {t('settings.about.updateDownloading', { agentName })}
            </span>
            <span className={styles.progressValue}>{t('settings.about.updateProgress', { percent })}</span>
          </div>
          <div className={styles.barTrack} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
            <div className={styles.barFill} style={{ width: `${percent}%` }} />
          </div>
          <ReleaseDigestEntry digest={state.digest} />
        </div>
      </div>
    );
  }

  if (state.status === 'downloaded') {
    const actionLabel = variant === 'train' ? t('settings.about.updateApply') : t('settings.about.updateInstall');
    const hintText = variant === 'train' ? t('settings.about.updateApplyAutoHint') : t('settings.about.updateInstallManualHint');
    return (
      <div className={styles.root}>
        <div className={styles.column}>
          <div className={styles.row}>
            <span className={styles.message}>{t('settings.about.updateReadyInstall', { version: state.version ?? '' })}</span>
            {onInstall && (
              <button type="button" className={styles.action} onClick={() => void onInstall()}>
                <span>{actionLabel}</span>
                <InstallIcon />
              </button>
            )}
            <ReleaseDigestEntry digest={state.digest} />
          </div>
          <div className={`${styles.message} ${styles.hint}`}>{hintText}</div>
        </div>
      </div>
    );
  }

  if (state.status === 'error') {
    const message = state.error === 'disk_space_insufficient'
      ? t('settings.about.updateDiskSpace')
      : state.error === 'running_from_dmg'
        ? t('settings.about.updateNeedInstall')
        : t('settings.about.updateError');

    return (
      <div className={styles.root}>
        <div className={styles.row}>
          <span className={`${styles.message} ${styles.error}`}>{message}</span>
          {state.error && state.error !== 'disk_space_insufficient' && state.error !== 'running_from_dmg' && (
            <span className={styles.errorDetail} title={state.error}>{state.error}</span>
          )}
        </div>
      </div>
    );
  }

  const messages: Partial<Record<AutoUpdateState['status'], string>> = {
    checking: t('settings.about.updateChecking'),
    available: t('settings.about.updateAvailable', { version: state.version ?? '' }),
    installing: t('settings.about.updateInstalling'),
    latest: t('settings.about.updateLatest'),
  };

  const message = messages[state.status];
  if (!message) {
    return null;
  }

  return (
    <div className={styles.root}>
      <div className={styles.row}>
        <span className={styles.message}>{message}</span>
        {(state.status === 'available' || state.status === 'installing') && (
          <ReleaseDigestEntry digest={state.digest} />
        )}
      </div>
    </div>
  );
}
