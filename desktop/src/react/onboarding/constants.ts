/**
 * constants.ts — Onboarding wizard constants
 */

import { API_PROVIDER_PRESETS } from '../utils/provider-presets';
import type { ProviderPreset } from '../utils/provider-presets';

export type { ProviderPreset } from '../utils/provider-presets';

export const TOTAL_STEPS = 6;

export const LOCALES = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'ja',    label: '日本語' },
  { value: 'ko',    label: '한국어' },
  { value: 'en',    label: 'English' },
] as const;

export const PROVIDER_PRESETS: ProviderPreset[] = [
  ...API_PROVIDER_PRESETS,
  { value: '_custom',     label: '',                     url: '',  api: 'openai-completions', custom: true },
];
