import type {
  Session,
  SessionMetaRecoveryStatus,
  SessionPermissionMode,
  SessionStream,
  TodoItem,
} from '../types';
import type { SessionConfirmationBlock } from './chat-types';
import type { ThinkingLevel } from './model-slice';

const SESSION_PERMISSION_MODES = new Set(['auto', 'operate', 'ask', 'read_only']);

function normalizeSessionPermissionMode(mode: unknown): SessionPermissionMode {
  return typeof mode === 'string' && SESSION_PERMISSION_MODES.has(mode)
    ? mode as SessionPermissionMode
    : 'ask';
}

function normalizeSessionId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeSessionPath(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function mergeSessionLocators(
  current: Record<string, { path: string | null }>,
  sessions: Session[],
): Record<string, { path: string | null }> {
  const next = { ...current };
  for (const session of sessions || []) {
    const sessionId = normalizeSessionId(session.sessionId);
    if (!sessionId) continue;
    next[sessionId] = { path: normalizeSessionPath(session.path) };
  }
  return next;
}

export type SessionLocatorState = {
  currentSessionId?: string | null;
  currentSessionPath?: string | null;
  sessions?: Array<Pick<Session, 'path' | 'sessionId'>>;
  sessionLocatorsById?: Record<string, { path: string | null }>;
};

export function sessionIdForPathFromLocatorState(
  state: SessionLocatorState,
  sessionPath: string | null | undefined,
): string | null {
  const path = normalizeSessionPath(sessionPath);
  if (!path) return null;
  const currentSessionId = normalizeSessionId(state.currentSessionId);
  if (currentSessionId && state.currentSessionPath === path) return currentSessionId;
  const session = (state.sessions || []).find((item) => item?.path === path);
  const sessionId = normalizeSessionId(session?.sessionId);
  if (sessionId) return sessionId;
  for (const [id, locator] of Object.entries(state.sessionLocatorsById || {})) {
    if (locator?.path === path) return id;
  }
  return null;
}

export function sessionScopedKey(
  state: SessionLocatorState,
  sessionPath: string | null | undefined,
): string | null {
  const path = normalizeSessionPath(sessionPath);
  if (!path) return null;
  return sessionIdForPathFromLocatorState(state, path) || path;
}

export function sessionScopedValue<T>(
  state: SessionLocatorState,
  map: Record<string, T> | null | undefined,
  sessionPath: string | null | undefined,
): T | undefined {
  if (!map) return undefined;
  const path = normalizeSessionPath(sessionPath);
  if (!path) return undefined;
  const key = sessionScopedKey(state, path);
  if (key && Object.prototype.hasOwnProperty.call(map, key)) return map[key];
  return Object.prototype.hasOwnProperty.call(map, path) ? map[path] : undefined;
}

export function sessionScopedListIncludes(
  state: SessionLocatorState,
  list: readonly string[] | null | undefined,
  sessionPath: string | null | undefined,
): boolean {
  if (!list || !sessionPath) return false;
  const key = sessionScopedKey(state, sessionPath);
  return !!key && (list.includes(key) || (key !== sessionPath && list.includes(sessionPath)));
}

function putSessionScopedListValue(
  state: SessionLocatorState,
  list: readonly string[],
  sessionPath: string,
): string[] {
  const key = sessionScopedKey(state, sessionPath) || sessionPath;
  const next = list.filter((item) => item !== key && item !== sessionPath);
  next.push(key);
  return next;
}

function deleteSessionScopedListValue(
  state: SessionLocatorState,
  list: readonly string[],
  sessionPath: string,
): string[] {
  const key = sessionScopedKey(state, sessionPath) || sessionPath;
  return list.filter((item) => item !== key && item !== sessionPath);
}

function putSessionScopedValue<T>(
  state: SessionLocatorState,
  map: Record<string, T>,
  sessionPath: string,
  value: T,
): Record<string, T> {
  const key = sessionScopedKey(state, sessionPath) || sessionPath;
  const next = { ...map, [key]: value };
  if (key !== sessionPath) delete next[sessionPath];
  return next;
}

function deleteSessionScopedValue<T>(
  state: SessionLocatorState,
  map: Record<string, T>,
  sessionPath: string,
): Record<string, T> {
  const key = sessionScopedKey(state, sessionPath) || sessionPath;
  const next = { ...map };
  delete next[key];
  if (key !== sessionPath) delete next[sessionPath];
  return next;
}

export interface SessionSlice {
  sessions: Session[];
  currentSessionPath: string | null;
  currentSessionId: string | null;
  sessionLocatorsById: Record<string, { path: string | null }>;
  pendingSessionSwitchPath: string | null;
  sessionStreams: Record<string, SessionStream>;
  pendingNewSession: boolean;
  /** 当前首页新会话草稿的实例身份；每次重新进入新会话页都会更换，防止迟到创建响应 ABA。 */
  pendingDraftId: string | null;
  pendingProjectId: string | null;
  pendingNewSessionThinkingLevel: ThinkingLevel | null;
  pendingNewSessionPermissionMode: SessionPermissionMode | null;
  sessionPermissionMode: SessionPermissionMode;
  memoryEnabled: boolean;
  /** @deprecated 兼容层 — 读取当前 session 的 todos，新代码用 todosBySession */
  sessionTodos: TodoItem[];
  todosBySession: Record<string, TodoItem[]>;
  sessionAuthorizedFoldersByPath: Record<string, string[]>;
  /**
   * 每个 session 的 live todos 版本号。live WS 写入（tool_end）+1，
   * loadMessages hydrate 捕获版本前后对比：若 mid-flight 被 live 更新，
   * 就跳过 hydrate 写入，避免旧快照覆盖更晚到达的实时状态。
   */
  todosLiveVersionBySession: Record<string, number>;
  /** fresh-compact 进行中的 session 集合（跨切换保留 busy 态） */
  capabilityRefreshingSessions: string[];
  /** 输入区确认卡片的 live pending 状态，keyed by session identity，避免后台 session 事件被焦点过滤丢失。 */
  pendingSessionConfirmationsByPath: Record<string, SessionConfirmationBlock>;
  /**
   * session 元数据待恢复状态：loadSessions() 并行读取 /api/health 的 sessionStore
   * 附块后写入这里。默认 null（尚未探测过 / 探测被静默忽略），侧边栏据此在
   * degraded 时把误导性的空列表换成"部分会话待恢复"提示。
   */
  metaRecovery: SessionMetaRecoveryStatus | null;
  setSessions: (sessions: Session[]) => void;
  setCurrentSessionPath: (path: string | null) => void;
  setCurrentSessionRef: (ref: { sessionId?: string | null; path?: string | null }) => void;
  setPendingSessionSwitchPath: (path: string | null) => void;
  setSessionStream: (sessionPath: string, stream: SessionStream) => void;
  removeSessionStream: (sessionPath: string) => void;
  setPendingNewSession: (pending: boolean) => void;
  setPendingProjectId: (projectId: string | null) => void;
  setPendingNewSessionThinkingLevel: (level: ThinkingLevel | null) => void;
  setPendingNewSessionPermissionMode: (mode: SessionPermissionMode | null) => void;
  setSessionPermissionMode: (mode: SessionPermissionMode) => void;
  setMemoryEnabled: (enabled: boolean) => void;
  setSessionTodos: (todos: TodoItem[]) => void;
  setSessionTodosForPath: (sessionPath: string, todos: TodoItem[]) => void;
  setSessionAuthorizedFolders: (sessionPath: string, folders: string[]) => void;
  bumpTodosLiveVersion: (sessionPath: string) => void;
  setSessionCapabilityRefreshing: (sessionPath: string, refreshing: boolean) => void;
  setPendingSessionConfirmation: (sessionPath: string, block: SessionConfirmationBlock | null) => void;
  resolvePendingSessionConfirmation: (confirmId: string) => void;
  setSessionMetaRecovery: (status: SessionMetaRecoveryStatus | null) => void;
}

export const createSessionSlice = (
  set: (partial: Partial<SessionSlice> | ((s: SessionSlice) => Partial<SessionSlice>)) => void
): SessionSlice => ({
  sessions: [],
  currentSessionPath: null,
  currentSessionId: null,
  sessionLocatorsById: {},
  pendingSessionSwitchPath: null,
  sessionStreams: {},
  pendingNewSession: false,
  pendingDraftId: null,
  pendingProjectId: null,
  pendingNewSessionThinkingLevel: null,
  pendingNewSessionPermissionMode: null,
  sessionPermissionMode: 'ask',
  memoryEnabled: true,
  sessionTodos: [],
  todosBySession: {},
  sessionAuthorizedFoldersByPath: {},
  todosLiveVersionBySession: {},
  capabilityRefreshingSessions: [],
  pendingSessionConfirmationsByPath: {},
  metaRecovery: null,
  setSessions: (sessions) => set((s) => ({
    sessions,
    sessionLocatorsById: mergeSessionLocators(s.sessionLocatorsById, sessions),
  })),
  setCurrentSessionPath: (path) => set({ currentSessionPath: path, ...(path === null ? { currentSessionId: null } : {}) }),
  setCurrentSessionRef: (ref) => set((s) => {
    const sessionId = normalizeSessionId(ref?.sessionId);
    const sessionPath = normalizeSessionPath(ref?.path);
    return {
      currentSessionId: sessionId,
      currentSessionPath: sessionPath,
      ...(sessionId ? {
        sessionLocatorsById: {
          ...s.sessionLocatorsById,
          [sessionId]: { path: sessionPath },
        },
      } : {}),
    };
  }),
  setPendingSessionSwitchPath: (path) => set({ pendingSessionSwitchPath: path }),
  setSessionStream: (sessionPath, stream) =>
    set((s) => ({
      sessionStreams: putSessionScopedValue(s, s.sessionStreams, sessionPath, stream),
    })),
  removeSessionStream: (sessionPath) =>
    set((s) => {
      return { sessionStreams: deleteSessionScopedValue(s, s.sessionStreams, sessionPath) };
    }),
  setPendingNewSession: (pending) => set({ pendingNewSession: pending }),
  setPendingProjectId: (projectId) => set({ pendingProjectId: projectId }),
  setPendingNewSessionThinkingLevel: (level) => set({ pendingNewSessionThinkingLevel: level }),
  setPendingNewSessionPermissionMode: (mode) => {
    if (mode === null) {
      set({ pendingNewSessionPermissionMode: null });
      return;
    }
    const normalized = normalizeSessionPermissionMode(mode);
    set({ pendingNewSessionPermissionMode: normalized, sessionPermissionMode: normalized });
  },
  setSessionPermissionMode: (mode) => {
    const normalized = normalizeSessionPermissionMode(mode);
    set((s) => ({
      sessionPermissionMode: normalized,
      ...(s.pendingNewSession ? { pendingNewSessionPermissionMode: normalized } : {}),
    }));
  },
  setMemoryEnabled: (enabled) => set({ memoryEnabled: enabled }),
  // 兼容：旧调用方仍可用，写入当前 session
  setSessionTodos: (todos) =>
    set((s) => {
      const path = s.currentSessionPath;
      if (!path) return { sessionTodos: todos };
      return {
        sessionTodos: todos,
        todosBySession: putSessionScopedValue(s, s.todosBySession, path, todos),
      };
    }),
  // 新 API：指定 session path
  setSessionTodosForPath: (sessionPath, todos) =>
    set((s) => ({
      todosBySession: putSessionScopedValue(s, s.todosBySession, sessionPath, todos),
      // 如果写入的是当前 session，同步更新兼容字段
      sessionTodos: s.currentSessionPath === sessionPath ? todos : s.sessionTodos,
    })),
  setSessionAuthorizedFolders: (sessionPath, folders) =>
    set((s) => ({
      sessionAuthorizedFoldersByPath: putSessionScopedValue(
        s,
        s.sessionAuthorizedFoldersByPath,
        sessionPath,
        Array.isArray(folders) ? folders : [],
      ),
    })),
  bumpTodosLiveVersion: (sessionPath) =>
    set((s) => {
      const key = sessionScopedKey(s, sessionPath) || sessionPath;
      return {
        todosLiveVersionBySession: putSessionScopedValue(
          s,
          s.todosLiveVersionBySession,
          sessionPath,
          (s.todosLiveVersionBySession[key] ?? s.todosLiveVersionBySession[sessionPath] ?? 0) + 1,
        ),
      };
    }),
  setSessionCapabilityRefreshing: (sessionPath, refreshing) =>
    set((s) => ({
      capabilityRefreshingSessions: refreshing
        ? putSessionScopedListValue(s, s.capabilityRefreshingSessions, sessionPath)
        : deleteSessionScopedListValue(s, s.capabilityRefreshingSessions, sessionPath),
    })),
  setPendingSessionConfirmation: (sessionPath, block) =>
    set((s) => {
      const path = typeof sessionPath === 'string' ? sessionPath.trim() : '';
      if (!path) return {};
      const key = sessionScopedKey(s, path) || path;
      const next = { ...s.pendingSessionConfirmationsByPath };
      if (block?.status === 'pending') {
        next[key] = block;
        if (key !== path) delete next[path];
      } else {
        delete next[key];
        delete next[path];
      }
      return { pendingSessionConfirmationsByPath: next };
    }),
  resolvePendingSessionConfirmation: (confirmId) =>
    set((s) => {
      const id = typeof confirmId === 'string' ? confirmId.trim() : '';
      if (!id) return {};
      let changed = false;
      const next = { ...s.pendingSessionConfirmationsByPath };
      for (const [sessionPath, block] of Object.entries(next)) {
        if (block.confirmId !== id) continue;
        delete next[sessionPath];
        changed = true;
      }
      return changed ? { pendingSessionConfirmationsByPath: next } : {};
    }),
  setSessionMetaRecovery: (status) => set({ metaRecovery: status }),
});
