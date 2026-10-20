import {
  buildDeferredResultMessage,
  buildDeferredResultRecord,
  DEFERRED_RESULT_RECORD_TYPE,
  isUiOnlyDeferredResultTask,
  shouldNotifyAgentOnFailure,
} from "./deferred-result-notification.ts";

const DEFAULT_RETRY_INTERVAL_MS = 30_000;

function isDeliverable(task) {
  return task && !task.delivered && (
    task.status === "resolved" ||
    task.status === "failed" ||
    task.status === "aborted"
  );
}

function shouldTriggerParentTurn(task) {
  if (shouldNotifyAgentOnFailure(task)) return true;
  if (task?.meta?.triggerParentTurn === false) return false;
  if (task?.meta?.deliveryIntent === "notify_ui_only") return false;
  if (task?.meta?.deliveryIntent === "trigger_parent_turn") return true;
  return task?.status === "resolved";
}

function isExternallyDeliveredTask(task) {
  return task?.meta?.deliveryTarget?.kind === "bridge";
}

export class DeferredResultCoordinator {
  declare _inFlight: any;
  declare _retryTimer: any;
  declare _started: any;
  declare _unsubs: any;
  declare log: any;
  declare recordCustomEntry: any;
  declare retryIntervalMs: any;
  declare sessionCoordinator: any;
  declare store: any;
  constructor({
    store,
    sessionCoordinator,
    retryIntervalMs = DEFAULT_RETRY_INTERVAL_MS,
    log = console,
    recordCustomEntry = sessionCoordinator?.recordCustomEntry?.bind(sessionCoordinator),
  }) {
    this.store = store;
    this.sessionCoordinator = sessionCoordinator;
    this.recordCustomEntry = recordCustomEntry;
    this.retryIntervalMs = retryIntervalMs;
    this.log = log;
    this._unsubs = [];
    this._retryTimer = null;
    this._started = false;
    this._inFlight = new Map();
  }

  start() {
    if (this._started) return;
    this._started = true;
    this._unsubs.push(this.store.onResult((taskId) => {
      this.deliverTask(taskId);
    }));
    this._unsubs.push(this.store.onFail((taskId) => {
      this.deliverTask(taskId);
    }));

    if (this.retryIntervalMs > 0) {
      this._retryTimer = setInterval(() => {
        this.flushUndelivered().catch((err) => {
          this.log.warn?.(`[deferred-result] flush failed: ${err.message}`);
        });
      }, this.retryIntervalMs);
      this._retryTimer.unref?.();
    }
  }

  dispose() {
    for (const unsub of this._unsubs.splice(0)) {
      try { unsub(); } catch {}
    }
    if (this._retryTimer) {
      clearInterval(this._retryTimer);
      this._retryTimer = null;
    }
    this._started = false;
  }

  async flushUndelivered(sessionPath?) {
    const tasks = this.store.listUndelivered(sessionPath);
    for (const task of tasks) {
      await this.deliverTask(task.taskId);
    }
  }

  async deliverTask(taskId) {
    const existing = this._inFlight.get(taskId);
    if (existing) return existing;

    const promise = this._deliverTask(taskId).finally(() => {
      this._inFlight.delete(taskId);
    });
    this._inFlight.set(taskId, promise);
    return promise;
  }

  async _deliverTask(taskId) {
    const task = this.store.query(taskId);
    if (!isDeliverable(task)) return false;
    if (isExternallyDeliveredTask(task)) return false;
    if (isUiOnlyDeferredResultTask(task) && !shouldNotifyAgentOnFailure(task)) {
      return await this._recordUiOnlyTask(taskId, task);
    }

    if (
      typeof this.sessionCoordinator.isRunnableSessionPath === "function"
      && !this.sessionCoordinator.isRunnableSessionPath(task.sessionPath)
    ) {
      this.store.suppressDelivery?.(taskId, "parent session is no longer active");
      return false;
    }

    try {
      const shouldDeliver = () => this.store.query(taskId)?.deliverySuppressed !== true;
      if (!shouldDeliver()) return false;
      const delivery = await this.sessionCoordinator.deliverCustomMessage(
        task.sessionPath,
        buildDeferredResultMessage(taskId, task),
        { triggerTurn: shouldTriggerParentTurn(task), shouldDeliver },
      );
      if (delivery?.mode === "suppressed") return false;
      this.store.markDelivered(taskId);
      return true;
    } catch (err) {
      this.log.warn?.(`[deferred-result] delivery failed for ${taskId}: ${err.message}`);
      return false;
    }
  }

  async _recordUiOnlyTask(taskId, task) {
    if (typeof this.recordCustomEntry !== "function") {
      this.log.warn?.(`[deferred-result] UI-only delivery unavailable for ${taskId}`);
      return false;
    }
    if (
      typeof this.sessionCoordinator?.isRunnableSessionPath === "function"
      && !this.sessionCoordinator.isRunnableSessionPath(task.sessionPath)
    ) {
      this.store.suppressDelivery?.(taskId, "parent session is no longer active");
      return false;
    }
    try {
      await this.recordCustomEntry(
        task.sessionPath,
        DEFERRED_RESULT_RECORD_TYPE,
        buildDeferredResultRecord(taskId, task),
      );
      this.store.markDelivered(taskId);
      return true;
    } catch (err) {
      this.log.warn?.(`[deferred-result] UI-only record failed for ${taskId}: ${err.message}`);
      return false;
    }
  }
}
