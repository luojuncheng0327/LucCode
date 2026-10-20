import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteSync } from "../shared/safe-fs.ts";

export const SUBAGENT_RUN_STORE_VERSION = 1;

const VALID_STATUSES = new Set(["pending", "resolved", "failed", "aborted"]);
const TERMINAL_STATUSES = new Set(["resolved", "failed", "aborted"]);
const SUBAGENT_RUN_TOOL_NAMES = new Set(["subagent", "subagent_reply"]);
const WORKFLOW_RUN_TOOL_NAMES = new Set(["workflow"]);
const SUBAGENT_CONTEXT_TOOL_NAMES = new Set([
  ...SUBAGENT_RUN_TOOL_NAMES,
  "subagent_close",
]);
const SUBAGENT_PAYLOAD_KEYS = new Set([
  "content",
  "message",
  "note",
  "prompt",
  "reason",
  "result",
  "summary",
  "task",
  "taskTitle",
  "text",
]);
const DEFERRED_RESULT_MESSAGE_TYPE = "luc-background-result";
const DEFERRED_RESULT_RECORD_TYPE = "luc-deferred-result";

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeStatus(status, fallback = "pending") {
  return VALID_STATUSES.has(status) ? status : fallback;
}

function pickString(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function isRecord(value: any): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const normalized = pickString(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function toolNameForRecord(record: any) {
  const explicit = pickString(record?.toolName);
  if (explicit) return explicit;
  return record?.type === "toolCall" ? pickString(record?.name) : null;
}

function parseDeferredNotificationAttrs(content: any): Record<string, string> | null {
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
        .filter((item) => item?.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("")
      : "";
  const opening = /^<luc-background-result\b([^>]*)>/i.exec(text.trim());
  if (!opening) return null;
  const attrs: Record<string, string> = {};
  const attrPattern = /([a-zA-Z0-9:_-]+)="([^"]*)"/g;
  let match;
  while ((match = attrPattern.exec(opening[1]))) attrs[match[1]] = match[2];
  return attrs;
}

function isSubagentDeferredRecord(record: any) {
  if (record?.customType === DEFERRED_RESULT_RECORD_TYPE) {
    return record.data?.type === "subagent";
  }
  if (record?.customType === DEFERRED_RESULT_MESSAGE_TYPE) {
    return parseDeferredNotificationAttrs(record.content)?.type === "subagent";
  }
  return false;
}

function isWorkflowDeferredRecord(record: any) {
  if (record?.customType === DEFERRED_RESULT_RECORD_TYPE) {
    return record.data?.type === "workflow";
  }
  if (record?.customType === DEFERRED_RESULT_MESSAGE_TYPE) {
    return parseDeferredNotificationAttrs(record.content)?.type === "workflow";
  }
  return false;
}

function isSubagentContextRecord(record: any) {
  if (record?.type === "subagent") return true;
  if (SUBAGENT_CONTEXT_TOOL_NAMES.has(toolNameForRecord(record))) return true;
  return isSubagentDeferredRecord(record);
}

function isExcludedIdentityDomain(record: any) {
  const type = pickString(record?.type);
  if (type === "workflow" || type === "media_generation") return true;
  const toolName = toolNameForRecord(record);
  return toolName === "workflow" || toolName === "generate_image" || toolName === "generate_video";
}

/**
 * Find subagent run identities that are structurally present on the retained
 * parent branch. Plain text and unrelated identity domains are ignored.
 */
export function collectRetainedSubagentTaskIds(entries: any[]) {
  const taskIds: string[] = [];
  const seenTaskIds = new Set<string>();
  const seenObjects = new WeakSet<object>();
  const add = (value: any) => {
    const taskId = pickString(value);
    if (!taskId || seenTaskIds.has(taskId)) return;
    seenTaskIds.add(taskId);
    taskIds.push(taskId);
  };
  const visit = (value: any, inheritedContext = false) => {
    if (!value || typeof value !== "object") return;
    if (seenObjects.has(value)) return;
    seenObjects.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, inheritedContext);
      return;
    }
    if (isExcludedIdentityDomain(value)) return;

    const toolName = toolNameForRecord(value);
    const ownContext = inheritedContext || isSubagentContextRecord(value);
    const runContext = inheritedContext
      || value.type === "subagent"
      || SUBAGENT_RUN_TOOL_NAMES.has(toolName)
      || isSubagentDeferredRecord(value);
    if (runContext) add(value.taskId);
    if (value.customType === DEFERRED_RESULT_RECORD_TYPE && value.data?.type === "subagent") {
      add(value.data.taskId);
    }
    if (value.customType === DEFERRED_RESULT_MESSAGE_TYPE) {
      const attrs = parseDeferredNotificationAttrs(value.content);
      if (attrs?.type === "subagent") add(attrs["task-id"] || attrs.taskId);
    }
    for (const [key, child] of Object.entries(value)) {
      const childContext = ownContext && !SUBAGENT_PAYLOAD_KEYS.has(key);
      visit(child, childContext);
    }
  };
  visit(Array.isArray(entries) ? entries : []);
  return taskIds;
}

/** Find workflow run identities structurally present on the retained branch. */
export function collectRetainedWorkflowTaskIds(entries: any[]) {
  const taskIds: string[] = [];
  const seenTaskIds = new Set<string>();
  const seenObjects = new WeakSet<object>();
  const add = (value: any) => {
    const taskId = pickString(value);
    if (!taskId || seenTaskIds.has(taskId)) return;
    seenTaskIds.add(taskId);
    taskIds.push(taskId);
  };
  const visit = (value: any, inheritedContext = false) => {
    if (!value || typeof value !== "object") return;
    if (seenObjects.has(value)) return;
    seenObjects.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, inheritedContext);
      return;
    }
    if (value.type === "subagent" || value.type === "media_generation") return;
    const toolName = toolNameForRecord(value);
    if (SUBAGENT_CONTEXT_TOOL_NAMES.has(toolName) || toolName === "generate_image" || toolName === "generate_video") {
      return;
    }
    const ownContext = inheritedContext
      || value.type === "workflow"
      || WORKFLOW_RUN_TOOL_NAMES.has(toolName)
      || isWorkflowDeferredRecord(value);
    if (ownContext) {
      add(value.taskId);
      add(value.runId);
    }
    if (value.customType === DEFERRED_RESULT_RECORD_TYPE && value.data?.type === "workflow") {
      add(value.data.taskId);
    }
    if (value.customType === DEFERRED_RESULT_MESSAGE_TYPE) {
      const attrs = parseDeferredNotificationAttrs(value.content);
      if (attrs?.type === "workflow") add(attrs["task-id"] || attrs.taskId);
    }
    for (const [key, child] of Object.entries(value)) {
      visit(child, ownContext && !SUBAGENT_PAYLOAD_KEYS.has(key));
    }
  };
  visit(Array.isArray(entries) ? entries : []);
  return taskIds;
}

function forkedRunTaskId() {
  return `subagent-fork-run-${randomUUID()}`;
}

function forkedWorkflowTaskId() {
  return `workflow-fork-run-${randomUUID()}`;
}

function normalizedThreadClones(value: any) {
  const clones = Array.isArray(value) ? value : Array.isArray(value?.clones) ? value.clones : [];
  return clones.filter(isRecord);
}

function threadCloneMaps(threadClones: any) {
  const threadIdMap: Record<string, string> = {};
  const childSessionIdMap: Record<string, string> = {};
  const childSessionPathMap: Record<string, string> = {};
  const cloneBySourceThreadId = new Map<string, Record<string, any>>();
  for (const receipt of normalizedThreadClones(threadClones)) {
    const sourceThreadId = pickString(receipt.sourceThreadId);
    const newThreadId = pickString(receipt.newThreadId);
    if (!sourceThreadId || !newThreadId) continue;
    const previous = cloneBySourceThreadId.get(sourceThreadId);
    if (previous && previous.newThreadId !== newThreadId) {
      throw new Error(`SubagentRunStore: conflicting thread clone for ${sourceThreadId}`);
    }
    cloneBySourceThreadId.set(sourceThreadId, receipt);
    threadIdMap[sourceThreadId] = newThreadId;

    const sourceChildSessionId = pickString(receipt.sourceChildSessionId);
    const targetChildSessionId = pickString(receipt.targetChildSessionId);
    if (sourceChildSessionId && targetChildSessionId) {
      childSessionIdMap[sourceChildSessionId] = targetChildSessionId;
    }
    const sourceChildSessionPath = pickString(receipt.sourceChildSessionPath);
    const targetChildSessionPath = pickString(receipt.targetChildSessionPath);
    if (sourceChildSessionPath && targetChildSessionPath) {
      childSessionPathMap[sourceChildSessionPath] = targetChildSessionPath;
    }
  }
  return { threadIdMap, childSessionIdMap, childSessionPathMap, cloneBySourceThreadId };
}

function normalizeIdentityMap(value: any) {
  const result: Record<string, string> = {};
  for (const [source, target] of Object.entries(value || {})) {
    const sourceId = pickString(source);
    const targetId = pickString(target);
    if (!sourceId || !targetId || sourceId === targetId) continue;
    result[sourceId] = targetId;
  }
  return result;
}

function mappedIdentity(value: any, identityMap: Record<string, string>) {
  const normalized = pickString(value);
  return normalized && identityMap[normalized] ? identityMap[normalized] : value;
}

function rewriteDeferredNotificationContent(content: any, taskIdMap: Record<string, string>) {
  const rewriteText = (text: any) => typeof text === "string"
    ? text.replace(/task-id="([^"]+)"/g, (match, taskId) => (
      taskIdMap[taskId] ? `task-id="${taskIdMap[taskId]}"` : match
    ))
    : text;
  if (typeof content === "string") return rewriteText(content);
  if (!Array.isArray(content)) return content;
  return content.map((item) => (
    item?.type === "text" && typeof item.text === "string"
      ? { ...item, text: rewriteText(item.text) }
      : clone(item)
  ));
}

function rewriteSubagentValue(value: any, maps: any, inheritedContext = false): any {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteSubagentValue(item, maps, inheritedContext));
  }
  if (!isRecord(value)) return value;
  if (isExcludedIdentityDomain(value)) return clone(value);

  const ownContext = inheritedContext || isSubagentContextRecord(value);
  const next: Record<string, any> = {};
  for (const [key, child] of Object.entries(value)) {
    const childContext = ownContext && !SUBAGENT_PAYLOAD_KEYS.has(key);
    next[key] = rewriteSubagentValue(child, maps, childContext);
  }

  if (ownContext) {
    for (const key of ["taskId", "parentTaskId"]) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        next[key] = mappedIdentity(value[key], maps.taskIdMap);
      }
    }
    for (const key of ["threadId", "subagentThreadId"]) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        next[key] = mappedIdentity(value[key], maps.threadIdMap);
      }
    }
    for (const key of ["sessionId", "childSessionId"]) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        next[key] = mappedIdentity(value[key], maps.childSessionIdMap);
      }
    }
    for (const key of ["sessionPath", "childSessionPath", "streamKey"]) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        next[key] = mappedIdentity(value[key], maps.childSessionPathMap);
      }
    }
  }

  if (value.type === "interlude" && value.variant === "deferred_result") {
    next.taskId = mappedIdentity(value.taskId, maps.taskIdMap);
  }
  if (
    value.customType === DEFERRED_RESULT_MESSAGE_TYPE
    && parseDeferredNotificationAttrs(value.content)?.type === "subagent"
  ) {
    next.content = rewriteDeferredNotificationContent(value.content, maps.taskIdMap);
  }
  return next;
}

/**
 * Rewrite only typed subagent identities in a forked transcript. The helper
 * deliberately leaves ordinary text plus media/workflow identity domains alone.
 */
export function rewriteForkedSubagentRunReferences(entries, input: any = {}) {
  const derived = threadCloneMaps(input.threadClones);
  const maps = {
    taskIdMap: normalizeIdentityMap(input.taskIdMap),
    threadIdMap: {
      ...derived.threadIdMap,
      ...normalizeIdentityMap(input.threadIdMap),
    },
    childSessionIdMap: {
      ...derived.childSessionIdMap,
      ...normalizeIdentityMap(input.childSessionIdMap),
    },
    childSessionPathMap: {
      ...derived.childSessionPathMap,
      ...normalizeIdentityMap(input.childSessionPathMap),
    },
  };
  return rewriteSubagentValue(Array.isArray(entries) ? entries : [], maps);
}

function rewriteWorkflowValue(value: any, taskIdMap: Record<string, string>, inheritedContext = false): any {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteWorkflowValue(item, taskIdMap, inheritedContext));
  }
  if (!isRecord(value)) return value;
  const toolName = toolNameForRecord(value);
  if (
    value.type === "subagent"
    || value.type === "media_generation"
    || SUBAGENT_CONTEXT_TOOL_NAMES.has(toolName)
    || toolName === "generate_image"
    || toolName === "generate_video"
  ) {
    return clone(value);
  }

  const ownContext = inheritedContext
    || value.type === "workflow"
    || WORKFLOW_RUN_TOOL_NAMES.has(toolName)
    || isWorkflowDeferredRecord(value);
  const next: Record<string, any> = {};
  for (const [key, child] of Object.entries(value)) {
    next[key] = rewriteWorkflowValue(
      child,
      taskIdMap,
      ownContext && !SUBAGENT_PAYLOAD_KEYS.has(key),
    );
  }
  if (ownContext) {
    for (const key of ["taskId", "runId", "parentTaskId"]) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        next[key] = mappedIdentity(value[key], taskIdMap);
      }
    }
  }
  if (
    value.customType === DEFERRED_RESULT_MESSAGE_TYPE
    && parseDeferredNotificationAttrs(value.content)?.type === "workflow"
  ) {
    next.content = rewriteDeferredNotificationContent(value.content, taskIdMap);
  }
  return next;
}

/** Rewrite only typed workflow task identities in a forked transcript. */
export function rewriteForkedWorkflowRunReferences(entries, input: any = {}) {
  return rewriteWorkflowValue(
    Array.isArray(entries) ? entries : [],
    normalizeIdentityMap(input.taskIdMap),
  );
}

function normalizeRun(taskId, record: any = {}, existing = null) {
  const timestamp = nowIso();
  const next = {
    ...(existing || {}),
    taskId,
    status: normalizeStatus(record.status, existing?.status || "pending"),
    parentSessionId: pickString(record.parentSessionId) || existing?.parentSessionId || null,
    parentSessionPath: pickString(record.parentSessionPath) || existing?.parentSessionPath || null,
    childSessionId: pickString(record.childSessionId) || existing?.childSessionId || null,
    childSessionPath: pickString(record.childSessionPath) || pickString(record.sessionPath) || existing?.childSessionPath || null,
    childLeafEntryId: pickString(record.childLeafEntryId) || existing?.childLeafEntryId || null,
    threadId: pickString(record.threadId) || existing?.threadId || null,
    threadKind: pickString(record.threadKind) || existing?.threadKind || null,
    summary: pickString(record.summary) || existing?.summary || null,
    reason: pickString(record.reason) || existing?.reason || null,
    requestedAgentId: pickString(record.requestedAgentId) || existing?.requestedAgentId || null,
    requestedAgentNameSnapshot: pickString(record.requestedAgentNameSnapshot) || existing?.requestedAgentNameSnapshot || null,
    executorAgentId: pickString(record.executorAgentId) || existing?.executorAgentId || null,
    executorAgentNameSnapshot: pickString(record.executorAgentNameSnapshot) || existing?.executorAgentNameSnapshot || null,
    executorMetaVersion: record.executorMetaVersion || existing?.executorMetaVersion || null,
    forkedFromTaskId: pickString(record.forkedFromTaskId) || existing?.forkedFromTaskId || null,
    forkedFromThreadId: pickString(record.forkedFromThreadId) || existing?.forkedFromThreadId || null,
    forkedAt: pickString(record.forkedAt) || existing?.forkedAt || null,
    sourceTaskIds: uniqueStrings([
      ...(Array.isArray(existing?.sourceTaskIds) ? existing.sourceTaskIds : []),
      ...(Array.isArray(record.sourceTaskIds) ? record.sourceTaskIds : []),
    ]),
    createdAt: existing?.createdAt || pickString(record.createdAt) || timestamp,
    updatedAt: timestamp,
  };

  if (record.completedAt || (next.status !== "pending" && !next.completedAt)) {
    next.completedAt = pickString(record.completedAt) || timestamp;
  }
  return next;
}

export class SubagentRunStore {

  declare _getSessionIdForPath: any;

  declare _persistPath: any;

  declare _runs: any;
  constructor(persistPath = null, { getSessionIdForPath = null }: any = {}) {
    this._persistPath = persistPath || null;
    this._runs = new Map();
    this._getSessionIdForPath = typeof getSessionIdForPath === "function" ? getSessionIdForPath : () => null;
    if (this._persistPath) this._load();
  }

  register(taskId, record: any = {}) {
    if (!taskId) return null;
    const existing = this._runs.get(taskId) || null;
    const next = normalizeRun(taskId, {
      ...record,
      parentSessionId: this._parentSessionIdFromRecord(record, existing),
      status: existing?.status || "pending",
    }, existing);
    this._runs.set(taskId, next);
    this._save();
    return clone(next);
  }

  attachSession(taskId, childSessionPath, record: any = {}) {
    if (!taskId) return null;
    const existing = this._runs.get(taskId) || null;
    const next = normalizeRun(taskId, {
      ...record,
      parentSessionId: this._parentSessionIdFromRecord(record, existing),
      childSessionPath,
      status: existing?.status || "pending",
    }, existing);
    this._runs.set(taskId, next);
    this._save();
    return clone(next);
  }

  resolve(taskId, summary = null) {
    return this.upsert(taskId, {
      status: "resolved",
      summary: typeof summary === "string" ? summary : null,
    });
  }

  fail(taskId, reason = null) {
    const text = typeof reason === "string" ? reason : null;
    return this.upsert(taskId, {
      status: "failed",
      reason: text,
      summary: text,
    });
  }

  abort(taskId, reason = null) {
    const text = typeof reason === "string" ? reason : null;
    return this.upsert(taskId, {
      status: "aborted",
      reason: text,
      summary: text,
    });
  }

  upsert(taskId, record: any = {}) {
    if (!taskId) return null;
    const existing = this._runs.get(taskId) || null;
    const next = normalizeRun(taskId, {
      ...record,
      parentSessionId: this._parentSessionIdFromRecord(record, existing),
    }, existing);
    this._runs.set(taskId, next);
    this._save();
    return clone(next);
  }

  query(taskId) {
    return clone(this._runs.get(taskId) || null);
  }

  list() {
    return Array.from(this._runs.values()).map(clone);
  }

  /**
   * Clone retained terminal direct-thread runs into an independently owned
   * parent Session. Thread clones are authoritative for target child SessionRefs.
   */
  forkSessionRuns(input: any = {}) {
    const sourceRef = {
      sessionId: pickString(input.sourceSessionId),
      sessionPath: pickString(input.sourceSessionPath),
    };
    const targetRef = {
      sessionId: pickString(input.targetSessionId),
      sessionPath: pickString(input.targetSessionPath),
    };
    const sourceKey = this._parentSessionKeyForRef(sourceRef);
    const targetKey = this._parentSessionKeyForRef(targetRef);
    if (!sourceKey || !sourceRef.sessionPath) {
      throw new Error("SubagentRunStore: source Session identity is required");
    }
    if (!targetRef.sessionId || !targetRef.sessionPath || !targetKey) {
      throw new Error("SubagentRunStore: target SessionRef is required");
    }
    if (sourceKey === targetKey) {
      throw new Error("SubagentRunStore: Session Fork target must be independent from its source");
    }
    const createTaskId = typeof input.createTaskId === "function" ? input.createTaskId : forkedRunTaskId;
    const retainedTaskIds = collectRetainedSubagentTaskIds(input.retainedEntries);
    const threadMaps = threadCloneMaps(input.threadClones);
    const skipped = [];
    const candidates = [];

    for (const sourceTaskId of retainedTaskIds) {
      const sourceRun = this._runs.get(sourceTaskId) || null;
      if (!sourceRun) {
        skipped.push({ taskId: sourceTaskId, reason: "run_not_found" });
        continue;
      }
      if (this._parentSessionKeyForRecord(sourceRun) !== sourceKey) {
        skipped.push({ taskId: sourceTaskId, reason: "ownership_mismatch" });
        continue;
      }
      if (sourceRun.status === "pending") {
        const error: any = new Error(`subagent run is active: ${sourceTaskId}`);
        error.code = "subagent_run_busy";
        error.status = 409;
        error.taskId = sourceTaskId;
        throw error;
      }
      if (!TERMINAL_STATUSES.has(sourceRun.status)) {
        skipped.push({ taskId: sourceTaskId, reason: "run_not_terminal" });
        continue;
      }
      const sourceThreadId = pickString(sourceRun.threadId);
      const threadClone = sourceThreadId
        ? threadMaps.cloneBySourceThreadId.get(sourceThreadId) || null
        : null;
      if (!sourceThreadId || !threadClone) {
        skipped.push({ taskId: sourceTaskId, reason: "thread_not_forked" });
        continue;
      }
      candidates.push({ sourceTaskId, sourceRun, sourceThreadId, threadClone });
    }

    const staged = [];
    const taskIdMap = {};
    const stagedTaskIds = new Set();
    const forkedAt = nowIso();
    for (const candidate of candidates) {
      const { sourceTaskId, sourceRun, sourceThreadId, threadClone } = candidate;
      const newThreadId = pickString(threadClone.newThreadId);
      const targetChildSessionId = pickString(threadClone.targetChildSessionId);
      const targetChildSessionPath = pickString(threadClone.targetChildSessionPath);
      if (!newThreadId || !targetChildSessionId || !targetChildSessionPath) {
        throw new Error(`SubagentRunStore: incomplete thread clone for ${sourceThreadId}`);
      }
      const targetTaskId = sourceTaskId === sourceThreadId
        ? newThreadId
        : pickString(createTaskId(sourceRun, staged.length));
      if (!targetTaskId) {
        throw new Error(`SubagentRunStore: forked taskId is required for ${sourceTaskId}`);
      }
      if (
        targetTaskId === sourceTaskId
        || this._runs.has(targetTaskId)
        || stagedTaskIds.has(targetTaskId)
      ) {
        throw new Error(`SubagentRunStore: forked taskId is not unique: ${targetTaskId}`);
      }
      const sourceTaskIds = uniqueStrings([
        sourceTaskId,
        ...(Array.isArray(sourceRun.sourceTaskIds) ? sourceRun.sourceTaskIds : []),
      ]);
      const record = normalizeRun(targetTaskId, {
        ...sourceRun,
        parentSessionId: targetRef.sessionId,
        parentSessionPath: targetRef.sessionPath,
        childSessionId: targetChildSessionId,
        childSessionPath: targetChildSessionPath,
        threadId: newThreadId,
        forkedFromTaskId: sourceTaskId,
        forkedFromThreadId: sourceThreadId,
        forkedAt,
        sourceTaskIds,
      });
      staged.push([targetTaskId, record]);
      stagedTaskIds.add(targetTaskId);
      taskIdMap[sourceTaskId] = targetTaskId;
    }

    try {
      for (const [taskId, record] of staged) this._runs.set(taskId, record);
      if (staged.length > 0) this._save();
    } catch (error) {
      for (const [taskId] of staged) this._runs.delete(taskId);
      if (staged.length > 0) {
        try {
          this._save();
        } catch {
          // The in-memory transaction is already restored; retain the root error.
        }
      }
      throw error;
    }

    return {
      runs: staged.length,
      taskIds: staged.map(([taskId]) => taskId),
      taskIdMap,
      threadIdMap: clone(threadMaps.threadIdMap),
      skipped,
    };
  }

  /** Clone retained terminal workflow parent runs under child-owned task IDs. */
  forkSessionWorkflowRuns(input: any = {}) {
    const sourceRef = {
      sessionId: pickString(input.sourceSessionId),
      sessionPath: pickString(input.sourceSessionPath),
    };
    const targetRef = {
      sessionId: pickString(input.targetSessionId),
      sessionPath: pickString(input.targetSessionPath),
    };
    const sourceKey = this._parentSessionKeyForRef(sourceRef);
    const targetKey = this._parentSessionKeyForRef(targetRef);
    if (!sourceKey || !sourceRef.sessionPath) {
      throw new Error("SubagentRunStore: workflow source Session identity is required");
    }
    if (!targetRef.sessionId || !targetRef.sessionPath || !targetKey) {
      throw new Error("SubagentRunStore: workflow target SessionRef is required");
    }
    if (sourceKey === targetKey) {
      throw new Error("SubagentRunStore: workflow Fork target must be independent from its source");
    }

    const createTaskId = typeof input.createTaskId === "function"
      ? input.createTaskId
      : forkedWorkflowTaskId;
    const retainedTaskIds = collectRetainedWorkflowTaskIds(input.retainedEntries);
    const skipped = [];
    const staged = [];
    const stagedTaskIds = new Set<string>();
    const taskIdMap: Record<string, string> = {};
    const forkedAt = nowIso();

    for (const sourceTaskId of retainedTaskIds) {
      const sourceRun = this._runs.get(sourceTaskId) || null;
      if (!sourceRun) {
        skipped.push({ taskId: sourceTaskId, reason: "run_not_found" });
        continue;
      }
      if (this._parentSessionKeyForRecord(sourceRun) !== sourceKey) {
        skipped.push({ taskId: sourceTaskId, reason: "ownership_mismatch" });
        continue;
      }
      if (sourceRun.status === "pending") {
        const error: any = new Error(`workflow run is active: ${sourceTaskId}`);
        error.code = "workflow_run_busy";
        error.status = 409;
        error.taskId = sourceTaskId;
        throw error;
      }
      if (!TERMINAL_STATUSES.has(sourceRun.status)) {
        skipped.push({ taskId: sourceTaskId, reason: "run_not_terminal" });
        continue;
      }
      const targetTaskId = pickString(createTaskId(sourceRun, staged.length));
      if (
        !targetTaskId
        || targetTaskId === sourceTaskId
        || this._runs.has(targetTaskId)
        || stagedTaskIds.has(targetTaskId)
      ) {
        throw new Error(`SubagentRunStore: forked workflow taskId is not unique: ${targetTaskId || "(empty)"}`);
      }
      const record = normalizeRun(targetTaskId, {
        ...sourceRun,
        parentSessionId: targetRef.sessionId,
        parentSessionPath: targetRef.sessionPath,
        childSessionId: null,
        childSessionPath: null,
        childLeafEntryId: null,
        threadId: null,
        threadKind: null,
        forkedFromTaskId: sourceTaskId,
        forkedFromThreadId: null,
        forkedAt,
        sourceTaskIds: uniqueStrings([
          sourceTaskId,
          ...(Array.isArray(sourceRun.sourceTaskIds) ? sourceRun.sourceTaskIds : []),
        ]),
      });
      staged.push([targetTaskId, record]);
      stagedTaskIds.add(targetTaskId);
      taskIdMap[sourceTaskId] = targetTaskId;
    }

    try {
      for (const [taskId, record] of staged) this._runs.set(taskId, record);
      if (staged.length > 0) this._save();
    } catch (error) {
      for (const [taskId] of staged) this._runs.delete(taskId);
      if (staged.length > 0) {
        try { this._save(); } catch { /* retain the root persistence error */ }
      }
      throw error;
    }

    return {
      runs: staged.length,
      taskIds: staged.map(([taskId]) => taskId),
      taskIdMap,
      skipped,
    };
  }

  /** Remove only fork-owned runs belonging to the failed target Session. */
  discardForkedSessionRuns(input: any = {}) {
    const targetRef = {
      sessionId: pickString(input.targetSessionId),
      sessionPath: pickString(input.targetSessionPath),
    };
    const targetKey = this._parentSessionKeyForRef(targetRef);
    if (!targetKey) throw new Error("SubagentRunStore: fork cleanup target Session identity is required");
    const requestedTaskIds = uniqueStrings(input.taskIds);
    const candidateTaskIds = requestedTaskIds.length > 0
      ? requestedTaskIds
      : [...this._runs.keys()];
    const removed = [];
    const skipped = [];
    for (const taskId of candidateTaskIds) {
      const run = this._runs.get(taskId) || null;
      if (!run) continue;
      if (
        this._parentSessionKeyForRecord(run) !== targetKey
        || !pickString(run.forkedFromTaskId)
      ) {
        skipped.push(taskId);
        continue;
      }
      removed.push([taskId, run]);
      this._runs.delete(taskId);
    }
    try {
      if (removed.length > 0) this._save();
    } catch (error) {
      for (const [taskId, run] of removed) this._runs.set(taskId, run);
      if (removed.length > 0) {
        try {
          this._save();
        } catch {
          // Preserve the cleanup failure that triggered the rollback.
        }
      }
      throw error;
    }
    return { discarded: removed.length, skipped };
  }

  abortByParentSession(parentSessionPath, reason = "parent session aborted") {
    const summary = {
      matched: 0,
      aborted: 0,
      skippedFinal: 0,
    };
    if (!parentSessionPath) return summary;
    const targetKey = this._parentSessionKeyForPath(parentSessionPath);
    for (const [taskId, run] of this._runs) {
      if (this._parentSessionKeyForRecord(run) !== targetKey) continue;
      summary.matched++;
      if (run.status !== "pending") {
        summary.skippedFinal++;
        continue;
      }
      const next = normalizeRun(taskId, {
        status: "aborted",
        reason,
        summary: reason,
      }, run);
      this._runs.set(taskId, next);
      summary.aborted++;
    }
    if (summary.aborted) this._save();
    return summary;
  }

  get size() {
    return this._runs.size;
  }

  _parentSessionIdFromRecord(record: any = {}, existing = null) {
    return pickString(record.parentSessionId)
      || this._sessionIdForPath(record.parentSessionPath)
      || existing?.parentSessionId
      || this._sessionIdForPath(existing?.parentSessionPath)
      || null;
  }

  _sessionIdForPath(sessionPath) {
    const sessionId = this._getSessionIdForPath?.(sessionPath);
    return pickString(sessionId);
  }

  _parentSessionKeyForPath(parentSessionPath) {
    return this._sessionIdForPath(parentSessionPath) || parentSessionPath;
  }

  _parentSessionKeyForRef(ref) {
    if (typeof ref === "string") return this._parentSessionKeyForPath(ref);
    return pickString(ref?.sessionId)
      || (pickString(ref?.sessionPath) ? this._parentSessionKeyForPath(ref.sessionPath) : null);
  }

  _parentSessionKeyForRecord(run) {
    return pickString(run?.parentSessionId)
      || this._sessionIdForPath(run?.parentSessionPath)
      || run?.parentSessionPath
      || null;
  }

  _save() {
    if (!this._persistPath) return;
    const data = {
      schemaVersion: SUBAGENT_RUN_STORE_VERSION,
      runs: Object.fromEntries(this._runs.entries()),
    };
    fs.mkdirSync(path.dirname(this._persistPath), { recursive: true });
    atomicWriteSync(this._persistPath, JSON.stringify(data, null, 2) + "\n");
  }

  _load() {
    if (!this._persistPath || !fs.existsSync(this._persistPath)) return;
    const raw = JSON.parse(fs.readFileSync(this._persistPath, "utf-8"));
    const runs = raw?.runs && typeof raw.runs === "object" ? raw.runs : raw;
    for (const [taskId, value] of Object.entries(runs || {})) {
      if (!taskId || !value || typeof value !== "object") continue;
      this._runs.set(taskId, normalizeRun(taskId, value));
    }
  }
}
