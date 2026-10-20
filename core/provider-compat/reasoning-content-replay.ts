import {
  getReasoningProfile,
  getReasoningReplayContract,
  getThinkingFormat,
} from "../../shared/model-capabilities.ts";

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function hasToolCalls(message) {
  if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) return true;
  return Array.isArray(message?.content)
    && message.content.some((block) => block?.type === "toolCall");
}

function hasStringReasoningContent(message) {
  return hasOwn(message, "reasoning_content") && typeof message.reasoning_content === "string";
}

function normalizeAssistantContent(content) {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  if (!Array.isArray(content)) return "";

  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

/**
 * 从带协议签名的 canonical thinking block 投影 reasoning_content。
 * 普通 text / assistant.content 可能是用户可见正文，禁止猜成思考链。
 */
function findCanonicalReasoningContent(message) {
  if (!message || typeof message !== "object") return { found: false, value: "" };
  const content = message.content;
  if (!Array.isArray(content) || content.length === 0) return { found: false, value: "" };

  for (const block of content) {
    if (
      block
      && block.type === "thinking"
      && block.thinkingSignature === "reasoning_content"
      && typeof block.thinking === "string"
    ) {
      return { found: true, value: block.thinking };
    }
  }

  return { found: false, value: "" };
}

export function extractReasoningFromContent(message) {
  return findCanonicalReasoningContent(message).value;
}

function hasCanonicalReasoningContent(message) {
  if (hasStringReasoningContent(message)) return true;
  return findCanonicalReasoningContent(message).found;
}

function isThinkingOff(value) {
  if (value === false) return true;
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  return normalized === "off" || normalized === "none" || normalized === "disabled";
}

function requestUsesReasoning(payload, model, options) {
  if (options?.mode === "utility") return false;
  if (isThinkingOff(options?.reasoningLevel)) return false;
  if (model?.reasoning === false) return false;
  if (payload?.thinking?.type === "disabled") return false;
  if (payload?.enable_thinking === false) return false;
  if (payload?.chat_template_kwargs?.enable_thinking === false) return false;
  if (payload?.reasoning?.enabled === false || isThinkingOff(payload?.reasoning?.effort)) return false;
  return true;
}

function providerLabel(model) {
  const profile = getReasoningProfile(model);
  if (profile?.startsWith("kimi-")) return "Kimi";
  if (profile?.startsWith("deepseek-")) return "DeepSeek";
  if (profile?.startsWith("mimo-")) return "MiMo";
  if (profile?.startsWith("zhipu-")) return "Zhipu";
  const provider = typeof model?.provider === "string" ? model.provider.trim() : "";
  if (!provider) return "Provider";
  if (provider.toLowerCase() === "kimi-coding") return "Kimi";
  if (provider.toLowerCase().includes("deepseek")) return "DeepSeek";
  if (provider.toLowerCase().includes("mimo") || provider.toLowerCase().includes("xiaomi")) return "MiMo";
  if (provider.toLowerCase().includes("zhipu")) return "Zhipu";
  return provider;
}

function missingReasoningReplayError(model) {
  const label = providerLabel(model);
  return new Error(
    `${label} thinking mode reasoning_content is missing for tool_calls history (assistant tool call). `
    + `Compact this session or start a new session before continuing with ${label} thinking mode.`,
  );
}

function isSameAssistantModel(message, model) {
  return message?.provider === model?.provider
    && message?.api === model?.api
    && message?.model === model?.id;
}

function reasoningReplayFamily(model) {
  const profile = getReasoningProfile(model);
  if (profile?.startsWith("deepseek-")) return "deepseek";
  if (profile?.startsWith("kimi-")) return "kimi";
  if (profile?.startsWith("mimo-")) return "mimo";
  if (profile?.startsWith("zhipu-")) return "zhipu";

  const format = getThinkingFormat(model);
  if (format === "deepseek" || format === "kimi" || format === "zhipu") return format;

  const provider = typeof model?.provider === "string" ? model.provider.toLowerCase() : "";
  const id = typeof model?.id === "string" ? model.id.toLowerCase() : "";
  if (provider.includes("deepseek")) return "deepseek";
  if (provider === "kimi-coding" || provider === "moonshot" || provider.startsWith("moonshotai")) return "kimi";
  if (provider.includes("mimo") || provider.includes("xiaomi")) return "mimo";
  if (provider.includes("zhipu") || provider === "zai" || provider.startsWith("zai-")) return "zhipu";
  if (provider === "opencode-go" && id.startsWith("glm-")) return "zhipu";
  return null;
}

function isCompatibleReasoningContentSource(message, model) {
  if (isSameAssistantModel(message, model)) return true;
  if (!message?.provider || !message?.api || !message?.model) return false;
  if (message.api !== model?.api) return false;

  const sourceFamily = reasoningReplayFamily({
    id: message.model,
    provider: message.provider,
    api: message.api,
    reasoning: true,
  });
  const targetFamily = reasoningReplayFamily(model);
  return sourceFamily !== null && sourceFamily === targetFamily;
}

/**
 * Validate canonical AssistantMessage history before the SDK serializer and
 * preserve textual reasoning carriers across compatible model IDs. Only the
 * model-visible copy is rewritten; persisted session messages stay untouched.
 */
export function normalizeReasoningReplayContextMessages(messages, model, options: Record<string, any> = {}) {
  if (!Array.isArray(messages)) return messages;
  const contract = getReasoningReplayContract(model);
  if (!contract || contract.policy === "none" || contract.carrier !== "reasoning_content") {
    return messages;
  }
  if (!requestUsesReasoning(null, model, options)) return messages;

  if (options.reasoningReplay === "clear") {
    if (contract.clearable !== true) {
      throw new Error(`${providerLabel(model)} reasoning replay cannot be cleared for this protocol.`);
    }
    return messages;
  }

  let changed = false;
  const next = messages.map((message) => {
    if (!message || typeof message !== "object" || message.role !== "assistant") return message;
    const hasCarrier = hasCanonicalReasoningContent(message);
    if (contract.policy === "require-tool-call" && hasToolCalls(message) && !hasCarrier) {
      throw missingReasoningReplayError(model);
    }
    if (!hasCarrier || !Array.isArray(message.content) || isSameAssistantModel(message, model)) {
      return message;
    }
    if (!isCompatibleReasoningContentSource(message, model)) {
      if (contract.policy === "require-tool-call" && hasToolCalls(message)) {
        throw missingReasoningReplayError(model);
      }
      return message;
    }

    changed = true;
    return {
      ...message,
      provider: model?.provider,
      api: model?.api,
      model: model?.id,
    };
  });

  return changed ? next : messages;
}

/** Apply the resolved replay contract to the final provider payload. */
export function normalizeReasoningReplayPayload(payload, model, options: Record<string, any> = {}) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.messages)) return payload;
  const contract = getReasoningReplayContract(model);
  if (!contract || contract.policy === "none" || contract.carrier !== "reasoning_content") {
    return payload;
  }

  if (options.reasoningReplay === "clear") {
    if (contract.clearable !== true) {
      throw new Error(`${providerLabel(model)} reasoning replay cannot be cleared for this protocol.`);
    }
    const messages = stripReasoningContent(payload.messages);
    return messages === payload.messages ? payload : { ...payload, messages };
  }
  if (!requestUsesReasoning(payload, model, options)) return payload;
  if (contract.policy !== "require-tool-call") return payload;

  const messages = ensureReasoningContentForToolCalls(payload.messages, {
    providerLabel: providerLabel(model),
  });
  return messages === payload.messages ? payload : { ...payload, messages };
}

export function reasoningReplayCanClear(model) {
  return getReasoningReplayContract(model)?.clearable === true;
}

/**
 * 保证所有带 tool_calls 的 assistant message 都有真实 reasoning_content。
 * 只接受 wire 字段本身或 canonical `thinkingSignature=reasoning_content`；
 * 不从普通正文猜测，避免把可见回答错误回传成隐藏推理。
 *
 * @param {Array|any} messages
 * @param {{ providerLabel: string }} options
 * @returns {Array|any}
 */
export function ensureReasoningContentForToolCalls(messages, options: { providerLabel?: string } = {}) {
  if (!Array.isArray(messages)) return messages;

  const providerLabel = options.providerLabel || "Provider";
  const missingError =
    `${providerLabel} thinking mode reasoning_content is missing for tool_calls history (assistant tool call). `
    + `Compact this session or start a new session before continuing with ${providerLabel} thinking mode.`;

  let changed = false;
  const next = messages.map((message) => {
    if (!message || typeof message !== "object" || message.role !== "assistant") {
      return message;
    }
    if (!hasToolCalls(message)) {
      return message;
    }
    if (hasStringReasoningContent(message)) {
      return message;
    }
    const recovered = findCanonicalReasoningContent(message);
    if (!recovered.found) {
      throw new Error(missingError);
    }
    changed = true;
    return { ...message, reasoning_content: recovered.value };
  });

  return changed ? next : messages;
}

export function isReasoningReplayUnavailable(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return message.includes("reasoning_content is missing for tool_calls history")
    || message.includes("thinking mode history is missing non-empty thinking content for a tool call");
}

/**
 * OpenAI 兼容工具调用历史中，部分供应商要求 assistant.content 不能是 null。
 *
 * @param {Array|any} messages
 * @returns {Array|any}
 */
export function ensureAssistantContentForToolCalls(messages) {
  if (!Array.isArray(messages)) return messages;

  let changed = false;
  const next = messages.map((message) => {
    if (!message || typeof message !== "object" || message.role !== "assistant") {
      return message;
    }
    if (!hasToolCalls(message)) {
      return message;
    }

    const content = normalizeAssistantContent(message.content);
    if (message.content === content) {
      return message;
    }

    changed = true;
    return { ...message, content };
  });

  return changed ? next : messages;
}

export function stripReasoningContent(messages) {
  if (!Array.isArray(messages)) return messages;

  let changed = false;
  const next = messages.map((message) => {
    if (!message || typeof message !== "object" || !hasOwn(message, "reasoning_content")) {
      return message;
    }
    changed = true;
    const copy = { ...message };
    delete copy.reasoning_content;
    return copy;
  });
  return changed ? next : messages;
}
