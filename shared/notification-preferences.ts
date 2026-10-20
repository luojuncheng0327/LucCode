export type ChatCompletionNotificationMode = "never" | "when_unfocused" | "when_session_unfocused";
export type BackgroundCompletionNotificationMode = "never" | "when_unfocused" | "always";

export interface NotificationPreferences {
  chatCompletion: ChatCompletionNotificationMode;
  scheduledTaskCompletion: BackgroundCompletionNotificationMode;
  patrolCompletion: BackgroundCompletionNotificationMode;
}

const NEVER = "never" as const;

export const CHAT_COMPLETION_NOTIFICATION_MODES: readonly ChatCompletionNotificationMode[] = Object.freeze([
  NEVER,
  "when_unfocused",
  "when_session_unfocused",
]);

export const BACKGROUND_COMPLETION_NOTIFICATION_MODES: readonly BackgroundCompletionNotificationMode[] = Object.freeze([
  NEVER,
  "when_unfocused",
  "always",
]);

export function normalizeChatCompletionNotificationMode(value: unknown): ChatCompletionNotificationMode {
  return CHAT_COMPLETION_NOTIFICATION_MODES.includes(value as ChatCompletionNotificationMode)
    ? (value as ChatCompletionNotificationMode)
    : NEVER;
}

export function normalizeBackgroundCompletionNotificationMode(value: unknown): BackgroundCompletionNotificationMode {
  return BACKGROUND_COMPLETION_NOTIFICATION_MODES.includes(value as BackgroundCompletionNotificationMode)
    ? (value as BackgroundCompletionNotificationMode)
    : NEVER;
}

export function normalizeNotificationPreferences(value: unknown = {}): NotificationPreferences {
  const source = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const chatCompletion = Object.prototype.hasOwnProperty.call(source, "chatCompletion")
    ? source.chatCompletion
    : source.turnCompletion;
  return {
    chatCompletion: normalizeChatCompletionNotificationMode(chatCompletion),
    scheduledTaskCompletion: normalizeBackgroundCompletionNotificationMode(source.scheduledTaskCompletion),
    patrolCompletion: normalizeBackgroundCompletionNotificationMode(source.patrolCompletion),
  };
}

export function mergeNotificationPreferences(existing: unknown = {}, patch: unknown = {}): NotificationPreferences {
  const patchSource = patch && typeof patch === "object" && !Array.isArray(patch)
    ? (patch as Record<string, unknown>)
    : {};
  const compatiblePatch = !Object.prototype.hasOwnProperty.call(patchSource, "chatCompletion")
    && Object.prototype.hasOwnProperty.call(patchSource, "turnCompletion")
    ? { ...patchSource, chatCompletion: patchSource.turnCompletion }
    : patchSource;
  return normalizeNotificationPreferences({
    ...normalizeNotificationPreferences(existing),
    ...compatiblePatch,
  });
}
