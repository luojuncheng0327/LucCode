/**
 * Volcengine Ark OpenAI-compatible thinking compatibility.
 *
 * Volcengine keeps the Chat Completions request envelope, but deep thinking is
 * controlled by `thinking.type`. Some Chat Completions models also accept
 * `reasoning_effort`, with no Luc-visible `max` value in that effort enum.
 */

import { stripReasoningContent } from "./reasoning-content-replay.ts";

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function baseHost(value) {
  if (typeof value !== "string" || value.trim().length === 0) return "";
  const text = value.trim();
  try {
    return new URL(text).hostname.toLowerCase();
  } catch {
    try {
      return new URL(`https://${text}`).hostname.toLowerCase();
    } catch {
      return lower(text).split(/[/?#]/)[0].replace(/:\d+$/, "");
    }
  }
}

export function matches(model) {
  if (!model || typeof model !== "object") return false;
  if (lower(model.compat?.thinkingFormat) === "volcengine") return true;

  const provider = lower(model.provider);
  if (provider === "volcengine" || provider === "volcengine-coding") return true;

  const host = baseHost(model.baseUrl || model.base_url);
  return host === "ark.cn-beijing.volces.com" || host.endsWith(".volces.com");
}

function isThinkingOff(value) {
  if (value === false) return true;
  if (value == null) return false;
  const normalized = lower(value);
  return normalized === "" || normalized === "none" || normalized === "off" || normalized === "disabled";
}

function reasoningEffortForLevel(level) {
  const normalized = lower(level);
  if (normalized === "minimal") return "minimal";
  if (normalized === "low") return "low";
  if (normalized === "medium" || normalized === "auto") return "medium";
  if (normalized === "high" || normalized === "xhigh" || normalized === "max") return "high";
  return null;
}

function hasThinkingControls(payload) {
  return hasOwn(payload, "thinking")
    || hasOwn(payload, "reasoning_effort")
    || hasOwn(payload, "enable_thinking");
}

function shouldDisableThinking(payload, model, options) {
  if (options?.mode === "utility") return true;
  if (isThinkingOff(options?.reasoningLevel)) return true;
  if (payload.thinking?.type === "disabled") return true;
  if (payload.enable_thinking === false) return true;
  return model?.reasoning === false && hasThinkingControls(payload);
}

function shouldEnableThinking(payload, model, options) {
  return Boolean(
    model?.reasoning === true
    || payload.thinking?.type === "enabled"
    || payload.enable_thinking === true
    || hasOwn(payload, "reasoning_effort")
    || reasoningEffortForLevel(options?.reasoningLevel)
  );
}

function disableThinking(payload) {
  const next = { ...payload };
  delete next.reasoning_effort;
  delete next.enable_thinking;
  next.thinking = { type: "disabled" };

  if (Array.isArray(next.messages)) {
    const stripped = stripReasoningContent(next.messages);
    if (stripped !== next.messages) next.messages = stripped;
  }

  return next;
}

function enableThinking(payload, options) {
  const next = { ...payload };
  delete next.enable_thinking;
  next.thinking = { type: "enabled" };

  const effort = reasoningEffortForLevel(options?.reasoningLevel)
    || (hasOwn(payload, "reasoning_effort") ? reasoningEffortForLevel(payload.reasoning_effort) : null);
  if (effort) {
    next.reasoning_effort = effort;
  } else {
    delete next.reasoning_effort;
  }

  return next;
}

export function apply(payload, model, options = {}) {
  if (!payload || typeof payload !== "object") return payload;

  if (shouldDisableThinking(payload, model, options)) {
    if (model?.reasoning !== true && !hasThinkingControls(payload)) return payload;
    return disableThinking(payload);
  }

  if (!shouldEnableThinking(payload, model, options)) return payload;

  return enableThinking(payload, options);
}
