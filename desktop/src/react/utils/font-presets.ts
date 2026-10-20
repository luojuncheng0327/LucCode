export const DEFAULT_READING_FONT_PRESET_ID = 'serif' as const;
export const FOLLOW_READING_FONT_ID = 'follow' as const;
export const READING_FONT_STORAGE_KEY = 'luc-font-serif' as const;
export const SCREENSHOT_FONT_STORAGE_KEY = 'luc-screenshot-font' as const;

export type FontPresetId = 'serif' | 'sans';
export type FontSelectionId = FontPresetId | typeof FOLLOW_READING_FONT_ID;

export interface FontPreset {
  id: FontPresetId;
  labelKey: string;
  descriptionKey: string;
  fontFamily: string;
  cssVariableFamily: string;
}

export const READING_FONT_PRESETS: FontPreset[] = [
  {
    id: 'serif',
    labelKey: 'settings.fonts.serifName',
    descriptionKey: 'settings.fonts.serifDesc',
    fontFamily: "'EB Garamond', 'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', 'STSong', serif",
    cssVariableFamily: "'EB Garamond', 'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', 'STSong', serif",
  },
  {
    id: 'sans',
    labelKey: 'settings.fonts.sansName',
    descriptionKey: 'settings.fonts.sansDesc',
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', 'PingFang SC', 'Microsoft YaHei', sans-serif",
    cssVariableFamily: 'var(--font-ui)',
  },
];

const FONT_PRESET_IDS = new Set<FontPresetId>(READING_FONT_PRESETS.map(preset => preset.id));

export function normalizeFontPresetId(
  value: unknown,
  fallback: FontPresetId = DEFAULT_READING_FONT_PRESET_ID,
): FontPresetId {
  return typeof value === 'string' && FONT_PRESET_IDS.has(value as FontPresetId)
    ? value as FontPresetId
    : fallback;
}

export function normalizeFontSelectionId(
  value: unknown,
  options: { allowFollow?: boolean; fallback?: FontSelectionId } = {},
): FontSelectionId {
  const fallback = options.fallback ?? DEFAULT_READING_FONT_PRESET_ID;
  if (options.allowFollow && value === FOLLOW_READING_FONT_ID) return FOLLOW_READING_FONT_ID;
  if (options.allowFollow && fallback === FOLLOW_READING_FONT_ID && !FONT_PRESET_IDS.has(value as FontPresetId)) {
    return FOLLOW_READING_FONT_ID;
  }
  return normalizeFontPresetId(value, fallback === FOLLOW_READING_FONT_ID ? DEFAULT_READING_FONT_PRESET_ID : fallback);
}

export function fontPresetIdFromSerif(enabled: boolean): FontPresetId {
  return enabled ? 'serif' : 'sans';
}

export function serifFromFontPresetId(id: FontPresetId): boolean {
  return id === 'serif';
}

export function getFontPreset(id: FontPresetId): FontPreset {
  return READING_FONT_PRESETS.find(preset => preset.id === id) ?? READING_FONT_PRESETS[0];
}

export function getFontFamilyForPreset(id: FontPresetId): string {
  return getFontPreset(id).fontFamily;
}

export function getCssVariableFontFamilyForPreset(id: FontPresetId): string {
  return getFontPreset(id).cssVariableFamily;
}

export function readReadingFontPresetId(storage: Pick<Storage, 'getItem'> = localStorage): FontPresetId {
  return fontPresetIdFromSerif(storage.getItem(READING_FONT_STORAGE_KEY) !== '0');
}

export function readScreenshotFontSelectionId(
  storage: Pick<Storage, 'getItem'> = localStorage,
): FontSelectionId {
  return normalizeFontSelectionId(storage.getItem(SCREENSHOT_FONT_STORAGE_KEY), {
    allowFollow: true,
    fallback: FOLLOW_READING_FONT_ID,
  });
}

export function resolveSurfaceFontPresetId(
  selection: FontSelectionId,
  readingFont: FontPresetId,
): FontPresetId {
  return selection === FOLLOW_READING_FONT_ID ? readingFont : selection;
}

export function resolveScreenshotFontFamily(storage: Pick<Storage, 'getItem'> = localStorage): string {
  const readingFont = readReadingFontPresetId(storage);
  const screenshotFont = readScreenshotFontSelectionId(storage);
  return getFontFamilyForPreset(resolveSurfaceFontPresetId(screenshotFont, readingFont));
}
