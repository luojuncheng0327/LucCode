/**
 * cron-store.js — 定时任务存储
 *
 * 管理 cron job 的 CRUD 和运行历史。
 * 调度逻辑在 cron-scheduler.js，这里只负责持久化。
 *
 * 参考 OpenClaw：jobs.json + runs/<jobId>.jsonl
 *
 * Job 类型：
 * - "at"：一次性任务（schedule = ISO 时间字符串）
 * - "every"：间隔任务（schedule = 毫秒数，如 3600000 = 1小时）
 * - "cron"：标准 cron 表达式（schedule = "0 7 * * *"）
 */

import fs from "fs";
import path from "path";
import { isDeepStrictEqual } from "node:util";
import {
  AUTOMATION_SCHEMA_VERSION,
  normalizeAutomationJob,
  normalizeAutomationJobs,
} from "./automation-normalizer.ts";
import {
  finalizeAutomationSuggestionReceipt,
  inspectAutomationSuggestionReceipt,
} from "./automation-suggestion-receipt.ts";
import { parseModelRef } from "../../shared/model-ref.ts";
import { filesystemIdentityKeySync } from "../../shared/link-aware-fs.ts";
import { atomicWriteSync } from "../../shared/safe-fs.ts";
import { createModuleLogger } from "../debug-log.ts";

const log = createModuleLogger("cron-store");
const MIN_EVERY_INTERVAL_MS = 60_000;
const DOUBLE_NORMALIZED_EVERY_FACTOR = 60_000;
const DOUBLE_NORMALIZED_EVERY_DIVISOR = MIN_EVERY_INTERVAL_MS * DOUBLE_NORMALIZED_EVERY_FACTOR;
const MAX_COMPAT_REPAIRED_EVERY_INTERVAL_MS = 366 * 24 * 60 * 60 * 1000;
const ACTIVE_STORE_MUTATIONS = new Set<string>();
const CONFIG_REVISION_FIELDS = Object.freeze([
  "type",
  "schedule",
  "label",
  "prompt",
  "model",
  "enabled",
  "actorAgentId",
  "executionContext",
  "executor",
  "createdBy",
]);

function clonePlain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function codedError(message, code, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

function parseCronStoreDocument(bytes) {
  let data;
  try {
    data = JSON.parse(bytes.toString("utf-8"));
  } catch {
    throw codedError("automation task storage is corrupt", "cron_store_corrupt", 500);
  }
  if (!data || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.jobs)) {
    throw codedError("automation task storage is corrupt", "cron_store_corrupt", 500);
  }
  return data;
}

function configRevisionProjection(job) {
  return Object.fromEntries(CONFIG_REVISION_FIELDS.map((key) => [key, clonePlain(job?.[key])]));
}

export function normalizeCronModelRef(model) {
  const parsed = parseModelRef(model);
  if (!parsed?.id) return "";
  if (parsed.provider) return { id: parsed.id, provider: parsed.provider };
  return parsed.id;
}

function clonePlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return JSON.parse(JSON.stringify(value));
}

function deriveJobLabel({ label, prompt, executor }) {
  if (typeof label === "string" && label.trim()) return label;
  if (typeof prompt === "string" && prompt.trim()) return prompt.slice(0, 30);
  const params = executor && typeof executor === "object" && !Array.isArray(executor)
    ? executor.params
    : null;
  if (typeof params?.title === "string" && params.title.trim()) return params.title.slice(0, 30);
  return "";
}

function validateAutomationExecutorForWrite(executor) {
  if (!executor) return;
  if (!executor.kind || executor.kind === "agent_session") return;
  throw new Error(`unsupported automation executor: ${executor.kind}`);
}

function isAgentSessionAutomation(job) {
  const normalized = normalizeAutomationJob(job);
  return !normalized.executor || normalized.executor.kind === "agent_session";
}

function assertCanEnableAutomationJob(job) {
  if (!job?.enabled) return;
  if (!isAgentSessionAutomation(job)) return;
  if (typeof job.prompt === "string" && job.prompt.trim()) return;
  throw new Error("prompt required to enable agent automation");
}

function parseEveryScheduleMs(schedule) {
  const ms = typeof schedule === "number" ? schedule : parseInt(schedule, 10);
  return Number.isFinite(ms) ? ms : NaN;
}

function normalizeEveryScheduleMs(schedule) {
  const ms = parseEveryScheduleMs(schedule);
  if (!Number.isFinite(ms)) return schedule;
  return Math.max(MIN_EVERY_INTERVAL_MS, ms);
}

function repairPersistedEverySchedule(schedule) {
  const ms = parseEveryScheduleMs(schedule);
  if (!Number.isSafeInteger(ms) || ms < DOUBLE_NORMALIZED_EVERY_DIVISOR) {
    return { schedule: normalizeEveryScheduleMs(schedule), repaired: false };
  }
  const decoded = ms / DOUBLE_NORMALIZED_EVERY_FACTOR;
  const isKnownPollutionShape =
    Number.isSafeInteger(decoded)
    && decoded >= MIN_EVERY_INTERVAL_MS
    && decoded <= MAX_COMPAT_REPAIRED_EVERY_INTERVAL_MS
    && ms % DOUBLE_NORMALIZED_EVERY_DIVISOR === 0;
  if (!isKnownPollutionShape) {
    return { schedule: normalizeEveryScheduleMs(schedule), repaired: false };
  }
  return { schedule: decoded, repaired: true };
}

function isValidRunAt(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  return Number.isFinite(new Date(value).getTime());
}

export class CronStore {
  declare _idPrefix: any;
  declare _jobs: any;
  declare _jobsPath: any;
  declare _nextNum: any;
  declare _runsDir: any;
  declare _storeRevision: number;
  declare _studioId: string | null;
  /** 退避表（毫秒）：0/1m/5m/15m/60m */
  static BACKOFF = [0, 60_000, 300_000, 900_000, 3_600_000];

  /**
   * @param {string} jobsPath - cron-jobs.json 路径
   * @param {string} runsDir  - cron-runs/ 目录路径
   */
  constructor(jobsPath, runsDir, options: any = {}) {
    this._jobsPath = jobsPath;
    this._runsDir = runsDir;
    this._idPrefix = options.idPrefix || "job";
    this._studioId = typeof options.studioId === "string" && options.studioId.trim()
      ? options.studioId.trim()
      : null;
    this._jobs = [];
    this._nextNum = 1;
    this._storeRevision = 0;
    this._load();
  }

  // ════════════════════════════
  //  持久化
  // ════════════════════════════

  _readRecoveryFile({ mainExists, mainBytes, primaryFailure }) {
    const tmpPath = this._jobsPath + ".tmp";
    let tmpBytes;
    try {
      tmpBytes = fs.readFileSync(tmpPath);
    } catch (err) {
      if (err?.code === "ENOENT" && primaryFailure === "missing") {
        return null;
      }
      if (err?.code === "ENOENT" && primaryFailure === "corrupt") {
        throw codedError("automation task storage is corrupt", "cron_store_corrupt", 500);
      }
      throw codedError("automation task storage is unavailable", "cron_store_unavailable", 500);
    }

    const data = parseCronStoreDocument(tmpBytes);

    let backupPath = null;
    try {
      if (mainExists) {
        backupPath = this._preservePrimaryForRecovery(mainBytes);
      }
      fs.renameSync(tmpPath, this._jobsPath);
    } catch (err) {
      log.error(`恢复 cron jobs 文件失败: ${err instanceof Error ? err.message : String(err)}`);
      throw codedError("automation task recovery failed", "cron_store_recovery_failed", 500);
    }
    log.error(backupPath
      ? "主文件 JSON 损坏或不可读，已保留备份并从 .tmp 恢复"
      : "主文件缺失，已从 .tmp 恢复");
    return data;
  }

  _preservePrimaryForRecovery(mainBytes) {
    const stem = `${this._jobsPath}.corrupt-${Date.now().toString(36)}-${process.pid}`;
    for (let attempt = 0; attempt < 10_000; attempt += 1) {
      const backupPath = `${stem}-${attempt}.bak`;
      try {
        if (mainBytes) {
          fs.writeFileSync(backupPath, mainBytes, { flag: "wx" });
        } else {
          fs.copyFileSync(this._jobsPath, backupPath, fs.constants.COPYFILE_EXCL);
        }
        return backupPath;
      } catch (err) {
        if (err?.code === "EEXIST") continue;
        throw err;
      }
    }
    throw new Error("unable to allocate cron store backup name");
  }

  _readState() {
    let mainBytes;
    let data;
    try {
      mainBytes = fs.readFileSync(this._jobsPath);
    } catch (err) {
      if (err?.code === "ENOENT") {
        data = this._readRecoveryFile({
          mainExists: false,
          mainBytes: null,
          primaryFailure: "missing",
        });
        if (data === null) {
          return { jobs: [], nextNum: 1, storeRevision: 0, dirty: false };
        }
      } else {
        log.error(`读取 jobs 文件失败: ${err instanceof Error ? err.message : String(err)}`);
        data = this._readRecoveryFile({
          mainExists: true,
          mainBytes: null,
          primaryFailure: "unavailable",
        });
      }
    }

    if (mainBytes) {
      try {
        data = parseCronStoreDocument(mainBytes);
      } catch (err) {
        if (err?.code !== "cron_store_corrupt") throw err;
        data = this._readRecoveryFile({
          mainExists: true,
          mainBytes,
          primaryFailure: "corrupt",
        });
      }
    }

    const jobs = Array.isArray(data.jobs) ? clonePlain(data.jobs) : [];
    const nextNum = Number.isSafeInteger(data.nextNum) && data.nextNum > 0
      ? data.nextNum
      : jobs.length + 1;
    const storeRevision = Number.isSafeInteger(data.storeRevision) && data.storeRevision >= 0
      ? data.storeRevision
      : 0;

    // 旧数据清洗
    let dirty = false;
    const loadTime = new Date().toISOString();
    for (const job of jobs) {
      if (this._studioId && job.studioId !== this._studioId) {
        job.studioId = this._studioId;
        dirty = true;
      }
      // model 统一规范：默认模型为空串；显式模型保留 {id, provider} 复合键。
      const normalizedModel = normalizeCronModelRef(job.model);
      if (JSON.stringify(job.model ?? "") !== JSON.stringify(normalizedModel)) {
        job.model = normalizedModel;
        dirty = true;
      }
      // every 类型的持久化契约是毫秒。读旧数据时同时修正早期
      // suggestion add 入口把毫秒再次当分钟乘 60000 的污染值。
      if (job.type === "every") {
        const repaired = repairPersistedEverySchedule(job.schedule);
        if (job.schedule !== repaired.schedule) {
          job.schedule = repaired.schedule;
          if (job.enabled !== false && repaired.repaired) {
            job.nextRunAt = this._calcNextRun(job.type, job.schedule, loadTime);
          }
          dirty = true;
        }
      }
      // consecutiveErrors 缺失补 0
      if (job.consecutiveErrors === undefined) {
        job.consecutiveErrors = 0;
        dirty = true;
      }
    }
    const normalizedJobs = normalizeAutomationJobs(jobs);
    if (JSON.stringify(jobs) !== JSON.stringify(normalizedJobs)) {
      dirty = true;
    }
    for (const job of normalizedJobs) {
      if (this._repairEnabledJobCursor(job, loadTime)) dirty = true;
    }
    return { jobs: normalizedJobs, nextNum, storeRevision, dirty };
  }

  _adoptState(state) {
    this._jobs = state.jobs;
    this._nextNum = state.nextNum;
    this._storeRevision = state.storeRevision;
  }

  _writeState(state) {
    fs.mkdirSync(path.dirname(this._jobsPath), { recursive: true });
    const data = JSON.stringify({
      storeRevision: state.storeRevision,
      jobs: state.jobs,
      nextNum: state.nextNum,
    }, null, 2) + "\n";
    // atomic write: tmp + rename，防止写到一半崩溃损坏文件
    atomicWriteSync(this._jobsPath, data);
  }

  _load() {
    const state = this._readState();
    if (state.dirty) {
      state.storeRevision += 1;
      this._writeState(state);
      state.dirty = false;
    }
    this._adoptState(state);
  }

  _mutationKey() {
    return filesystemIdentityKeySync(this._jobsPath);
  }

  _mutate(mutator) {
    const key = this._mutationKey();
    if (ACTIVE_STORE_MUTATIONS.has(key)) {
      throw codedError("cron store does not allow reentrant writes", "cron_store_reentrant_write");
    }
    ACTIVE_STORE_MUTATIONS.add(key);
    try {
      const base = this._readState();
      const draft = {
        jobs: clonePlain(base.jobs),
        nextNum: base.nextNum,
        storeRevision: base.storeRevision,
        dirty: false,
      };
      const outcome = mutator(draft) || {};
      if (outcome && typeof outcome.then === "function") {
        throw codedError("cron store mutator must be synchronous", "cron_store_async_mutator_forbidden");
      }
      if (outcome.changed === false) {
        this._adoptState(base);
        outcome.afterCommit?.();
        return clonePlain(outcome.value);
      }
      draft.jobs = normalizeAutomationJobs(draft.jobs);
      draft.storeRevision = base.storeRevision + 1;
      this._writeState(draft);
      this._adoptState(draft);
      outcome.afterCommit?.();
      return clonePlain(outcome.value);
    } finally {
      ACTIVE_STORE_MUTATIONS.delete(key);
    }
  }

  // ════════════════════════════
  //  Job CRUD
  // ════════════════════════════

  /**
   * 添加任务
   * @param {object} opts
   * @param {"at"|"every"|"cron"} opts.type - 调度类型
   * @param {string|number} opts.schedule - 调度参数
   * @param {string} opts.prompt - 执行时的 prompt
   * @param {string} [opts.mode="isolated"] - 执行模式
   * @param {string} [opts.label] - 显示标签
   * @param {string} [opts.model] - 指定模型（为空则用 agent 默认模型）
   * @returns {object} 新建的 job
   */
  addJob({
    type,
    schedule,
    prompt,
    mode = "isolated",
    label = "",
    model = "",
    actorAgentId = null,
    executionContext = null,
    legacyRef = null,
    executor = null,
    createdBy = null,
    authorization: _untrustedAuthorization = null,
    enabled = true,
  }, options: any = {}) {
    return this._mutate((state) => {
      const VALID_TYPES = new Set(["at", "every", "cron"]);
      if (!VALID_TYPES.has(type)) {
        throw new Error(`无效的 job type: "${type}"，必须是 at / every / cron`);
      }
      const normalizedSchedule = type === "every" ? normalizeEveryScheduleMs(schedule) : schedule;
      if (type === "at") {
        const target = new Date(normalizedSchedule);
        if (isNaN(target.getTime())) {
          throw new Error(`无效的 at schedule: "${normalizedSchedule}"，无法解析为日期`);
        }
        if (target <= new Date()) {
          throw new Error(`at schedule 已过期: "${normalizedSchedule}"，必须是未来时间`);
        }
      }
      const now = new Date().toISOString();
      validateAutomationExecutorForWrite(executor);
      const job = {
        id: this._nextJobId(state),
        schemaVersion: AUTOMATION_SCHEMA_VERSION,
        ...(this._studioId ? { studioId: this._studioId } : {}),
        configRevision: 1,
        type,
        schedule: normalizedSchedule,
        prompt: typeof prompt === "string" ? prompt : "",
        mode,
        label: deriveJobLabel({ label, prompt, executor }),
        model: normalizeCronModelRef(model),
        enabled: enabled !== false,
        consecutiveErrors: 0,
        createdAt: now,
        lastRunAt: null,
        nextRunAt: this._calcNextRun(type, normalizedSchedule, now),
      };
      this._attachOwnershipFields(job, { actorAgentId, executionContext, legacyRef });
      this._attachAutomationFields(job, { executor, createdBy });
      const receipt = this._applySuggestionReceipt(options, {
        operation: "create",
        jobId: null,
        baseConfigRevision: null,
      });
      const normalized = normalizeAutomationJob(job);
      assertCanEnableAutomationJob(normalized);
      state.jobs.push(normalized);
      return {
        changed: true,
        value: normalized,
        afterCommit: receipt
          ? () => finalizeAutomationSuggestionReceipt(receipt)
          : null,
      };
    });
  }

  /**
   * 导入已存在的任务，不做 at 未来时间校验，保留运行状态与 nextRunAt。
   * @param {object} input
   * @returns {object}
   */
  addImportedJob(input) {
    return this._mutate((state) => {
      const VALID_TYPES = new Set(["at", "every", "cron"]);
      const type = input?.type;
      if (!VALID_TYPES.has(type)) {
        throw new Error(`无效的 job type: "${type}"，必须是 at / every / cron`);
      }
      if (typeof input.prompt !== "string" || !input.prompt.trim()) {
        const explicitExecutor = clonePlainObject(input.executor);
        if (!explicitExecutor) throw new Error("cron import requires prompt");
      }
      validateAutomationExecutorForWrite(input.executor);
      const schedule = type === "every"
        ? repairPersistedEverySchedule(input.schedule).schedule
        : input.schedule;
      const now = new Date().toISOString();
      const job = {
        id: this._nextJobId(state),
        schemaVersion: AUTOMATION_SCHEMA_VERSION,
        ...(this._studioId ? { studioId: this._studioId } : {}),
        configRevision: 1,
        type,
        schedule,
        prompt: typeof input.prompt === "string" ? input.prompt : "",
        mode: input.mode || "isolated",
        label: deriveJobLabel({ label: input.label, prompt: input.prompt, executor: input.executor }),
        model: normalizeCronModelRef(input.model),
        enabled: input.enabled !== false,
        consecutiveErrors: Number.isFinite(input.consecutiveErrors) ? input.consecutiveErrors : 0,
        createdAt: typeof input.createdAt === "string" ? input.createdAt : now,
        lastRunAt: typeof input.lastRunAt === "string" ? input.lastRunAt : null,
        nextRunAt: typeof input.nextRunAt === "string" || input.nextRunAt === null
          ? input.nextRunAt
          : this._calcNextRun(type, schedule, now),
      };
      this._attachOwnershipFields(job, input);
      this._attachAutomationFields(job, input);
      const normalized = normalizeAutomationJob(job);
      this._repairEnabledJobCursor(normalized, now);
      state.jobs.push(normalized);
      return { changed: true, value: normalized };
    });
  }

  _nextJobId(state) {
    let id;
    do {
      id = `${this._idPrefix}_${state.nextNum++}`;
    } while (state.jobs.some((job) => job.id === id));
    return id;
  }

  _attachOwnershipFields(job, { actorAgentId = null, executionContext = null, legacyRef = null } = {}) {
    if (typeof actorAgentId === "string" && actorAgentId.trim()) {
      job.actorAgentId = actorAgentId.trim();
    }
    if (executionContext && typeof executionContext === "object" && !Array.isArray(executionContext)) {
      job.executionContext = JSON.parse(JSON.stringify(executionContext));
    }
    if (legacyRef && typeof legacyRef === "object" && !Array.isArray(legacyRef)) {
      job.legacyRef = JSON.parse(JSON.stringify(legacyRef));
    }
  }

  _attachAutomationFields(job, { executor = null, createdBy = null } = {}) {
    const normalizedExecutor = clonePlainObject(executor);
    if (normalizedExecutor) job.executor = normalizedExecutor;
    const normalizedCreatedBy = clonePlainObject(createdBy);
    if (normalizedCreatedBy) job.createdBy = normalizedCreatedBy;
  }

  _applySuggestionReceipt(options, expected) {
    const receipt = options?.suggestionReceipt ?? null;
    if (!receipt) return null;
    inspectAutomationSuggestionReceipt(receipt, {
      studioId: this._studioId,
      ...expected,
    });
    return receipt;
  }

  /**
   * 删除任务
   * @param {string} id
   * @returns {boolean}
   */
  removeJob(id) {
    return this._mutate((state) => {
      const idx = state.jobs.findIndex(j => j.id === id);
      if (idx === -1) return { changed: false, value: false };
      state.jobs.splice(idx, 1);
      return { changed: true, value: true };
    });
  }

  /**
   * 获取单个任务
   * @param {string} id
   * @returns {object|null}
   */
  getJob(id) {
    this._load();
    const job = this._jobs.find(j => j.id === id) || null;
    return job ? normalizeAutomationJob(job) : null;
  }

  /**
   * 列出所有任务（每次从磁盘重读，确保跨实例的写入都能被感知）
   * @returns {object[]}
   */
  listJobs() {
    this._load();
    return this._jobs.map((job) => normalizeAutomationJob(job));
  }

  /**
   * 更新任务字段
   * @param {string} id
   * @param {object} partial
   * @returns {object|null}
   */
  updateJob(id, partial, options: any = {}) {
    return this._mutate((state) => {
      const currentIndex = state.jobs.findIndex(job => job.id === id);
      if (currentIndex === -1) {
        if (options?.suggestionReceipt) {
          throw codedError(
            "automation no longer exists",
            "cron_job_revision_conflict",
            410,
          );
        }
        return { changed: false, value: null };
      }
      const current = normalizeAutomationJob(state.jobs[currentIndex]);
      const receipt = options?.suggestionReceipt ?? null;
      const receiptClaims = receipt
        ? inspectAutomationSuggestionReceipt(receipt, {
          studioId: this._studioId,
          operation: "update",
          jobId: id,
        })
        : null;
      if (receiptClaims && receiptClaims.baseConfigRevision !== current.configRevision) {
        throw codedError(
          "automation changed after this suggestion was created",
          "cron_job_revision_conflict",
        );
      }

      const job = clonePlain(current);
      const ALLOWED = new Set([
        "label",
        "model",
        "schedule",
        "prompt",
        "enabled",
        "type",
        "actorAgentId",
        "executionContext",
        "executor",
        "createdBy",
      ]);
      const VALID_TYPES = new Set(["at", "every", "cron"]);
      if ("type" in partial && !VALID_TYPES.has(partial.type)) {
        throw new Error(`无效的 job type: "${partial.type}"，必须是 at / every / cron`);
      }
      if ("type" in partial && partial.type !== job.type && !("schedule" in partial)) {
        throw new Error("修改 job type 时必须同时提供 schedule");
      }
      for (const key of Object.keys(partial || {})) {
        if (!ALLOWED.has(key)) continue;
        let value = partial[key];
        if (key === "model") value = normalizeCronModelRef(value);
        if (key === "type") value = String(value);
        if (key === "actorAgentId") {
          if (typeof value === "string" && value.trim()) job.actorAgentId = value.trim();
          continue;
        }
        if (key === "executionContext") {
          if (value && typeof value === "object" && !Array.isArray(value)) job.executionContext = clonePlain(value);
          continue;
        }
        if (key === "executor") {
          validateAutomationExecutorForWrite(value);
          if (value && typeof value === "object" && !Array.isArray(value)) job.executor = clonePlain(value);
          continue;
        }
        if (key === "createdBy") {
          if (value && typeof value === "object" && !Array.isArray(value)) job.createdBy = clonePlain(value);
          continue;
        }
        job[key] = value;
      }
      if ("schedule" in partial || "type" in partial) {
        if (job.type === "every") {
          const ms = parseEveryScheduleMs(job.schedule);
          if (!Number.isFinite(ms) || ms <= 0) {
            throw new Error(`无效的 every schedule: "${job.schedule}"，必须是正整数毫秒`);
          }
          job.schedule = Math.max(MIN_EVERY_INTERVAL_MS, ms);
        }
        if (job.type === "at") {
          const target = new Date(job.schedule);
          if (isNaN(target.getTime())) {
            throw new Error(`无效的 at schedule: "${job.schedule}"，无法解析为日期`);
          }
          if (target <= new Date()) {
            throw new Error(`at schedule 已过期: "${job.schedule}"，必须是未来时间`);
          }
        }
        job.nextRunAt = this._calcNextRun(job.type, job.schedule, new Date().toISOString());
      }
      this._repairEnabledJobCursor(job, new Date().toISOString());

      const configChanged = !isDeepStrictEqual(
        configRevisionProjection(current),
        configRevisionProjection(job),
      );
      if (configChanged) {
        job.configRevision = current.configRevision + 1;
      } else {
        job.configRevision = current.configRevision;
      }

      const appliedReceipt = this._applySuggestionReceipt(options, {
        operation: "update",
        jobId: id,
        baseConfigRevision: current.configRevision,
      });
      const normalized = normalizeAutomationJob(job);
      assertCanEnableAutomationJob(normalized);
      state.jobs[currentIndex] = normalized;
      return {
        changed: !isDeepStrictEqual(current, normalized),
        value: normalized,
        afterCommit: appliedReceipt
          ? () => finalizeAutomationSuggestionReceipt(appliedReceipt)
          : null,
      };
    });
  }

  /**
   * 切换任务启用/禁用
   * @param {string} id
   * @returns {object|null}
   */
  toggleJob(id) {
    return this._mutate((state) => {
      const index = state.jobs.findIndex(job => job.id === id);
      if (index === -1) return { changed: false, value: null };
      const job = clonePlain(state.jobs[index]);
      job.enabled = !job.enabled;
      job.configRevision = (Number.isSafeInteger(job.configRevision) && job.configRevision > 0
        ? job.configRevision
        : 1) + 1;
      if (job.enabled) job.nextRunAt = this._calcNextRun(job.type, job.schedule, new Date().toISOString());
      const normalized = normalizeAutomationJob(job);
      assertCanEnableAutomationJob(normalized);
      state.jobs[index] = normalized;
      return { changed: true, value: normalized };
    });
  }

  /**
   * 标记任务已执行，更新 lastRunAt + nextRunAt
   * @param {string} id
   * @param {object} [opts]
   * @param {boolean} [opts.success=true] - 是否执行成功
   */
  markRun(id, { success = true, expectedConfigRevision = null } = {}) {
    return this._mutate((state) => {
      const index = state.jobs.findIndex(job => job.id === id);
      if (index === -1) return { changed: false, value: false };
      const job = clonePlain(state.jobs[index]);
      if (
        expectedConfigRevision != null
        && job.configRevision !== expectedConfigRevision
      ) {
        return { changed: false, value: false };
      }
      const now = new Date().toISOString();
      job.lastRunAt = now;
      if (success) {
        job.consecutiveErrors = 0;
        job.nextRunAt = this._calcNextRun(job.type, job.schedule, now);
      } else {
        job.consecutiveErrors = (job.consecutiveErrors || 0) + 1;
        const normalNext = this._calcNextRun(job.type, job.schedule, now);
        const backoffIdx = Math.min(job.consecutiveErrors, CronStore.BACKOFF.length - 1);
        const backoffMs = CronStore.BACKOFF[backoffIdx];
        const backoffNext = new Date(Date.now() + backoffMs).toISOString();
        job.nextRunAt = normalNext && normalNext > backoffNext ? normalNext : backoffNext;
      }
      if (job.type === "at" && job.enabled !== false) {
        job.enabled = false;
        job.configRevision = (Number.isSafeInteger(job.configRevision) && job.configRevision > 0
          ? job.configRevision
          : 1) + 1;
      }
      state.jobs[index] = normalizeAutomationJob(job);
      return { changed: true, value: true };
    });
  }

  // ════════════════════════════
  //  运行历史
  // ════════════════════════════

  /**
   * 记录一次运行
   * @param {string} jobId
   * @param {object} run - { status, startedAt, finishedAt, error? }
   */
  logRun(jobId, run) {
    const filePath = path.join(this._runsDir, `${jobId}.jsonl`);
    const line = JSON.stringify({ ...run, timestamp: new Date().toISOString() }) + "\n";
    fs.mkdirSync(this._runsDir, { recursive: true });
    fs.appendFileSync(filePath, line, "utf-8");

    // 修剪：超过 500 行时只留最后 300 行
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.trim().split("\n");
      if (lines.length > 500) {
        atomicWriteSync(filePath, lines.slice(-300).join("\n") + "\n");
      }
    } catch { /* 修剪失败不影响主流程 */ }
  }

  /**
   * 读取运行历史
   * @param {string} jobId
   * @param {number} [limit=20]
   * @returns {object[]}
   */
  getRunHistory(jobId, limit = 20) {
    const filePath = path.join(this._runsDir, `${jobId}.jsonl`);
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const lines = raw.trim().split("\n").filter(Boolean);
      return lines
        .slice(-limit)
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  // ════════════════════════════
  //  调度计算
  // ════════════════════════════

  /**
   * 计算下次执行时间
   * @param {"at"|"every"|"cron"} type
   * @param {string|number} schedule
   * @param {string} fromISO - 基准时间（ISO string）
   * @returns {string|null} ISO string
   */
  _calcNextRun(type, schedule, fromISO) {
    const from = new Date(fromISO);

    switch (type) {
      case "at": {
        // 一次性：schedule 就是目标时间
        const target = new Date(schedule);
        if (isNaN(target.getTime())) return null;
        return target > from ? target.toISOString() : null;
      }

      case "every": {
        // 间隔：从现在起 schedule 毫秒后
        const ms = typeof schedule === "number" ? schedule : parseInt(schedule, 10);
        if (isNaN(ms) || ms <= 0) return null;
        return new Date(from.getTime() + ms).toISOString();
      }

      case "cron": {
        // 完整 5 字段 cron 解析
        return this._parseSimpleCron(schedule, from);
      }

      default:
        return null;
    }
  }

  _repairEnabledJobCursor(job, fromISO = new Date().toISOString()) {
    if (!job || job.enabled !== true) return false;
    if (isValidRunAt(job.nextRunAt)) return false;
    const nextRunAt = this._calcNextRun(job.type, job.schedule, fromISO);
    const normalized = isValidRunAt(nextRunAt) ? nextRunAt : null;
    if (job.nextRunAt === normalized) return false;
    job.nextRunAt = normalized;
    return true;
  }

  /**
   * 完整 cron 解析：支持标准 5 字段 cron 表达式
   *
   * 字段：分(0-59) 时(0-23) 日(1-31) 月(1-12) 周(0-6, 0=周日, 7也=周日)
   * 语法：数字 | * | *\/N | N-M | N-M/S | N,M,...
   *
   * @param {string} expr - cron 表达式
   * @param {Date} from - 基准时间
   * @returns {string|null}
   */
  _parseSimpleCron(expr, from) {
    const parts = expr.trim().split(/\s+/);
    if (parts.length < 5) return null;

    const ranges = [
      [0, 59],  // 分
      [0, 23],  // 时
      [1, 31],  // 日
      [1, 12],  // 月
      [0, 6],   // 周（0=周日）
    ];

    const fields = [];
    for (let i = 0; i < 5; i++) {
      const set = this._parseCronField(parts[i], ranges[i][0], ranges[i][1], i === 4);
      if (!set) return null;
      fields.push(set);
    }

    const [minutes, hours, days, months, weekdays] = fields;
    const dayOfMonthRestricted = parts[2] !== "*";
    const dayOfWeekRestricted = parts[4] !== "*";

    // 从下一分钟开始搜索，上限 366 天（覆盖年度 cron）
    const start = new Date(from);
    start.setSeconds(0, 0);
    start.setMinutes(start.getMinutes() + 1);

    const limit = 366 * 24 * 60;
    for (let i = 0; i < limit; i++) {
      const t = new Date(start.getTime() + i * 60_000);
      if (!months.has(t.getMonth() + 1)) continue;
      const matchesDayOfMonth = days.has(t.getDate());
      const matchesDayOfWeek = weekdays.has(t.getDay());
      const matchesDay =
        dayOfMonthRestricted && dayOfWeekRestricted
          ? (matchesDayOfMonth || matchesDayOfWeek)
          : (matchesDayOfMonth && matchesDayOfWeek);
      if (!matchesDay) continue;
      if (!hours.has(t.getHours())) continue;
      if (!minutes.has(t.getMinutes())) continue;
      return t.toISOString();
    }

    return null;
  }

  /**
   * 解析单个 cron 字段为值集合
   * @param {string} field - 字段字符串
   * @param {number} min - 最小值
   * @param {number} max - 最大值
   * @param {boolean} isWeekday - 是否为周字段（7→0）
   * @returns {Set<number>|null}
   */
  _parseCronField(field, min, max, isWeekday = false) {
    const values = new Set();

    for (const segment of field.split(",")) {
      // */N — 步进
      if (segment.startsWith("*/")) {
        const step = parseInt(segment.slice(2), 10);
        if (isNaN(step) || step <= 0) return null;
        for (let v = min; v <= max; v += step) values.add(v);
        continue;
      }

      // * — 全部
      if (segment === "*") {
        for (let v = min; v <= max; v++) values.add(v);
        continue;
      }

      // N-M 或 N-M/S — 范围（可选步进）
      const rangeMatch = segment.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
      if (rangeMatch) {
        const lo = parseInt(rangeMatch[1], 10);
        const hi = parseInt(rangeMatch[2], 10);
        const step = rangeMatch[3] ? parseInt(rangeMatch[3], 10) : 1;
        if (isNaN(lo) || isNaN(hi) || isNaN(step) || step <= 0) return null;
        if (lo > hi) return null;  // 反向范围
        const effectiveMax = isWeekday ? 7 : max;
        if (lo < min || hi > effectiveMax) return null;  // 越界
        for (let v = lo; v <= hi; v += step) values.add(isWeekday && v === 7 ? 0 : v);
        continue;
      }

      // 纯数字
      const num = parseInt(segment, 10);
      if (isNaN(num)) return null;
      const effectiveMax = isWeekday ? 7 : max;
      if (num < min || num > effectiveMax) return null;  // 越界
      values.add(isWeekday && num === 7 ? 0 : num);
    }

    return values.size > 0 ? values : null;
  }

  /** 任务数量 */
  get size() {
    return this._jobs.length;
  }

  /** 启用的任务数量 */
  get enabledCount() {
    return this._jobs.filter(j => j.enabled).length;
  }
}
