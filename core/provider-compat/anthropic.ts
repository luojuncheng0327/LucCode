/**
 * Anthropic Messages prompt-cache compatibility layer.
 *
 * Chat requests normally get cache_control from Pi SDK before this layer runs.
 * Utility requests are direct HTTP calls, so this module makes the same marker
 * contract available through normalizeProviderPayload.
 */

import { modelSupportsAnthropicMaxEffort } from "../session-thinking-level.ts";
import { getReasoningProfile, getThinkingFormat } from "../../shared/model-capabilities.ts";

const CACHE_CONTROL = { type: "ephemeral" };
const MAX_EFFORT_MIN_OUTPUT_TOKENS = 64000;
const ADAPTIVE_THINKING_DISABLED_ERROR =
  "The Claude 5 adaptive model family does not support disabling adaptive thinking.";

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function positiveInteger(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function getModelOutputLimit(model) {
  return positiveInteger(model?.maxTokens || model?.maxOutput);
}

function isImplicitAnthropicOutputCap(value, model) {
  const modelLimit = getModelOutputLimit(model);
  if (!modelLimit) return false;
  return positiveInteger(value) === Math.floor(modelLimit / 3);
}

function hasCacheControl(block) {
  return Boolean(block && typeof block === "object" && block.cache_control);
}

function shouldCacheContentBlock(block) {
  return block && typeof block === "object"
    && (block.type === "text" || block.type === "image" || block.type === "tool_result");
}

function withCacheControl(block) {
  if (!shouldCacheContentBlock(block) || hasCacheControl(block)) return block;
  return { ...block, cache_control: { ...CACHE_CONTROL } };
}

function normalizeSystem(system) {
  if (typeof system === "string") {
    return {
      value: [{ type: "text", text: system, cache_control: { ...CACHE_CONTROL } }],
      changed: true,
    };
  }

  if (!Array.isArray(system)) {
    return { value: system, changed: false };
  }

  let lastIndex = -1;
  for (let i = system.length - 1; i >= 0; i--) {
    if (system[i]?.type === "text") {
      lastIndex = i;
      break;
    }
  }
  if (lastIndex < 0 || hasCacheControl(system[lastIndex])) {
    return { value: system, changed: false };
  }

  const next = system.slice();
  next[lastIndex] = withCacheControl(system[lastIndex]);
  return { value: next, changed: true };
}

function normalizeUserMessage(message) {
  if (!message || message.role !== "user") {
    return { value: message, changed: false, cacheable: false };
  }

  if (typeof message.content === "string") {
    if (message.content.trim().length === 0) {
      return { value: message, changed: false, cacheable: false };
    }
    return {
      value: {
        ...message,
        content: [{
          type: "text",
          text: message.content,
          cache_control: { ...CACHE_CONTROL },
        }],
      },
      changed: true,
      cacheable: true,
    };
  }

  if (!Array.isArray(message.content) || message.content.length === 0) {
    return { value: message, changed: false, cacheable: false };
  }

  const blockIndex = message.content.length - 1;
  const lastBlock = message.content[blockIndex];
  if (!shouldCacheContentBlock(lastBlock)) {
    return { value: message, changed: false, cacheable: false };
  }
  if (hasCacheControl(lastBlock)) {
    return { value: message, changed: false, cacheable: true };
  }

  const nextContent = message.content.slice();
  nextContent[blockIndex] = withCacheControl(lastBlock);
  return {
    value: { ...message, content: nextContent },
    changed: true,
    cacheable: true,
  };
}

function normalizeRecentUserMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { value: messages, changed: false };
  }

  let next = messages;
  let changed = false;
  let marked = 0;
  for (let i = messages.length - 1; i >= 0 && marked < 2; i--) {
    const result = normalizeUserMessage(next[i]);
    if (!result.cacheable) continue;
    marked++;
    if (result.changed) {
      if (next === messages) next = messages.slice();
      next[i] = result.value;
      changed = true;
    }
  }
  return { value: next, changed };
}

export function matches(model) {
  if (!model || typeof model !== "object") return false;
  if (usesAnthropicCacheControl(model)) return true;
  if (lower(model.api) === "anthropic-messages" && getThinkingFormat(model) === "anthropic") return true;
  if (isAdaptiveOnlyProfile(model)) return true;
  return false;
}

function usesAnthropicCacheControl(model) {
  if (!model || typeof model !== "object") return false;
  if (lower(model.api) !== "anthropic-messages") return false;
  if (lower(model.provider) === "anthropic") return true;
  if (lower(model.id).startsWith("claude-")) return true;
  return model.compat?.cacheControlFormat === "anthropic";
}

function shouldUseAnthropicMaxEffort(model, options) {
  return (options?.reasoningLevel === "xhigh" || options?.reasoningLevel === "max")
    && modelSupportsAnthropicMaxEffort(model);
}

function isAdaptiveOnlyProfile(model) {
  return getReasoningProfile(model) === "anthropic-adaptive-only";
}

function isThinkingOff(level) {
  return level === "off" || level === "none" || level === "disabled";
}

function adaptiveEffortForLevel(level) {
  if (level === "xhigh" || level === "max") return "max";
  if (level === "low" || level === "medium" || level === "high") return level;
  return "high";
}

function normalizeAdaptiveThinking(thinking) {
  const base = thinking && typeof thinking === "object" && !Array.isArray(thinking)
    ? thinking
    : {};
  if (base.type === "disabled") {
    throw new Error(ADAPTIVE_THINKING_DISABLED_ERROR);
  }
  return {
    type: "adaptive",
    display: base.display || "summarized",
  };
}

function withMaxEffort(payload) {
  const next = { ...payload };
  const thinking = payload.thinking && typeof payload.thinking === "object"
    ? payload.thinking
    : {};
  if (thinking.type !== "adaptive") {
    next.thinking = {
      type: "adaptive",
      display: thinking.display || "summarized",
    };
  }
  next.output_config = { ...(payload.output_config || {}), effort: "max" };
  return next;
}

function withMaxEffortOutputBudget(payload, model, options) {
  const current = positiveInteger(payload.max_tokens);
  const modelLimit = getModelOutputLimit(model);
  if (!current || !modelLimit) return payload;
  if (!isImplicitAnthropicOutputCap(current, model)) return payload;
  const source = lower(options?.outputBudgetSource || options?.maxTokensSource);
  if (source === "user" || source === "system") return payload;

  const target = Math.min(modelLimit, MAX_EFFORT_MIN_OUTPUT_TOKENS);
  if (current >= target) return payload;
  return { ...payload, max_tokens: target };
}

function normalizeMaxEffort(payload, model, options) {
  if (!shouldUseAnthropicMaxEffort(model, options)) return payload;
  return withMaxEffortOutputBudget(withMaxEffort(payload), model, options);
}

function normalizeAdaptiveOnlyThinking(payload, model, options) {
  if (isThinkingOff(options?.reasoningLevel)) {
    throw new Error(ADAPTIVE_THINKING_DISABLED_ERROR);
  }

  const effort = adaptiveEffortForLevel(options?.reasoningLevel);
  let next = payload;
  const editable = () => {
    if (next === payload) next = { ...payload };
    return next;
  };

  const p = editable();
  p.thinking = normalizeAdaptiveThinking(payload.thinking);
  p.output_config = { ...(payload.output_config || {}), effort };
  delete p.reasoning_effort;

  return effort === "max" ? withMaxEffortOutputBudget(next, model, options) : next;
}

function shouldDisableThinking(payload, options) {
  return options?.mode === "utility"
    || isThinkingOff(options?.reasoningLevel)
    || payload.thinking?.type === "disabled";
}

function normalizeStandardThinking(payload, options) {
  if (!shouldDisableThinking(payload, options)) return payload;
  const next = { ...payload, thinking: { type: "disabled" } };
  delete next.reasoning_effort;
  delete next.output_config;
  return next;
}

export function apply(payload, model, options = {}) {
  let result = payload;

  if (usesAnthropicCacheControl(model) && Object.prototype.hasOwnProperty.call(payload, "system")) {
    const system = normalizeSystem(payload.system);
    if (system.changed) result = { ...result, system: system.value };
  }

  if (usesAnthropicCacheControl(model)) {
    const messages = normalizeRecentUserMessages(result.messages);
    if (messages.changed) result = { ...result, messages: messages.value };
  }

  result = isAdaptiveOnlyProfile(model)
    ? normalizeAdaptiveOnlyThinking(result, model, options)
    : normalizeMaxEffort(normalizeStandardThinking(result, options), model, options);

  return result;
}
