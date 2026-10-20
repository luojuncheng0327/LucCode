/**
 * LongCat OpenAI-compatible thinking compatibility.
 *
 * LongCat keeps the Chat Completions request envelope while exposing reasoning
 * controls through a `thinking` object. Utility calls need deterministic
 * answer text, so they explicitly disable thinking and strip stale reasoning
 * history before replay.
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
  if (lower(model.compat?.thinkingFormat) === "longcat") return true;

  const provider = lower(model.provider);
  if (provider === "longcat" || provider === "longcat-coding") return true;

  const host = baseHost(model.baseUrl || model.base_url);
  return host === "api.longcat.chat" || host.endsWith(".longcat.chat");
}

function isThinkingOff(value) {
  if (value === false) return true;
  if (value == null) return false;
  const normalized = lower(value);
  return normalized === "" || normalized === "none" || normalized === "off" || normalized === "disabled";
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
  return model?.reasoning === false && hasThinkingControls(payload);
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

export function apply(payload, model, options = {}) {
  if (!payload || typeof payload !== "object") return payload;
  if (!shouldDisableThinking(payload, model, options)) return payload;
  return disableThinking(payload);
}
