export interface ThinkingModelLike {
  id?: string;
  provider?: string;
  reasoning?: boolean;
  thinkingLevels?: string[];
  quirks?: string[];
  compat?: {
    thinkingFormat?: string;
  };
}

export function shouldShowThinkingControl(
  currentModel: ThinkingModelLike | null | undefined,
  models: readonly ThinkingModelLike[] = [],
): boolean {
  if (!currentModel) return true;
  if (currentModel.reasoning !== false) return true;
  return hasControllableThinking(currentModel) || hasControllableThinking(findFullModel(currentModel, models));
}

function hasControllableThinking(model: ThinkingModelLike | null | undefined): boolean {
  if (!model) return false;
  if (Array.isArray(model.thinkingLevels) && model.thinkingLevels.some(level => level && level !== 'off')) return true;
  if (Array.isArray(model.quirks) && model.quirks.includes('enable_thinking')) return true;
  return model.compat?.thinkingFormat === 'qwen' || model.compat?.thinkingFormat === 'qwen-chat-template';
}

function findFullModel(
  currentModel: ThinkingModelLike,
  models: readonly ThinkingModelLike[],
): ThinkingModelLike | undefined {
  return models.find((model) => {
    if (!model?.id || model.id !== currentModel.id) return false;
    if (currentModel.provider && model.provider && model.provider !== currentModel.provider) return false;
    return true;
  });
}
