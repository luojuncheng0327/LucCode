import {
  DEFERRED_RESULT_MESSAGE_TYPE,
  DEFERRED_RESULT_RECORD_TYPE,
  parseDeferredResultNotification,
  parseDeferredResultRecord,
} from "../../lib/deferred-result-notification.ts";

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isMediaDeferredType(value: unknown) {
  return value === "image-generation" || value === "video-generation";
}

function addTaskId(taskIds: Set<string>, value: unknown) {
  const taskId = text(value);
  if (taskId) taskIds.add(taskId);
}

export function collectRetainedMediaTaskState(entries: unknown[]) {
  const taskIds = new Set<string>();
  const resultsByTaskId: Record<string, any> = {};
  const seen = new WeakSet<object>();

  const recordResult = (parsed: any) => {
    if (!parsed?.taskId || !isMediaDeferredType(parsed.type)) return;
    taskIds.add(parsed.taskId);
    resultsByTaskId[parsed.taskId] = structuredClone(parsed);
  };

  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (seen.has(value as object)) return;
    seen.add(value as object);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    const record = value as Record<string, any>;
    if (record.type === "media_generation") addTaskId(taskIds, record.taskId);
    if (record.type === "file" && record.replacesTaskId) {
      addTaskId(taskIds, record.replacesTaskId);
    }

    const mediaGeneration = isRecord(record.mediaGeneration) ? record.mediaGeneration : null;
    if (mediaGeneration && Array.isArray(mediaGeneration.tasks)) {
      for (const task of mediaGeneration.tasks) {
        addTaskId(taskIds, typeof task === "string" ? task : task?.taskId);
      }
    }

    if (record.customType === DEFERRED_RESULT_RECORD_TYPE) {
      recordResult(parseDeferredResultRecord(record.data));
    } else if (record.customType === DEFERRED_RESULT_MESSAGE_TYPE) {
      recordResult(parseDeferredResultNotification(record.content));
    }

    for (const child of Object.values(record)) visit(child);
  };

  visit(Array.isArray(entries) ? entries : []);
  return {
    taskIds: [...taskIds],
    resultsByTaskId,
  };
}

function normalizedTaskIdMap(value: Record<string, unknown> = {}) {
  const result: Record<string, string> = {};
  for (const [sourceTaskId, targetTaskId] of Object.entries(value || {})) {
    const sourceId = text(sourceTaskId);
    const targetId = text(targetTaskId);
    if (!sourceId || !targetId || sourceId === targetId) continue;
    result[sourceId] = targetId;
  }
  return result;
}

function mappedTaskId(value: unknown, taskIdMap: Record<string, string>) {
  const taskId = text(value);
  return taskId ? taskIdMap[taskId] || value : value;
}

function rewriteDeferredMessageContent(value: unknown, taskIdMap: Record<string, string>): unknown {
  if (typeof value === "string") {
    return value.replace(/task-id="([^"]+)"/g, (match, taskId) => {
      const replacement = taskIdMap[taskId];
      return replacement ? `task-id="${replacement}"` : match;
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (!isRecord(item) || item.type !== "text") return rewriteForkedMediaTaskValue(item, taskIdMap);
      return {
        ...item,
        text: rewriteDeferredMessageContent(item.text, taskIdMap),
      };
    });
  }
  return rewriteForkedMediaTaskValue(value, taskIdMap);
}

function rewriteMediaGeneration(value: unknown, taskIdMap: Record<string, string>) {
  if (!isRecord(value)) return rewriteForkedMediaTaskValue(value, taskIdMap);
  const next = rewriteForkedMediaTaskValue(value, taskIdMap) as Record<string, any>;
  if (!Array.isArray(value.tasks)) return next;
  next.tasks = value.tasks.map((task) => {
    if (typeof task === "string") return mappedTaskId(task, taskIdMap);
    if (!isRecord(task)) return rewriteForkedMediaTaskValue(task, taskIdMap);
    return {
      ...(rewriteForkedMediaTaskValue(task, taskIdMap) as Record<string, any>),
      taskId: mappedTaskId(task.taskId, taskIdMap),
    };
  });
  return next;
}

function rewriteForkedMediaTaskValue(value: unknown, taskIdMap: Record<string, string>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteForkedMediaTaskValue(item, taskIdMap));
  }
  if (!isRecord(value)) return value;

  const next: Record<string, any> = {};
  for (const [key, child] of Object.entries(value)) {
    next[key] = key === "mediaGeneration"
      ? rewriteMediaGeneration(child, taskIdMap)
      : rewriteForkedMediaTaskValue(child, taskIdMap);
  }

  if (value.type === "media_generation") {
    next.taskId = mappedTaskId(value.taskId, taskIdMap);
  }
  if (value.type === "file" && value.replacesTaskId) {
    next.replacesTaskId = mappedTaskId(value.replacesTaskId, taskIdMap);
  }
  if (value.type === "interlude" && value.variant === "deferred_result" && value.taskId) {
    next.taskId = mappedTaskId(value.taskId, taskIdMap);
  }
  if (value.customType === DEFERRED_RESULT_RECORD_TYPE && isRecord(value.data)) {
    next.data = {
      ...next.data,
      taskId: mappedTaskId(value.data.taskId, taskIdMap),
    };
  }
  if (value.customType === DEFERRED_RESULT_MESSAGE_TYPE) {
    next.content = rewriteDeferredMessageContent(value.content, taskIdMap);
    if (isRecord(value.details)) {
      next.details = {
        ...next.details,
        taskId: mappedTaskId(value.details.taskId, taskIdMap),
      };
    }
  }
  return next;
}

/**
 * Rewrite only typed media-task references. Unrelated taskId fields and plain
 * user/assistant text are deliberately left byte-for-byte unchanged.
 */
export function rewriteForkedMediaTaskReferences(
  entries: unknown[],
  taskIdMap: Record<string, unknown>,
) {
  const normalizedMap = normalizedTaskIdMap(taskIdMap);
  if (Object.keys(normalizedMap).length === 0) return structuredClone(entries || []);
  return rewriteForkedMediaTaskValue(entries || [], normalizedMap) as unknown[];
}
