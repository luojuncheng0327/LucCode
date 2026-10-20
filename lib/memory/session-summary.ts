/**
 * session-summary.js — Session 摘要管理器
 *
 * 每个 session 一个 JSON 文件（存在 memory/summaries/ 下），
 * 包含摘要文本 + 深度记忆处理的 snapshot。
 *
 * 摘要通过 rollingSummary() 滚动更新（覆盖式，非追加），
 * 输出固定为 rolling-summary-format.ts 契约规定的 facts + timeline 两节格式。
 *
 * 同时服务：
 * - 普通记忆（compile.js 读摘要 → 递归压缩 → memory.md）
 * - 深度记忆（deep-memory.js 读 snapshot diff → 拆元事实）
 */

import fs from "fs";
import path from "path";
import { atomicWriteSync } from "../../shared/safe-fs.ts";
import { scrubPII } from "../pii-guard.ts";
import { callText } from "../../core/llm-client.ts";
import { callTextConfigFromResolvedModel } from "../../core/model-execution-config.ts";
import { getToolArgs, isToolCallBlock } from "../../core/llm-utils.ts";
import { getLocale } from "../i18n.ts";
import { readCompiledResetAt } from "./compiled-memory-state.ts";
import { attachPromptLayoutMetadata, buildUtilityPromptLayout } from "../llm/prompt-layout.ts";
import {
  buildSourceTimeRange,
  formatZonedDateTime,
  resolveMemoryTimeZone,
} from "./time-context.ts";
import { createModuleLogger } from "../debug-log.ts";
import { withMemoryReasoningBuffer } from "./llm-budget.ts";
import {
  MAX_ROLLING_SUMMARY_FORMAT_REPAIRS,
  buildRollingSummaryFormatRequirements,
  buildRollingSummaryRepairInput,
  buildRollingSummaryRepairPrompt,
  getFactSectionTitle,
  getTimelineSectionTitle,
  validateRollingSummaryFormat,
} from "./rolling-summary-format.ts";

const log = createModuleLogger("session-summary");

export function sessionSummaryRevision(data) {
  if (!data || typeof data !== "object") return null;
  return JSON.stringify({
    updatedAt: data.updated_at || null,
    summary: data.summary || "",
    snapshot: data.snapshot || "",
    cursor: data.cursor || null,
    snapshotCursor: data.snapshotCursor || null,
    factReplacementRequired: data.factReplacementRequired === true,
  });
}

export class SessionSummaryManager {
  declare summariesDir: string;
  declare _cache: Map<string, any>;
  declare _cachePopulated: boolean;

  /**
   * @param {string} summariesDir - summaries/ 目录的绝对路径
   */
  constructor(summariesDir) {
    this.summariesDir = summariesDir;
    fs.mkdirSync(summariesDir, { recursive: true });
    this._cache = new Map();          // sessionId → summary data
    this._cachePopulated = false;     // 是否已做过全量扫描
  }

  // ════════════════════════════
  //  读写
  // ════════════════════════════

  /**
   * 读取指定 session 的摘要
   * @param {string} sessionId
   * @returns {object|null}
   */
  getSummary(sessionId) {
    if (this._cache.has(sessionId)) return this._cache.get(sessionId);
    const fp = this._filePath(sessionId);
    try {
      const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
      this._cache.set(sessionId, data);
      return data;
    } catch {
      return null;
    }
  }

  /**
   * 写入摘要（原子写入）
   * @param {string} sessionId
   * @param {object} data
   */
  saveSummary(sessionId, data) {
    const fp = this._filePath(sessionId);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    atomicWriteSync(fp, JSON.stringify(data, null, 2) + "\n");
    this._cache.set(sessionId, data);
  }

  /**
   * A fork owns an independent memory lineage. Keep the source/boundary metadata,
   * but start the child's rolling-summary cursor at zero so its first memory pass
   * can derive durable state from its own active transcript. Reusing the source
   * message count would couple the child to the source summary and also mixes count
   * domains when compiled-memory resetAt filtering is active.
   */
  initializeForkBaseline(sessionId, input: Record<string, any> = {}) {
    const normalized = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!normalized) throw new Error("fork memory baseline requires sessionId");
    const sourceSessionId = typeof input.sourceSessionId === "string" ? input.sourceSessionId.trim() : "";
    const throughEntryId = typeof input.throughEntryId === "string" ? input.throughEntryId.trim() : "";
    const retainedMessageCount = Number(input.retainedMessageCount ?? input.messageCount);
    if (!sourceSessionId) throw new Error("fork memory baseline requires sourceSessionId");
    if (!throughEntryId) throw new Error("fork memory baseline requires throughEntryId");
    if (!Number.isInteger(retainedMessageCount) || retainedMessageCount < 0) {
      throw new Error("fork memory baseline retainedMessageCount must be a non-negative integer");
    }
    if (this.getSummary(normalized) || fs.existsSync(this._filePath(normalized))) {
      throw new Error(`fork memory baseline already exists for ${normalized}`);
    }
    const forkedAt = normalizeSince(input.forkedAt) || new Date().toISOString();
    const data = {
      session_id: normalized,
      created_at: forkedAt,
      updated_at: forkedAt,
      summary: "",
      messageCount: 0,
      source_time_range: null,
      snapshot: "",
      snapshot_at: null,
      fork_baseline: {
        sourceSessionId,
        throughEntryId,
        retainedMessageCount,
        forkedAt,
      },
    };
    this.saveSummary(normalized, data);
    return data;
  }

  /**
   * 作废单个 session 的派生摘要。Retry 改变 active branch 后，旧摘要不能继续
   * 参与 today/facts/deep-memory 编译。文件与内存缓存必须作为一个操作清掉。
   *
   * @param {string} sessionId
   * @returns {boolean} 是否删除了持久化摘要或缓存项
   */
  invalidateSession(sessionId, opts: Record<string, any> = {}) {
    const normalized = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!normalized) throw new Error("session summary invalidation requires sessionId");
    const existing = this.getSummary(normalized);
    const retainedMessageCount = Number(opts.retainedMessageCount);
    if (
      existing?.fork_baseline
      && Number.isInteger(retainedMessageCount)
      && retainedMessageCount >= 0
    ) {
      const inheritedCount = Number(
        existing.fork_baseline.retainedMessageCount
        ?? existing.fork_baseline.messageCount,
      );
      const nextRetainedCount = Number.isInteger(inheritedCount) && inheritedCount >= 0
        ? Math.min(inheritedCount, retainedMessageCount)
        : retainedMessageCount;
      const now = new Date().toISOString();
      this.saveSummary(normalized, {
        session_id: normalized,
        created_at: existing.created_at || existing.fork_baseline.forkedAt || now,
        updated_at: now,
        summary: "",
        messageCount: 0,
        source_time_range: null,
        snapshot: "",
        snapshot_at: null,
        fork_baseline: {
          ...existing.fork_baseline,
          retainedMessageCount: nextRetainedCount,
        },
      });
      return true;
    }
    const hadCache = this._cache.delete(normalized);
    try {
      fs.unlinkSync(this._filePath(normalized));
      return true;
    } catch (err) {
      if (err?.code === "ENOENT") return hadCache;
      throw err;
    }
  }

  // ════════════════════════════
  //  脏 session 追踪（供深度记忆用）
  // ════════════════════════════

  /**
   * 获取所有"脏" session（summary !== snapshot）
   * @returns {Array<{ session_id, summary, snapshot, snapshot_at, updated_at }>}
   */
  getDirtySessions(opts: Record<string, any> = {}) {
    this._ensureCachePopulated();
    const since = normalizeSince(opts.since);
    const dirty = [];
    for (const data of this._cache.values()) {
      if (!data?.summary && data?.factReplacementRequired !== true) continue;
      if (since && !isAfter(data.updated_at || data.created_at, since)) continue;
      if (data.factReplacementRequired === true || data.summary !== (data.snapshot || "")) {
        dirty.push(data);
      }
    }
    return dirty;
  }

  /**
   * 标记 session 已被深度记忆处理（snapshot = summary）
   * @param {string} sessionId
   */
  markProcessed(sessionId) {
    const data = this.getSummary(sessionId);
    if (!data) return;

    const next = {
      ...data,
      snapshot: data.summary,
      snapshotCursor: data.cursor || null,
      snapshot_at: new Date().toISOString(),
      factReplacementRequired: false,
    };
    this.saveSummary(sessionId, next);
    return true;
  }

  isRevisionCurrent(sessionId, expectedRevision) {
    return expectedRevision != null
      && sessionSummaryRevision(this.getSummary(sessionId)) === expectedRevision;
  }

  markProcessedIfCurrent(sessionId, expectedRevision) {
    if (!this.isRevisionCurrent(sessionId, expectedRevision)) return false;
    return this.markProcessed(sessionId);
  }

  // ════════════════════════════
  //  查询
  // ════════════════════════════

  /**
   * 获取所有摘要（按 updated_at 降序）
   * @returns {Array<object>}
   */
  getAllSummaries() {
    this._ensureCachePopulated();
    const summaries = [];
    for (const data of this._cache.values()) {
      if (data?.summary) summaries.push(data);
    }
    summaries.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
    return summaries;
  }

  /** 首次调用时做一次全量扫描填充缓存 */
  _ensureCachePopulated() {
    if (this._cachePopulated) return;
    const files = this._listFiles();
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(file, "utf-8"));
        if (data?.session_id) this._cache.set(data.session_id, data);
      } catch {}
    }
    this._cachePopulated = true;
  }

  /**
   * 获取指定日期范围内的摘要
   * @param {Date} startDate
   * @param {Date} endDate
   * @returns {Array<object>}
   */
  getSummariesInRange(startDate, endDate, opts: Record<string, any> = {}) {
    const startISO = startDate.toISOString();
    const endISO = endDate.toISOString();
    const since = normalizeSince(opts.since);

    return this.getAllSummaries().filter((s) => {
      const updated = s.updated_at || s.created_at || "";
      if (updated < startISO || updated > endISO) return false;
      if (since && !isAfter(updated, since)) return false;
      return true;
    });
  }

  clearCache() {
    this._cache.clear();
    this._cachePopulated = false;
  }

  clearAll() {
    fs.mkdirSync(this.summariesDir, { recursive: true });
    for (const file of this._listFiles()) {
      try { fs.unlinkSync(file); } catch (err) {
        if (err?.code !== "ENOENT") throw err;
      }
    }
    this.clearCache();
  }

  // ════════════════════════════
  //  内部
  // ════════════════════════════

  _filePath(sessionId) {
    // session 文件名可能包含时间戳前缀（如 1234567890_uuid），
    // 直接取 uuid 部分（去掉 .jsonl 后缀和时间戳前缀）
    const cleanId = sessionId.replace(/\.jsonl$/, "");
    return path.join(this.summariesDir, `${cleanId}.json`);
  }

  _listFiles() {
    try {
      return fs.readdirSync(this.summariesDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => path.join(this.summariesDir, f));
    } catch {
      return [];
    }
  }

  /**
   * 从消息列表构建带时间戳的对话文本
   * @param {Array<{role: string, content: any, timestamp?: string}>} messages
   * @returns {string}
   */
  _buildConversationText(messages, opts: Record<string, any> = {}) {
    const parts = [];
    const isZh = getLocale().startsWith("zh");
    const timeZone = resolveMemoryTimeZone(opts.timeZone);

    for (const msg of messages) {
      const segments = this._extractSummarySegments(msg, isZh);
      if (segments.length === 0) continue;

      // 时间标注
      let timePrefix = "";
      if (msg.timestamp) {
        const d = new Date(msg.timestamp);
        if (!isNaN(d.getTime())) {
          timePrefix = `[${formatZonedDateTime(d, timeZone)}] `;
        }
      }

      const speaker = msg.role === "user" ? (isZh ? "用户" : "User") : (isZh ? "助手" : "Assistant");
      for (const segment of segments) {
        parts.push(`${timePrefix}【${speaker}】${segment}`);
      }
    }

    return parts.join("\n\n");
  }

  _extractSummarySegments(msg, isZh) {
    if (!msg?.content) return [];

    if (typeof msg.content === "string") {
      const text = msg.content.trim();
      return text ? [text] : [];
    }

    if (!Array.isArray(msg.content)) return [];

    const segments = [];
    let textBuffer = "";
    const flushText = () => {
      const text = textBuffer.trim();
      if (text) segments.push(text);
      textBuffer = "";
    };

    for (const block of msg.content) {
      if (block?.type === "text" && block.text) {
        textBuffer += block.text;
        continue;
      }

      if (msg.role === "assistant" && isToolCallBlock(block)) {
        flushText();
        const title = this._summarizeToolCall(block, isZh);
        if (title) segments.push(title);
      }
    }

    flushText();
    return segments;
  }

  _summarizeToolCall(block, isZh) {
    const name = String(block?.name || "").trim();
    if (!name) return "";
    const args = getToolArgs(block) && typeof getToolArgs(block) === "object" ? getToolArgs(block) : {};
    const pick = (...keys) => {
      for (const key of keys) {
        const value = args[key];
        if (typeof value === "string" && value.trim()) return value.trim();
      }
      return "";
    };
    const shorten = (text, limit = 120) => {
      if (!text) return "";
      return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
    };

    switch (name) {
      case "read":
      case "read_file":
        return isZh ? `读取了 ${pick("file_path", "path")}` : `Read ${pick("file_path", "path")}`;
      case "write":
        return isZh ? `写入了 ${pick("file_path", "path")}` : `Wrote ${pick("file_path", "path")}`;
      case "edit":
      case "edit-diff":
        return isZh ? `修改了 ${pick("file_path", "path")}` : `Edited ${pick("file_path", "path")}`;
      case "bash":
        return isZh ? `执行了命令 ${shorten(pick("command"), 80)}` : `Ran command ${shorten(pick("command"), 80)}`;
      case "glob":
      case "find":
        return isZh ? `查找了 ${shorten(pick("pattern"), 80)}` : `Searched for ${shorten(pick("pattern"), 80)}`;
      case "grep": {
        const pattern = shorten(pick("pattern"), 60);
        const target = pick("path");
        return isZh
          ? `搜索了 ${pattern}${target ? `（范围 ${target}）` : ""}`
          : `Searched ${pattern}${target ? ` in ${target}` : ""}`;
      }
      case "ls":
        return isZh ? `查看了 ${pick("path")}` : `Listed ${pick("path")}`;
      case "web_fetch":
        return isZh ? `读取了网页 ${pick("url")}` : `Fetched ${pick("url")}`;
      case "web_search":
        return isZh ? `搜索了 ${shorten(pick("query"), 80)}` : `Searched ${shorten(pick("query"), 80)}`;
      case "browser": {
        const action = pick("action");
        const url = pick("url");
        const detail = url || action;
        return isZh ? `操作了浏览器${detail ? `（${detail}）` : ""}` : `Used browser${detail ? ` (${detail})` : ""}`;
      }
      case "search_memory":
        return isZh ? `搜索了记忆 ${shorten(pick("query"), 80)}` : `Searched memory ${shorten(pick("query"), 80)}`;
      case "subagent":
        return isZh ? `启动了子代理${pick("task", "prompt") ? `：${shorten(pick("task", "prompt"), 80)}` : ""}` : `Started subagent${pick("task", "prompt") ? `: ${shorten(pick("task", "prompt"), 80)}` : ""}`;
      case "dm":
        return isZh ? `发送了私信${pick("to") ? ` 给 ${pick("to")}` : ""}` : `Sent DM${pick("to") ? ` to ${pick("to")}` : ""}`;
      case "channel":
        return isZh ? `操作了频道 ${pick("channel", "name")}` : `Used channel ${pick("channel", "name")}`;
      case "cron":
        return isZh ? `设置了定时任务${pick("label", "prompt") ? `：${shorten(pick("label", "prompt"), 80)}` : ""}` : `Scheduled task${pick("label", "prompt") ? `: ${shorten(pick("label", "prompt"), 80)}` : ""}`;
      case "notify":
        return isZh ? `发送了通知${pick("title") ? `：${shorten(pick("title"), 80)}` : ""}` : `Sent notification${pick("title") ? `: ${shorten(pick("title"), 80)}` : ""}`;
      case "artifact":
        return isZh ? `生成了产物${pick("title") ? `：${shorten(pick("title"), 80)}` : ""}` : `Generated artifact${pick("title") ? `: ${shorten(pick("title"), 80)}` : ""}`;
      case "install_skill":
        return isZh
          ? `安装了技能 ${pick("skill_name", "github_url", "local_path", "fileId")}`
          : `Installed skill ${pick("skill_name", "github_url", "local_path", "fileId")}`;
      case "update_settings":
        return isZh ? `修改了设置 ${pick("key", "setting")}` : `Updated setting ${pick("key", "setting")}`;
      default: {
        const detail = shorten(
          pick("file_path", "path", "query", "url", "command", "pattern", "prompt", "label", "title"),
          80,
        );
        return isZh
          ? `调用了 ${name}${detail ? `：${detail}` : ""}`
          : `Called ${name}${detail ? `: ${detail}` : ""}`;
      }
    }
  }

  // ════════════════════════════
  //  滚动摘要
  // ════════════════════════════

  /**
   * 滚动更新 session 摘要：每 10 轮或 session 结束时触发。
   * 若有旧摘要则将旧摘要 + 新对话合并产出新摘要（覆盖，非追加）；
   * 若无旧摘要则直接从对话生成。
   * 输出格式固定为 rolling-summary-format.ts 契约规定的两节（facts + timeline）。
   *
   * @param {string} sessionId
   * @param {Array<{role: string, content: any, timestamp?: string}>} messages
   * @param {{ model: string, api: string, api_key: string, base_url: string }} resolvedModel
   * @returns {Promise<string>} 更新后的摘要文本
   */
  async rollingSummary(sessionId, messages, resolvedModel, opts: Record<string, any> = {}) {
    const draft = await this.createRollingSummaryDraft(sessionId, messages, resolvedModel, opts);
    if (draft?.data) {
      this.saveSummary(sessionId, draft.data);
    }
    return opts.returnResult === true ? draft : (draft?.summary || "");
  }

  /**
   * 生成 legacy utility rolling summary 草稿但不落盘。
   * session_snapshot memory reflection 走 live session side-task runner，
   * 不通过这个 utility_template 冷路径。
   *
   * @param {string} sessionId
   * @param {Array<{role: string, content: any, timestamp?: string}>} messages
   * @param {{ model: string, api: string, api_key: string, base_url: string }} resolvedModel
   * @returns {Promise<{summary: string, changed: boolean, data: object|null, usage?: object|null, reason?: string}>}
   */
  async createRollingSummaryDraft(sessionId, messages, resolvedModel, opts: Record<string, any> = {}) {
    const resetAt = latestSince(opts.resetAt, readCompiledResetAt(path.dirname(this.summariesDir)));
    const existingRaw = this.getSummary(sessionId);
    const existing = resetAt && existingRaw && !isAfter(existingRaw.updated_at || existingRaw.created_at, resetAt)
      ? null
      : existingRaw;
    const projection = normalizeBranchProjection(opts.projection);
    let mode = "legacy";
    let prevSummary = existing?.summary || "";
    let newMessages = messages;
    if (projection) {
      if (!existing) {
        mode = "initial";
        prevSummary = "";
      } else if (isCursorAncestorOfProjection(existing.cursor, projection)) {
        mode = "append";
        const coveredIndex = existing.cursor?.coveredLeafId == null
          ? -1
          : projection.lineage.findIndex((entry) => entry.id === existing.cursor.coveredLeafId);
        newMessages = messages.filter((message) => (
          Number.isInteger(message?.lineageIndex)
          && message.lineageIndex > coveredIndex
        ));
      } else {
        // messageCount cannot establish branch ancestry. Legacy summaries and
        // sibling/rewound branches must rebuild from the complete projection.
        mode = "replace";
        prevSummary = "";
      }
    } else {
      // 旧数据无 messageCount 时 fallback 到全量；显式 0 代表尚未覆盖任何消息。
      const hasMessageCount = Number.isInteger(existing?.messageCount) && existing.messageCount >= 0;
      const lastMessageCount = hasMessageCount ? existing.messageCount : 0;
      newMessages = hasMessageCount
        ? messages.slice(Math.min(lastMessageCount, messages.length))
        : messages;
    }

    const timeZone = resolveMemoryTimeZone(opts.timeZone);
    const sourceTimeRange = buildSourceTimeRange(messages, { timeZone });
    const convText = this._buildConversationText(newMessages, { timeZone });
    if (!convText) {
      if (projection) {
        const now = new Date().toISOString();
        const cursor = projectionCursor(projection);
        const replacement = mode === "replace";
        const summary = replacement ? "" : prevSummary;
        const cursorChanged = !sameCursor(existing?.cursor, cursor);
        const shouldSave = replacement || mode === "initial" || cursorChanged;
        return {
          summary,
          changed: replacement,
          mode,
          data: shouldSave ? {
            session_id: sessionId,
            created_at: existing?.created_at || now,
            updated_at: replacement ? now : (existing?.updated_at || now),
            summary,
            messageCount: messages.length,
            cursor,
            source_time_range: sourceTimeRange || (replacement ? null : existing?.source_time_range || null),
            snapshot: existing?.snapshot || "",
            snapshotCursor: existing?.snapshotCursor || null,
            snapshot_at: existing?.snapshot_at || null,
            factReplacementRequired: replacement || existing?.factReplacementRequired === true,
          } : null,
          usage: null,
          reason: replacement ? "empty_branch_replacement" : "empty_conversation",
        };
      }
      return {
        summary: prevSummary,
        changed: false,
        mode,
        data: null,
        usage: null,
        reason: "empty_conversation",
      };
    }

    // 按全量用户轮数计算摘要配额（预算反映对话整体体量，输入只传增量）
    const turnCount = messages.filter((m) => m.role === "user").length;
    const llmResult = await this._callRollingLLM(convText, prevSummary, resolvedModel, turnCount, {
      memoryReflectionSnapshot: opts.memoryReflectionSnapshot,
      returnUsage: opts.returnUsage,
      usageTrigger: opts.usageTrigger,
    });
    let usage = typeof llmResult === "object" && llmResult !== null ? llmResult.usage || null : null;
    let newSummary: any = typeof llmResult === "object" && llmResult !== null ? llmResult.text : llmResult;
    if (!newSummary?.trim()) {
      return {
        summary: prevSummary,
        changed: false,
        mode,
        data: null,
        usage,
        reason: "empty_output",
      };
    }

    // 写入前结构校验 + 有限次数格式修复（#1628）：摘要必须满足 compileEditableFacts
    // 的提取假设，否则 facts 会在编译侧静默丢失。最终修不好就抛错，由调用方
    // （memory ticker / 日记回填）按既有失败通道记录，旧摘要保持不被覆盖。
    let repairsUsed = 0;
    let validation = validateRollingSummaryFormat(newSummary);
    while (!validation.ok && repairsUsed < MAX_ROLLING_SUMMARY_FORMAT_REPAIRS) {
      repairsUsed += 1;
      log.warn(`rolling summary format invalid for ${sessionId} (${validation.issues.join("; ")}), repair attempt ${repairsUsed}/${MAX_ROLLING_SUMMARY_FORMAT_REPAIRS}`);
      const repairResult = await this._callRollingRepairLLM(newSummary, validation.issues, resolvedModel, turnCount, {
        returnUsage: opts.returnUsage,
        usageTrigger: opts.usageTrigger,
      });
      usage = typeof repairResult === "object" && repairResult !== null ? repairResult.usage || null : usage;
      newSummary = typeof repairResult === "object" && repairResult !== null ? repairResult.text : repairResult;
      if (!newSummary?.trim()) {
        validation = { ok: false, issues: [...validation.issues, "format repair attempt returned empty output"] };
        break;
      }
      validation = validateRollingSummaryFormat(newSummary);
    }
    if (!validation.ok) {
      throw new Error(`rolling summary format invalid after ${repairsUsed} repair attempt(s): ${validation.issues.join("; ")}`);
    }

    if (projection && typeof opts.revalidateProjection === "function") {
      const latestProjection = normalizeBranchProjection(await opts.revalidateProjection());
      if (!latestProjection || !projectionRemainsAncestor(projection, latestProjection)) {
        return {
          summary: existing?.summary || "",
          changed: false,
          mode,
          data: null,
          usage,
          reason: "branch_changed",
        };
      }
    }

    const latestResetAt = latestSince(resetAt, readCompiledResetAt(path.dirname(this.summariesDir)));
    if (latestResetAt && !areMessagesAfter(messages, latestResetAt)) {
      return {
        summary: prevSummary,
        changed: false,
        mode,
        data: null,
        usage,
        reason: "reset_watermark",
      };
    }

    // PII 脱敏
    const { cleaned: scrubbedRolling, detected: rollingDetected } = scrubPII(newSummary);
    if (rollingDetected.length > 0) {
      log.warn(`PII detected in rolling summary (${rollingDetected.join(", ")}), redacted`);
      newSummary = scrubbedRolling;
    }

    // 脱敏是结构保持操作；这里再守一道，确保最终落盘文本仍满足提取假设
    const finalValidation = validateRollingSummaryFormat(newSummary);
    if (!finalValidation.ok) {
      throw new Error(`rolling summary format invalid after PII scrub: ${finalValidation.issues.join("; ")}`);
    }

    const now = new Date().toISOString();
    const data = {
      session_id: sessionId,
      created_at: existing?.created_at || now,
      updated_at: now,
      summary: newSummary.trim(),
      messageCount: messages.length, // 记录已覆盖的消息总数
      ...(projection ? { cursor: projectionCursor(projection) } : {}),
      source_time_range: sourceTimeRange || existing?.source_time_range || null,
      snapshot: existing?.snapshot || "",
      snapshotCursor: existing?.snapshotCursor || null,
      snapshot_at: existing?.snapshot_at || null,
      ...(existingRaw?.fork_baseline ? { fork_baseline: existingRaw.fork_baseline } : {}),
      factReplacementRequired: mode === "replace" || existing?.factReplacementRequired === true,
    };

    return {
      summary: newSummary.trim(),
      changed: true,
      mode,
      data,
      usage,
      reason: rollingDetected.length > 0 ? "pii_redacted" : "",
    };
  }

  /**
   * 滚动摘要的输出预算（单一来源，初次生成与格式修复共用 visibleMaxTokens）
   * @param {number} turnCount
   * @returns {{ totalBudget: number, visibleMaxTokens: number }}
   */
  _rollingSummaryBudget(turnCount) {
    // 按轮数线性缩放：每轮 40 字配额，10 轮封顶 400 字
    const totalBudget = Math.min(400, Math.max(40, turnCount * 40));
    // max_tokens 跟着配额走，避免固定值引导 LLM 写满
    const visibleMaxTokens = Math.max(150, Math.min(750, Math.round(totalBudget * 1.5)));
    return { totalBudget, visibleMaxTokens };
  }

  /**
   * 格式修复调用：把不满足 compileEditableFacts 提取假设的摘要草稿重排进契约结构。
   * 只基于草稿本身修复（不重发对话内容），信息不增删。
   * @param {string} summaryText - 待修复的摘要草稿
   * @param {string[]} issues - validateRollingSummaryFormat 给出的失败原因
   * @param {{ model: string, api: string, api_key: string, base_url: string }} resolvedModel
   * @param {number} turnCount
   * @returns {Promise<string | { text: string, usage: object|null }>}
   */
  async _callRollingRepairLLM(summaryText, issues, resolvedModel, turnCount = 10, opts: Record<string, any> = {}) {
    const locale = getLocale();
    const { visibleMaxTokens } = this._rollingSummaryBudget(turnCount);
    const layout = buildUtilityPromptLayout({
      cacheGroup: "memory.rolling_summary",
      templateVersion: "rolling-summary-repair.v1",
      systemPrompt: buildRollingSummaryRepairPrompt(locale),
      userContent: buildRollingSummaryRepairInput({ locale, issues, summaryText }),
    });
    const usageContext = attachPromptLayoutMetadata({
      source: {
        subsystem: "memory",
        // 与初次生成（rolling_summary）可区分，修复用量不混进初次的账目
        operation: "rolling_summary_repair",
        surface: "system",
        trigger: opts.usageTrigger || "threshold",
      },
      attribution: {
        kind: "memory",
        agentId: resolvedModel.usageAgentId || null,
      },
    }, layout.usageMetadata);

    return callText({
      ...callTextConfigFromResolvedModel(resolvedModel),
      systemPrompt: layout.systemPrompt,
      messages: layout.messages,
      temperature: 0.3,
      maxTokens: withMemoryReasoningBuffer(visibleMaxTokens, resolvedModel),
      timeoutMs: 60_000,
      signal: undefined,
      returnUsage: opts.returnUsage === true,
      usageLedger: resolvedModel.usageLedger,
      usageContext,
    });
  }

  /**
   * 调用 LLM 生成滚动摘要（两节格式）
   * @param {string} convText - 本次对话文本
   * @param {string} prevSummary - 上一次摘要（可为空）
   * @param {{ model: string, api: string, api_key: string, base_url: string }} resolvedModel
   * @returns {Promise<string>}
   */
  async _callRollingLLM(convText, prevSummary, resolvedModel, turnCount = 10, opts: Record<string, any> = {}) {
    const locale = getLocale();
    const isZh = locale.startsWith("zh");
    const hasPrev = !!prevSummary;
    const memorySnapshot = normalizeMemoryReflectionSnapshot(opts.memoryReflectionSnapshot);
    const agentName = memorySnapshot.agentName || (isZh ? "这个 Agent" : "this agent");
    const userName = memorySnapshot.userName || (isZh ? "主人" : "the user");
    const identityAndPersonality = memorySnapshot.identityAndPersonality || (isZh ? "（未提供）" : "(Not provided)");
    const userProfile = memorySnapshot.userProfile || (isZh ? "（未提供）" : "(Not provided)");
    const existingMemory = memorySnapshot.existingMemory || (isZh ? "（暂无已有长期记忆）" : "(No existing long-term memory)");
    const roster = memorySnapshot.roster || (isZh ? "（没有其他 Agent）" : "(No other agents)");
    const formatRequirements = buildRollingSummaryFormatRequirements(locale);
    // 标题文本统一从格式契约取，prompt 文案禁止硬编码标题字面量
    const factTitle = getFactSectionTitle(locale);
    const timelineTitle = getTimelineSectionTitle(locale);

    const { totalBudget, visibleMaxTokens } = this._rollingSummaryBudget(turnCount);
    const factsBudget = Math.max(15, Math.round(totalBudget * 0.3));
    const eventsBudget = totalBudget - factsBudget;

    // 英文 budget 按 word 估算（约 1.5x 字符比）
    const factsWordBudget = Math.max(10, Math.round(factsBudget * 0.6));
    const eventsWordBudget = Math.max(20, Math.round(eventsBudget * 0.6));

    const systemPrompt = isZh
      ? `你是 ${agentName}。你正在整理自己刚刚经历的一段对话。

下面是你在本次对话开始前已经拥有的设定和记忆。它们是背景，不是新增事实。请从自己的视角审视本次对话，判断哪些新信息值得进入长期记忆。

## 你的身份与人格
${identityAndPersonality}

## 主人设定
${userProfile}

## 你已有的长期记忆
这是你在本次对话开始前已经拥有的记忆。不要因为它出现在这里就重复写入；只有本次对话更新、反驳、强化它时才记录变化。

${existingMemory}

## 花名册
花名册告诉你同处于这个系统里的别的 Agent。它只用于理解对话中的 Agent 名字和协作语境，不要把花名册本身当作新增记忆。

${roster}

## 核心原则
记忆的核心职责是维护你对${userName}的理解，让你以后更自然地理解这个人、你们的关系、长期项目和共同语境。摘要仍然以用户侧为中心：优先记录${userName}是谁、喜欢什么、在意什么、最近关注什么大主题。你的回复只需记录"做了什么"（如"生成了一篇关于X的文章""写了一段代码实现Y功能"），不记录回复的具体内容，也不记录即时内心想法。

${formatRequirements}

## 内容要求

**${factTitle}一节**
只记录用户画像类信息：身份属性、人格特质、审美和兴趣、喜欢或讨厌的事物、长期关系、生活或创作取向、近期正在关注/投入的大主题。没有则写 \`- 无\`。

不要抽：
- 工作方式偏好：用户希望助手怎样审查、规划、调研、实现、测试、汇报、commit、push
- 协作流程偏好：用户要求的步骤、确认点、验证顺序、上下文管理方式
- 工具和平台偏好：某次任务中使用什么工具、命令、文件、模型、目录
- 工程纪律和项目规则：这些属于项目文档或系统规则，不属于用户画像记忆
- 一次任务里的格式、标准、临时判断

只抽：
- 用户是什么样的人
- 用户喜欢或讨厌什么对象、风格、内容、体验
- 用户长期在意的主题、关系、身份、审美、价值取向
- 用户最近正在关注哪个领域/项目/主题，只保留大主题，不保留细节

判别标准：
- 如果这条信息回答的是“用户是谁、喜欢什么、在意什么”，可以抽。
- 如果这条信息回答的是“和用户工作时该怎么做”，不要抽。
- 如果这条信息回答的是“用户最近在关注哪个领域/项目/主题”，只保留大主题，不保留该主题里的细节。
- 拿不准一律不抽。宁可漏，不可错。

字数要求：按实际信息量写，遵守本次摘要预算。信息少就写短，不要凑字数。

**${timelineTitle}一节**
按时间顺序记录本 session 发生了什么，带 YYYY-MM-DD HH:MM 时间标注，抓重点脉络。工作相关内容只允许保留到大主题层级。
工作内容可以写成“用户在讨论记忆系统”“用户在做 Project Luc”，不要写具体子问题、方案、文件、工具、命令、测试、执行步骤、检查顺序或协作偏好。
字数要求：按实际信息量写，遵守本次摘要预算。三句话能说清的事不要写成一段。

## 规则
1. 有已有摘要时：新旧内容合并，同一件事以新信息为准，不要重复
2. 时间标注从消息时间戳提取（YYYY-MM-DD HH:MM 格式）
3. 只记录客观事实，不记录 MOOD 或助手内心想法
4. 用户提供的文件/附件：只记录文件名和用途，忽略文件的具体内容
5. 助手的长篇输出（文章、代码、分析等）：只记录产出了什么，不摘录内容
6. 宁短勿长：摘要长度应与对话的实际信息密度成正比，闲聊几句只需一两行`
      : `You are ${agentName}. You are reviewing a conversation you just experienced.

Below are the identity, settings, and memories you already had at the start of this session. They are background, not new facts. Review the new conversation from your own perspective and decide what deserves long-term memory.

## Your Identity And Personality
${identityAndPersonality}

## Owner / User Settings
${userProfile}

## Your Existing Long-Term Memory
This is the memory you already had before this conversation began. Do not rewrite it merely because it appears here; record only what this conversation updates, contradicts, or reinforces.

${existingMemory}

## Roster
The roster tells you which other agents are in the same system. Use it only to understand agent names and collaboration context; do not treat the roster itself as new memory.

${roster}

## Core Principle
Memory's core job is to maintain your understanding of ${userName}: who they are, your relationship with them, their long-running projects, and shared context. Keep the summary user-centric: prioritize who the user is, what they like, what they care about, and the broad themes they are currently focused on. For your replies, only record what was done (e.g. "generated an article about X", "wrote code implementing Y"), not the actual content or transient inner thoughts.

${formatRequirements}

## Content Requirements

**${factTitle} section**
Only record user-profile information: identity attributes, personality traits, aesthetics and interests, likes and dislikes, long-term relationships, life or creative orientation, and broad current themes the user is focused on. Write \`- None\` if none.

Do NOT extract:
- Work-style preferences: how the user wants the assistant to review, plan, research, implement, test, report, commit, or push
- Collaboration-process preferences: steps, checkpoints, validation order, context-management rules
- Tool and platform preferences from a task: tools, commands, files, models, directories
- Engineering discipline and project rules: these belong in explicit project instructions, not profile memory
- One-task formats, standards, or temporary judgments

ONLY extract:
- What kind of person the user is
- What objects, styles, content, and experiences the user likes or dislikes
- Long-term themes, relationships, identity, aesthetics, and values the user cares about
- Which domain/project/theme the user is currently focused on, keeping only the broad theme and no details

Test:
- If the information answers "who is the user, what do they like, what do they care about", extract it.
- If the information answers "how should one work with the user", do not extract it.
- If the information answers "which domain/project/theme is the user focused on recently", keep only the broad theme and no details inside that theme.
- When in doubt, skip. Better miss than mis-record.

Word limit: follow the per-run summary budget. Keep it short if there's little info.

**${timelineTitle} section**
Record what happened in this session in chronological order with YYYY-MM-DD HH:MM timestamps, capturing key points. Work-related content may only be kept at the broad-theme level.
Work can be written as "the user discussed memory systems" or "the user worked on Project Luc"; do not record subproblems, proposals, files, tools, commands, tests, execution steps, validation order, or collaboration preferences.
Word limit: follow the per-run summary budget. If three sentences suffice, don't write a paragraph.

## Rules
1. When existing summary is present: merge old and new, use newer info for the same topic, no duplicates
2. Extract time annotations from message timestamps (YYYY-MM-DD HH:MM format)
3. Only record objective facts, not MOOD or assistant's inner thoughts
4. User-provided files/attachments: only record filename and purpose, ignore file contents
5. Assistant's long outputs (articles, code, analysis): only record what was produced, don't excerpt content
6. Prefer brevity: summary length should be proportional to actual information density`;

    const prevLabel = isZh ? "## 已有摘要" : "## Existing Summary";
    const newLabel = isZh ? "## 新增对话" : "## New Conversation";
    const budgetLabel = isZh ? "## 本次摘要预算" : "## This Run's Summary Budget";
    const budgetText = isZh
      ? `${factTitle}最多${factsBudget}字。${timelineTitle}最多${eventsBudget}字。`
      : `${factTitle} max ${factsWordBudget} words. ${timelineTitle} max ${eventsWordBudget} words.`;
    const userContent = [
      hasPrev ? `${prevLabel}\n\n${prevSummary}` : "",
      `${newLabel}\n\n${convText}`,
      `${budgetLabel}\n\n${budgetText}`,
    ].filter(Boolean).join("\n\n");
    const layout = buildUtilityPromptLayout({
      cacheGroup: "memory.rolling_summary",
      templateVersion: "rolling-summary.v1",
      systemPrompt,
      userContent,
    });
    const usageContext = attachPromptLayoutMetadata({
      source: {
        subsystem: "memory",
        operation: "rolling_summary",
        surface: "system",
        trigger: opts.usageTrigger || "threshold",
      },
      attribution: {
        kind: "memory",
        agentId: resolvedModel.usageAgentId || null,
      },
    }, layout.usageMetadata);

    const maxTokens = withMemoryReasoningBuffer(visibleMaxTokens, resolvedModel);

    return callText({
      ...callTextConfigFromResolvedModel(resolvedModel),
      systemPrompt: layout.systemPrompt,
      messages: layout.messages,
      temperature: 0.3,
      maxTokens: maxTokens,
      timeoutMs: 60_000,
      signal: undefined,
      returnUsage: opts.returnUsage === true,
      usageLedger: resolvedModel.usageLedger,
      usageContext,
    });
  }

}

function normalizeSince(value) {
  if (!value || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function latestSince(...values) {
  let latest = null;
  for (const value of values) {
    const normalized = normalizeSince(value);
    if (!normalized) continue;
    if (!latest || Date.parse(normalized) > Date.parse(latest)) latest = normalized;
  }
  return latest;
}

function isAfter(value, since) {
  if (!value) return false;
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return false;
  return ts > Date.parse(since);
}

function areMessagesAfter(messages, since) {
  if (!since) return true;
  return messages.every((message) => isAfter(message.timestamp, since));
}

function normalizeBranchProjection(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.lineage)) return null;
  if (typeof value.lineageHash !== "string" || !value.lineageHash) return null;
  return value;
}

function projectionCursor(projection) {
  return {
    coveredLeafId: projection.selectedLeafId ?? null,
    lineageHash: projection.lineageHash,
  };
}

function sameCursor(left, right) {
  if (!left || !right) return false;
  return (left.coveredLeafId ?? null) === (right.coveredLeafId ?? null)
    && left.lineageHash === right.lineageHash;
}

function projectionHashAtLeaf(projection, leafId) {
  if (leafId == null) return projection.rootLineageHash || null;
  return projection.prefixHashes?.[leafId] || null;
}

function isCursorAncestorOfProjection(cursor, projection) {
  if (!cursor || typeof cursor.lineageHash !== "string") return false;
  return projectionHashAtLeaf(projection, cursor.coveredLeafId ?? null) === cursor.lineageHash;
}

function projectionRemainsAncestor(original, latest) {
  return projectionHashAtLeaf(latest, original.selectedLeafId ?? null) === original.lineageHash;
}

function normalizeMemoryReflectionSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const pick = (key) => typeof value[key] === "string" ? value[key].trim() : "";
  return {
    agentName: pick("agentName"),
    userName: pick("userName"),
    identityAndPersonality: pick("identityAndPersonality"),
    userProfile: pick("userProfile"),
    existingMemory: pick("existingMemory"),
    roster: pick("roster"),
  };
}
