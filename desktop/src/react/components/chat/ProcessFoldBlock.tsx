import { memo, useCallback, useId, useMemo, useState } from 'react';
import { Collapse } from '@/ui';
import { AgentAvatar, type AgentDisplayInfo } from '../../utils/agent-display';
import { AssistantMessage } from './AssistantMessage';
import { MessageFooterActions, formatMessageTime } from './MessageFooterActions';
import { buildProcessFoldSummary, type ProcessFoldRenderItem } from './process-fold';
import { useSessionNodeActions } from './SessionNodeActions';
import type {
  ForkedSessionHandler,
  SessionNodeTarget,
} from '../../stores/message-turn-actions';
import type { ChatMessage } from '../../stores/chat-types';
import styles from './Chat.module.css';

interface Props {
  group: ProcessFoldRenderItem;
  showAvatar: boolean;
  sessionPath: string;
  agentId?: string | null;
  readOnly: boolean;
  turnCompletionAssistantIndexes?: ReadonlySet<number>;
  assistantTurnSelectionIdsByCompletionIndex?: ReadonlyMap<number, readonly string[]>;
  assistantTurnTargetsByCompletionIndex?: ReadonlyMap<number, SessionNodeTarget>;
  assistantTurnRetryMessagesByCompletionIndex?: ReadonlyMap<number, ChatMessage>;
  completionTimePersistent?: boolean;
  agentDisplay: AgentDisplayInfo & { yuan: string };
  isStreaming: boolean;
  selectedIds: readonly string[];
  registerMessageElement?: (messageId: string, element: HTMLDivElement | null) => void;
  onForkCreated?: ForkedSessionHandler;
}

export const ProcessFoldBlock = memo(function ProcessFoldBlock({
  group,
  showAvatar,
  sessionPath,
  agentId,
  readOnly,
  turnCompletionAssistantIndexes,
  assistantTurnSelectionIdsByCompletionIndex,
  assistantTurnTargetsByCompletionIndex,
  assistantTurnRetryMessagesByCompletionIndex,
  completionTimePersistent = false,
  agentDisplay,
  isStreaming,
  selectedIds,
  registerMessageElement,
  onForkCreated,
}: Props) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const t = window.t ?? ((p: string) => p);

  const displayName = agentDisplay.displayName;
  const displayInfo = agentDisplay;
  const summary = useMemo(
    () => buildProcessFoldSummary(
      group.stats,
      displayName,
      (key, vars) => String(t(key, vars as Record<string, string | number> | undefined)),
    ),
    [displayName, group.stats, t],
  );

  const toggle = useCallback(() => setOpen(value => !value), []);
  const messageRef = useCallback((messageId: string) => (
    (element: HTMLDivElement | null) => registerMessageElement?.(messageId, element)
  ), [registerMessageElement]);
  const turnCompletionEntry = turnCompletionAssistantIndexes
    ? group.items.find((entry) => turnCompletionAssistantIndexes.has(entry.originalIndex))
    : null;
  const completionTimeText = formatMessageTime(turnCompletionEntry?.item.data.timestamp);
  const completionTarget = turnCompletionEntry
    ? assistantTurnTargetsByCompletionIndex?.get(turnCompletionEntry.originalIndex) ?? null
    : null;
  const { actions: completionActions } = useSessionNodeActions({
    sessionPath,
    target: readOnly || !turnCompletionEntry || isStreaming ? null : completionTarget,
    retryMessage: turnCompletionEntry
      ? assistantTurnRetryMessagesByCompletionIndex?.get(turnCompletionEntry.originalIndex)
      : undefined,
    onForkCreated,
    disabled: isStreaming,
  });

  return (
    <>
      <div className={`${styles.messageGroup} ${styles.messageGroupAssistant}`}>
        {showAvatar && (
          <div className={styles.avatarRow}>
            <AgentAvatar
              info={displayInfo}
              className={`${styles.avatar} ${styles.lucAvatar}`}
              alt={displayName}
            />
            <span className={styles.avatarName}>{displayName}</span>
          </div>
        )}
        <div className={`${styles.message} ${styles.messageAssistant} ${styles.processFoldMessage}`}>
          <button
            type="button"
            className={`${styles.processFoldSummary}${open ? ` ${styles.processFoldSummaryOpen}` : ''}`}
            aria-expanded={open}
            aria-controls={panelId}
            onClick={toggle}
          >
            <span className={styles.processFoldTitle}>
              <span className={styles.processFoldTitleText}>{summary}</span>
              <span className={styles.processFoldArrow} aria-hidden="true">›</span>
            </span>
          </button>
        </div>
        <Collapse open={open} className={styles.processFoldCollapse}>
          <div id={panelId} className={`${styles.message} ${styles.messageAssistant} ${styles.processFoldPanel}`}>
            {group.items.map((entry) => (
              <AssistantMessage
                key={entry.item.data.id}
                message={entry.item.data}
                showAvatar={false}
                sessionPath={sessionPath}
                agentId={agentId}
                readOnly={readOnly}
                agentDisplay={agentDisplay}
                isStreaming={isStreaming}
                isSelected={selectedIds.includes(entry.item.data.id)}
                showTurnCompletionTime={turnCompletionAssistantIndexes?.has(entry.originalIndex) ?? false}
                assistantTurnSelectionIds={assistantTurnSelectionIdsByCompletionIndex?.get(entry.originalIndex)}
                turnTarget={assistantTurnTargetsByCompletionIndex?.get(entry.originalIndex) ?? null}
                retrySourceMessage={assistantTurnRetryMessagesByCompletionIndex?.get(entry.originalIndex) ?? null}
                onForkCreated={onForkCreated}
                messageRef={messageRef(entry.item.data.id)}
              />
            ))}
          </div>
        </Collapse>
        {!open && (completionTimeText || completionActions.length > 0) && (
          <MessageFooterActions
            align="left"
            timeText={completionTimeText}
            timePersistent={completionTimePersistent}
            leadingActions={completionActions}
            actions={[]}
            testId="process-fold-completion-actions"
          />
        )}
      </div>
    </>
  );
});
