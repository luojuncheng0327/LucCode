const DEFAULT_REASONING_BUFFER_TOKENS = 1024;

function positiveInteger(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function resolvedModelObject(resolvedModel) {
  if (resolvedModel?.model && typeof resolvedModel.model === "object") return resolvedModel.model;
  return resolvedModel && typeof resolvedModel === "object" ? resolvedModel : null;
}

function isReasoningModel(model) {
  return model?.reasoning === true
    || !!model?.reasoningProfile
    || !!model?.compat?.thinkingFormat
    || !!model?.compat?.reasoningProfile;
}

export function withMemoryReasoningBuffer(visibleMaxTokens, resolvedModel, opts: Record<string, any> = {}) {
  const visible = positiveInteger(visibleMaxTokens);
  if (!visible) return visibleMaxTokens;

  const model = resolvedModelObject(resolvedModel);
  if (!isReasoningModel(model)) return visible;

  const buffer = positiveInteger(opts.reasoningBufferTokens) || DEFAULT_REASONING_BUFFER_TOKENS;
  const requested = visible + buffer;
  const modelLimit = positiveInteger(model?.maxTokens || model?.maxOutput);
  if (!modelLimit) return requested;
  return Math.max(visible, Math.min(modelLimit, requested));
}
