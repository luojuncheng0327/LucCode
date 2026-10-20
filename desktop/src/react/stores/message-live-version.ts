const _messageLiveVersionBySession: Record<string, number> = {};

let _resolveMessageLiveSessionKey: ((sessionPath: string) => string | null | undefined) | null = null;

export function configureMessageLiveVersionSessionKeyResolver(
  resolver: ((sessionPath: string) => string | null | undefined) | null,
): void {
  _resolveMessageLiveSessionKey = typeof resolver === 'function' ? resolver : null;
}

function messageLiveSessionKey(sessionPath: string): string {
  return _resolveMessageLiveSessionKey?.(sessionPath) || sessionPath;
}

export function readMessageLiveVersion(sessionPath: string): number {
  const key = messageLiveSessionKey(sessionPath);
  return _messageLiveVersionBySession[key] ?? _messageLiveVersionBySession[sessionPath] ?? 0;
}

export function bumpMessageLiveVersion(sessionPath: string): number {
  const key = messageLiveSessionKey(sessionPath);
  const next = (_messageLiveVersionBySession[key] ?? _messageLiveVersionBySession[sessionPath] ?? 0) + 1;
  _messageLiveVersionBySession[key] = next;
  if (key !== sessionPath) delete _messageLiveVersionBySession[sessionPath];
  return next;
}

export function clearMessageLiveVersion(sessionPath?: string): void {
  if (sessionPath == null) {
    for (const key of Object.keys(_messageLiveVersionBySession)) {
      delete _messageLiveVersionBySession[key];
    }
    return;
  }
  const key = messageLiveSessionKey(sessionPath);
  delete _messageLiveVersionBySession[key];
  if (key !== sessionPath) delete _messageLiveVersionBySession[sessionPath];
}
