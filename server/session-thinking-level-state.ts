import {
  getModelThinkingLevels,
  normalizeSessionThinkingLevel,
  normalizeThinkingLevelForModel,
} from "../core/session-thinking-level.ts";

function resolveTargetModel(engine: any, {
  pendingNewSession = false,
  sessionPath = null,
}: { pendingNewSession?: boolean; sessionPath?: string | null } = {}) {
  if (pendingNewSession) return engine.currentModel || null;
  if (sessionPath) {
    return engine.getSessionByPath?.(sessionPath)?.model
      || engine.activeSessionModel
      || engine.currentModel
      || null;
  }
  return engine.activeSessionModel || engine.currentModel || null;
}

function readThinkingLevel(engine: any, {
  pendingNewSession = false,
  sessionPath = null,
}: { pendingNewSession?: boolean; sessionPath?: string | null } = {}) {
  if (pendingNewSession) {
    return engine.getDefaultThinkingLevel?.()
      || engine.getThinkingLevel?.()
      || "medium";
  }
  if (sessionPath) {
    return engine.getSessionThinkingLevel?.(sessionPath)
      || engine.getDefaultThinkingLevel?.()
      || engine.getThinkingLevel?.()
      || "medium";
  }
  return engine.getSessionThinkingLevel?.()
    || engine.getDefaultThinkingLevel?.()
    || engine.getThinkingLevel?.()
    || "medium";
}

export function resolveSessionThinkingLevelState(engine: any, options: {
  pendingNewSession?: boolean;
  sessionPath?: string | null;
} = {}) {
  const targetModel = resolveTargetModel(engine, options);
  const requestedLevel = normalizeSessionThinkingLevel(readThinkingLevel(engine, options));
  return {
    thinkingLevel: normalizeThinkingLevelForModel(requestedLevel, targetModel),
    thinkingLevels: targetModel ? getModelThinkingLevels(targetModel) : null,
  };
}
