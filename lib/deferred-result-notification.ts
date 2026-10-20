import { randomUUID } from "node:crypto";

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function unescapeXml(str) {
  return String(str)
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

export const DEFERRED_RESULT_MESSAGE_TYPE = "luc-background-result";
export const DEFERRED_RESULT_RECORD_TYPE = "luc-deferred-result";

export function isUiOnlyDeferredResultTask(task) {
  const intent = task?.meta?.deliveryIntent;
  return intent === "ui_only" || intent === "notify_ui_only";
}

export function shouldNotifyAgentOnFailure(task) {
  return task?.status === "failed" && task?.meta?.notifyAgentOnFailure === true;
}

function parseAttrs(rawAttrs): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z0-9:_-]+)="([^"]*)"/g;
  let match;
  while ((match = re.exec(rawAttrs || ""))) {
    attrs[match[1]] = unescapeXml(match[2]);
  }
  return attrs;
}

function formatResultNotification(taskId, result, meta) {
  const type = escapeXml(meta?.type || "background-task");
  const body =
    typeof result === "string"
      ? escapeXml(result)
      : escapeXml(JSON.stringify(result, null, 2));
  return `<luc-background-result task-id="${escapeXml(taskId)}" status="success" type="${type}">\n${body}\n</luc-background-result>`;
}

function formatFailNotification(taskId, reason, meta) {
  const type = escapeXml(meta?.type || "background-task");
  return `<luc-background-result task-id="${escapeXml(taskId)}" status="failed" type="${type}">\n${escapeXml(reason)}\n</luc-background-result>`;
}

function formatAbortNotification(taskId, reason, meta) {
  const type = escapeXml(meta?.type || "background-task");
  return `<luc-background-result task-id="${escapeXml(taskId)}" status="aborted" type="${type}">\n${escapeXml(reason || "task was stopped")}\n</luc-background-result>`;
}

export function formatDeferredResultNotification(taskId, task) {
  if (task?.status === "resolved") {
    return formatResultNotification(taskId, task.result, task.meta);
  }
  if (task?.status === "aborted") {
    return formatAbortNotification(taskId, task.reason, task.meta);
  }
  return formatFailNotification(taskId, task?.reason, task?.meta);
}

function createDeferredResultDeliveryId(taskId) {
  return `deferred-delivery:${taskId}:${randomUUID()}`;
}

export function buildDeferredResultMessage(taskId, task) {
  return {
    customType: DEFERRED_RESULT_MESSAGE_TYPE,
    content: formatDeferredResultNotification(taskId, task),
    display: false,
    details: {
      schemaVersion: 1,
      taskId,
      deliveryId: createDeferredResultDeliveryId(taskId),
    },
  };
}

export function buildDeferredResultRecord(taskId, task) {
  const status = task?.status === "resolved" ? "success" : task?.status;
  const record: Record<string, any> = {
    schemaVersion: 1,
    taskId,
    status,
    type: task?.meta?.type || "background-task",
  };
  if (task?.status === "resolved") {
    record.result = task.result ?? null;
  } else if (task?.status === "failed" || task?.status === "aborted") {
    record.reason = task.reason || (task.status === "aborted" ? "task was stopped" : "task failed");
  }
  return record;
}

export function parseDeferredResultRecord(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const taskId = typeof data.taskId === "string" ? data.taskId : null;
  const status = typeof data.status === "string" ? data.status : null;
  if (!taskId || !status) return null;
  return {
    taskId,
    status,
    type: typeof data.type === "string" ? data.type : "background-task",
    ...(Object.prototype.hasOwnProperty.call(data, "result") ? { result: data.result } : {}),
    ...(Object.prototype.hasOwnProperty.call(data, "reason") ? { reason: data.reason } : {}),
  };
}

export function parseDeferredResultNotification(content) {
  const text = contentToText(content).trim();
  const match = /^<luc-background-result\b([^>]*)>([\s\S]*?)<\/luc-background-result>$/.exec(text);
  if (!match) return null;

  const attrs = parseAttrs(match[1]);
  const taskId = attrs["task-id"] || attrs.taskId || null;
  const status = attrs.status || null;
  if (!taskId || !status) return null;

  const body = unescapeXml(match[2] || "").trim();
  const parsed: Record<string, any> = {
    taskId,
    status,
    type: attrs.type || "background-task",
  };

  if (status === "success") {
    try {
      parsed.result = body ? JSON.parse(body) : null;
    } catch {
      parsed.result = body;
    }
  } else {
    parsed.reason = body;
  }

  return parsed;
}
