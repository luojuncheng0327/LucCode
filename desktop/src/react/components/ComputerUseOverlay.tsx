import { useEffect } from 'react';
import { useStore } from '../stores';
import { computerOverlayForSession } from '../stores/computer-overlay-slice';
import { sessionScopedValue } from '../stores/session-slice';
import { getWebSocket } from '../services/websocket';
import styles from './ComputerUseOverlay.module.css';

declare function t(key: string, vars?: Record<string, string | number>): string;

export function ComputerUseOverlay() {
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const currentSessionId = useStore(s => s.currentSessionId);
  const currentStreamId = useStore(s => currentSessionPath
    ? sessionScopedValue(s, s.activeSessionStreams, currentSessionPath)?.streamId || null
    : null);
  const event = useStore(s => computerOverlayForSession(s, currentSessionPath));

  const foregroundTakeover = !!event && event.inputMode === 'foreground-input' && event.phase !== 'done' && event.phase !== 'error';

  useEffect(() => {
    if (!foregroundTakeover || !currentSessionId || !currentSessionPath || !currentStreamId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      getWebSocket()?.send(JSON.stringify({
        type: 'abort',
        sessionId: currentSessionId,
        sessionPath: currentSessionPath,
        streamId: currentStreamId,
      }));
      useStore.getState().clearComputerOverlayForSession(currentSessionPath);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [currentSessionId, currentSessionPath, currentStreamId, foregroundTakeover]);

  if (!event || !foregroundTakeover) return null;

  return (
    <div className={styles.overlay}>
      <div className={styles.takeoverNotice} role="status">
        <strong>{t('computerUse.overlay.foregroundTakeover')}</strong>
        <span>{t('computerUse.overlay.foregroundMessage')}</span>
      </div>
    </div>
  );
}
