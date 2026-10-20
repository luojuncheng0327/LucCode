import { memo, useCallback, useMemo, useState } from 'react';
import type { AgentReviewRequestContext } from '../../stores/chat-types';
import { useStore } from '../../stores';
import { loadSessions, switchSession } from '../../stores/session-actions';
import { AgentAvatar, resolveAgentDisplayInfo } from '../../utils/agent-display';
import styles from './Chat.module.css';
import { useI18n } from '../../hooks/use-i18n';
import { ConversationEventCard } from './ConversationEventCard';

export const AgentReviewRequestCard = memo(function AgentReviewRequestCard({
  request,
}: {
  request: AgentReviewRequestContext;
}) {
  const [opening, setOpening] = useState(false);
  const { t } = useI18n();
  const agents = useStore(state => state.agents);
  const reviewedSession = useStore(state => state.sessions.find(session => session.sessionId === request.reviewedSessionId));
  const info = useMemo(() => resolveAgentDisplayInfo({
    id: request.reviewerAgentId,
    agents,
    fallbackAgentName: request.reviewerAgentName,
  }), [agents, request.reviewerAgentId, request.reviewerAgentName]);
  const sessionName = reviewedSession?.title?.trim()
    || reviewedSession?.firstMessage?.trim()
    || t('agentReview.reviewedSessionFallback');
  const openReviewedSession = useCallback(async () => {
    if (opening) return;
    setOpening(true);
    try {
      let target = useStore.getState().sessions.find(session => session.sessionId === request.reviewedSessionId);
      if (!target) {
        await loadSessions();
        target = useStore.getState().sessions.find(session => session.sessionId === request.reviewedSessionId);
      }
      if (!target) {
        useStore.getState().addToast(t('agentReview.sessionUnavailable'), 'error', 5000);
        return;
      }
      await switchSession(target.path);
    } finally {
      setOpening(false);
    }
  }, [opening, request.reviewedSessionId, t]);

  return (
    <ConversationEventCard
      cardClassName={`${styles.agentOriginCard} ${styles.agentReviewMessageCard}`}
      onActivate={opening ? undefined : () => { void openReviewedSession(); }}
      ariaLabel={t('agentReview.openReviewedSession')}
    >
      <header className={styles.agentOriginHeader}>
        <AgentAvatar info={info} className={styles.agentOriginAvatar} alt="" />
        <span className={styles.agentOriginName}>{request.reviewerAgentName}</span>
        <span className={styles.agentReviewSessionName}>{sessionName}</span>
      </header>
      <div className={styles.agentOriginBody}>
        {opening ? t('common.loading') : t('agentReview.requestReceived')}
      </div>
    </ConversationEventCard>
  );
});
