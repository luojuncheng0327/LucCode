import { memo, useCallback, useMemo } from 'react';
import type { ChatListItem, ChatMessage } from '../../stores/chat-types';
import { UserMessage } from './UserMessage';
import { AgentOriginMessage } from './AgentOriginMessage';
import { AssistantMessage } from './AssistantMessage';
import { ProcessFoldBlock } from './ProcessFoldBlock';
import { InterludeBlock } from './InterludeBlock';
import { buildTranscriptRenderItems, type TranscriptRenderItem } from './process-fold';
import { useStore } from '../../stores';
import { selectIsStreamingSession, selectSelectedIdsBySession } from '../../stores/session-selectors';
import { resolveAgentDisplayInfo, type AgentDisplayInfo } from '../../utils/agent-display';
import type {
  ForkedSessionHandler,
  SessionNodeTarget,
} from '../../stores/message-turn-actions';

interface Props {
  items: ChatListItem[];
  sessionPath: string;
  agentId?: string | null;
  readOnly?: boolean;
  hideUserIdentity?: boolean;
  userIdentity?: { name?: string | null; avatarUrl?: string | null };
  registerMessageElement?: (messageId: string, element: HTMLDivElement | null) => void;
  enableProcessFold?: boolean;
  onForkCreated?: ForkedSessionHandler;
}

export const ChatTranscript = memo(function ChatTranscript({
  items,
  sessionPath,
  agentId,
  readOnly = false,
  hideUserIdentity = false,
  userIdentity,
  registerMessageElement,
  enableProcessFold = false,
  onForkCreated,
}: Props) {
  const isStreaming = useStore(s => selectIsStreamingSession(s, sessionPath));
  const agents = useStore(s => s.agents);
  const globalAgentName = useStore(s => s.agentName) || 'Luc';
  const globalYuan = useStore(s => s.agentYuan) || 'luc';
  const selectedIds = useStore(s => selectSelectedIdsBySession(s, sessionPath));
  const userAvatarUrl = useStore(s => s.userAvatarUrl);
  const storeUserName = useStore(s => s.userName);
  const t = window.t ?? ((p: string) => p);
  const agentDisplay = useMemo<AgentDisplayInfo & { yuan: string }>(() => {
    const info = resolveAgentDisplayInfo({
      id: agentId || null,
      agents,
      fallbackAgentName: globalAgentName,
      fallbackAgentYuan: globalYuan,
    });
    return { ...info, yuan: info.yuan || globalYuan };
  }, [agentId, agents, globalAgentName, globalYuan]);
  const viewerIdentity = useMemo(() => ({
    name: storeUserName || t('common.me'),
    avatarUrl: userAvatarUrl,
  }), [storeUserName, userAvatarUrl, t]);
  const renderItems = useMemo(
    () => enableProcessFold
      ? buildTranscriptRenderItems(items, { isStreaming })
      : items.map((item, originalIndex) => ({ type: 'source' as const, item, originalIndex })),
    [enableProcessFold, isStreaming, items],
  );
  const turnState = useMemo(() => buildTurnState(items), [items]);

  return (
    <>
      {renderItems.map((renderItem) => (
        <TranscriptRenderItemView
          key={renderItemKey(renderItem)}
          renderItem={renderItem}
          sourceItems={items}
          sessionPath={sessionPath}
          agentId={agentId}
          readOnly={readOnly}
          hideUserIdentity={hideUserIdentity}
          userIdentity={userIdentity}
          latestUserIndex={turnState.latestUserIndex}
          latestAssistantIndex={turnState.latestAssistantIndex}
          turnCompletionAssistantIndexes={turnState.turnCompletionAssistantIndexes}
          assistantTurnSelectionIdsByCompletionIndex={turnState.assistantTurnSelectionIdsByCompletionIndex}
          assistantTurnTargetsByCompletionIndex={turnState.assistantTurnTargetsByCompletionIndex}
          assistantTurnRetryMessagesByCompletionIndex={turnState.assistantTurnRetryMessagesByCompletionIndex}
          isStreamingSession={isStreaming}
          agentDisplay={agentDisplay}
          viewerIdentity={viewerIdentity}
          selectedIds={selectedIds}
          registerMessageElement={registerMessageElement}
          onForkCreated={onForkCreated}
        />
      ))}
    </>
  );
});

function renderItemKey(renderItem: TranscriptRenderItem): string {
  if (renderItem.type === 'process_fold') return renderItem.id;
  const item = renderItem.item;
  if (item.type === 'message') return item.data.id;
  if (item.type === 'interlude') return `i-${item.id}`;
  return `c-${renderItem.originalIndex}`;
}

function buildTurnState(items: ChatListItem[]): {
  latestUserIndex: number;
  latestAssistantIndex: number;
  turnCompletionAssistantIndexes: ReadonlySet<number>;
  assistantTurnSelectionIdsByCompletionIndex: ReadonlyMap<number, readonly string[]>;
  assistantTurnTargetsByCompletionIndex: ReadonlyMap<number, SessionNodeTarget>;
  assistantTurnRetryMessagesByCompletionIndex: ReadonlyMap<number, ChatMessage>;
} {
  let latestUserIndex = -1;
  let latestAssistantIndex = -1;
  let precedingUserEntryId: string | null = null;
  let precedingUserMessage: ChatMessage | null = null;
  let pendingAssistantIndex = -1;
  let pendingAssistantTurnInputEntryId: string | null = null;
  let pendingAssistantTurnIds: string[] = [];
  let pendingAssistantTarget: SessionNodeTarget | null = null;
  let pendingAssistantRetryMessage: ChatMessage | null = null;
  const turnCompletionAssistantIndexes = new Set<number>();
  const assistantTurnSelectionIdsByCompletionIndex = new Map<number, readonly string[]>();
  const assistantTurnTargetsByCompletionIndex = new Map<number, SessionNodeTarget>();
  const assistantTurnRetryMessagesByCompletionIndex = new Map<number, ChatMessage>();

  const completePendingAssistantTurn = () => {
    if (pendingAssistantIndex < 0) return;
    turnCompletionAssistantIndexes.add(pendingAssistantIndex);
    assistantTurnSelectionIdsByCompletionIndex.set(pendingAssistantIndex, pendingAssistantTurnIds);
    if (pendingAssistantTarget) {
      assistantTurnTargetsByCompletionIndex.set(pendingAssistantIndex, pendingAssistantTarget);
    }
    if (pendingAssistantRetryMessage) {
      assistantTurnRetryMessagesByCompletionIndex.set(pendingAssistantIndex, pendingAssistantRetryMessage);
    }
    pendingAssistantIndex = -1;
    pendingAssistantTurnInputEntryId = null;
    pendingAssistantTurnIds = [];
    pendingAssistantTarget = null;
    pendingAssistantRetryMessage = null;
  };

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item.type !== 'message') continue;

    if (item.data.role === 'user') {
      completePendingAssistantTurn();
      latestUserIndex = i;
      precedingUserEntryId = item.data.sourceEntryId || null;
      precedingUserMessage = item.data;
      continue;
    }

    if (item.data.role === 'assistant') {
      const turnInputEntryId = item.data.turnInputEntryId || precedingUserEntryId;
      if (
        pendingAssistantIndex >= 0
        && pendingAssistantTurnInputEntryId !== turnInputEntryId
        && (pendingAssistantTurnInputEntryId !== null || turnInputEntryId !== null)
      ) {
        completePendingAssistantTurn();
      }
      if (pendingAssistantIndex < 0) {
        pendingAssistantTurnInputEntryId = turnInputEntryId;
      }
      pendingAssistantIndex = i;
      pendingAssistantTurnIds = [...pendingAssistantTurnIds, item.data.id];
      pendingAssistantTarget = item.data.sourceEntryId
        ? { role: 'assistant', entryId: item.data.sourceEntryId }
        : (turnInputEntryId
            ? { role: 'assistant_turn', turnInputEntryId }
            : null);
      pendingAssistantRetryMessage = turnInputEntryId && turnInputEntryId === precedingUserEntryId
        ? precedingUserMessage
        : null;
      latestAssistantIndex = i;
    }
  }

  completePendingAssistantTurn();

  return {
    latestUserIndex,
    latestAssistantIndex,
    turnCompletionAssistantIndexes,
    assistantTurnSelectionIdsByCompletionIndex,
    assistantTurnTargetsByCompletionIndex,
    assistantTurnRetryMessagesByCompletionIndex,
  };
}

const TranscriptRenderItemView = memo(function TranscriptRenderItemView({
  renderItem,
  sourceItems,
  sessionPath,
  agentId,
  readOnly,
  hideUserIdentity,
  userIdentity,
  latestUserIndex,
  latestAssistantIndex,
  turnCompletionAssistantIndexes,
  assistantTurnSelectionIdsByCompletionIndex,
  assistantTurnTargetsByCompletionIndex,
  assistantTurnRetryMessagesByCompletionIndex,
  isStreamingSession,
  agentDisplay,
  viewerIdentity,
  selectedIds,
  registerMessageElement,
  onForkCreated,
}: {
  renderItem: TranscriptRenderItem;
  sourceItems: ChatListItem[];
  sessionPath: string;
  agentId?: string | null;
  readOnly: boolean;
  hideUserIdentity: boolean;
  userIdentity?: { name?: string | null; avatarUrl?: string | null };
  latestUserIndex: number;
  latestAssistantIndex: number;
  turnCompletionAssistantIndexes: ReadonlySet<number>;
  assistantTurnSelectionIdsByCompletionIndex: ReadonlyMap<number, readonly string[]>;
  assistantTurnTargetsByCompletionIndex: ReadonlyMap<number, SessionNodeTarget>;
  assistantTurnRetryMessagesByCompletionIndex: ReadonlyMap<number, ChatMessage>;
  isStreamingSession: boolean;
  agentDisplay: AgentDisplayInfo & { yuan: string };
  viewerIdentity: { name: string; avatarUrl: string | null };
  selectedIds: readonly string[];
  registerMessageElement?: (messageId: string, element: HTMLDivElement | null) => void;
  onForkCreated?: ForkedSessionHandler;
}) {
  const originalIndex = renderItem.originalIndex;
  const prevMessageItem = previousMessageItem(sourceItems, originalIndex);

  if (renderItem.type === 'process_fold') {
    const prevRole = prevMessageItem?.data.role ?? null;
    return (
      <ProcessFoldBlock
        group={renderItem}
        showAvatar={prevRole !== 'assistant'}
        sessionPath={sessionPath}
        agentId={agentId}
        readOnly={readOnly}
        turnCompletionAssistantIndexes={turnCompletionAssistantIndexes}
        assistantTurnSelectionIdsByCompletionIndex={assistantTurnSelectionIdsByCompletionIndex}
        assistantTurnTargetsByCompletionIndex={assistantTurnTargetsByCompletionIndex}
        assistantTurnRetryMessagesByCompletionIndex={assistantTurnRetryMessagesByCompletionIndex}
        completionTimePersistent={
          turnCompletionAssistantIndexes.has(groupLastOriginalIndex(renderItem))
          && groupLastOriginalIndex(renderItem) === latestAssistantIndex
          && latestAssistantIndex > latestUserIndex
          && !isStreamingSession
        }
        agentDisplay={agentDisplay}
        isStreaming={isStreamingSession}
        selectedIds={selectedIds}
        registerMessageElement={registerMessageElement}
        onForkCreated={onForkCreated}
      />
    );
  }

  const showTurnCompletionTime = turnCompletionAssistantIndexes.has(originalIndex)
    && !(
      isStreamingSession
      && originalIndex === latestAssistantIndex
      && latestAssistantIndex > latestUserIndex
    );

  return (
    <TranscriptItemView
      item={renderItem.item}
      prevItem={prevMessageItem}
      sessionPath={sessionPath}
      agentId={agentId}
      readOnly={readOnly}
      hideUserIdentity={hideUserIdentity}
      userIdentity={userIdentity}
      isLatestUserMessage={originalIndex === latestUserIndex}
      isLatestAssistantMessage={
        originalIndex === latestAssistantIndex
        && latestAssistantIndex > latestUserIndex
      }
      showTurnCompletionTime={showTurnCompletionTime}
      assistantTurnSelectionIds={showTurnCompletionTime
        ? assistantTurnSelectionIdsByCompletionIndex.get(originalIndex)
        : undefined}
      assistantTurnTarget={showTurnCompletionTime
        ? assistantTurnTargetsByCompletionIndex.get(originalIndex) ?? null
        : null}
      assistantTurnRetryMessage={showTurnCompletionTime
        ? assistantTurnRetryMessagesByCompletionIndex.get(originalIndex) ?? null
        : null}
      agentDisplay={agentDisplay}
      viewerIdentity={viewerIdentity}
      isStreaming={isStreamingSession}
      selectedIds={selectedIds}
      registerMessageElement={registerMessageElement}
      onForkCreated={onForkCreated}
    />
  );
});

function previousMessageItem(items: ChatListItem[], beforeIndex: number): Extract<ChatListItem, { type: 'message' }> | undefined {
  for (let i = beforeIndex - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.type === 'message') return item;
  }
  return undefined;
}

function groupLastOriginalIndex(renderItem: Extract<TranscriptRenderItem, { type: 'process_fold' }>): number {
  return renderItem.items[renderItem.items.length - 1]?.originalIndex ?? renderItem.originalIndex;
}

const TranscriptItemView = memo(function TranscriptItemView({
  item,
  prevItem,
  sessionPath,
  agentId,
  readOnly,
  hideUserIdentity,
  userIdentity,
  isLatestUserMessage,
  isLatestAssistantMessage,
  showTurnCompletionTime,
  assistantTurnSelectionIds,
  assistantTurnTarget,
  assistantTurnRetryMessage,
  agentDisplay,
  viewerIdentity,
  isStreaming,
  selectedIds,
  registerMessageElement,
  onForkCreated,
}: {
  item: ChatListItem;
  prevItem?: ChatListItem;
  sessionPath: string;
  agentId?: string | null;
  readOnly: boolean;
  hideUserIdentity: boolean;
  userIdentity?: { name?: string | null; avatarUrl?: string | null };
  isLatestUserMessage: boolean;
  isLatestAssistantMessage: boolean;
  showTurnCompletionTime: boolean;
  assistantTurnSelectionIds?: readonly string[];
  assistantTurnTarget?: SessionNodeTarget | null;
  assistantTurnRetryMessage?: ChatMessage | null;
  agentDisplay: AgentDisplayInfo & { yuan: string };
  viewerIdentity: { name: string; avatarUrl: string | null };
  isStreaming: boolean;
  selectedIds: readonly string[];
  registerMessageElement?: (messageId: string, element: HTMLDivElement | null) => void;
  onForkCreated?: ForkedSessionHandler;
}) {
  const messageId = item.type === 'message' ? item.data.id : null;
  const messageRef = useCallback((element: HTMLDivElement | null) => {
    if (messageId) registerMessageElement?.(messageId, element);
  }, [messageId, registerMessageElement]);

  if (item.type === 'compaction') return null;
  if (item.type === 'interlude') return <InterludeBlock block={item.data} />;

  const msg = item.data;
  const prevRole = prevItem?.type === 'message' ? prevItem.data.role : null;
  const showAvatar = msg.role !== prevRole;

  if (msg.role === 'user') {
    return msg.origin ? (
      <AgentOriginMessage
        message={msg}
        sessionPath={sessionPath}
        readOnly={readOnly}
        isStreaming={isStreaming}
        onForkCreated={onForkCreated}
      />
    ) : (
      <UserMessage
        message={msg}
        showAvatar={showAvatar}
        sessionPath={sessionPath}
        readOnly={readOnly}
        hideIdentity={hideUserIdentity}
        userIdentity={userIdentity}
        viewerIdentity={viewerIdentity}
        isStreaming={isStreaming}
        isSelected={selectedIds.includes(msg.id)}
        isLatestUserMessage={isLatestUserMessage}
        onForkCreated={onForkCreated}
        messageRef={messageRef}
      />
    );
  }

  return (
    <AssistantMessage
      message={msg}
      showAvatar={showAvatar}
      sessionPath={sessionPath}
      agentId={agentId}
      readOnly={readOnly}
      agentDisplay={agentDisplay}
      isStreaming={isStreaming}
      isSelected={selectedIds.includes(msg.id)}
      isLatestAssistantMessage={isLatestAssistantMessage}
      showTurnCompletionTime={showTurnCompletionTime}
      assistantTurnSelectionIds={assistantTurnSelectionIds}
      turnTarget={assistantTurnTarget}
      retrySourceMessage={assistantTurnRetryMessage}
      onForkCreated={onForkCreated}
      messageRef={messageRef}
    />
  );
});
