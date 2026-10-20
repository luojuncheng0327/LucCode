/**
 * stream-resume.ts — 流恢复逻辑（从 app-ws-shim.ts 迁移）
 *
 * 管理 per-session 流元数据、断线重连后的 stream resume 请求和事件重放。
 * 不依赖 ctx 注入，通过 Zustand store 访问状态。
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- WS 消息协议为动态 JSON，类型无法静态收窄 */

import { streamBufferManager } from '../hooks/use-stream-buffer';
import { useStore } from '../stores';
import { sessionIdForPathFromLocatorState, sessionScopedKey } from '../stores/session-slice';
import { clearChat } from '../stores/agent-actions';
import { loadMessages } from '../stores/session-actions';
import { registerStreamResumeMetaInvalidator } from '../stores/stream-invalidator';

// 延迟导入，打破循环依赖
let _handleServerMessage: ((msg: any) => void) | null = null;
let _applyStreamingStatus: ((
  isStreaming: boolean,
  sessionPath: string | null,
  identity?: { streamId?: string | null; turnId?: string | null },
  options?: { force?: boolean },
) => boolean | void) | null = null;
let _getWebSocket: (() => WebSocket | null) | null = null;

export function injectHandlers(
  handleServerMessage: (msg: any) => void,
  applyStreamingStatus: (
    isStreaming: boolean,
    sessionPath: string | null,
    identity?: { streamId?: string | null; turnId?: string | null },
    options?: { force?: boolean },
  ) => boolean | void,
): void {
  _handleServerMessage = handleServerMessage;
  _applyStreamingStatus = applyStreamingStatus;
}

export function injectWebSocketGetter(getWebSocket: () => WebSocket | null): void {
  _getWebSocket = getWebSocket;
}

// ── 流恢复版本计数 ──
const _streamResumeRebuildVersions: Record<string, number> = {};
let _streamResumeRebuildingFor: string | null = null;

// ── Session 流元数据（module-level，不走 Zustand） ──
const MAX_CONSUMED_SEQS = 10_000;

type SessionStreamMeta = {
  streamId: string | null;
  lastSeq: number;
  consumedSeqs: Set<number>;
};

const _sessionStreams: Record<string, SessionStreamMeta> = {};

type StreamSessionInput = string | {
  sessionId?: unknown;
  sessionPath?: unknown;
  path?: unknown;
  session?: {
    sessionId?: unknown;
    path?: unknown;
  } | null;
} | null | undefined;

type ResolvedStreamSession = {
  sessionId: string | null;
  sessionPath: string | null;
  key: string | null;
  isCurrent: boolean;
};

function normalizeStreamString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function streamRefFromInput(input: StreamSessionInput, opts: any = {}): { sessionId: string | null; sessionPath: string | null } {
  if (typeof input === 'string') {
    return {
      sessionId: normalizeStreamString(opts?.sessionId),
      sessionPath: normalizeStreamString(input) || normalizeStreamString(opts?.sessionPath),
    };
  }
  const session = input && typeof input === 'object' && input.session && typeof input.session === 'object'
    ? input.session
    : null;
  return {
    sessionId: normalizeStreamString(input && typeof input === 'object' ? input.sessionId : null)
      || normalizeStreamString(session?.sessionId)
      || normalizeStreamString(opts?.sessionId),
    sessionPath: normalizeStreamString(input && typeof input === 'object' ? input.sessionPath : null)
      || normalizeStreamString(input && typeof input === 'object' ? input.path : null)
      || normalizeStreamString(session?.path)
      || normalizeStreamString(opts?.sessionPath),
  };
}

function resolveStreamSession(
  input?: StreamSessionInput,
  opts: { fallbackToCurrent?: boolean; requestOptions?: any } = {},
): ResolvedStreamSession {
  const state = useStore.getState();
  const ref = streamRefFromInput(input, opts.requestOptions);
  const currentSessionId = normalizeStreamString(state.currentSessionId);
  const currentSessionPath = normalizeStreamString(state.currentSessionPath);
  const explicitPath = ref.sessionPath || (opts.fallbackToCurrent !== false ? currentSessionPath : null);
  const sessionId = ref.sessionId
    || (explicitPath ? sessionIdForPathFromLocatorState(state, explicitPath) : null)
    || (explicitPath && explicitPath === currentSessionPath ? currentSessionId : null);
  const currentPathForSessionId = sessionId && sessionId === currentSessionId ? currentSessionPath : null;
  const locatorPath = sessionId
    ? normalizeStreamString(state.sessionLocatorsById?.[sessionId]?.path)
    : null;
  const sessionPath = currentPathForSessionId || locatorPath || explicitPath;
  const key = sessionId || (sessionPath ? sessionScopedKey(state, sessionPath) || sessionPath : null);
  const isCurrent = (!!sessionId && sessionId === currentSessionId)
    || (!!sessionPath && sessionPath === currentSessionPath);
  return { sessionId, sessionPath, key, isCurrent };
}

function isStillCurrentStreamSession(target: ResolvedStreamSession): boolean {
  const state = useStore.getState();
  if (target.sessionId) return state.currentSessionId === target.sessionId;
  return !!target.sessionPath && state.currentSessionPath === target.sessionPath;
}

function streamIdentityKey(input?: StreamSessionInput): string | null {
  return resolveStreamSession(input).key;
}

export function invalidateSessionStreamMeta(sessionRef?: StreamSessionInput): void {
  if (sessionRef == null) {
    for (const key of Object.keys(_sessionStreams)) delete _sessionStreams[key];
    return;
  }
  const target = resolveStreamSession(sessionRef, { fallbackToCurrent: false });
  const key = target.key || target.sessionPath;
  if (key) delete _sessionStreams[key];
  if (target.sessionPath && target.sessionPath !== key) delete _sessionStreams[target.sessionPath];
}

export function getSessionStreamMeta(sessionRef?: StreamSessionInput): SessionStreamMeta | null {
  const target = resolveStreamSession(sessionRef);
  const path = target.sessionPath;
  const key = target.key || path;
  if (!key) return null;
  if (!_sessionStreams[key]) {
    _sessionStreams[key] = (path ? _sessionStreams[path] : null) || { streamId: null, lastSeq: 0, consumedSeqs: new Set() };
    if (path && key !== path) delete _sessionStreams[path];
  }
  return _sessionStreams[key];
}

export function isStreamScopedMessage(msg: any): boolean {
  const ref = streamRefFromInput(msg, {});
  return !!(msg && (ref.sessionId || ref.sessionPath) && (msg.streamId || Number.isFinite(msg.seq)));
}

export function updateSessionStreamMeta(meta: any = {}): boolean {
  const target = resolveStreamSession(meta);
  if (!target.key && !target.sessionPath) return true;
  const entry = getSessionStreamMeta(target);
  if (!entry) return true;

  if (meta.streamId) {
    if (entry.streamId && entry.streamId !== meta.streamId) {
      entry.lastSeq = 0;
      entry.consumedSeqs.clear();
    }
    entry.streamId = meta.streamId;
  }

  if (Number.isFinite(meta.seq)) {
    const seq = Math.max(0, Math.floor(meta.seq));
    if (entry.consumedSeqs.has(seq)) return false;
    markConsumedSeq(entry, seq);
  }

  return true;
}

export function isStreamResumeRebuilding(): string | null {
  return _streamResumeRebuildingFor;
}

export function requestStreamResume(sessionRef?: StreamSessionInput, opts: any = {}): void {
  const target = resolveStreamSession(sessionRef, { requestOptions: opts });
  const path = target.sessionPath;
  const ws = _getWebSocket?.() || null;
  if (!path || !ws || ws.readyState !== WebSocket.OPEN) return;
  const sessionId = target.sessionId || sessionIdForPathFromLocatorState(useStore.getState(), path);
  const meta = getSessionStreamMeta(target) || { streamId: null, lastSeq: 0 };
  const fromStart = !!opts.fromStart;
  const streamId = opts.streamId !== undefined ? opts.streamId : (meta.streamId || null);
  const sinceSeq = Number.isFinite(opts.sinceSeq)
    ? Math.max(0, Math.floor(opts.sinceSeq))
    : (fromStart ? 0 : (meta.lastSeq || 0));
  ws.send(JSON.stringify({
    type: 'resume_stream',
    sessionPath: path,
    ...(sessionId ? { sessionId } : {}),
    streamId,
    sinceSeq,
  }));
}

// ── 流恢复 / 重建 ──

function nextResumeRebuildVersion(target: ResolvedStreamSession): number {
  const key = target.key || target.sessionPath;
  if (!key) return 0;
  const next = (_streamResumeRebuildVersions[key] ?? 0) + 1;
  _streamResumeRebuildVersions[key] = next;
  if (target.sessionPath && key !== target.sessionPath) delete _streamResumeRebuildVersions[target.sessionPath];
  return next;
}

function isLatestResumeRebuild(target: ResolvedStreamSession, version: number): boolean {
  const key = target.key || target.sessionPath;
  return !!key && _streamResumeRebuildVersions[key] === version;
}

function shouldHydrateCompletedEmptyResume(msg: any): boolean {
  if (msg.isStreaming) return false;
  if (!msg.streamId) return false;
  if (Array.isArray(msg.events) && msg.events.length > 0) return false;
  return Number.isFinite(msg.nextSeq) && msg.nextSeq > 1;
}

function resolveRuntimeStreaming(msg: any): boolean {
  return typeof msg.runtimeIsStreaming === 'boolean'
    ? msg.runtimeIsStreaming
    : !!msg.isStreaming;
}

function shouldForceApplyRuntimeStreamingStatus(msg: any): boolean {
  return msg?.runtimeIsStreaming === false;
}

function prepareStreamMeta(sessionRef: StreamSessionInput, streamId: string | null, opts: { resetConsumed?: boolean } = {}): SessionStreamMeta | null {
  const meta = getSessionStreamMeta(sessionRef);
  if (!meta) return null;
  if (streamId) {
    if (meta.streamId && meta.streamId !== streamId) {
      meta.lastSeq = 0;
      meta.consumedSeqs.clear();
    }
    meta.streamId = streamId;
  }
  if (opts.resetConsumed) {
    meta.lastSeq = 0;
    meta.consumedSeqs.clear();
  }
  return meta;
}

function markConsumedSeq(meta: SessionStreamMeta, seq: unknown): void {
  const value = Number(seq);
  if (!Number.isFinite(value)) return;
  const normalized = Math.max(0, Math.floor(value));
  meta.lastSeq = Math.max(meta.lastSeq || 0, normalized);
  meta.consumedSeqs.add(normalized);
  pruneConsumedSeqs(meta);
}

function pruneConsumedSeqs(meta: SessionStreamMeta): void {
  if (meta.consumedSeqs.size <= MAX_CONSUMED_SEQS) return;
  const sorted = [...meta.consumedSeqs].sort((a, b) => a - b);
  const removeCount = meta.consumedSeqs.size - MAX_CONSUMED_SEQS;
  for (let i = 0; i < removeCount; i += 1) {
    meta.consumedSeqs.delete(sorted[i]);
  }
}

function dispatchReplayEvent(sessionPath: string, streamId: string | null, entry: any, meta: SessionStreamMeta | null): void {
  const seq = Number.isFinite(entry?.seq) ? Math.max(0, Math.floor(Number(entry.seq))) : null;
  if (seq !== null && meta?.consumedSeqs.has(seq)) return;

  _handleServerMessage?.({
    ...entry.event,
    sessionPath,
    streamId,
    seq: entry.seq,
    __fromReplay: true,
  });

  if (seq !== null && meta) {
    markConsumedSeq(meta, seq);
  }
}

async function rebuildSessionFromResume(msg: any, opts: { finishTurnBeforeHydrate?: boolean } = {}): Promise<void> {
  const target = resolveStreamSession(msg);
  const sessionPath = target.sessionPath;
  if (!sessionPath) return;

  const isCurrentSession = target.isCurrent;
  const myVersion = nextResumeRebuildVersion(target);
  if (isCurrentSession) _streamResumeRebuildingFor = sessionPath;
  try {
    if (opts.finishTurnBeforeHydrate) {
      streamBufferManager.finishTurn(sessionPath);
    } else {
      // 清掉旧 buffer 防止脏写
      streamBufferManager.clear(sessionPath);
    }

    if (isCurrentSession) {
      clearChat();
    } else {
      useStore.getState().clearSession?.(sessionPath);
    }
    await loadMessages(sessionPath);

    if (!isLatestResumeRebuild(target, myVersion)) return;
    if (isCurrentSession && !isStillCurrentStreamSession(target)) return;

    const streamId = msg.streamId || null;
    const meta = prepareStreamMeta(target, streamId, { resetConsumed: true });

    for (const entry of msg.events || []) {
      dispatchReplayEvent(sessionPath, streamId, entry, meta);
    }

    if (meta && Number.isFinite(msg.nextSeq)) {
      meta.lastSeq = Math.max(meta.lastSeq || 0, Math.max(0, msg.nextSeq - 1));
    }

    _applyStreamingStatus?.(resolveRuntimeStreaming(msg), sessionPath, {
      streamId: msg.streamId || null,
    }, { force: shouldForceApplyRuntimeStreamingStatus(msg) });

    const ws = _getWebSocket?.() || null;
    if (isCurrentSession && isStillCurrentStreamSession(target) && ws?.readyState === WebSocket.OPEN && msg.isStreaming) {
      requestStreamResume(target);
    }
  } finally {
    if (isLatestResumeRebuild(target, myVersion) && _streamResumeRebuildingFor === sessionPath) {
      _streamResumeRebuildingFor = null;
    }
  }
}

export function replayStreamResume(msg: any): void {
  const target = resolveStreamSession(msg);
  const sessionPath = target.sessionPath;
  if (!sessionPath) return;

  const completedEmptyResume = shouldHydrateCompletedEmptyResume(msg);
  if (msg.reset || msg.truncated || completedEmptyResume) {
    rebuildSessionFromResume(msg, { finishTurnBeforeHydrate: completedEmptyResume }).catch((err) => {
      console.error('[stream] rebuild failed:', err);
      _streamResumeRebuildingFor = null;
    });
    return;
  }

  const streamId = msg.streamId || null;
  const meta = prepareStreamMeta(target, streamId);

  for (const entry of msg.events || []) {
    dispatchReplayEvent(sessionPath, streamId, entry, meta);
  }

  if (meta && Number.isFinite(msg.nextSeq)) {
    meta.lastSeq = Math.max(meta.lastSeq || 0, Math.max(0, msg.nextSeq - 1));
  }

  _applyStreamingStatus?.(resolveRuntimeStreaming(msg), sessionPath, {
    streamId: msg.streamId || null,
  }, { force: shouldForceApplyRuntimeStreamingStatus(msg) });
}

registerStreamResumeMetaInvalidator((sessionPath) => {
  invalidateSessionStreamMeta(sessionPath);
});
