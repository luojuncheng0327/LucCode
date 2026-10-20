import quickChatPreferences from "./quick-chat-preferences.cjs";

export type { QuickChatPreferences } from "./quick-chat-preferences.cjs";

export const {
  DEFAULT_QUICK_CHAT_SHORTCUT,
  DEFAULT_QUICK_CHAT_REUSE_TIMEOUT_MINUTES,
  normalizeQuickChatPreferences,
  mergeQuickChatPreferences,
} = quickChatPreferences;
