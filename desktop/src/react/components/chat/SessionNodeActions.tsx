import { useCallback, useRef, useState } from 'react';
import type { ChatMessage } from '../../stores/chat-types';
import { useStore } from '../../stores';
import {
  activateForkedSession,
  forkSessionTurn,
  retrySessionTurn,
  type ForkedSessionHandler,
  type SessionNodeTarget,
} from '../../stores/message-turn-actions';
import { presentError } from '../../errors/error-presenter';
import type { MessageFooterAction } from './MessageFooterActions';

interface Options {
  sessionPath: string;
  target: SessionNodeTarget | null;
  retryMessage?: ChatMessage;
  onForkCreated?: ForkedSessionHandler;
  disabled?: boolean;
}

export function useSessionNodeActions({
  sessionPath,
  target,
  retryMessage,
  onForkCreated,
  disabled = false,
}: Options): { actions: MessageFooterAction[]; busy: boolean } {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const t = window.t ?? ((key: string) => key);

  const handleRetry = useCallback(async () => {
    if (!target || busyRef.current || disabled) return;
    busyRef.current = true;
    setBusy(true);
    try {
      if (retryMessage) {
        await retrySessionTurn(sessionPath, target, { message: retryMessage });
      } else {
        await retrySessionTurn(sessionPath, target);
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [disabled, retryMessage, sessionPath, target]);

  const handleFork = useCallback(async () => {
    if (!target || busyRef.current || disabled) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const forked = await forkSessionTurn(sessionPath, target);
      if (!forked) return;
      await (onForkCreated || activateForkedSession)(forked);
      if (target.role === 'user' && retryMessage) {
        await retrySessionTurn(forked.sessionPath, target, { message: retryMessage });
      }
    } catch (error) {
      useStore.getState().setInlineError?.(sessionPath, presentError(error), 6000);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [disabled, onForkCreated, retryMessage, sessionPath, target]);

  const actions: MessageFooterAction[] = target ? [
    {
      id: 'regenerate',
      title: t('common.regenerate'),
      icon: <RegenerateIcon />,
      onClick: () => { void handleRetry(); },
      disabled: disabled || busy,
    },
    {
      id: 'fork-session',
      title: t('common.forkSession'),
      icon: <ForkIcon />,
      onClick: () => { void handleFork(); },
      disabled: disabled || busy,
    },
  ] : [];

  return { actions, busy };
}

function RegenerateIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 3v5m0 0h-5m5 0-3-2.708A9 9 0 1 0 20.777 14" />
    </svg>
  );
}

function ForkIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 512 512" fill="currentColor" aria-hidden="true">
      <path d="M124,166.291V345.709a76,76,0,1,0,32,0V282H308a80.091,80.091,0,0,0,80-80V165.311a75.983,75.983,0,1,0-32,1.733V202a48.055,48.055,0,0,1-48,48H156V166.291a76,76,0,1,0-32,0ZM324,92a44,44,0,1,1,44,44A44.049,44.049,0,0,1,324,92ZM184,420a44,44,0,1,1-44-44A44.049,44.049,0,0,1,184,420ZM140,48A44,44,0,1,1,96,92,44.049,44.049,0,0,1,140,48Z" />
    </svg>
  );
}
