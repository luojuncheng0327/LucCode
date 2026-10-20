/**
 * ws-message-handler.ts — WebSocket 消息分发（从 app-ws-shim.ts 迁移）
 *
 * 纯逻辑模块，不依赖 ctx 注入。通过 Zustand store 访问状态。
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- WS 消息分发，msg 结构由服务端动态决定 */

import { streamBufferManager } from '../hooks/use-stream-buffer';
import { dispatchStreamKey } from './stream-key-dispatcher';
import { useStore } from '../stores';
import { updateKeyed } from '../stores/create-keyed-slice';
import { sessionScopedKey, sessionScopedListIncludes, sessionScopedValue } from '../stores/session-slice';
import { browserStateForPath, setBrowserStateForPath } from '../stores/browser-slice';
import { scheduleSessionsRefresh } from './session-refresh-scheduler';
import { handleLegacyArtifactBlock } from '../stores/preview-actions';
import {
  appendChannelMessage as appendChannelMessageAction,
  loadChannels as loadChannelsAction,
  markChannelMessagesDirty as markChannelMessagesDirtyAction,
  openChannel as openChannelAction,
  upsertConversationAgentActivity as upsertConversationAgentActivityAction,
} from '../stores/channel-actions';
import { showError } from '../utils/ui-helpers';
import { errorWithCode, presentError } from '../errors/error-presenter';
import { handleAppEvent } from './app-event-actions';
import {
  PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
  markDeskTreeDirtyForResourceChange,
  refreshOpenPreviewDocumentsForResourceChange,
} from '../utils/preview-document-refresh';
import {
  replayStreamResume,
  isStreamResumeRebuilding,
  isStreamScopedMessage,
  updateSessionStreamMeta,
} from './stream-resume';
import { TODO_TOOL_NAMES, type TodoToolName } from '../utils/todo-constants';
import { applyTodoLifecycle, migrateLegacyTodos } from '../utils/todo-compat';
import { renderMarkdown } from '../utils/markdown';
import { bumpMessageLiveVersion } from '../stores/message-live-version';

declare function t(key: string, vars?: Record<string, string>): any;

let requestContextUsage: (sessionPath: string) => void = () => {};

function syncSessionPermissionMode(mode: unknown) {
  if (mode === 'auto' || mode === 'operate' || mode === 'ask' || mode === 'read_only') {
    useStore.getState().setSessionPermissionMode?.(mode);
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sessionIdentityFromMessage(msg: any): { sessionId: string | null; sessionPath: string | null } {
  const session = msg?.session && typeof msg.session === 'object' ? msg.session : null;
  return {
    sessionId: nonEmptyString(msg?.sessionId) || nonEmptyString(session?.sessionId),
    sessionPath: nonEmptyString(msg?.sessionPath) || nonEmptyString(msg?.path) || nonEmptyString(session?.path),
  };
}

function rememberSessionLocatorFromMessage(msg: any): boolean {
  const { sessionId, sessionPath } = sessionIdentityFromMessage(msg);
  if (!sessionId || !sessionPath) return true;
  if (
    msg?.type === 'compaction_accepted'
    || msg?.type === 'compaction_result'
    || msg?.type === 'compaction_start'
    || msg?.type === 'compaction_end'
  ) {
    // Compaction path is transport metadata only. Identity routing uses sessionId,
    // and this event family must never mutate the locator truth maintained by the
    // sessions projection / manifest boundary.
    return true;
  }
  const snapshot = useStore.getState();
  const knownLocatorPath = snapshot.sessionLocatorsById?.[sessionId]?.path || null;
  const authoritativeLocatorUpdate = msg?.type === 'session_created';
  if (knownLocatorPath && knownLocatorPath !== sessionPath && !authoritativeLocatorUpdate) {
    console.warn('[ws] session locator mismatch; dropping non-authoritative event', {
      sessionId,
      sessionPath,
      knownLocatorPath,
    });
    return false;
  }
  const knownPathSessionId = snapshot.sessions.find((session: any) => session?.path === sessionPath)?.sessionId
    || (snapshot.currentSessionPath === sessionPath ? snapshot.currentSessionId : null)
    || Object.entries(snapshot.sessionLocatorsById || {}).find(([, locator]: any) => locator?.path === sessionPath)?.[0]
    || null;
  if (knownPathSessionId && knownPathSessionId !== sessionId) {
    console.warn('[ws] session identity mismatch; dropping event', { sessionId, sessionPath, knownPathSessionId });
    return false;
  }
  useStore.setState((state: any) => {
    const currentLocator = state.sessionLocatorsById?.[sessionId] || null;
    const patch: Record<string, any> = {};
    if (currentLocator?.path !== sessionPath) {
      patch.sessionLocatorsById = {
        ...(state.sessionLocatorsById || {}),
        [sessionId]: { path: sessionPath },
      };
    }
    if (state.currentSessionPath === sessionPath && state.currentSessionId !== sessionId) {
      patch.currentSessionId = sessionId;
    }
    return Object.keys(patch).length ? patch : {};
  });
  return true;
}

function isFocusedSessionMessage(msg: any): boolean {
  const { sessionId, sessionPath } = sessionIdentityFromMessage(msg);
  if (!sessionId && !sessionPath) return true;
  const state = useStore.getState();
  if (sessionId && sessionPath) {
    return state.currentSessionPath === sessionPath && state.currentSessionId === sessionId;
  }
  return (!!sessionPath && state.currentSessionPath === sessionPath)
    || (!!sessionId && state.currentSessionId === sessionId);
}

export function configureWsMessageHandler(options: {
  requestContextUsage?: (sessionPath: string) => void;
}): void {
  requestContextUsage = options.requestContextUsage || (() => {});
}

// ── 聊天事件集合（走 StreamBufferManager） ──

const REACT_CHAT_EVENTS = new Set([
  'text_delta', 'thinking_start', 'thinking_delta', 'thinking_end',
  'mood_start', 'mood_text', 'mood_end',
  'tool_start', 'tool_end', 'turn_end',
  'content_block', 'plugin_card',
  'compaction_start', 'compaction_end',
]);

// ── Session 可见性 + 流状态 ──

function ensureCurrentSessionVisible(): void {
  const state = useStore.getState();
  const sessionPath = state.currentSessionPath;
  if (!sessionPath || state.pendingNewSession) return;
  if (state.sessions.some((s: any) => s.path === sessionPath)) return;

  useStore.setState({
    sessions: [{
      path: sessionPath,
      title: null,
      firstMessage: '',
      modified: new Date().toISOString(),
      messageCount: 0,
      agentId: state.currentAgentId || null,
      agentName: state.agentName || null,
      cwd: null,
      _optimistic: true,
    }, ...state.sessions],
  });
}

function upsertCreatedSession(msg: any): void {
  const incoming = msg.session && typeof msg.session === 'object' ? msg.session : {};
  const sessionPath = typeof incoming.path === 'string' && incoming.path.trim()
    ? incoming.path
    : typeof msg.sessionPath === 'string' && msg.sessionPath.trim()
      ? msg.sessionPath
      : null;
  if (!sessionPath) return;
  const sessionId = typeof incoming.sessionId === 'string' && incoming.sessionId.trim()
    ? incoming.sessionId.trim()
    : typeof msg.sessionId === 'string' && msg.sessionId.trim()
      ? msg.sessionId.trim()
      : null;

  const state = useStore.getState();
  const existing: any = state.sessions.find((s: any) => s.path === sessionPath) || {};
  const now = new Date().toISOString();
  const next = {
    ...existing,
    path: sessionPath,
    sessionId: sessionId || existing.sessionId || null,
    title: typeof incoming.title === 'string' ? incoming.title : existing.title ?? null,
    firstMessage: typeof incoming.firstMessage === 'string' ? incoming.firstMessage : existing.firstMessage ?? '',
    modified: typeof incoming.modified === 'string' ? incoming.modified : existing.modified ?? now,
    messageCount: Number.isFinite(incoming.messageCount) ? incoming.messageCount : existing.messageCount ?? 0,
    agentId: typeof incoming.agentId === 'string' ? incoming.agentId : existing.agentId ?? state.currentAgentId ?? null,
    agentName: typeof incoming.agentName === 'string' ? incoming.agentName : existing.agentName ?? state.agentName ?? null,
    cwd: typeof incoming.cwd === 'string' ? incoming.cwd : existing.cwd ?? null,
    pinnedAt: incoming.pinnedAt ?? existing.pinnedAt ?? null,
    hasSummary: incoming.hasSummary ?? existing.hasSummary,
    rcAttachment: incoming.rcAttachment ?? existing.rcAttachment ?? null,
    _optimistic: false,
  };

  useStore.setState({
    sessions: [next, ...state.sessions.filter((s: any) => s.path !== sessionPath)]
      .sort((a: any, b: any) => new Date(b.modified || 0).getTime() - new Date(a.modified || 0).getTime()),
    ...(sessionId ? {
      sessionLocatorsById: {
        ...(state.sessionLocatorsById || {}),
        [sessionId]: { path: sessionPath },
      },
    } : {}),
  });
}

function resolveNotificationDesktopFocusPolicy(msg: any): 'always' | 'when_unfocused' {
  if (msg.desktopFocusPolicy === 'when_session_unfocused') {
    const completedSessionPath = typeof msg.sessionPath === 'string' && msg.sessionPath.trim()
      ? msg.sessionPath.trim()
      : null;
    const currentSessionPath = useStore.getState().currentSessionPath || null;
    if (completedSessionPath && currentSessionPath !== completedSessionPath) return 'always';
    return 'when_unfocused';
  }
  return msg.desktopFocusPolicy === 'when_unfocused' ? 'when_unfocused' : 'always';
}

function hasOptimisticCurrentSession(): boolean {
  const state = useStore.getState();
  const sessionPath = state.currentSessionPath;
  if (!sessionPath) return false;
  return !!state.sessions.find((s: any) => s.path === sessionPath && s._optimistic);
}

function resolvePrimaryAgentId(state: any): string | null {
  const primary = Array.isArray(state.agents)
    ? state.agents.find((agent: any) => agent?.isPrimary === true)
    : null;
  return typeof primary?.id === 'string' && primary.id ? primary.id : null;
}

function resolveDmPeerIdForEvent(state: any, msg: any): string | null {
  const channels = Array.isArray(state.channels) ? state.channels : [];
  const known = channels.find((channel: any) => {
    if (!channel?.isDM || !channel.dmOwnerId || !channel.peerId) return false;
    return (
      (msg.from === channel.dmOwnerId && msg.to === channel.peerId)
      || (msg.to === channel.dmOwnerId && msg.from === channel.peerId)
    );
  });
  if (known?.peerId) return known.peerId;

  const ownerId = resolvePrimaryAgentId(state) || state.currentAgentId || null;
  if (!ownerId) return typeof msg.from === 'string' ? msg.from : null;
  if (msg.from === ownerId && typeof msg.to === 'string') return msg.to;
  if (msg.to === ownerId && typeof msg.from === 'string') return msg.from;
  return null;
}

function applyTodoToolEnd(msg: any): void {
  if (msg.type !== 'tool_end' || !TODO_TOOL_NAMES.includes(msg.name as TodoToolName)) return;
  const sp = msg.sessionPath;
  if (!sp) {
    console.warn('[ws] tool_end(todo) missing sessionPath, skipping');
    return;
  }
  const todos = applyTodoLifecycle(migrateLegacyTodos(msg.details as { todos?: unknown[] } | null));
  useStore.getState().setSessionTodosForPath(sp, todos);
  // bump 版本：若 loadMessages 正在 fetch 旧快照，回来时会发现
  // 版本号变了，主动跳过 hydrate 写入，避免覆盖本次 live 状态。
  useStore.getState().bumpTodosLiveVersion(sp);
}

function isKnownChatSession(sessionPath: string, state = useStore.getState()): boolean {
  return !!sessionScopedValue(state, state.chatSessions, sessionPath)
    || state.sessions.some((s: any) => s.path === sessionPath);
}

function requestInputFocusForCurrentSession(sessionPath: string | null): void {
  if (!sessionPath) return;
  const state = useStore.getState();
  if (state.pendingNewSession) return;
  if (state.currentSessionPath !== sessionPath) return;
  state.requestInputFocus?.('restore');
}

function applyTurnEndSideEffects(msg: any): void {
  scheduleSessionsRefresh('turn_end');
  const turnSp = msg.sessionPath;
  if (turnSp) {
    requestContextUsage(turnSp);
  } else {
    console.warn('[ws] turn_end missing sessionPath, skipping context_usage request');
  }
}

function compactionIdentity(msg: any): { key: string | null; sessionId: string | null; sessionPath: string | null } {
  const { sessionId, sessionPath } = sessionIdentityFromMessage(msg);
  return { key: sessionId || sessionPath, sessionId, sessionPath };
}

function setCompactionBusy(msg: any, busy: boolean): void {
  const { key, sessionId, sessionPath } = compactionIdentity(msg);
  if (!key) return;
  useStore.setState((state: any) => {
    const compactingSessions = state.compactingSessions || [];
    const wasBusy = compactingSessions.some((item: string) => (
      item === key || item === sessionId || item === sessionPath
    ));
    const withoutIdentity = compactingSessions.filter((item: string) => (
      item !== key && item !== sessionId && item !== sessionPath
    ));
    const compactionModeBySession = { ...(state.compactionModeBySession || {}) };
    const priorMode = wasBusy
      ? compactionModeBySession[key]
        || (sessionId ? compactionModeBySession[sessionId] : null)
        || (sessionPath ? compactionModeBySession[sessionPath] : null)
      : null;
    const incomingMode = typeof msg.mode === 'string' && msg.mode.trim()
      ? msg.mode.trim()
      : null;
    delete compactionModeBySession[key];
    if (sessionId) delete compactionModeBySession[sessionId];
    if (sessionPath) delete compactionModeBySession[sessionPath];
    if (busy && (incomingMode || priorMode)) {
      compactionModeBySession[key] = incomingMode || priorMode;
    }
    return {
      compactingSessions: busy ? [...withoutIdentity, key] : withoutIdentity,
      compactionModeBySession,
    };
  });
}

function updateCompactionContext(msg: any): void {
  const { key, sessionId, sessionPath } = compactionIdentity(msg);
  if (!key) return;
  useStore.setState((state: any) => {
    const existing = state.contextBySession?.[key]
      || (sessionPath ? sessionScopedValue(state, state.contextBySession, sessionPath) : null);
    const value = {
      tokens: msg.tokens ?? null,
      window: msg.contextWindow ?? existing?.window ?? null,
      percent: msg.percent ?? null,
    };
    const contextBySession = { ...(state.contextBySession || {}), [key]: value };
    if (sessionId && sessionPath && sessionId !== sessionPath) delete contextBySession[sessionPath];
    const focused = (sessionId && state.currentSessionId === sessionId)
      || (!sessionId && sessionPath && state.currentSessionPath === sessionPath);
    return {
      contextBySession,
      ...(focused ? {
        contextTokens: value.tokens,
        contextWindow: value.window,
        contextPercent: value.percent,
      } : {}),
    };
  });
}

function applyCompactionMessage(msg: any): void {
  if (msg.type === 'compaction_accepted' || msg.type === 'compaction_start') {
    setCompactionBusy(msg, true);
    return;
  }
  if (msg.type === 'compaction_end') {
    setCompactionBusy(msg, false);
    updateCompactionContext(msg);
    return;
  }
  if (msg.type !== 'compaction_result') return;

  setCompactionBusy(msg, false);
  if (msg.status === 'noop' || msg.status === 'failed') {
    const message = nonEmptyString(msg.message)
      || (msg.status === 'noop' ? 'Nothing to compact' : 'Compaction failed');
    useStore.getState().addToast(message, msg.status === 'noop' ? 'info' : 'error', 6000, {
      dedupeKey: `compaction-result:${msg.sessionId || msg.sessionPath || 'unknown'}:${msg.status}`,
    });
  }
}

export function applyStreamingStatus(
  isStreaming: boolean,
  sessionPath: string | null,
  identity: { streamId?: string | null; turnId?: string | null } = {},
  options: { force?: boolean } = {},
): boolean {
  // 元数据层：把 isStreaming 视为 sessionPath 维度的权威信号，统一写回 streamingSessions。
  // 这一层不分焦点，任何来源（普通 status、stream_resume 恢复）都必须到达这里，
  // 否则重连后服务端说「已结束」前端却留着旧的 streaming 标记，UI 会卡在"思考中"。
  const wasStreaming = !!sessionPath
    && sessionScopedListIncludes(useStore.getState(), useStore.getState().streamingSessions, sessionPath);
  if (sessionPath) {
    if (isStreaming) {
      useStore.getState().addStreamingSession(sessionPath, identity);
      useStore.getState().clearInlineError(sessionPath);
    } else {
      const applied = options.force
        ? useStore.getState().forceRemoveStreamingSession(sessionPath)
        : useStore.getState().removeStreamingSession(sessionPath, identity);
      if (!applied) return false;
    }
  }

  if (!isStreaming && wasStreaming) {
    requestInputFocusForCurrentSession(sessionPath);
    const focused = useStore.getState().currentSessionPath;
    if (sessionPath && sessionPath !== focused) {
      useStore.getState().markSessionOutputUnread?.(sessionPath);
    }
  }

  // 渲染层：只有焦点 session 才影响 UI 占位 / sessions 列表。
  const focused = useStore.getState().currentSessionPath;
  if (sessionPath && sessionPath !== focused) return false;
  if (isStreaming) {
    ensureCurrentSessionVisible();
  } else if (hasOptimisticCurrentSession()) {
    scheduleSessionsRefresh('optimistic_session_settled');
  }
  return true;
}

function attachmentsEqual(a: any, b: any): boolean {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const la = left[i] || {};
    const rb = right[i] || {};
    if ((la.path || '') !== (rb.path || '')) return false;
    if ((la.name || '') !== (rb.name || '')) return false;
    if (!!la.isDir !== !!rb.isDir) return false;
    if ((la.mimeType || '') !== (rb.mimeType || '')) return false;
    if ((la.base64Data || '') !== (rb.base64Data || '')) return false;
    if ((la.status || '') !== (rb.status || '')) return false;
    if ((la.missingAt ?? null) !== (rb.missingAt ?? null)) return false;
    if (!!la.visionAuxiliary !== !!rb.visionAuxiliary) return false;
  }
  return true;
}

function sameJsonish(a: any, b: any): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function normalizeMessageTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
}

function replayUserMessageAlreadyHydrated(sessionPath: string, message: any): boolean {
  const state = useStore.getState();
  const session = sessionScopedValue(state, state.chatSessions, sessionPath);
  const last = session?.items?.[session.items.length - 1];
  if (!last || last.type !== 'message' || last.data?.role !== 'user') return false;
  const text = typeof message?.text === 'string' ? message.text : '';
  return last.data.text === text &&
    (last.data.quotedText || '') === (message?.quotedText || '') &&
    attachmentsEqual(last.data.attachments, message?.attachments) &&
    sameJsonish(last.data.deskContext, message?.deskContext);
}

function applyVoiceTranscriptionUpdate(msg: any): void {
  const sessionPath = typeof msg.sessionPath === 'string' ? msg.sessionPath : '';
  const fileId = typeof msg.fileId === 'string' ? msg.fileId : '';
  const transcription = msg.transcription && typeof msg.transcription === 'object' ? msg.transcription : null;
  if (!sessionPath || !fileId || !transcription) return;

  let changed = false;
  useStore.setState((s: any) => {
    const session = sessionScopedValue<any>(s, s.chatSessions, sessionPath);
    if (!session) return {};
    const items = session.items.map((item: any) => {
      if (item?.type !== 'message' || !Array.isArray(item.data?.attachments)) return item;
      let itemChanged = false;
      const attachments = item.data.attachments.map((attachment: any) => {
        if (attachment?.fileId !== fileId) return attachment;
        itemChanged = true;
        return { ...attachment, transcription };
      });
      if (!itemChanged) return item;
      changed = true;
      return { ...item, data: { ...item.data, attachments } };
    });
    if (!changed) return {};
    const sessionKey = sessionScopedKey(s, sessionPath) || sessionPath;
    const chatSessions = {
      ...s.chatSessions,
      [sessionKey]: { ...session, items },
    };
    if (sessionKey !== sessionPath) delete chatSessions[sessionPath];
    return {
      chatSessions,
    };
  });
  if (changed) bumpMessageLiveVersion(sessionPath);
}

function applyInputSessionConfirmationBlock(msg: any): void {
  if (msg.type !== 'content_block') return;
  const block = msg.block;
  if (block?.type !== 'session_confirmation' || block.surface !== 'input') return;
  const sessionPath = typeof msg.sessionPath === 'string' ? msg.sessionPath.trim() : '';
  if (!sessionPath) {
    console.warn('[ws] input session_confirmation missing sessionPath, skipping pending cache');
    return;
  }
  useStore.getState().setPendingSessionConfirmation?.(
    sessionPath,
    block.status === 'pending' ? block : null,
  );
}

// ── 消息分发（大 switch） ──

export function handleServerMessage(msg: any): void {
  if (!rememberSessionLocatorFromMessage(msg)) return;
  const state = useStore.getState();

  const rebuildingFor = isStreamResumeRebuilding();

  if (rebuildingFor && msg.type === 'status' && state.currentSessionPath === rebuildingFor) {
    return;
  }

  if (
    rebuildingFor &&
    isStreamScopedMessage(msg) &&
    msg.sessionPath === rebuildingFor &&
    !msg.__fromReplay &&
    msg.type !== 'stream_resume'
  ) {
    return;
  }

  if (msg.type !== 'stream_resume' && isStreamScopedMessage(msg)) {
    if (!updateSessionStreamMeta(msg)) return;
  }

  if (
    msg.type === 'compaction_accepted'
    || msg.type === 'compaction_result'
    || msg.type === 'compaction_start'
    || msg.type === 'compaction_end'
  ) {
    applyCompactionMessage(msg);
    if (msg.type === 'compaction_accepted' || msg.type === 'compaction_result') return;
  }

  applyInputSessionConfirmationBlock(msg);

  // 活跃 block 事件路由：非当前 session 的聊天事件也要写入正常聊天缓存。
  // stream-key-dispatcher 只负责卡片/预览订阅，不能吞掉主 transcript 的后台流。
  if (REACT_CHAT_EVENTS.has(msg.type) && msg.sessionPath && msg.sessionPath !== state.currentSessionPath) {
    if (isKnownChatSession(msg.sessionPath, state)) {
      streamBufferManager.handle(msg);
    }
    if (msg.type === 'turn_end') {
      applyTurnEndSideEffects(msg);
    }
    dispatchStreamKey(msg.sessionPath, msg);
    applyTodoToolEnd(msg);
    applyToolEndSessionFile(msg);
    applyContentBlockSessionFile(msg);
    return;
  }

  // ── React 聊天渲染路径：聊天相关事件走 StreamBufferManager ──
  if (REACT_CHAT_EVENTS.has(msg.type)) {
    streamBufferManager.handle(msg);
    // turn_end 后仍需执行部分通用逻辑（loadSessions、context_usage）
    if (msg.type === 'turn_end') {
      applyTurnEndSideEffects(msg);
    }
    // tool_end 后更新 todo（兼容新旧工具名 + 新旧格式）
    applyTodoToolEnd(msg);
    if (msg.type === 'tool_end') {
      applyToolEndSessionFile(msg);
    }
    applyContentBlockSessionFile(msg);
    // COMPAT(create_artifact, remove no earlier than v0.133):
    // 旧 artifact block 进入当前 Preview 面板。
    if (msg.type === 'content_block' && msg.block?.type === 'artifact' && state.currentTab === 'chat') {
      handleLegacyArtifactBlock({ ...msg.block, sessionPath: msg.sessionPath });
    }
    return;
  }

  // 非聊天渲染事件走传统 switch
  switch (msg.type) {
    case 'resource.changed': {
      markDeskTreeDirtyForResourceChange(msg);
      void refreshOpenPreviewDocumentsForResourceChange(
        msg,
        PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
      );
      break;
    }
    case 'resource.deleted':
    case 'resource.renamed': {
      markDeskTreeDirtyForResourceChange(msg);
      void refreshOpenPreviewDocumentsForResourceChange(
        msg,
        PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
      );
      break;
    }
    case 'session_branch_reset': {
      const sp = msg.sessionPath;
      const targetIds = [...new Set([msg.clientMessageId, msg.messageId, msg.projectionMessageId]
        .filter((id): id is string => typeof id === 'string' && !!id))];
      if (!sp || targetIds.length === 0) { console.warn('[ws] session_branch_reset missing sessionPath or message id'); break; }
      let truncated = false;
      for (const targetId of targetIds) {
        if (useStore.getState().truncateSessionFromMessage(sp, targetId)) {
          truncated = true;
          break;
        }
      }
      bumpMessageLiveVersion(sp);
      if (!truncated) {
        console.warn('[ws] session_branch_reset target message not found:', sp, targetIds);
      }
      if (Array.isArray(msg.todos)) {
        useStore.getState().setSessionTodosForPath(sp, msg.todos);
        useStore.getState().bumpTodosLiveVersion(sp);
      }
      useStore.getState().applyBranchResetSessionFiles(
        sp,
        Array.isArray(msg.sessionFiles) ? msg.sessionFiles : null,
      );
      break;
    }

    case 'stream_resume':
      replayStreamResume(msg);
      break;

    case 'session_title':
      if (msg.title) {
        useStore.setState({
          sessions: state.sessions.map((s: any) =>
            s.path === msg.path ? { ...s, title: msg.title } : s,
          ),
        });
      }
      break;

    case 'session_created':
      upsertCreatedSession(msg);
      scheduleSessionsRefresh('session_created');
      break;

    case 'browser_status': {
      const bsp = msg.sessionPath;
      if (!bsp) { console.warn('[ws] event missing sessionPath:', msg.type); break; }
      const bRunning = !!msg.running;
      const bUrl = msg.url || null;
      const prev = browserStateForPath(state, bsp);
      const hasFreshThumbnail = bRunning && typeof msg.thumbnail === 'string' && msg.thumbnail.length > 0;
      const bThumbnail = bRunning ? (hasFreshThumbnail ? msg.thumbnail : prev?.thumbnail ?? null) : null;
      const thumbnailCapturedAt = bRunning
        ? hasFreshThumbnail
          ? (typeof msg.thumbnailCapturedAt === 'number' ? msg.thumbnailCapturedAt : Date.now())
          : prev?.thumbnailCapturedAt ?? null
        : null;
      const thumbnailUrl = bRunning
        ? hasFreshThumbnail
          ? (typeof msg.thumbnailUrl === 'string' ? msg.thumbnailUrl : bUrl)
          : prev?.thumbnailUrl ?? null
        : null;
      const thumbnailFresh = bRunning && hasFreshThumbnail;
      // 卡片的"收起"是用户意图，状态更新不该把它抹掉；只有浏览器重新启用（running false→true）
      // 才算新一轮会话，卡片回归。
      const collapsed = bRunning && !prev?.running ? false : (prev?.collapsed ?? false);
      setBrowserStateForPath(bsp, { running: bRunning, url: bUrl, thumbnail: bThumbnail, thumbnailCapturedAt, thumbnailUrl, thumbnailFresh, collapsed });
      break;
    }

    case 'todo_update': {
      const sp = msg.sessionPath;
      if (!sp) { console.warn('[ws] event missing sessionPath:', msg.type); break; }
      useStore.getState().setSessionTodosForPath(sp, Array.isArray(msg.todos) ? msg.todos : []);
      useStore.getState().bumpTodosLiveVersion(sp);
      break;
    }

    case 'browser_bg_status': {
      const bgSp = msg.sessionPath;
      if (!bgSp) { console.warn('[ws] event missing sessionPath:', msg.type); break; }
      const prev = browserStateForPath(useStore.getState(), bgSp);
      setBrowserStateForPath(bgSp, { ...prev, running: !!msg.running });
      break;
    }

    case 'computer_overlay': {
      const sp = msg.sessionPath;
      if (!sp) { console.warn('[ws] event missing sessionPath:', msg.type); break; }
      if (msg.phase === 'clear') {
        useStore.getState().clearComputerOverlayForSession(sp);
      } else {
        useStore.getState().setComputerOverlayForSession(sp, {
          phase: msg.phase || 'running',
          action: msg.action || 'computer',
          agentId: msg.agentId ?? null,
          leaseId: msg.leaseId ?? null,
          snapshotId: msg.snapshotId ?? null,
          target: msg.target ?? null,
          inputMode: msg.inputMode === 'foreground-input' ? 'foreground-input' : 'background',
          visualSurface: msg.visualSurface === 'provider' ? 'provider' : 'renderer',
          requiresForeground: msg.requiresForeground === true,
          interruptKey: msg.interruptKey ?? null,
          errorCode: msg.errorCode ?? null,
          ts: msg.ts || Date.now(),
        });
      }
      break;
    }

    case 'block_update': {
      const { taskId, patch, sessionPath: sp } = msg;
      if (!taskId || !patch) break;
      if (!sp) { console.warn('[ws] event missing sessionPath:', msg.type); break; }
      useStore.getState().patchBlockByTaskId(sp, taskId, patch);
      break;
    }

    case 'activity_update':
      if (msg.activity) {
        useStore.setState((current: any) => {
          const incoming = msg.activity;
          const existing = current.activities.find((activity: any) => activity.id === incoming.id);
          const merged = existing ? { ...existing, ...incoming } : incoming;
          return {
            activities: [
              merged,
              ...current.activities.filter((activity: any) => activity.id !== incoming.id),
            ].slice(0, 500),
          };
        });
      }
      break;

    case 'agent_activity':
      // 统一 Agent Activity 真相源（ActivityHub 广播）：subagent / workflow / 巡检
      if (msg.entry?.id) {
        useStore.getState().upsertAgentActivity(msg.entry);
      }
      break;

    case 'notification':
      if (window.luc?.showNotification) {
        // agentId 标识触发通知的助手，主进程据此读取该 agent 头像作为通知 icon。
        // 缺失时透传 null，主进程退回无 icon，禁止从当前焦点 agent 兜底。
        window.luc.showNotification(msg.title, msg.body, msg.agentId ?? null, {
          desktopFocusPolicy: resolveNotificationDesktopFocusPolicy(msg),
        });
      }
      break;

    case 'bridge_status':
      useStore.getState().triggerBridgeReload();
      break;

    case 'plugin_ui_changed':
      import('../stores/plugin-ui-actions').then(m => m.refreshPluginUI());
      break;

    case 'app_event':
      if (msg.event?.type) {
        handleAppEvent(msg.event.type, msg.event.payload || {}, { source: msg.event.source || 'server' });
      }
      break;

    case 'bridge_message':
      if (msg.message) {
        useStore.getState().addBridgeMessage(msg.message);
      }
      break;

    case 'agent_review_status': {
      const sp = nonEmptyString(msg.sessionPath);
      const requestId = nonEmptyString(msg.requestId);
      if (!sp || !requestId) break;
      const session = sessionScopedValue(useStore.getState(), useStore.getState().chatSessions, sp);
      const item = session?.items.find((candidate: any) => (
        candidate.type === 'message' && candidate.data.role === 'user' && candidate.data.id === requestId
      ));
      if (!item || item.type !== 'message') break;
      useStore.getState().appendOptimisticUserMessage(sp, {
        ...item.data,
        agentReview: {
          requestId,
          status: msg.status,
          reviewedSessionId: msg.reviewedSessionId ?? null,
          reviewerSessionId: msg.reviewerSessionId ?? null,
          reviewerAgentId: msg.reviewerAgentId,
          reviewerAgentName: msg.reviewerAgentName,
          text: msg.result ?? item.data.agentReview?.text ?? null,
          error: msg.error ?? null,
        },
      });
      break;
    }

    case 'session_user_message': {
      const sp = msg.sessionPath;
      if (!sp || !msg.message) break;
      const current = useStore.getState();
      if (!sessionScopedValue(current, current.chatSessions, sp)) {
        useStore.getState().initSession(sp, [], false);
      }
      if (msg.__fromReplay === true && replayUserMessageAlreadyHydrated(sp, msg.message)) {
        break;
      }
      const text = typeof msg.message.text === 'string' ? msg.message.text : '';
      const clientMessageId = typeof msg.clientMessageId === 'string' && msg.clientMessageId
        ? msg.clientMessageId
        : typeof msg.message.clientMessageId === 'string' && msg.message.clientMessageId
          ? msg.message.clientMessageId
          : null;
      const serverMessageId = typeof msg.message.id === 'string' && msg.message.id
        ? msg.message.id
        : typeof msg.message.sourceEntryId === 'string' && msg.message.sourceEntryId
          ? msg.message.sourceEntryId
          : undefined;
      const data = {
        id: clientMessageId || serverMessageId || `user-${Date.now()}`,
        sourceEntryId: serverMessageId,
        role: 'user' as const,
        text,
        textHtml: text ? renderMarkdown(text) : undefined,
        timestamp: normalizeMessageTimestamp(msg.message.timestamp),
        attachments: msg.message.attachments,
        quotedText: msg.message.quotedText,
        skills: msg.message.skills,
        sessionRefs: msg.message.sessionRefs ?? undefined,
        agentMentions: msg.message.agentMentions ?? undefined,
        agentReview: msg.message.agentReview ?? undefined,
        agentReviewRequest: msg.message.agentReviewRequest ?? undefined,
        deskContext: msg.message.deskContext ?? undefined,
        origin: msg.message.origin ?? undefined,
      };
      if (clientMessageId && useStore.getState().confirmOptimisticUserMessage(sp, clientMessageId, data)) {
        bumpMessageLiveVersion(sp);
        if (sp === useStore.getState().currentSessionPath) {
          useStore.setState({ welcomeVisible: false });
        }
        break;
      }
      useStore.getState().appendItem(sp, { type: 'message', data });
      bumpMessageLiveVersion(sp);
      if (sp === useStore.getState().currentSessionPath) {
        useStore.setState({ welcomeVisible: false });
      }
      break;
    }

    case 'voice_transcription_update': {
      applyVoiceTranscriptionUpdate(msg);
      break;
    }

    case 'bridge_rc_attached': {
      const sp = msg.sessionPath;
      if (sp && msg.sessionKey) {
        useStore.setState((s) => ({
          sessions: s.sessions.map((session) => session.path === sp
            ? {
              ...session,
              rcAttachment: {
                sessionKey: msg.sessionKey,
                platform: msg.platform || 'bridge',
                title: msg.title || null,
              },
            }
            : session),
        }));
      }
      break;
    }

    case 'bridge_rc_detached': {
      const sp = msg.sessionPath;
      if (sp) {
        useStore.setState((s) => ({
          sessions: s.sessions.map((session) => session.path === sp
            ? { ...session, rcAttachment: null }
            : session),
        }));
      }
      break;
    }

    case 'session_metadata_updated': {
      const sp = msg.sessionPath;
      const sid = typeof msg.sessionId === 'string' && msg.sessionId.trim() ? msg.sessionId.trim() : null;
      const metadata = msg.metadata && typeof msg.metadata === 'object' ? msg.metadata : {};
      if (!sp) { console.warn('[ws] event missing sessionPath:', msg.type); break; }
      const hasPinnedAt = Object.prototype.hasOwnProperty.call(metadata, 'pinnedAt');
      const hasPinOrder = Object.prototype.hasOwnProperty.call(metadata, 'pinOrder');
      const hasProjectId = Object.prototype.hasOwnProperty.call(metadata, 'projectId');
      if (hasPinnedAt || hasPinOrder || hasProjectId) {
        useStore.setState((s) => ({
          sessions: s.sessions.map((session) => {
            if (session.path !== sp && (!sid || session.sessionId !== sid)) return session;
            return {
              ...session,
              ...(hasPinnedAt
                ? { pinnedAt: typeof metadata.pinnedAt === 'string' ? metadata.pinnedAt : null }
                : {}),
              ...(hasPinOrder
                ? { pinOrder: typeof metadata.pinOrder === 'number' ? metadata.pinOrder : null }
                : {}),
              ...(hasProjectId
                ? { projectId: typeof metadata.projectId === 'string' && metadata.projectId.trim() ? metadata.projectId.trim() : null }
                : {}),
            };
          }),
        }));
      }
      if (sp === useStore.getState().currentSessionPath && typeof metadata.thinkingLevel === 'string') {
        useStore.getState().setThinkingLevel(metadata.thinkingLevel);
      }
      break;
    }

    case 'plan_mode': {
      if (isFocusedSessionMessage(msg)) {
        const mode = msg.mode || (msg.enabled ? 'read_only' : 'operate');
        syncSessionPermissionMode(mode);
        window.dispatchEvent(new CustomEvent('luc-plan-mode', {
          detail: { enabled: !!msg.enabled, mode },
        }));
      }
      break;
    }

    case 'permission_mode': {
      if (isFocusedSessionMessage(msg)) {
        syncSessionPermissionMode(msg.mode);
        window.dispatchEvent(new CustomEvent('luc-plan-mode', {
          detail: { enabled: msg.mode === 'read_only', mode: msg.mode },
        }));
      }
      break;
    }

    case 'access_mode': {
      if (isFocusedSessionMessage(msg)) {
        const mode = msg.permissionMode || msg.mode;
        syncSessionPermissionMode(mode);
        window.dispatchEvent(new CustomEvent('luc-plan-mode', {
          detail: {
            enabled: msg.readOnly === true,
            mode,
          },
        }));
      }
      break;
    }

    case 'channel_new_message': {
      const store = useStore.getState();
      const knownChannel = store.channels.some((channel) => channel.id === msg.channelName);
      const isVisibleCurrentChannel =
        store.currentTab === 'channels'
        && store.currentChannel === msg.channelName
        && document.visibilityState === 'visible';
      if (msg.channelName && msg.message) {
        if (!knownChannel) loadChannelsAction();
        appendChannelMessageAction(msg.channelName, msg.message, { markRead: isVisibleCurrentChannel });
      } else if (msg.channelName && isVisibleCurrentChannel) {
        markChannelMessagesDirtyAction(msg.channelName);
        openChannelAction(msg.channelName);
      } else if (msg.channelName) {
        markChannelMessagesDirtyAction(msg.channelName);
        loadChannelsAction();
      }
      break;
    }

    case 'channel_created': {
      loadChannelsAction();
      break;
    }

    case 'dm_new_message': {
      const store2 = useStore.getState();
      const peerId = resolveDmPeerIdForEvent(store2, msg);
      if (!peerId) {
        loadChannelsAction();
        break;
      }
      const dmId = `dm:${peerId}`;
      const isViewingDM = store2.currentTab === 'channels' && store2.currentChannel === dmId && document.visibilityState === 'visible';
      if (isViewingDM) {
        openChannelAction(dmId, true);
      } else {
        loadChannelsAction();
      }
      break;
    }

    case 'conversation_agent_activity': {
      if (msg.activity) {
        upsertConversationAgentActivityAction(msg.activity);
      }
      break;
    }

    case 'context_usage': {
      const sp = msg.sessionPath;
      if (!sp) { console.warn('[ws] event missing sessionPath:', msg.type); break; }
      const existingWindow = sessionScopedValue(useStore.getState(), useStore.getState().contextBySession, sp)?.window ?? null;
      const window = msg.contextWindow ?? existingWindow;
      if (msg.tokens != null || window != null || msg.percent != null) {
        updateKeyed('contextBySession', sp,
          { tokens: msg.tokens ?? null, window, percent: msg.percent ?? null },
          (_s, d) => ({ contextTokens: d.tokens, contextWindow: d.window, contextPercent: d.percent }),
        );
      }
      break;
    }

    case 'error': {
      const { sessionPath: sp } = sessionIdentityFromMessage(msg);
      const presented = presentError(errorWithCode(
        String(msg.message ?? ''),
        typeof msg.code === 'string' ? msg.code : null,
      ));
      if (!sp) {
        // 身份类错误本身就说明没有会话可以挂靠，落不到 inline 位，只能弹 toast。
        // internal_contract 同理：服务端认定调用方没带身份，用户看不到就等于故障消失了。
        if (
          msg.code === 'session_identity_unresolved'
          || msg.code === 'session_identity_mismatch'
          || msg.code === 'internal_contract'
        ) {
          useStore.getState().addToast(presented.text, 'error', 6000, { errorCode: msg.code });
        } else {
          console.warn('[ws] event missing sessionPath:', msg.type);
        }
        break;
      }
      useStore.getState().setInlineError(sp, presented);
      break;
    }

    case 'confirmation_resolved': {
      // 更新所有 session 中匹配 confirmId 的确认卡片状态。确认块可能不在最后一条消息，
      // 输入区也从消息块派生 pending 状态，所以这里按 session/message/block 三层显式定位。
      const nextStatusFor = (blockType: string): string => {
        if (msg.action === 'confirmed') return blockType === 'cron_confirm' || blockType === 'suggestion_card' ? 'approved' : 'confirmed';
        if (msg.action === 'timeout') return 'timeout';
        return 'rejected';
      };
      let changedPaths: string[] = [];
      useStore.setState((s: any) => {
        const chatSessions = s.chatSessions || {};
        let changed = false;
        const nextSessions: Record<string, any> = {};

        for (const [sp, session] of Object.entries(chatSessions) as Array<[string, any]>) {
          let sessionChanged = false;
          const items = (session.items || []).map((item: any) => {
            if (item.type !== 'message' || !item.data?.blocks) return item;
            let messageChanged = false;
            const blocks = item.data.blocks.map((b: any) => {
              const matchesType = b.type === 'settings_confirm'
                || b.type === 'cron_confirm'
                || b.type === 'suggestion_card'
                || b.type === 'session_confirmation';
              if (!matchesType || b.confirmId !== msg.confirmId) return b;
              messageChanged = true;
              return { ...b, status: nextStatusFor(b.type) };
            });
            if (!messageChanged) return item;
            sessionChanged = true;
            return { ...item, data: { ...item.data, blocks } };
          });
          if (!sessionChanged) {
            nextSessions[sp] = session;
            continue;
          }
          changed = true;
          changedPaths.push(sp);
          nextSessions[sp] = { ...session, items };
        }

        return changed ? { chatSessions: nextSessions } : {};
      });
      useStore.getState().resolvePendingSessionConfirmation?.(msg.confirmId);
      changedPaths = Array.from(new Set(changedPaths));
      for (const sp of changedPaths) bumpMessageLiveVersion(sp);
      break;
    }

    case 'apply_frontend_setting': {
      if (msg.key === 'theme') {
        window.applyTheme?.(msg.value);
        // 通知其他窗口（设置窗口等）同步主题
        window.platform?.settingsChanged?.('theme-changed', { theme: msg.value });
      }
      break;
    }

    case 'abort_result': {
      if (msg.status !== 'already_stopped') break;
      const sp = msg.sessionPath || null;
      const sid = typeof msg.sessionId === 'string' && msg.sessionId.trim() ? msg.sessionId.trim() : null;
      const streamId = typeof msg.streamId === 'string' && msg.streamId.trim() ? msg.streamId.trim() : null;
      const applied = applyStreamingStatus(false, sp, { streamId }, { force: !streamId });
      if (sp && applied) streamBufferManager.finishTurn(sp, sid);
      break;
    }

    case 'status': {
      const sp = msg.sessionPath || null;
      const sid = typeof msg.sessionId === 'string' && msg.sessionId.trim() ? msg.sessionId.trim() : null;
      // streamingSessions 维护 + 焦点 UI 占位一并由 applyStreamingStatus 处理
      const applied = applyStreamingStatus(msg.isStreaming, sp, {
        streamId: msg.streamId ?? null,
        turnId: msg.turnId ?? null,
      });
      if (sp && applied) {
        if (msg.isStreaming) streamBufferManager.beginTurn(sp, sid);
        else streamBufferManager.finishTurn(sp, sid);
      }
      break;
    }

    case 'slash_result': {
      if (typeof window === 'undefined') break;
      if (!isFocusedSessionMessage(msg)) break;
      const text = typeof msg.text === 'string' ? msg.text.trim() : '';
      if (!text) break;
      window.dispatchEvent(new CustomEvent('luc-inline-notice', {
        detail: {
          text,
          type: msg.level === 'error' || msg.error ? 'error' : 'success',
        },
      }));
      break;
    }
  }
}

function applyToolEndSessionFile(msg: any): void {
  const sp = msg.sessionPath;
  const sessionFile = msg.details?.sessionFile;
  if (!sp || !sessionFile) return;
  useStore.getState().upsertSessionRegistryFile?.(sp, sessionFile);
}

function applyContentBlockSessionFile(msg: any): void {
  const sp = msg.sessionPath;
  const block = msg.block;
  if (!sp || block?.type !== 'file') return;
  useStore.getState().upsertSessionRegistryFile?.(sp, {
    id: block.fileId,
    fileId: block.fileId,
    filePath: block.filePath,
    label: block.label,
    ext: block.ext,
    mime: block.mime,
    kind: block.kind,
    storageKind: block.storageKind,
    presentation: block.presentation,
    listed: block.listed,
    status: block.status,
    missingAt: block.missingAt,
    mtimeMs: block.mtimeMs,
    size: block.size,
    version: block.version,
    resource: block.resource,
    origin: block.origin,
    operations: block.operations,
  });
}
