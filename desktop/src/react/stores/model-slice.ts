import type { Model } from '../types';

export type ThinkingLevel = 'off' | 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const DEFAULT_THINKING_LEVELS: ThinkingLevel[] = ['off', 'medium', 'high'];

export function normalizeThinkingLevel(level: ThinkingLevel): ThinkingLevel {
  if (level === 'auto') return 'medium';
  if (level === 'xhigh') return 'max';
  return level;
}

export function normalizeThinkingLevels(levels: readonly ThinkingLevel[] | null | undefined): ThinkingLevel[] | null {
  if (!Array.isArray(levels)) return null;
  const normalized: ThinkingLevel[] = [];
  for (const rawLevel of levels) {
    const level = normalizeThinkingLevel(rawLevel);
    if (!normalized.includes(level)) normalized.push(level);
  }
  return normalized.length > 0 ? normalized : null;
}

export function getModelThinkingLevels(model: { thinkingLevels?: readonly ThinkingLevel[]; xhigh?: boolean } | null | undefined): ThinkingLevel[] {
  const explicit = normalizeThinkingLevels(model?.thinkingLevels);
  if (explicit) return explicit;
  return model?.xhigh ? [...DEFAULT_THINKING_LEVELS, 'max'] : [...DEFAULT_THINKING_LEVELS];
}

export interface ModelSlice {
  models: Model[];
  currentModel: { id: string; provider: string } | null;
  thinkingLevel: ThinkingLevel;
  setModels: (models: Model[]) => void;
  setCurrentModel: (model: { id: string; provider: string } | null) => void;
  setThinkingLevel: (level: ThinkingLevel) => void;
}

export const createModelSlice = (
  set: (partial: Partial<ModelSlice>) => void
): ModelSlice => ({
  models: [],
  currentModel: null,
  thinkingLevel: 'medium',
  setModels: (models) => set({ models }),
  setCurrentModel: (model) => set({ currentModel: model }),
  setThinkingLevel: (level) => set({ thinkingLevel: normalizeThinkingLevel(level) }),
});
