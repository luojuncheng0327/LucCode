/**
 * WebSocket 聊天路由
 *
 * 桥接 Pi SDK streaming 事件 → WebSocket 消息
 * 支持多 session 并发：所有 session 事件平等广播，前端按 sessionPath 路由
 */
import { Hono } from "hono";
import { MoodParser, ThinkTagParser, CardParser } from "../../core/events.ts";
import { dropUninstalledPluginCards, extractBlocks, pluginInstalledPredicate } from "../block-extractors.ts";
import { normalizePluginChatSurfaceBlocks } from "../plugin-chat-surface.ts";
import { toAppEventWsMessage } from "../app-events.ts";
import { toResourceEventWsMessage } from "../resource-events-ws.ts";
import {
  createSessionStreamEventWsMessage,
  createStreamResumeWsMessage,
  wsSend,
  wsParse,
  wsSendSerialized,
} from "../ws-protocol.ts";
import { debugLog, createModuleLogger } from "../../lib/debug-log.ts";
import { t } from "../../lib/i18n.ts";
import { getLastAssistantUsage } from "../../lib/pi-sdk/index.ts";
import {
  compactSessionWithCachePreservationRecoveringRuntime,
  runLossyLocalCompactionForSession,
} from "../../core/session-compactor.ts";
import {
  getResolvedCompactionMode,
  getResolvedInstantSimpleCompactionEnabled,
  INSTANT_SIMPLE_COMPACTION_METHOD,
  INSTANT_SIMPLE_COMPACTION_RUNTIME_MODE,
  normalizeCompactionLifecycleMode,
} from "../../shared/compaction-mode.ts";
import { submitDesktopSessionInterjection, submitDesktopSessionMessage } from "../../core/desktop-session-submit.ts";
import {
  AgentReviewTurnCoordinator,
  buildSessionReferenceBlock,
  normalizeSessionReferences,
} from "../../lib/agent-review/turn-coordinator.ts";
import { logLlmUsage } from "../../lib/llm/usage-observer.ts";
import { BrowserManager } from "../../lib/browser/browser-manager.ts";
import {
  createSessionStreamState,
  beginSessionStream,
  finishSessionStream,
  appendSessionStreamEvent,
  resumeSessionStream,
} from "../session-stream-store.ts";
import { resolveWsSessionContext } from "./ws-session-context.ts";
import { visiblePromptText } from "../../core/session-reminders.ts";
import { AppError } from "../../shared/errors.ts";
import { errorBus } from "../../shared/error-bus.ts";
import { createRequestContext } from "../http/boundary.ts";
import { buildDeferredResultInterludeBlock, resolveDeferredReceiverName } from "../deferred-result-interlude.ts";
import { DEFERRED_RESULT_MESSAGE_TYPE } from "../../lib/deferred-result-notification.ts";
import {
  TURN_INPUT_CONSUMPTION_EVENT_TYPE,
  TURN_INPUT_PRESENTATION_EVENT_TYPE,
  buildTurnInputConsumptionRecord,
  buildTurnInputPresentationEvent,
  isHiddenTurnInputMessage,
  isSessionTurnInputEntry,
} from "../../lib/turn-input-presentation.ts";
import { buildAutomationSuggestionBlock } from "../suggestion-blocks.ts";
import { isAllowedChatImageMime, isChatImageBase64WithinLimit } from "../../shared/image-mime.ts";
import { isAllowedChatVideoMime, isChatVideoBase64WithinLimit } from "../../shared/video-mime.ts";
import { isAllowedChatAudioMime, isChatAudioBase64WithinLimit } from "../../shared/audio-mime.ts";
import { getAssistantTextPhase } from "../../shared/text-signature.ts";
import { summarizeToolArgs } from "../../shared/tool-arg-summary.ts";
import { projectLiveToolResultOutcome } from "../../shared/tool-outcome.ts";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import {
  createWsClientRecord,
  subscribeWsClientToSession,
  wsClientCanReceiveEvent,
  wsClientCanSendMessage,
} from "../ws-scope.ts";

const log = createModuleLogger("chat");
const wsLog = createModuleLogger("ws");

export function summarizeToolStartArgs(toolName: any, rawArgs: any, startedAt = Date.now()) {
  void toolName;
  void startedAt;
  return summarizeToolArgs(rawArgs);
}

/**
 * 从 Pi SDK 的 content 块中提取纯文本
 */
function extractText(content: any) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(b => b.type === "text" && b.text)
    .map(b => b.text)
    .join("");
}

function persistedTurnEntryIds(engine: any, sessionPath: string) {
  const branch = engine.getSessionByPath?.(sessionPath)?.sessionManager?.getBranch?.();
  if (!Array.isArray(branch) || branch.length === 0) {
    return { turnInputEntryId: null, userEntryId: null, assistantEntryId: null };
  }

  let lastTurnInputIndex = -1;
  let lastAssistantIndex = -1;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (lastTurnInputIndex < 0 && isSessionTurnInputEntry(entry)) lastTurnInputIndex = index;
    if (
      lastAssistantIndex < 0
      && entry?.type === "message"
      && entry.message?.role === "assistant"
    ) lastAssistantIndex = index;
    if (lastTurnInputIndex >= 0 && lastAssistantIndex >= 0) break;
  }
  if (lastTurnInputIndex < 0) {
    return { turnInputEntryId: null, userEntryId: null, assistantEntryId: null };
  }

  let turnInputIndex = lastTurnInputIndex;
  let assistantEntryId = null;
  if (lastAssistantIndex > lastTurnInputIndex) {
    assistantEntryId = branch[lastAssistantIndex]?.id || null;
    for (let index = lastAssistantIndex - 1; index >= 0; index -= 1) {
      if (isSessionTurnInputEntry(branch[index])) {
        turnInputIndex = index;
        break;
      }
    }
  }
  const turnInputEntry = branch[turnInputIndex];
  const turnInputEntryId = turnInputEntry?.id || null;
  const visibleUserEntry = turnInputEntry?.type === "message"
    && turnInputEntry.message?.role === "user"
    && !isHiddenTurnInputMessage(turnInputEntry.message);
  return {
    turnInputEntryId,
    userEntryId: visibleUserEntry ? turnInputEntryId : null,
    assistantEntryId,
  };
}

function deferredResultFileBlocks(result: any, taskId: any = null) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return [];
  const sessionFiles = Array.isArray(result.sessionFiles) ? result.sessionFiles : [];
  return sessionFiles
    .map((file) => sessionFileToContentBlock(file, taskId ? { replacesTaskId: taskId } : undefined))
    .filter(Boolean);
}

function sessionFileToContentBlock(file: any, extra: any = undefined) {
  if (!file || typeof file !== "object") return null;
  const filePath = file.filePath || file.realPath || null;
  if (!filePath) return null;
  const fileId = file.fileId || file.id || null;
  const label = file.label || file.displayName || file.filename || path.basename(filePath);
  const ext = file.ext ?? path.extname(filePath || label).toLowerCase().replace(/^\./, "");
  return {
    type: "file",
    ...(extra || {}),
    ...(fileId ? { fileId } : {}),
    filePath,
    label,
    ext,
    ...(file.mime ? { mime: file.mime } : {}),
    ...(file.kind ? { kind: file.kind } : {}),
    ...(file.storageKind ? { storageKind: file.storageKind } : {}),
    ...(file.presentation ? { presentation: file.presentation } : {}),
    ...(file.listed !== undefined ? { listed: file.listed !== false } : {}),
    ...(file.status ? { status: file.status } : {}),
    ...(file.missingAt !== undefined ? { missingAt: file.missingAt } : {}),
    ...(file.mtimeMs !== undefined ? { mtimeMs: file.mtimeMs } : {}),
    ...(file.size !== undefined ? { size: file.size } : {}),
    ...(file.version ? { version: file.version } : {}),
    ...(file.waveform ? { waveform: file.waveform } : {}),
    ...(file.resource ? { resource: file.resource } : {}),
  };
}

function deferredResultFailureBlock(event: any) {
  const metaType = event?.meta?.type || "";
  const mediaKind = event?.meta?.mediaKind || (metaType === "video-generation" ? "video" : (metaType === "image-generation" ? "image" : null));
  if (!mediaKind || !event?.taskId) return null;
  return {
    type: "media_generation",
    taskId: event.taskId,
    kind: mediaKind,
    status: event.status === "aborted" ? "aborted" : "failed",
    ...(event.reason ? { reason: event.reason } : {}),
    ...(event.meta?.prompt ? { prompt: event.meta.prompt } : {}),
  };
}

export function toCompactionLifecycleWsMessage(
  event: any,
  sessionPath: any,
  getSessionByPath: any,
  getSessionIdForPath: any,
  getCompactionMode?: any,
) {
  if (!sessionPath) return null;
  const sessionId = getSessionIdForPath?.(sessionPath) ?? null;
  const rawMode = event?.mode ?? getCompactionMode?.();
  const mode = rawMode == null ? null : normalizeCompactionLifecycleMode(rawMode);
  if (event.type === "compaction_start") {
    return {
      type: "compaction_start",
      sessionId,
      sessionPath,
      reason: event.reason ?? null,
      ...(mode ? { mode } : {}),
    };
  }
  if (event.type !== "compaction_end") return null;

  const usage = getSessionByPath?.(sessionPath)?.getContextUsage?.();
  return {
    type: "compaction_end",
    sessionId,
    sessionPath,
    reason: event.reason ?? null,
    aborted: event.aborted ?? false,
    willRetry: event.willRetry ?? false,
    ...(mode ? { mode } : {}),
    tokens: usage?.tokens ?? null,
    contextWindow: usage?.contextWindow ?? null,
    percent: usage?.percent ?? null,
  };
}

function normalizedIdentity(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sessionIdForLegacyCompactPath(engine: any, sessionPath: string) {
  try {
    return normalizedIdentity(engine.getSessionIdForPath?.(sessionPath));
  } catch {
    return null;
  }
}

export function buildDesktopSlashSessionRef(engine: any, agentId: string, sessionPath: string) {
  const sessionId = sessionIdForLegacyCompactPath(engine, sessionPath);
  return {
    kind: "desktop",
    agentId,
    sessionPath,
    ...(sessionId ? { sessionId } : {}),
  };
}

// compact 只接受 manifest 当前定位器：压缩会重写 JSONL，落到过期路径上等于写错文件。
export function resolveCompactSessionTarget(engine: any, msg: any) {
  const ctx = resolveWsSessionContext(engine, msg, { requireManifestLocator: true });
  // 显式比较 false 而不是 !ctx.ok：server 侧关掉了 strictNullChecks，此时对显式声明的
  // 判别联合取反不会收窄到错误分支（推导出来的 as const 联合不受此限）。
  if (ctx.ok === false) {
    return { ok: false as const, code: ctx.code, message: ctx.message, sessionId: ctx.sessionId };
  }
  return { ok: true as const, sessionId: ctx.sessionId, sessionPath: ctx.sessionPath };
}

function compactionNoopReason(message: string) {
  if (message.includes("Already compacted")) return "already_compacted";
  if (message.includes("Nothing to compact")) return "nothing_to_compact";
  return null;
}

export function toNotificationWsMessage(event: any, sessionPath: any = null) {
  const desktopFocusPolicy = event.desktopFocusPolicy === "when_session_unfocused"
    ? "when_session_unfocused"
    : event.desktopFocusPolicy === "when_unfocused"
      ? "when_unfocused"
      : "always";
  return {
    type: "notification",
    title: event.title,
    body: event.body,
    // 携带触发 agent 的 agentId，展示侧据此显示对应助手头像（多 agent 并发定时任务可分辨身份）。
    // 缺失时归一化为 null，由消费侧退回无 icon 行为，禁止从全局焦点兜底。
    agentId: event.agentId ?? null,
    desktopFocusPolicy,
    sessionPath: event.sessionPath ?? sessionPath ?? null,
  };
}

// ActivityHub（统一 Agent Activity 真相源）广播：subagent / workflow / 巡检 / cron。
// 必须带顶层 sessionPath —— wsClientCanReceiveEvent 靠它给非本地（PWA/远程）client 做
// session 订阅校验，缺失会 fail-closed。优先用 listener 第二参数（emit 时的权威 sessionPath），
// entry.sessionPath 兜底。
export function toAgentActivityWsMessage(event: any, sessionPath: any) {
  if (!event || event.type !== "agent_activity") return null;
  return {
    type: "agent_activity",
    entry: event.entry,
    sessionPath: sessionPath ?? event.entry?.sessionPath ?? null,
  };
}

export const DEFAULT_DISCONNECT_ABORT_GRACE_MS = 5 * 60_000;
export const DEFAULT_TURN_STALL_ABORT_MS = 20 * 60_000;

export function resolveDisconnectAbortGraceMs(value = process.env.LUC_WS_DISCONNECT_ABORT_GRACE_MS) {
  if (value === undefined || value === null || value === "") return DEFAULT_DISCONNECT_ABORT_GRACE_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_DISCONNECT_ABORT_GRACE_MS;
  return Math.floor(parsed);
}

export function resolveTurnStallAbortMs(value = process.env.LUC_TURN_STALL_ABORT_MS) {
  if (value === undefined || value === null || value === "") return DEFAULT_TURN_STALL_ABORT_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_TURN_STALL_ABORT_MS;
  return Math.floor(parsed);
}

export function createChatRoute(engine: any, hub: any, {
  upgradeWebSocket,
  runInstantSimpleCompaction = runLossyLocalCompactionForSession,
}: any) {
  const restRoute = new Hono();
  const wsRoute = new Hono();

  let activeWsClients = 0;
  let disconnectAbortTimer = null;
  const disconnectAbortGraceMs = resolveDisconnectAbortGraceMs();
  const turnStallAbortMs = resolveTurnStallAbortMs();
  const sessionState = new Map(); // sessionId || legacy sessionPath -> shared stream state

  function cancelDisconnectAbort() {
    if (disconnectAbortTimer) {
      clearTimeout(disconnectAbortTimer);
      disconnectAbortTimer = null;
    }
  }

  function scheduleDisconnectAbort() {
    if (disconnectAbortTimer || activeWsClients > 0) return;
    if (disconnectAbortGraceMs === 0) return;
    disconnectAbortTimer = setTimeout(() => {
      disconnectAbortTimer = null;
      if (activeWsClients > 0) return;

      // 中断所有正在 streaming 的 owner session（焦点 + 后台）
      for (const [, ss] of sessionState) ss.isAborted = true;
      debugLog()?.log("ws", `no clients for ${disconnectAbortGraceMs}ms, aborting all streaming`);
      engine.abortAllStreaming().catch(() => {});
    }, disconnectAbortGraceMs);
    disconnectAbortTimer.unref?.();
  }

  const MAX_SESSION_STATES = 100;

  // 所有 WS 分支的身份入口：解析一次，失败就地回错，成功的结果由 handler 直接消费。
  function requireWsSessionContext(msg, ws) {
    const ctx = resolveWsSessionContext(engine, msg);
    if (ctx.ok === false) {
      wsSend(ws, {
        type: "error",
        code: ctx.code,
        message: ctx.message,
        ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
        ...(ctx.sessionPath ? { sessionPath: ctx.sessionPath } : {}),
      });
      return null;
    }
    return ctx;
  }

  // compact 走 resolveCompactSessionTarget（错误回包形状与前端路由绑定，不能换成通用
  // 身份错误），拿不到解析结果里的归属标记，所以这一条分支仍单独问引擎要删除状态。
  // 问的是同一个归属权威，不是另开身份来源。
  function isDeletedAgentSessionPath(sessionPath) {
    if (!sessionPath) return false;
    return engine.isDeletedAgentSession?.(sessionPath) === true;
  }

  function rejectDeletedAgentSession(ws, sessionPath) {
    wsSend(ws, { type: "error", message: "agent_deleted", sessionPath });
  }

  function sessionIdForPath(sessionPath) {
    if (!sessionPath) return null;
    try {
      const sessionId = engine.getSessionIdForPath?.(sessionPath);
      return typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : null;
    } catch {
      return null;
    }
  }

  function sessionStateKey(sessionPath) {
    return sessionIdForPath(sessionPath) || sessionPath;
  }

  function getState(sessionPath) {
    if (!sessionPath) return null;
    const key = sessionStateKey(sessionPath);
    if (key !== sessionPath && sessionState.has(sessionPath) && !sessionState.has(key)) {
      sessionState.set(key, sessionState.get(sessionPath));
      sessionState.delete(sessionPath);
    }
    if (!sessionState.has(key)) {
      // 超过上限时，循环淘汰非流式的最久未访问 entry
      while (sessionState.size >= MAX_SESSION_STATES) {
        let oldest = null;
        let oldestTime = Infinity;
        for (const [sp, ss] of sessionState) {
          if (!ss.isStreaming && sp !== key && ss.lastAccessed < oldestTime) {
            oldest = sp;
            oldestTime = ss.lastAccessed;
          }
        }
        if (oldest) sessionState.delete(oldest);
        else break; // 全是流式 session，无法淘汰
      }
      sessionState.set(key, {
        thinkTagParser: new ThinkTagParser(),
        moodParser: new MoodParser(),
        cardParser: new CardParser(),
        _cardHints: [],
        _cardEmitted: false,
        isThinking: false,
        hasOutput: false,
        hasToolCall: false,
        hasThinking: false,
        hasError: false,
        assistantStopReason: null,
        isAborted: false,
        turnActive: false,
        titleRequested: false,
        titlePreview: "",
        pendingDeferredContentEvents: [],
        pendingTurnInputConsumptions: [],
        consumedTurnInputsForCurrentTurn: [],
        flushedTurnInputConsumptionKeys: new Set(),
        pendingTurnCompletionNotification: null,
        pendingPhaseTextByIndex: new Map(),
        turnStallTimer: null,
        lastStreamActivityAt: 0,
        lastAccessed: Date.now(),
        ...createSessionStreamState(),
      });
    }
    const ss = sessionState.get(key);
    ss.sessionPath = sessionPath;
    ss.lastAccessed = Date.now();
    return ss;
  }

  function getExistingState(sessionPath) {
    if (!sessionPath) return null;
    const key = sessionStateKey(sessionPath);
    if (key !== sessionPath && sessionState.has(sessionPath) && !sessionState.has(key)) {
      sessionState.set(key, sessionState.get(sessionPath));
      sessionState.delete(sessionPath);
    }
    const ss = sessionState.get(key) || null;
    if (ss) {
      ss.sessionPath = sessionPath;
      ss.lastAccessed = Date.now();
    }
    return ss;
  }

  const clients = new Map();

  function createInitialWsClientRecord(requestContext, { assumeLocalOwner = false } = {}) {
    return createWsClientRecord({
      principal: assumeLocalOwner
        ? {
            kind: "local_user",
            userId: requestContext.userId,
            studioId: requestContext.studioId,
            serverId: requestContext.serverId,
            serverNodeId: requestContext.serverNodeId,
            connectionKind: "local",
            credentialKind: "loopback_token",
            trustState: "local",
          }
        : requestContext.authPrincipal,
      subscriptions: requestContext.studioId
        ? [{ kind: "studio", studioId: requestContext.studioId }]
        : [],
    } as any);
  }

  function ensureWsClientRecord(ws, requestContext, options = {}) {
    const existing = clients.get(ws);
    if (existing) return existing;
    const client = createInitialWsClientRecord(requestContext, options);
    clients.set(ws, client);
    return client;
  }

  // 给所有携带 sessionPath 的事件强制注入 studioId（来自 server runtime context），
  // 让下游 wsClientCanReceiveEvent 的 sameStudio 校验有真实归属可比，不再用
  // receiver principal 的 studioId 做 fallback —— 避免 multi-studio 部署时
  // A studio 设备订阅 B studio session 后收到事件。
  function hardenStudio(msg) {
    if (!msg || typeof msg !== "object") return msg;
    if (msg.studioId) return msg;
    if (!msg.sessionPath) return msg;
    const studioId = engine.getRuntimeContext?.()?.studioId;
    if (!studioId) return msg;
    return { ...msg, studioId };
  }

  function broadcast(msg) {
    const hardenedMsg = hardenStudio(msg);
    // 扇出前解析一次 sessionId（不随每个订阅者重复解析）：event 本身若已带
    // sessionId（如 createSessionStreamEventWsMessage 产出的流事件）优先用它，
    // 否则按 sessionPath 现查一次。只用于 wsClientCanReceiveEvent 的匹配，
    // 不写回 hardenedMsg —— 出站 wire payload 保持原样，本机桌面端行为不变。
    const resolvedSessionId = hardenedMsg?.sessionPath && !hardenedMsg?.sessionId
      ? sessionIdForPath(hardenedMsg.sessionPath)
      : null;
    // 同一条消息发给 N 个 client 时只序列化一次。lazy：没有任何 client
    // 能收到时连 JSON.stringify 都省掉。
    let serialized = null;
    for (const [clientWs, client] of clients) {
      if (clientWs.readyState !== 1) continue; // OPEN
      if (wsClientCanReceiveEvent(client, hardenedMsg, { resolvedSessionId })) {
        if (serialized === null) serialized = JSON.stringify(hardenedMsg);
        wsSendSerialized(clientWs, serialized);
      }
    }
  }

  const agentReviewTurns = new AgentReviewTurnCoordinator({
    engine,
    submitSessionMessage: submitDesktopSessionMessage,
    emitStatus: (status, sessionPath) => broadcast({
      type: "agent_review_status",
      sessionId: status.reviewedSessionId,
      sessionPath,
      ...status,
    }),
  });

  // 浏览器缩略图 30s 定时刷新（browser 活跃时）
  let _browserThumbTimer = null;
  function startBrowserThumbPoll() {
    if (_browserThumbTimer) return;
    _browserThumbTimer = setInterval(async () => {
      const browser = BrowserManager.instance();
      if (!browser.hasAnyRunning) { stopBrowserThumbPoll(); return; }
      await Promise.all(browser.runningSessions.map(async (sp) => {
        const wasRunning = browser.isRunning(sp);
        const thumbnail = await browser.thumbnail(sp);
        if (thumbnail) {
          const url = browser.currentUrl(sp);
          broadcast({
            type: "browser_status",
            running: true,
            url,
            thumbnail,
            thumbnailCapturedAt: Date.now(),
            thumbnailUrl: url,
            sessionPath: sp,
          });
        } else if (wasRunning && !browser.isRunning(sp)) {
          broadcast({
            type: "browser_status",
            running: false,
            url: browser.currentUrl(sp),
            error: browser.sessionUnavailableReason?.(sp) || null,
            sessionPath: sp,
          });
        }
      }));
      if (!browser.hasAnyRunning) stopBrowserThumbPoll();
    }, 30_000);
  }
  function stopBrowserThumbPoll() {
    if (_browserThumbTimer) { clearInterval(_browserThumbTimer); _browserThumbTimer = null; }
  }

  function emitStreamEvent(sessionPath, ss, event) {
    const entry = appendSessionStreamEvent(ss, event);
    // Phase 4: 始终广播所有事件，前端按 sessionPath 路由到对应 panel
    broadcast(createSessionStreamEventWsMessage({
      sessionPath,
      sessionId: sessionIdForPath(sessionPath),
      sessionEvent: event,
      streamId: entry.streamId,
      seq: entry.seq,
    }));
    return entry;
  }

  function buildDeferredResultContentEvents(sessionPath, event) {
    const events = [];

    if (event.status === "success") {
      for (const block of enrichSessionFileBlocks(deferredResultFileBlocks(event.result, event.taskId), engine, sessionPath)) {
        events.push({ type: "content_block", block });
      }
    } else {
      const block = deferredResultFailureBlock(event);
      if (block) events.push({ type: "content_block", block });
    }

    return events;
  }

  function emitDeferredContentEvents(sessionPath, ss, events) {
    for (const deferredEvent of events) {
      emitStreamEvent(sessionPath, ss, deferredEvent);
    }
  }

  function queueOrEmitDeferredContentEvents(sessionPath, ss, events, { delayUntilTurnEnd = ss.isStreaming } = {}) {
    if (!events.length) return;
    if (delayUntilTurnEnd) {
      ss.pendingDeferredContentEvents.push(...events);
      return;
    }
    emitDeferredContentEvents(sessionPath, ss, events);
  }

  function flushPendingDeferredContentEvents(sessionPath, ss) {
    const pending = ss.pendingDeferredContentEvents || [];
    if (!pending.length) return;
    ss.pendingDeferredContentEvents = [];
    emitDeferredContentEvents(sessionPath, ss, pending);
  }

  function deferredContentEventTaskId(event) {
    const block = event?.block;
    if (!block || typeof block !== "object") return null;
    return textOrNull(block.taskId) || textOrNull(block.replacesTaskId);
  }

  function discardQueuedBranchTaskEvents(ss, taskIds) {
    const discarded = new Set(Array.isArray(taskIds) ? taskIds.filter(Boolean) : []);
    if (!discarded.size) return;
    ss.pendingDeferredContentEvents = (ss.pendingDeferredContentEvents || []).filter((event) => {
      const taskId = deferredContentEventTaskId(event);
      return !taskId || !discarded.has(taskId);
    });
    ss.pendingTurnInputConsumptions = (ss.pendingTurnInputConsumptions || []).filter((item) => {
      const taskId = textOrNull(item?.input?.taskId) || textOrNull(item?.block?.taskId);
      return !taskId || !discarded.has(taskId);
    });
    ss.consumedTurnInputsForCurrentTurn = (ss.consumedTurnInputsForCurrentTurn || []).filter((item) => {
      const taskId = textOrNull(item?.input?.taskId) || textOrNull(item?.block?.taskId);
      return !taskId || !discarded.has(taskId);
    });
  }

  function beginStreamingTurnState(sessionPath, ss, { streamId = null, flushDeferred = false } = {}) {
    if (flushDeferred) flushPendingDeferredContentEvents(sessionPath, ss);
    ss.pendingTurnCompletionNotification = null;
    ss.lastStreamActivityAt = Date.now();
    ss.turnActive = true;
    ss.thinkTagParser.reset();
    ss.moodParser.reset();
    ss.cardParser.reset();
    ss.pendingPhaseTextByIndex?.clear?.();
    ss._cardHints = [];
    ss._cardEmitted = false;
    ss.isThinking = false;
    ss.hasOutput = false;
    ss.hasToolCall = false;
    ss.hasThinking = false;
    ss.hasError = false;
    ss.assistantStopReason = null;
    ss.isAborted = false;
    ss.titleRequested = false;
    ss.titlePreview = "";
    const statusStreamId = beginSessionStream(ss, streamId);
    scheduleTurnStallWatchdog(sessionPath, ss);
    return statusStreamId;
  }

  function textOrNull(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  function turnInputConsumptionKey(item) {
    const entryId = item?.input?.entryId || null;
    if (entryId) return `entry:${entryId}`;
    const deliveryId = item?.deliveryId || item?.block?.deliveryId || null;
    if (deliveryId) return `delivery:${deliveryId}`;
    return item?.block?.id ? `block:${item.block.id}` : null;
  }

  function turnInputConsumptionAlreadyQueued(ss, item) {
    const key = turnInputConsumptionKey(item);
    if (!key) return false;
    if (ss.flushedTurnInputConsumptionKeys?.has?.(key)) return true;
    return (ss.pendingTurnInputConsumptions || []).some((queued) => (
      turnInputConsumptionKey(queued) === key
    ));
  }

  function buildPreReplyInterludeBlock(sessionPath, presentation) {
    if (presentation?.kind !== "pre_reply_interlude" || !presentation.taskId) return null;
    const task = engine.deferredResults?.query?.(presentation.taskId) || null;
    const taskStatus = task?.status === "failed" || task?.status === "aborted"
      ? task.status
      : presentation.status;
    const status = taskStatus === "failed" || taskStatus === "aborted" ? taskStatus : "success";
    const meta = {
      ...(task?.meta || {}),
      type: presentation.resultType || task?.meta?.type || "background-task",
    };
    const result = Object.prototype.hasOwnProperty.call(presentation, "result")
      ? presentation.result
      : task?.result;
    const reason = presentation.reason || task?.reason || null;
    return buildDeferredResultInterludeBlock({
      taskId: presentation.taskId,
      deliveryId: presentation.deliveryId || null,
      status,
      result,
      reason,
      meta,
    }, {
      receiverName: resolveDeferredReceiverName(engine, sessionPath),
    });
  }

  function isUiOnlyMediaTurnInput(presentation) {
    const resultType = presentation?.resultType || "";
    return presentation?.status === "success" && (
      resultType === "image-generation" ||
      resultType === "video-generation"
    );
  }

  function buildTurnInputConsumptionItem(sessionPath, message) {
    if (message?.role !== "custom") return null;
    if (message.display !== false) return null;
    if (message.customType !== DEFERRED_RESULT_MESSAGE_TYPE) return null;
    const event = buildTurnInputPresentationEvent(message, { deliveryMode: "consumed" });
    const presentation = event?.presentation;
    if (!presentation || isUiOnlyMediaTurnInput(presentation)) return null;
    const details = message.details && typeof message.details === "object" ? message.details : null;
    const entryId = textOrNull(message.id);
    const deliveryId =
      textOrNull(presentation.deliveryId) ||
      textOrNull(details?.deliveryId) ||
      (entryId ? `turn-input:${entryId}` : `turn-input:${crypto.randomUUID()}`);
    const normalizedPresentation = {
      ...presentation,
      deliveryId,
      deliveryMode: "consumed",
    };
    const block = buildPreReplyInterludeBlock(sessionPath, normalizedPresentation);
    if (!block) return null;
    return {
      kind: normalizedPresentation.kind,
      deliveryId,
      presentation: normalizedPresentation,
      input: {
        ...(entryId ? { entryId } : {}),
        customType: message.customType,
        deliveryId,
        taskId: normalizedPresentation.taskId,
        status: normalizedPresentation.status,
        resultType: normalizedPresentation.resultType,
        ...(textOrNull(message.timestamp) ? { timestamp: textOrNull(message.timestamp) } : {}),
      },
      block,
    };
  }

  function queueConsumedTurnInput(sessionPath, ss, message) {
    const item = buildTurnInputConsumptionItem(sessionPath, message);
    if (!item || turnInputConsumptionAlreadyQueued(ss, item)) return;
    ss.pendingTurnInputConsumptions = [...(ss.pendingTurnInputConsumptions || []), item];
  }

  function emitTurnInputConsumption(sessionPath, ss, item) {
    const block = item?.block;
    if (!block) return;
    emitStreamEvent(sessionPath, ss, { type: "content_block", block });
  }

  function persistedConsumptionEntryIds(sessionPath, item, fallbackIds) {
    const branch = engine.getSessionByPath?.(sessionPath)?.sessionManager?.getBranch?.();
    const deliveryId = textOrNull(item?.deliveryId) || textOrNull(item?.input?.deliveryId);
    const eventEntryId = textOrNull(item?.input?.entryId);
    const inputEntry = Array.isArray(branch)
      ? [...branch].reverse().find((entry) => (
          entry?.type === "custom_message"
          && (
            (deliveryId && textOrNull(entry.details?.deliveryId) === deliveryId)
            || (eventEntryId && entry.id === eventEntryId)
          )
        )) || null
      : null;
    const inputEntryId = inputEntry?.id || fallbackIds?.turnInputEntryId || eventEntryId || null;
    const assistantEntryId = fallbackIds?.assistantEntryId || null;
    const assistantEntry = Array.isArray(branch) && assistantEntryId
      ? branch.find((entry) => entry?.id === assistantEntryId) || null
      : null;
    return {
      inputEntryId,
      assistantEntryId,
      assistantParentId: assistantEntry?.parentId || null,
      inputTimestamp: inputEntry?.timestamp || null,
      assistantTimestamp: assistantEntry?.timestamp || null,
    };
  }

  function persistTurnInputConsumption(sessionPath, item, fallbackIds) {
    const recordCustomEntry = typeof engine.recordSessionCustomEntry === "function"
      ? engine.recordSessionCustomEntry.bind(engine)
      : typeof engine.recordCustomEntry === "function"
        ? engine.recordCustomEntry.bind(engine)
        : null;
    if (!sessionPath || !recordCustomEntry) return;
    const persisted = persistedConsumptionEntryIds(sessionPath, item, fallbackIds);
    if (!persisted.assistantEntryId) return;
    const record = buildTurnInputConsumptionRecord({
      input: {
        ...(item?.input || {}),
        ...(persisted.inputEntryId ? { entryId: persisted.inputEntryId } : {}),
        ...(persisted.inputTimestamp ? { timestamp: persisted.inputTimestamp } : {}),
      },
      assistant: {
        entryId: persisted.assistantEntryId,
        ...(persisted.assistantParentId ? { parentId: persisted.assistantParentId } : {}),
        ...(persisted.assistantTimestamp ? { timestamp: persisted.assistantTimestamp } : {}),
      },
      presentation: item?.presentation,
      block: item?.block,
    });
    if (!record) return;
    try {
      recordCustomEntry(sessionPath, TURN_INPUT_CONSUMPTION_EVENT_TYPE, record);
    } catch (err) {
      log.warn(`turn input consumption persistence failed: ${err.message}`);
    }
  }

  function persistConsumedTurnInputs(sessionPath, ss, persistedIds) {
    const consumed = ss.consumedTurnInputsForCurrentTurn || [];
    ss.consumedTurnInputsForCurrentTurn = [];
    for (const item of consumed) persistTurnInputConsumption(sessionPath, item, persistedIds);
  }

  function takePendingTurnInputConsumptionsForAssistant(ss, assistantMessage = null) {
    const pending = ss.pendingTurnInputConsumptions || [];
    if (!pending.length) return { items: [], remaining: [] };
    const parentId = textOrNull(assistantMessage?.parentId);
    if (!parentId) return { items: pending, remaining: [] };
    const matchIndex = pending.findIndex((item) => item?.input?.entryId === parentId);
    if (matchIndex < 0) return { items: [], remaining: pending };
    return {
      items: pending.slice(0, matchIndex + 1),
      remaining: pending.slice(matchIndex + 1),
    };
  }

  function flushPendingTurnInputConsumptions(sessionPath, ss, assistantMessage = null) {
    const { items, remaining } = takePendingTurnInputConsumptionsForAssistant(ss, assistantMessage);
    if (!items.length) return [];
    ss.pendingTurnInputConsumptions = remaining;
    if (!(ss.flushedTurnInputConsumptionKeys instanceof Set)) {
      ss.flushedTurnInputConsumptionKeys = new Set();
    }
    for (const item of items) {
      emitTurnInputConsumption(sessionPath, ss, item);
      ss.consumedTurnInputsForCurrentTurn = [
        ...(ss.consumedTurnInputsForCurrentTurn || []),
        item,
      ];
      const key = turnInputConsumptionKey(item);
      if (key) ss.flushedTurnInputConsumptionKeys.add(key);
    }
    return items;
  }

  function finishStreamingState(ss, sessionPath = null) {
    if (!ss) return;
    ss.turnActive = false;
    clearTurnStallWatchdog(ss);
    if (sessionPath && ss.isThinking) {
      ss.isThinking = false;
      emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
    }
    if (ss.isStreaming) finishSessionStream(ss);
    ss.thinkTagParser.reset();
    ss.moodParser.reset();
    ss.cardParser.reset();
    ss.pendingPhaseTextByIndex?.clear?.();
  }

  function clearTurnStallWatchdog(ss) {
    if (!ss?.turnStallTimer) return;
    clearTimeout(ss.turnStallTimer);
    ss.turnStallTimer = null;
  }

  function scheduleTurnStallWatchdog(sessionPath, ss) {
    if (!sessionPath || !ss || turnStallAbortMs === 0) return;
    clearTurnStallWatchdog(ss);
    const lastActivity = ss.lastStreamActivityAt || Date.now();
    const delay = Math.max(0, turnStallAbortMs - (Date.now() - lastActivity));
    ss.turnStallTimer = setTimeout(() => {
      ss.turnStallTimer = null;
      const idleFor = Date.now() - (ss.lastStreamActivityAt || 0);
      if (idleFor < turnStallAbortMs) {
        scheduleTurnStallWatchdog(sessionPath, ss);
        return;
      }
      if (!isSessionRuntimeStreaming(sessionPath)) return;
      ss.isAborted = true;
      const reason = "turn_stall_timeout";
      Promise.resolve(hub.abort?.(sessionPath, { reason })).then((aborted) => {
        if (aborted === false) return engine.abortSessionByPath?.(sessionPath, { reason });
      }).catch((err) => {
        log.warn(`turn stall abort failed for ${path.basename(sessionPath)}: ${err.message}`);
      });
    }, delay);
    ss.turnStallTimer.unref?.();
  }

  function markTurnStreamActivity(sessionPath, ss) {
    if (!sessionPath || !ss || !isSessionRuntimeStreaming(sessionPath)) return;
    ss.lastStreamActivityAt = Date.now();
    scheduleTurnStallWatchdog(sessionPath, ss);
  }

  function maybeGenerateFirstTurnTitle(sessionPath, ss) {
    if (!sessionPath || !ss || ss.titleRequested) return;

    const session = engine.getSessionByPath(sessionPath);
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    const userMsgCount = messages.filter(m => m.role === "user").length;
    if (userMsgCount !== 1) return;

    const assistantMsg = messages.find(m => m.role === "assistant");
    const assistantText = (ss.titlePreview || extractText(assistantMsg?.content)).trim();
    if (!assistantText) return;

    ss.titleRequested = true;
    generateSessionTitle(engine, broadcast, {
      sessionPath,
      assistantTextHint: assistantText,
    }).then((ok) => {
      if (!ok) ss.titleRequested = false;
    }).catch((err) => {
      ss.titleRequested = false;
      log.error(`generateSessionTitle error: ${err.message}`);
    });
  }

  function resolveChatNotificationIdentity(sessionPath) {
    const sessionId = engine.getSessionIdForPath?.(sessionPath) || null;
    const manifest = sessionId ? engine.getSessionManifest?.(sessionId) || null : null;
    if (!manifest) {
      log.warn(`chat completion notification skipped: session manifest missing for ${path.basename(sessionPath || "")}`);
      return null;
    }
    if (manifest.domain !== "desktop" || manifest.kind !== "chat") {
      log.log(`chat completion notification skipped: ${manifest.domain || "unknown"}/${manifest.kind || "unknown"} session`);
      return null;
    }
    const session = engine.getSessionByPath?.(sessionPath) || null;
    const agent = session?.agent || null;
    const agentId = typeof manifest.ownerAgentId === "string" && manifest.ownerAgentId
      ? manifest.ownerAgentId
      : typeof session?.agentId === "string" && session.agentId
        ? session.agentId
        : typeof agent?.id === "string" && agent.id
          ? agent.id
          : null;
    const agentName = typeof session?.agentName === "string" && session.agentName
      ? session.agentName
      : typeof agent?.agentName === "string" && agent.agentName
        ? agent.agentName
        : typeof agent?.name === "string" && agent.name
          ? agent.name
          : null;
    return { agentId, agentName, sessionId };
  }

  function maybeDeliverTurnCompletionNotification(sessionPath, { wasAborted, wasSuccessful, streamId }) {
    if (!sessionPath || wasAborted || !wasSuccessful) return;
    try {
      const prefs = engine.getNotificationPreferences?.();
      if (prefs?.chatCompletion !== "when_unfocused" && prefs?.chatCompletion !== "when_session_unfocused") return;
      if (typeof engine.deliverNotification !== "function") return;

      const identity = resolveChatNotificationIdentity(sessionPath);
      if (!identity) return;
      const { agentId, agentName, sessionId } = identity;
      const idempotencyKey = streamId ? `chat-completion:${sessionId}:${streamId}` : null;
      const delivery = engine.deliverNotification({
        title: agentName || "LucCode",
        body: t("notification.chatCompletionBody"),
        channels: ["desktop"],
        desktopFocusPolicy: prefs.chatCompletion === "when_session_unfocused"
          ? "when_session_unfocused"
          : "when_unfocused",
        sessionPath,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      }, {
        agentId,
      });
      delivery?.catch?.((err) => {
        log.warn(`chat completion notification failed: ${err.message}`);
      });
    } catch (err) {
      log.warn(`chat completion notification skipped: ${err.message}`);
    }
  }

  function isSessionRuntimeStreaming(sessionPath) {
    try {
      return engine.isSessionStreaming?.(sessionPath) === true;
    } catch {
      return false;
    }
  }

  function deliverOrDeferTurnCompletionNotification(sessionPath, ss, details) {
    if (!ss) {
      maybeDeliverTurnCompletionNotification(sessionPath, details);
      return;
    }
    if (isSessionRuntimeStreaming(sessionPath)) {
      ss.pendingTurnCompletionNotification = details;
      return;
    }
    ss.pendingTurnCompletionNotification = null;
    maybeDeliverTurnCompletionNotification(sessionPath, details);
  }

  function flushPendingTurnCompletionNotification(sessionPath, ss) {
    const pending = ss?.pendingTurnCompletionNotification;
    if (!pending || isSessionRuntimeStreaming(sessionPath)) return;
    ss.pendingTurnCompletionNotification = null;
    maybeDeliverTurnCompletionNotification(sessionPath, {
      ...pending,
      wasAborted: pending.wasAborted || ss.isAborted === true,
    });
  }

  // 单订阅：事件只写入一次，再按需广播到所有连接中的客户端。
  hub.subscribe((event, sessionPath) => {
    // Non-session-scoped events: handle before session resolution
    const appEventMessage = toAppEventWsMessage(event);
    if (appEventMessage) {
      broadcast(appEventMessage);
      return;
    }

    const resourceEventMessage = toResourceEventWsMessage(event, sessionPath);
    if (resourceEventMessage) {
      broadcast(resourceEventMessage);
      return;
    }

    if (event.type === "plugin_ui_changed") {
      broadcast({ type: "plugin_ui_changed" });
      return;
    }

    const compactionMessage = toCompactionLifecycleWsMessage(
      event,
      sessionPath,
      (sp) => engine.getSessionByPath(sp),
      (sp) => sessionIdForPath(sp),
      () => getResolvedCompactionMode(engine.preferences),
    );
    if (compactionMessage) {
      broadcast(compactionMessage);
      return;
    }

    const ss = sessionPath ? getState(sessionPath) : null;
    if (ss && event.type !== "session_status") {
      markTurnStreamActivity(sessionPath, ss);
    }

    // Helper: feed CardParser, emit card events or pass text through as text_delta
    const feedCardPipeline = (text) => {
      ss.cardParser.feed(text, (cEvt) => {
        switch (cEvt.type) {
          case "text":
            ss.titlePreview += cEvt.data || "";
            emitStreamEvent(sessionPath, ss, { type: "text_delta", delta: cEvt.data });
            maybeGenerateFirstTurnTitle(sessionPath, ss);
            break;
          case "card_start":
            ss._cardEmitted = true;
            emitStreamEvent(sessionPath, ss, { type: "card_start", attrs: cEvt.attrs });
            break;
          case "card_text":
            emitStreamEvent(sessionPath, ss, { type: "card_text", delta: cEvt.data });
            break;
          case "card_end":
            emitStreamEvent(sessionPath, ss, { type: "card_end" });
            break;
        }
      });
    };

    const feedMoodPipeline = (text) => {
      ss.moodParser.feed(text, (evt) => {
        if (evt.type === "text") {
          feedCardPipeline(evt.data);
        } else if (evt.type === "mood_start") {
          emitStreamEvent(sessionPath, ss, { type: "mood_start" });
        } else if (evt.type === "mood_text") {
          emitStreamEvent(sessionPath, ss, { type: "mood_text", delta: evt.data });
        } else if (evt.type === "mood_end") {
          emitStreamEvent(sessionPath, ss, { type: "mood_end" });
        }
      });
    };

    const flushTerminalParsers = () => {
      if (ss.isThinking) {
        ss.isThinking = false;
        emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
      }
      ss.thinkTagParser.flush((tEvt) => {
        if (tEvt.type === "think_text") {
          emitStreamEvent(sessionPath, ss, { type: "thinking_delta", delta: tEvt.data });
        } else if (tEvt.type === "think_end") {
          emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
        } else if (tEvt.type === "text") {
          feedMoodPipeline(tEvt.data);
        }
      });
      ss.moodParser.flush((evt) => {
        if (evt.type === "text") {
          feedCardPipeline(evt.data);
        } else if (evt.type === "mood_text") {
          emitStreamEvent(sessionPath, ss, { type: "mood_text", delta: evt.data });
        }
      });
      ss.cardParser.flush((cEvt) => {
        if (cEvt.type === "text") {
          emitStreamEvent(sessionPath, ss, { type: "text_delta", delta: cEvt.data });
        } else if (cEvt.type === "card_text") {
          emitStreamEvent(sessionPath, ss, { type: "card_text", delta: cEvt.data });
        } else if (cEvt.type === "card_start") {
          ss._cardEmitted = true;
          emitStreamEvent(sessionPath, ss, { type: "card_start", attrs: cEvt.attrs });
        } else if (cEvt.type === "card_end") {
          emitStreamEvent(sessionPath, ss, { type: "card_end" });
        }
      });
    };

    const phaseTextBuffer = () => {
      if (!(ss.pendingPhaseTextByIndex instanceof Map)) ss.pendingPhaseTextByIndex = new Map();
      return ss.pendingPhaseTextByIndex;
    };

    const textEventBufferKey = (subEvent) => (
      Number.isInteger(subEvent?.contentIndex) ? String(subEvent.contentIndex) : "__default"
    );

    const textBlockFromEvent = (subEvent) => {
      const partialContent = subEvent?.partial?.content;
      const messageContent = event.message?.content;
      const content = Array.isArray(partialContent)
        ? partialContent
        : Array.isArray(messageContent)
          ? messageContent
          : null;
      if (!content) return null;
      if (Number.isInteger(subEvent?.contentIndex)) {
        return content[subEvent.contentIndex] || null;
      }
      return content.find((block) => block?.type === "text") || null;
    };

    const shouldBufferPhaseText = (subEvent) => {
      const message = subEvent?.partial || event.message || {};
      const api = typeof message?.api === "string" ? message.api.toLowerCase() : "";
      const provider = typeof message?.provider === "string" ? message.provider.toLowerCase() : "";
      return provider === "openai-codex"
        || api === "openai-codex-responses"
        || api === "openai-responses"
        || api === "azure-openai-responses";
    };

    const thinkingDeltaFromEvent = (subEvent) => {
      for (const key of ["delta", "reasoning_content", "reasoning_text", "thinking", "thinking_text", "reasoning", "text"]) {
        const value = subEvent?.[key];
        if (typeof value === "string" && value.length > 0) return value;
      }
      return "";
    };

    const emitVisibleTextDelta = (delta) => {
      const text = typeof delta === "string" ? delta : "";
      if (!text) return;
      flushPendingTurnInputConsumptions(sessionPath, ss, event.message);
      ss.hasOutput = true;
      if (ss.isThinking) {
        ss.isThinking = false;
        emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
      }

      // ThinkTagParser（最外层）→ MoodParser → CardParser
      ss.thinkTagParser.feed(text, (tEvt) => {
        switch (tEvt.type) {
          case "think_start":
            emitStreamEvent(sessionPath, ss, { type: "thinking_start" });
            break;
          case "think_text":
            emitStreamEvent(sessionPath, ss, { type: "thinking_delta", delta: tEvt.data });
            break;
          case "think_end":
            emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
            break;
          case "text":
            // 非 think 内容继续走 MoodParser → CardParser 链
            feedMoodPipeline(tEvt.data);
            break;
        }
      });
    };

    if (event.type === "message_update") {
      if (!ss) return;
      const sub = event.assistantMessageEvent?.type;

      if (sub === "text_delta") {
        const subEvent = event.assistantMessageEvent;
        const delta = subEvent.delta || "";
        if (shouldBufferPhaseText(subEvent)) {
          const pending = phaseTextBuffer();
          const key = textEventBufferKey(subEvent);
          pending.set(key, `${pending.get(key) || ""}${delta}`);
          return;
        }
        emitVisibleTextDelta(delta);
      } else if (sub === "text_end") {
        const subEvent = event.assistantMessageEvent;
        if (!shouldBufferPhaseText(subEvent)) return;
        const pending = phaseTextBuffer();
        const key = textEventBufferKey(subEvent);
        const block = textBlockFromEvent(subEvent);
        const buffered = pending.get(key);
        pending.delete(key);
        if (getAssistantTextPhase(block) === "commentary") return;
        emitVisibleTextDelta(buffered ?? subEvent.content ?? block?.text ?? "");
      } else if (sub === "thinking_delta") {
        flushPendingTurnInputConsumptions(sessionPath, ss, event.message);
        ss.hasThinking = true;
        if (!ss.isThinking) {
          ss.isThinking = true;
          emitStreamEvent(sessionPath, ss, { type: "thinking_start" });
        }
        emitStreamEvent(sessionPath, ss, {
          type: "thinking_delta",
          delta: thinkingDeltaFromEvent(event.assistantMessageEvent),
        });
      } else if (sub === "toolcall_start") {
        // 不在这里关闭 thinking 状态
      } else if (sub === "error") {
        ss.hasError = true;
        broadcast({ type: "error", message: event.assistantMessageEvent.error || "Unknown error", sessionPath });
      }
    } else if (event.type === "tool_execution_start") {
      if (!ss) return;
      flushPendingTurnInputConsumptions(sessionPath, ss, event.message);
      ss.hasToolCall = true;
      if (ss.isThinking) {
        ss.isThinking = false;
        emitStreamEvent(sessionPath, ss, { type: "thinking_end" });
      }
      // 只保留前端 extractToolDetail 需要的字段，避免广播完整文件内容
      const args = summarizeToolStartArgs(event.toolName || "", event.args);
      emitStreamEvent(sessionPath, ss, {
        type: "tool_start",
        id: event.toolCallId || undefined,
        name: event.toolName || "",
        args,
      });
    } else if (event.type === "tool_execution_end") {
      if (!ss) return;
      const outcome = projectLiveToolResultOutcome({
        ...event.result,
        isError: event.isError === true || event.result?.isError === true,
      });
      emitStreamEvent(sessionPath, ss, {
        type: "tool_end",
        id: event.toolCallId || undefined,
        name: event.toolName || "",
        status: outcome.status,
        success: outcome.success,
        ...(outcome.error ? { error: outcome.error } : {}),
        details: event.result?.details,
      });

      // Unified content_block emission for all tool results
      const blocks = normalizePluginChatSurfaceBlocks(
        dropUninstalledPluginCards(
          enrichSessionFileBlocks(
            extractBlocks(event.toolName, event.result?.details, event.result),
            engine,
            sessionPath,
          ),
          pluginInstalledPredicate(engine),
        ),
        engine,
      );
      for (const block of blocks) {
        emitStreamEvent(sessionPath, ss, { type: "content_block", block });
      }

      if (event.toolName === "browser") {
        const d = event.result?.details || {};
        const statusMsg: Record<string, any> = {
          type: "browser_status",
          running: d.running ?? false,
          url: d.url || null,
        };
        if (d.thumbnail) {
          statusMsg.thumbnail = d.thumbnail;
          statusMsg.thumbnailCapturedAt = d.thumbnailCapturedAt || Date.now();
          statusMsg.thumbnailUrl = d.thumbnailUrl || statusMsg.url;
        }
        emitStreamEvent(sessionPath, ss, statusMsg);
        if (statusMsg.running) startBrowserThumbPoll();
        else if (!BrowserManager.instance().hasAnyRunning) stopBrowserThumbPoll();
      }
    } else if (event.type === "jian_update") {
      broadcast({ type: "jian_update", content: event.content });
    } else if (event.type === "devlog") {
      broadcast({ type: "devlog", text: event.text, level: event.level });
    } else if (event.type === "browser_status") {
      const statusMsg: Record<string, any> = {
        type: "browser_status",
        running: !!event.running,
        url: event.url || null,
        sessionPath,
      };
      if (event.thumbnail) {
        statusMsg.thumbnail = event.thumbnail;
        statusMsg.thumbnailCapturedAt = event.thumbnailCapturedAt || Date.now();
        statusMsg.thumbnailUrl = event.thumbnailUrl || statusMsg.url;
      }
      if (event.error) statusMsg.error = event.error;
      broadcast(statusMsg);
      if (statusMsg.running) startBrowserThumbPoll();
      else if (!BrowserManager.instance().hasAnyRunning) stopBrowserThumbPoll();
    } else if (event.type === "browser_bg_status") {
      broadcast({ type: "browser_bg_status", running: event.running, url: event.url, sessionPath });
    } else if (event.type === "computer_overlay") {
      if (!ss) return;
      emitStreamEvent(sessionPath, ss, event);
    } else if (event.type === "session_confirmation" && event.request) {
      if (!ss) return;
      emitStreamEvent(sessionPath, ss, {
        type: "content_block",
        block: event.request,
      });
    } else if (event.type === "cron_confirmation" && event.confirmId) {
      // 新的阻塞式自动化建议（通过 emitEvent 触发）
      if (!ss) return;
      emitStreamEvent(sessionPath, ss, {
        type: "content_block",
        block: buildAutomationSuggestionBlock({
          confirmId: event.confirmId,
          jobData: event.jobData || {},
          operation: event.operation === "update" ? "update" : "create",
          status: "pending",
        }),
      });
    } else if (event.type === "settings_confirmation") {
      if (!ss) return;
      emitStreamEvent(sessionPath, ss, {
        type: "content_block",
        block: {
          type: "settings_confirm", confirmId: event.confirmId,
          settingKey: event.settingKey, cardType: event.cardType,
          currentValue: event.currentValue, proposedValue: event.proposedValue,
          options: event.options, optionLabels: event.optionLabels || null,
          label: event.label, description: event.description,
          frontend: event.frontend, status: "pending",
        },
      });
    } else if (event.type === "confirmation_resolved") {
      broadcast({
        type: "confirmation_resolved",
        confirmId: event.confirmId,
        action: event.action,
        value: event.value,
      });
    } else if (event.type === "apply_frontend_setting") {
      broadcast({
        type: "apply_frontend_setting",
        key: event.key,
        value: event.value,
      });
    } else if (event.type === "block_update") {
      broadcast({
        type: "block_update",
        taskId: event.taskId,
        patch: event.patch,
        sessionPath,
      });
    } else if (event.type === TURN_INPUT_PRESENTATION_EVENT_TYPE) {
      // Delivery notifications are advisory only. The timeline UI is bound to the
      // actual hidden custom_message once the SDK consumes it for an assistant turn.
    } else if (event.type === "turn_start") {
      if (!ss) return;
      if (!ss.turnActive) {
        const statusStreamId = beginStreamingTurnState(sessionPath, ss);
        broadcast({
          type: "status",
          isStreaming: true,
          sessionPath,
          streamId: statusStreamId,
        });
      }
    } else if (event.type === "todo_update") {
      broadcast({
        type: "todo_update",
        todos: Array.isArray(event.todos) ? event.todos : [],
        sessionPath,
      });
    } else if (event.type === "activity_update") {
      broadcast({ type: "activity_update", activity: event.activity });
    } else if (event.type === "agent_activity") {
      // ActivityHub 统一活动真相源 → WS（右侧「子助手 / workflow」卡数据源）。
      const agentActivityMsg = toAgentActivityWsMessage(event, sessionPath);
      if (agentActivityMsg) broadcast(agentActivityMsg);
    } else if (event.type === "bridge_message") {
      broadcast({ type: "bridge_message", message: event.message });
    } else if (event.type === "bridge_status") {
      broadcast({ type: "bridge_status", platform: event.platform, status: event.status, error: event.error, agentId: event.agentId || null });
    } else if (event.type === "session_branch_reset") {
      if (!ss) return;
      discardQueuedBranchTaskEvents(ss, event.discardedTaskIds);
      ss.pendingTurnInputConsumptions = [];
      ss.consumedTurnInputsForCurrentTurn = [];
      ss.flushedTurnInputConsumptionKeys?.clear?.();
      emitStreamEvent(sessionPath, ss, {
        type: "session_branch_reset",
        messageId: event.messageId || null,
        projectionMessageId: event.projectionMessageId || null,
        clientMessageId: event.clientMessageId || null,
        todos: Array.isArray(event.todos) ? event.todos : [],
        sessionFiles: Array.isArray(event.sessionFiles) ? event.sessionFiles : [],
      });
    } else if (event.type === "session_user_message") {
      if (!ss) return;
      emitStreamEvent(sessionPath, ss, {
        type: "session_user_message",
        clientMessageId: event.clientMessageId || null,
        message: event.message,
      });
    } else if (event.type === "voice_transcription_update") {
      broadcast({
        type: "voice_transcription_update",
        sessionPath: event.sessionPath || sessionPath,
        fileId: event.fileId || null,
        transcription: event.transcription || null,
      });
    } else if (event.type === "session_created") {
      broadcast({
        type: "session_created",
        sessionPath,
        session: event.session || null,
      });
    } else if (event.type === "session_status") {
      let statusStreamId = null;
      if (ss) {
        const eventStreamId = typeof event.streamId === "string" && event.streamId.trim()
          ? event.streamId
          : null;
        if (event.isStreaming) {
          statusStreamId = beginStreamingTurnState(sessionPath, ss, {
            streamId: eventStreamId,
            flushDeferred: true,
          });
        } else if (ss.isStreaming) {
          statusStreamId = eventStreamId || ss.streamId || null;
          flushTerminalParsers();
          finishStreamingState(ss);
        } else {
          statusStreamId = eventStreamId || ss.streamId || null;
          ss.turnActive = false;
          clearTurnStallWatchdog(ss);
        }
      }
      const payload: any = {
        type: "status",
        isStreaming: !!event.isStreaming,
        sessionPath,
        streamId: statusStreamId,
      };
      if (event.aborted !== undefined) payload.aborted = !!event.aborted;
      if (typeof event.reason === "string" && event.reason.trim()) payload.reason = event.reason.trim();
      broadcast(payload);
      if (ss && !event.isStreaming) {
        flushPendingDeferredContentEvents(sessionPath, ss);
        flushPendingTurnCompletionNotification(sessionPath, ss);
      }
    } else if (event.type === "bridge_rc_attached") {
      broadcast({
        type: "bridge_rc_attached",
        sessionKey: event.sessionKey,
        sessionPath,
        title: event.title,
        platform: event.platform || null,
      });
    } else if (event.type === "bridge_rc_detached") {
      broadcast({
        type: "bridge_rc_detached",
        sessionKey: event.sessionKey,
        sessionPath,
      });
    } else if (event.type === "session_metadata_updated") {
      broadcast({
        type: "session_metadata_updated",
        sessionPath,
        metadata: event.metadata && typeof event.metadata === "object" ? event.metadata : {},
      });
    } else if (event.type === "permission_mode") {
      broadcast({ type: "permission_mode", mode: event.mode, readOnly: event.readOnly === true, sessionPath });
    } else if (event.type === "access_mode") {
      broadcast({
        type: "access_mode",
        mode: event.mode,
        permissionMode: event.permissionMode,
        readOnly: event.readOnly === true,
        sessionPath,
      });
    } else if (event.type === "plan_mode") {
      broadcast({ type: "plan_mode", enabled: event.enabled, mode: event.mode, sessionPath });
    } else if (event.type === "notification") {
      broadcast(toNotificationWsMessage(event, sessionPath));
    } else if (event.type === "channel_new_message") {
      broadcast({
        type: "channel_new_message",
        channelName: event.channelName,
        sender: event.sender,
        message: event.message || null,
      });
    } else if (event.type === "channel_created") {
      broadcast({
        type: "channel_created",
        channelName: event.channelName,
        channel: event.channel || null,
      });
    } else if (event.type === "dm_new_message") {
      broadcast({ type: "dm_new_message", from: event.from, to: event.to });
    } else if (event.type === "conversation_agent_activity") {
      broadcast({ type: "conversation_agent_activity", activity: event.activity });
    } else if (event.type === "message_end") {
      // Provider 级别错误（超时、连接断开等）通过 message_end 传递，不经过 message_update
      if (!ss) return;
      if (event.message?.role === "custom" && event.message.display === false) {
        queueConsumedTurnInput(sessionPath, ss, event.message);
      }
      if (event.message?.role === "custom" && event.message.display !== false) {
        const blocks = normalizePluginChatSurfaceBlocks(
          dropUninstalledPluginCards(
            enrichSessionFileBlocks(
              extractBlocks(event.message.customType, event.message.details, event.message),
              engine,
              sessionPath,
            ),
            pluginInstalledPredicate(engine),
          ),
          engine,
        );
        for (const block of blocks) {
          emitStreamEvent(sessionPath, ss, { type: "content_block", block });
        }
      }
      if (event.message?.stopReason === "error") {
        ss.hasError = true;
        broadcast({ type: "error", message: event.message.errorMessage || "Unknown error", sessionPath });
      }
      if (event.message?.role === "assistant" && typeof event.message.stopReason === "string") {
        ss.assistantStopReason = event.message.stopReason;
      }
    } else if (event.type === "turn_end") {
      if (!ss) return;
      // 合成的中止事件带 event.aborted：中止源在 WS abort 之外时（断线宽限中止、
      // 关机 abort_all）ss.isAborted 不会被置位，只能靠事件本身识别。
      const turnWasAborted = ss.isAborted === true || event.aborted === true;
      const turnWasTruncated = ss.assistantStopReason === "length";
      const turnStreamId = ss.streamId || null;
      flushTerminalParsers();

      // 空回复检测：本轮没有文本输出也没有工具调用，提示用户检查配置
      // 被 abort 的 turn 不弹此提示（用户主动停止 / WS 断开 / 连接超时）；
      // 合成中止事件同样豁免
      const truncatedWithoutVisibleResult = turnWasTruncated && !ss.hasOutput && !ss.hasToolCall;
      if (
        ((!ss.hasOutput && !ss.hasToolCall && !ss.hasThinking) || truncatedWithoutVisibleResult)
        && !ss.hasError
        && !turnWasAborted
      ) {
        ss.hasError = true;
        broadcast({ type: "error", message: t("error.modelNoResponse"), sessionPath });
      }
      const turnWasSuccessful = !turnWasAborted && !ss.hasError && (ss.hasOutput || ss.hasToolCall || ss.hasThinking);

      const persistedEntries = persistedTurnEntryIds(engine, sessionPath);

      // ── token usage 事件（供插件监听做用量统计）──
      // 中止的 turn 没落盘任何 assistant 时跳过记账：branch 里最后一条 assistant
      // 属于上一轮，它的 usage 在上一轮 turn_end 已经记过一次，重复记会双计。
      const skipUsageAccounting = event.aborted === true && !persistedEntries.assistantEntryId;
      if (!skipUsageAccounting) {
        try {
          const sess = engine.getSessionByPath(sessionPath);
          if (sess) {
            const usage = getLastAssistantUsage(sess.entries ?? []);
            if (usage) {
              const model = sess.model;
              logLlmUsage({
                source: "chat",
                api: model?.api ?? null,
                modelId: model?.id ?? null,
                provider: model?.provider ?? null,
                usage,
                costRates: model?.cost,
              } as any);
              hub.eventBus.emit({
                type: "token_usage",
                usage,
                modelId: model?.id ?? null,
                modelProvider: model?.provider ?? null,
              }, sessionPath);
            }
          }
        } catch (_) { /* 统计失败不阻塞主流程 */ }
      }

      persistConsumedTurnInputs(sessionPath, ss, persistedEntries);
      emitStreamEvent(sessionPath, ss, {
        type: "turn_end",
        ...persistedEntries,
        ...(turnWasTruncated ? { truncated: true, stopReason: "length" } : {}),
      });
      finishSessionStream(ss);
      ss.turnActive = false;
      if (!isSessionRuntimeStreaming(sessionPath)) {
        clearTurnStallWatchdog(ss);
      }
      deliverOrDeferTurnCompletionNotification(sessionPath, ss, {
        wasAborted: turnWasAborted,
        wasSuccessful: turnWasSuccessful,
        streamId: turnStreamId,
      });
      ss.hasOutput = false;
      ss.hasToolCall = false;
      ss.hasThinking = false;
      ss.hasError = false;
      ss.assistantStopReason = null;
      ss.isAborted = false;
      ss.pendingTurnInputConsumptions = [];
      ss.consumedTurnInputsForCurrentTurn = [];
      ss.thinkTagParser.reset();
      ss.moodParser.reset();
      ss.cardParser.reset();
      ss.pendingPhaseTextByIndex?.clear?.();
      ss._cardHints = [];
      ss._cardEmitted = false;
      flushPendingDeferredContentEvents(sessionPath, ss);

      debugLog()?.log("ws", `turn done (${sessionPath?.split("/").pop()})`);
      maybeGenerateFirstTurnTitle(sessionPath, ss);
    } else if (event.type === "deferred_result") {
      if (!ss) return;
      // Retry fences discarded task IDs in DeferredResultStore before emitting
      // session_branch_reset. Ignore any delayed bus callback that observes the
      // old branch after that fence was installed.
      if (engine.deferredResults?.query?.(event.taskId)?.deliverySuppressed) return;
      const delayVisibleBlocks = ss.turnActive === true;
      emitStreamEvent(sessionPath, ss, {
        type: "deferred_result",
        taskId: event.taskId,
        status: event.status,
        result: event.result,
        reason: event.reason,
        meta: event.meta,
      });
      queueOrEmitDeferredContentEvents(
        sessionPath,
        ss,
        buildDeferredResultContentEvents(sessionPath, event),
        { delayUntilTurnEnd: delayVisibleBlocks },
      );
    }
  });

  // ── 后台任务终止 ──

  restRoute.post("/task/:taskId/abort", async (c) => {
    const taskId = c.req.param("taskId");
    const registry = engine.taskRegistry;
    if (!registry) return c.json({ error: "registry unavailable" }, 500);
    const result = registry.abort(taskId);
    if (result === "not_found") return c.json({ error: "task not found" }, 404);
    if (result === "no_handler") return c.json({ error: "task type does not support abort" }, 400);
    return c.json({ ok: true, status: result });
  });

  // ── WebSocket 路由（挂载在 wsRoute，由 index.js 挂到根路径） ──

  wsRoute.get("/ws",
    upgradeWebSocket((c) => {
      let closed = false;
      const requestContext = createRequestContext(c, engine);
      const isAdapterWithoutHttpRequest = !c?.req;

      return {
        onOpen(event, ws) {
          activeWsClients++;
          clients.set(ws, createInitialWsClientRecord(requestContext, {
            assumeLocalOwner: isAdapterWithoutHttpRequest,
          }));
          cancelDisconnectAbort();
          debugLog()?.log("ws", "client connected");
        },

        onMessage(event, ws) {
          // Hono @hono/node-ws delivers event.data as a string for text frames
          const msg = wsParse(event.data);
          if (!msg) return;
          let client = ensureWsClientRecord(ws, requestContext, {
            assumeLocalOwner: isAdapterWithoutHttpRequest,
          });
          if (!wsClientCanSendMessage(client, msg)) {
            wsSend(ws, { type: "error", message: "insufficient_scope", sessionPath: msg.sessionPath });
            return;
          }
          if (msg.sessionPath && requestContext.studioId) {
            client = subscribeWsClientToSession(client, {
              studioId: requestContext.studioId,
              sessionPath: msg.sessionPath,
              sessionId: sessionIdForPath(msg.sessionPath),
            });
            clients.set(ws, client);
          }

          // Wrap the async handler with error handling (replaces wrapWsHandler)
          (async () => {
            if (msg.type === "abort") {
              const abortTarget = requireWsSessionContext(msg, ws); if (!abortTarget) return;
              const abortPath = abortTarget.sessionPath;
              const abortSs = getState(abortPath);
              const requestedStreamId = typeof msg.streamId === "string" && msg.streamId.trim()
                ? msg.streamId.trim()
                : null;
              const activeStreamId = typeof abortSs?.streamId === "string" && abortSs.streamId.trim()
                ? abortSs.streamId.trim()
                : null;
              if (requestedStreamId && (!activeStreamId || requestedStreamId !== activeStreamId)) {
                wsSend(ws, {
                  type: "abort_result",
                  status: "rejected",
                  reason: "stale_stream",
                  sessionId: abortTarget.sessionId,
                  sessionPath: abortPath,
                  streamId: activeStreamId,
                });
                // Keep the legacy rejection event while older clients migrate to abort_result.
                wsSend(ws, {
                  type: "abort_rejected",
                  reason: "stale_stream",
                  sessionId: abortTarget.sessionId,
                  sessionPath: abortPath,
                  streamId: activeStreamId,
                });
                return;
              }
              const abortReason = typeof msg.reason === "string" && msg.reason.trim()
                ? msg.reason.trim()
                : "user_abort";
              if (abortSs) abortSs.isAborted = true;
              let abortAccepted = false;
              try {
                abortAccepted = !!(await agentReviewTurns.cancelByParent(abortTarget.sessionId, abortReason));
                if (!abortAccepted) abortAccepted = !!(await hub.abort(abortPath, { reason: abortReason }));
              } catch {}
              if (!abortAccepted) {
                const abortStreamId = abortSs?.streamId || null;
                finishStreamingState(abortSs, abortPath);
                broadcast({
                  type: "status",
                  isStreaming: false,
                  sessionPath: abortPath,
                  streamId: abortStreamId,
                  aborted: true,
                  reason: abortReason,
                });
              }
              wsSend(ws, {
                type: "abort_result",
                status: abortAccepted ? "accepted" : "already_stopped",
                sessionId: abortTarget.sessionId,
                sessionPath: abortPath,
                streamId: activeStreamId,
              });
              return;
            }

            if (msg.type === "steer" && msg.text) {
              debugLog()?.log("ws", `steer (${msg.text.length} chars)`);
              const steerTarget = requireWsSessionContext(msg, ws); if (!steerTarget) return;
              const steerPath = steerTarget.sessionPath;
              if (steerTarget.agentDeleted) {
                rejectDeletedAgentSession(ws, steerPath);
                return;
              }
              if (engine.steerSession(steerPath, msg.text)) {
                wsSend(ws, { type: "steered" });
                return;
              }
              // agent 已停止，降级为正常 prompt（下面的 prompt 分支会处理）。
              // prompt 分支会对同一条消息再解析一次身份，输入没变，结果与这里等价。
              debugLog()?.log("ws", `steer missed, falling back to prompt`);
              msg.type = "prompt";
            }

            // session 切回时，前端请求补发离屏期间的流式内容
            if (msg.type === "resume_stream") {
              const resumeTarget = requireWsSessionContext(msg, ws); if (!resumeTarget) return;
              const currentPath = resumeTarget.sessionPath;
              const currentSessionId = resumeTarget.sessionId;
              const ss = getExistingState(currentPath);
              const runtimeIsStreaming = typeof engine.isSessionStreaming === "function"
                ? !!engine.isSessionStreaming(currentPath)
                : !!ss?.isStreaming;
              if (ss) {
                const resumed = resumeSessionStream(ss, {
                  streamId: msg.streamId,
                  sinceSeq: msg.sinceSeq,
                });
                wsSend(ws, createStreamResumeWsMessage({
                  sessionPath: currentPath,
                  ...(currentSessionId ? { sessionId: currentSessionId } : {}),
                  streamId: resumed.streamId,
                  sinceSeq: resumed.sinceSeq,
                  nextSeq: resumed.nextSeq,
                  reset: resumed.reset,
                  truncated: resumed.truncated,
                  isStreaming: resumed.isStreaming,
                  runtimeIsStreaming,
                  events: resumed.events,
                }));
              } else {
                wsSend(ws, createStreamResumeWsMessage({
                  sessionPath: currentPath,
                  ...(currentSessionId ? { sessionId: currentSessionId } : {}),
                  streamId: null,
                  sinceSeq: Number.isFinite(msg.sinceSeq) ? Math.max(0, Math.floor(msg.sinceSeq)) : 0,
                  nextSeq: 1,
                  reset: false,
                  truncated: false,
                  isStreaming: false,
                  runtimeIsStreaming,
                  events: [],
                }));
              }
              return;
            }

            if (msg.type === "context_usage") {
              const usageCtx = requireWsSessionContext(msg, ws); if (!usageCtx) return;
              const usagePath = usageCtx.sessionPath;
              const usage = engine.getSessionContextUsage?.(usagePath)
                || engine.getSessionByPath(usagePath)?.getContextUsage?.();
              wsSend(ws, {
                type: "context_usage",
                sessionPath: usagePath,
                tokens: usage?.tokens ?? null,
                contextWindow: usage?.contextWindow ?? null,
                percent: usage?.percent ?? null,
              });
              return;
            }

            if (msg.type === "slash" && typeof msg.text === "string") {
              const slashCtx = requireWsSessionContext(msg, ws); if (!slashCtx) return;
              const sp = slashCtx.sessionPath;
              if (slashCtx.agentDeleted) {
                rejectDeletedAgentSession(ws, sp);
                return;
              }
              const dispatcher = engine.slashDispatcher;
              if (!dispatcher) {
                wsSend(ws, { type: "error", message: "slash system not ready", sessionPath: sp });
                return;
              }
              const agentId = slashCtx.agentId;
              if (!agentId) {
                // 走到这里说明服务端认不出这个会话的归属、调用方也没带身份——是内部契约被
                // 破坏，不是用户操作错误。带上 code 让前端换成通用文案，英文原文进详情。
                wsSend(ws, {
                  type: "error",
                  code: "internal_contract",
                  message: "agent identity unresolved",
                  sessionPath: sp,
                });
                return;
              }
              const sendReply = async (text) => {
                wsSend(ws, { type: "slash_result", sessionPath: sp, text, level: "success" });
              };
              const res = await dispatcher.tryDispatch(msg.text.trim(), {
                sessionRef: buildDesktopSlashSessionRef(engine, agentId, sp),
                source: "desktop",
                senderId: "desktop",
                isOwner: true,
                reply: sendReply,
              });
              if (!res.handled) {
                wsSend(ws, { type: "slash_result", sessionPath: sp, text: t("chat.unknownCommand", { text: msg.text }), level: "error" });
              }
              return;
            }

            if (msg.type === "compact") {
              const compactTarget = resolveCompactSessionTarget(engine, msg);
              if (!compactTarget.ok) {
                wsSend(ws, {
                  type: "error",
                  code: compactTarget.code,
                  message: compactTarget.message,
                  sessionId: compactTarget.sessionId,
                });
                return;
              }
              const { sessionId: compactSessionId, sessionPath: compactPath } = compactTarget;
              const requestedMethod = msg.method == null ? null : String(msg.method);
              if (requestedMethod !== null && requestedMethod !== INSTANT_SIMPLE_COMPACTION_METHOD) {
                wsSend(ws, {
                  type: "error",
                  code: "invalid_compaction_method",
                  message: "unsupported compaction method",
                  sessionId: compactSessionId,
                  sessionPath: compactPath,
                });
                return;
              }
              const instantSimple = requestedMethod === INSTANT_SIMPLE_COMPACTION_METHOD;
              const compactionMode = instantSimple
                ? INSTANT_SIMPLE_COMPACTION_RUNTIME_MODE
                : getResolvedCompactionMode(engine.preferences);
              const compactResult = (status, details: Record<string, any> = {}) => wsSend(ws, {
                type: "compaction_result",
                sessionId: compactSessionId,
                sessionPath: compactPath,
                mode: compactionMode,
                status,
                ...details,
              });
              if (
                instantSimple
                && getResolvedInstantSimpleCompactionEnabled(engine.preferences) !== true
              ) {
                compactResult("failed", {
                  reason: "experiment_disabled",
                  message: "Instant simple compaction is disabled in Experiments",
                });
                return;
              }
              if (isDeletedAgentSessionPath(compactPath)) {
                compactResult("failed", { reason: "agent_deleted", message: "agent_deleted" });
                return;
              }
              let session = engine.getSessionByPath(compactPath)
                || await engine.ensureSessionLoaded?.(compactPath);
              if (!session) {
                compactResult("failed", { reason: "session_unavailable", message: t("error.noActiveSession") });
                return;
              }
              if (session.isCompacting) {
                compactResult("failed", { reason: "already_compacting", message: t("error.compacting") });
                return;
              }
              if (engine.isSessionStreaming(compactPath)) {
                compactResult("failed", { reason: "session_streaming", message: t("error.waitForReply") });
                return;
              }
              wsSend(ws, {
                type: "compaction_accepted",
                sessionId: compactSessionId,
                sessionPath: compactPath,
                mode: compactionMode,
              });
              try {
                if (instantSimple) {
                  if (typeof engine.getLossyLocalCompactionSummarySource !== "function") {
                    throw new Error("Instant simple compaction summary resolver is unavailable");
                  }
                  await runInstantSimpleCompaction(session, {
                    getSummarySource: () => engine.getLossyLocalCompactionSummarySource(compactPath),
                    lifecycleReason: "manual",
                  });
                } else {
                  const compacted = await compactSessionWithCachePreservationRecoveringRuntime({
                    session,
                    sessionPath: compactPath,
                    customInstructions: undefined,
                    reloadSessionRuntime: (path) => engine.reloadSessionRuntime?.(path),
                  });
                  session = compacted.session;
                }
                compactResult("succeeded");
              } catch (err) {
                const errMsg = err.message || "";
                const noopReason = compactionNoopReason(errMsg);
                if (noopReason) {
                  compactResult("noop", { reason: noopReason, message: errMsg });
                } else {
                  compactResult("failed", {
                    reason: "compaction_failed",
                    message: t("error.compactFailed", { msg: errMsg }),
                  });
                }
              }
              return;
            }

            if ((msg.type === "prompt" || msg.type === "interject") && (msg.text || msg.images?.length || msg.videos?.length || msg.audios?.length)) {
              const interject = msg.type === "interject";
              // 身份先解析：媒体校验的错误回包也要报在解析后的会话上，而且一条没有身份的
              // 消息不值得先把几 MB base64 量一遍再拒。
              const promptTarget = requireWsSessionContext(msg, ws); if (!promptTarget) return;
              const promptSessionPath = promptTarget.sessionPath;
              // 图片校验：最多 10 张，单张 ≤ 20MB，仅允许常见图片 MIME
              if (msg.images?.length) {
                const MAX_IMAGES = 10;
                if (msg.images.length > MAX_IMAGES) {
                  wsSend(ws, { type: "error", message: t("error.maxImages", { max: MAX_IMAGES }), sessionPath: promptSessionPath });
                  return;
                }
                for (const img of msg.images) {
                  if (!img?.mimeType || !isAllowedChatImageMime(img.mimeType)) {
                    wsSend(ws, { type: "error", message: t("error.unsupportedImageFormat", { mime: img?.mimeType || "unknown" }), sessionPath: promptSessionPath });
                    return;
                  }
                  if (img.data && !isChatImageBase64WithinLimit(img.data)) {
                    wsSend(ws, { type: "error", message: t("error.imageTooLarge"), sessionPath: promptSessionPath });
                    return;
                  }
                }
              }
              if (msg.videos?.length) {
                const MAX_VIDEOS = 3;
                if (msg.videos.length > MAX_VIDEOS) {
                  wsSend(ws, { type: "error", message: t("error.maxVideos", { max: MAX_VIDEOS }), sessionPath: promptSessionPath });
                  return;
                }
                for (const video of msg.videos) {
                  if (!video?.mimeType || !isAllowedChatVideoMime(video.mimeType)) {
                    wsSend(ws, { type: "error", message: t("error.unsupportedVideoFormat", { mime: video?.mimeType || "unknown" }), sessionPath: promptSessionPath });
                    return;
                  }
                  if (video.data && !isChatVideoBase64WithinLimit(video.data)) {
                    wsSend(ws, { type: "error", message: t("error.videoTooLarge"), sessionPath: promptSessionPath });
                    return;
                  }
                }
              }
              if (msg.audios?.length) {
                const MAX_AUDIOS = 3;
                if (msg.audios.length > MAX_AUDIOS) {
                  wsSend(ws, { type: "error", message: t("error.maxAudios", { max: MAX_AUDIOS }), sessionPath: promptSessionPath });
                  return;
                }
                for (const audio of msg.audios) {
                  if (!audio?.mimeType || !isAllowedChatAudioMime(audio.mimeType)) {
                    wsSend(ws, { type: "error", message: t("error.unsupportedAudioFormat", { mime: audio?.mimeType || "unknown" }), sessionPath: promptSessionPath });
                    return;
                  }
                  if (audio.data && !isChatAudioBase64WithinLimit(audio.data)) {
                    wsSend(ws, { type: "error", message: t("error.audioTooLarge"), sessionPath: promptSessionPath });
                    return;
                  }
                }
              }
              // 媒体持久化 + attached_* 标记 + 模态 check 统一在 hub.send() 和下游 handler 处理
              let promptText = msg.text || "";
              // Skill invocation tags
              if (msg.skills?.length) {
                const skillNote = msg.skills.map(s => `[Use skill: ${s}]`).join('\n');
                promptText = `${skillNote}\n${promptText}`;
              }
              debugLog()?.log("ws", `user message (${promptText.length} chars, ${msg.images?.length || 0} images, ${msg.videos?.length || 0} videos, ${msg.audios?.length || 0} audios)`);
              // agentDeleted 门禁只挂在会写入会话的分支（steer / slash / prompt / compact）；
              // abort、resume_stream、context_usage 是停止和只读，删除态照常放行，与改动前一致。
              if (promptTarget.agentDeleted) {
                rejectDeletedAgentSession(ws, promptSessionPath);
                return;
              }
              if (!interject && (
                engine.isSessionStreaming(promptSessionPath)
                || agentReviewTurns.hasPendingParent(promptTarget.sessionId)
              )) {
                wsSend(ws, { type: "error", message: t("error.stillStreaming", { name: engine.agentName }), sessionPath: promptSessionPath });
                return;
              }
              // Reject prompt while model switch is in progress
              if (engine.isSessionSwitching(promptSessionPath)) {
                wsSend(ws, { type: "error", message: t("chat.modelSwitching"), sessionPath: promptSessionPath });
                return;
              }
              const reviewRequests = Array.isArray(msg.agentReviewRequests)
                ? msg.agentReviewRequests.filter(request => (
                  request && typeof request.agentId === "string" && request.agentId.trim()
                ))
                : [];
              if (interject && reviewRequests.length > 0) {
                wsSend(ws, {
                  type: "error",
                  code: "agent_review_interjection_not_supported",
                  message: "@Agent review cannot be sent as an interjection.",
                  sessionPath: promptSessionPath,
                });
                return;
              }
              if (interject && engine.isSessionStreaming(promptSessionPath)) {
                try {
                  await submitDesktopSessionInterjection(engine, {
                    sessionId: promptTarget.sessionId,
                    sessionPath: promptSessionPath,
                    text: promptText,
                    clientMessageId: msg.clientMessageId,
                    images: msg.images,
                    videos: msg.videos,
                    audios: msg.audios,
                    uiContext: msg.uiContext ?? null,
                    displayMessage: msg.displayMessage,
                    sessionFileRefs: msg.sessionFileRefs,
                  });
                  wsSend(ws, { type: "steered", sessionPath: promptSessionPath });
                } catch (err) {
                  const errMessage = err.message === "session_busy"
                    ? t("error.stillStreaming", { name: engine.agentName })
                    : err.message;
                  wsSend(ws, { type: "error", message: errMessage, sessionPath: promptSessionPath });
                }
                return;
              }
              const sessionRefs = normalizeSessionReferences(msg.sessionRefs);
              if (reviewRequests.length > 1) {
                wsSend(ws, {
                  type: "error",
                  code: "multiple_agent_reviews_not_supported",
                  message: "Only one @Agent review is supported per turn.",
                  sessionPath: promptSessionPath,
                });
                return;
              }
              if (reviewRequests.length === 1) {
                if (!promptTarget.sessionId) {
                  wsSend(ws, {
                    type: "error",
                    code: "session_id_required_for_agent_review",
                    message: "A stable Session ID is required for @Agent review.",
                    sessionPath: promptSessionPath,
                  });
                  return;
                }
                const reviewerAgentId = reviewRequests[0].agentId.trim();
                // 这里刻意只认 manifest 上写着的属主，不吃路径推导、也不用上面解析出的
                // ctx.agentId：那个为了让草稿能跑，会退到路径推导甚至客户端声明。评审的
                // 规则是"评审者不能就是会话属主本人"，属主认错了等于让 agent 自己审自己，
                // 所以这一处宁可在属主查不出时放行创建，也不拿宽松来源当权威。
                const ownerAgentId = engine.getSessionManifest?.(promptTarget.sessionId)?.ownerAgentId || null;
                if (!engine.getAgent?.(reviewerAgentId) || reviewerAgentId === ownerAgentId) {
                  wsSend(ws, {
                    type: "error",
                    code: "invalid_review_agent",
                    message: reviewerAgentId === ownerAgentId
                      ? "The reviewing Agent must be different from the current Session Agent."
                      : `Agent not found: ${reviewerAgentId}`,
                    sessionPath: promptSessionPath,
                  });
                  return;
                }
                await agentReviewTurns.start({
                  requestId: msg.clientMessageId,
                  reviewedSessionId: promptTarget.sessionId,
                  reviewedSessionPath: promptSessionPath,
                  reviewer: {
                    agentId: reviewerAgentId,
                    label: typeof reviewRequests[0].label === "string" ? reviewRequests[0].label : reviewerAgentId,
                  },
                  text: promptText,
                  displayMessage: msg.displayMessage,
                  sessionRefs,
                  clientMessageId: msg.clientMessageId,
                  images: msg.images,
                  videos: msg.videos,
                  audios: msg.audios,
                  uiContext: msg.uiContext ?? null,
                  sessionFileRefs: msg.sessionFileRefs,
                });
                return;
              }
              const sessionRefBlock = buildSessionReferenceBlock(sessionRefs);
              if (sessionRefBlock) promptText = `${promptText}\n\n${sessionRefBlock}`;
              try {
                await hub.send(promptText, {
                  sessionId: promptTarget.sessionId,
                  sessionPath: promptSessionPath,
                  clientMessageId: msg.clientMessageId,
                  images: msg.images,
                  videos: msg.videos,
                  audios: msg.audios,
                  uiContext: msg.uiContext ?? null,
                  displayMessage: msg.displayMessage,
                  sessionFileRefs: msg.sessionFileRefs,
                });
              } catch (err) {
                const isUserAbort = err.name === 'AbortError'
                  || (err.message === 'This operation was aborted')
                  || (err.type === 'aborted');
                if (!isUserAbort) {
                  const errMessage = err.message === "session_busy"
                    ? t("error.stillStreaming", { name: engine.agentName })
                    : err.message;
                  wsSend(ws, { type: "error", message: errMessage, sessionPath: promptSessionPath });
                }
              }
            }
          })().catch((err) => {
            const appErr = AppError.wrap(err);
            errorBus.report(appErr, { context: { wsMessageType: msg.type } });
            const isUserAbort = appErr.name === 'AbortError'
              || appErr.message === 'This operation was aborted'
              || (appErr as any).type === 'aborted';
            if (!isUserAbort) {
              wsSend(ws, { type: 'error', message: appErr.message || 'Unknown error', error: appErr.toJSON(), sessionPath: msg.sessionPath });
            }
          });
        },

        onError(event, ws) {
          const err = event.error || event;
          wsLog.error(`error: ${err.message || err}`);
          debugLog()?.error("ws", err.message || String(err));
        },

        // 清理：WS 断开时只中断前台 session（后台 channel delivery / cron 不受影响）
        onClose(event, ws) {
          if (closed) return;
          closed = true;
          activeWsClients = Math.max(0, activeWsClients - 1);
          clients.delete(ws);
          debugLog()?.log("ws", "client disconnected");
          scheduleDisconnectAbort();
          // 无活跃客户端时，清理非流式 session 状态（防止 Map 无限增长）
          if (activeWsClients === 0) {
            for (const [sp, ss] of sessionState) {
              if (!ss.isStreaming) sessionState.delete(sp);
            }
          }
        },
      };
    })
  );

  return { restRoute, wsRoute };
}

function enrichSessionFileBlocks(blocks: any, engine: any, sessionPath: any) {
  if (!Array.isArray(blocks) || blocks.length === 0 || !sessionPath) return blocks || [];
  return blocks.map((block) => {
    const patch = sessionFileBlockPatch(block, engine, sessionPath);
    if (!patch) return block;
    const next = { ...block, ...patch };
    if (next.type === "skill" && next.installedFile) {
      next.installedFile = { ...next.installedFile, ...patch };
    }
    return next;
  });
}

function sessionFileBlockPatch(block: any, engine: any, sessionPath: any) {
  if (!block || typeof block !== "object") return null;
  if (!["file", "artifact", "skill"].includes(block.type)) return null;
  let file = null;
  if (block.fileId && typeof engine?.getSessionFile === "function") {
    file = engine.getSessionFile(block.fileId, { sessionPath });
  }
  if (!file && block.filePath && typeof engine?.getSessionFileByPath === "function") {
    file = engine.getSessionFileByPath(block.filePath, { sessionPath });
  }
  if (!file) return null;
  const serialized = typeof engine?.serializeSessionFile === "function"
    ? engine.serializeSessionFile(file)
    : file;
  return sessionFileFields(serialized || file);
}

function sessionFileFields(file: any) {
  if (!file || typeof file !== "object") return null;
  const fileId = file.fileId || file.id || null;
  return {
    ...(fileId ? { fileId } : {}),
    ...(file.filePath ? { filePath: file.filePath } : {}),
    ...(file.label || file.displayName || file.filename ? { label: file.label || file.displayName || file.filename } : {}),
    ...(file.ext !== undefined ? { ext: file.ext } : {}),
    ...(file.mime ? { mime: file.mime } : {}),
    ...(file.kind ? { kind: file.kind } : {}),
    ...(file.storageKind ? { storageKind: file.storageKind } : {}),
    ...(file.status ? { status: file.status } : {}),
    ...(file.missingAt !== undefined ? { missingAt: file.missingAt } : {}),
    ...(file.resource ? { resource: file.resource } : {}),
  };
}

/**
 * 后台生成 session 标题：从第一轮对话提取摘要
 * 只在 session 还没有自定义标题时执行
 *
 * 首条 user 消息在提交时会被前置注入 reminder / reference 信封和附件标记，
 * 所以取标题素材前必须先投影回用户真正打的那段文字：既喂给摘要模型，也用于
 * 模型不可用时的截断兜底，否则标题会变成信封字面量。
 */
export async function generateSessionTitle(engine: any, notify: any, opts: any = {}) {
  try {
    const sessionPath = opts.sessionPath;
    if (!sessionPath) return false;

    // 检查是否已有标题（避免重复生成）
    const sessions = await engine.listSessions();
    const current = sessions.find(s => s.path === sessionPath);
    if (current?.title) return true;

    const session = engine.getSessionByPath(sessionPath);
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    const userMsg = messages.find(m => m.role === "user");
    const assistantMsg = messages.find(m => m.role === "assistant");
    if (!userMsg && !opts.userTextHint) return false;

    const userText = visiblePromptText(opts.userTextHint || extractText(userMsg?.content));
    const assistantText = (opts.assistantTextHint || extractText(assistantMsg?.content)).trim();
    // 纯附件消息剥完信封什么都不剩：跳过生成，侧边栏回退到同样剥离过的首条消息
    if (!userText || !assistantText) return false;

    // 超时由 callText 内部的 AbortSignal 统一控制：超时即取消 Pi SDK 连接，无空跑
    let title = await engine.summarizeTitle(userText, assistantText, { timeoutMs: 15_000, sessionPath });

    // API 失败时，用用户第一条消息截取作为 fallback 标题
    if (!title) {
      const fallback = userText.replace(/\n/g, " ").trim().slice(0, 30);
      if (!fallback) return false;
      title = fallback;
      log.log(`session 标题 API 失败，使用 fallback: ${title}`);
    }

    // 保存标题
    await engine.saveSessionTitle(sessionPath, title);

    // 通知前端更新
    notify({ type: "session_title", title, path: sessionPath });
    return true;
  } catch (err) {
    log.error(`生成 session 标题失败: ${err.message}`);
    return false;
  }
}
