const FIELD_LABELS = Object.freeze({
  system: "system",
  beforeUser: "before_user",
  afterUser: "after_user",
});

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function textFromBlock(block, fieldName) {
  if (typeof block === "string") return block.trim();
  if (!isPlainObject(block)) {
    throw new Error(`session turn context ${fieldName} entries must be strings or { text, label } objects`);
  }
  if (typeof block.text !== "string") {
    throw new Error(`session turn context ${fieldName} entry.text must be a string`);
  }
  const text = block.text.trim();
  if (!text) return "";
  const label = typeof block.label === "string" && block.label.trim()
    ? block.label.trim()
    : null;
  return label ? `[${label}]\n${text}` : text;
}

function normalizeContextText(value, fieldName) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => textFromBlock(item, fieldName))
      .filter(Boolean);
    return parts.length ? parts.join("\n\n") : null;
  }
  if (isPlainObject(value)) {
    const text = textFromBlock(value, fieldName);
    return text || null;
  }
  throw new Error(`session turn context ${fieldName} must be a string, array, or { text, label } object`);
}

export function normalizeSessionTurnContext(input) {
  if (input === undefined || input === null) return null;
  if (!isPlainObject(input)) {
    throw new Error("session turn context must be an object");
  }

  const system = normalizeContextText(input.system, "system");
  const beforeUser = normalizeContextText(input.beforeUser, "beforeUser");
  const afterUser = normalizeContextText(input.afterUser, "afterUser");
  let metadata = null;
  if (input.metadata !== undefined && input.metadata !== null) {
    if (!isPlainObject(input.metadata)) {
      throw new Error("session turn context metadata must be an object");
    }
    metadata = cloneJson(input.metadata);
  }

  if (!system && !beforeUser && !afterUser && !metadata) return null;
  return {
    ...(system ? { system } : {}),
    ...(beforeUser ? { beforeUser } : {}),
    ...(afterUser ? { afterUser } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function metadataLine(metadata) {
  if (!metadata || Object.keys(metadata).length === 0) return "";
  return `\nmetadata: ${JSON.stringify(metadata)}`;
}

function contextBlock(kind, text, metadata = null) {
  return `[Luc turn context: ${kind}]${metadataLine(metadata)}\n${text}\n[/Luc turn context]\n\n`;
}

function appendContextBlock(kind, text, metadata = null) {
  return `\n\n${contextBlock(kind, text, metadata).trim()}`;
}

function withSystemContext(message, context) {
  const block = appendContextBlock(FIELD_LABELS.system, context.system, context.metadata);
  if (typeof message.content === "string") {
    return { ...message, content: `${message.content}${block}` };
  }
  if (Array.isArray(message.content)) {
    return {
      ...message,
      content: [...message.content, { type: "text", text: block.trim() }],
    };
  }
  return { ...message, content: block.trim() };
}

function prependUserContext(message, text, metadata) {
  const block = contextBlock(FIELD_LABELS.beforeUser, text, metadata);
  if (typeof message.content === "string") {
    return { ...message, content: `${block}${message.content}` };
  }
  if (Array.isArray(message.content)) {
    return {
      ...message,
      content: [{ type: "text", text: block }, ...message.content],
    };
  }
  return { ...message, content: block };
}

function appendUserContext(message, text, metadata) {
  const block = appendContextBlock(FIELD_LABELS.afterUser, text, metadata);
  if (typeof message.content === "string") {
    return { ...message, content: `${message.content}${block}` };
  }
  if (Array.isArray(message.content)) {
    return {
      ...message,
      content: [...message.content, { type: "text", text: block.trim() }],
    };
  }
  return { ...message, content: block.trim() };
}

function lastIndexByRole(messages, role) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === role) return index;
  }
  return -1;
}

export function injectSessionTurnContextMessages(messages, rawContext) {
  const context = normalizeSessionTurnContext(rawContext);
  if (!context || !Array.isArray(messages)) return messages;

  let next = [...messages];
  if (context.system) {
    const systemIndex = next.findIndex((message) => message?.role === "system");
    if (systemIndex >= 0) {
      next[systemIndex] = withSystemContext(next[systemIndex], context);
    } else {
      next = [{
        role: "system",
        content: contextBlock(FIELD_LABELS.system, context.system, context.metadata).trim(),
      }, ...next];
    }
  }

  const userIndex = lastIndexByRole(next, "user");
  if (userIndex >= 0 && context.beforeUser) {
    next[userIndex] = prependUserContext(next[userIndex], context.beforeUser, context.metadata);
  }
  if (userIndex >= 0 && context.afterUser) {
    next[userIndex] = appendUserContext(next[userIndex], context.afterUser, context.metadata);
  }
  return next;
}

function refValue(ref) {
  if (typeof ref === "function") return ref();
  if (ref && typeof ref === "object" && "current" in ref) return ref.current;
  return ref ?? null;
}

export function createSessionTurnContextExtension({
  path = "luc-session-turn-context",
  sessionPathRef,
  getTurnContext,
}: {
  path?: string;
  sessionPathRef?: any;
  getTurnContext?: any;
} = {}) {
  return {
    path,
    tools: new Map(),
    handlers: new Map([
      [
        "context",
        [
          async (event) => {
            const sessionPath = refValue(sessionPathRef);
            const context = getTurnContext?.(sessionPath) || null;
            if (!context) return undefined;
            return {
              messages: injectSessionTurnContextMessages(event?.messages, context),
            };
          },
        ],
      ],
    ]),
    flags: new Map(),
    shortcuts: new Map(),
    commands: new Map(),
    messageRenderers: new Map(),
  };
}
