/**
 * Zhipu GLM OpenAI-compatible provider compatibility.
 *
 * Zhipu uses the OpenAI chat-completions shape but rejects several OpenAI-only
 * request fields. Keep the provider contract explicit instead of relying on
 * server-side defaults or silent provider fallback.
 *
 * Protocol notes:
 *   1. GLM 4.7/5/5.1 thinking is controlled with thinking.type.
 *   2. Tool-call turns in thinking mode must replay real reasoning_content.
 *   3. Preserved thinking uses thinking.clear_thinking=false.
 *   4. OpenCode Go's GLM endpoint follows the same thinking/replay shape, but
 *      does not accept the clear_thinking preservation flag.
 *
 * Official docs:
 *   - https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode
 *   - https://docs.z.ai/api-reference/llm/chat-completion
 *
 * Deletion condition:
 *   - pi-ai natively handles Zhipu thinking controls, reasoning_content replay,
 *     and unsupported OpenAI-only request fields for GLM OpenAI-compatible APIs.
 */

import {
  ensureAssistantContentForToolCalls,
  stripReasoningContent,
} from "./reasoning-content-replay.ts";

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function isThinkingOff(value) {
  if (value === false || value == null) return value === false;
  const normalized = lower(value);
  return normalized === "" || normalized === "none" || normalized === "off" || normalized === "disabled";
}

export function matches(model) {
  if (!model || typeof model !== "object") return false;
  if (lower(model.compat?.thinkingFormat) === "zhipu") return true;
  const provider = lower(model.provider);
  const baseUrl = lower(model.baseUrl || model.base_url);
  return provider === "zhipu"
    || provider === "zhipu-coding"
    || baseUrl.includes("open.bigmodel.cn")
    || (
      baseUrl.includes("api.z.ai")
      && (
        baseUrl.includes("/api/paas/v4")
        || baseUrl.includes("/api/coding/paas/v4")
      )
    );
}

function normalizeMaxTokenField(payload) {
  if (!hasOwn(payload, "max_completion_tokens")) return payload;
  const next = { ...payload };
  if (!hasOwn(next, "max_tokens")) {
    next.max_tokens = next.max_completion_tokens;
  }
  delete next.max_completion_tokens;
  return next;
}

function normalizeTools(tools) {
  if (!Array.isArray(tools)) return { value: tools, changed: false };

  let changed = false;
  const value = tools.map((tool) => {
    if (!tool || typeof tool !== "object") return tool;
    let next = tool;
    if (hasOwn(next, "strict")) {
      next = { ...next };
      delete next.strict;
      changed = true;
    }
    if (next.function && typeof next.function === "object" && hasOwn(next.function, "strict")) {
      if (next === tool) next = { ...next };
      next.function = { ...next.function };
      delete next.function.strict;
      changed = true;
    }
    return next;
  });

  return { value, changed };
}

function hasAssistantToolCallHistory(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.some((message) => {
    return message
      && typeof message === "object"
      && message.role === "assistant"
      && Array.isArray(message.tool_calls)
      && message.tool_calls.length > 0;
  });
}

function hasAssistantReasoningHistory(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.some((message) => {
    return message
      && typeof message === "object"
      && message.role === "assistant"
      && typeof message.reasoning_content === "string"
      && message.reasoning_content.length > 0;
  });
}

function isOpenCodeGoEndpoint(model) {
  if (!model || typeof model !== "object") return false;
  const provider = lower(model.provider);
  const baseUrl = lower(model.baseUrl || model.base_url);
  return provider === "opencode-go"
    || baseUrl.includes("opencode.ai/zen/go");
}

function supportsClearThinkingFlag(model) {
  return !isOpenCodeGoEndpoint(model);
}

function resolveReasoningReplay(payload, options) {
  const value = typeof options?.reasoningReplay === "string"
    ? lower(options.reasoningReplay)
    : "";
  if (value === "clear" || value === "none" || value === "strip") return "clear";
  if (value === "preserve" || value === "replay") return "preserve";
  if (hasOwn(payload.thinking || {}, "clear_thinking")) {
    return payload.thinking.clear_thinking === true ? "clear" : "preserve";
  }
  return "preserve";
}

function normalizeThinking(payload, model, options) {
  const off = options?.mode === "utility"
    || isThinkingOff(options?.reasoningLevel)
    || payload.thinking?.type === "disabled"
    || payload.enable_thinking === false;
  const wantsThinking = !off && (
    hasOwn(payload, "reasoning_effort")
    || payload.enable_thinking === true
    || model?.reasoning === true
    || payload.thinking?.type === "enabled"
  );
  if (!off && !wantsThinking && !hasOwn(payload, "reasoning_effort")) return payload;

  const next = { ...payload };
  delete next.reasoning_effort;
  delete next.enable_thinking;

  if (off) {
    next.thinking = { type: "disabled" };
    if (Array.isArray(next.messages)) {
      const stripped = stripReasoningContent(next.messages);
      if (stripped !== next.messages) next.messages = stripped;
    }
    return next;
  }

  next.thinking = { type: "enabled" };
  const reasoningReplay = resolveReasoningReplay(payload, options);
  const clearHistory = reasoningReplay === "clear";
  const canSendClearThinking = supportsClearThinkingFlag(model);
  const hasToolCalls = hasAssistantToolCallHistory(next.messages);

  if (clearHistory) {
    if (canSendClearThinking) {
      next.thinking.clear_thinking = true;
    }
    if (Array.isArray(next.messages)) {
      const stripped = stripReasoningContent(next.messages);
      if (stripped !== next.messages) next.messages = stripped;
    }
  } else if (canSendClearThinking && (hasToolCalls || hasAssistantReasoningHistory(next.messages))) {
    next.thinking.clear_thinking = false;
  }

  if (hasToolCalls) {
    const contentEnsured = ensureAssistantContentForToolCalls(next.messages);
    if (contentEnsured !== next.messages) {
      next.messages = contentEnsured;
    }
  }

  return next;
}

export function apply(payload, model, options = {}) {
  let next = normalizeMaxTokenField(payload);

  if (hasOwn(next, "store")) {
    if (next === payload) next = { ...next };
    delete next.store;
  }
  if (hasOwn(next, "stream_options")) {
    if (next === payload) next = { ...next };
    delete next.stream_options;
  }

  const tools = normalizeTools(next.tools);
  if (tools.changed) {
    if (next === payload) next = { ...next };
    next.tools = tools.value;
  }

  next = normalizeThinking(next, model, options);
  return next;
}
