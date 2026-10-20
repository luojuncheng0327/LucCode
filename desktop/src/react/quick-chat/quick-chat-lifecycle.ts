interface QuickChatIdleResetInput {
  lastHiddenAt: number | null;
  now: number;
  reuseTimeoutMinutes: number;
  isStreaming: boolean;
}

export function shouldResetQuickChatSessionAfterIdle({
  lastHiddenAt,
  now,
  reuseTimeoutMinutes,
  isStreaming,
}: QuickChatIdleResetInput): boolean {
  if (isStreaming) return false;
  if (!Number.isFinite(lastHiddenAt) || lastHiddenAt === null) return false;
  const timeoutMs = Math.max(0, reuseTimeoutMinutes) * 60 * 1000;
  return Math.max(0, now - lastHiddenAt) >= timeoutMs;
}
