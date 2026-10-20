import { sessionScopedKey, sessionScopedListIncludes, type SessionLocatorState } from './session-slice';

export interface ContextSlice {
  /** Context usage — token count for the current session */
  contextTokens: number | null;
  contextWindow: number | null;
  contextPercent: number | null;
  /** 按 session identity key 存储的 context usage（读旧 path key 兼容） */
  contextBySession: Record<string, { tokens: number | null; window: number | null; percent: number | null }>;
  /** Session identity keys currently undergoing compaction */
  compactingSessions: string[];
  /** Compaction mode for each busy session, keyed by session identity. */
  compactionModeBySession: Record<string, string>;
  addCompactingSession: (path: string, mode?: string | null) => void;
  removeCompactingSession: (path: string) => void;
}

export const createContextSlice = (
  set: (partial: Partial<ContextSlice> | ((s: ContextSlice) => Partial<ContextSlice>)) => void
): ContextSlice => ({
  contextTokens: null,
  contextWindow: null,
  contextPercent: null,
  contextBySession: {},
  compactingSessions: [],
  compactionModeBySession: {},
  addCompactingSession: (path, mode) => set((s) => {
    const key = sessionScopedKey(s as ContextSlice & SessionLocatorState, path) || path;
    const compactingSessions = s.compactingSessions.filter((item) => item !== key && item !== path);
    const compactionModeBySession = { ...s.compactionModeBySession };
    const normalizedMode = typeof mode === 'string' && mode.trim() ? mode.trim() : null;
    const existingMode = compactionModeBySession[key] || compactionModeBySession[path];
    delete compactionModeBySession[key];
    delete compactionModeBySession[path];
    if (normalizedMode || existingMode) {
      compactionModeBySession[key] = normalizedMode || existingMode;
    }
    return { compactingSessions: [...compactingSessions, key], compactionModeBySession };
  }),
  removeCompactingSession: (path) => set((s) => {
    const key = sessionScopedKey(s as ContextSlice & SessionLocatorState, path) || path;
    const compactionModeBySession = { ...s.compactionModeBySession };
    delete compactionModeBySession[key];
    delete compactionModeBySession[path];
    return {
      compactingSessions: s.compactingSessions.filter(p => p !== key && p !== path),
      compactionModeBySession,
    };
  }),
});

// ── Selectors ──
export const selectContextTokens = (s: ContextSlice) => s.contextTokens;
export const selectContextWindow = (s: ContextSlice) => s.contextWindow;
export const selectContextPercent = (s: ContextSlice) => s.contextPercent;

export function isSessionCompacting(
  state: ContextSlice & SessionLocatorState,
  sessionPath: string | null | undefined,
): boolean {
  return sessionScopedListIncludes(state, state.compactingSessions, sessionPath);
}

export function getSessionCompactionMode(
  state: ContextSlice & SessionLocatorState,
  sessionPath: string | null | undefined,
): string | null {
  if (!sessionPath || !isSessionCompacting(state, sessionPath)) return null;
  const key = sessionScopedKey(state, sessionPath);
  if (key && Object.prototype.hasOwnProperty.call(state.compactionModeBySession, key)) {
    return state.compactionModeBySession[key] || null;
  }
  return state.compactionModeBySession[sessionPath] || null;
}
