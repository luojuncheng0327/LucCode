/**
 * memory-ticker.js — 记忆调度器（v4：按天滚动记忆传送带 + today 水位线增量）
 *
 * 触发机制改为 turn-based：
 * - 每 10 轮：滚动摘要 + compileToday + assemble
 * - session 结束：final 滚动摘要 + compileToday + assemble
 * - 每天一次（日期变化时触发）：compileDaily（把昨天最终版 today 草稿蒸馏成日记）
 *   + compileToday（今日水位线增量，日期切换后重置草稿）+ rollDailyWindow（滚出
 *   窗口的 daily 条目 fold 进 longterm）+ compileEditableFacts + assemble（含
 *   assembleWeekFromDaily 纯文件装配 week.md）+ deep-memory
 *
 * compileDaily 必须先于 compileToday 执行：compileDaily 读取的是"昨天最终版
 * today.md 草稿"，这份草稿在日期切换前仍然躺在 todayMdPath 里；compileToday
 * 一旦先跑，日期切换会把 today.md 重置成新一天的空白草稿，昨天的内容就再也
 * 读不到了。
 *
 * session 关闭记忆时，整条记忆流水线都应跳过，避免被写入 summary/facts。
 *
 * facts.md 是唯一的 facts 产物：曾经的 `memory.editable_facts` 实验已毕业，
 * 增量编译（compileEditableFacts）是唯一路径。创建 ticker 时会先跑一次幂等的
 * 读时迁移，把 alpha 阶段遗留的 editable-facts.md 并入 facts.md。
 *
 * week 段不再是独立 LLM 编译产物：旧版 compileWeek（过去 7 天摘要整周编译）已
 * 退役，week.md 改为从 memory/daily/ 目录纯文件装配最近 6 个已结束逻辑日的日记条目
 * （assembleWeekFromDaily，零 LLM）。创建 ticker 时会先跑一次幂等的读时迁移
 * （migrateLegacyWeekToLongterm），把旧版 week.md 整段 fold 进 longterm 一次，
 * daily 传送带自迁移日起独立积累。
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { debugLog, createModuleLogger } from "../debug-log.ts";
import {
  compileToday,
  compileDaily,
  assembleWeekFromDaily,
  rollDailyWindow,
  compileEditableFacts,
  assemble,
  ensureEditableFactsBaseline,
  migrateLegacyEditableFacts,
  migrateLegacyWeekToLongterm,
} from "./compile.ts";
import { processDirtySessions } from "./deep-memory.ts";
import { getLogicalDay, shiftLogicalDate } from "../time-utils.ts";
import { readCompiledResetAt } from "./compiled-memory-state.ts";
import { listSessionFiles, readCurrentSessionBranch, sessionIdFromFilename } from "../session-jsonl.ts";
import { isAgentPhoneSessionPath } from "../conversations/agent-phone-session.ts";
import { buildSourceTimeRange } from "./time-context.ts";
import { writeCacheSnapshotObservation } from "./cache-snapshot-observation.ts";
import { runMemoryReflection as defaultRunMemoryReflection } from "./memory-reflection-runner.ts";
import { validateRollingSummaryFormat } from "./rolling-summary-format.ts";
import { CACHE_STRATEGIES } from "../llm/cache-strategy-contract.ts";
import { atomicWriteSync } from "../../shared/safe-fs.ts";
import { invalidateSessionDerivedStateSync } from "./session-derived-state.ts";
import { createMemoryDreamRunner } from "./dream/runner.ts";
import type { DreamErrorCode } from "./dream/state-store.ts";
import {
  listDreamRevisions as listDreamRevisionFiles,
  readDreamRevision as readDreamRevisionFile,
} from "./dream/revision-store.ts";

const log = createModuleLogger("memory-ticker");

const TURNS_PER_SUMMARY = 10;   // 每隔多少轮触发一次滚动摘要
const CACHE_SNAPSHOT_PREVIEW_LIMIT = 16_000;
const DAILY_STATE_FILE = "daily-state.json";
// v3：week 段 LLM 编译（compileWeek/compileLongterm-from-week）退役，
// 换成 compileDaily（编译昨天）+ rollDailyWindow（滚出窗口的 daily fold 进
// longterm）。步骤名变化，版本号提升让旧 schema 的持久化状态被判定为不匹配，
// 走一次性重算（幂等，不会重复计费）。
// v4：compileToday 改水位线增量（今日记忆 P3），compileDaily 的输入从"当天全部
// 摘要"改为"昨天最终版今日草稿"——两步的执行顺序也随之对调（compileDaily 必须
// 先于 compileToday 跑，否则昨天的草稿会先被 compileToday 的日期切换重置清空）。
// 步骤内部语义变了，版本号提升让旧 schema 的断点续跑状态失效，走一次性重算。
const DAILY_STATE_SCHEMA_VERSION = 4;
const DAILY_STEP_KEYS = ["compileDaily", "compileToday", "rollDailyWindow", "compileFacts", "deepMemory"];

function dreamTickerError(code: DreamErrorCode, message: string, cause?: unknown) {
  const error: Error & { code: DreamErrorCode; cause?: unknown } = Object.assign(new Error(message), { code });
  if (cause !== undefined) error.cause = cause;
  return error;
}

// ── 主调度器 ──

/**
 * 创建 v3 记忆调度器
 *
 * @param {object} opts
 * @param {import('./session-summary.ts').SessionSummaryManager} opts.summaryManager
 * @param {string} opts.configPath
 * @param {import('./fact-store.ts').FactStore} opts.factStore
 * @param {function} opts.getResolvedMemoryModel - 返回预解析的 { model, provider, api, api_key, base_url }
 * @param {function} [opts.onCompiled] - memory.md 更新后的回调
 * @param {string} opts.sessionDir
 * @param {string} opts.memoryMdPath
 * @param {string} opts.todayMdPath
 * @param {string} opts.weekMdPath
 * @param {string} opts.longtermMdPath
 * @param {string} opts.factsMdPath
 * @param {function} [opts.getMemoryMasterEnabled] - 返回 agent 级别记忆总开关状态
 * @param {function} [opts.getDreamAutoEnabled] - 返回当前 agent 的每日自动 Dream 开关
 * @param {(sessionPath: string) => boolean} [opts.isSessionMemoryEnabled] - 返回指定 session 的记忆状态
 * @param {function} [opts.getTimezone] - 返回用户配置时区
 * @param {(sessionPath: string) => object|null} [opts.getSessionBranchHeadForPath] - 读取持久化 branch head 元数据
 * @param {(sessionPath: string, options?: object) => object} [opts.readSessionBranchForPath] - 读取 manifest 选中的当前 branch
 * @param {function} [opts.getCacheSnapshotReflectionMode] - retired; runtime is hard-gated to off
 * @param {(sessionPath: string) => object|null} [opts.readMemoryReflectionSnapshot] - 返回 session 创建时冻结的记忆反思快照
 * @param {string} [opts.agentId] - 当前 agent id；启用 envChangeLedger 时也是 reminder 归属的必填项
 * @param {string} [opts.agentDir] - 当前 agent 数据目录，用于实验观察产物落盘
 * @param {import('../../core/env-change-ledger.ts').EnvChangeLedger} [opts.envChangeLedger] - 进程内环境变更台账
 */
export function createMemoryTicker(opts) {
  const {
    agentId,
    agentDir,
    summaryManager,
    factStore,
    getResolvedMemoryModel,
    onCompiled,
    sessionDir,
    memoryMdPath,
    todayMdPath,
    weekMdPath,
    longtermMdPath,
    factsMdPath,
    getMemoryMasterEnabled,
    getDreamAutoEnabled,
    isSessionMemoryEnabled,
    getTimezone,
    readMemoryReflectionSnapshot,
    memoryReflectionRunner,
    buildSessionCacheSnapshot,
    ensureSessionLoaded,
    getSessionStreamFn,
    getSessionIdForPath,
    getSessionBranchHeadForPath,
    readSessionBranchForPath,
    envChangeLedger,
    memoryDir = path.dirname(memoryMdPath),
  } = opts;
  const _memoryReflectionRunner = memoryReflectionRunner || { runMemoryReflection: defaultRunMemoryReflection };
  let _aggregateCompileInFlight = 0;
  const _dreamRunner = createMemoryDreamRunner({
    memoryDir,
    memoryMdPath,
    getResolvedMemoryModel,
    getLogicalDate: () => getLogicalDay().logicalDate,
    onCompiled,
  });

  // 一次性、幂等的读时迁移：把 alpha 阶段遗留的 editable-facts.md 并入 facts.md。
  // 必须早于 assemble/compileEditableFacts 首次读取 facts.md 之前跑完。
  try {
    migrateLegacyEditableFacts(memoryDir);
  } catch (err) {
    log.error(`facts.md 迁移失败: ${err.message}`);
  }

  /** agent 级总开关 */
  const _isMemoryMasterOn = () => !getMemoryMasterEnabled || getMemoryMasterEnabled();
  /** 指定 session 是否允许进入记忆流水线 */
  const _isSessionMemoryOn = (sessionPath) =>
    !isAgentPhoneSessionPath(sessionPath)
    && _isMemoryMasterOn()
    && (!isSessionMemoryEnabled || isSessionMemoryEnabled(sessionPath));
  const _getCompiledResetAt = () => readCompiledResetAt(memoryDir);
  const _getTimezone = () => getTimezone?.() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const _sessionIdentityForPath = (sessionPath) => {
    try {
      const sessionId = getSessionIdForPath?.(sessionPath);
      if (typeof sessionId === "string" && sessionId.trim()) return sessionId.trim();
    } catch {}
    return sessionIdFromFilename(path.basename(sessionPath));
  };
  const _readSessionBranch = (sessionPath, options: any = {}) => {
    if (typeof readSessionBranchForPath === "function") {
      const projection = readSessionBranchForPath(sessionPath, options);
      if (projection) return projection;
    }
    return readCurrentSessionBranch(sessionPath, options);
  };
  const _summaryCursorBelongsToProjection = (summary, projection) => {
    const cursor = summary?.cursor;
    if (!cursor || typeof cursor.lineageHash !== "string" || !projection) return false;
    const lineageHash = cursor.coveredLeafId == null
      ? projection.rootLineageHash
      : projection.prefixHashes?.[cursor.coveredLeafId];
    return lineageHash === cursor.lineageHash;
  };
  const _getCacheSnapshotReflectionMode = () => {
    return "off";
  };
  const _factsSourcePath = () => {
    ensureEditableFactsBaseline(memoryDir, summaryManager, {
      outputPath: factsMdPath,
    });
    return factsMdPath;
  };
  const _readFactsLines = () => {
    try {
      return fs.readFileSync(factsMdPath, "utf-8")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    } catch (err) {
      return err?.code === "ENOENT" ? [] : null;
    }
  };
  const _recordNewFactLines = (beforeLines) => {
    if (!envChangeLedger || !Array.isArray(beforeLines)) return;
    const afterLines = _readFactsLines();
    if (!Array.isArray(afterLines)) return;
    const before = new Set(beforeLines);
    const seen = new Set();
    const addedLines = afterLines.filter((line) => {
      if (before.has(line) || seen.has(line)) return false;
      seen.add(line);
      return true;
    }).slice(0, 5);
    if (addedLines.length === 0) return;
    const reminderAgentId = typeof agentId === "string" ? agentId.trim() : "";
    if (!reminderAgentId) {
      throw new Error("memory fact reminder requires an explicit agentId");
    }
    envChangeLedger.append({
      type: "memory_facts",
      scope: { kind: "agent", agentId: reminderAgentId },
      payload: { addedLines },
    });
  };
  const _dailyDir = () => path.join(memoryDir, "daily");
  const _createSourceTimeRangeResolver = () => {
    const filesById = new Map(
      listSessionFiles(sessionDir).map((entry) => [_sessionIdentityForPath(entry.filePath), entry.filePath]),
    );
    return (sessionId) => {
      const filePath = filesById.get(sessionId);
      if (!filePath) return null;
      const { messages } = _readSessionBranch(filePath);
      return buildSourceTimeRange(messages, { timeZone: _getTimezone() });
    };
  };
  const _createSessionBranchProjectionResolver = () => {
    const filesById = new Map(
      listSessionFiles(sessionDir).map((entry) => [_sessionIdentityForPath(entry.filePath), entry.filePath]),
    );
    return (sessionId) => {
      const filePath = filesById.get(sessionId);
      return filePath ? _readSessionBranch(filePath) : null;
    };
  };
  const _readMemoryReflectionSnapshot = (sessionPath) => {
    try {
      const snapshot = readMemoryReflectionSnapshot?.(sessionPath);
      return snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
        ? snapshot
        : null;
    } catch {
      return null;
    }
  };

  // 每小时检查日期变化（备用触发，主触发是 notifyTurn）
  const DAILY_CHECK_INTERVAL = 60 * 60 * 1000;

  let _timer = null;
  let _tickInFlight = null;
  let _stopped = false;
  const _activeJobs = new Set();
  let _dailyRunning = false;
  let _lastDailyJobDate = null;
  let _dailyStepsDate = null;               // 当天已完成步骤所属日期
  let _dailyStepsContextKey = null;          // 日期 + resetAt，防止同日 reset 变更误跳过
  let _dailyCompletedAt = null;
  const _dailyStepsCompleted = new Set();    // 当天已完成的步骤名（断点续跑）
  const _dailyStepCompletedAt = new Map();   // stepName → ISO timestamp
  const _turnCounts = new Map();             // stable session identity → turn count
  const _summaryInProgress = new Set();      // 正在跑滚动摘要的 session
  const _branchReplacementPending = new Set(); // sessionId → replacement 未完整落到 facts.db
  const _branchReplacementEpoch = new Map(); // sessionId → force generation，防止运行中的摘要吞掉新 force

  const _markBranchReplacementPending = (sessionId) => {
    _branchReplacementPending.add(sessionId);
    const nextEpoch = (_branchReplacementEpoch.get(sessionId) || 0) + 1;
    _branchReplacementEpoch.set(sessionId, nextEpoch);
    return nextEpoch;
  };

  // ── 错误 dedup：相同根因（如凭证持续无效）只在 console 打一次，避免每轮对话都刷屏 ──
  let _lastErrorSig = null;
  function _logStepError(label, err) {
    const msg = err?.message || String(err);
    const sig = `${label}|${msg}`;
    if (sig === _lastErrorSig) {
      // 同一根因重复 → 只写 debug 文件，不打 console
      debugLog()?.error("memory", `${label} (dup suppressed): ${msg}`);
      return;
    }
    _lastErrorSig = sig;
    log.error(`${label} 失败: ${msg}`);
    debugLog()?.error("memory", `${label} failed: ${msg}`);
  }
  function _markStepRecovered(label) {
    if (!_lastErrorSig) return;
    const prev = _lastErrorSig;
    _lastErrorSig = null;
    log.log(`${label} 恢复正常（之前: ${prev}）`);
    debugLog()?.log("memory", `${label} recovered (was: ${prev})`);
  }

  // ── 步骤健康状态：每步独立记录，方便 UI 层 / healthz 接口读取 ──
  // 注意：failCount 只在连续失败时递增，一次成功立即清零
  const _stepKeys = ["rollingSummary", "compileToday", "compileDaily", "rollDailyWindow", "compileFacts", "deepMemory"];
  const _health = {};
  for (const k of _stepKeys) {
    _health[k] = { lastSuccessAt: null, lastErrorAt: null, lastErrorMsg: null, failCount: 0 };
  }
  function _markSuccess(stepKey) {
    const h = _health[stepKey];
    if (!h) return;
    h.lastSuccessAt = new Date().toISOString();
    h.lastErrorAt = null;
    h.lastErrorMsg = null;
    h.failCount = 0;
  }
  function _markFailure(stepKey, err) {
    const h = _health[stepKey];
    if (!h) return;
    h.lastErrorAt = new Date().toISOString();
    h.lastErrorMsg = err?.message || String(err);
    h.failCount += 1;
  }

  function _trackJob(promise) {
    _activeJobs.add(promise);
    promise.then(() => {
      _activeJobs.delete(promise);
    }, () => {
      _activeJobs.delete(promise);
    });
    return promise;
  }

  // ── 每日任务状态持久化：进程重启后继续跳过已完成的 expensive steps ──

  function _dailyStatePath() {
    return path.join(memoryDir, DAILY_STATE_FILE);
  }

  function _normalizeResetAt(value) {
    if (!value || Number.isNaN(Date.parse(value))) return null;
    return new Date(value).toISOString();
  }

  function _dailyContext(logicalDate = getLogicalDay().logicalDate) {
    return {
      logicalDate,
      resetAt: _normalizeResetAt(_getCompiledResetAt()),
    };
  }

  function _dailyContextKey(context) {
    return [context.logicalDate, context.resetAt || ""].join("\n");
  }

  function _isValidIso(value) {
    return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
  }

  function _readDailyState() {
    try {
      const raw = JSON.parse(fs.readFileSync(_dailyStatePath(), "utf-8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      if (raw.schemaVersion !== DAILY_STATE_SCHEMA_VERSION) return null;
      const completedSteps = raw.completedSteps && typeof raw.completedSteps === "object" && !Array.isArray(raw.completedSteps)
        ? raw.completedSteps
        : {};
      return {
        logicalDate: typeof raw.logicalDate === "string" ? raw.logicalDate : "",
        resetAt: _normalizeResetAt(raw.resetAt),
        completedSteps,
        dailyCompletedAt: _isValidIso(raw.dailyCompletedAt) ? new Date(raw.dailyCompletedAt).toISOString() : null,
      };
    } catch (err) {
      if (err?.code !== "ENOENT") {
        debugLog()?.error("memory", `daily state read failed: ${err?.message || err}`);
      }
      return null;
    }
  }

  function _stateMatchesContext(state, context) {
    return Boolean(state)
      && state.logicalDate === context.logicalDate
      && state.resetAt === context.resetAt;
  }

  function _allDailyStepsCompleted() {
    return DAILY_STEP_KEYS.every((stepKey) => _dailyStepsCompleted.has(stepKey));
  }

  function _resetDailyProgressForContext(context) {
    _dailyStepsCompleted.clear();
    _dailyStepCompletedAt.clear();
    _dailyCompletedAt = null;
    _dailyStepsDate = context.logicalDate;
    _dailyStepsContextKey = _dailyContextKey(context);
    if (_lastDailyJobDate === context.logicalDate) _lastDailyJobDate = null;
  }

  function _restoreDailyProgress(context = _dailyContext()) {
    const contextKey = _dailyContextKey(context);
    if (_dailyStepsContextKey !== contextKey) {
      _resetDailyProgressForContext(context);
    }

    const state = _readDailyState();
    if (!_stateMatchesContext(state, context)) {
      return context;
    }

    for (const stepKey of DAILY_STEP_KEYS) {
      const completedAt = state.completedSteps?.[stepKey];
      if (!_isValidIso(completedAt)) continue;
      _dailyStepsCompleted.add(stepKey);
      _dailyStepCompletedAt.set(stepKey, new Date(completedAt).toISOString());
    }
    _dailyCompletedAt = state.dailyCompletedAt;
    _dailyStepsDate = context.logicalDate;
    _dailyStepsContextKey = contextKey;
    if (_dailyCompletedAt && _allDailyStepsCompleted()) {
      _lastDailyJobDate = context.logicalDate;
    }
    return context;
  }

  function _writeDailyState(context) {
    const completedSteps = {};
    for (const stepKey of DAILY_STEP_KEYS) {
      const completedAt = _dailyStepCompletedAt.get(stepKey);
      if (completedAt) completedSteps[stepKey] = completedAt;
    }
    const state = {
      schemaVersion: DAILY_STATE_SCHEMA_VERSION,
      logicalDate: context.logicalDate,
      resetAt: context.resetAt,
      completedSteps,
      dailyCompletedAt: _dailyCompletedAt,
      updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(memoryDir, { recursive: true });
    atomicWriteSync(_dailyStatePath(), JSON.stringify(state, null, 2) + "\n");
  }

  function _markDailyStepCompleted(stepKey, context) {
    _dailyStepsCompleted.add(stepKey);
    _dailyStepCompletedAt.set(stepKey, new Date().toISOString());
    try {
      _writeDailyState(context);
    } catch (err) {
      debugLog()?.error("memory", `daily state write failed after ${stepKey}: ${err?.message || err}`);
    }
  }

  function _clearPersistedDailyProgress(context, reason) {
    _resetDailyProgressForContext(context);
    try {
      _writeDailyState(context);
    } catch (err) {
      debugLog()?.error("memory", `daily state clear failed (${reason}): ${err?.message || err}`);
    }
  }

  // ── 内部：滚动摘要 ──

  function _textPreview(text) {
    const value = String(text || "");
    return value.length > CACHE_SNAPSHOT_PREVIEW_LIMIT
      ? value.slice(0, CACHE_SNAPSHOT_PREVIEW_LIMIT)
      : value;
  }

  function _sha256(text) {
    if (!text) return "";
    return crypto.createHash("sha256").update(String(text)).digest("hex");
  }

  function _readMemoryMdPreview() {
    try {
      return _textPreview(fs.readFileSync(memoryMdPath, "utf-8"));
    } catch (err) {
      if (err?.code === "ENOENT") return "";
      throw err;
    }
  }

  function _firstNumber(...values) {
    for (const value of values) {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
    return 0;
  }

  function _observationUsage(usage, resolvedModel, latencyMs) {
    return {
      model: String(resolvedModel?.model?.id || resolvedModel?.id || resolvedModel?.model || ""),
      cachedTokens: _firstNumber(
        usage?.cachedTokens,
        usage?.cacheReadTokens,
        usage?.cache?.readTokens,
      ),
      missTokens: _firstNumber(
        usage?.missTokens,
        usage?.cacheMissTokens,
        usage?.cache?.missTokens,
        usage?.input?.uncachedTokens,
      ),
      latencyMs,
    };
  }

  function _requestModelDiagnostics(model) {
    if (!model || typeof model !== "object" || Array.isArray(model)) return null;
    return {
      id: String(model.id || model.model || ""),
      provider: String(model.provider || ""),
      api: String(model.api || ""),
      hasBaseUrl: Boolean(model.baseUrl || model.base_url),
      hasQuirks: Array.isArray(model.quirks),
    };
  }

  function _errorDiagnostics(err, requestModel) {
    return {
      errorName: String(err?.name || ""),
      stack: typeof err?.stack === "string" ? err.stack.split("\n").slice(0, 4) : [],
      requestModel: _requestModelDiagnostics(requestModel),
    };
  }

  function _isRecoverableSessionSnapshotUnavailable(err) {
    const message = String(err?.message || err || "");
    if (/session cache snapshot unavailable/i.test(message)) return true;
    return /snapshot/i.test(message) && /unknown session/i.test(message);
  }

  async function _buildSessionCacheSnapshotWithRecovery(sessionPath, options) {
    try {
      return buildSessionCacheSnapshot(sessionPath, options);
    } catch (err) {
      if (!_isRecoverableSessionSnapshotUnavailable(err) || typeof ensureSessionLoaded !== "function") {
        throw err;
      }
      debugLog()?.warn?.(
        "memory",
        `cache snapshot runtime missing for ${path.basename(sessionPath)}; loading session before retry`,
      );
      try {
        await ensureSessionLoaded(sessionPath);
        return buildSessionCacheSnapshot(sessionPath, options);
      } catch (retryErr) {
        if (_isRecoverableSessionSnapshotUnavailable(retryErr)) throw retryErr;
        const wrapped: any = new Error(`Session cache snapshot unavailable after runtime recovery: ${retryErr?.message || retryErr}`);
        wrapped.cause = retryErr;
        throw wrapped;
      }
    }
  }

  async function _runSessionSnapshotMemoryReflection({
    sessionPath,
    sessionId,
    messages,
    resolvedModel,
    rollingOptions,
    mode,
    trigger,
  }) {
    const startedAt = Date.now();
    let baseMemoryMd = "";
    let requestModel = null;
    try {
      baseMemoryMd = _readMemoryMdPreview();
    } catch (err) {
      debugLog()?.error("memory", `cache snapshot memory.md preview failed: ${err?.message || err}`);
    }
    try {
      if (!agentDir) {
        throw new Error("agentDir is required for cache snapshot reflection observation");
      }
      if (typeof _memoryReflectionRunner.runMemoryReflection !== "function") {
        throw new Error("memoryReflectionRunner.runMemoryReflection is required for session snapshot reflection");
      }
      if (typeof buildSessionCacheSnapshot !== "function") {
        throw new Error("buildSessionCacheSnapshot is required for session snapshot reflection");
      }

      const snapshot = await _buildSessionCacheSnapshotWithRecovery(sessionPath, {
        reason: "memory.reflection",
        messages,
      });
      const previousSummary = summaryManager.getSummary?.(sessionId)?.summary || "";
      requestModel = snapshot.requestModel || snapshot.model || resolvedModel?.model || resolvedModel;
      const reflection = await _memoryReflectionRunner.runMemoryReflection({
        snapshot,
        model: requestModel,
        cacheKeyParams: snapshot.cacheKeyParams || {},
        previousSummary,
        sessionId,
        messages,
        sourceTimeRange: buildSourceTimeRange(messages, { timeZone: rollingOptions.timeZone }),
        timeZone: rollingOptions.timeZone,
        streamFn: getSessionStreamFn?.(sessionPath),
        options: {
          ...(snapshot.cacheKeyParams?.thinkingLevel && snapshot.cacheKeyParams.thinkingLevel !== "off"
            ? { reasoning: snapshot.cacheKeyParams.thinkingLevel }
            : {}),
          toolChoice: "none",
        },
        usageLedger: resolvedModel?.usageLedger,
        usageContext: {
          source: {
            subsystem: "memory",
            operation: "cache_snapshot_reflection",
            surface: "system",
            trigger,
          },
          attribution: {
            kind: "memory",
            agentId: agentId || resolvedModel?.usageAgentId || null,
          },
        },
      });
      const metadata = reflection?.metadata || {};
      const strictSessionSnapshot = metadata.cacheStrategy === CACHE_STRATEGIES.SESSION_SNAPSHOT && metadata.strict === true;

      if (!strictSessionSnapshot) {
        const err: any = new Error("Cache snapshot memory write requires a strict session_snapshot result");
        err.cacheMetadata = metadata;
        throw err;
      }

      if (mode === "write" && reflection?.data) {
        // 写入前结构校验（#1628）：reflection runner 是可注入依赖，落盘边界
        // 不信任上游；不满足 compileFacts 提取假设的摘要禁止覆盖旧摘要。
        const formatValidation = validateRollingSummaryFormat(String(reflection.data.summary || ""));
        if (!formatValidation.ok) {
          const err: any = new Error(
            `cache snapshot reflection summary violates the rolling summary format: ${formatValidation.issues.join("; ")}`,
          );
          err.cacheMetadata = metadata;
          throw err;
        }
        summaryManager.saveSummary(sessionId, reflection.data);
      }

      const observation = writeCacheSnapshotObservation(agentDir, {
        agentId: agentId || resolvedModel?.usageAgentId || path.basename(agentDir),
        sessionPath,
        trigger,
        mode,
        status: "success",
        reason: reflection?.reason || "",
        usage: _observationUsage(reflection?.usage, requestModel, Date.now() - startedAt),
        summaryPreview: _textPreview(reflection?.summary || ""),
        memoryMdPreview: baseMemoryMd,
        baseMemoryMdHash: _sha256(baseMemoryMd),
        cacheStrategy: metadata.cacheStrategy,
        strict: metadata.strict === true,
        cachePrefixHash: metadata.cachePrefixHash || "",
        parentCachePrefixHash: metadata.parentCachePrefixHash || "",
        contractDiffs: metadata.contractDiffs || [],
        degradeReason: metadata.degradeReason || "",
      });
      _markSuccess("cacheSnapshotReflection");
      return observation.summaryPreview;
    } catch (err) {
      const metadata = err?.cacheMetadata || {};
      _markFailure("cacheSnapshotReflection", err);
      if (err?.stack) {
        debugLog()?.error("memory", `cache snapshot reflection stack: ${err.stack}`);
      }
      try {
        if (agentDir) {
          writeCacheSnapshotObservation(agentDir, {
            agentId: agentId || resolvedModel?.usageAgentId || path.basename(agentDir),
            sessionPath,
            trigger,
            mode,
            status: "failed",
            reason: err?.message || String(err),
            usage: _observationUsage(null, resolvedModel, Date.now() - startedAt),
            summaryPreview: "",
            memoryMdPreview: baseMemoryMd,
            baseMemoryMdHash: _sha256(baseMemoryMd),
            cacheStrategy: metadata.cacheStrategy || CACHE_STRATEGIES.CACHE_RECOVERY,
            strict: metadata.strict === true,
            cachePrefixHash: metadata.cachePrefixHash || "",
            parentCachePrefixHash: metadata.parentCachePrefixHash || "",
            contractDiffs: metadata.contractDiffs || [],
            degradeReason: metadata.degradeReason || err?.message || String(err),
            diagnostics: _errorDiagnostics(err, requestModel),
          });
        }
      } catch (writeErr) {
        debugLog()?.error("memory", `cache snapshot observation write failed: ${writeErr?.message || writeErr}`);
      }
      _logStepError(`cache snapshot reflection (${path.basename(sessionPath)})`, err);
      if (mode === "write") throw err;
      return "";
    }
  }

  async function _doRollingSummary(sessionPath, trigger = "threshold") {
    const sessionId = _sessionIdentityForPath(sessionPath);
    if (_summaryInProgress.has(sessionId)) return; // 并发保护
    const replacementEpochAtStart = _branchReplacementEpoch.get(sessionId) || 0;
    _summaryInProgress.add(sessionId);
    try {
      const resetAt = _getCompiledResetAt();
      const projection = _readSessionBranch(sessionPath, { since: resetAt });
      const { messages } = projection;

      const rollingOptions: any = {
        resetAt,
        timeZone: _getTimezone(),
        projection,
        returnResult: true,
        revalidateProjection: () => _readSessionBranch(sessionPath, { since: resetAt }),
      };
      const memoryReflectionSnapshot = _readMemoryReflectionSnapshot(sessionPath);
      if (memoryReflectionSnapshot) {
        rollingOptions.memoryReflectionSnapshot = memoryReflectionSnapshot;
      }
      const resolvedModel = await getResolvedMemoryModel();
      const cacheSnapshotMode = _getCacheSnapshotReflectionMode();
      let summaryResult = null;
      if (cacheSnapshotMode === "write") {
        try {
          await _runSessionSnapshotMemoryReflection({
            sessionPath,
            sessionId,
            messages,
            resolvedModel,
            rollingOptions,
            mode: "write",
            trigger,
          });
        } catch (err) {
          if (!_isRecoverableSessionSnapshotUnavailable(err)) throw err;
          debugLog()?.warn?.(
            "memory",
            `cache snapshot unavailable for ${path.basename(sessionPath)}; falling back to rolling summary`,
          );
          summaryResult = await summaryManager.rollingSummary(sessionId, messages, resolvedModel, rollingOptions);
        }
      } else {
        summaryResult = await summaryManager.rollingSummary(
          sessionId,
          messages,
          resolvedModel,
          rollingOptions,
        );
        if (summaryResult?.reason === "branch_changed") {
          throw new Error("session branch changed while rebuilding its memory summary");
        }
        if (summaryResult?.mode === "replace" && !summaryResult?.data) {
          throw new Error(`branch memory replacement was not committed (${summaryResult?.reason || "unknown"})`);
        }
        if (summaryManager.getSummary(sessionId)?.factReplacementRequired === true) {
          await processDirtySessions(summaryManager, factStore, resolvedModel, {
            since: resetAt,
            timeZone: _getTimezone(),
            getSourceTimeRange: _createSourceTimeRangeResolver(),
            getCurrentBranchProjection: () => _readSessionBranch(sessionPath),
            sessionIds: [sessionId],
          });
          if (summaryManager.getSummary(sessionId)?.factReplacementRequired === true) {
            throw new Error("branch fact replacement remains pending");
          }
        }
        if (cacheSnapshotMode === "shadow") {
          await _runSessionSnapshotMemoryReflection({
            sessionPath,
            sessionId,
            messages,
            resolvedModel,
            rollingOptions,
            mode: "shadow",
            trigger,
          });
        }
      }
      debugLog()?.log("memory", `rolling summary updated: ${sessionId.slice(0, 8)}...`);
      _markSuccess("rollingSummary");
      _markStepRecovered("滚动摘要");
      const newerReplacementPending = (_branchReplacementEpoch.get(sessionId) || 0) > replacementEpochAtStart;
      if (!newerReplacementPending) {
        _branchReplacementPending.delete(sessionId);
        _branchReplacementEpoch.delete(sessionId);
      }
      return { ok: true, summary: summaryManager.getSummary(sessionId) };
    } catch (err) {
      _markFailure("rollingSummary", err);
      _logStepError(`滚动摘要 (${path.basename(sessionPath)})`, err);
      if (trigger === "manual" && _getCacheSnapshotReflectionMode() === "write") {
        throw err;
      }
      return { ok: false, error: err };
    } finally {
      _summaryInProgress.delete(sessionId);
      const newerReplacementPending = (_branchReplacementEpoch.get(sessionId) || 0) > replacementEpochAtStart;
      if (!_stopped && newerReplacementPending) {
        _trackJob(_doRollingSummary(sessionPath, "branch_change_rerun")
          .then((outcome) => outcome?.ok ? _doCompileTodayAndAssemble() : undefined)
          .catch(() => {}));
      }
    }
  }

  // ── 内部：今天编译 + 组装 ──

  async function _doCompileTodayAndAssemble() {
    if (_dreamRunner.isRunning()) return;
    _aggregateCompileInFlight += 1;
    try {
      const resetAt = _getCompiledResetAt();
      await compileToday(summaryManager, todayMdPath, await getResolvedMemoryModel(), { since: resetAt });
      assemble(_factsSourcePath(), todayMdPath, weekMdPath, longtermMdPath, memoryMdPath);
      onCompiled?.();
      debugLog()?.log("memory", "today compiled + assembled");
      _markSuccess("compileToday");
      _markStepRecovered("compileToday");
    } catch (err) {
      _markFailure("compileToday", err);
      _logStepError("compileToday", err);
    } finally {
      _aggregateCompileInFlight = Math.max(0, _aggregateCompileInFlight - 1);
    }
  }

  // ── 内部：每日任务 ──

  async function _doDaily() {
    if (_dailyRunning || _dreamRunner.isRunning()) return;
    _dailyRunning = true;
    try {
      const todayStr = getLogicalDay().logicalDate;
      const context = _restoreDailyProgress(_dailyContext(todayStr));
      const resetAt = context.resetAt;

      log.log(`每日任务开始 (${todayStr})`);
      let hasFailed = false;

      // Step -1（不计入断点续跑）：一次性迁移旧 week.md 到 longterm。幂等——
      // week.md 迁移后被更名为 .migrated.bak，之后每次调用都会因文件不存在而 no-op，
      // 不需要独立 checkpoint。必须早于本函数末尾的 assemble（读 weekMdPath）之前跑完。
      try {
        await migrateLegacyWeekToLongterm(memoryDir, longtermMdPath, await getResolvedMemoryModel());
      } catch (err) {
        hasFailed = true;
        log.error(`week.md 迁移失败: ${err.message}`);
      }

      // Step 0: compileDaily——把已经翻篇的昨天蒸馏成 memory/daily/{date}.md。
      // 必须先于 Step 1 的 compileToday 执行：compileDaily 读取的"昨天最终版今日草稿"
      // 就是这一刻仍躺在 todayMdPath 里的内容——一旦 compileToday 先跑，日期切换会
      // 把 today.md 重置为新一天的空白草稿，昨天的草稿就再也读不到了。
      if (!_dailyStepsCompleted.has("compileDaily")) {
        try {
          const yesterday = shiftLogicalDate(todayStr, -1);
          await compileDaily(summaryManager, _dailyDir(), yesterday, await getResolvedMemoryModel(), {
            since: resetAt,
            todayDraftPath: todayMdPath,
          });
          _markDailyStepCompleted("compileDaily", context);
          _markSuccess("compileDaily");
          _markStepRecovered("compileDaily");
        } catch (err) {
          hasFailed = true;
          _markFailure("compileDaily", err);
          _logStepError("compileDaily", err);
        }
      }

      // Step 1: compileToday（日期切换后刷新 today.md，新一天无 session 时会清空）
      if (!_dailyStepsCompleted.has("compileToday")) {
        try {
          await compileToday(summaryManager, todayMdPath, await getResolvedMemoryModel(), { since: resetAt });
          _markDailyStepCompleted("compileToday", context);
          _markSuccess("compileToday");
          _markStepRecovered("compileToday(daily)");
        } catch (err) {
          hasFailed = true;
          _markFailure("compileToday", err);
          _logStepError("compileToday(daily)", err);
        }
      }

      // Step 2: rollDailyWindow——把滚出 6 日窗口的 daily 条目 fold 进 longterm 并删除源文件。
      // 依赖 compileDaily 已经把昨天落盘，否则窗口判断会漏看最新一天（虽然滚动窗口本身
      // 判断的是"更早"的条目，但保持与 compileWeek→compileLongterm 相同的顺序约束更安全）。
      if (!_dailyStepsCompleted.has("rollDailyWindow") && _dailyStepsCompleted.has("compileDaily")) {
        try {
          const { failed } = await rollDailyWindow(_dailyDir(), longtermMdPath, await getResolvedMemoryModel(), {
            referenceDate: todayStr,
          });
          if (failed.length > 0) {
            throw new Error(`${failed.length} 份 daily 条目 fold 进 longterm 失败: ${failed.join(", ")}`);
          }
          _markDailyStepCompleted("rollDailyWindow", context);
          _markSuccess("rollDailyWindow");
          _markStepRecovered("rollDailyWindow");
        } catch (err) {
          hasFailed = true;
          _markFailure("rollDailyWindow", err);
          _logStepError("rollDailyWindow", err);
        }
      }

      // Step 3: compileFacts（独立于 step 1-2）——恒走增量编译，facts.md 是唯一产物
      if (!_dailyStepsCompleted.has("compileFacts")) {
        try {
          const factsBefore = _readFactsLines();
          await compileEditableFacts(summaryManager, factsMdPath, await getResolvedMemoryModel(), {
            since: resetAt,
          });
          _recordNewFactLines(factsBefore);
          _markDailyStepCompleted("compileFacts", context);
          _markSuccess("compileFacts");
          _markStepRecovered("compileFacts");
        } catch (err) {
          hasFailed = true;
          _markFailure("compileFacts", err);
          _logStepError("compileFacts", err);
        }
      }

      // Step 4: assemble（纯文件操作，先从 daily/ 目录装配 week.md 再拼 memory.md，总是执行）
      try {
        assembleWeekFromDaily(_dailyDir(), weekMdPath);
        assemble(_factsSourcePath(), todayMdPath, weekMdPath, longtermMdPath, memoryMdPath);
        onCompiled?.();
      } catch (err) {
        hasFailed = true;
        log.error(`assemble 失败: ${err.message}`);
      }

      // Step 5: deep-memory（独立，更新 facts.db）
      if (!_dailyStepsCompleted.has("deepMemory")) {
        try {
          const { processed, factsAdded } = await processDirtySessions(
            summaryManager, factStore, await getResolvedMemoryModel(), {
              since: resetAt,
              timeZone: _getTimezone(),
              getSourceTimeRange: _createSourceTimeRangeResolver(),
              getCurrentBranchProjection: _createSessionBranchProjectionResolver(),
            },
          );
          const replacementStillPending = typeof summaryManager.getDirtySessions === "function"
            && summaryManager
              .getDirtySessions({ since: resetAt })
              .some((session) => session.factReplacementRequired === true);
          if (replacementStillPending) {
            throw new Error("branch fact replacement remains pending after deep-memory pass");
          }
          _markDailyStepCompleted("deepMemory", context);
          if (processed > 0) {
            log.log(`deep-memory: ${processed} session, ${factsAdded} 条新事实`);
          }
          _markSuccess("deepMemory");
          _markStepRecovered("deep-memory");
        } catch (err) {
          hasFailed = true;
          _markFailure("deepMemory", err);
          _logStepError("deep-memory", err);
        }
      }

      if (hasFailed) {
        const done = [..._dailyStepsCompleted].join(", ");
        log.error(`每日任务部分失败，已完成: [${done}]，1 小时后重试未完成步骤`);
        debugLog()?.error("memory", `daily job partial failure, completed: [${done}]`);
      } else {
        _lastDailyJobDate = todayStr;
        _dailyCompletedAt = new Date().toISOString();
        try {
          _writeDailyState(context);
        } catch (err) {
          debugLog()?.error("memory", `daily state final write failed: ${err?.message || err}`);
        }
        log.log(`每日任务完成`);
        _maybeStartAutomaticDream(todayStr);
      }
    } finally {
      _dailyRunning = false;
    }
  }

  function _maybeStartAutomaticDream(logicalDate = getLogicalDay().logicalDate) {
    // 这是 Dream 的休眠边界：配置缺失或 false 时只做一次布尔判断，不读取/创建
    // Dream state，也不改变既有 daily checkpoint、模型调用或记忆文件。
    if (getDreamAutoEnabled?.() !== true) return null;
    if (_stopped || !_isMemoryMasterOn() || _branchReplacementPending.size > 0) return null;
    try {
      return _dreamRunner.startAutomaticIfEligible(logicalDate);
    } catch (err) {
      _logStepError("automatic Dream", err);
      return null;
    }
  }

  function _checkDailyJob() {
    if (_stopped) return;
    if (!_isMemoryMasterOn()) return;
    if (_branchReplacementPending.size > 0) return;
    if (_dreamRunner.isRunning()) return;
    const context = _restoreDailyProgress();
    if (_lastDailyJobDate !== context.logicalDate) {
      _trackJob(_doDaily()); // 后台，不 await
    } else {
      _maybeStartAutomaticDream(context.logicalDate);
    }
  }

  // ── 公开 API ──

  /**
   * 每轮对话结束后调用（由 engine.js 在 prompt() 返回后调用）
   * @param {string} sessionPath - 当前 session 的 .jsonl 文件路径
   */
  function notifyTurn(sessionPath, options: any = {}) {
    if (_stopped) return;
    const sessionKey = _sessionIdentityForPath(sessionPath);
    if (options.forceSummary === true) _markBranchReplacementPending(sessionKey);
    const count = (_turnCounts.get(sessionKey) || 0) + 1;
    _turnCounts.set(sessionKey, count);

    const memoryOn = _isSessionMemoryOn(sessionPath);

    let job = null;
    if ((_branchReplacementPending.has(sessionKey) || count % TURNS_PER_SUMMARY === 0) && memoryOn) {
      job = _trackJob(_doRollingSummary(sessionPath, "threshold")
        .then((outcome) => outcome?.ok ? _doCompileTodayAndAssemble() : undefined)
        .catch(() => {}));
    }

    if (memoryOn && !_branchReplacementPending.has(sessionKey)) _checkDailyJob();
    return job;
  }

  /**
   * A replay rewind changes the semantic branch before a replacement reply is
   * guaranteed to reach JSONL. Mark and start the replacement immediately so
   * a rejected submit cannot leave the discarded sibling in derived memory.
   */
  function notifyBranchChanged(sessionPath) {
    if (_stopped || !sessionPath) return null;
    const sessionKey = _sessionIdentityForPath(sessionPath);
    _markBranchReplacementPending(sessionKey);
    if (!_isSessionMemoryOn(sessionPath)) return null;
    return _trackJob(_doRollingSummary(sessionPath, "branch_change")
      .then((outcome) => outcome?.ok ? _doCompileTodayAndAssemble() : undefined)
      .catch(() => {}));
  }

  /**
   * Session 切换或 dispose 前调用（final pass）
   *
   * 设计取舍：fire-and-forget。函数立即 resolve，rollingSummary + compileToday
   * 在后台跑。这样 switchSession / closeSession 的 caller 不会被 LLM 阻塞。
   *
   * 数据可见性：memory.md 只在 `agent.buildSystemPrompt()` 时读，由 agent
   * 初始化和 onCompiled 回调刷新 `_systemPrompt` 快照。新 session 创建时拿
   * snapshot，老 session 用自己创建时的快照。所以"后台刷新"对已运行 session
   * 透明，下次新建 session 时自然吃到最新记忆。
   *
   * 代价：后台 Promise 如果抛错且进程很快退出，这个 session 末尾不满
   * TURNS_PER_SUMMARY 那几轮的 rollingSummary 会丢。兜底机制是启动时
   * `_recoverUnsummarized()` 扫 24h 内 `mtime > summary.updated_at` 的 session
   * 补跑。
   *
   * @param {string} sessionPath
   * @returns {Promise<void>} 返回后台刷新的 Promise。switch/close 场景不需要 await，
   *   直接让它后台跑；dispose 场景可以 Promise.race 上限 4s 等它尽量刷完。
   */
  function notifySessionEnd(sessionPath) {
    if (_stopped) return Promise.resolve();
    if (!sessionPath) return Promise.resolve();
    const sessionKey = _sessionIdentityForPath(sessionPath);
    const count = _turnCounts.get(sessionKey) || 0;
    _turnCounts.delete(sessionKey);
    if (count === 0) return Promise.resolve();
    if (!_isSessionMemoryOn(sessionPath)) return Promise.resolve();
    return _trackJob(_doRollingSummary(sessionPath, "session_end")
      .then((outcome) => outcome?.ok ? _doCompileTodayAndAssemble() : undefined)
      .catch((err) => {
        log.error(`notifySessionEnd 后台失败: ${err.message}`);
      }));
  }

  /**
   * Retry 改写 active branch 前，作废只属于该 session 的摘要与深度事实。
   *
   * 聚合产物（today.md / facts.md / memory.md）是 Retry 发生前已经沉淀的历史记忆，
   * 不做追溯改写。这里只清掉会继续参与后续编译的 per-session 摘要与深度事实，
   * 从下一次 rolling pass 开始只消费新的 active branch。
   */
  function invalidateSessionDerivedState(ref) {
    const explicitSessionId = typeof ref?.sessionId === "string" ? ref.sessionId.trim() : "";
    const sessionPath = typeof ref?.sessionPath === "string" ? ref.sessionPath : "";
    const sessionId = explicitSessionId || (sessionPath ? _sessionIdentityForPath(sessionPath) : "");
    if (!sessionId) throw new Error("memory invalidation requires sessionId");
    // 不与任何在途记忆任务互斥：编译/摘要是记忆侧的观察者，永远要给用户发起的
    // 操作让道，绝不能让 Retry 因为后台记忆任务恰好在跑而报错回滚。
    // 这里的同步删除和一个在途旧分支任务之间确实存在竞态——旧任务可能在
    // 删除之后才把（属于被丢弃分支的）摘要写回。但这个竞态已经被分支替换
    // epoch 的收尾重跑机制闭合：Retry 改分支头时已经 bump 过 epoch，旧任务
    // 收尾时发现 epoch 前进了，会在 finally 里自动用新分支重新跑一遍摘要，
    // 把旧任务刚写回的内容覆盖掉。聚合产物（today.md / facts.md / memory.md）
    // 本就声明不追溯改写，一次在途的聚合编译最多把 Retry 之前的历史沉淀进去，
    // 这是既有语义下可以接受的结果，不需要为此阻塞用户操作。
    const result = invalidateSessionDerivedStateSync({
      sessionId,
      retainedMessageCount: ref?.retainedMessageCount,
      summaryManager,
      factStore,
    });
    _turnCounts.delete(sessionId);
    debugLog()?.warn?.(
      "memory",
      `session-derived memory invalidated for ${sessionId}; existing aggregate history preserved`,
    );
    return result;
  }

  /**
   * 启动每小时的日期检查 timer（备用触发，不依赖用户对话）
   */
  function start() {
    if (_stopped) return;
    if (_timer) return;
    _timer = setInterval(() => _checkDailyJob(), DAILY_CHECK_INTERVAL);
    if (_timer.unref) _timer.unref();
    log.log(`v3 已启动（turn-based，每日任务备用 timer 1h）`);
  }

  async function stop() {
    _stopped = true;
    if (_timer) {
      clearInterval(_timer);
      _timer = null;
    }
    await _dreamRunner.stop();
    if (_tickInFlight) await _tickInFlight.catch(() => {});
    while (_activeJobs.size > 0) {
      await Promise.allSettled([..._activeJobs]);
    }
  }

  /**
   * 启动时补偿：扫描最近修改过的 session，如果 JSONL mtime > summary.updated_at，
   * 说明上次崩溃/重启前有未收尾的对话，补跑一次滚动摘要。
   * 只处理过去 24 小时内修改的文件，避免全量扫描。
   */
  async function _recoverUnsummarized() {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const resetAt = _getCompiledResetAt();
    const resetMs = resetAt ? Date.parse(resetAt) : null;
    const sessions = listSessionFiles(sessionDir);
    let recovered = 0;
    for (const { filePath, mtime } of sessions) {
      if (!_isSessionMemoryOn(filePath)) continue;
      const sessionId = _sessionIdentityForPath(filePath);
      const existing = summaryManager.getSummary(sessionId);
      const replacementPending = existing?.factReplacementRequired === true;
      const existingSummaryAt = existing?.updated_at ? new Date(existing.updated_at).getTime() : 0;
      const summaryAt = resetMs ? Math.max(existingSummaryAt, resetMs) : existingSummaryAt;
      const pendingForkBaseline = !!existing?.fork_baseline
        && !String(existing?.summary || "").trim()
        && Number(existing?.messageCount) === 0;
      const branchHead = typeof getSessionBranchHeadForPath === "function"
        ? getSessionBranchHeadForPath(filePath)
        : null;
      const branchHeadAt = branchHead?.updatedAt ? Date.parse(branchHead.updatedAt) : NaN;
      const branchHeadMayBeNewer = Number.isFinite(branchHeadAt) && branchHeadAt >= existingSummaryAt;
      let branchCursorMismatch = false;
      if (replacementPending || branchHeadMayBeNewer) {
        const projection = _readSessionBranch(filePath);
        branchCursorMismatch = !_summaryCursorBelongsToProjection(existing, projection);
      }
      if (!pendingForkBaseline && !replacementPending && !branchCursorMismatch && mtime.getTime() < cutoff) continue;
      if (!pendingForkBaseline && !replacementPending && !branchCursorMismatch && resetMs && mtime.getTime() <= resetMs) continue;
      if (replacementPending || branchCursorMismatch) _markBranchReplacementPending(sessionId);
      if (pendingForkBaseline || replacementPending || branchCursorMismatch || mtime.getTime() > summaryAt + 5000) {
        const outcome = await _doRollingSummary(filePath, "recovery");
        if (outcome?.ok) recovered += 1;
      }
    }
    return recovered;
  }

  /**
   * 手动触发一次完整编译（调试 / 启动时用）
   * 先跑 daily job（确保 week/facts/longterm.md 存在），再 compileToday + assemble
   */
  async function tick() {
    if (_stopped) return;
    const p = _tickCore();
    _tickInFlight = p;
    try { await p; } finally { if (_tickInFlight === p) _tickInFlight = null; }
  }

  async function _tickCore() {
    if (!_isMemoryMasterOn()) return;
    const recovered = await _recoverUnsummarized(); // 补偿崩溃/重启前未收尾的 session
    if (_branchReplacementPending.size > 0) return;
    let context = _restoreDailyProgress();
    if (recovered > 0) {
      _clearPersistedDailyProgress(context, "summary recovery");
      context = _dailyContext(context.logicalDate);
    }
    if (_lastDailyJobDate !== context.logicalDate) {
      await _doDaily(); // 启动时 await，确保中间文件就绪后再 assemble
    }
    await _doCompileTodayAndAssemble();
  }

  /**
   * 手动触发（兼容旧调用）
   */
  function triggerNow() {
    if (_stopped) return;
    tick().catch(() => {});
  }

  /**
   * Session promote 后调用（心跳/cron session 从 activity/ 移到 sessions/ 后）
   * executeIsolated 不调 notifyTurn，所以需要显式补一次滚动摘要。
   * @param {string} sessionPath - promote 后的新 session 文件路径
   */
  async function notifyPromoted(sessionPath) {
    if (_stopped) return;
    if (!sessionPath) return;
    if (!_isSessionMemoryOn(sessionPath)) return;
    try {
      const outcome = await _doRollingSummary(sessionPath, "promoted");
      if (!outcome?.ok) throw outcome?.error || new Error("rolling summary failed");
      await _doCompileTodayAndAssemble();
      debugLog()?.log("memory", `promoted session summarized: ${path.basename(sessionPath).slice(0, 20)}...`);
    } catch (err) {
      log.error(`notifyPromoted 失败: ${err.message}`);
    }
    // 注册 turn count = 1，后续 notifySessionEnd 不会因 count===0 跳过
    _turnCounts.set(_sessionIdentityForPath(sessionPath), 1);
  }

  /**
   * A fork already contains a durable shared prefix even before the user sends
   * a new turn. Materialize that prefix under the child Session ID immediately
   * so the source and child memory lineages are independently durable.
   */
  function notifyForkCreated(sessionPath) {
    if (_stopped || !sessionPath || !_isSessionMemoryOn(sessionPath)) return Promise.resolve();
    const sessionId = _sessionIdentityForPath(sessionPath);
    _turnCounts.set(sessionId, Math.max(1, _turnCounts.get(sessionId) || 0));
    return _trackJob((async () => {
      try {
        await _doRollingSummary(sessionPath, "fork_created");
        await _doCompileTodayAndAssemble();
        debugLog()?.log("memory", `forked session summarized: ${sessionId.slice(0, 8)}...`);
      } catch (err) {
        log.error(`notifyForkCreated 失败: ${err.message}`);
      }
    })());
  }

  /**
   * 强制刷新指定 session 的摘要（日记等功能调用前确保摘要最新）
   * @param {string} sessionPath
   */
  async function flushSession(sessionPath) {
    if (_stopped) return;
    if (!sessionPath) return;
    if (!_isSessionMemoryOn(sessionPath)) return;
    const outcome = await _doRollingSummary(sessionPath, "manual");
    if (!outcome?.ok) throw outcome?.error || new Error("rolling summary failed");
  }

  /**
   * 强制刷新指定 session 的摘要并立刻汇编 memory.md。
   * 用于没有“退出焦点”语义的外部长会话：平时按轮次滚动，日结维护前补齐未满
   * TURNS_PER_SUMMARY 的尾巴，再让 fresh compact 吃到最新系统 prompt。
   *
   * @param {string} sessionPath
   */
  async function flushSessionAndCompile(sessionPath) {
    if (_stopped) return;
    if (!sessionPath) return;
    if (!_isSessionMemoryOn(sessionPath)) return;
    const outcome = await _doRollingSummary(sessionPath, "manual");
    if (!outcome?.ok) throw outcome?.error || new Error("rolling summary failed");
    await _doCompileTodayAndAssemble();
    _turnCounts.delete(_sessionIdentityForPath(sessionPath));
  }

  /**
   * 返回每个编译步骤的健康状态快照（深拷贝，调用方安全持有）
   * @returns {Record<string, { lastSuccessAt: string|null, lastErrorAt: string|null, lastErrorMsg: string|null, failCount: number }>}
   */
  function getHealthStatus() {
    const snapshot = {};
    for (const k of _stepKeys) snapshot[k] = { ..._health[k] };
    return snapshot;
  }

  function startDream(options: any = {}) {
    if (_stopped) throw dreamTickerError("dream_unavailable", "Memory ticker is stopped");
    if (!_isMemoryMasterOn()) {
      throw dreamTickerError("dream_memory_disabled", "Memory is disabled for this agent");
    }
    if (_dailyRunning || _aggregateCompileInFlight > 0) {
      throw dreamTickerError(
        "dream_memory_busy",
        "Memory maintenance is currently running; try Dream again shortly",
      );
    }
    return _dreamRunner.start({
      trigger: options.trigger === "automatic" ? "automatic" : "manual",
      logicalDate: options.logicalDate || getLogicalDay().logicalDate,
    });
  }

  function getDreamStatus() {
    return _dreamRunner.getStatus();
  }

  function listDreamRevisions() {
    return listDreamRevisionFiles(memoryDir);
  }

  function getDreamRevision(revisionId) {
    try {
      return readDreamRevisionFile(memoryDir, revisionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/dream revision not found/i.test(message)) {
        throw dreamTickerError("dream_revision_not_found", message, error);
      }
      throw error;
    }
  }

  async function restoreDreamRevision(revisionId) {
    if (_stopped) throw dreamTickerError("dream_unavailable", "Memory ticker is stopped");
    if (_dailyRunning || _aggregateCompileInFlight > 0) {
      throw dreamTickerError(
        "dream_memory_busy",
        "Memory maintenance is currently running; try restore again shortly",
      );
    }
    const result = await _dreamRunner.restoreRevision(revisionId);
    return result;
  }

  return {
    start,
    stop,
    tick,
    triggerNow,
    notifyTurn,
    notifyBranchChanged,
    notifySessionEnd,
    notifyPromoted,
    notifyForkCreated,
    flushSession,
    flushSessionAndCompile,
    invalidateSessionDerivedState,
    getHealthStatus,
    startDream,
    getDreamStatus,
    listDreamRevisions,
    getDreamRevision,
    restoreDreamRevision,
  };
}
