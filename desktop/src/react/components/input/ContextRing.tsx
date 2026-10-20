import { useState, useEffect, useCallback, useRef } from 'react';
import { useStore } from '../../stores';
import { getSessionCompactionMode, isSessionCompacting } from '../../stores/context-slice';
import { sessionScopedListIncludes, sessionScopedValue } from '../../stores/session-slice';
import { useI18n } from '../../hooks/use-i18n';
import { getWebSocket } from '../../services/websocket';
import { lucFetch } from '../../hooks/use-luc-fetch';
import { refreshSessionCapabilities } from '../../stores/session-actions';
import { AnchoredPortal, Tooltip } from '../../ui';
import { shouldShowContextRingTokenLabel } from './context-ring-visibility';
import {
  INSTANT_SIMPLE_COMPACTION_EXPERIMENT_ID,
  INSTANT_SIMPLE_COMPACTION_METHOD,
} from '../../../../../shared/compaction-mode.ts';
import styles from './InputArea.module.css';

export function ContextRing() {
  const { t } = useI18n();
  const agentYuan = useStore(s => s.agentYuan);
  const [tokens, setTokens] = useState<number | null>(null);
  const [contextWindow, setContextWindow] = useState<number | null>(null);
  const [percent, setPercent] = useState<number | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [instantSimpleEnabled, setInstantSimpleEnabled] = useState(false);
  const anchorRef = useRef<HTMLElement | null>(null);

  // 从 Zustand store 同步 context 数据（keyed store 优先，compat global 兜底）
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const currentSessionId = useStore(s => s.currentSessionId);
  const addToast = useStore(s => s.addToast);
  const contextEntry = useStore(s => (
    s.currentSessionPath ? sessionScopedValue(s, s.contextBySession, s.currentSessionPath) : null
  ));
  const globalContextTokens = useStore(s => s.contextTokens);
  const globalContextWindow = useStore(s => s.contextWindow);
  const globalContextPercent = useStore(s => s.contextPercent);
  const storeContextTokens = contextEntry?.tokens ?? globalContextTokens;
  const storeContextWindow = contextEntry?.window ?? globalContextWindow;
  const storeContextPercent = contextEntry?.percent ?? globalContextPercent;
  const storeCompacting = useStore(s => isSessionCompacting(s, currentSessionPath));
  const compactionMode = useStore(s => getSessionCompactionMode(s, currentSessionPath));
  const refreshing = useStore(s => sessionScopedListIncludes(s, s.capabilityRefreshingSessions, currentSessionPath));
  const busy = compacting || refreshing;

  useEffect(() => {
    setTokens(storeContextTokens ?? null);
    setContextWindow(storeContextWindow ?? null);
    setPercent(storeContextPercent ?? null);
    setCompacting(storeCompacting);
  }, [storeContextTokens, storeContextWindow, storeContextPercent, storeCompacting]);

  useEffect(() => {
    setMenuOpen(false);
  }, [currentSessionPath]);

  useEffect(() => {
    let disposed = false;
    const applyExperimentValue = (value: unknown) => {
      if (!disposed) setInstantSimpleEnabled(value === true);
    };
    const onSettings = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (
        detail?.type === 'experiment-changed'
        && detail.id === INSTANT_SIMPLE_COMPACTION_EXPERIMENT_ID
      ) {
        applyExperimentValue(detail.value);
      }
    };

    window.addEventListener('luc-settings', onSettings);
    void lucFetch('/api/experiments')
      .then((res) => res.json())
      .then((data) => {
        if (data?.error) throw new Error(data.error);
        const experiment = Array.isArray(data?.experiments)
          ? data.experiments.find((item: any) => item?.id === INSTANT_SIMPLE_COMPACTION_EXPERIMENT_ID)
          : null;
        applyExperimentValue(experiment?.value);
      })
      .catch((error) => {
        console.warn('[context-ring] failed to load instant compaction experiment:', error);
      });

    return () => {
      disposed = true;
      window.removeEventListener('luc-settings', onSettings);
    };
  }, []);

  const handleClick = useCallback(() => {
    if (busy) return;
    setMenuOpen(open => !open);
  }, [busy]);

  const handleRefreshAndCompact = useCallback(() => {
    if (!currentSessionPath || busy) return;
    setMenuOpen(false);
    void refreshSessionCapabilities(currentSessionPath);
  }, [busy, currentSessionPath]);

  const requestCompaction = useCallback((method?: string) => {
    if (!currentSessionPath || busy) return;
    setMenuOpen(false);
    if (!currentSessionId) {
      addToast(t('error.noActiveSession'), 'error', 6000);
      return;
    }
    const ws = getWebSocket();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      addToast(t('status.disconnected'), 'error', 6000);
      return;
    }
    ws.send(JSON.stringify({
      type: 'compact',
      sessionId: currentSessionId,
      ...(method ? { method } : {}),
    }));
  }, [addToast, busy, currentSessionId, currentSessionPath, t]);

  const handleCompact = useCallback(() => {
    requestCompaction();
  }, [requestCompaction]);

  const handleInstantSimpleCompact = useCallback(() => {
    requestCompaction(INSTANT_SIMPLE_COMPACTION_METHOD);
  }, [requestCompaction]);

  if (!currentSessionPath) return null;
  const displayTokens = tokens ?? 0;
  const pct = percent ?? 0;
  const showTokenLabel = shouldShowContextRingTokenLabel(tokens);

  // SVG 圆环参数（更小更粗）
  const r = 6;
  const sw = 2.5;
  const size = (r + sw) * 2;
  const center = size / 2;
  const circumference = 2 * Math.PI * r;
  const strokeDashoffset = circumference * (1 - Math.min(pct, 100) / 100);
  const yuan = agentYuan || 'luc';

  // token 数量格式化
  const tokensK = Math.round(displayTokens / 1000);
  const windowK = contextWindow != null ? Math.round(contextWindow / 1000) : 0;

  const tooltipContent = (
    <>
      {compacting && compactionMode === 'lossy_local' && (
        <div>{t('chat.instantSimpleCompaction')}</div>
      )}
      <div>{t('input.contextWindow', { windowK })}</div>
      {tokens != null && (
        <div>{t('input.tokensUsed', { tokensK, pct: Math.round(pct) })}</div>
      )}
    </>
  );

  return (
    <>
      <Tooltip content={tooltipContent} placement="top" align="end" disabled={menuOpen}>
        {({ ref, ...tooltipProps }) => (
          <span
            className={styles['context-ring-wrap']}
            ref={(node) => {
              anchorRef.current = node;
              ref(node);
            }}
            {...tooltipProps}
          >
            <button
              className={`${styles['context-ring']}${compacting ? ` ${styles.compacting}` : ''}`}
              data-yuan={yuan}
              onClick={handleClick}
              disabled={busy}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={t('input.contextActions')}
            >
              <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
                <circle cx={center} cy={center} r={r} fill="none" stroke="var(--ring-bg)" strokeWidth={sw} />
                <circle
                  cx={center} cy={center} r={r}
                  fill="none"
                  stroke="var(--ring-fg)"
                  strokeWidth={sw}
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={strokeDashoffset}
                  transform={`rotate(-90 ${center} ${center})`}
                  className={styles['context-ring-progress']}
                />
              </svg>
              {showTokenLabel && (
                <span className={styles['context-ring-label']}>{tokensK}k</span>
              )}
            </button>
          </span>
        )}
      </Tooltip>
      <AnchoredPortal
        open={menuOpen}
        anchorRef={anchorRef}
        className={styles['context-ring-menu']}
        role="menu"
        align="end"
        offset={6}
        onClose={() => setMenuOpen(false)}
      >
        <button
          type="button"
          className={styles['context-ring-menu-item']}
          role="menuitem"
          onClick={handleCompact}
          disabled={busy}
        >
          {t('input.compact')}
        </button>
        <Tooltip
          content={t('input.refreshAndCompactTooltip')}
          placement="left"
          align="center"
        >
          {({ ref, ...tooltipProps }) => (
            <button
              type="button"
              ref={ref}
              className={styles['context-ring-menu-item']}
              role="menuitem"
              onClick={handleRefreshAndCompact}
              disabled={busy}
              {...tooltipProps}
            >
              {t('input.refreshAndCompact')}
            </button>
          )}
        </Tooltip>
        {instantSimpleEnabled && (
          <button
            type="button"
            className={styles['context-ring-menu-item']}
            role="menuitem"
            onClick={handleInstantSimpleCompact}
            disabled={busy}
          >
            {t('chat.instantSimpleCompaction')}
          </button>
        )}
      </AnchoredPortal>
    </>
  );
}
