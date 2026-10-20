import type { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { isToolProtocolFragment } from "../tool-protocol-sanitizer.ts";

const STREAM_GUARD_FLAG = Symbol.for("luc.piSdk.streamGuardInstalled");

export function installAssistantStreamGuard(session) {
  const agent = session?.agent;
  if (!agent || typeof agent.streamFn !== "function" || agent[STREAM_GUARD_FLAG]) return;
  const originalStreamFn = agent.streamFn;
  agent.streamFn = async (model, context, options) => {
    const inner = await originalStreamFn(model, context, options);
    return guardAssistantMessageStream(inner);
  };
  agent[STREAM_GUARD_FLAG] = true;
}

export function guardAssistantMessageStream(inner) {
  const outer: AssistantMessageEventStream = createAssistantMessageEventStream();
  const state = createGuardState();

  void (async () => {
    try {
      for await (const event of inner) {
        for (const guarded of guardStreamEvent(event, state)) {
          outer.push(guarded);
        }
      }
    } catch (error) {
      outer.push({
        type: "error",
        reason: "error",
        error: createErrorMessage(error),
      });
    }
    outer.end();
  })();

  return outer;
}

function createGuardState() {
  return {
    invalidToolCalls: new Map(),
  };
}

function guardStreamEvent(event, state) {
  if (!event || typeof event !== "object") return [];
  if (event.type === "toolcall_start" || event.type === "toolcall_delta") {
    const toolCall = toolCallFromEvent(event);
    if (isEmptyNameToolCall(toolCall)) {
      bufferInvalidToolCallEvent(state, event, toolCall);
      return [];
    }
    return [{ ...event, partial: sanitizeAssistantMessage(event.partial, state) }];
  }
  if (event.type === "toolcall_end") {
    const toolCall = toolCallFromEvent(event);
    if (isEmptyNameToolCall(toolCall)) {
      bufferInvalidToolCallEvent(state, event, toolCall);
      const text = recoverInvalidToolCallText(toolCall, getBufferedInvalidToolCallText(state, event, toolCall));
      if (!text) return [];
      recordRecoveredInvalidToolCallText(state, event, toolCall, text);
      const partial = sanitizeAssistantMessage(event.partial, state);
      const contentIndex = Math.max(0, partial.content.length - 1);
      return [
        { type: "text_start", contentIndex, partial },
        { type: "text_delta", contentIndex, delta: text, partial },
        { type: "text_end", contentIndex, content: text, partial },
      ];
    }
    return [{ ...event, partial: sanitizeAssistantMessage(event.partial, state) }];
  }
  if (event.type === "done") {
    return [{ ...event, message: sanitizeAssistantMessage(event.message, state) }];
  }
  if (event.type === "error") {
    return [{ ...event, error: sanitizeAssistantMessage(event.error, state) }];
  }
  if ("partial" in event) {
    return [{ ...event, partial: sanitizeAssistantMessage(event.partial, state) }];
  }
  return [event];
}

function toolCallFromEvent(event) {
  if (event.toolCall?.type === "toolCall") return event.toolCall;
  const content = event.partial?.content;
  if (Array.isArray(content) && typeof event.contentIndex === "number") {
    return content[event.contentIndex];
  }
  return null;
}

function isEmptyNameToolCall(block) {
  return block?.type === "toolCall" && String(block.name || "").trim().length === 0;
}

export function sanitizeAssistantMessage(message, state = null) {
  if (!message || !Array.isArray(message.content)) return message;
  const content = [];
  message.content.forEach((block, index) => {
    if (isEmptyNameToolCall(block)) {
      appendTextBlock(content, recoverInvalidToolCallText(block, getRecoveredInvalidToolCallText(state, block, index)));
      return;
    }
    content.push(block);
  });
  return { ...message, content };
}

function appendTextBlock(content, text) {
  if (!text) return;
  const last = content[content.length - 1];
  if (last?.type === "text") {
    last.text += text;
    return;
  }
  content.push({ type: "text", text });
}

function recoverInvalidToolCallText(block, bufferedText = "") {
  const raw = bufferedText || rawPartialArgs(block);
  const parsed = parseJsonLike(raw);
  const fromParsed = recoverTextFromValue(parsed ?? block?.arguments);
  if (fromParsed) return fromParsed;

  const text = raw.trim();
  if (!text) return "";
  if (text.startsWith("{") || text.startsWith("[")) return "";
  // 工具协议碎片：是失败的工具调用，不是 prose，丢弃（不回写成可见文本）。
  if (isToolProtocolFragment(text)) return "";
  return raw;
}

function rawPartialArgs(block) {
  return typeof block?.partialArgs === "string" ? block.partialArgs : "";
}

function invalidToolCallKey(event, block) {
  if (block?.id) return `id:${block.id}`;
  if (typeof event?.contentIndex === "number") return `index:${event.contentIndex}`;
  return "index:0";
}

function invalidToolCallIndex(event) {
  return typeof event?.contentIndex === "number" ? event.contentIndex : 0;
}

function getInvalidToolCallState(state, event, block) {
  if (!state) return null;
  const key = invalidToolCallKey(event, block);
  const existing = state.invalidToolCalls.get(key);
  if (existing) return existing;
  const entry = {
    raw: "",
    lastPartialArgs: "",
    contentIndex: invalidToolCallIndex(event),
    recoveredText: "",
  };
  state.invalidToolCalls.set(key, entry);
  return entry;
}

function bufferInvalidToolCallEvent(state, event, block) {
  const entry = getInvalidToolCallState(state, event, block);
  if (!entry) return;
  if (typeof event?.delta === "string") {
    entry.raw += event.delta;
    const partial = rawPartialArgs(block);
    if (partial) entry.lastPartialArgs = partial;
    return;
  }

  const partial = rawPartialArgs(block);
  if (!partial) return;
  if (partial.startsWith(entry.lastPartialArgs)) {
    entry.raw += partial.slice(entry.lastPartialArgs.length);
  } else if (!entry.raw.endsWith(partial)) {
    entry.raw += partial;
  }
  entry.lastPartialArgs = partial;
}

function getBufferedInvalidToolCallText(state, event, block) {
  const entry = getInvalidToolCallState(state, event, block);
  return entry?.raw || "";
}

function recordRecoveredInvalidToolCallText(state, event, block, text) {
  const entry = getInvalidToolCallState(state, event, block);
  if (entry) entry.recoveredText = text;
}

function getRecoveredInvalidToolCallText(state, block, index) {
  if (!state) return "";
  if (block?.id) {
    const byId = state.invalidToolCalls.get(`id:${block.id}`)?.recoveredText;
    if (byId) return byId;
  }
  return state.invalidToolCalls.get(`index:${index}`)?.recoveredText || "";
}

function recoverTextFromValue(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  for (const key of ["text", "content", "message", "body", "input"]) {
    if (typeof value[key] === "string") return value[key];
  }
  return "";
}

function parseJsonLike(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || (!text.startsWith("{") && !text.startsWith("[") && !text.startsWith("\""))) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function createErrorMessage(error) {
  return {
    role: "assistant" as const,
    content: [] as any[],
    api: "unknown",
    provider: "unknown",
    model: "unknown",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error" as const,
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}
