/**
 * OpenRouter provider compatibility layer.
 *
 * Handles OpenRouter-hosted Anthropic adaptive-only Claude models:
 *   - provider === "openrouter" or baseUrl belongs to openrouter.ai
 *   - compat.reasoningProfile === "openrouter-anthropic-adaptive"
 *
 * Protocol problem:
 *   Claude adaptive effort is controlled through OpenRouter's `verbosity`
 *   field for these models. Sending Anthropic raw `thinking` or generic
 *   `reasoning.effort` silently aims at the wrong wire contract.
 *
 * Deletion condition:
 *   - pi-ai natively emits the OpenRouter Claude adaptive request shape, or
 *   - OpenRouter changes these models to accept the standard reasoning effort
 *     field with the same semantics.
 */

import { getReasoningProfile } from "../../shared/model-capabilities.ts";

const ADAPTIVE_THINKING_DISABLED_ERROR =
  "The Claude 5 adaptive model family does not support disabling adaptive thinking.";

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

export function matches(model) {
  if (!model || typeof model !== "object") return false;
  return getReasoningProfile(model) === "openrouter-anthropic-adaptive";
}

function isThinkingOff(value) {
  if (value === false) return true;
  const normalized = lower(value);
  return normalized === "off"
    || normalized === "none"
    || normalized === "disabled";
}

function adaptiveEffortForLevel(level) {
  if (level === "xhigh" || level === "max") return "max";
  if (level === "low" || level === "medium" || level === "high") return level;
  return "high";
}

function hasDisabledReasoning(payload) {
  if (isThinkingOff(payload.reasoning_effort)) return hasOwn(payload, "reasoning_effort");
  if (payload.thinking?.type === "disabled") return true;
  if (!isPlainObject(payload.reasoning)) return false;
  if (payload.reasoning.enabled === false) return true;
  return isThinkingOff(payload.reasoning.effort);
}

function normalizeReasoning(reasoning) {
  const next = isPlainObject(reasoning) ? { ...reasoning } : {};
  delete next.effort;
  delete next.max_tokens;
  delete next.maxTokens;
  next.enabled = true;
  return next;
}

export function apply(payload, model, options: Record<string, any> = {}) {
  if (isThinkingOff(options?.reasoningLevel) || hasDisabledReasoning(payload)) {
    throw new Error(ADAPTIVE_THINKING_DISABLED_ERROR);
  }

  const next = { ...payload };
  delete next.thinking;
  delete next.reasoning_effort;
  next.reasoning = normalizeReasoning(payload.reasoning);
  next.verbosity = adaptiveEffortForLevel(options?.reasoningLevel);
  return next;
}
