export type ChatLayoutContentWidth = 640 | 720 | 800 | 'unlimited';
export type ChatBodyFontSizeOffset = -2 | -1 | 0 | 1 | 2;

export interface ChatLayoutPreferences {
  contentWidth: ChatLayoutContentWidth;
  bodyFontSizeOffset: ChatBodyFontSizeOffset;
}

export const DEFAULT_CHAT_LAYOUT: ChatLayoutPreferences = Object.freeze({
  contentWidth: 720,
  bodyFontSizeOffset: 0,
});

const CONTENT_WIDTH_PRESETS = new Set([640, 720, 800]);
const BODY_FONT_SIZE_OFFSETS = new Set([-2, -1, 0, 1, 2]);
const BODY_FONT_SIZE_BASE = 15;
const UNLIMITED_CONTENT_WIDTH = 'unlimited';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim()) return Number(value);
  return NaN;
}

function normalizeContentWidth(value: unknown, fallback: ChatLayoutContentWidth): ChatLayoutContentWidth {
  if (value === UNLIMITED_CONTENT_WIDTH) return UNLIMITED_CONTENT_WIDTH;
  const parsed = readNumber(value);
  return CONTENT_WIDTH_PRESETS.has(parsed) ? parsed as ChatLayoutContentWidth : fallback;
}

function normalizeBodyFontSizeOffset(value: unknown, fallback: ChatBodyFontSizeOffset): ChatBodyFontSizeOffset {
  const parsed = readNumber(value);
  return BODY_FONT_SIZE_OFFSETS.has(parsed) ? parsed as ChatBodyFontSizeOffset : fallback;
}

export function normalizeChatLayout(value: unknown): ChatLayoutPreferences {
  const source = isRecord(value) ? value : {};
  return {
    contentWidth: normalizeContentWidth(source.contentWidth, DEFAULT_CHAT_LAYOUT.contentWidth),
    bodyFontSizeOffset: normalizeBodyFontSizeOffset(source.bodyFontSizeOffset, DEFAULT_CHAT_LAYOUT.bodyFontSizeOffset),
  };
}

export function mergeChatLayout(base: unknown, patch: unknown): ChatLayoutPreferences {
  const current = normalizeChatLayout(base);
  const source = isRecord(patch) ? patch : {};
  return normalizeChatLayout({
    ...current,
    ...source,
  });
}

export function applyChatLayout(
  value: unknown,
  root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement,
): ChatLayoutPreferences {
  const layout = normalizeChatLayout(value);
  if (!root?.style) return layout;

  if (layout.contentWidth === 'unlimited') {
    root.style.setProperty('--chat-column-width', 'none');
    root.style.setProperty('--chat-input-column-width', 'none');
  } else {
    root.style.setProperty('--chat-column-width', `${layout.contentWidth}px`);
    root.style.setProperty('--chat-input-column-width', 'calc(var(--chat-column-width) + var(--chat-input-column-extra))');
  }
  root.style.setProperty('--chat-message-font-size', `${BODY_FONT_SIZE_BASE + layout.bodyFontSizeOffset}px`);

  return layout;
}
