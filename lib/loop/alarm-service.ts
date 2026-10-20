/**
 * alarm-service.ts — 循环级单槽闹钟（键 = 循环键，即 sessionId）
 *
 * 兜底唤醒的定时层：每个循环至多一个待触发闹钟，新约替换旧约。
 * 后台工作完成的事件驱动投递是主唤醒路径；闹钟只兜"事件永远不来"的底，
 * 因此存在活跃后台任务时拒绝短闹钟——轮询后台任务这条路在机制层走不通。
 *
 * 投递结果语义：
 *   - "busy"：目标暂不可注入（桥接侧与入站消息互斥），顺延 60 秒重试，有限次
 *   - "suppressed"：本次无效投递，按失败重试
 *   - 抛错：按退避重试，耗尽后 fail-closed 交给钩子暂停循环
 *   - 其余模式（triggerTurn/followUp/notifyOnly/stopped）：终态，唤醒流程结束
 */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;           // 定时器上限，超过则链式续接
const DELIVERY_RETRY_DELAYS_MS = [5_000, 25_000, 125_000];
const BUSY_DEFER_MS = 60_000;
const MAX_BUSY_DEFERRALS = 30;
const OVERDUE_JITTER_MIN_MS = 1_000;
const OVERDUE_JITTER_MAX_MS = 5_000;

function sleep(ms) {
  return new Promise((resolve) => { const t = setTimeout(resolve, ms); (t as any).unref?.(); });
}

export class LoopAlarmError extends Error {
  declare code: string;
  constructor(code, message) {
    super(message);
    this.name = "LoopAlarmError";
    this.code = code;
  }
}

export class LoopAlarmService {
  declare _store: any;
  declare _deliverWakeup: any;
  declare _hasLiveBackgroundWork: any;
  declare _hooks: any;
  declare _log: any;
  declare _timers: Map<string, any>;
  declare _busyDeferrals: Map<string, number>;

  constructor({ store, deliverWakeup, hasLiveBackgroundWork, hooks = {}, log = console }) {
    this._store = store;
    this._deliverWakeup = deliverWakeup;               // (key, reason) => Promise<{mode}>
    this._hasLiveBackgroundWork = hasLiveBackgroundWork; // (target) => boolean
    this._hooks = hooks;
    this._log = log;
    this._timers = new Map();
    this._busyDeferrals = new Map();
  }

  schedule(key, delaySec, reason) {
    const loop = this._store.get(key);
    if (!loop) throw new LoopAlarmError("no_active_loop", `no_active_loop: ${key}`);
    if (loop.status !== "running") {
      throw new LoopAlarmError("loop_not_running", `loop_not_running: status=${loop.status}`);
    }
    const limits = loop.limits;
    const effectiveDelaySec = Math.max(Number(delaySec) || 0, limits.minDelaySec);
    if (this._hasLiveBackgroundWork(loop.target) && effectiveDelaySec < limits.guardedMinDelaySec) {
      throw new LoopAlarmError(
        "short_alarm_with_live_work",
        `Background work in this session wakes it automatically on completion; do not schedule alarms to poll it. `
        + `While background work is live, alarms must be long fallbacks (>= ${limits.guardedMinDelaySec}s).`,
      );
    }
    const wakeAt = Date.now() + effectiveDelaySec * 1000;
    this._store.update(key, { alarm: { wakeAt, reason: reason || "" } });
    this._busyDeferrals.delete(key);
    this._arm(key, wakeAt);
    return { wakeAt, effectiveDelaySec };
  }

  cancel(key) {
    this._clearTimer(key);
    this._busyDeferrals.delete(key);
    const loop = this._store.get(key);
    if (loop?.alarm) this._store.update(key, { alarm: null });
  }

  rehydrate() {
    for (const loop of this._store.listByStatus("running")) {
      if (!loop.alarm) continue;
      const overdue = loop.alarm.wakeAt <= Date.now();
      const wakeAt = overdue
        ? Date.now() + OVERDUE_JITTER_MIN_MS
          + Math.floor(Math.random() * (OVERDUE_JITTER_MAX_MS - OVERDUE_JITTER_MIN_MS))
        : loop.alarm.wakeAt;
      this._arm(loop.key, wakeAt);
    }
  }

  dispose() {
    for (const key of [...this._timers.keys()]) this._clearTimer(key);
    this._busyDeferrals.clear();
  }

  _clearTimer(key) {
    const entry = this._timers.get(key);
    if (entry) {
      clearTimeout(entry.timer);
      this._timers.delete(key);
    }
  }

  _arm(key, wakeAt) {
    this._clearTimer(key);
    const delay = Math.max(0, wakeAt - Date.now());
    const step = Math.min(delay, MAX_TIMER_DELAY_MS);
    const timer = setTimeout(() => {
      this._timers.delete(key);
      if (wakeAt - Date.now() > 500) {
        this._arm(key, wakeAt);                    // 链式续接超长延迟
        return;
      }
      void this._fire(key);
    }, step);
    (timer as any).unref?.();
    this._timers.set(key, { timer, wakeAt });
  }

  async _fire(key) {
    const loop = this._store.get(key);
    if (!loop || loop.status !== "running" || !loop.alarm) return;
    const reason = loop.alarm.reason;
    // 先清槽再投递：投递触发的轮里模型可立即再约，不会撞上旧槽。
    this._store.update(key, { alarm: null });
    let lastError = null;
    for (let attempt = 0; attempt <= DELIVERY_RETRY_DELAYS_MS.length; attempt++) {
      try {
        const delivery = await this._deliverWakeup(key, reason);
        if (delivery?.mode === "busy") {
          this._deferBusy(key, reason);
          return;
        }
        if (delivery && delivery.mode !== "suppressed") {
          this._busyDeferrals.delete(key);
          return;
        }
        lastError = new Error("wakeup delivery suppressed");
      } catch (err) {
        lastError = err;
      }
      if (attempt < DELIVERY_RETRY_DELAYS_MS.length) {
        await sleep(DELIVERY_RETRY_DELAYS_MS[attempt]);
      }
    }
    this._log.warn?.(`[loop-alarm] wakeup delivery exhausted for ${key}: ${lastError?.message}`);
    this._hooks.onDeliveryExhausted?.(key, lastError);
  }

  _deferBusy(key, reason) {
    const count = (this._busyDeferrals.get(key) || 0) + 1;
    if (count > MAX_BUSY_DEFERRALS) {
      this._busyDeferrals.delete(key);
      this._log.warn?.(`[loop-alarm] busy deferrals exhausted for ${key}`);
      this._hooks.onDeliveryExhausted?.(key, new Error("wakeup deferred too long: target stayed busy"));
      return;
    }
    this._busyDeferrals.set(key, count);
    const wakeAt = Date.now() + BUSY_DEFER_MS;
    // busy 顺延要把槽写回去：守恒检查依赖"槽里有闹钟"这个事实
    this._store.update(key, { alarm: { wakeAt, reason } });
    this._arm(key, wakeAt);
  }
}
