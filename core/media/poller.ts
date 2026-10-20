/**
 * core/media/poller.ts
 *
 * Background poller with age-based smart intervals.
 * Every 5 s the poller ticks; how often each task is actually queried
 * depends on how old the submission is.
 *
 * Key difference from the dreamina poller: instead of calling runCli("query_result")
 * directly, this routes through the adapter registry — adapter.query(taskId, ctx).
 * Also supports "fake-async" detection: if the task already has files when polled
 * (e.g. a synchronous adapter populated files at submit time), it skips the query
 * and marks the task successful immediately.
 */

import { dirname, join as pathJoin } from "node:path";
import { readImageSize } from "./image-size.ts";
import { isResponseDelivery } from "./image-task-runner.ts";

const TICK_MS = 5_000;
const TWO_MINUTES = 2 * 60 * 1000;
const TEN_MINUTES = 10 * 60 * 1000;
const MAX_CONSECUTIVE_ERRORS = 5;

function callLogger(logger, level, args, fallbackLevel = null) {
  const fn = typeof logger?.[level] === "function"
    ? logger[level]
    : fallbackLevel && typeof logger?.[fallbackLevel] === "function"
      ? logger[fallbackLevel]
      : null;
  if (!fn) return;
  try {
    fn.call(logger, ...args);
  } catch {
    // Logging must never break media task recovery, cancellation, or polling.
  }
}

function createSafeLogger(logger) {
  return {
    log: (...args) => callLogger(logger, "log", args, "info"),
    info: (...args) => callLogger(logger, "info", args, "log"),
    warn: (...args) => callLogger(logger, "warn", args),
    error: (...args) => callLogger(logger, "error", args),
  };
}

/**
 * Decide whether this tick should trigger a real adapter query for a task.
 *
 * @param {number} ageMs     Milliseconds since task was created
 * @param {number} tickCount Monotonically-increasing tick counter (starts at 1)
 * @returns {boolean}
 */
export function shouldCheckThisTick(ageMs, tickCount) {
  if (ageMs < TWO_MINUTES) return true;               // < 2 min: every tick
  if (ageMs < TEN_MINUTES) return tickCount % 3 === 0; // 2-10 min: every 3rd
  return tickCount % 6 === 0;                           // 10 min+: every 6th
}

export class Poller {
  declare _active: any;
  declare _bus: any;
  declare _cancelled: any;
  declare _dataDir: any;
  declare _errorCounts: any;
  declare _generatedDir: any;
  declare _log: any;
  declare _registerSessionFile: any;
  declare _registry: any;
  declare _store: any;
  declare _tickCount: any;
  declare _timer: any;
  /**
   * @param {{
   *   store: import("./task-store.ts").TaskStore,
   *   registry: import("./adapter-registry.ts").AdapterRegistry,
 *   bus: object,
	 *   dataDir?: string,
	 *   generatedDir: string,
	 *   log: object,
	 *   registerSessionFile?: Function,
	 * }} opts
	 */
  constructor({ store, registry, bus, dataDir, generatedDir, log, registerSessionFile }) {
    this._store        = store;
    this._registry     = registry;
    this._bus          = bus;
    this._dataDir      = dataDir || dirname(generatedDir);
    this._generatedDir = generatedDir;
    this._log          = createSafeLogger(log);
    this._registerSessionFile = registerSessionFile || null;

    /** @type {Set<string>} taskIds being tracked */
    this._active    = new Set();
    this._timer     = null;
    this._tickCount = 0;
    /** @type {Map<string, number>} consecutive query error counts per taskId */
    this._errorCounts = new Map();
    /** @type {Set<string>} taskIds cancelled — fence against in-flight queries */
    this._cancelled = new Set();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  get running() {
    return this._timer !== null;
  }

  /**
   * Add a taskId to the active polling set.
   * @param {string} taskId
   */
  add(taskId) {
    this._cancelled.delete(taskId);
    this._errorCounts.delete(taskId);
    this._active.add(taskId);
  }

  /**
   * Check whether a taskId is in the active set.
   * @param {string} taskId
   * @returns {boolean}
   */
  hasPending(taskId) {
    return this._active.has(taskId);
  }

  /**
   * Cancel a task. Adds to cancellation fence so in-flight queries are ignored.
   * @param {string} taskId
   */
  cancel(taskId) {
    if (!this._active.has(taskId)) return;
    const task = this._store.get(taskId);
    this._cancelled.add(taskId);
    this._active.delete(taskId);
    this._errorCounts.delete(taskId);
    this._store.update(taskId, {
      status: "cancelled",
      failReason: "user cancelled",
      completedAt: new Date().toISOString(),
    });
    if (!isResponseDelivery(task)) {
      this._bus.request("deferred:abort", { taskId, reason: "user cancelled" }).catch(() => {});
      this._bus.request("task:remove", { taskId }).catch(() => {});
    }
    this._log.info(`[media] task ${taskId} cancelled by user`);
  }

  /**
   * Recover pending tasks from the store and start the polling interval.
   */
  start() {
    const pending = this._store.listPending();
    for (const task of pending) {
      if (task.submitState === "submitting" && !task.adapterTaskId && !(task.files?.length)) {
        const reason = "generation interrupted before provider submission completed";
        this._store.update(task.taskId, {
          status: "failed",
          failReason: reason,
          submitState: "failed",
          completedAt: new Date().toISOString(),
        });
        this._bus.request("deferred:fail", { taskId: task.taskId, error: { message: reason } }).catch(() => {});
        this._bus.request("task:remove", { taskId: task.taskId }).catch(() => {});
        continue;
      }
      this._active.add(task.taskId);
      if (isResponseDelivery(task)) continue;
      // Re-register in DeferredResultStore so resolve/fail notifications work after restart
      this._bus.request("deferred:register", {
        taskId: task.taskId,
        sessionPath: task.sessionPath,
        meta: {
          type: task.type === "video" ? "video-generation" : "image-generation",
          mediaKind: task.type === "video" ? "video" : "image",
          deliveryIntent: "ui_only",
          triggerParentTurn: false,
          ...(task.type === "image" ? { notifyAgentOnFailure: true } : {}),
          prompt: task.prompt,
          ...(task.deliveryTarget ? { deliveryTarget: task.deliveryTarget } : {}),
        },
      }).catch(() => {}); // ignore if no active session yet
      // Re-register in TaskRegistry so the task is visible and cancellable
      this._bus.request("task:register", {
        taskId: task.taskId,
        type: "media-generation",
        parentSessionPath: task.sessionPath,
        meta: {
          type: task.type === "video" ? "video-generation" : "image-generation",
          ...(task.deliveryTarget ? { deliveryTarget: task.deliveryTarget } : {}),
        },
      }).catch(() => {});
    }
    if (pending.length > 0) {
      this._log.info(`[media] poller recovered ${pending.length} pending task(s)`);
    }

    this._timer = setInterval(() => this._tick(), TICK_MS);
  }

  /**
   * Stop the polling interval.
   */
  stop() {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Immediately check a task outside the interval, useful when a background
   * submit just produced local files and the UI can be updated without waiting
   * for the next 5s tick.
   * @param {string} taskId
   */
  async checkNow(taskId) {
    if (!this._active.has(taskId)) return;
    const task = this._store.get(taskId);
    if (!task || task.status !== "pending") return;
    try {
      await this._checkTask(taskId, task);
    } catch (err) {
      this._log.error(`[media] checkNow unexpected error for ${taskId}:`, err);
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  async _readImageDimensions(files) {
    if (!files?.length) return { imageWidth: null, imageHeight: null };
    const filePath = pathJoin(this._generatedDir, files[0]);
    const size = await readImageSize(filePath).catch(() => null);
    return size
      ? { imageWidth: (size as any).width, imageHeight: (size as any).height }
      : { imageWidth: null, imageHeight: null };
  }

  _registerGeneratedFiles(task, files) {
    if (isResponseDelivery(task)) return [];
    const sessionId = typeof task?.sessionId === "string" && task.sessionId.trim()
      ? task.sessionId.trim()
      : task?.sessionRef?.sessionId || null;
    const sessionPath = typeof task?.sessionPath === "string" && task.sessionPath.trim()
      ? task.sessionPath.trim()
      : task?.sessionRef?.sessionPath || null;
    const sessionRef = task?.sessionRef || (sessionId ? {
      sessionId,
      ...(sessionPath ? { sessionPath } : {}),
    } : null);
    if (!this._registerSessionFile || (!sessionId && !sessionPath) || !files?.length) return [];
    const sessionFiles = [];
    for (const file of files) {
      const filePath = pathJoin(this._generatedDir, file);
      try {
        const sessionFile = this._registerSessionFile({
          ...(sessionId ? { sessionId } : {}),
          ...(sessionPath ? { sessionPath } : {}),
          ...(sessionRef ? { sessionRef } : {}),
          filePath,
          label: file,
          origin: "plugin_output",
          storageKind: "plugin_data",
        });
        if (sessionFile) sessionFiles.push(sessionFile);
      } catch (err) {
        this._log.error(`[media] register generated file failed for ${file}:`, err?.message || err);
      }
    }
    return sessionFiles;
  }

  _emitTaskDone(task, files, dims, sessionFiles) {
    const latest = this._store.get(task.taskId) || task;
    this._bus.emit({
      type: "media-gen:task-done",
      taskId: task.taskId,
      batchId: task.batchId || null,
      kind: task.type === "video" ? "video" : "image",
      files: Array.isArray(files) ? files : [],
      generatedDir: this._generatedDir,
      sessionFiles: Array.isArray(sessionFiles) ? sessionFiles : [],
      imageWidth: dims?.imageWidth ?? latest.imageWidth ?? null,
      imageHeight: dims?.imageHeight ?? latest.imageHeight ?? null,
      providerId: latest.providerId || null,
      modelId: latest.modelId || null,
      protocolId: latest.protocolId || null,
      metadata: latest.metadata || null,
      task: latest,
      ...(latest.sessionId ? { sessionId: latest.sessionId, sessionRef: latest.sessionRef || null } : {}),
    }, task.sessionPath || null);
  }

  _tick() {
    this._tickCount += 1;
    const tick = this._tickCount;

    for (const taskId of [...this._active]) {
      const task = this._store.get(taskId);

      // Task disappeared from store or was already resolved — drop it.
      if (!task || task.status !== "pending") {
        this._active.delete(taskId);
        this._errorCounts.delete(taskId);
        continue;
      }

      const ageMs = Date.now() - new Date(task.createdAt).getTime();
      if (!shouldCheckThisTick(ageMs, tick)) continue;

      // Fire-and-forget; errors are caught inside _checkTask.
      this._checkTask(taskId, task).catch((err) => {
        this._log.error(`[media] _checkTask unexpected error for ${taskId}:`, err);
      });
    }
  }

  /**
   * Check a single task. If the task already has files (fake-async / synchronous
   * adapter), mark it done immediately without querying the adapter. Otherwise
   * route through the adapter registry.
   *
   * @param {string} taskId
   * @param {object} task   Shallow copy from store.get()
   */
  async _checkTask(taskId, task) {
    // Cancellation fence: if cancel() was called while a query was in-flight, bail out.
    if (this._cancelled.has(taskId)) return;

    // Fake-async: adapter populated files synchronously during submit.
    if (task.files && task.files.length > 0) {
      const dims = await this._readImageDimensions(task.files);
      const sessionFiles = this._registerGeneratedFiles(task, task.files);
      this._store.update(taskId, {
        status: "done",
        ...dims,
        ...(sessionFiles.length ? { sessionFiles } : {}),
        completedAt: new Date().toISOString(),
      });
      this._active.delete(taskId);
      if (!isResponseDelivery(task)) {
        this._bus.request("task:remove", { taskId }).catch(() => {});
        await this._bus.request("deferred:resolve", {
          taskId,
          files: task.files,
          ...(sessionFiles.length ? { sessionFiles } : {}),
        });
      }
      this._emitTaskDone(task, task.files, dims, sessionFiles);
      return;
    }

    if (task.submitState === "submitting" && !task.adapterTaskId) {
      return;
    }

    // Real async: delegate to the adapter.
    const adapter = (task.protocolId && this._registry.getProtocol?.(task.protocolId))
      || this._registry.get(task.adapterId)
      || this._registry.get(task.providerId);
    if (!adapter) {
      const err = new Error(`[media] no adapter registered for "${task.adapterId}"`);
      this._store.update(taskId, {
        status: "failed",
        failReason: err.message,
        completedAt: new Date().toISOString(),
      });
      this._active.delete(taskId);
      if (!isResponseDelivery(task)) {
        this._bus.request("task:remove", { taskId }).catch(() => {});
        await this._bus.request("deferred:fail", { taskId, error: err });
      }
      return;
    }

    const baseCtx = {
      dataDir: this._dataDir,
      generatedDir: this._generatedDir,
      bus: this._bus,
      log: this._log,
      task,
    };
    const ctx = this._registry.createSubmitContextForAdapter?.(adapter, baseCtx) || baseCtx;

    let result;
    try {
      result = await adapter.query(task.adapterTaskId || taskId, ctx);
      // Re-check cancellation fence after await — cancel() may have fired while query was in-flight
      if (this._cancelled.has(taskId)) return;
    } catch (err) {
      const count = (this._errorCounts.get(taskId) || 0) + 1;
      this._errorCounts.set(taskId, count);
      if (count < MAX_CONSECUTIVE_ERRORS) {
        this._log.warn(`[media] query ${taskId} failed (${count}/${MAX_CONSECUTIVE_ERRORS}), will retry: ${err?.message ?? err}`);
        return;
      }
      this._log.error(`[media] query ${taskId} failed ${count} times, giving up`);
      this._errorCounts.delete(taskId);
      this._store.update(taskId, {
        status: "failed",
        failReason: err?.message ?? String(err),
        completedAt: new Date().toISOString(),
      });
      this._active.delete(taskId);
      this._bus.request("task:remove", { taskId }).catch(() => {});
      await this._bus.request("deferred:fail", { taskId, error: err });
      return;
    }

    // Query succeeded — reset consecutive error counter
    this._errorCounts.delete(taskId);

    const { status } = result ?? {};

    if (status === "success" || status === "done") {
      const files = result.files ?? [];
      const dims = await this._readImageDimensions(files);
      const sessionFiles = this._registerGeneratedFiles(task, files);
      this._store.update(taskId, {
        status: "done",
        files,
        ...(sessionFiles.length ? { sessionFiles } : {}),
        ...dims,
        completedAt: new Date().toISOString(),
      });
      this._active.delete(taskId);
      if (!isResponseDelivery(task)) {
        this._bus.request("task:remove", { taskId }).catch(() => {});
        await this._bus.request("deferred:resolve", {
          taskId,
          files,
          ...(sessionFiles.length ? { sessionFiles } : {}),
        });
      }
      this._emitTaskDone(task, files, dims, sessionFiles);
      return;
    }

    if (status === "failed") {
      const failReason = result.failReason ?? result.error?.message ?? "generation failed";
      this._store.update(taskId, {
        status: "failed",
        failReason,
        completedAt: new Date().toISOString(),
      });
      this._active.delete(taskId);
      if (!isResponseDelivery(task)) {
        this._bus.request("task:remove", { taskId }).catch(() => {});
        await this._bus.request("deferred:fail", {
          taskId,
          error: result.error ?? { code: "GEN_FAILED", message: failReason },
        });
      }
      return;
    }

    // status === "pending" or anything else — leave in active set, retry next tick.
  }
}
