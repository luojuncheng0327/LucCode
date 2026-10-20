/**
 * DeferredResultStore — 异步后台任务结果通知存储（带磁盘持久化）
 *
 * 工具调用触发异步任务时通过 defer() 注册占位，任务完成后调用
 * resolve() 或 fail()，通知所有订阅方并向 EventBus 广播事件。
 *
 * 所有状态变更自动持久化到 JSON 文件，app 重启后能恢复。
 */

import fs from "node:fs";
import path from "node:path";
import { atomicWriteSync } from "../shared/safe-fs.ts";

const CLEANUP_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 天

function textOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeSessionRef(input, resolveSessionIdForPath = null) {
  if (typeof input === "string") {
    const sessionPath = textOrNull(input);
    const sessionId = textOrNull(resolveSessionIdForPath?.(sessionPath));
    const sessionRef = sessionId
      ? { sessionId, ...(sessionPath ? { sessionPath, legacySessionPath: sessionPath } : {}) }
      : null;
    return { sessionId, sessionPath, sessionRef };
  }
  const rawRef = input?.sessionRef && typeof input.sessionRef === "object"
    ? input.sessionRef
    : null;
  const sessionPath =
    textOrNull(input?.sessionPath)
    || textOrNull(input?.path)
    || textOrNull(rawRef?.sessionPath)
    || textOrNull(rawRef?.path);
  const sessionId =
    textOrNull(input?.sessionId)
    || textOrNull(rawRef?.sessionId)
    || textOrNull(resolveSessionIdForPath?.(sessionPath));
  const legacySessionPath =
    textOrNull(input?.legacySessionPath)
    || textOrNull(rawRef?.legacySessionPath)
    || (sessionId && sessionPath ? sessionPath : null);
  const sessionRef = sessionId
    ? {
      sessionId,
      ...(sessionPath ? { sessionPath } : {}),
      ...(legacySessionPath ? { legacySessionPath } : {}),
    }
    : null;
  return { sessionId, sessionPath, sessionRef };
}

function matchesSession(task, input, resolveSessionIdForPath = null) {
  const target = normalizeSessionRef(input, resolveSessionIdForPath);
  if (target.sessionId) {
    return task.sessionId === target.sessionId || task.sessionRef?.sessionId === target.sessionId;
  }
  return !!target.sessionPath && task.sessionPath === target.sessionPath;
}

export class DeferredResultStore {
  declare _bus: any;
  declare _cleanupTimer: any;
  declare _dirty: any;
  declare _failCbs: any;
  declare _getSessionIdForPath: any;
  declare _persistPath: any;
  declare _resultCbs: any;
  declare _saveTimer: any;
  declare _tasks: any;
  /**
   * @param {object} [bus] - EventBus 实例
   * @param {string} [persistPath] - 持久化文件路径。不传则纯内存（兼容测试）。
   */
  constructor(bus, persistPath, options: any = {}) {
    this._bus = bus || null;
    this._getSessionIdForPath = typeof options?.getSessionIdForPath === "function"
      ? options.getSessionIdForPath
      : null;
    this._persistPath = persistPath || null;
    /** @type {Map<string, { status: string, sessionId?: string|null, sessionPath: string|null, sessionRef?: object|null, meta: object, deferredAt: number, result: any, reason: any, delivered: boolean }>} */
    this._tasks = new Map();
    this._resultCbs = [];
    this._failCbs = [];
    if (this._persistPath) this._load();

    // 启动时立即清理一次 + 每 24 小时自动清理
    this.cleanup();
    this._cleanupTimer = setInterval(() => this.cleanup(), 24 * 60 * 60 * 1000);
    this._cleanupTimer.unref(); // 不阻止进程退出
  }

  dispose() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    // flush 残余脏数据
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._flushToDisk();
  }

  // ── 核心操作 ──

  defer(taskId, sessionPath, meta: any = {}) {
    if (this._tasks.has(taskId)) return;
    const sessionRef = normalizeSessionRef(sessionPath, this._getSessionIdForPath);
    this._tasks.set(taskId, {
      status: "pending",
      sessionId: sessionRef.sessionId,
      sessionPath: sessionRef.sessionPath,
      sessionRef: sessionRef.sessionRef,
      meta,
      deferredAt: Date.now(),
      result: null,
      reason: null,
      delivered: false,
    });
    this._save();
  }

  resolve(taskId, result) {
    const task = this._tasks.get(taskId);
    if (!task || task.status !== "pending") return;
    task.status = "resolved";
    task.result = result;
    this._save();

    for (const cb of this._resultCbs) {
      try { cb(taskId, task.sessionPath, result, task.meta); } catch {}
    }
    this._bus?.emit({
      type: "deferred_result",
      taskId,
      status: "success",
      result,
      meta: task.meta,
      ...(task.sessionId ? { sessionId: task.sessionId, sessionRef: task.sessionRef } : {}),
    }, task.sessionPath);
  }

  fail(taskId, reason) {
    const task = this._tasks.get(taskId);
    if (!task || task.status !== "pending") return;
    task.status = "failed";
    task.reason = reason;
    this._save();

    for (const cb of this._failCbs) {
      try { cb(taskId, task.sessionPath, reason, task.meta); } catch {}
    }
    this._bus?.emit({
      type: "deferred_result",
      taskId,
      status: "failed",
      reason,
      meta: task.meta,
      ...(task.sessionId ? { sessionId: task.sessionId, sessionRef: task.sessionRef } : {}),
    }, task.sessionPath);
  }

  retry(taskId, sessionPath, meta: any = {}) {
    const existing = this._tasks.get(taskId);
    const sessionRef = normalizeSessionRef(sessionPath, this._getSessionIdForPath);
    const next = {
      status: "pending",
      sessionId: sessionRef.sessionId,
      sessionPath: sessionRef.sessionPath,
      sessionRef: sessionRef.sessionRef,
      meta,
      deferredAt: Date.now(),
      result: null,
      reason: null,
      delivered: false,
    };
    if (existing) {
      Object.assign(existing, next);
      delete existing.deliverySuppressed;
      delete existing.suppressedAt;
      delete existing.suppressionReason;
    } else {
      this._tasks.set(taskId, next);
    }
    this._save();
  }

  abort(taskId, reason) {
    const task = this._tasks.get(taskId);
    if (!task || task.status !== "pending") return;
    task.status = "aborted";
    task.reason = reason || "user aborted";
    this._save();

    // Reuse failCbs to notify subscribers (deferred-result-ext handles delivery)
    for (const cb of this._failCbs) {
      try { cb(taskId, task.sessionPath, task.reason, task.meta); } catch {}
    }
    this._bus?.emit({
      type: "deferred_result",
      taskId,
      status: "aborted",
      reason: task.reason,
      meta: task.meta,
      ...(task.sessionId ? { sessionId: task.sessionId, sessionRef: task.sessionRef } : {}),
    }, task.sessionPath);
  }

  /** 标记任务结果已成功送达（steer 成功后调用） */
  markDelivered(taskId) {
    const task = this._tasks.get(taskId);
    if (task) {
      // Retry may fence a discarded branch while a delivery coroutine is
      // already awaiting sendCustomMessage(). That stale completion must not
      // reopen delivery by clearing the fence afterwards.
      if (task.deliverySuppressed) return false;
      task.delivered = true;
      delete task.deliverySuppressed;
      delete task.suppressedAt;
      delete task.suppressionReason;
      this._save();
      return true;
    }
    return false;
  }

  suppressDelivery(taskId, reason = "delivery suppressed") {
    const task = this._tasks.get(taskId);
    if (!task) return false;
    if (task.status === "pending") {
      task.status = "aborted";
      task.reason = reason;
    }
    task.delivered = true;
    task.deliverySuppressed = true;
    task.suppressedAt = Date.now();
    task.suppressionReason = reason;
    this._save();
    return true;
  }

  /**
   * Fence only the named tasks owned by one stable session. The returned
   * receipt can be restored synchronously if the surrounding branch commit
   * fails before any irreversible task cancellation is attempted.
   */
  suppressTaskIdsForSession(sessionRef, taskIds, reason = "discarded by session retry") {
    const ids = Array.from(new Set(
      Array.isArray(taskIds)
        ? taskIds.map(textOrNull).filter(Boolean)
        : [],
    ));
    const receipt = [];
    const suppressedTaskIds = [];
    const mismatchedTaskIds = [];
    const missingTaskIds = [];

    try {
      for (const taskId of ids) {
        const task = this._tasks.get(taskId);
        if (!task) {
          missingTaskIds.push(taskId);
          continue;
        }
        if (!matchesSession(task, sessionRef, this._getSessionIdForPath)) {
          mismatchedTaskIds.push(taskId);
          continue;
        }

        receipt.push({ taskId, task: { ...task } });
        if (task.status === "pending") {
          task.status = "aborted";
          task.reason = reason;
        }
        task.delivered = true;
        task.deliverySuppressed = true;
        task.suppressedAt = Date.now();
        task.suppressionReason = reason;
        suppressedTaskIds.push(taskId);
      }
      if (receipt.length) this._save();
    } catch (error) {
      for (const snapshot of receipt) this._tasks.set(snapshot.taskId, snapshot.task);
      if (receipt.length) this._save();
      throw error;
    }

    return {
      suppressedTaskIds,
      mismatchedTaskIds,
      missingTaskIds,
      receipt,
    };
  }

  restoreSuppressedTaskIds(receipt) {
    if (!Array.isArray(receipt) || !receipt.length) return 0;
    let restored = 0;
    for (const snapshot of receipt) {
      if (!snapshot?.taskId || !snapshot.task) continue;
      const current = this._tasks.get(snapshot.taskId);
      if (!current?.deliverySuppressed) continue;
      this._tasks.set(snapshot.taskId, { ...snapshot.task });
      restored++;
    }
    if (restored) this._save();
    return restored;
  }

  forkTerminalTasks({
    sourceSessionId,
    sourceSessionPath,
    targetSessionId,
    targetSessionPath,
    taskIdMap = {},
  }: any = {}) {
    const sourceRef = normalizeSessionRef({ sessionId: sourceSessionId, sessionPath: sourceSessionPath }, this._getSessionIdForPath);
    const targetRef = normalizeSessionRef({ sessionId: targetSessionId, sessionPath: targetSessionPath }, this._getSessionIdForPath);
    if (!sourceRef.sessionId || !targetRef.sessionId || !targetRef.sessionPath) {
      throw new Error("deferred task fork requires source and target SessionRefs");
    }
    if (sourceRef.sessionId === targetRef.sessionId) {
      throw new Error("deferred task fork target must be independent");
    }

    const createdTaskIds = [];
    try {
      for (const [sourceTaskId, targetTaskId] of Object.entries(taskIdMap || {})) {
        if (!textOrNull(sourceTaskId) || !textOrNull(targetTaskId) || sourceTaskId === targetTaskId) continue;
        const source = this._tasks.get(sourceTaskId);
        if (!source) continue;
        if (!matchesSession(source, sourceRef, this._getSessionIdForPath)) {
          throw new Error(`deferred task fork ownership mismatch: ${sourceTaskId}`);
        }
        if (source.status === "pending") {
          const error: any = new Error(`active deferred task cannot be cloned: ${sourceTaskId}`);
          error.code = "session_fork_active_task";
          error.status = 409;
          throw error;
        }
        if (this._tasks.has(targetTaskId)) {
          throw new Error(`deferred task fork identity already exists: ${targetTaskId}`);
        }
        const clone = structuredClone(source);
        clone.sessionId = targetRef.sessionId;
        clone.sessionPath = targetRef.sessionPath;
        clone.sessionRef = targetRef.sessionRef;
        clone.delivered = true;
        clone.meta = {
          ...(clone.meta || {}),
          forkedFromTaskId: sourceTaskId,
        };
        delete clone.deliverySuppressed;
        delete clone.suppressedAt;
        delete clone.suppressionReason;
        this._tasks.set(targetTaskId, clone);
        createdTaskIds.push(targetTaskId);
      }
      if (createdTaskIds.length > 0) this._save();
      return { tasks: createdTaskIds.length, taskIds: createdTaskIds };
    } catch (error) {
      for (const taskId of createdTaskIds) this._tasks.delete(taskId);
      if (createdTaskIds.length > 0) this._save();
      throw error;
    }
  }

  discardForkedTerminalTasks({ targetSessionId, taskIds = [] }: any = {}) {
    const targetId = textOrNull(targetSessionId);
    if (!targetId) throw new Error("targetSessionId is required to discard forked deferred tasks");
    let discarded = 0;
    for (const taskId of Array.isArray(taskIds) ? taskIds : []) {
      const normalizedTaskId = textOrNull(taskId);
      const task = normalizedTaskId ? this._tasks.get(normalizedTaskId) : null;
      if (!task || task.sessionId !== targetId || !textOrNull(task.meta?.forkedFromTaskId)) continue;
      this._tasks.delete(normalizedTaskId);
      discarded += 1;
    }
    if (discarded > 0) this._save();
    return { discarded };
  }

  // ── 查询 ──

  query(taskId) {
    const task = this._tasks.get(taskId);
    return task ? { ...task } : null;
  }

  listPending(sessionPath) {
    const result = [];
    for (const [taskId, task] of this._tasks) {
      if (matchesSession(task, sessionPath, this._getSessionIdForPath) && task.status === "pending") {
        result.push({ taskId, meta: task.meta, deferredAt: task.deferredAt });
      }
    }
    return result;
  }

  listBySession(sessionPath) {
    const result = [];
    for (const [taskId, task] of this._tasks) {
      if (matchesSession(task, sessionPath, this._getSessionIdForPath)) {
        result.push({ taskId, ...task });
      }
    }
    return result;
  }

  /** 列出指定 session 下已完成但未送达的任务 */
  listUndelivered(sessionPath = null) {
    const result = [];
    for (const [taskId, task] of this._tasks) {
      if ((!sessionPath || matchesSession(task, sessionPath, this._getSessionIdForPath)) && !task.delivered &&
          (task.status === "resolved" || task.status === "failed" || task.status === "aborted")) {
        result.push({ taskId, ...task });
      }
    }
    return result;
  }

  // ── 订阅 ──

  onResult(callback) {
    this._resultCbs.push(callback);
    return () => {
      const idx = this._resultCbs.indexOf(callback);
      if (idx !== -1) this._resultCbs.splice(idx, 1);
    };
  }

  onFail(callback) {
    this._failCbs.push(callback);
    return () => {
      const idx = this._failCbs.indexOf(callback);
      if (idx !== -1) this._failCbs.splice(idx, 1);
    };
  }

  // ── 清理 ──

  clearBySession(sessionPath) {
    for (const [taskId, task] of this._tasks) {
      if (matchesSession(task, sessionPath, this._getSessionIdForPath) && task.status === "pending") {
        this._tasks.delete(taskId);
      }
    }
    this._save();
  }

  suppressBySession(sessionPath, reason = "parent session unavailable") {
    let aborted = 0;
    let suppressed = 0;
    let unchanged = 0;
    for (const task of this._tasks.values()) {
      if (!matchesSession(task, sessionPath, this._getSessionIdForPath)) continue;
      if (task.status === "pending") {
        task.status = "aborted";
        task.reason = reason;
        task.delivered = true;
        task.deliverySuppressed = true;
        task.suppressedAt = Date.now();
        task.suppressionReason = reason;
        aborted++;
        continue;
      }
      if (
        !task.delivered
        && (task.status === "resolved" || task.status === "failed" || task.status === "aborted")
      ) {
        task.delivered = true;
        task.deliverySuppressed = true;
        task.suppressedAt = Date.now();
        task.suppressionReason = reason;
        suppressed++;
        continue;
      }
      unchanged++;
    }
    if (aborted || suppressed) this._save();
    return { aborted, suppressed, unchanged };
  }

  /** 清理已送达且超过 maxAge 的任务 */
  cleanup() {
    const now = Date.now();
    let changed = false;
    for (const [taskId, task] of this._tasks) {
      if (task.delivered && (now - task.deferredAt > CLEANUP_MAX_AGE)) {
        this._tasks.delete(taskId);
        changed = true;
      }
    }
    if (changed) this._save();
  }

  get size() { return this._tasks.size; }

  // ── 持久化 ──

  /** 标记脏数据，延迟 1 秒批量写盘（合并高频状态变更） */
  _save() {
    if (!this._persistPath) return;
    this._dirty = true;
    if (!this._saveTimer) {
      this._saveTimer = setTimeout(() => this._flushToDisk(), 1000);
      this._saveTimer.unref();
    }
  }

  _flushToDisk() {
    this._saveTimer = null;
    if (!this._dirty) return;
    this._dirty = false;
    try {
      const obj: any = {};
      for (const [k, v] of this._tasks) obj[k] = v;
      fs.mkdirSync(path.dirname(this._persistPath), { recursive: true });
      atomicWriteSync(this._persistPath, JSON.stringify(obj, null, 2) + "\n");
    } catch { /* best effort */ }
  }

  _load() {
    if (!this._persistPath) return;
    try {
      if (!fs.existsSync(this._persistPath)) return;
      const raw = JSON.parse(fs.readFileSync(this._persistPath, "utf-8"));
      for (const [k, v] of Object.entries(raw)) {
        const sessionRef = normalizeSessionRef(v, this._getSessionIdForPath);
        this._tasks.set(k, {
          delivered: false,
          ...(v as any),
          sessionId: (v as any)?.sessionId || sessionRef.sessionId,
          sessionRef: (v as any)?.sessionRef || sessionRef.sessionRef,
        });
      }
    } catch { /* best effort */ }
  }
}
