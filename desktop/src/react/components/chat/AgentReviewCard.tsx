import { memo, useCallback, useMemo, useState } from 'react';
import type { AgentReviewContext } from '../../stores/chat-types';
import { useStore } from '../../stores';
import { loadSessions, switchSession } from '../../stores/session-actions';
import { AgentAvatar, resolveAgentDisplayInfo } from '../../utils/agent-display';
import styles from './Chat.module.css';
import { AssistantContentPreview } from './AssistantContentPreview';
import { ConversationEventCard } from './ConversationEventCard';
import { useI18n } from '../../hooks/use-i18n';

export const AgentReviewCard = memo(function AgentReviewCard({ review }: { review: AgentReviewContext }) {
  const agents = useStore(state => state.agents);
  const reviewerSession = useStore(state => state.sessions.find(session => session.sessionId === review.reviewerSessionId));
  const [opening, setOpening] = useState(false);
  const { t } = useI18n();
  const info = useMemo(() => resolveAgentDisplayInfo({
    id: review.reviewerAgentId,
    agents,
    fallbackAgentName: review.reviewerAgentName,
  }), [agents, review.reviewerAgentId, review.reviewerAgentName]);

  const openReviewerSession = useCallback(async () => {
    const sessionId = review.reviewerSessionId?.trim();
    if (!sessionId || opening) return;
    setOpening(true);
    try {
      let target = useStore.getState().sessions.find(session => session.sessionId === sessionId);
      if (!target) {
        await loadSessions();
        target = useStore.getState().sessions.find(session => session.sessionId === sessionId);
      }
      if (!target) {
        useStore.getState().addToast(t('agentReview.sessionUnavailable'), 'error', 5000);
        return;
      }
      await switchSession(target.path);
    } finally {
      setOpening(false);
    }
  }, [opening, review.reviewerSessionId, t]);

  const statusLabel = review.status === 'running'
    ? t('agentReview.running')
    : review.status === 'completed'
      ? t('agentReview.completed')
      : review.status === 'cancelled'
        ? t('agentReview.cancelled')
        : t('agentReview.failed');
  const sessionName = reviewerSession?.title?.trim()
    || reviewerSession?.firstMessage?.trim()
    || t('agentReview.reviewSessionFallback', { name: review.reviewerAgentName });

  return (
    <ConversationEventCard
      cardClassName={`${styles.agentOriginCard} ${styles.agentReviewMessageCard}`}
      status={review.status}
      onActivate={review.reviewerSessionId && !opening ? () => { void openReviewerSession(); } : undefined}
      ariaLabel={t('agentReview.openSession')}
    >
      <header className={styles.agentOriginHeader}>
        <AgentAvatar info={info} className={styles.agentOriginAvatar} alt="" />
        <span className={styles.agentOriginName}>
          {t('sessionCollab.fromAgent', { name: review.reviewerAgentName })}
        </span>
        <span className={styles.agentReviewSessionName}>{sessionName}</span>
        {review.status === 'running' && <span className={styles.agentReviewPulse} aria-hidden="true" />}
      </header>
      {review.status === 'completed' && review.text && (
        <AssistantContentPreview
          content={review.text}
          className={styles.agentReviewBody}
          linkContext={reviewerSession?.path ? {
            origin: 'session',
            sessionPath: reviewerSession.path,
          } : undefined}
        />
      )}
      {review.status === 'running' && <div className={styles.agentOriginBody}>{statusLabel}</div>}
      {(review.status === 'failed' || review.status === 'cancelled') && (
        <div className={styles.agentReviewError}>{review.error || statusLabel}</div>
      )}
    </ConversationEventCard>
  );
});
