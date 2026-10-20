/**
 * loop-controller.ts — 循环的状态机、记账与护栏
 *
 * 只在 turn 与 turn 的缝隙里工作：通过事件总线的 turn_start / message_end /
 * turn_end 观测轮生命周期，绝不介入轮内部。护栏（轮数预算、连续失败）与
 * 守恒检查（运行中的循环必须"有闹钟 ∨ 有活跃后台工作"）是本层的硬保证，
 * 不依赖模型自觉。
 *
 * 循环以 sessionId 为键（桌面桥接统一）。事件与工具只带 sessionPath，经注入的
 * path→sessionId 解析器归位；投递层负责 sessionId→当前 locator 的解析与身份
 * 校验，会话换代（reset/new）时以 err.code === "loop_target_reset" 上抛，
 * 本层将循环终止（循环只活在一个物理会话里）。
 */
import { buildLoopKickoffMessage, buildLoopWakeupMessage, buildLoopNoticeMessage } from "./loop-messages.ts";
import { loopKeyForTarget } from "./loop-store.ts";

const FALLBACK_ALARM_REASON = "loop invariant fallback: the previous turn scheduled no alarm and left no live background work";
const BOOT_RECOVERY_REASON = "loop recovery after restart";

export class LoopError extends Error {
  declare code: string;
  constructor(code, message) {
    super(message || code);
    this.name = "LoopError";
    this.code = code;
  }
}

export class LoopController {
  declare _store: any;
  declare _alarm: any;
  declare _hasLiveBackgroundWork: any;
  declare _deliverLoopMessage: any;
  declare _recordNotice: any;
  declare _isTargetMidStream: any;
  declare _isTargetRunnable: any;
  declare _resolveSessionIdForPath: any;
  declare _resolveTargetFromSessionRef: any;
  declare _log: any;
  declare _pendingLoopTurn: Set<string>;
  declare _activeLoopTurn: Set<string>;
  declare _turnFlags: Map<string, any>;

  constructor({
    store,
    hasLiveBackgroundWork,
    deliverLoopMessage,
    recordNotice,
    isTargetMidStream,
    isTargetRunnable,
    resolveSessionIdForPath,
    resolveTargetFromSessionRef,
    log = console,
  }) {
    this._store = store;
    this._alarm = null;                            // attachAlarm 注入（相互引用，接线层一次性绑定）
    this._hasLiveBackgroundWork = hasLiveBackgroundWork;       // (target) => boolean
    this._deliverLoopMessage = deliverLoopMessage;             // (target, message) => Promise<{mode}>；换代时抛 code="loop_target_reset"
    this._recordNotice = recordNotice;                         // (target, message) => Promise<any>
    this._isTargetMidStream = isTargetMidStream;               // (target) => boolean
    this._isTargetRunnable = isTargetRunnable;                 // (target) => boolean
    this._resolveSessionIdForPath = resolveSessionIdForPath;   // (sessionPath) => sessionId|null
    this._resolveTargetFromSessionRef = resolveTargetFromSessionRef; // (ref, opts) => Promise<target|null>
    this._log = log;
    this._pendingLoopTurn = new Set();             // 键：loop key（sessionId）
    this._activeLoopTurn = new Set();
    this._turnFlags = new Map();                   // sessionPath → { key, hasError }
  }

  attachAlarm(alarm) {
    if (this._alarm) throw new Error("loop-controller: alarm already attached");
    this._alarm = alarm;
  }

  // ── 命令面 ────────────────────────────────────────────────

  targetFromSessionRef(ref, opts = {}) {
    return this._resolveTargetFromSessionRef(ref, opts);
  }

  async start(target, prompt) {
    const key = loopKeyForTarget(target);
    const existing = this._store.get(key);
    if (existing && (existing.status === "running" || existing.status === "paused")) {
      throw new LoopError("loop_already_active", "该会话已有活跃循环，先 /loop stop 再启动新的");
    }
    this._store.create(target, prompt);
    const loop = this._store.get(key);
    await this._injectLoopTurn(key, target, buildLoopKickoffMessage(loop));
    return this._store.get(key);
  }

  async stop(target) {
    const key = loopKeyForTarget(target);
    this._requireLoop(key);
    this._alarm?.cancel(key);
    this._clearRuntimeMarks(key);
    return this._store.update(key, { status: "stopped", pausedReason: null });
  }

  async pause(target, reasonCode, noticeText = null) {
    const key = loopKeyForTarget(target);
    this._requireLoop(key);
    return this._pause(key, reasonCode, noticeText);
  }

  async resume(target) {
    const key = loopKeyForTarget(target);
    const loop = this._requireLoop(key);
    if (loop.status !== "paused") {
      throw new LoopError("loop_not_paused", `循环当前状态为 ${loop.status}，只有 paused 可 resume`);
    }
    const patch: any = { status: "running", pausedReason: null, consecutiveFailures: 0 };
    if (loop.pausedReason === "budget_exhausted") patch.turnCount = 0;
    this._store.update(key, patch);
    const fresh = this._store.get(key);
    await this._injectLoopTurn(key, fresh.target, buildLoopWakeupMessage(fresh, "loop resumed"));
    return this._store.get(key);
  }

  statusForTarget(target) {
    return this._store.get(loopKeyForTarget(target));
  }

  // ── 工具面 ────────────────────────────────────────────────

  toolStatus(sessionPath) {
    const key = this._resolveKeyForSessionPath(sessionPath);
    return key ? this._store.get(key) : null;
  }

  toolSchedule(sessionPath, delaySec, reason) {
    const key = this._resolveKeyForSessionPath(sessionPath);
    if (!key) throw new LoopError("no_active_loop", "该会话没有活跃循环");
    this._requireRunning(key);
    return this._alarm.schedule(key, delaySec, reason);
  }

  async toolComplete(sessionPath, summary) {
    const key = this._resolveKeyForSessionPath(sessionPath);
    if (!key) throw new LoopError("no_active_loop", "该会话没有活跃循环");
    this._requireRunning(key);
    this._alarm?.cancel(key);
    this._clearRuntimeMarks(key);
    return this._store.update(key, {
      status: "completed",
      completedSummary: summary || null,
    });
  }

  // ── 闹钟回调面 ────────────────────────────────────────────

  async deliverWakeupTurn(key, reason) {
    const loop = this._store.get(key);
    if (!loop || loop.status !== "running") return { ok: false, mode: "suppressed" };
    try {
      return await this._injectLoopTurn(key, loop.target, buildLoopWakeupMessage(loop, reason));
    } catch (err: any) {
      if (err?.code === "loop_target_reset") {
        await this._stopForReset(key);
        return { mode: "stopped" };
      }
      throw err;
    }
  }

  pauseForDeliveryFailure(key, err) {
    void this._pause(
      key,
      "wakeup_delivery_failed",
      `（循环唤醒投递失败已重试耗尽，循环暂停：${err?.message || err}。可用 /loop resume 恢复）`,
    );
  }

  // ── 事件总线钩子 ──────────────────────────────────────────

  onTurnStart(sessionPath) {
    const key = this._resolveKeyForSessionPath(sessionPath);
    if (!key) return;                              // 快路径：无关会话零开销
    this._turnFlags.set(sessionPath, { key, hasError: false });
    if (this._pendingLoopTurn.delete(key)) this._activeLoopTurn.add(key);
  }

  onMessageEnd(sessionPath, stopReason) {
    const flags = this._turnFlags.get(sessionPath);
    if (flags && stopReason === "error") flags.hasError = true;
  }

  async onTurnEnd(sessionPath, { aborted = false } = {}) {
    const flags = this._turnFlags.get(sessionPath);
    this._turnFlags.delete(sessionPath);
    const key = flags?.key ?? this._resolveKeyForSessionPath(sessionPath);
    if (!key) return;
    const isLoopTurn = this._activeLoopTurn.delete(key);
    const loop = this._store.get(key);
    if (!loop || loop.status !== "running") return;

    const ok = !aborted && !flags?.hasError;
    if (isLoopTurn) {
      this._store.update(key, {
        turnCount: loop.turnCount + 1,
        consecutiveFailures: ok ? 0 : loop.consecutiveFailures + 1,
      });
    }

    const fresh = this._store.get(key);
    if (fresh.turnCount >= fresh.limits.maxTurns) {
      await this._pause(key, "budget_exhausted",
        `（循环已用完 ${fresh.limits.maxTurns} 轮预算，自动暂停。/loop resume 可重置并继续）`);
      return;
    }
    if (fresh.consecutiveFailures >= fresh.limits.maxConsecutiveFailures) {
      await this._pause(key, "consecutive_failures",
        `（循环连续 ${fresh.consecutiveFailures} 轮失败，自动暂停。排查后可 /loop resume）`);
      return;
    }
    // 桌面 followUp 连续轮尚未收束时不做守恒检查，留给整串的最后一个 turn_end；
    // 桥接轮是单发外呼，无连续轮概念，注入的判定器恒 false。
    if (this._isTargetMidStream(fresh.target)) return;
    if (!fresh.alarm && !this._hasLiveBackgroundWork(fresh.target)) {
      // 守恒检查：运行中的循环必须"有闹钟 ∨ 有活跃后台工作"。模型忘了续约 →
      // 补兜底闹钟，循环绝不静默停摆。
      try {
        this._alarm.schedule(key, fresh.limits.fallbackDelaySec, FALLBACK_ALARM_REASON);
        this._log.info?.(`[loop] invariant fallback alarm armed for ${key}`);
      } catch (err) {
        this._log.warn?.(`[loop] invariant fallback arming failed for ${key}: ${err?.message}`);
      }
    }
  }

  // ── 启动恢复 / 收尾 ───────────────────────────────────────

  recoverAtBoot() {
    for (const loop of this._store.listByStatus("running")) {
      if (!this._isTargetRunnable(loop.target)) {
        this._store.update(loop.key, { status: "stopped", pausedReason: "target_unavailable" });
      }
    }
    this._alarm?.rehydrate();
    for (const loop of this._store.listByStatus("running")) {
      if (!this._store.get(loop.key).alarm) {
        // 重启丢失了运行时上下文，模型不会自己醒来 → 守恒兜底
        try {
          this._alarm.schedule(loop.key, loop.limits.fallbackDelaySec, BOOT_RECOVERY_REASON);
        } catch (err) {
          this._log.warn?.(`[loop] boot recovery arming failed for ${loop.key}: ${err?.message}`);
        }
      }
    }
  }

  dispose() {
    this._pendingLoopTurn.clear();
    this._activeLoopTurn.clear();
    this._turnFlags.clear();
  }

  /** 测试专用：模拟"下一轮由循环触发"的 pending 标记。 */
  markPendingLoopTurnForTest(key) {
    this._pendingLoopTurn.add(key);
  }

  // ── 内部 ─────────────────────────────────────────────────

  _resolveKeyForSessionPath(sessionPath) {
    if (!sessionPath) return null;
    const sessionId = this._resolveSessionIdForPath(sessionPath);
    if (!sessionId) return null;
    return this._store.get(sessionId) ? sessionId : null;
  }

  _requireLoop(key) {
    const loop = this._store.get(key);
    if (!loop) throw new LoopError("no_loop", "该会话没有循环");
    return loop;
  }

  _requireRunning(key) {
    const loop = this._requireLoop(key);
    if (loop.status !== "running") {
      throw new LoopError("loop_not_running", `循环当前状态为 ${loop.status}`);
    }
    return loop;
  }

  _clearRuntimeMarks(key) {
    this._pendingLoopTurn.delete(key);
    this._activeLoopTurn.delete(key);
    for (const [sp, flags] of [...this._turnFlags]) {
      if (flags.key === key) this._turnFlags.delete(sp);
    }
  }

  async _stopForReset(key) {
    this._alarm?.cancel(key);
    this._clearRuntimeMarks(key);
    const loop = this._store.update(key, { status: "stopped", pausedReason: "session_reset" });
    // 尽力通知：桥接目标发到聊天；桌面目标会话已换代，通知投递失败仅记日志
    try {
      await this._recordNotice(loop.target, buildLoopNoticeMessage("（会话已重置，循环终止。需要的话在新会话里重新 /loop）"));
    } catch (err) {
      this._log.warn?.(`[loop] reset notice failed for ${key}: ${err?.message}`);
    }
  }

  async _pause(key, reasonCode, noticeText) {
    this._alarm?.cancel(key);
    this._clearRuntimeMarks(key);
    this._store.update(key, { status: "paused", pausedReason: reasonCode });
    if (noticeText) {
      const loop = this._store.get(key);
      try {
        await this._recordNotice(loop.target, buildLoopNoticeMessage(noticeText));
      } catch (err) {
        this._log.warn?.(`[loop] pause notice failed for ${key}: ${err?.message}`);
      }
    }
    return this._store.get(key);
  }

  async _injectLoopTurn(key, target, message) {
    // 在投递前标记 pending，避免 turn_start 事件抢在返回值处理之前到达
    this._pendingLoopTurn.add(key);
    let delivery;
    try {
      delivery = await this._deliverLoopMessage(target, message);
    } catch (err) {
      this._pendingLoopTurn.delete(key);
      throw err;
    }
    if (delivery?.mode === "followUp") {
      this._pendingLoopTurn.delete(key);
      this._activeLoopTurn.add(key);
    } else if (delivery?.mode !== "triggerTurn") {
      this._pendingLoopTurn.delete(key);           // busy / suppressed / notifyOnly 均不留标记
    }
    return delivery;
  }
}
