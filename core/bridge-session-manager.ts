/**
 * BridgeSessionManager — Bridge（外部平台）session 管理
 *
 * 负责 bridge session 索引读写、外部消息执行、消息注入。
 * 从 Engine 提取，Engine 通过 manager 访问 bridge 功能。
 */
import fs from "fs";
import path from "path";
import { createAgentSession, SessionManager } from "../lib/pi-sdk/index.ts";
import { createDefaultSettings } from "./session-defaults.ts";
import { compactSessionWithCachePreservation } from "./session-compactor.ts";
import {
  installDynamicCompactionReserve,
  installMidRunCompaction,
} from "./session-compaction-runtime.ts";
import { repairOrphanToolResultEntriesInFile } from "./session-health.ts";
import { debugLog, createModuleLogger } from "../lib/debug-log.ts";
import { t, getLocale } from "../lib/i18n.ts";
import { atomicWriteSync, safeReadJSON } from "../shared/safe-fs.ts";
import { findModel } from "../shared/model-ref.ts";
import { teardownSessionResources } from "./session-teardown.ts";
import {
  pruneSessionInlineMediaHistory,
  repairSessionInlineMediaEntriesInFile,
} from "./session-inline-media-prune.ts";
import { isAbortLikeError, prepareVisionInputForTextOnlyModel } from "./vision-prepare.ts";
import { prepareModelImageInputsForPrompt } from "./model-image-preprocess.ts";
import { withVisionContextInjectionExtension } from "./vision-context-injector.ts";
import { normalizeBridgePermissionMode, SESSION_PERMISSION_MODES } from "./session-permission-mode.ts";
import { uniqueToolNames } from "../shared/tool-categories.ts";
import { collectMediaItems } from "../lib/tools/media-details.ts";
import { formatSettingsUpdateText } from "../lib/tools/settings-update-result.ts";
import { materializeBridgeInboundFiles } from "../lib/session-files/bridge-inbound-files.ts";
import {
  modelSupportsDirectAudioInput,
  modelSupportsAudioInput,
  modelSupportsDirectVideoInput,
  modelSupportsVideoInput,
} from "../shared/model-capabilities.ts";
import {
  appendBridgePromptLine,
  bridgeContextIndexMeta,
  buildBridgeContext,
} from "../lib/bridge/bridge-context.ts";
import { createVisibleTextAccumulator } from "../lib/bridge/visible-text-accumulator.ts";
import {
  buildFreshCompactMetaPatch,
  buildFreshCompactSnapshot,
  getFreshCompactNoopReason,
  normalizeFreshCompactNoopReason,
  shouldRunFreshCompact,
} from "../lib/fresh-compact/policy.ts";
import {
  buildSessionPromptSnapshot,
  createPromptSnapshotResourceLoader,
  normalizeSessionPromptSnapshot,
} from "./session-prompt-snapshot.ts";
import {
  normalizeSessionThinkingLevel,
  resolveModelDefaultThinkingLevel,
} from "./session-thinking-level.ts";
import { sameToolNames } from "./tool-snapshot-repair.ts";
import { formatWorkspaceScopePrompt } from "../shared/workspace-scope.ts";
import { buildWorkspaceInstructionPrompt } from "./workspace-instruction-files.ts";
import { agentPersonaFilePaths } from "./persona-source.ts";

const log = createModuleLogger("bridge-session");
const BRIDGE_OWNER_DENIED_TOOL_NAMES = Object.freeze([
  "computer",
  "browser",
  "luc_card_guide",
  "show_card",
]);

function computeBridgeOwnerActiveToolNames(allToolNames) {
  const denied = new Set(BRIDGE_OWNER_DENIED_TOOL_NAMES);
  return uniqueToolNames(allToolNames).filter((name) => !denied.has(name));
}

function filterBridgeOwnerToolObjects(tools) {
  const denied = new Set(BRIDGE_OWNER_DENIED_TOOL_NAMES);
  return (tools || []).filter((tool) => tool?.name && !denied.has(tool.name));
}

function assertVideoInputSupported(model, videos) {
  if (!videos?.length) return;
  if (!modelSupportsVideoInput(model)) {
    throw new Error("current model does not support video input");
  }
  if (!modelSupportsDirectVideoInput(model)) {
    throw new Error("current provider does not support direct video input");
  }
}

function assertAudioInputSupported(model, audios) {
  if (!audios?.length) return;
  if (!modelSupportsAudioInput(model)) {
    throw new Error("current model does not support audio input");
  }
  if (!modelSupportsDirectAudioInput(model)) {
    throw new Error("current provider does not support direct audio input");
  }
}

function buildPromptMediaOptions(opts) {
  const media = [
    ...(opts?.images || []),
    ...(opts?.videos || []),
    ...(opts?.audios || []),
  ];
  if (!media.length) return undefined;
  return {
    images: media,
    ...(opts.imageAttachmentPaths?.length ? { imageAttachmentPaths: opts.imageAttachmentPaths } : {}),
    ...(opts.videoAttachmentPaths?.length ? { videoAttachmentPaths: opts.videoAttachmentPaths } : {}),
    ...(opts.audioAttachmentPaths?.length ? { audioAttachmentPaths: opts.audioAttachmentPaths } : {}),
  };
}

function getProviderMessageEndError(event) {
  if (event?.type !== "message_end" || event.message?.stopReason !== "error") return null;
  return event.message.errorMessage || event.message.error?.message || "Unknown error";
}

function valueText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function valueRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function formatCronDaily(schedule) {
  const raw = valueText(schedule);
  const match = raw.match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/);
  if (!match) return "";
  const minute = Number(match[1]);
  const hour = Number(match[2]);
  if (!Number.isInteger(minute) || !Number.isInteger(hour) || minute > 59 || hour > 23) return "";
  return `每天 ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function formatAutomationSchedule(jobData) {
  const type = valueText(jobData.type || jobData.scheduleType);
  const schedule = jobData.schedule;
  if (type === "cron") return formatCronDaily(schedule) || valueText(schedule);
  if (type === "every") {
    const ms = typeof schedule === "number" ? schedule : Number(schedule);
    if (Number.isFinite(ms) && ms > 0) {
      const minutes = Math.round(ms / 60_000);
      if (minutes > 0) return `每 ${minutes} 分钟`;
    }
  }
  if (type === "at") {
    const date = new Date(schedule);
    if (!Number.isNaN(date.getTime())) return date.toLocaleString("zh-CN", { hour12: false });
  }
  return valueText(schedule);
}

function formatBridgePlatform(context) {
  const platform = valueText(context?.platform);
  if (platform === "wechat") return "微信";
  if (platform === "feishu") return "飞书";
  if (platform === "telegram") return "Telegram";
  if (platform === "qq") return "QQ";
  return platform;
}

function resolveAutomationAgentLabel(jobData, deps) {
  const executor = valueRecord(jobData.executor);
  const agentId = valueText(jobData.actorAgentId) || valueText(executor.agentId);
  if (!agentId) return "";
  const agent = deps?.getAgentById?.(agentId);
  return valueText(agent?.agentName) || valueText(agent?.name) || agentId;
}

function formatAutomationSuggestionText(payload, deps: any = {}) {
  const suggestions = (Array.isArray(payload) ? payload : [payload])
    .filter((item) => item && typeof item === "object");
  if (!suggestions.length) return "";

  const blocks = suggestions.map((suggestion, index) => {
    const jobData = valueRecord(suggestion.jobData);
    const title = valueText(jobData.label) || valueText(suggestion.title) || "未命名自动任务";
    const schedule = formatAutomationSchedule(jobData);
    const agentLabel = resolveAutomationAgentLabel(jobData, deps);
    const prompt = valueText(jobData.prompt) || valueText(suggestion.description);
    const shortCode = valueText(suggestion.shortCode) || valueText(suggestion.suggestionShortCode);
    const platform = formatBridgePlatform(deps.bridgeContext);
    const lines = suggestions.length > 1 ? [`${index + 1}.`] : [];
    lines.push(`标题：${title}`);
    if (schedule) lines.push(`时间：${schedule}`);
    if (agentLabel) lines.push(`执行助手：${agentLabel}`);
    if (platform) lines.push(`平台：${platform}`);
    if (prompt) lines.push(`任务内容：${prompt}`);
    if (shortCode) lines.push(`建议ID：${shortCode}`);
    return lines.join("\n");
  });

  if (suggestions.length === 1) {
    const shortCode = valueText(suggestions[0].shortCode) || valueText(suggestions[0].suggestionShortCode);
    return [
      "我准备了一项自动任务建议：",
      blocks[0],
      "",
      "回复 /apply 即可创建这个任务。",
      ...(shortCode ? [`也可以回复 /apply ${shortCode} 精确创建这一项。`] : []),
    ].join("\n");
  }

  return [
    `我准备了 ${suggestions.length} 项自动任务建议：`,
    blocks.join("\n\n"),
    "",
    "回复 /apply 创建最新这一项。",
    "也可以回复 /apply <建议ID> 精确创建。",
  ].join("\n");
}

/**
 * Usage attribution for a compaction that fires between turns of a bridge run.
 * Mirrors the reply attribution so compaction cost lands on the same
 * conversation, with its own subsystem/trigger.
 */
function buildBridgeCompactionUsageContext({ sessionPath, agent, bridgeContext }) {
  const conversationType = bridgeContext?.chatType === "channel" ? "channel" : "dm";
  if (bridgeContext?.isBridgeSession) {
    return {
      source: {
        subsystem: "compaction",
        operation: "compact",
        surface: conversationType,
        trigger: "threshold",
      },
      attribution: {
        kind: "phone_conversation",
        agentId: agent?.id || bridgeContext?.agentId || null,
        conversationId: bridgeContext?.sessionKey || bridgeContext?.chatId || sessionPath || "unknown",
        conversationType,
        sessionPath,
      },
    };
  }
  return {
    source: {
      subsystem: "compaction",
      operation: "compact",
      surface: "bridge",
      trigger: "threshold",
    },
    attribution: {
      kind: "session",
      agentId: agent?.id || null,
      sessionPath,
    },
  };
}

function recordBridgeAssistantUsage({ ledger, event, sessionPath, agent, model, bridgeContext }) {
  if (!ledger || event?.type !== "message_end" || event.message?.role !== "assistant") return null;
  const conversationType = bridgeContext?.chatType === "channel" ? "channel" : "dm";
  const conversationId = bridgeContext?.sessionKey || bridgeContext?.chatId || sessionPath || "unknown";
  const usageContext = bridgeContext?.isBridgeSession
    ? {
        source: {
          subsystem: "phone",
          operation: "reply",
          surface: conversationType,
          trigger: "user",
        },
        attribution: {
          kind: "phone_conversation",
          agentId: agent?.id || bridgeContext?.agentId || null,
          conversationId,
          conversationType,
          sessionPath,
        },
      }
    : {
        source: {
          subsystem: "session",
          operation: "reply",
          surface: "bridge",
          trigger: "user",
        },
        attribution: {
          kind: "session",
          agentId: agent?.id || null,
          sessionPath,
        },
      };
  const modelMeta = {
    provider: model?.provider ?? null,
    modelId: model?.id ?? null,
    api: model?.api ?? null,
  };
  if (event.message?.usage) {
    return ledger.record({
      model: modelMeta,
      usage: event.message.usage,
      usageContext,
      costRates: model?.cost,
    });
  }
  const errorMessage = getProviderMessageEndError(event);
  if (errorMessage) {
    const request = ledger.start({
      model: modelMeta,
      usageContext,
      costRates: model?.cost,
    });
    return ledger.recordError(request.requestId, new Error(errorMessage));
  }
  return null;
}

/**
 * 构造 executeExternalMessage 的结构化结果（#1607）。
 * 正文 / 错误 / 截断三者正交：provider/transport 出错不再吞掉已生成的 partial text。
 */
function buildExternalMessageResult({ capturedText, toolMedia, error }) {
  const text = (capturedText || "").trim() || null;
  const normalizedError = error == null || error === "" ? null : String(error);
  return {
    text,
    toolMedia: Array.isArray(toolMedia) ? [...toolMedia] : [],
    error: normalizedError,
    // 有错误且已有可见正文 ⇒ 正文不可信为完整
    truncated: !!(normalizedError && text),
  };
}

function zeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function warnVisionContextInjection(entry) {
  if (typeof entry === "string") {
    log.warn(`${entry}`);
    return;
  }
  log.warn(`vision context injection diagnostic: ${JSON.stringify(entry)}`);
}

function readLastJsonlEntry(filePath) {
  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
  const lines = raw.trimEnd().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Bridge index entry（持久化到 bridge-sessions.json）。
 * 这个 typedef 只声明结构以便 IDE 和未来读者，运行时仍是 plain JSON object。
 *
 * @typedef {object} BridgeIndexEntry
 * @property {string} [file] - owner/xxx.jsonl 或 guests/xxx.jsonl（rotate 后会被移除保留 meta）
 * @property {string} [name]
 * @property {string} [avatarUrl]
 * @property {string} [userId]
 * @property {string} [chatId] - 平台投递地址；飞书等平台的 owner 身份 ID 不等于发送目标时必须保留
 * @property {string} [linkedSessionPath]
 *   - 预留字段：当该 bridge session 由某个桌面 session "推送"产生时，
 *     记录源桌面 session 的绝对路径。一期不写入（/push 命令在后续 phase 落地），
 *     现有读写路径对未知字段透明保留（readIndex → writeIndex roundtrip 不丢）。
 *     这是"桌面 session 推送到社交平台"长期能力的数据模型钩子。
 */

export class BridgeSessionManager {
  declare _activeSessionRoles: any;
  declare _activeSessions: any;
  declare _deps: any;
  declare _prePromptAbortControllers: any;
  declare _bridgeContextsBySessionIdentity: any;
  /**
   * @param {object} deps - 注入依赖（不持有 engine 引用）
   * @param {() => object} deps.getAgent - 返回当前 agent（需 sessionDir, yuanPrompt）
   * @param {(id: string) => object|null} deps.getAgentById - 按 ID 获取 agent
   * @param {() => Map<string, object>|object[]|undefined} [deps.getAgents] - 返回所有 agent（reconcile 用）
   * @param {() => import('./model-manager.ts').ModelManager} deps.getModelManager
   * @param {() => object} deps.getResourceLoader
   * @param {() => object} deps.getPreferences
   * @param {(cwd: string, customTools?, opts?) => {tools: any[], customTools: any[]}} deps.buildTools
   * @param {() => string} deps.getHomeCwd
   * @param {() => boolean} [deps.isVisionAuxiliaryEnabled]
   */
  constructor(deps) {
    this._deps = deps;
    this._activeSessions = new Map();
    this._activeSessionRoles = new Map();
    this._prePromptAbortControllers = new Map();
    this._bridgeContextsBySessionIdentity = new Map();
  }

  _bridgeContextIdentityKey(sessionPath) {
    if (!sessionPath) return null;
    try {
      const sessionId = this._deps.getSessionIdForPath?.(sessionPath);
      if (typeof sessionId === "string" && sessionId.trim()) {
        return `id:${sessionId.trim()}`;
      }
    } catch {
      // Path fallback below preserves legacy bridge context lookup behavior.
    }
    return null;
  }

  _ensureBridgeSessionRef(sessionPath, {
    agent,
    sessionKey,
    role = "owner",
    locatorReason = "bridge_session_open",
  }: any = {}) {
    if (typeof this._deps.ensureSessionRefForPath !== "function") {
      const error: any = new Error("Bridge session identity service is unavailable");
      error.code = "session_manifest_unavailable";
      throw error;
    }
    return this._deps.ensureSessionRefForPath(sessionPath, {
      ownerAgentId: agent?.id || null,
      domain: "bridge",
      kind: role === "guest" ? "bridge_guest" : "bridge_owner",
      lifecycle: "active",
      provenance: {
        createdBy: "bridge",
        bridgeSessionKey: sessionKey || null,
        bridgeRole: role,
      },
      locatorReason,
    });
  }

  _applySessionBranchHead(sessionPath, manager, reason) {
    if (typeof this._deps.applySessionBranchHead !== "function") return null;
    return this._deps.applySessionBranchHead(sessionPath, manager, {
      reason,
      domain: "bridge",
    });
  }

  _syncSessionBranchHead(sessionPath, manager, reason) {
    if (typeof this._deps.syncSessionBranchHead !== "function") return null;
    return this._deps.syncSessionBranchHead(sessionPath, manager, reason);
  }

  _assertBridgeSessionRefLocator(sessionRef, sessionPath, operation) {
    if (!sessionRef?.sessionId || !sessionRef?.sessionPath || !sessionPath) {
      throw new Error(`${operation}: SessionRef is incomplete`);
    }
    if (path.resolve(sessionRef.sessionPath) !== path.resolve(sessionPath)) {
      const error: any = new Error(`${operation}: runtime locator does not match SessionRef`);
      error.code = "session_identity_conflict";
      throw error;
    }
  }

  _bridgeContextLegacyPathKeys(sessionPath) {
    const keys = [];
    if (!sessionPath) return keys;
    const resolved = path.resolve(sessionPath);
    keys.push(`path:${resolved}`);
    keys.push(resolved);
    return keys;
  }

  _bridgeContextLookupKeys(sessionPath) {
    const identityKey = this._bridgeContextIdentityKey(sessionPath);
    return [
      ...(identityKey ? [identityKey] : []),
      ...this._bridgeContextLegacyPathKeys(sessionPath),
    ];
  }

  _bridgeContextWriteKeys(sessionPath) {
    const identityKey = this._bridgeContextIdentityKey(sessionPath);
    return identityKey ? [identityKey] : this._bridgeContextLegacyPathKeys(sessionPath);
  }

  /** 活跃 bridge sessions（供 bridge-manager abort 用） */
  get activeSessions() { return this._activeSessions; }

  _emitSessionEvent(event, sessionPath) {
    if (!sessionPath || typeof this._deps.emitEvent !== "function") return;
    try {
      this._deps.emitEvent(event, sessionPath);
    } catch (err) {
      log.warn(`emit ${event?.type || "event"} failed: ${err?.message || err}`);
    }
  }

  _repairInlineMediaHistory(sessionPath, label) {
    try {
      const result = repairSessionInlineMediaEntriesInFile(sessionPath);
      if (result.repaired) {
        log.warn(
          `${label}: ${path.basename(sessionPath)} 清理 ${result.stripped} 个 inline media `
          + `(image=${result.strippedImages}, video=${result.strippedVideos}, audio=${result.strippedAudios})`
        );
      }
    } catch (err) {
      log.warn(`inline media history repair failed for ${label} ${path.basename(sessionPath)}: ${err.message}`);
    }
  }

  /** 指定 bridge session 是否正在 streaming */
  isSessionStreaming(sessionKey, opts: any = {}) {
    if (!this._activeSessionRoleMatches(sessionKey, opts.role)) return false;
    return this._prePromptAbortControllers.has(sessionKey)
      || (this._activeSessions.get(sessionKey)?.isStreaming ?? false);
  }

  /** abort 指定 bridge session（如果正在 streaming） */
  async abortSession(sessionKey) {
    const pending = this._prePromptAbortControllers.get(sessionKey);
    if (pending) {
      pending.abort();
      this._prePromptAbortControllers.delete(sessionKey);
      return true;
    }
    const session = this._activeSessions.get(sessionKey);
    if (!session?.isStreaming) return false;
    this._activeSessions.delete(sessionKey);
    this._activeSessionRoles.delete(sessionKey);
    try {
      const abortPromise = session.abort?.();
      Promise.resolve(abortPromise).catch((err) =>
        log.warn(`abortSession[${sessionKey}]: abort failed: ${err.message}`),
      );
    } catch (err) {
      log.warn(`abortSession[${sessionKey}]: abort failed: ${err.message}`);
    }
    try {
      session.dispose?.();
    } catch (err) {
      log.warn(`abortSession[${sessionKey}]: session.dispose failed: ${err.message}`);
    }
    return true;
  }

  /** bridge 索引文件路径 */
  _indexPath(agent) {
    // The index lives inside one agent's session directory, so the caller has
    // to say whose index it means. Reaching for the focused agent here read and
    // wrote another agent's file whenever the caller had a different one.
    if (!agent?.sessionDir) throw new Error("bridge index: agent required");
    return path.join(agent.sessionDir, "bridge", "bridge-sessions.json");
  }

  _resolveAgent(opts: any = {}, operation = "operation") {
    // Bridge sessions belong to an agent: the transcript, the index entry and
    // the outbound identity are all that agent's. Callers carry that agent in
    // the message context or the bridge index entry they looked the session up
    // from, so a missing id means the caller lost track of it, not that the
    // focused agent is a reasonable substitute.
    if (!opts.agentId) throw new Error(`bridge ${operation}: agentId required`);
    const agent = this._deps.getAgentById?.(opts.agentId) || null;
    if (!agent) throw new Error(`bridge ${operation}: agent "${opts.agentId}" not found`);
    return agent;
  }

  async _ensureAgentRuntime(agent, operation) {
    if (!agent?.id || typeof this._deps.ensureAgentRuntime !== "function") return agent;
    const ensured = await this._deps.ensureAgentRuntime(agent.id, {
      priority: "background",
      reason: `bridge:${operation}`,
    });
    return ensured || this._deps.getAgentById?.(agent.id) || agent;
  }

  _listAgentsForReconcile() {
    const all = this._deps.getAgents?.();
    if (all instanceof Map) return [...all.values()].filter(Boolean);
    if (Array.isArray(all)) return all.filter(Boolean);
    // This is the set of agents to search, not a decision about who owns
    // anything: callers match a session path against each agent's index and
    // take the id from whichever index actually contains it. When the roster is
    // unavailable, searching just the focused agent narrows the search and can
    // only end in "not found" — it can never pin a session on the wrong agent.
    const focus = this._deps.getAgent?.();
    return focus ? [focus] : [];
  }

  _activeSessionRoleMatches(sessionKey, role) {
    if (!role) return true;
    const activeRole = this._activeSessionRoles.get(sessionKey);
    return !activeRole || activeRole === role;
  }

  /**
   * 启动时 sanity check：扫描 bridge-index，清理孤儿条目
   * （有 file 引用但 JSONL 文件已不存在的）
   */
  reconcile() {
    let totalCleaned = 0;

    for (const agent of this._listAgentsForReconcile()) {
      const index = this.readIndex(agent);
      const bridgeDir = path.join(agent.sessionDir, "bridge");
      let cleaned = 0;

      for (const [sessionKey, raw] of Object.entries(index)) {
        const entry: any = typeof raw === "string" ? { file: raw } : raw;
        if (!entry.file) continue;
        const fp = path.join(bridgeDir, entry.file);
        if (!fs.existsSync(fp)) {
          // 保留元数据（name/avatarUrl/userId），只删 file 引用
          delete entry.file;
          index[sessionKey] = entry;
          cleaned++;
        }
      }

      if (cleaned > 0) {
        this.writeIndex(index, agent);
        totalCleaned += cleaned;
        debugLog()?.log("bridge", `reconcile: cleaned ${cleaned} orphan session refs for ${agent.id || "unknown"}`);
      }
    }

    if (totalCleaned > 0) {
      log.log(`reconcile: 清理 ${totalCleaned} 个孤儿 session 引用`);
    }
  }

  /** 读取 bridge session 索引 */
  readIndex(agent) {
    return safeReadJSON(this._indexPath(agent), {});
  }

  /** 写入 bridge session 索引 */
  writeIndex(index, agent) {
    const dir = path.dirname(this._indexPath(agent));
    fs.mkdirSync(dir, { recursive: true });
    atomicWriteSync(this._indexPath(agent), JSON.stringify(index, null, 2) + "\n");
  }

  /**
   * sessionKey → 当前会话的 sessionId。索引无条目、条目没有文件引用、
   * 或身份服务解析不到时返回 null。只读：不创建会话、不改索引。
   */
  resolveSessionIdForSessionKey(sessionKey, agent) {
    if (!sessionKey || !agent) return null;
    const index = this.readIndex(agent);
    const raw = index?.[sessionKey];
    if (!raw) return null;
    const file = typeof raw === "string" ? raw : raw.file;
    if (!file) return null;
    const sessionPath = path.join(agent.sessionDir, "bridge", file);
    return this._deps.getSessionIdForPath?.(sessionPath) ?? null;
  }

  /** sessionKey → 当前 jsonl 绝对路径（索引无条目返回 null；只读，不创建）。 */
  resolveSessionPathForSessionKey(sessionKey, agent) {
    if (!sessionKey || !agent) return null;
    const index = this.readIndex(agent);
    const entry = index?.[sessionKey];
    if (!entry) return null;
    const file = typeof entry === "string" ? entry : entry.file;
    if (!file) return null;
    return path.join(agent.sessionDir, "bridge", file);
  }

  /**
   * 确保 sessionKey 对应的会话实体存在并返回其 sessionId（不存在则创建）。
   * 不建 agent session、不跑一轮：空聊天里第一条消息就是循环启动命令时用。
   */
  async ensureSessionForSessionKey(sessionKey, agent) {
    if (!sessionKey || !agent) return null;
    const opened = this._openOrCreateOwnerSession(sessionKey, agent, {
      createIfMissing: true,
      locatorReasonPrefix: "loop_ensure_session",
      label: "ensureSessionForSessionKey",
    });
    if (!opened) return null;
    const { index, raw, bridgeDir, sessionPath, sessionRef } = opened;
    // 只写 file 引用：确保会话存在不带任何聊天元数据，已有条目的元数据原样保留。
    const { changed } = this._syncIndexEntry(index, sessionKey, raw, { bridgeDir, sessionPath, meta: null });
    if (changed) this.writeIndex(index, agent);
    return sessionRef?.sessionId || null;
  }

  /**
   * owner bridge 会话实体的"打开或创建"序列：索引查、open/create、身份 ref、branch head。
   * 助手消息补记与循环会话确保共用同一条路径；两者都不建 agent session、不跑 prompt。
   * 返回 null 表示会话不存在且调用方不允许创建（或新会话没拿到 locator）。
   */
  _openOrCreateOwnerSession(sessionKey, agent, { createIfMissing = false, locatorReasonPrefix, label }: any = {}) {
    const index = this.readIndex(agent);
    const raw = index[sessionKey];
    const existingFile = typeof raw === "string" ? raw : raw?.file || null;
    const bridgeDir = path.join(agent.sessionDir, "bridge");
    const sessionDir = path.join(bridgeDir, "owner");
    fs.mkdirSync(sessionDir, { recursive: true });

    let mgr = null;
    let sessionPath = null;
    if (existingFile) {
      sessionPath = path.join(bridgeDir, existingFile);
      if (fs.existsSync(sessionPath)) {
        mgr = SessionManager.open(sessionPath, path.dirname(sessionPath));
      } else if (!createIfMissing) {
        log.warn(`${label}: session 文件不存在: ${sessionPath}`);
        return null;
      }
    } else if (!createIfMissing) {
      log.warn(`${label}: sessionKey "${sessionKey}" 不存在`);
      return null;
    }

    const restoredExistingSession = !!mgr;
    if (!mgr) {
      const homeCwd = this._deps.getHomeCwd(agent.id) || process.cwd();
      mgr = SessionManager.create(homeCwd, sessionDir);
      sessionPath = mgr.getSessionFile?.() || null;
      if (!sessionPath) {
        log.warn(`${label}: new session path unavailable for "${sessionKey}"`);
        return null;
      }
    }

    const sessionRef = this._ensureBridgeSessionRef(sessionPath, {
      agent,
      sessionKey,
      role: "owner",
      locatorReason: restoredExistingSession
        ? `${locatorReasonPrefix}_restore`
        : `${locatorReasonPrefix}_create`,
    });
    if (restoredExistingSession) {
      this._applySessionBranchHead(sessionRef.sessionPath, mgr, `${locatorReasonPrefix}_restore`);
    } else {
      this._syncSessionBranchHead(sessionRef.sessionPath, mgr, `${locatorReasonPrefix}_create`);
    }

    return { index, raw, bridgeDir, mgr, sessionPath, sessionRef, restoredExistingSession };
  }

  _normalizeIndexEntry(raw) {
    if (!raw) return {};
    return typeof raw === "string" ? { file: raw } : { ...raw };
  }

  _serializeIndexEntry(previousRaw, entry) {
    if (typeof previousRaw === "string" && Object.keys(entry).length === 1 && typeof entry.file === "string") {
      return entry.file;
    }
    return entry;
  }

  _inferIndexEntryRole(entry, file) {
    if (entry.role === "owner" || entry.role === "guest") return entry.role;
    const root = typeof file === "string" ? file.split(/[\\/]/)[0] : "";
    if (root === "owner") return "owner";
    if (root === "guests") return "guest";
    return null;
  }

  _relativeBridgeFile(bridgeDir, sessionPath) {
    const relative = path.relative(bridgeDir, sessionPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`bridge session path escapes bridge dir: ${sessionPath}`);
    }
    return relative.split(path.sep).join("/");
  }

  _syncIndexEntry(index, sessionKey, previousRaw, { bridgeDir, sessionPath, meta, resetRoleBoundState = false }) {
    const entry = this._normalizeIndexEntry(previousRaw);
    if (resetRoleBoundState) {
      delete entry.promptSnapshot;
      delete entry.toolNames;
      delete entry.freshCompact;
    }
    entry.file = this._relativeBridgeFile(bridgeDir, sessionPath);
    if (meta) Object.assign(entry, meta);
    const nextValue = this._serializeIndexEntry(previousRaw, entry);
    if (JSON.stringify(previousRaw ?? null) === JSON.stringify(nextValue)) return { changed: false, file: entry.file };
    index[sessionKey] = nextValue;
    return { changed: true, file: entry.file };
  }

  _buildBridgeContext(sessionKey, meta: any = {}, opts: any = {}, agent = null) {
    return buildBridgeContext({
      ...(meta || {}),
      sessionKey,
      role: opts.guest === true ? "guest" : "owner",
      agentId: agent?.id || opts.agentId || null,
    }, getLocale());
  }

  _bridgeContextMeta(context, meta: any = {}) {
    return bridgeContextIndexMeta(context, meta || {});
  }

  _normalizeToolNames(value) {
    return uniqueToolNames(Array.isArray(value) ? value : []);
  }

  _buildPromptSnapshot(agent, systemPrompt, {
    appendSystemPrompt = null,
    skillsResult = null,
    agentsFilesResult = null,
  } = {}) {
    const baseResourceLoader = this._deps.getResourceLoader?.() || {};
    const skillsManager = this._deps.getSkills?.();
    return buildSessionPromptSnapshot({
      systemPrompt,
      appendSystemPrompt: appendSystemPrompt ?? baseResourceLoader.getAppendSystemPrompt?.() ?? [],
      skillsResult: skillsResult ?? (
        skillsManager?.getSkillsForAgent
          ? skillsManager.getSkillsForAgent(agent)
          : baseResourceLoader.getSkills?.()
      ),
      agentsFilesResult: agentsFilesResult ?? baseResourceLoader.getAgentsFiles?.(),
    });
  }

  _buildOwnerPromptSnapshot(agent, homeCwd, bridgeContext) {
    const ownerPromptBase = agent.buildSystemPrompt({
      forceMemoryEnabled: agent.memoryMasterEnabled,
      ...(typeof agent.experienceEnabled === "boolean"
        ? { forceExperienceEnabled: agent.experienceEnabled === true }
        : {}),
    });
    const systemPrompt = appendBridgePromptLine(ownerPromptBase, bridgeContext, getLocale());
    const locale = agent.config?.locale || getLocale();
    const baseAppend = this._deps.getResourceLoader?.()?.getAppendSystemPrompt?.() || [];
    const workspacePrompt = formatWorkspaceScopePrompt({
      primaryCwd: homeCwd,
      workspaceFolders: [],
      locale,
    });
    const workspaceInstructions = buildWorkspaceInstructionPrompt({
      cwd: homeCwd,
      workspaceContext: agent.config?.workspace_context,
      locale,
      excludeFiles: agentPersonaFilePaths(agent.agentDir),
    });
    return this._buildPromptSnapshot(agent, systemPrompt, {
      appendSystemPrompt: [
        ...(Array.isArray(baseAppend) ? baseAppend : []),
        ...(workspacePrompt ? [workspacePrompt] : []),
        ...(workspaceInstructions ? [workspaceInstructions] : []),
      ],
    });
  }

  _buildGuestPromptSnapshot(agent, bridgeContext, opts: any = {}) {
    const bridgePromptLine = appendBridgePromptLine("", bridgeContext, getLocale()).trim();
    const parts = [agent.yuanPrompt, agent.publicAgentsMd, opts.contextTag, bridgePromptLine].filter(Boolean);
    return this._buildPromptSnapshot(agent, parts.join("\n\n"), {
      appendSystemPrompt: [],
      skillsResult: { skills: [], diagnostics: [] },
      agentsFilesResult: { agentsFiles: [] },
    });
  }

  _writeIndexEntryPatch(agent, sessionKey, patch) {
    const index = this.readIndex(agent);
    const raw = index[sessionKey];
    const entry = this._normalizeIndexEntry(raw);
    if (!entry.file) return false;
    Object.assign(entry, patch);
    index[sessionKey] = this._serializeIndexEntry(raw, entry);
    this.writeIndex(index, agent);
    return true;
  }

  _resolveBridgeSessionEntry(agent, sessionKey, operation) {
    const bridgeDir = path.join(agent.sessionDir, "bridge");
    const index = this.readIndex(agent);
    const raw = index[sessionKey];
    const entry = this._normalizeIndexEntry(raw);
    const existingFile = entry.file || null;
    if (!existingFile) {
      throw new Error(`bridge ${operation}: session "${sessionKey}" not found or has no history`);
    }
    const sessionFilePath = path.join(bridgeDir, existingFile);
    if (!fs.existsSync(sessionFilePath)) {
      throw new Error(`bridge ${operation}: session file missing on disk: ${sessionFilePath}`);
    }
    return { bridgeDir, index, raw, entry, sessionFilePath };
  }

  _buildFreshCompactSatisfactionPatch(agent, {
    now = new Date(),
    reason = "daily", usage = {} as any,
    bridgeContext = null,
  } = {}) {
    const homeCwd = this._deps.getHomeCwd(agent.id) || process.cwd();
    const freshContext = this._buildOwnerFreshCompactContext(agent, homeCwd, { bridgeContext });
    const patch = buildFreshCompactMetaPatch({
      snapshot: freshContext.snapshot,
      reason,
      now,
      usage,
    });
    return {
      patch,
      promptSnapshot: freshContext.promptSnapshot,
    };
  }

  isFreshCompactAlreadySatisfied(sessionKey, opts: any = {}) {
    const agent = this._resolveAgent(opts, "fresh compact inspect");
    const sessionPath = opts.sessionPath || this._resolveBridgeSessionEntry(agent, sessionKey, "fresh compact inspect").sessionFilePath;
    const lastEntry = readLastJsonlEntry(sessionPath);
    if (lastEntry?.type === "compaction") {
      return { satisfied: true, reason: "already_compacted" };
    }
    return { satisfied: false, reason: null };
  }

  async markFreshCompactSatisfied(sessionKey, opts: any = {}) {
    const agent = this._resolveAgent(opts, "fresh compact mark");
    const { entry, sessionFilePath } = this._resolveBridgeSessionEntry(agent, sessionKey, "fresh compact mark");
    const bridgeContext = this.getBridgeContextForSessionPath(sessionFilePath, { agentId: agent.id })
      || this._buildBridgeContext(sessionKey, entry, { guest: false }, agent);
    const noopReason = normalizeFreshCompactNoopReason(opts.noopReason);
    const before = typeof opts.tokensBefore === "number" ? opts.tokensBefore : null;
    const after = typeof opts.tokensAfter === "number"
      ? opts.tokensAfter
      : (before ?? null);
    const contextWindow = typeof opts.contextWindow === "number" ? opts.contextWindow : null;
    const usage = {
      tokensBefore: before,
      tokensAfter: after,
      contextWindow,
    };
    const { patch, promptSnapshot } = this._buildFreshCompactSatisfactionPatch(agent, {
      now: opts.now || new Date(),
      reason: opts.reason || "daily",
      usage,
      bridgeContext,
    });
    this._writeIndexEntryPatch(agent, sessionKey, { freshCompact: patch, promptSnapshot });
    return {
      tokensBefore: before,
      tokensAfter: after,
      contextWindow,
      fresh: true,
      reason: opts.reason || "daily",
      noop: !!noopReason,
      noopReason,
    };
  }

  _rememberBridgeContext(sessionPath, context) {
    if (!sessionPath || context?.isBridgeSession !== true) return;
    const raw = { ...context };
    delete raw.platformLabel;
    delete raw.notificationHint;
    // 派生字段：重建时由 buildBridgeContext 按平台声明表附加，不缓存代码版本化的能力对象
    delete raw.interactionCapabilities;
    for (const key of this._bridgeContextWriteKeys(sessionPath)) {
      this._bridgeContextsBySessionIdentity.set(key, raw);
    }
  }

  getBridgeContextForSessionPath(sessionPath, opts: any = {}) {
    if (!sessionPath) return null;
    const resolved = path.resolve(sessionPath);
    for (const key of this._bridgeContextLookupKeys(sessionPath)) {
      const cached = this._bridgeContextsBySessionIdentity.get(key);
      if (cached) return buildBridgeContext(cached, getLocale());
    }

    const agents = opts.agentId
      ? [this._resolveAgent(opts, "getBridgeContextForSessionPath")]
      : this._listAgentsForReconcile();
    for (const agent of agents) {
      const index = this.readIndex(agent);
      const bridgeDir = path.join(agent.sessionDir, "bridge");
      for (const [sessionKey, raw] of Object.entries(index)) {
        const entry = this._normalizeIndexEntry(raw);
        if (!entry.file) continue;
        const entryPath = path.resolve(bridgeDir, entry.file);
        if (entryPath !== resolved) continue;
        const fileRoot = String(entry.file).split(/[\\/]/)[0];
        return buildBridgeContext({
          ...entry,
          role: entry.role || (fileRoot === "guests" ? "guest" : "owner"),
          sessionKey,
          agentId: agent.id,
        }, getLocale());
      }
    }
    return null;
  }

  recordCustomEntryForSessionPath(sessionPath, customType, data, opts: any = {}) {
    if (!sessionPath) throw new Error("recordCustomEntryForSessionPath: sessionPath is required");
    if (!customType) throw new Error("recordCustomEntryForSessionPath: customType is required");
    const context = this.getBridgeContextForSessionPath(sessionPath, opts);
    if (context?.isBridgeSession !== true) return null;
    const agent = this._resolveAgent({ agentId: context.agentId || opts.agentId }, "recordCustomEntryForSessionPath");
    const sessionRef = this._ensureBridgeSessionRef(sessionPath, {
      agent,
      sessionKey: context.sessionKey,
      role: context.role,
      locatorReason: "bridge_custom_entry",
    });

    const resolved = path.resolve(sessionPath);
    for (const session of this._activeSessions.values()) {
      const activePath = session?.sessionManager?.getSessionFile?.();
      if (!activePath || path.resolve(activePath) !== resolved) continue;
      if (typeof session.sessionManager?.appendCustomEntry !== "function") {
        throw new Error("recordCustomEntryForSessionPath: active bridge session does not support custom entries");
      }
      session.sessionManager.appendCustomEntry(customType, data);
      this._syncSessionBranchHead(activePath, session.sessionManager, "bridge_custom_entry_live");
      return { ok: true, mode: "bridge-live" };
    }

    if (!fs.existsSync(resolved)) {
      throw new Error(`recordCustomEntryForSessionPath: session file not found: ${sessionPath}`);
    }
    const manager = SessionManager.open(resolved, path.dirname(resolved));
    this._applySessionBranchHead(sessionRef.sessionPath, manager, "bridge_custom_entry_file_open");
    manager.appendCustomEntry(customType, data);
    this._syncSessionBranchHead(sessionRef.sessionPath, manager, "bridge_custom_entry_file_append");
    return { ok: true, mode: "bridge-file" };
  }

  _buildOwnerFreshCompactContext(agent, homeCwd, opts: any = {}) {
    const prefs = this._deps.getPreferences();
    const mm = this._deps.getModelManager();
    const chatRef = agent.config?.models?.chat;
    const ref = (typeof chatRef === "object" && chatRef?.id && chatRef?.provider) ? chatRef : null;
    const ownerModel = ref ? findModel(mm.availableModels, ref.id, ref.provider) : null;
    const bridgeContext = opts.bridgeContext || null;
    const promptSnapshot = this._buildOwnerPromptSnapshot(agent, homeCwd, bridgeContext);
    const state = {
      bridgePermissionMode: normalizeBridgePermissionMode(prefs?.bridge || {}),
      bridgeReadOnly: normalizeBridgePermissionMode(prefs?.bridge || {}) === SESSION_PERMISSION_MODES.READ_ONLY,
      experienceEnabled: agent.experienceEnabled === true,
      memoryMasterEnabled: agent.memoryMasterEnabled !== false,
      model: chatRef || null,
      thinkingLevel: resolveModelDefaultThinkingLevel(ownerModel, normalizeSessionThinkingLevel(prefs?.thinking_level)),
    };
    return {
      promptSnapshot,
      systemPrompt: promptSnapshot.systemPrompt,
      snapshot: buildFreshCompactSnapshot({ systemPrompt: promptSnapshot.systemPrompt, state }),
    };
  }

  listDailyFreshCompactTargets(agent, { now = new Date() } = {}) {
    const index = this.readIndex(agent);
    const bridgeDir = path.join(agent.sessionDir, "bridge");
    const targets = [];
    for (const [sessionKey, raw] of Object.entries(index)) {
      const entry = this._normalizeIndexEntry(raw);
      if (!entry.file) continue;
      const root = String(entry.file).split(/[\\/]/)[0];
      if (root !== "owner") continue;
      const sessionPath = path.join(bridgeDir, entry.file);
      if (!fs.existsSync(sessionPath)) continue;
      if (this.isSessionStreaming(sessionKey)) continue;
      const decision = shouldRunFreshCompact({ meta: entry, now });
      if (decision.run) {
        targets.push({ sessionKey, sessionPath, reason: decision.reason || "daily" });
      }
    }
    return targets;
  }

  /**
   * 执行外部平台消息：找到或创建持久 session，prompt 并捕获回复文本。
   *
   * 结果为结构化对象，正文 / 错误 / 截断三者正交（#1607）：
   *   - text: 可见正文（trim 后，空则 null）。provider/transport 出错时仍保留已生成的 partial text
   *   - toolMedia: 工具 details.media 合约产出的媒体
   *   - error: provider/transport 层错误信息（诊断用，发送侧不得将其作为聊天正文发出）
   *   - truncated: 正文是否因错误而不完整
   * 返回 null 仅出现在 prompt 开始前被中止（如 vision prepare 抛 AbortError）；
 * 流中中止（stopReason "aborted"）会正常 resolve 并返回已生成的 partial，error 为 null。
   *
   * @param {string} prompt - 格式化后的用户消息
   * @param {string} sessionKey - 会话标识（如 tg_dm_12345）
   * @param {object} [meta] - 元数据（name, avatarUrl, userId）
   * @param {object} [opts] - { guest: boolean, contextTag?: string, onDelta? }
   * @returns {Promise<{text: string|null, toolMedia: any[], error: string|null, truncated: boolean}|null>}
   */
  async executeExternalMessage(prompt, sessionKey, meta, opts: any = {}) {
    // 捕获状态提升到 try 外：错误路径（含 transport throw）也必须拿得到已生成内容（#1607）
    const visibleText = createVisibleTextAccumulator();
    let providerErrorMessage = null;
    // 工具 details.media 收集器（被动提取 tool_execution_end 事件）
    const toolMediaUrls = [];
    try {
      let promptText = prompt;
      const isGuest = opts.guest === true;
      let agent = this._resolveAgent(opts, "executeExternalMessage");
      agent = await this._ensureAgentRuntime(agent, "executeExternalMessage");
      const bridgeContext = this._buildBridgeContext(sessionKey, meta, opts, agent);
      const mm = this._deps.getModelManager();
      const bridgeDir = path.join(agent.sessionDir, "bridge");
      const subDir = opts.guest ? "guests" : "owner";
      const sessionDir = path.join(bridgeDir, subDir);
      fs.mkdirSync(sessionDir, { recursive: true });

      // 查找已有 session（兼容旧格式字符串和新格式对象）
      const index = this.readIndex(agent);
      const raw = index[sessionKey];
      const entry = this._normalizeIndexEntry(raw);
      const existingFile = typeof raw === "string" ? raw : raw?.file || null;
      const previousRole = this._inferIndexEntryRole(entry, existingFile);
      const currentRole = bridgeContext.role || (isGuest ? "guest" : "owner");
      const roleChanged = !!previousRole && previousRole !== currentRole;
      let promptSnapshot = roleChanged ? null : normalizeSessionPromptSnapshot(entry.promptSnapshot);
      const existingPath = existingFile ? path.join(bridgeDir, existingFile) : null;

      let mgr;
      let reopenError = null;
      if (existingPath && !roleChanged) {
        // #1285 读时结构修复：在 open 之前清理已落盘 bridge session 里的孤儿 toolResult entry。
        // 失败不阻塞 restore（运行时 provider-compat 兜底仍会防 400）。
        try {
          const { repaired, removed } = repairOrphanToolResultEntriesInFile(existingPath);
          if (repaired) {
            log.warn(
              `bridge session restore: ${path.basename(existingPath)} 清理 ${removed} 条孤儿 toolResult `
              + `(父 tool_calls 属于 error/aborted assistant，会被 SDK 丢弃) — see #1285.`
            );
          }
        } catch (err) {
          log.warn(`orphan tool history repair failed for bridge ${path.basename(existingPath)}: ${err.message}`);
        }
        this._repairInlineMediaHistory(existingPath, "bridge session restore");
        try {
          mgr = SessionManager.open(existingPath, sessionDir);
        } catch (err) {
          reopenError = err;
          mgr = null;
          log.warn(`existing session open failed (${sessionKey}): ${err.message}; creating a new session and rebinding index`);
          debugLog()?.log("bridge-session", `open failed for ${sessionKey}: ${err.message}`);
        }
      }
      const homeCwd = this._deps.getHomeCwd(agent.id) || process.cwd();
      const restoredExistingSession = !!mgr;
      if (!mgr) {
        mgr = SessionManager.create(homeCwd, sessionDir);
      }

      let sessionOpts;
      const identityPath = mgr.getSessionFile?.() || null;
      if (!identityPath) throw new Error("bridge session locator unavailable before runtime assembly");
      const sessionRef = this._ensureBridgeSessionRef(identityPath, {
        agent,
        sessionKey,
        role: currentRole,
        locatorReason: restoredExistingSession ? "bridge_session_restore" : "bridge_session_create",
      });
      if (restoredExistingSession) {
        this._applySessionBranchHead(identityPath, mgr, "bridge_session_restore");
      } else {
        this._syncSessionBranchHead(identityPath, mgr, "bridge_session_create");
      }
      const sessionPathRef = { current: identityPath };
      const sessionRefRef = { current: sessionRef };
      const targetModelRef = { current: null };

      if (isGuest) {
        // guest 模式：yuan + AGENTS.public.md + contextTag，主模型，无工具
        promptSnapshot ||= this._buildGuestPromptSnapshot(agent, bridgeContext, opts);
        const guestResourceLoaderBase = createPromptSnapshotResourceLoader(
          this._deps.getResourceLoader?.(),
          promptSnapshot,
        );
        const guestResourceLoader = withVisionContextInjectionExtension(guestResourceLoaderBase, {
          path: "luc-vision-context-injection",
          sessionPathRef,
          targetModelRef,
          getVisionBridge: () => this._deps.getVisionBridge?.(),
          isVisionAuxiliaryEnabled: () => this._deps.isVisionAuxiliaryEnabled?.() === true,
          warn: warnVisionContextInjection,
          resolveSessionFile: ({ fileId, filePath, sessionPath }) => {
            const lookupSessionPath = sessionPath || sessionPathRef.current || null;
            if (fileId) return this._deps.getSessionFile?.(fileId, { sessionPath: lookupSessionPath });
            if (filePath) return this._deps.getSessionFileByPath?.(filePath, { sessionPath: lookupSessionPath });
            return null;
          },
        });

        // 使用 agent 配置的模型，而非 defaultModel。
        // migration #5 之后 models.chat 必为 {id, provider} 对象；缺 provider 视为未配置。
        const chatRef = agent.config?.models?.chat;
        const ref = (typeof chatRef === "object" && chatRef?.id && chatRef?.provider) ? chatRef : null;
        if (!ref) {
          throw new Error(t("error.bridgeAgentNoChatModel", { name: agent.agentName }));
        }
        const chatModel = findModel(mm.availableModels, ref.id, ref.provider);
        if (!chatModel) {
          throw new Error(t("error.bridgeAgentModelNotAvailable", { name: agent.agentName, model: `${ref.provider}/${ref.id}` }));
        }
        targetModelRef.current = chatModel;

        sessionOpts = {
          model: chatModel,
          thinkingLevel: "off",
          resourceLoader: guestResourceLoader,
          tools: [],
          customTools: [],
          settingsManager: this._createSettings(chatModel),
        };
      } else {
        // owner 模式：完整 agent。抽出 _buildOwnerSessionOpts 后，compactSession 也能复用同一构造逻辑
        promptSnapshot ||= this._buildOwnerPromptSnapshot(agent, homeCwd, bridgeContext);
        sessionOpts = this._buildOwnerSessionOpts(agent, mm, homeCwd, sessionPathRef, targetModelRef, {
          bridgeContext,
          promptSnapshot,
          sessionRefRef,
        });
      }
      const activeToolNames = this._normalizeToolNames(sessionOpts.activeToolNames);
      delete sessionOpts.activeToolNames;

      const { session } = await createAgentSession({
        cwd: homeCwd,
        sessionManager: mgr,
        authStorage: mm.authStorage,
        modelRegistry: mm.modelRegistry,
        ...sessionOpts,
      });

      installDynamicCompactionReserve(session);
      installMidRunCompaction(session, {
        usageLedger: this._deps.getUsageLedger?.() || null,
        buildUsageContext: (s: any) => buildBridgeCompactionUsageContext({
          sessionPath: s?.sessionManager?.getSessionFile?.() || null,
          agent,
          bridgeContext,
        }),
      });

      const activeSessionPath = session.sessionManager?.getSessionFile?.() || null;
      this._assertBridgeSessionRefLocator(sessionRefRef.current, activeSessionPath, "bridge executeExternalMessage");
      sessionPathRef.current = activeSessionPath;
      targetModelRef.current = session.model || sessionOpts.model || targetModelRef.current || null;
      if (activeToolNames.length) {
        session.setActiveToolsByName?.(activeToolNames);
      }
      this._rememberBridgeContext(activeSessionPath, bridgeContext);
      this._activeSessions.set(sessionKey, session);
      this._activeSessionRoles.set(sessionKey, currentRole);

      let displayAttachments = [];
      if (opts.inboundFiles?.length && !activeSessionPath) {
        throw new Error("bridge inbound files require a resolved sessionPath");
      }
      if (opts.inboundFiles?.length && activeSessionPath) {
        const materialized = await materializeBridgeInboundFiles({
          lucHome: this._deps.getLucHome?.(),
          sessionId: sessionRefRef.current.sessionId,
          sessionPath: activeSessionPath,
          files: opts.inboundFiles,
          registerSessionFile: this._deps.registerSessionFile,
        });
        if (materialized.imageAttachmentPaths.length) {
          promptText = addAttachedImageMarkers(promptText, materialized.imageAttachmentPaths);
          opts = {
            ...opts,
            imageAttachmentPaths: [
              ...(opts.imageAttachmentPaths || []),
              ...materialized.imageAttachmentPaths,
            ],
          };
        }
        displayAttachments = materialized.displayAttachments || [];
      }

      this._emitSessionEvent({ type: "session_status", isStreaming: true }, activeSessionPath);
      const displayMessage = {
        timestamp: Date.now(),
        ...(opts.displayMessage || {}),
        text: opts.displayMessage?.text ?? promptText,
        source: opts.displayMessage?.source || "bridge",
        bridgeSessionKey: sessionKey,
      };
      if (displayAttachments.length && !displayMessage.attachments?.length) {
        displayMessage.attachments = displayAttachments;
      }
      this._emitSessionEvent({
        type: "session_user_message",
        message: displayMessage,
      }, activeSessionPath);

      // 捕获文本输出（visibleText / providerErrorMessage 声明见方法顶部）
      const unsub = session.subscribe((event) => {
        recordBridgeAssistantUsage({
          ledger: this._deps.getUsageLedger?.(),
          event,
          sessionPath: activeSessionPath,
          agent,
          model: session.model,
          bridgeContext,
        });
        if (event.type === "message_update") {
          const sub = event.assistantMessageEvent;
          if (sub?.type === "text_delta") {
            const { emittedDelta, text } = visibleText.appendTextDelta(sub.delta || "");
            try { opts.onDelta?.(emittedDelta, text); } catch {}
          }
        } else if (event.type === "tool_execution_start") {
          visibleText.markHiddenToolBoundary();
        } else if (event.type === "tool_execution_end" && !event.isError) {
          toolMediaUrls.push(...collectMediaItems(event.result?.details?.media));
          let appendedDetail = false;
          const automationSuggestionText = formatAutomationSuggestionText(
            event.result?.details?.automationSuggestion || event.result?.details?.automationSuggestions,
            {
              getAgentById: this._deps.getAgentById,
              bridgeContext,
            },
          );
          if (automationSuggestionText) {
            visibleText.appendVisibleDetail(automationSuggestionText);
            appendedDetail = true;
          }
          const card = event.result?.details?.card;
          if (card?.description) {
            visibleText.appendVisibleDetail(card.description);
            appendedDetail = true;
          }
          const settingsUpdateText = formatSettingsUpdateText(event.result?.details?.settingsUpdate);
          if (settingsUpdateText) {
            visibleText.appendVisibleDetail(settingsUpdateText);
            appendedDetail = true;
          }
          if (!appendedDetail) visibleText.markHiddenToolBoundary();
        }
        const messageEndError = getProviderMessageEndError(event);
        if (messageEndError) providerErrorMessage = messageEndError;
        this._emitSessionEvent(event, activeSessionPath);
      });

      try {
        const abortController = new AbortController();
        this._prePromptAbortControllers.set(sessionKey, abortController);
        ({ text: promptText, opts } = await prepareVisionInputForTextOnlyModel({
          targetModel: session.model,
          text: promptText,
          opts,
          sessionPath: activeSessionPath,
          getVisionBridge: () => this._deps.getVisionBridge?.(),
          visionPolicyTarget: {
            isVisionAuxiliaryEnabled: this._deps.isVisionAuxiliaryEnabled,
          },
          warn: (msg) => log.warn(msg),
          signal: abortController.signal,
        }));
        ({ text: promptText, opts } = await prepareModelImageInputsForPrompt({
          text: promptText,
          opts,
          signal: abortController.signal,
        }));
        if (this._prePromptAbortControllers.get(sessionKey) === abortController) {
          this._prePromptAbortControllers.delete(sessionKey);
        }
        assertVideoInputSupported(session.model, opts?.videos);
        assertAudioInputSupported(session.model, opts?.audios);
        const promptOpts = buildPromptMediaOptions(opts);
        const nativeMediaTurn = this._deps.beginCurrentTurnNativeMedia?.(activeSessionPath, opts);
        try {
          await session.prompt(promptText, promptOpts);
        } finally {
          this._deps.endCurrentTurnNativeMedia?.(nativeMediaTurn);
        }
      } finally {
        this._prePromptAbortControllers.delete(sessionKey);
        try {
          pruneSessionInlineMediaHistory(session);
        } catch (err) {
          log.warn(`bridge inline media prune failed (${sessionKey}): ${err?.message || err}`);
        }
        if (activeSessionPath) {
          this._syncSessionBranchHead(activeSessionPath, session.sessionManager, "bridge_prompt_finally");
        }
        await teardownSessionResources({
          session,
          unsub,
          label: `bridge.executeExternalMessage[${sessionKey}]`,
          warn: (msg) => log.warn(msg),
        });
        this._activeSessions.delete(sessionKey);
        this._activeSessionRoles.delete(sessionKey);
        this._emitSessionEvent({ type: "session_status", isStreaming: false }, activeSessionPath);
      }

      // 更新索引 + 元数据
      const sessionPath = activeSessionPath || session.sessionManager?.getSessionFile?.();
      if (sessionPath) {
        const { changed, file } = this._syncIndexEntry(index, sessionKey, raw, {
          bridgeDir,
          sessionPath,
          resetRoleBoundState: roleChanged,
          meta: {
            ...this._bridgeContextMeta(bridgeContext, meta),
            promptSnapshot,
            ...(activeToolNames.length ? { toolNames: activeToolNames } : {}),
          },
        });
        if (changed) {
          if (existingFile && existingFile !== file) {
            debugLog()?.log("bridge-session", `rebound ${sessionKey}: ${existingFile} -> ${file}`);
            if (reopenError) {
              log.log(`${sessionKey} 已自愈：${existingFile} -> ${file}`);
            }
          }
          this.writeIndex(index, agent);
        }
      }
      if (!isGuest && sessionPath) {
        try {
          agent.memoryTicker?.notifyTurn?.(sessionPath);
        } catch (err) {
          log.warn(`bridge memory notifyTurn failed (${sessionKey}): ${err?.message || err}`);
        }
      }
      if (toolMediaUrls.length) {
        debugLog()?.log("bridge-session", `tool media → ${toolMediaUrls.length} url(s) via details.media`);
      }
      return buildExternalMessageResult({
        capturedText: visibleText.getText(),
        toolMedia: toolMediaUrls,
        error: providerErrorMessage,
      });
    } catch (err) {
      if (isAbortLikeError(err)) return null;
      log.error(`external message failed (${sessionKey}): ${err.message}`);
      return buildExternalMessageResult({
        capturedText: visibleText.getText(),
        toolMedia: toolMediaUrls,
        // message_end 携带的 provider 错误（若有）比 transport throw 更贴近根因，优先保留
        error: providerErrorMessage || err.message || String(err),
      });
    }
  }

  /**
   * 向正在 streaming 的 bridge session 注入 steer 消息
   * @param {string} sessionKey
   * @param {string} text
   * @returns {boolean} 是否成功注入
   */
  steerSession(sessionKey, text, opts: any = {}) {
    if (!this._activeSessionRoleMatches(sessionKey, opts.role)) return false;
    const session = this._activeSessions.get(sessionKey);
    if (!session?.isStreaming) return false;
    session.steer(text);
    return true;
  }

  /**
   * 往指定 bridge session 追加一条 assistant 消息（不触发 LLM）。
   * createIfMissing 仅用于真实外发成功后的主动通知记录。
   *
   * @param {string} sessionKey - bridge session 标识
   * @param {string} text - 要追加的 assistant 消息文本
   * @param {object} [opts] - { agentId?: string, createIfMissing?: boolean, meta?: object }
   * @returns {boolean}
   */
  recordAssistantMessage(sessionKey, text, opts: any = {}) {
    const agent = this._resolveAgent(opts, "recordAssistantMessage");
    try {
      const bridgeContext = this._buildBridgeContext(sessionKey, opts.meta, { ...opts, guest: false }, agent);
      const opened = this._openOrCreateOwnerSession(sessionKey, agent, {
        createIfMissing: !!opts.createIfMissing,
        locatorReasonPrefix: "bridge_assistant_record",
        label: "recordAssistantMessage",
      });
      if (!opened) return false;
      const { index, raw, bridgeDir, mgr, sessionPath, sessionRef } = opened;

      mgr.appendMessage(this._buildRecordedAssistantMessage(agent, text));
      this._syncSessionBranchHead(sessionRef.sessionPath, mgr, "bridge_assistant_record_append");

      if (sessionPath) {
        this._rememberBridgeContext(sessionPath, bridgeContext);
        const { changed } = this._syncIndexEntry(index, sessionKey, raw, {
          bridgeDir,
          sessionPath,
          meta: this._bridgeContextMeta(bridgeContext, opts.meta || null),
        });
        if (changed) this.writeIndex(index, agent);
      }

      debugLog()?.log("bridge-session", `recorded assistant message to ${sessionKey} (${text.length} chars)`);
      return true;
    } catch (err) {
      log.error(`recordAssistantMessage failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Back-compat wrapper used by slash/session ops.
   */
  injectMessage(sessionKey, text, opts: any = {}) {
    return this.recordAssistantMessage(sessionKey, text, { ...opts, createIfMissing: false });
  }

  _buildRecordedAssistantMessage(agent, text) {
    const mm = this._deps.getModelManager();
    const chatRef = agent.config?.models?.chat;
    const ref = (typeof chatRef === "object" && chatRef?.id && chatRef?.provider) ? chatRef : null;
    if (!ref) {
      throw new Error(t("error.bridgeAgentNoChatModel", { name: agent.agentName }));
    }
    const chatModel = findModel(mm.availableModels, ref.id, ref.provider);
    if (!chatModel) {
      throw new Error(t("error.bridgeAgentModelNotAvailable", { name: agent.agentName, model: `${ref.provider}/${ref.id}` }));
    }
    return {
      role: "assistant",
      content: [{ type: "text", text }],
      api: chatModel.api || "openai-completions",
      provider: chatModel.provider,
      model: chatModel.id,
      usage: zeroUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    };
  }

  /**
   * 构造 owner 模式 bridge session 的 createAgentSession opts。
   * 从 executeExternalMessage 的 owner 分支抽出，以便 compactSession 复用同一配置。
   *
   * 纯函数（相对于 this._deps）：不写 _activeSessions，不落盘索引。
   *
   * @param {object} agent
   * @param {import('./model-manager.ts').ModelManager} mm
   * @param {string} homeCwd
   * @returns {object} sessionOpts for createAgentSession
   */
  _buildOwnerSessionOpts(agent, mm, homeCwd, sessionPathRef = { current: null }, targetModelRef = { current: null }, opts: any = {}) {
    const prefs = this._deps.getPreferences();
    const bridgePermissionMode = normalizeBridgePermissionMode(prefs?.bridge || {});
    const agentToolsSnapshot = typeof agent.getToolsSnapshot === "function"
      ? agent.getToolsSnapshot({
        forceMemoryEnabled: agent.memoryMasterEnabled !== false,
        ...(typeof agent.experienceEnabled === "boolean"
          ? { forceExperienceEnabled: agent.experienceEnabled === true }
          : {}),
        surface: "bridge",
      })
      : agent.tools;
    const { tools: baseTools, customTools: baseCustomTools } = this._deps.buildTools(
      homeCwd, agentToolsSnapshot,
      {
        workspace: homeCwd,
        agentDir: agent.agentDir,
        runtimeSessionRef: opts.sessionRefRef?.current || null,
        requireSessionIdentity: true,
        getPermissionMode: () => bridgePermissionMode,
        allowHumanApproval: false,
        bridgeContext: opts.bridgeContext || null,
      },
    );

    // 使用 agent 配置的模型（必须是带 provider 的复合键对象）
    const ownerRef = agent.config?.models?.chat;
    const ref = (typeof ownerRef === "object" && ownerRef?.id && ownerRef?.provider) ? ownerRef : null;
    if (!ref) {
      throw new Error(t("error.bridgeAgentNoChatModel", { name: agent.agentName }));
    }
    const ownerModel = findModel(mm.availableModels, ref.id, ref.provider);
    if (!ownerModel) {
      throw new Error(t("error.bridgeAgentModelNotAvailable", { name: agent.agentName, model: `${ref.provider}/${ref.id}` }));
    }
    targetModelRef.current = ownerModel;

    // 快照 prompt，隔离于其他 session 的 prompt 变更（与 SessionCoordinator.createSession 一致）。
    // Bridge owner 是独立长期 session：普通消息复用它自己的持久 snapshot；
    // fresh compact 才刷新 snapshot。
    const promptSnapshot = normalizeSessionPromptSnapshot(opts.promptSnapshot)
      || this._buildOwnerPromptSnapshot(agent, homeCwd, opts.bridgeContext || null);
    const ownerResourceLoader = createPromptSnapshotResourceLoader(
      this._deps.getResourceLoader?.(),
      promptSnapshot,
    );
    const visionResourceLoader = withVisionContextInjectionExtension(ownerResourceLoader, {
      path: "luc-vision-context-injection",
      sessionPathRef,
      targetModelRef,
      getVisionBridge: () => this._deps.getVisionBridge?.(),
      isVisionAuxiliaryEnabled: () => this._deps.isVisionAuxiliaryEnabled?.() === true,
      warn: warnVisionContextInjection,
      resolveSessionFile: ({ fileId, filePath, sessionPath }) => {
        const lookupSessionPath = sessionPath || sessionPathRef.current || null;
        if (fileId) return this._deps.getSessionFile?.(fileId, { sessionPath: lookupSessionPath });
        if (filePath) return this._deps.getSessionFileByPath?.(filePath, { sessionPath: lookupSessionPath });
        return null;
      },
    });

    const ownerTools = filterBridgeOwnerToolObjects(baseTools);
    const ownerCustomTools = filterBridgeOwnerToolObjects(baseCustomTools);
    const allToolNames = uniqueToolNames([
      ...ownerTools.map((tool) => tool?.name),
      ...ownerCustomTools.map((tool) => tool?.name),
    ]);

    return {
      model: ownerModel,
      thinkingLevel: mm.resolveThinkingLevel(resolveModelDefaultThinkingLevel(
        ownerModel,
        normalizeSessionThinkingLevel(prefs?.thinking_level),
      )),
      resourceLoader: visionResourceLoader,
      tools: ownerTools,
      customTools: ownerCustomTools,
      settingsManager: this._createSettings(ownerModel),
      activeToolNames: computeBridgeOwnerActiveToolNames(allToolNames),
    };
  }

  /**
   * 对指定 bridge session 执行真正的上下文压缩。
   *
   * 流程：
   *   1. 从 index 定位 jsonl 文件
   *   2. 若当前正 streaming → 抛错（禁止并发压缩+生成）
   *   3. SessionManager.open + createAgentSession 组装临时 owner session
   *   4. 读取压缩前 token 占用 → Luc cache-preserving compaction → 读取压缩后
   *   5. 不把临时 session 写入 _activeSessions（它不承担 LLM 生成，isStreaming 语义无关）
   *
   * 返回值为结构化对象，上层 /compact handler 负责消息文案。
   *
   * @param {string} sessionKey
   * @param {{ agentId?: string }} opts
   * @returns {Promise<{ tokensBefore: number|null, tokensAfter: number|null, contextWindow: number|null }>}
   */
  async compactSession(sessionKey, opts: any = {}) {
    // 1. 定位 agent
    let agent = this._resolveAgent(opts, "compactSession");
    agent = await this._ensureAgentRuntime(agent, "compactSession");

    // 2. 并发保护：正在生成回复时禁止压缩（SDK 内部冲突）
    const active = this._activeSessions.get(sessionKey);
    if (active?.isStreaming) {
      throw new Error("bridge compact: session is streaming, try again after the reply completes");
    }

    // 3. 读索引 → 拿到 jsonl 绝对路径
    const bridgeDir = path.join(agent.sessionDir, "bridge");
    const index = this.readIndex(agent);
    const raw = index[sessionKey];
    const entry = this._normalizeIndexEntry(raw);
    const existingFile = entry.file || null;
    if (!existingFile) {
      throw new Error(`bridge compact: session "${sessionKey}" not found or has no history`);
    }
    const sessionFilePath = path.join(bridgeDir, existingFile);
    if (!fs.existsSync(sessionFilePath)) {
      throw new Error(`bridge compact: session file missing on disk: ${sessionFilePath}`);
    }

    // 4. 打开 SessionManager + 组装 owner 模式 createAgentSession opts
    const mm = this._deps.getModelManager();
    const homeCwd = this._deps.getHomeCwd(agent.id) || process.cwd();
    const sessionDir = path.dirname(sessionFilePath);
    // #1285 读时结构修复：在 open 之前清理已落盘 bridge session 里的孤儿 toolResult entry。
    // 失败不阻塞 compaction（运行时 provider-compat 兜底仍会防 400）。
    try {
      const { repaired, removed } = repairOrphanToolResultEntriesInFile(sessionFilePath);
      if (repaired) {
        log.warn(
          `bridge compact reopen: ${path.basename(sessionFilePath)} 清理 ${removed} 条孤儿 toolResult `
          + `(父 tool_calls 属于 error/aborted assistant，会被 SDK 丢弃) — see #1285.`
        );
      }
    } catch (err) {
      log.warn(`orphan tool history repair failed for bridge compact ${path.basename(sessionFilePath)}: ${err.message}`);
    }
    this._repairInlineMediaHistory(sessionFilePath, "bridge compact reopen");
    const mgr = SessionManager.open(sessionFilePath, sessionDir);
    const sessionRef = this._ensureBridgeSessionRef(sessionFilePath, {
      agent,
      sessionKey,
      role: "owner",
      locatorReason: "bridge_compact_restore",
    });
    this._applySessionBranchHead(sessionRef.sessionPath, mgr, "bridge_compact_restore");
    const bridgeContext = this.getBridgeContextForSessionPath(sessionFilePath, { agentId: agent.id })
      || this._buildBridgeContext(sessionKey, entry, { guest: false }, agent);
    const freshContext = opts.fresh === true
      ? this._buildOwnerFreshCompactContext(agent, homeCwd, { bridgeContext })
      : null;
    const restoredPromptSnapshot = normalizeSessionPromptSnapshot(entry.promptSnapshot);
    const promptSnapshot = freshContext?.promptSnapshot
      || restoredPromptSnapshot
      || this._buildOwnerPromptSnapshot(agent, homeCwd, bridgeContext);
    const sessionOpts = this._buildOwnerSessionOpts(agent, mm, homeCwd, { current: sessionFilePath }, { current: null }, {
      bridgeContext,
      promptSnapshot,
      sessionRefRef: { current: sessionRef },
    });
    const activeToolNames = this._normalizeToolNames(sessionOpts.activeToolNames);
    delete sessionOpts.activeToolNames;

    const { session } = await createAgentSession({
      cwd: homeCwd,
      sessionManager: mgr,
      authStorage: mm.authStorage,
      modelRegistry: mm.modelRegistry,
      ...sessionOpts,
    });

    installDynamicCompactionReserve(session);
    installMidRunCompaction(session, {
      usageLedger: this._deps.getUsageLedger?.() || null,
      buildUsageContext: (s: any) => buildBridgeCompactionUsageContext({
        sessionPath: s?.sessionManager?.getSessionFile?.() || null,
        agent,
        bridgeContext,
      }),
    });

    try {
      const activeSessionPath = session.sessionManager?.getSessionFile?.() || null;
      this._assertBridgeSessionRefLocator(sessionRef, activeSessionPath, "bridge compactSession");
      if (activeToolNames.length) {
        session.setActiveToolsByName?.(activeToolNames);
      }

      // 5. 读 usage → compact → 读 usage
      const before = session.getContextUsage?.() ?? null;
      if (session.isCompacting) {
        throw new Error("bridge compact: already compacting");
      }
      let after = null;
      try {
        try {
          await compactSessionWithCachePreservation(session, undefined);
        } finally {
          this._syncSessionBranchHead(sessionRef.sessionPath, session.sessionManager, "bridge_compact_finally");
        }
        after = session.getContextUsage?.() ?? null;
      } catch (err) {
        const noopReason = freshContext ? getFreshCompactNoopReason(err) : null;
        if (!noopReason) throw err;
        const tokensBefore = before?.tokens ?? null;
        return await this.markFreshCompactSatisfied(sessionKey, {
          agentId: agent.id,
          reason: opts.reason || "manual",
          now: opts.now || new Date(),
          noopReason,
          tokensBefore,
          tokensAfter: tokensBefore,
          contextWindow: before?.contextWindow ?? null,
        });
      }
      const result = {
        tokensBefore: before?.tokens ?? null,
        tokensAfter: after?.tokens ?? null,
        contextWindow: after?.contextWindow ?? before?.contextWindow ?? null,
      };

      if (freshContext) {
        const reason = opts.reason || "manual";
        const patch = buildFreshCompactMetaPatch({
          snapshot: freshContext.snapshot,
          reason,
          now: opts.now || new Date(),
          usage: result,
        });
        this._writeIndexEntryPatch(agent, sessionKey, {
          freshCompact: patch,
          promptSnapshot,
          ...(activeToolNames.length ? { toolNames: activeToolNames } : {}),
        });
        return { ...result, fresh: true, reason };
      }

      const shouldPersistToolNames = activeToolNames.length && !sameToolNames(activeToolNames, entry.toolNames);
      if (!restoredPromptSnapshot || shouldPersistToolNames) {
        const patch: any = {};
        if (!restoredPromptSnapshot) patch.promptSnapshot = promptSnapshot;
        if (activeToolNames.length) patch.toolNames = activeToolNames;
        this._writeIndexEntryPatch(agent, sessionKey, patch);
      }

      return result;
    } finally {
      await teardownSessionResources({
        session,
        label: `bridge.compactSession[${sessionKey}]`,
        warn: (msg) => log.warn(msg),
      } as any);
    }
  }

  async freshCompactSession(sessionKey, opts: any = {}) {
    return this.compactSession(sessionKey, {
      ...opts,
      fresh: true,
      reason: opts.reason || "manual",
    });
  }

  /** 创建 bridge 专用 settings：compaction 由 SDK 默认触发（contextWindow - 16384） */
  _createSettings(_model) {
    return createDefaultSettings();
  }
}

function addAttachedImageMarkers(text, imageAttachmentPaths) {
  const promptText = text || "";
  const missing = Array.from(new Set(imageAttachmentPaths || []))
    .filter((filePath) => filePath && !promptText.includes(`[attached_image: ${filePath}]`));
  if (!missing.length) return promptText;
  const markerText = missing.map((filePath) => `[attached_image: ${filePath}]`).join("\n");
  return promptText ? `${markerText}\n${promptText}` : markerText;
}
