import type { StoreState } from './index';
import { sessionScopedListIncludes, sessionScopedValue, type SessionLocatorState } from './session-slice';

type SelectionState = SessionLocatorState & Pick<StoreState, 'selectedIdsBySession'>;
type StreamingState = SessionLocatorState & Pick<StoreState, 'streamingSessions'>;

export const EMPTY_SELECTED_IDS = Object.freeze([]) as readonly string[];

export function selectSelectedIdsBySession(
  state: SelectionState,
  sessionPath: string | null | undefined,
): readonly string[] {
  if (!sessionPath) return EMPTY_SELECTED_IDS;
  return sessionScopedValue(state, state.selectedIdsBySession, sessionPath) ?? EMPTY_SELECTED_IDS;
}

export function selectIsStreamingSession(
  state: StreamingState,
  sessionPath: string | null | undefined,
): boolean {
  return sessionScopedListIncludes(state, state.streamingSessions, sessionPath);
}
