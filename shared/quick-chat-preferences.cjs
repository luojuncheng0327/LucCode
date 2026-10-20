const DEFAULT_QUICK_CHAT_SHORTCUT = "Alt+Space";
const DEFAULT_QUICK_CHAT_REUSE_TIMEOUT_MINUTES = 10;
const MAX_QUICK_CHAT_REUSE_TIMEOUT_MINUTES = 120;

function normalizeShortcutPart(value) {
  const raw = String(value ?? "");
  if ((raw === " " || raw === "\u00A0" || raw === "Spacebar") || (raw.length > 0 && raw.trim() === "")) {
    return "Space";
  }
  const trimmed = raw.trim();
  if (trimmed === "CmdOrCtrl" || trimmed === "CommandOrCtrl" || trimmed === "CtrlOrCommand") {
    return "CommandOrControl";
  }
  if (trimmed === "Esc") return "Escape";
  if (trimmed === "Spacebar") return "Space";
  return trimmed;
}

function normalizeShortcut(value) {
  if (typeof value !== "string") return DEFAULT_QUICK_CHAT_SHORTCUT;
  const raw = value.trim();
  if (!raw) return DEFAULT_QUICK_CHAT_SHORTCUT;
  const parts = raw.split("+").map(normalizeShortcutPart);
  if (parts.some((part) => !part)) return DEFAULT_QUICK_CHAT_SHORTCUT;
  return parts.join("+");
}

function normalizeReuseTimeoutMinutes(value) {
  if (value === null || value === undefined || value === "") return DEFAULT_QUICK_CHAT_REUSE_TIMEOUT_MINUTES;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_QUICK_CHAT_REUSE_TIMEOUT_MINUTES;
  return Math.max(0, Math.min(MAX_QUICK_CHAT_REUSE_TIMEOUT_MINUTES, Math.round(numeric)));
}

function normalizeQuickChatPreferences(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    shortcut: normalizeShortcut(source.shortcut),
    reuseTimeoutMinutes: normalizeReuseTimeoutMinutes(source.reuseTimeoutMinutes ?? source.reuse_timeout_minutes),
  };
}

function mergeQuickChatPreferences(existing = {}, patch = {}) {
  return normalizeQuickChatPreferences({
    ...normalizeQuickChatPreferences(existing),
    ...(patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {}),
  });
}

module.exports = {
  DEFAULT_QUICK_CHAT_SHORTCUT,
  DEFAULT_QUICK_CHAT_REUSE_TIMEOUT_MINUTES,
  normalizeQuickChatPreferences,
  mergeQuickChatPreferences,
};
