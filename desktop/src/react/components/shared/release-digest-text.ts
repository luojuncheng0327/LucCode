import type { LocalizedReleaseText, ReleaseDigestItem } from '../../types';

const t = (key: string, vars?: Record<string, string | number>) => window.t?.(key, vars) ?? key;

export function digestLocale(): keyof LocalizedReleaseText {
  const lang = (document.documentElement.lang || navigator.language || '').toLowerCase();
  return lang.startsWith('zh') ? 'zh' : 'en';
}

export function digestText(value: LocalizedReleaseText | undefined, locale: keyof LocalizedReleaseText): string {
  if (!value) return '';
  return value[locale] || value.en || value.zh || '';
}

export function kindLabel(kind: ReleaseDigestItem['kind']): string {
  return t(`settings.about.updateDigestKind.${kind}`);
}
