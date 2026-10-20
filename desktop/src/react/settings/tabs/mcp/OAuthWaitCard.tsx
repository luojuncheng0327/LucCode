import React from 'react';
import { t } from '../../helpers';
import styles from '../../Settings.module.css';

interface OAuthWaitCardProps {
  connectorId: string;
  connected: boolean;
  /** True while a browser round trip for this connector is outstanding. */
  waiting: boolean;
  busy: boolean;
  onStart: (connectorId: string) => void;
  onCancel: (connectorId: string) => void;
  onLogout: (connectorId: string) => void;
}

/**
 * The OAuth connect control and, while a login is outstanding, the wait itself.
 *
 * The wait is a card rather than a modal state: the browser trip can take as
 * long as the user needs, and nothing else in settings should be frozen behind
 * it. It can also be called off, which is the only way out that does not
 * involve waiting for a timeout.
 */
export function OAuthWaitCard({
  connectorId,
  connected,
  waiting,
  busy,
  onStart,
  onCancel,
  onLogout,
}: OAuthWaitCardProps) {
  if (waiting) {
    return (
      <div className={styles['mcp-oauth-card']} data-testid="mcp-oauth-waiting">
        <div className={styles['skills-list-info']}>
          <div className={styles['skills-list-name']}>{t('settings.mcp.oauthWaiting')}</div>
          <div className={styles['skills-list-desc']}>{t('settings.mcp.oauthWaitingHint')}</div>
        </div>
        <div className={styles['skills-list-actions']}>
          <button
            className={styles['pv-add-form-btn']}
            type="button"
            onClick={() => onCancel(connectorId)}
          >
            {t('common.cancel')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles['mcp-oauth-card']}>
      <div className={styles['skills-list-info']}>
        <div className={styles['skills-list-name']}>
          {connected ? t('settings.mcp.oauthConnected') : t('settings.mcp.oauthDisconnected')}
        </div>
      </div>
      <div className={styles['skills-list-actions']}>
        {connected ? (
          <button
            className={styles['pv-add-form-btn']}
            type="button"
            disabled={busy}
            onClick={() => onLogout(connectorId)}
          >
            {t('settings.oauth.logout')}
          </button>
        ) : (
          <button
            className={`${styles['pv-add-form-btn']} ${styles['primary']}`}
            type="button"
            onClick={() => onStart(connectorId)}
          >
            {t('settings.mcp.oauthConnect')}
          </button>
        )}
      </div>
    </div>
  );
}
