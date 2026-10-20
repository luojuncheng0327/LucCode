import { lookupKnown } from "../shared/known-models.ts";

export const DEFAULT_SESSION_THINKING_LEVEL = "medium";
const VALID_THINKING_LEVELS = new Set(["off", "low", "medium", "high", "xhigh", "max"]);
const DEFAULT_VISIBLE_THINKING_LEVELS = ["off", "medium", "high"];
const OPENAI_XHIGH_MODEL_MARKERS = [
  "gpt-5.2",
  "gpt-5.3",
  "gpt-5.4",
  "gpt-5.5",
];
const ANTHROPIC_MAX_EFFORT_MODEL_MARKERS = [
  "opus-5",
  "sonnet-5",
  "fable-5",
  "mythos-5",
  "opus-4-6",
  "opus-4.6",
  "opus-4-7",
  "opus-4.7",
  "sonnet-4-6",
  "sonnet-4.6",
];

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function canonicalThinkingLevel(level) {
  const normalized = lower(level);
  if (normalized === "auto") return "medium";
  if (normalized === "ultracode") return "max";
  return VALID_THINKING_LEVELS.has(normalized) ? normalized : null;
}

function visibleThinkingLevel(level) {
  const normalized = canonicalThinkingLevel(level);
  if (!normalized) return null;
  return normalized === "xhigh" ? "max" : normalized;
}

export function normalizeThinkingLevelChoices(levels) {
  if (!Array.isArray(levels)) return null;
  const out = [];
  for (const rawLevel of levels) {
    const normalized = visibleThinkingLevel(rawLevel);
    if (!normalized || out.includes(normalized)) continue;
    out.push(normalized);
  }
  return out.length > 0 ? out : null;
}

export function normalizeSessionThinkingLevel(level) {
  return canonicalThinkingLevel(level) || DEFAULT_SESSION_THINKING_LEVEL;
}

export function normalizeRequestThinkingLevel(level, fallback = "off") {
  return canonicalThinkingLevel(level)
    || canonicalThinkingLevel(fallback)
    || "off";
}

export function normalizePiSdkThinkingLevel(level) {
  const normalized = normalizeRequestThinkingLevel(level, "off");
  return normalized === "max" ? "xhigh" : normalized;
}

function idIncludesAny(id, markers) {
  return markers.some((marker) => id.includes(marker));
}

function modelUsesAnthropicEffortControl(model) {
  const provider = lower(model?.provider);
  const api = lower(model?.api);
  const baseUrl = lower(model?.baseUrl || model?.base_url);
  return provider === "anthropic"
    || api === "anthropic-messages"
    || baseUrl.includes("api.anthropic.com");
}

export function modelSupportsAnthropicMaxEffort(model) {
  const id = lower(model?.id);
  return modelUsesAnthropicEffortControl(model)
    && idIncludesAny(id, ANTHROPIC_MAX_EFFORT_MODEL_MARKERS);
}

export function modelSupportsXhigh(model) {
  const id = lower(model?.id);
  const known = lookupKnown(model?.provider, model?.id);
  const explicitLevels = normalizeThinkingLevelChoices(model?.thinkingLevels);
  return typeof model?.thinkingLevelMap?.xhigh === "string"
    || typeof known?.thinkingLevelMap?.xhigh === "string"
    || model?.xhigh === true
    || explicitLevels?.includes("max")
    || known?.xhigh === true
    || idIncludesAny(id, OPENAI_XHIGH_MODEL_MARKERS)
    || modelSupportsAnthropicMaxEffort(model);
}

export function getModelThinkingLevels(model) {
  const explicitLevels = normalizeThinkingLevelChoices(model?.thinkingLevels);
  if (explicitLevels) return explicitLevels;
  return modelSupportsXhigh(model)
    ? [...DEFAULT_VISIBLE_THINKING_LEVELS, "max"]
    : [...DEFAULT_VISIBLE_THINKING_LEVELS];
}

export function normalizeThinkingLevelForModel(level, model) {
  if (lower(level) === "auto") {
    return resolveModelDefaultThinkingLevel(model);
  }
  return normalizeCanonicalThinkingLevelForModel(level, model);
}

function normalizeCanonicalThinkingLevelForModel(level, model) {
  const normalized = normalizeSessionThinkingLevel(level);
  const explicitLevels = normalizeThinkingLevelChoices(model?.thinkingLevels);
  if (explicitLevels) {
    const requestedVisible = visibleThinkingLevel(normalized);
    if (!requestedVisible || !explicitLevels.includes(requestedVisible)) {
      const defaultVisible = visibleThinkingLevel(model?.defaultThinkingLevel);
      if (defaultVisible && explicitLevels.includes(defaultVisible)) return defaultVisible;
      if (explicitLevels.includes(DEFAULT_SESSION_THINKING_LEVEL)) return DEFAULT_SESSION_THINKING_LEVEL;
      return explicitLevels[0];
    }
  }
  const requestsMax = normalized === "xhigh" || normalized === "max";
  if (requestsMax && !modelSupportsXhigh(model)) return "high";
  return normalized;
}

export function resolveModelDefaultThinkingLevel(model, fallback = DEFAULT_SESSION_THINKING_LEVEL) {
  const declaredLevel = typeof model?.defaultThinkingLevel === "string"
    && lower(model.defaultThinkingLevel) !== "auto"
    ? model.defaultThinkingLevel
    : fallback;
  return normalizeCanonicalThinkingLevelForModel(declaredLevel, model);
}

export function resolveThinkingLevelForModel(level, model, resolveThinkingLevel = (value) => value) {
  return resolveThinkingLevel(normalizeThinkingLevelForModel(level, model));
}
