import { sessionScopedKey } from './session-slice';
import type { PresentedError } from '../errors/error-presenter';

/**
 * 一条 inline error：text 是给用户看的人话，detail 与 code 是排障用的原始信息，
 * 由错误条的展开区呈现。形状跟 presentError() 的产物一致，两端不各自定义。
 */
export type InlineErrorEntry = PresentedError;

export interface ActiveSessionStream {
  streamId: string | null;
  turnId: string | null;
}

export interface StreamingStatusIdentity {
  streamId?: string | null;
  turnId?: string | null;
}

export interface StreamingSlice {
  /** 所有正在 streaming 的 session identity key 集合（legacy path 只做兼容 locator） */
  streamingSessions: string[];
  /** 正在 streaming 的 session 身份。用于忽略旧 turn/status 迟到事件。 */
  activeSessionStreams: Record<string, ActiveSessionStream>;
  addStreamingSession: (path: string, identity?: StreamingStatusIdentity) => void;
  removeStreamingSession: (path: string, identity?: StreamingStatusIdentity) => boolean;
  forceRemoveStreamingSession: (path: string) => boolean;
  /** 后台 session 已完成新输出，但用户尚未切回查看。 */
  unreadOutputSessionPaths: string[];
  markSessionOutputUnread: (path: string) => void;
  clearSessionOutputUnread: (path: string) => void;
  /** 按 session path 存储的内联错误（权威源）。null 表示无 error。 */
  inlineErrors: Record<string, InlineErrorEntry | null>;
  /**
   * 写入某个 session 的 inline error；ttl>0 时 ttl 毫秒后自动清除（默认 5s）。
   * 新 error 覆盖旧 error 会取消旧定时器。传字符串表示这句话已经是给用户看的成品，
   * 没有额外详情；带 detail/code 的错误传 InlineErrorEntry。
   */
  setInlineError: (path: string, error: string | InlineErrorEntry, ttlMs?: number) => void;
  /** 清除某个 session 的 inline error（同时取消其定时器）。 */
  clearInlineError: (path: string) => void;
  /** 模型切换进行中（阻止发送） */
  modelSwitching: boolean;
  setModelSwitching: (v: boolean) => void;
}

// 定时器按 session identity key 存在模块闭包里，不污染 store 的可见状态。
// 生命周期规则：
//   - setInlineError 覆盖写入时，先 clear 旧 timer 再起新的，避免"旧 timer 误清新 text"竞态
//   - clearInlineError 清状态时同步 clear timer，防 timer 在 null 写入后继续 fire
//   - timer 回调内部用 get() 取最新条目：若已被新 error 覆盖，引用不等于本次写入的条目，不动它。
//     用引用而非文本比较，同一句错误连续发生两次时旧定时器才不会把新条目清掉
const inlineErrorTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** 把字符串或部分条目归一化成完整条目。总是新建对象，让每次写入拥有独一无二的引用。 */
function toInlineErrorEntry(error: string | InlineErrorEntry): InlineErrorEntry {
  if (typeof error === 'string') return { text: error, detail: null, code: null };
  return {
    text: error.text,
    detail: error.detail ?? null,
    code: error.code ?? null,
  };
}

function cancelTimer(path: string): void {
  const t = inlineErrorTimers.get(path);
  if (t) {
    clearTimeout(t);
    inlineErrorTimers.delete(path);
  }
}

function identityKeyForPath(get: (() => any) | undefined, path: string): string {
  return sessionScopedKey(get?.() || {}, path) || path;
}

function filterLegacyAndIdentity(list: readonly string[], path: string, key: string): string[] {
  return list.filter((item) => item !== key && item !== path);
}

function putIdentityMapValue<T>(map: Record<string, T>, path: string, key: string, value: T): Record<string, T> {
  const next = { ...map, [key]: value };
  if (key !== path) delete next[path];
  return next;
}

function deleteIdentityMapValue<T>(map: Record<string, T>, path: string, key: string): Record<string, T> {
  const next = { ...map };
  delete next[key];
  if (key !== path) delete next[path];
  return next;
}

function normalizeIdentityPart(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function hasExplicitIdentity(identity: StreamingStatusIdentity | undefined): boolean {
  return !!identity
    && (Object.prototype.hasOwnProperty.call(identity, 'streamId')
      || Object.prototype.hasOwnProperty.call(identity, 'turnId'));
}

function hasKnownIdentityPart(identity: ActiveSessionStream | StreamingStatusIdentity | undefined): boolean {
  return !!normalizeIdentityPart(identity?.streamId) || !!normalizeIdentityPart(identity?.turnId);
}

function identitiesMatch(
  current: ActiveSessionStream | undefined,
  incoming: StreamingStatusIdentity | undefined,
): boolean {
  if (!current || !hasKnownIdentityPart(current)) return true;
  const currentStreamId = normalizeIdentityPart(current.streamId);
  const incomingStreamId = normalizeIdentityPart(incoming?.streamId);
  let matchedKnownPart = false;
  if (currentStreamId && incomingStreamId) {
    if (currentStreamId !== incomingStreamId) return false;
    matchedKnownPart = true;
  }

  const currentTurnId = normalizeIdentityPart(current.turnId);
  const incomingTurnId = normalizeIdentityPart(incoming?.turnId);
  if (currentTurnId && incomingTurnId) {
    if (currentTurnId !== incomingTurnId) return false;
    matchedKnownPart = true;
  }

  return matchedKnownPart;
}

export const createStreamingSlice = (
  set: (partial: Partial<StreamingSlice> | ((s: StreamingSlice) => Partial<StreamingSlice>)) => void,
  get?: () => StreamingSlice,
): StreamingSlice => ({
  streamingSessions: [],
  activeSessionStreams: {},
  addStreamingSession: (path, identity) => set((s) => {
    const key = identityKeyForPath(get, path);
    const active = s.activeSessionStreams || {};
    const current = active[key] || active[path];
    const currentStreamId = normalizeIdentityPart(current?.streamId);
    const currentTurnId = normalizeIdentityPart(current?.turnId);
    const incomingStreamId = normalizeIdentityPart(identity?.streamId);
    const incomingTurnId = normalizeIdentityPart(identity?.turnId);
    const explicitIdentity = hasExplicitIdentity(identity);
    const streamChanged = !!incomingStreamId && incomingStreamId !== currentStreamId;
    const streamingSessions = filterLegacyAndIdentity(s.streamingSessions, path, key);
    return {
      streamingSessions: [...streamingSessions, key],
      activeSessionStreams: putIdentityMapValue(active, path, key, {
          streamId: explicitIdentity
            ? (incomingStreamId ?? currentStreamId ?? null)
            : (currentStreamId ?? null),
          turnId: explicitIdentity
            ? (incomingTurnId ?? (streamChanged ? null : currentTurnId) ?? null)
            : (currentTurnId ?? null),
      }),
    };
  }),
  removeStreamingSession: (path, identity) => {
    let applied = true;
    set((s) => {
      const key = identityKeyForPath(get, path);
      const active = s.activeSessionStreams || {};
      if (!identitiesMatch(active[key] || active[path], identity)) {
        applied = false;
        return {};
      }
      return {
        streamingSessions: filterLegacyAndIdentity(s.streamingSessions, path, key),
        activeSessionStreams: deleteIdentityMapValue(active, path, key),
      };
    });
    return applied;
  },
  forceRemoveStreamingSession: (path) => {
    let applied = false;
    set((s) => {
      const key = identityKeyForPath(get, path);
      const active = s.activeSessionStreams || {};
      const hadSession = s.streamingSessions.includes(key) || (key !== path && s.streamingSessions.includes(path));
      const hadIdentity = Object.prototype.hasOwnProperty.call(active, key)
        || (key !== path && Object.prototype.hasOwnProperty.call(active, path));
      if (!hadSession && !hadIdentity) return {};
      applied = hadSession || hadIdentity;
      return {
        streamingSessions: filterLegacyAndIdentity(s.streamingSessions, path, key),
        activeSessionStreams: deleteIdentityMapValue(active, path, key),
      };
    });
    return applied;
  },
  unreadOutputSessionPaths: [],
  markSessionOutputUnread: (path) => set((s) => {
    const key = identityKeyForPath(get, path);
    const unread = filterLegacyAndIdentity(s.unreadOutputSessionPaths, path, key);
    return { unreadOutputSessionPaths: [...unread, key] };
  }),
  clearSessionOutputUnread: (path) => set((s) => {
    const key = identityKeyForPath(get, path);
    return { unreadOutputSessionPaths: filterLegacyAndIdentity(s.unreadOutputSessionPaths, path, key) };
  }),
  inlineErrors: {},
  setInlineError: (path, error, ttlMs = 5000) => {
    const key = identityKeyForPath(get, path);
    const entry = toInlineErrorEntry(error);
    cancelTimer(key);
    if (key !== path) cancelTimer(path);
    set((s) => ({ inlineErrors: putIdentityMapValue(s.inlineErrors, path, key, entry) }));
    if (ttlMs > 0) {
      const timer = setTimeout(() => {
        inlineErrorTimers.delete(key);
        const current = get?.().inlineErrors[key];
        if (current !== entry) return;
        set((s) => ({ inlineErrors: putIdentityMapValue(s.inlineErrors, path, key, null) }));
      }, ttlMs);
      inlineErrorTimers.set(key, timer);
    }
  },
  clearInlineError: (path) => {
    const key = identityKeyForPath(get, path);
    cancelTimer(key);
    if (key !== path) cancelTimer(path);
    set((s) => ({ inlineErrors: putIdentityMapValue(s.inlineErrors, path, key, null) }));
  },
  modelSwitching: false,
  setModelSwitching: (v) => set({ modelSwitching: v }),
});
