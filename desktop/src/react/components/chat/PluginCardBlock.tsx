import { useEffect, useState } from 'react';
import { usePluginIframe } from '../../hooks/use-plugin-iframe';
import { usePluginSurfaceUrl } from '../../hooks/use-plugin-surface-url';
import { useStore } from '../../stores';
import { loadMessages } from '../../stores/session-actions';
import { sessionScopedValue } from '../../stores/session-slice';
import type { PluginCardDetails } from '../../types';
import { ChatMessageSurface } from './ChatMessageSurface';
import s from './PluginCardBlock.module.css';

interface Props {
  card: PluginCardDetails;
  agentId?: string | null;
}

const MAX_W = 400;
const MAX_H = 600;
const EMPTY_CAPABILITY_GRANTS: readonly string[] = [];

function parseRatio(raw?: string): number {
  if (!raw) return 0;
  const [w, h] = raw.split(':').map(Number);
  return (w && h) ? w / h : 0;
}

function isIframeCard(card: PluginCardDetails): boolean {
  return !card.type || card.type === 'iframe' || card.type === 'webview';
}

function chatSurfaceSession(card: PluginCardDetails): { sessionId: string | null; sessionPath: string | null } {
  const sessionRef = card.sessionRef || null;
  const sessionId = card.sessionId || sessionRef?.sessionId || null;
  const sessionPath = card.sessionPath
    || sessionRef?.sessionPath
    || sessionRef?.path
    || sessionRef?.legacySessionPath
    || null;
  return { sessionId, sessionPath };
}

function PluginCardFallback({ card }: { card: PluginCardDetails }) {
  if (!card.description) return null;
  return (
    <div className={s.container}>
      {card.title && <div className={s.title}>{card.title}</div>}
      <div className={s.description}>{card.description}</div>
    </div>
  );
}

function PluginChatSurfaceCard({ card }: { card: PluginCardDetails }) {
  const { sessionId, sessionPath } = chatSurfaceSession(card);
  const hasTitle = Boolean(card.title);
  const loaded = useStore(st => sessionPath
    ? Boolean(sessionScopedValue(st, st.chatSessions, sessionPath))
    : false);

  useEffect(() => {
    if (!sessionPath || loaded) return;
    void loadMessages(sessionPath);
  }, [loaded, sessionPath]);

  if (!sessionId || !sessionPath) {
    return <PluginCardFallback card={card} />;
  }

  return (
    <div className={`${s.container} ${s.chatSurface}`}>
      {hasTitle && (
        <div className={s.chatSurfaceHeader}>
          <div className={s.chatSurfaceTitle}>{card.title}</div>
        </div>
      )}
      <div className={`${s.chatSurfaceBody}${hasTitle ? '' : ` ${s.chatSurfaceBodyFull}`}`}>
        <ChatMessageSurface sessionPath={sessionPath} active variant="card" />
      </div>
    </div>
  );
}

function PluginWebViewCard({ card, agentId }: Props) {
  const [error, setError] = useState(false);
  const capabilityGrants = useStore(st => st.pluginUiHostCapabilities[card.pluginId] ?? EMPTY_CAPABILITY_GRANTS);

  // Compute initial size from aspectRatio hint; 0 means unknown
  const ratio = parseRatio(card.aspectRatio);
  const defaultW = MAX_W;
  const defaultH = ratio > 0
    ? Math.min(Math.round(defaultW / ratio), MAX_H)
    : Math.round(defaultW * 0.75); // 4:3 fallback for old cards

  const isIframe = isIframeCard(card);
  const route = isIframe && card.route ? card.route : null;

  const surfaceUrl = usePluginSurfaceUrl(route ? `/api/plugins/${card.pluginId}${route}` : null, agentId);
  const { iframeRef, status: iframeStatus, size } = usePluginIframe(isIframe ? surfaceUrl.iframeSrc : null, {
    pluginId: card.pluginId,
    agentId,
    slot: 'card',
    capabilityGrants,
    initialSize: { width: defaultW, height: defaultH },
    readyOnTimeout: true,
  });
  const status = surfaceUrl.status === 'ready' ? iframeStatus : surfaceUrl.status;
  const ready = status === 'ready';

  if (!isIframe || !route || error) {
    return <PluginCardFallback card={card} />;
  }

  return (
    <div className={s.container}>
      <iframe
        ref={iframeRef}
        className={s.iframe}
        src={surfaceUrl.iframeSrc || undefined}
        sandbox="allow-scripts allow-same-origin"
        style={{
          width: size.width ?? defaultW,
          height: size.height ?? defaultH,
          opacity: ready ? 1 : 0.3,
        }}
        onError={() => setError(true)}
      />
    </div>
  );
}

export function PluginCardBlock({ card, agentId }: Props) {
  if (card.type === 'chat.surface') {
    return <PluginChatSurfaceCard card={card} />;
  }
  return <PluginWebViewCard card={card} agentId={agentId} />;
}
