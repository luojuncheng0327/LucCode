import {
  DEFERRED_RESULT_MESSAGE_TYPE,
  parseDeferredResultNotification,
} from "./deferred-result-notification.ts";

export const TURN_INPUT_PRESENTATION_EVENT_TYPE = "turn_input_presentation";
export const TURN_INPUT_CONSUMPTION_EVENT_TYPE = "turn_input_consumption";

const HIDDEN_TURN_INPUT_RE = /<luc-background-result(?:\s|>)|<luc-deferred-tasks(?:\s|>)/;

function messageTextContent(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

/** System turn inputs can trigger an Agent reply without becoming a visible user node. */
export function isHiddenTurnInputMessage(message) {
  return HIDDEN_TURN_INPUT_RE.test(messageTextContent(message));
}

function isIndependentCustomTurnInput(entry) {
  return entry?.customType === DEFERRED_RESULT_MESSAGE_TYPE
    && !!parseDeferredResultNotification(entry.content);
}

/**
 * Pi persists independently delivered background results as `custom_message`
 * entries. Extension context injected beside a user prompt and notify-only
 * custom messages stay inside their surrounding turn instead of becoming an
 * artificial turn boundary.
 */
export function isSessionTurnInputEntry(entry) {
  return (
    entry?.type === "message" && entry.message?.role === "user"
  ) || (
    entry?.type === "custom_message" && isIndependentCustomTurnInput(entry)
  );
}

/** History projection of an independently delivered custom turn input. */
export function isCustomTurnInputHistoryMessage(message) {
  return message?.role === "custom"
    && typeof message.customType === "string"
    && Object.prototype.hasOwnProperty.call(message, "content")
    && !Object.prototype.hasOwnProperty.call(message, "data")
    && isIndependentCustomTurnInput(message);
}

function textOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function buildTurnInputPresentationEvent(message, { deliveryMode = null } = {}) {
  const parsed = parseDeferredResultNotification(message?.content);
  if (!parsed?.taskId) return null;
  const details = message?.details && typeof message.details === "object" ? message.details : null;
  const deliveryId = textOrNull(details?.deliveryId);

  return {
    type: TURN_INPUT_PRESENTATION_EVENT_TYPE,
    presentation: {
      kind: "pre_reply_interlude",
      inputKind: "custom_message",
      customType: message?.customType || null,
      ...(deliveryId ? { deliveryId } : {}),
      taskId: parsed.taskId,
      status: parsed.status === "failed" || parsed.status === "aborted" ? parsed.status : "success",
      resultType: parsed.type || "background-task",
      ...(Object.prototype.hasOwnProperty.call(parsed, "result") ? { result: parsed.result } : {}),
      ...(parsed.reason ? { reason: parsed.reason } : {}),
      ...(deliveryMode ? { deliveryMode } : {}),
    },
  };
}

export function buildTurnInputPresentationRecord(presentation, block) {
  if (!presentation || !block) return null;
  const deliveryId = textOrNull(presentation.deliveryId) || textOrNull(block.deliveryId);
  return {
    schemaVersion: 1,
    ...(deliveryId ? { deliveryId } : {}),
    presentation,
    block,
  };
}

export function parseTurnInputPresentationRecord(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const block = data.block && typeof data.block === "object" && !Array.isArray(data.block)
    ? data.block
    : null;
  if (block?.type !== "interlude") return null;
  return {
    deliveryId: textOrNull(data.deliveryId) || textOrNull(block.deliveryId),
    presentation: data.presentation && typeof data.presentation === "object" && !Array.isArray(data.presentation)
      ? data.presentation
      : null,
    block,
  };
}

export function buildTurnInputConsumptionRecord({ input, assistant = null, presentation = null, block }) {
  if (!input || !block || block.type !== "interlude") return null;
  const deliveryId = textOrNull(input.deliveryId) || textOrNull(block.deliveryId);
  return {
    schemaVersion: 1,
    ...(deliveryId ? { deliveryId } : {}),
    input: {
      ...(textOrNull(input.entryId) ? { entryId: textOrNull(input.entryId) } : {}),
      ...(textOrNull(input.customType) ? { customType: textOrNull(input.customType) } : {}),
      ...(textOrNull(input.deliveryId) ? { deliveryId: textOrNull(input.deliveryId) } : {}),
      ...(textOrNull(input.taskId) ? { taskId: textOrNull(input.taskId) } : {}),
      ...(textOrNull(input.status) ? { status: textOrNull(input.status) } : {}),
      ...(textOrNull(input.resultType) ? { resultType: textOrNull(input.resultType) } : {}),
      ...(textOrNull(input.timestamp) ? { timestamp: textOrNull(input.timestamp) } : {}),
    },
    ...(assistant && typeof assistant === "object" ? {
      assistant: {
        ...(textOrNull(assistant.entryId) ? { entryId: textOrNull(assistant.entryId) } : {}),
        ...(textOrNull(assistant.parentId) ? { parentId: textOrNull(assistant.parentId) } : {}),
        ...(textOrNull(assistant.timestamp) ? { timestamp: textOrNull(assistant.timestamp) } : {}),
      },
    } : {}),
    ...(presentation && typeof presentation === "object" ? { presentation } : {}),
    block,
  };
}

export function parseTurnInputConsumptionRecord(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const block = data.block && typeof data.block === "object" && !Array.isArray(data.block)
    ? data.block
    : null;
  if (block?.type !== "interlude") return null;
  return {
    deliveryId: textOrNull(data.deliveryId) || textOrNull(data.input?.deliveryId) || textOrNull(block.deliveryId),
    input: data.input && typeof data.input === "object" && !Array.isArray(data.input)
      ? data.input
      : null,
    assistant: data.assistant && typeof data.assistant === "object" && !Array.isArray(data.assistant)
      ? data.assistant
      : null,
    presentation: data.presentation && typeof data.presentation === "object" && !Array.isArray(data.presentation)
      ? data.presentation
      : null,
    block,
  };
}
