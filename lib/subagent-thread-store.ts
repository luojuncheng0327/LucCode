/**
 * subagent-thread-store.js — subagent 线程生命周期账本
 *
 * Thread 记录一个 child session 的身份与生命周期；Run 记录一次 taskId 执行。
 * 线程可以是：
 * - direct：普通 subagent 创建出的可继续线程，由主 agent 决定何时关闭
 * - ephemeral / reusable：旧数据兼容 kind，加载时规范化为 direct
 * - workflow_node：workflow 里 agent() 派出的临时节点线程，完成后关闭
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteSync } from "../shared/safe-fs.ts";

export const SUBAGENT_THREAD_STORE_VERSION = 2;

const VALID_KINDS = new Set(["direct", "workflow_node"]);
const LEGACY_DIRECT_KINDS = new Set(["ephemeral", "reusable"]);
const VALID_THREAD_STATUSES = new Set(["open", "closed"]);
const VALID_RUN_STATUSES = new Set(["pending", "resolved", "failed", "aborted"]);
const VALID_ACCESS = new Set(["read", "write"]);
// A direct thread's first run intentionally uses taskId === threadId. Later
// continuations carry threadId explicitly, so both structured forms are needed.
const THREAD_REFERENCE_KEYS = new Set(["threadId", "subagentThreadId", "taskId"]);

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const normalized = pickString(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/**
 * Find subagent thread identities that are structurally referenced by the retained
 * parent branch. String contents are deliberately ignored: only typed identity
 * fields can keep a continuable thread alive across a Session Fork.
 */
export function collectReferencedSubagentThreadIds(entries) {
  const ids = new Set<string>();
  const seen = new WeakSet<object>();
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const [key, nested] of Object.entries(value)) {
      if (THREAD_REFERENCE_KEYS.has(key)) {
        const threadId = pickString(nested);
        if (threadId) ids.add(threadId);
      }
      visit(nested);
    }
  };
  visit(Array.isArray(entries) ? entries : []);
  return [...ids];
}

function collectRetainedThreadSnapshots(entries) {
  const snapshots = new Map();
  const seen = new WeakSet<object>();
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const threadId = pickString(value.threadId || value.subagentThreadId);
    const isDirectSnapshot = value.threadKind === "direct"
      || value.kind === "direct"
      || value.type === "subagent";
    if (threadId && isDirectSnapshot) {
      const previous = snapshots.get(threadId) || {};
      const next = { ...previous };
      for (const key of ["agentId", "agentName", "label", "access", "summary", "childSessionId", "childSessionPath"]) {
        if (Object.prototype.hasOwnProperty.call(value, key)) next[key] = value[key];
      }
      if (Object.prototype.hasOwnProperty.call(value, "runCount")) next.runCount = value.runCount;
      if (Object.prototype.hasOwnProperty.call(value, "streamStatus")) next.streamStatus = value.streamStatus;
      snapshots.set(threadId, next);
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(Array.isArray(entries) ? entries : []);
  return snapshots;
}

function pickString(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function pickCount(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function normalizeKind(kind, fallback = "direct") {
  if (VALID_KINDS.has(kind)) return kind;
  if (LEGACY_DIRECT_KINDS.has(kind)) return "direct";
  return fallback;
}

function normalizeThreadStatus(status, fallback = "open") {
  return VALID_THREAD_STATUSES.has(status) ? status : fallback;
}

function normalizeRunStatus(status, fallback = "pending") {
  return VALID_RUN_STATUSES.has(status) ? status : fallback;
}

function normalizeAccess(access, fallback = null) {
  if (VALID_ACCESS.has(access)) return access;
  return VALID_ACCESS.has(fallback) ? fallback : null;
}

function pickThreadLabel( record: any = {}, existing = null) {
  if (pickString(record.label)) return pickString(record.label);
  if (pickString(record.instance)) return pickString(record.instance);
  if (pickString(record.taskSuffix)) return pickString(record.taskSuffix);
  if (pickString(record.reuseKey)) {
    const parts = record.reuseKey.split("::").map((part) => part.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return existing?.label || null;
}

function normalizeThread(threadId, record: any = {}, existing = null) {
  const timestamp = nowIso();
  const kind = normalizeKind(record.kind, normalizeKind(existing?.kind || "direct"));
  const status = normalizeThreadStatus(record.status, existing?.status || "open");
  const hasClosedAt = Object.prototype.hasOwnProperty.call(record, "closedAt");
  return {
    ...(existing || {}),
    threadId,
    kind,
    status,
    lastRunStatus: normalizeRunStatus(record.lastRunStatus || record.runStatus, existing?.lastRunStatus || "pending"),
    parentSessionId: pickString(record.parentSessionId) || existing?.parentSessionId || null,
    parentSessionPath: pickString(record.parentSessionPath) || existing?.parentSessionPath || null,
    parentTaskId: pickString(record.parentTaskId) || existing?.parentTaskId || null,
    nodeId: pickString(record.nodeId) || existing?.nodeId || null,
    agentId: pickString(record.agentId) || existing?.agentId || null,
    agentName: pickString(record.agentName) || existing?.agentName || null,
    childSessionId: pickString(record.childSessionId) || existing?.childSessionId || null,
    childSessionPath: pickString(record.childSessionPath) || pickString(record.sessionPath) || existing?.childSessionPath || null,
    label: pickThreadLabel(record, existing),
    access: normalizeAccess(record.access, existing?.access || null),
    summary: pickString(record.summary) || existing?.summary || null,
    runCount: pickCount(record.runCount ?? existing?.runCount),
    createdAt: existing?.createdAt || pickString(record.createdAt) || timestamp,
    lastRunAt: pickString(record.lastRunAt) || existing?.lastRunAt || null,
    closedAt: hasClosedAt ? pickString(record.closedAt) : (existing?.closedAt || null),
    forkedFromThreadId: pickString(record.forkedFromThreadId) || existing?.forkedFromThreadId || null,
    forkedAt: pickString(record.forkedAt) || existing?.forkedAt || null,
    cleanupPending: record.cleanupPending === true || existing?.cleanupPending === true,
    cleanupError: pickString(record.cleanupError) || existing?.cleanupError || null,
    sourceThreadIds: uniqueStrings([
      ...(Array.isArray(existing?.sourceThreadIds) ? existing.sourceThreadIds : []),
      ...(Array.isArray(record.sourceThreadIds) ? record.sourceThreadIds : []),
    ]),
    updatedAt: timestamp,
  };
}

function forkThreadId() {
  return `subagent-fork-${randomUUID()}`;
}

function normalizedChildSessionRef(value) {
  const sessionId = pickString(value?.sessionId || value?.childSessionId);
  const sessionPath = pickString(value?.sessionPath || value?.childSessionPath);
  return sessionId && sessionPath ? { sessionId, sessionPath } : null;
}

function forkCleanupError(error, clones, cleanupFailures) {
  const forkError: any = error instanceof Error ? error : new Error(String(error));
  forkError.subagentThreadForkCleanup = {
    clones: clone(clones),
    cleanupFailures: cleanupFailures.map(({ threadId, error: cleanupError }) => ({
      threadId,
      message: cleanupError?.message || String(cleanupError),
    })),
  };
  return forkError;
}

export class SubagentThreadStore {
  declare _chains: any;
  declare _getSessionIdForPath: any;
  declare _persistPath: any;
  declare _threads: any;
  constructor(persistPath = null, { getSessionIdForPath = null }: any = {}) {
    this._persistPath = persistPath || null;
    this._threads = new Map();
    this._chains = new Map();
    this._getSessionIdForPath = typeof getSessionIdForPath === "function" ? getSessionIdForPath : () => null;
    if (this._persistPath) this._load();
  }

  beginRun(threadId, record: any = {}) {
    if (!threadId) return null;
    const existing = this._threads.get(threadId) || null;
    const next = normalizeThread(threadId, {
      ...record,
      parentSessionId: this._parentSessionIdFromRecord(record, existing),
      status: "open",
      lastRunStatus: "pending",
      runCount: (existing?.runCount || 0) + 1,
      lastRunAt: nowIso(),
      closedAt: null,
    }, existing);
    this._threads.set(threadId, next);
    this._save();
    return clone(next);
  }

  attachSession(threadId, childSessionPath, record: any = {}) {
    if (!threadId) return null;
    const existing = this._threads.get(threadId) || null;
    const next = normalizeThread(threadId, {
      ...record,
      parentSessionId: this._parentSessionIdFromRecord(record, existing),
      childSessionPath,
      status: existing?.status || "open",
    }, existing);
    this._threads.set(threadId, next);
    this._save();
    return clone(next);
  }

  finishRun(threadId, record: any = {}) {
    if (!threadId) return null;
    const existing = this._threads.get(threadId) || null;
    if (!existing) return null;
    const close = record.close === true;
    const next = normalizeThread(threadId, {
      ...record,
      parentSessionId: this._parentSessionIdFromRecord(record, existing),
      status: close ? "closed" : "open",
      lastRunStatus: normalizeRunStatus(record.status || record.lastRunStatus, existing.lastRunStatus),
      closedAt: close ? nowIso() : null,
    }, existing);
    this._threads.set(threadId, next);
    this._save();
    return clone(next);
  }

  upsert(threadId, record: any = {}) {
    if (!threadId) return null;
    const existing = this._threads.get(threadId) || null;
    const next = normalizeThread(threadId, {
      ...record,
      parentSessionId: this._parentSessionIdFromRecord(record, existing),
    }, existing);
    this._threads.set(threadId, next);
    this._save();
    return clone(next);
  }

  get(threadId) {
    if (!threadId) return null;
    return clone(this._threads.get(threadId) || null);
  }

  list() {
    return Array.from(this._threads.values()).map(clone);
  }

  listOpenDirectBySession(parentSessionPath) {
    if (!parentSessionPath) return [];
    const targetKey = this._parentSessionKeyForPath(parentSessionPath);
    const out = [];
    for (const rec of this._threads.values()) {
      if (this._parentSessionKeyForRecord(rec) !== targetKey) continue;
      if (rec.kind !== "direct") continue;
      if (rec.status !== "open") continue;
      out.push(clone(rec));
    }
    return out.sort((a, b) => String(a.lastRunAt || a.updatedAt || "").localeCompare(String(b.lastRunAt || b.updatedAt || "")));
  }

  /**
   * Resolve a direct thread inside one parent Session only. Fork aliases are
   * scoped by the target parent identity, so the same historical threadId keeps
   * resolving to the source thread in the source Session and to its independent
   * clone in the forked Session.
   */
  resolveDirectThreadForSession(threadId, parentSessionRef) {
    const normalized = pickString(threadId);
    const targetKey = this._parentSessionKeyForRef(parentSessionRef);
    if (!normalized || !targetKey) return null;

    const exact = this._threads.get(normalized) || null;
    if (
      exact?.kind === "direct"
      && this._parentSessionKeyForRecord(exact) === targetKey
    ) {
      return clone(exact);
    }

    const aliases = [];
    for (const record of this._threads.values()) {
      if (record.kind !== "direct") continue;
      if (this._parentSessionKeyForRecord(record) !== targetKey) continue;
      if (!Array.isArray(record.sourceThreadIds) || !record.sourceThreadIds.includes(normalized)) continue;
      aliases.push(record);
    }
    return aliases.length === 1 ? clone(aliases[0]) : null;
  }

  /**
   * Clone the retained, open direct threads of a parent Session. The injected
   * callback owns child-session cloning (JSONL, manifest and related sidecars);
   * this store owns thread identity, parent ownership and transactional records.
   */
  async forkOpenDirectThreads(input: any = {}) {
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
    if (!sourceKey) throw new Error("subagent thread fork requires a source Session identity");
    if (!targetRef.sessionId || !targetRef.sessionPath || !targetKey) {
      throw new Error("subagent thread fork requires a target SessionRef");
    }
    if (sourceKey === targetKey) {
      throw new Error("subagent thread fork target must be independent from its source Session");
    }

    const referencedThreadIds = uniqueStrings(
      Array.isArray(input.referencedThreadIds)
        ? input.referencedThreadIds
        : collectReferencedSubagentThreadIds(input.retainedEntries),
    );
    const retainedSnapshots = collectRetainedThreadSnapshots(input.retainedEntries);
    const historicalBoundary = input.allowCurrentChildLeaf === false;
    const sources = [];
    const seenSources = new Set();
    const skipped = [];
    for (const referencedThreadId of referencedThreadIds) {
      const source = this.resolveDirectThreadForSession(referencedThreadId, sourceRef);
      if (!source) {
        skipped.push({ threadId: referencedThreadId, reason: "not_open_direct" });
        continue;
      }
      const retainedSnapshot = retainedSnapshots.get(source.threadId)
        || retainedSnapshots.get(referencedThreadId)
        || null;
      const closedAtBoundary = retainedSnapshot?.streamStatus === "closed";
      if (
        (closedAtBoundary || (!historicalBoundary && source.status !== "open"))
        && input.cloneClosedThreads !== true
      ) {
        skipped.push({ threadId: referencedThreadId, reason: "not_open_direct" });
        continue;
      }
      if (seenSources.has(source.threadId)) continue;
      seenSources.add(source.threadId);
      if (!source.childSessionPath) {
        skipped.push({ threadId: referencedThreadId, reason: "child_session_unavailable" });
        continue;
      }
      sources.push(historicalBoundary ? {
        ...source,
        status: closedAtBoundary ? "closed" : "open",
        lastRunStatus: retainedSnapshot?.streamStatus === "failed"
          ? "failed"
          : retainedSnapshot?.streamStatus === "aborted"
            ? "aborted"
            : "resolved",
        label: pickString(retainedSnapshot?.label) || source.label,
        access: normalizeAccess(retainedSnapshot?.access, null),
        summary: pickString(retainedSnapshot?.summary),
        runCount: pickCount(retainedSnapshot?.runCount),
        lastRunAt: null,
        closedAt: closedAtBoundary ? nowIso() : null,
      } : source);
    }

    const busy = sources.find((source) => this.isBusy(source.threadId));
    if (busy) {
      const error: any = new Error(`subagent thread is busy: ${busy.threadId}`);
      error.code = "subagent_thread_busy";
      error.threadId = busy.threadId;
      throw error;
    }
    if (
      sources.length > 0
      && (typeof input.cloneChildSession !== "function" || typeof input.discardChildSession !== "function")
    ) {
      throw new Error("subagent thread fork child-session clone/cleanup is unavailable");
    }

    // Reserve every source thread synchronously before the first child clone
    // awaits. A concurrent reply will queue behind this gate and therefore
    // cannot move the source child leaf between boundary resolution and copy.
    const reservations = sources.map((source) => {
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      this._chains.set(source.threadId, gate);
      return { threadId: source.threadId, gate, release };
    });

    const clones = [];
    try {
      for (let index = 0; index < sources.length; index += 1) {
        const source = sources[index];
        const newThreadId = pickString(input.createThreadId?.(source, index)) || forkThreadId();
        if (this._threads.has(newThreadId)) {
          throw new Error(`subagent thread fork identity already exists: ${newThreadId}`);
        }
        let childRef;
        try {
          childRef = normalizedChildSessionRef(await input.cloneChildSession({
            sourceThread: clone(source),
            sourceParentSession: clone(sourceRef),
            targetParentSession: clone(targetRef),
            newThreadId,
            childBoundaryEntryId: pickString(input.childBoundaryEntryIds?.[source.threadId]),
            allowCurrentChildLeaf: input.allowCurrentChildLeaf === true,
          }));
        } catch (error) {
          const partialRef = normalizedChildSessionRef(
            error?.forkedChildSession || error?.createdChildSession || error?.createdSessionRef,
          );
          if (partialRef) {
            clones.push({
              sourceThreadId: source.threadId,
              newThreadId,
              sourceChildSessionId: source.childSessionId || null,
              sourceChildSessionPath: source.childSessionPath,
              targetChildSessionId: partialRef.sessionId,
              targetChildSessionPath: partialRef.sessionPath,
            });
          }
          throw error;
        }
        if (!childRef) {
          throw new Error(`subagent child SessionRef clone is invalid for ${source.threadId}`);
        }
        if (
          childRef.sessionPath === source.childSessionPath
          || (source.childSessionId && childRef.sessionId === source.childSessionId)
        ) {
          throw new Error(`subagent child Session clone is not independent for ${source.threadId}`);
        }

        const forkedAt = nowIso();
        const sourceThreadIds = uniqueStrings([
          source.threadId,
          ...(Array.isArray(source.sourceThreadIds) ? source.sourceThreadIds : []),
        ]);
        const record = normalizeThread(newThreadId, {
          kind: "direct",
          status: source.status,
          lastRunStatus: source.lastRunStatus,
          parentSessionId: targetRef.sessionId,
          parentSessionPath: targetRef.sessionPath,
          parentTaskId: source.parentTaskId,
          agentId: source.agentId,
          agentName: source.agentName,
          childSessionId: childRef.sessionId,
          childSessionPath: childRef.sessionPath,
          label: source.label,
          access: source.access,
          summary: source.summary,
          runCount: source.runCount,
          createdAt: source.createdAt,
          lastRunAt: source.lastRunAt,
          closedAt: source.status === "closed" ? (source.closedAt || forkedAt) : null,
          forkedFromThreadId: source.threadId,
          forkedAt,
          sourceThreadIds,
        });
        this._threads.set(newThreadId, record);
        clones.push({
          sourceThreadId: source.threadId,
          newThreadId,
          sourceChildSessionId: source.childSessionId || null,
          sourceChildSessionPath: source.childSessionPath,
          targetChildSessionId: childRef.sessionId,
          targetChildSessionPath: childRef.sessionPath,
        });
      }
      if (clones.length > 0) this._save();
      return {
        clones: clone(clones),
        skipped: clone(skipped),
        referencedThreadIds,
      };
    } catch (error) {
      const cleanupFailures = [];
      for (const receipt of [...clones].reverse()) {
        try {
          await input.discardChildSession(clone(receipt));
          this._threads.delete(receipt.newThreadId);
        } catch (cleanupError) {
          cleanupFailures.push({ threadId: receipt.newThreadId, error: cleanupError });
          const existing = this._threads.get(receipt.newThreadId) || null;
          this._threads.set(receipt.newThreadId, normalizeThread(receipt.newThreadId, {
            ...(existing || {}),
            kind: "direct",
            status: "closed",
            parentSessionId: targetRef.sessionId,
            parentSessionPath: targetRef.sessionPath,
            childSessionId: receipt.targetChildSessionId,
            childSessionPath: receipt.targetChildSessionPath,
            forkedFromThreadId: receipt.sourceThreadId,
            sourceThreadIds: [receipt.sourceThreadId],
            cleanupPending: true,
            cleanupError: cleanupError?.message || String(cleanupError),
            closedAt: nowIso(),
          }, existing));
        }
      }
      if (clones.length > 0) {
        try {
          this._save();
        } catch (cleanupError) {
          cleanupFailures.push({ threadId: "thread-store", error: cleanupError });
        }
      }
      throw forkCleanupError(error, clones, cleanupFailures);
    } finally {
      for (const reservation of reservations) {
        reservation.release();
        if (this._chains.get(reservation.threadId) === reservation.gate) {
          this._chains.delete(reservation.threadId);
        }
      }
    }
  }

  /** Remove cloned direct-thread records owned by one failed target Session Fork. */
  async discardForkedDirectThreads(targetSessionRef, opts: any = {}) {
    const targetKey = this._parentSessionKeyForRef(targetSessionRef);
    if (!targetKey) throw new Error("forked subagent thread cleanup requires a target Session identity");
    const records = [...this._threads.values()].filter((record) => (
      record.kind === "direct"
      && !!record.forkedFromThreadId
      && this._parentSessionKeyForRecord(record) === targetKey
    ));
    if (records.length > 0 && typeof opts.discardChildSession !== "function") {
      throw new Error("forked subagent child-session cleanup is unavailable");
    }
    const clones = [];
    const cleanupFailures = [];
    let removed = 0;
    for (const record of records.reverse()) {
      const receipt = {
        sourceThreadId: record.forkedFromThreadId,
        newThreadId: record.threadId,
        sourceChildSessionId: null,
        sourceChildSessionPath: null,
        targetChildSessionId: record.childSessionId || null,
        targetChildSessionPath: record.childSessionPath || null,
      };
      clones.push(receipt);
      try {
        await opts.discardChildSession(clone(receipt));
        this._threads.delete(record.threadId);
        removed += 1;
      } catch (error) {
        cleanupFailures.push({
          threadId: record.threadId,
          message: error?.message || String(error),
        });
        this._threads.set(record.threadId, normalizeThread(record.threadId, {
          ...record,
          status: "closed",
          cleanupPending: true,
          cleanupError: error?.message || String(error),
        }, record));
      }
    }
    if (records.length > 0) this._save();
    return { removed, clones: clone(clones), cleanupFailures };
  }

  closeDirectThread(threadId, record: any = {}) {
    if (!threadId) return null;
    const existing = this._threads.get(threadId) || null;
    if (!existing || existing.kind !== "direct") return null;
    const next = normalizeThread(threadId, {
      ...record,
      status: "closed",
      closedAt: nowIso(),
      lastRunStatus: record.lastRunStatus || existing.lastRunStatus,
    }, existing);
    this._threads.set(threadId, next);
    this._save();
    return clone(next);
  }

  remove(threadId) {
    if (!threadId || !this._threads.has(threadId)) return false;
    this._threads.delete(threadId);
    this._save();
    return true;
  }

  removeBySession(parentSessionPath) {
    if (!parentSessionPath) return 0;
    const targetKey = this._parentSessionKeyForPath(parentSessionPath);
    let removed = 0;
    for (const [id, rec] of this._threads) {
      if (this._parentSessionKeyForRecord(rec) === targetKey) {
        this._threads.delete(id);
        removed += 1;
      }
    }
    if (removed) this._save();
    return removed;
  }

  removeByAgentId(agentId) {
    if (!agentId) return 0;
    let removed = 0;
    for (const [id, rec] of this._threads) {
      if (rec.agentId === agentId) {
        this._threads.delete(id);
        removed += 1;
      }
    }
    if (removed) this._save();
    return removed;
  }

  get size() {
    return this._threads.size;
  }

  isBusy(threadId) {
    return !!threadId && this._chains.has(threadId);
  }

  runSerialized(threadId, taskFn) {
    if (!threadId) return Promise.resolve().then(() => taskFn());
    const prev = this._chains.get(threadId) || Promise.resolve();
    const run = prev.then(() => taskFn());
    const tail = run.then(() => {}, () => {});
    this._chains.set(threadId, tail);
    tail.then(() => {
      if (this._chains.get(threadId) === tail) this._chains.delete(threadId);
    });
    return tail.then(() => run);
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

  _parentSessionKeyForRecord(record) {
    return pickString(record?.parentSessionId)
      || this._sessionIdForPath(record?.parentSessionPath)
      || record?.parentSessionPath
      || null;
  }

  _save() {
    if (!this._persistPath) return;
    const data = {
      schemaVersion: SUBAGENT_THREAD_STORE_VERSION,
      threads: Object.fromEntries(this._threads.entries()),
    };
    fs.mkdirSync(path.dirname(this._persistPath), { recursive: true });
    atomicWriteSync(this._persistPath, JSON.stringify(data, null, 2) + "\n");
  }

  _load() {
    if (!this._persistPath || !fs.existsSync(this._persistPath)) return;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this._persistPath, "utf-8"));
    } catch {
      return;
    }
    const threads = raw?.threads && typeof raw.threads === "object" ? raw.threads : {};
    let repaired = raw?.schemaVersion !== SUBAGENT_THREAD_STORE_VERSION;
    for (const [threadId, value] of Object.entries(threads)) {
      if (!threadId || !value || typeof value !== "object") continue;
      const next = normalizeThread(threadId, value);
      if (next.lastRunStatus === "pending") {
        repaired = true;
        next.lastRunStatus = "failed";
        if (next.kind === "direct") {
          next.status = "open";
          next.closedAt = null;
        } else {
          next.status = "closed";
          next.closedAt = next.closedAt || next.lastRunAt || next.updatedAt || nowIso();
        }
      }
      this._threads.set(threadId, next);
    }
    if (repaired) this._save();
  }
}
