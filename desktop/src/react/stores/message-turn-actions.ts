import { useStore } from './index';
import {
  sessionIdForPathFromLocatorState,
  sessionScopedListIncludes,
} from './session-slice';
import { loadSessions, switchSession } from './session-actions';
import type { ChatMessage } from './chat-types';
import { lucFetch } from '../hooks/use-luc-fetch';
import { collectUiContext } from '../utils/ui-context';
import { errorWithCode, presentError } from '../errors/error-presenter';
import { errorCodeFromResponseBody } from '../../../../shared/error-user-messages.ts';
import type { Session } from '../types';

export type SessionNodeTarget =
  | { role: 'user'; entryId: string }
  | { role: 'assistant'; entryId: string }
  | { role: 'assistant_turn'; turnInputEntryId: string };

export interface ForkedSessionRef {
  sessionId: string;
  sessionPath: string;
  agentId: string | null;
}

export type ForkedSessionHandler = (forked: ForkedSessionRef) => void | Promise<void>;

const SESSION_NODE_ACTION_TIMEOUT_MS = 30 * 60 * 1000;

interface RetrySessionTurnOptions {
  message?: ChatMessage;
  replacementText?: string;
}

function resolveSessionIdentity(sessionPath: string): { sessionId: string; sessionPath: string } {
  const state = useStore.getState();
  const sessionId = sessionIdForPathFromLocatorState(state, sessionPath);
  if (!sessionId) {
    throw new Error(`Cannot run session node action without sessionId for ${sessionPath}`);
  }
  return { sessionId, sessionPath };
}

function reportActionError(sessionPath: string, error: unknown): void {
  useStore.getState().setInlineError?.(sessionPath, presentError(error), 6000);
}

async function readSessionActionResponse(response: Response, fallback: string): Promise<any> {
  let data: any = null;
  try {
    data = await response.json();
  } catch {
    // The status fallback below remains actionable when a proxy returns no JSON.
  }
  if (!response.ok) {
    const detail = typeof data?.error === 'string' && data.error.trim()
      ? data.error.trim()
      : typeof data?.reason === 'string' && data.reason.trim()
        ? data.reason.trim()
        : `${response.status} ${response.statusText || fallback}`.trim();
    // 错误码跟着异常走，由呈现层翻成人话；这里不再把 code 拼进 message 字符串。
    throw errorWithCode(detail, errorCodeFromResponseBody(data));
  }
  return data;
}

function displayMessageEnvelope(message: ChatMessage, replacementText?: string) {
  return {
    text: replacementText ?? message.text ?? '',
    quotedText: message.quotedText,
    attachments: message.attachments,
    skills: message.skills,
    deskContext: message.deskContext ?? null,
  };
}

export async function retrySessionTurn(
  sessionPath: string,
  target: SessionNodeTarget,
  options: RetrySessionTurnOptions = {},
): Promise<boolean> {
  if (!sessionPath) return false;

  try {
    const state = useStore.getState();
    if (sessionScopedListIncludes(state, state.streamingSessions, sessionPath)) return false;
    const identity = resolveSessionIdentity(sessionPath);
    const { message, replacementText } = options;

    const response = await lucFetch('/api/sessions/turns/retry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      timeout: SESSION_NODE_ACTION_TIMEOUT_MS,
      throwOnHttpError: false,
      body: JSON.stringify({
        ...identity,
        target,
        ...(message?.id ? { clientMessageId: message.id } : {}),
        ...(replacementText !== undefined ? { text: replacementText } : {}),
        uiContext: collectUiContext(state),
        ...(message ? { displayMessage: displayMessageEnvelope(message, replacementText) } : {}),
      }),
    });
    await readSessionActionResponse(response, 'Retry failed');
    return true;
  } catch (error) {
    reportActionError(sessionPath, error);
    return false;
  }
}

export async function forkSessionTurn(
  sessionPath: string,
  target: SessionNodeTarget,
): Promise<ForkedSessionRef | null> {
  if (!sessionPath) return null;

  try {
    const state = useStore.getState();
    if (sessionScopedListIncludes(state, state.streamingSessions, sessionPath)) return null;
    const identity = resolveSessionIdentity(sessionPath);
    const response = await lucFetch('/api/sessions/fork', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      timeout: SESSION_NODE_ACTION_TIMEOUT_MS,
      throwOnHttpError: false,
      body: JSON.stringify({ ...identity, target }),
    });
    const data = await readSessionActionResponse(response, 'Fork failed');
    const sessionId = typeof data?.sessionId === 'string' && data.sessionId.trim()
      ? data.sessionId.trim()
      : null;
    const childPath = typeof data?.sessionPath === 'string' && data.sessionPath.trim()
      ? data.sessionPath
      : (typeof data?.path === 'string' && data.path.trim() ? data.path : null);
    if (!sessionId || !childPath) {
      throw new Error(data?.error || 'Fork response is missing sessionId or sessionPath');
    }
    return {
      sessionId,
      sessionPath: childPath,
      agentId: typeof data?.agentId === 'string' && data.agentId.trim() ? data.agentId : null,
    };
  } catch (error) {
    reportActionError(sessionPath, error);
    return null;
  }
}

export async function activateForkedSession(forked: ForkedSessionRef): Promise<void> {
  useStore.setState((state) => {
    const sessions = state.sessions || [];
    const existingIndex = sessions.findIndex((session) => (
      session?.sessionId === forked.sessionId || session?.path === forked.sessionPath
    ));
    const existing = existingIndex >= 0 ? sessions[existingIndex] : null;
    const projection: Session = {
      title: null,
      firstMessage: '',
      modified: new Date().toISOString(),
      messageCount: 0,
      agentName: null,
      cwd: null,
      ...(existing || {}),
      sessionId: forked.sessionId,
      path: forked.sessionPath,
      agentId: forked.agentId || existing?.agentId || null,
      _optimistic: true,
    };
    const nextSessions = existingIndex >= 0
      ? sessions.map((session, index) => (index === existingIndex ? projection : session))
      : [projection, ...sessions];
    return {
      sessions: nextSessions,
      sessionLocatorsById: {
        ...(state.sessionLocatorsById || {}),
        [forked.sessionId]: { path: forked.sessionPath },
      },
    };
  });
  await loadSessions();
  await switchSession(forked.sessionPath);
}
