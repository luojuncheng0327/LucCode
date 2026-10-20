/**
 * Session 管理 REST 路由
 */
import { appendFileSync } from "fs";
import fs from "fs/promises";
import path from "path";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.ts";
import { bodyFromRouteError, routeError, statusFromRouteError } from "./route-errors.ts";
import { t } from "../../lib/i18n.ts";
import { dropUninstalledPluginCards, extractBlocks, pluginInstalledPredicate, resolveMediaGenerationBlocks } from "../block-extractors.ts";
import { normalizePluginChatSurfaceBlocks } from "../plugin-chat-surface.ts";
import { buildDeferredResultInterludeBlock, resolveDeferredReceiverName } from "../deferred-result-interlude.ts";
import { BrowserManager } from "../../lib/browser/browser-manager.ts";
import { isSessionJsonlFilename, sessionIdFromFilename } from "../../lib/session-jsonl.ts";
import {
  DEFERRED_RESULT_MESSAGE_TYPE,
  DEFERRED_RESULT_RECORD_TYPE,
  buildDeferredResultRecord,
  parseDeferredResultNotification,
  parseDeferredResultRecord,
} from "../../lib/deferred-result-notification.ts";
import {
  TURN_INPUT_CONSUMPTION_EVENT_TYPE,
  TURN_INPUT_PRESENTATION_EVENT_TYPE,
  isCustomTurnInputHistoryMessage,
  isHiddenTurnInputMessage,
  parseTurnInputConsumptionRecord,
  parseTurnInputPresentationRecord,
} from "../../lib/turn-input-presentation.ts";
import {
  materializeExecutorIdentity,
  normalizeExecutorMetadata,
  readSubagentSessionMetaSync,
} from "../../lib/subagent-executor-metadata.ts";
import {
  extractTextContent,
  contentHasThinkingBlock,
  filterUnreferencedInlineImages,
  loadSessionHistoryMessages,
  loadLatestAssistantSummaryFromSessionFile,
  isValidSessionPath,
  isActiveDesktopSessionPath,
  isArchivedDesktopSessionPath,
  annotateOriginMessages,
  collectSessionCollabDecisions,
  overlaySessionCollabDecision,
} from "../../core/message-utils.ts";
import {
  AGENT_REVIEW_RECORD_TYPE,
  MESSAGE_ORIGIN_RECORD_TYPE,
  MESSAGE_PRESENTATION_RECORD_TYPE,
} from "../../core/desktop-session-submit.ts";
import { stripSessionReminderBlocks } from "../../core/session-reminders.ts";
import { sessionFileRevision } from "../../core/session-list-projection-cache.ts";
import {
  extractLatestTodoSnapshot,
  extractLatestTodos,
} from "../../lib/tools/todo-compat.ts";
import { SessionManager } from "../../lib/pi-sdk/index.ts";
import { TODO_STATE_CUSTOM_TYPE } from "../../lib/tools/todo-constants.ts";
import { mergeWorkspaceHistory } from "../../shared/workspace-history.ts";
import { sanitizeBridgeVisibleText } from "../../shared/bridge-visible-text.ts";
import {
  deleteSessionFileSidecarSync,
  moveSessionFileSidecarSync,
  sessionFileSidecarPath,
} from "../../lib/session-files/session-file-registry.ts";
import { serializeSessionFile } from "../../lib/session-files/session-file-response.ts";
import { browserScreenshotPath } from "../../lib/session-files/browser-screenshot-file.ts";
import { getModelThinkingLevels, normalizeSessionThinkingLevel, modelSupportsXhigh, resolveModelDefaultThinkingLevel } from "../../core/session-thinking-level.ts";
import {
  modelSupportsDirectAudioInput,
  modelSupportsDirectVideoInput,
  modelSupportsAudioInput,
  modelSupportsVideoInput,
  resolveModelAudioInputTransport,
  resolveModelVideoInputTransport,
} from "../../shared/model-capabilities.ts";
import { replayLatestUserTurn, retrySessionTurn } from "../../core/session-turn-actions.ts";
import { createRequestContext } from "../http/boundary.ts";
import { createModuleLogger } from "../../lib/debug-log.ts";
import { searchSessions } from "../../lib/search/session-search.ts";
import { findInSessionMessages } from "../../lib/search/session-find.ts";
import { SessionSearchTokenizerUnavailableError } from "../../lib/search/session-search-tokenizer.ts";
import { MountAwareFileError, MountAwareFileService } from "../../core/mount-aware-file-service.ts";
import { isAssistantCommentaryTextBlock } from "../../shared/text-signature.ts";
import { collectToolOutcomesByCallId } from "../../shared/tool-outcome.ts";

const log = createModuleLogger("sessions");
const lifecycleLog = createModuleLogger("sessions/lifecycle");
const switchLog = createModuleLogger("sessions/switch");
const SESSION_SEARCH_QUERY_MAX_LENGTH = 512;

function rcPlatformFromSessionKey(sessionKey) {
  const match = /^([a-z]+)_/i.exec(sessionKey || "");
  return match ? match[1] : "bridge";
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function completeTodoItems(todos) {
  return (Array.isArray(todos) ? todos : []).map((todo) => ({
    ...todo,
    status: "completed",
  }));
}

function getWritableSessionManager(engine, sessionPath) {
  const liveSession = engine.getSessionByPath?.(sessionPath);
  if (liveSession?.sessionManager) return liveSession.sessionManager;
  if (typeof engine.openSessionManagerAtCurrentBranch === "function") {
    return engine.openSessionManagerAtCurrentBranch(sessionPath, path.dirname(sessionPath));
  }
  return SessionManager.open(sessionPath, path.dirname(sessionPath));
}

function authorizeSessionRoute(requestContext, capability, target) {
  if (requestContext.authPrincipal?.kind === "unknown") return { allowed: true, reason: "legacy_test_context" };
  if (typeof requestContext.authorize !== "function") return { allowed: false, reason: "missing_policy" };
  return requestContext.authorize(capability, target);
}

function resolveSessionWorkspaceSelection(engine, requestContext, body) {
  const mountId = typeof body?.workspaceMountId === "string" && body.workspaceMountId.trim()
    ? body.workspaceMountId.trim()
    : null;
  if (!mountId) {
    return {
      cwd: typeof body?.cwd === "string" && body.cwd.trim() ? body.cwd : null,
      mount: null,
    };
  }
  if (typeof body?.cwd === "string" && body.cwd.trim()) {
    throw routeError("cwd and workspaceMountId cannot be combined", "ambiguous_workspace", 400);
  }
  try {
    const files = new MountAwareFileService({
      lucHome: engine.luccodeHome,
      defaultRoot: engine.defaultDeskCwd || engine.homeCwd || engine.deskCwd,
      studioId: requestContext?.studioId || engine.getRuntimeContext?.()?.studioId || null,
    });
    const root = files.resolveRoot(mountId);
    return {
      cwd: files.resolveDirectory(mountId, ""),
      mount: {
        mountId: root.mountId || root.id || mountId,
        label: root.label || null,
      },
    };
  } catch (err) {
    if (err instanceof MountAwareFileError) {
      throw routeError(err.message, err.code, err.status);
    }
    throw err;
  }
}

function sessionWorkspaceMountFields(engine, sessionPath, fallback = null) {
  const mount = engine.getSessionWorkspaceMount?.(sessionPath) || fallback || null;
  if (!mount?.mountId) return {};
  return {
    workspaceMountId: mount.mountId,
    workspaceLabel: mount.label || null,
  };
}

async function resumeBrowserForSessionSwitch(bm, sessionPath) {
  if (typeof bm.resumeForSessionIfAvailable === "function") {
    return await bm.resumeForSessionIfAvailable(sessionPath);
  }
  await bm.resumeForSession(sessionPath);
  return {
    status: "resumed",
    canResume: true,
    reason: null,
    hostConnected: null,
    hasResumeState: true,
    running: bm.isRunning(sessionPath),
    url: bm.currentUrl(sessionPath) || null,
  };
}

/**
 * 把建会话失败的异常分层成 { status, body }。
 *
 * 唯一正确的做法是在抛错点就带上 code 和 status——新增抛错点必须这么写。
 * 下面那串文案正则只服务于还没来得及带码的历史抛错点：它依赖错误信息的字面量，
 * 上游改一次文案就会失灵，翻译一变更是直接漏判。所以它是只减不增的兜底，
 * 不要再往里加语言或新的匹配分支。
 */
function classifySessionCreationError(err) {
  const message = err?.message || String(err);
  if (err?.status && Number.isInteger(err.status)) {
    return { status: err.status, body: { error: message, code: err.code || "session_create_failed" } };
  }
  if (
    /no available model/i.test(message)
    || /no available models/i.test(message)
    || /没有可用的模型/.test(message)
    || /沒有可用的模型/.test(message)
    || /利用可能なモデルがありません/.test(message)
    || /사용 가능한 모델이 없/.test(message)
  ) {
    return { status: 409, body: { error: message, code: "no_available_model" } };
  }
  return { status: 500, body: { error: message } };
}

const TODO_COMPLETE_MESSAGE =
  "[Luc Todo] The user marked the current todo list as completed and removed it from the session UI. Treat every item in that list as completed. Create a new todo list only if new work needs tracking.";

function stripInlineThinkText(text) {
  return String(text || "").replace(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>\n*/g, "");
}

function hasInlineImageContent(content) {
  if (!Array.isArray(content)) return false;
  return content.some(block => block?.type === "image" && (block.data || block.source?.data));
}

function hasTextBlockContent(content, { stripThink = false } = {}) {
  if (typeof content === "string") {
    const text = stripThink ? stripInlineThinkText(content) : content;
    return text.length > 0;
  }
  if (!Array.isArray(content)) return false;
  return content.some(block => block?.type === "text" && block.text && !isAssistantCommentaryTextBlock(block));
}

function hasToolUseContent(content) {
  if (!Array.isArray(content)) return false;
  return content.some(block => (block?.type === "tool_use" || block?.type === "toolCall") && !!block.name);
}

function isDisplayableHistoryMessage(message) {
  if (!message || typeof message !== "object") return false;
  if (message.role === "user") {
    return hasTextBlockContent(message.content) || hasInlineImageContent(message.content);
  }
  if (message.role === "assistant") {
    return hasTextBlockContent(message.content, { stripThink: true })
      || contentHasThinkingBlock(message.content, { stripThink: true })
      || hasToolUseContent(message.content);
  }
  return false;
}

// 与 /sessions/messages 主循环的序号语义逐字对齐：
// 只有 user/assistant 且 isDisplayableHistoryMessage 为真的消息推进 displayIdx。
// 改这里必须同步改 messages 主循环与 tests/session-find-route.test.ts 的一致性测试。
const FIND_LEGACY_STEER_PREFIX_RE = /^(?:（插话，无需 MOOD）|\(Interjection, no MOOD needed\))\n?/;
const FIND_TURN_TAG_PREFIX_RE = /^<t>[^<]*<\/t>\s*/;

// find 路由的热路径缓存：key 为 sessionPath，value 为 { revision, entries }。
// revision（stat 签名，与 /api/sessions 列表投影同源同格式）不一致即失效；
// revision 为 null（修订未知）时不写缓存，防止把"未知"固化成陈旧命中。
// 容量上限 FIND_ENTRIES_CACHE_MAX，超限时按插入序淘汰最早的 key。
const FIND_ENTRIES_CACHE_MAX = 8;
const findEntriesCache = new Map();

export function collectFindableHistoryEntries(sourceMessages, sanitizeVisibleContent) {
  const entries = [];
  let displayIdx = 0;
  for (const m of Array.isArray(sourceMessages) ? sourceMessages : []) {
    if (m?.role !== "user" && m?.role !== "assistant") continue;
    if (!isDisplayableHistoryMessage(m)) continue;
    const currentIndex = displayIdx;
    displayIdx += 1;
    if (m.role === "user") {
      const { text } = extractTextContent(m.content);
      const content = sanitizeVisibleContent(text);
      // 前端 history-builder 不渲染这类系统消息（history-builder.ts:503），
      // 序号照常推进，但不参与命中。
      if (isHiddenTurnInputMessage({ content })) continue;
      const visible = content
        .replace(FIND_LEGACY_STEER_PREFIX_RE, "")
        .replace(FIND_TURN_TAG_PREFIX_RE, "");
      if (visible.trim()) entries.push({ index: currentIndex, text: visible });
    } else {
      const { text } = extractTextContent(m.content, { stripThink: true });
      const content = sanitizeVisibleContent(text);
      if (content.trim()) entries.push({ index: currentIndex, text: content });
    }
  }
  return entries;
}

function nextImmediateDisplayableAssistantIndex(sourceMessages, sourceIndex, displayIdxAtSource) {
  let displayIdx = displayIdxAtSource;
  for (let i = sourceIndex + 1; i < sourceMessages.length; i += 1) {
    const message = sourceMessages[i];
    if (!isDisplayableHistoryMessage(message)) continue;
    const currentIndex = displayIdx;
    displayIdx += 1;
    if (message.role === "user") return null;
    if (message.role === "assistant") return currentIndex;
  }
  return null;
}

function resolveHistoryPageBounds(sourceMessages, { beforeId, limit, forceAll }) {
  let total = 0;
  for (const message of sourceMessages) {
    if (isDisplayableHistoryMessage(message)) total += 1;
  }
  if (forceAll) return { total, startIdx: 0, endIdx: total, hasMore: false };
  const endIdx = (beforeId != null && beforeId > 0)
    ? Math.min(beforeId, total)
    : total;
  const startIdx = Math.max(0, endIdx - limit);
  return { total, startIdx, endIdx, hasMore: startIdx > 0 };
}

function isBridgeSessionPath(sessionPath) {
  if (typeof sessionPath !== "string" || !sessionPath) return false;
  return sessionPath.split(/[\\/]+/).includes("bridge");
}

/**
 * 读取会话文件的磁盘修订点（stat 签名，与 /api/sessions 列表投影同源同格式）。
 * stat 失败（请求竞态中文件被归档/删除）返回 null —— 显式的「修订点未知」，
 * 前端对 null 的策略是下次触发时重新校验，不会把差异静默吞掉。
 */
async function readSessionFileRevision(sessionPath) {
  if (!sessionPath) return null;
  try {
    return sessionFileRevision(await fs.stat(sessionPath));
  } catch {
    return null;
  }
}

export function createSessionsRoute(engine, hub = null) {
  const route = new Hono();
  const lifecycleLocks = new Map();

  function resolveSessionCacheLocator(sessionPath) {
    if (!sessionPath) return { cacheKey: null, readPath: null, sessionId: null };
    const sessionId = engine.getSessionIdForPath?.(sessionPath) || null;
    const manifest = sessionId ? engine.getSessionManifest?.(sessionId) || null : null;
    const currentPath = typeof manifest?.currentLocator?.path === "string" && manifest.currentLocator.path
      ? manifest.currentLocator.path
      : sessionPath;
    return {
      cacheKey: sessionId || sessionPath,
      readPath: currentPath,
      sessionId,
    };
  }

  function currentSessionPathForId(sessionId) {
    if (!sessionId) return null;
    const manifest = engine.getSessionManifest?.(sessionId) || null;
    const currentPath = manifest?.currentLocator?.path;
    return typeof currentPath === "string" && currentPath ? currentPath : null;
  }

  function resolveSubagentBlockSession(block, task = null, run = null) {
    const rawSessionId =
      block?.sessionId
      || task?.meta?.sessionId
      || run?.childSessionId
      || null;
    let sessionId = typeof rawSessionId === "string" && rawSessionId.trim() ? rawSessionId.trim() : null;
    let sessionPath =
      block?.streamKey
      || task?.meta?.sessionPath
      || run?.childSessionPath
      || null;
    if (typeof sessionPath !== "string" || !sessionPath.trim()) sessionPath = null;
    if (!sessionId && sessionPath) {
      sessionId = engine.getSessionIdForPath?.(sessionPath) || null;
    }
    if (sessionId) {
      sessionPath = currentSessionPathForId(sessionId) || sessionPath;
    }
    return { sessionId, sessionPath };
  }

  // session-meta.json sidecar 按 session 目录共享；同一个 request 里遍历几十个 block
  // 时不必每个 block 都重复 readFileSync + JSON.parse。调用端构造一次 Map 当 cache。
  function createSubagentMetaCache() {
    const map = new Map();
    return (sessionPath) => {
      if (!sessionPath) return null;
      const { cacheKey, readPath, sessionId } = resolveSessionCacheLocator(sessionPath);
      if (!cacheKey || !readPath) return null;
      if (map.has(cacheKey)) return map.get(cacheKey);
      const manifestMeta = normalizeExecutorMetadata(
        engine.getSessionExecutorMetadata?.({ sessionId, sessionPath: readPath }),
      );
      const meta = manifestMeta || readSubagentSessionMetaSync(readPath);
      map.set(cacheKey, meta);
      return meta;
    };
  }

  function applySubagentIdentity(block, task, readSessionMeta) {
    const sessionRef = resolveSubagentBlockSession(block, task);
    if (sessionRef.sessionId && !block.sessionId) block.sessionId = sessionRef.sessionId;
    if (sessionRef.sessionPath) block.streamKey = sessionRef.sessionPath;
    const sessionPath = sessionRef.sessionPath;
    const sessionMeta = readSessionMeta(sessionPath);
    const resolved =
      materializeExecutorIdentity(sessionMeta, engine.getAgent?.bind(engine))
      || materializeExecutorIdentity(task?.meta, engine.getAgent?.bind(engine))
      || materializeExecutorIdentity(block, engine.getAgent?.bind(engine));

    if (resolved) {
      block.agentId = resolved.agentId;
      block.agentName = resolved.agentName;
      return;
    }

    const inferredAgentId = sessionPath
      ? engine.resolveSessionOwnership?.(sessionPath)?.agentId || null
      : null;
    if (!inferredAgentId) return;

    const inferredAgent = engine.getAgent?.(inferredAgentId) || null;
    block.agentId = inferredAgentId;
    block.agentName = inferredAgent?.agentName || "Unknown agent";
  }

  function patchBlockExecutorMetadata(block, task, readSessionMeta) {
    const sessionRef = resolveSubagentBlockSession(block, task);
    if (sessionRef.sessionId && !block.sessionId) block.sessionId = sessionRef.sessionId;
    if (sessionRef.sessionPath) block.streamKey = sessionRef.sessionPath;
    const sessionPath = sessionRef.sessionPath;
    const sessionMeta = readSessionMeta(sessionPath);
    const sources = [sessionMeta, task?.meta, block];

    for (const source of sources) {
      if (!source) continue;
      if (source.executorAgentId && !block.executorAgentId) {
        block.executorAgentId = source.executorAgentId;
      }
      if (source.executorAgentNameSnapshot && !block.executorAgentNameSnapshot) {
        block.executorAgentNameSnapshot = source.executorAgentNameSnapshot;
      }
      if (source.executorMetaVersion && !block.executorMetaVersion) {
        block.executorMetaVersion = source.executorMetaVersion;
      }
    }
  }

  function patchBlockRequestedMetadata(block, task = null) {
    const sources = [task?.meta, block];

    for (const source of sources) {
      if (!source) continue;
      if (source.requestedAgentId && !block.requestedAgentId) {
        block.requestedAgentId = source.requestedAgentId;
      }
      if (source.requestedAgentNameSnapshot && !block.requestedAgentName) {
        block.requestedAgentName = source.requestedAgentNameSnapshot;
      }
    }
  }

  function taskFromSubagentRun(run) {
    if (!run) return null;
    return {
      status: run.status,
      result: run.summary || null,
      reason: run.reason || run.summary || null,
      meta: {
        sessionId: run.childSessionId || null,
        sessionPath: run.childSessionPath || null,
        requestedAgentId: run.requestedAgentId || null,
        requestedAgentNameSnapshot: run.requestedAgentNameSnapshot || null,
        executorAgentId: run.executorAgentId || null,
        executorAgentNameSnapshot: run.executorAgentNameSnapshot || null,
        executorMetaVersion: run.executorMetaVersion || null,
      },
    };
  }

  function mergeSubagentTaskMetadata(primary, fallback) {
    if (!primary) return fallback || null;
    if (!fallback) return primary;
    const primaryMeta = {};
    for (const [key, value] of Object.entries(primary.meta || {})) {
      if (value != null) primaryMeta[key] = value;
    }
    return {
      status: primary.status || fallback.status,
      result: primary.result ?? fallback.result,
      reason: primary.reason ?? fallback.reason,
      meta: {
        ...(fallback.meta || {}),
        ...primaryMeta,
      },
    };
  }

  function createSubagentSummaryCache() {
    const map = new Map();
    return async (sessionPath) => {
      if (!sessionPath) return null;
      const { cacheKey, readPath } = resolveSessionCacheLocator(sessionPath);
      if (!cacheKey || !readPath) return null;
      if (!map.has(cacheKey)) {
        map.set(cacheKey, loadLatestAssistantSummaryFromSessionFile(readPath));
      }
      return await map.get(cacheKey);
    };
  }

  function getSessionSummaryRecord(sessionPath, agentIdHint = null) {
    if (!sessionPath) return null;
    const agentId = agentIdHint || engine.resolveSessionOwnership?.(sessionPath)?.agentId || null;
    if (!agentId) return null;
    const agent = engine.getAgent?.(agentId) || null;
    const summaryManager = agent?.summaryManager || null;
    if (!summaryManager || typeof summaryManager.getSummary !== "function") return null;

    const sessionId = engine.getSessionIdForPath?.(sessionPath)
      || sessionIdFromFilename(path.basename(sessionPath));
    const record = summaryManager.getSummary(sessionId);
    return record?.summary?.trim() ? record : null;
  }

  function serializeSessionSummaryRecord(record) {
    return {
      hasSummary: !!record,
      summary: record?.summary || null,
      createdAt: record?.created_at || null,
      updatedAt: record?.updated_at || null,
    };
  }

  function invalidateRcTarget(sessionPath) {
    const rcState = engine.rcState;
    if (!rcState?.invalidateDesktopSession) return;

    const { detachedAttachments } = rcState.invalidateDesktopSession(sessionPath);
    for (const attachment of detachedAttachments) {
      try {
        engine.emitEvent?.({
          type: "bridge_rc_detached",
          sessionKey: attachment.sessionKey,
          sessionPath: attachment.desktopSessionPath,
        }, attachment.desktopSessionPath);
      } catch {}
    }
  }

  function archivedPathForActiveSession(sessionPath) {
    return path.join(path.dirname(sessionPath), "archived", path.basename(sessionPath));
  }

  function activePathForArchivedSession(sessionPath) {
    return path.join(path.dirname(path.dirname(sessionPath)), path.basename(sessionPath));
  }

  function lifecycleLockKeyForPaths(paths) {
    for (const sessionPath of uniqueLifecyclePaths(paths)) {
      try {
        const sessionId = engine.getSessionIdForPath?.(sessionPath);
        if (typeof sessionId === "string" && sessionId.trim()) return `session:${sessionId.trim()}`;
      } catch {
        // Fall through to path-derived legacy lock keys.
      }
    }
    for (const sessionPath of uniqueLifecyclePaths(paths)) {
      const sessionPathText = typeof sessionPath === "string" ? sessionPath : "";
      const agentId = engine.resolveSessionOwnership?.(sessionPathText)?.agentId || "unknown-agent";
      const basename = path.basename(sessionPathText);
      if (basename) return `legacy:${agentId}:${basename}`;
    }
    return "legacy:unknown-session";
  }

  async function withSessionLifecycleLock(paths, fn) {
    const key = lifecycleLockKeyForPaths(paths);
    while (lifecycleLocks.has(key)) {
      await lifecycleLocks.get(key).catch(() => {});
    }
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    lifecycleLocks.set(key, held);
    try {
      return await fn();
    } finally {
      if (lifecycleLocks.get(key) === held) lifecycleLocks.delete(key);
      release();
    }
  }

  async function moveSessionLifecycleOrThrow(input) {
    if (typeof engine.moveSessionLifecycle !== "function") {
      throw routeError(
        "Session manifest lifecycle transition is unavailable",
        "session_manifest_unavailable",
        503,
      );
    }
    const manifest = await engine.moveSessionLifecycle(input);
    if (!manifest?.sessionId) {
      throw routeError(
        "Session manifest lifecycle transition failed",
        "session_lifecycle_transition_failed",
        500,
      );
    }
    return manifest;
  }

  async function permanentlyDeleteArchivedFile(sessionPath, reason) {
    const stagedPath = `${sessionPath}.deleting`;
    if (await pathExists(stagedPath) || await pathExists(sessionFileSidecarPath(stagedPath))) {
      throw routeError("Archived session deletion is already staged", "session_delete_staged_conflict", 409);
    }

    await fs.rename(sessionPath, stagedPath);
    try {
      moveSessionFileSidecarSync(sessionPath, stagedPath);
    } catch (err) {
      await fs.rename(stagedPath, sessionPath).catch(() => {});
      throw err;
    }

    let manifest;
    try {
      manifest = await moveSessionLifecycleOrThrow({
        fromPath: sessionPath,
        toPath: sessionPath,
        lifecycle: "deleted",
        reason,
      });
    } catch (err) {
      moveSessionFileSidecarSync(stagedPath, sessionPath);
      await fs.rename(stagedPath, sessionPath).catch(() => {});
      throw err;
    }

    try {
      await fs.unlink(stagedPath);
      deleteSessionFileSidecarSync(stagedPath);
    } catch (err) {
      try {
        await moveSessionLifecycleOrThrow({
          fromPath: sessionPath,
          toPath: sessionPath,
          lifecycle: "archived",
          reason: "session_delete_rollback",
        });
        await fs.rename(stagedPath, sessionPath);
        moveSessionFileSidecarSync(stagedPath, sessionPath);
      } catch (rollbackErr) {
        lifecycleLog.error(`delete rollback failed for ${sessionPath}: ${rollbackErr.message}`);
      }
      throw err;
    }
    return manifest;
  }

  async function sessionFileHasMessages(sessionPath) {
    const raw = await fs.readFile(sessionPath, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        return true;
      }
      if (entry?.type === "message" && entry.message) return true;
    }
    return false;
  }

  async function repairHeaderOnlyActiveRestoreTarget(destPath) {
    if (!(await pathExists(destPath))) return { repaired: false };
    if (await sessionFileHasMessages(destPath)) {
      throw routeError("Active path already exists with messages", "active_session_conflict", 409);
    }
    await fs.unlink(destPath);
    deleteSessionFileSidecarSync(destPath);
    return { repaired: true };
  }

  function uniqueLifecyclePaths(paths) {
    return [...new Set((paths || []).filter((p) => typeof p === "string" && p.trim()))];
  }

  function lifecycleSessionRef(sessionPath) {
    if (!sessionPath) return sessionPath;
    try {
      const sessionId = engine.getSessionIdForPath?.(sessionPath);
      if (typeof sessionId === "string" && sessionId.trim()) {
        return { sessionId: sessionId.trim(), sessionPath };
      }
    } catch {
      // Keep path-only cleanup for legacy sessions when manifest lookup fails.
    }
    return sessionPath;
  }

  async function cleanupSessionLifecycle(sessionPaths, reason, options: { skipMemory?: boolean } = {}) {
    const bm = BrowserManager.instance();
    for (const sessionPath of uniqueLifecyclePaths(sessionPaths)) {
      const sessionRef = lifecycleSessionRef(sessionPath);
      try {
        engine.taskRegistry?.abortByParentSession?.(sessionPath, reason);
      } catch (err) {
        lifecycleLog.warn(`task cleanup failed for ${sessionPath}: ${err.message}`);
      }
      try {
        engine.subagentRuns?.abortByParentSession?.(sessionPath, reason);
      } catch (err) {
        lifecycleLog.warn(`subagent run cleanup failed for ${sessionPath}: ${err.message}`);
      }
      try {
        engine.subagentThreads?.removeBySession?.(sessionPath);
      } catch (err) {
        lifecycleLog.warn(`subagent thread cleanup failed for ${sessionPath}: ${err.message}`);
      }
      try {
        // 右侧 workflow 卡活动随对话退场（内存 + 持久化背书一并清，按 sessionId 归属）。
        engine.activityHub?.clearBySession?.(sessionRef);
      } catch (err) {
        lifecycleLog.warn(`activity hub cleanup failed for ${sessionPath}: ${err.message}`);
      }
      try {
        engine.deferredResults?.suppressBySession?.(sessionRef, reason);
      } catch (err) {
        lifecycleLog.warn(`deferred cleanup failed for ${sessionPath}: ${err.message}`);
      }
      try {
        engine.confirmStore?.abortBySession?.(sessionRef);
      } catch (err) {
        lifecycleLog.warn(`confirm cleanup failed for ${sessionPath}: ${err.message}`);
      }
      try {
        if (typeof engine.discardSessionRuntime === "function") {
          if (options && Object.keys(options).length > 0) {
            await engine.discardSessionRuntime(sessionPath, reason, options);
          } else {
            await engine.discardSessionRuntime(sessionPath, reason);
          }
        } else {
          await engine.abortSessionByPath?.(sessionPath);
        }
      } catch (err) {
        lifecycleLog.warn(`session runtime cleanup failed for ${sessionPath}: ${err.message}`);
      }
      try {
        await bm.closeBrowserForSession(sessionPath);
      } catch (err) {
        lifecycleLog.warn(`browser cleanup failed for ${sessionPath}: ${err.message}`);
      }
      try {
        engine.terminalSessions?.closeForSession?.(sessionPath);
      } catch (err) {
        lifecycleLog.warn(`terminal cleanup failed for ${sessionPath}: ${err.message}`);
      }
      invalidateRcTarget(sessionPath);
    }
  }

  function isDeletedAgentSessionPath(sessionPath) {
    if (!sessionPath) return false;
    return engine.isDeletedAgentSession?.(sessionPath) === true;
  }

  function rejectDeletedAgentSession(c) {
    return c.json({ error: "agent_deleted", reason: "agent_deleted" }, 409);
  }

  function normalizeRequestSessionId(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  function resolveSessionLocatorFromBody(body, operation) {
    const sessionId = normalizeRequestSessionId(body?.sessionId);
    const legacySessionPath = typeof body?.path === "string" && body.path.trim()
      ? body.path
      : typeof body?.sessionPath === "string" && body.sessionPath.trim()
        ? body.sessionPath
        : null;

    if (sessionId) {
      const manifest = engine.getSessionManifest?.(sessionId) || null;
      const sessionPath = manifest?.currentLocator?.path || null;
      if (!sessionPath) {
        throw routeError(`${operation}: session manifest not found`, "session_manifest_not_found", 404);
      }
      if (legacySessionPath && path.resolve(legacySessionPath) !== path.resolve(sessionPath)) {
        const err: any = routeError(
          `${operation}: supplied path does not match the current session locator`,
          "session_locator_mismatch",
          409,
        );
        err.sessionId = sessionId;
        err.requestedPath = legacySessionPath;
        err.currentPath = sessionPath;
        err.lifecycle = manifest.lifecycle || null;
        throw err;
      }
      return { sessionId, sessionPath, manifest };
    }

    if (!legacySessionPath) {
      throw routeError(`${operation}: sessionId or path is required`, "session_locator_required", 400);
    }
    const resolvedSessionId = normalizeRequestSessionId(engine.getSessionIdForPath?.(legacySessionPath));
    const manifest = resolvedSessionId ? engine.getSessionManifest?.(resolvedSessionId) || null : null;
    return { sessionId: resolvedSessionId, sessionPath: legacySessionPath, manifest };
  }

  function assertManifestLifecycle(ref, lifecycle, operation) {
    if (!ref?.manifest?.lifecycle) return;
    if (ref.manifest.lifecycle === lifecycle) return;
    const err: any = routeError(
      `${operation}: session lifecycle is ${ref.manifest.lifecycle}, expected ${lifecycle}`,
      "session_lifecycle_mismatch",
      409,
    );
    err.sessionId = ref.sessionId || ref.manifest.sessionId || null;
    err.currentPath = ref.manifest.currentLocator?.path || null;
    err.lifecycle = ref.manifest.lifecycle;
    throw err;
  }

  function sessionFolderScopeResponse(scope) {
    return {
      ok: true,
      sessionPath: scope?.sessionPath || null,
      cwd: scope?.cwd || null,
      workspaceFolders: Array.isArray(scope?.workspaceFolders) ? scope.workspaceFolders : [],
      authorizedFolders: Array.isArray(scope?.authorizedFolders) ? scope.authorizedFolders : [],
      sandboxFolders: Array.isArray(scope?.sandboxFolders) ? scope.sandboxFolders : [],
    };
  }

  async function validateAuthorizedFolder(rawFolder) {
    if (typeof rawFolder !== "string" || !rawFolder.trim()) {
      throw new Error("folder is required");
    }
    const folder = path.resolve(rawFolder.trim());
    let stat;
    try {
      stat = await fs.stat(folder);
    } catch {
      throw new Error("folder does not exist");
    }
    if (!stat.isDirectory()) {
      throw new Error("folder must be a directory");
    }
    return folder;
  }

  function normalizeAuthorizedFolderPath(rawFolder) {
    if (typeof rawFolder !== "string" || !rawFolder.trim()) {
      throw new Error("folder is required");
    }
    return path.resolve(rawFolder.trim());
  }

  // 列出所有 agent 的历史 session
  route.get("/sessions", async (c) => {
    try {
      const requestContext = createRequestContext(c, engine);
      const auth = authorizeSessionRoute(requestContext, "sessions.read", {
        kind: "studio",
        studioId: requestContext.studioId,
      });
      if (!auth.allowed) return c.json({ error: "insufficient_scope", reason: auth.reason }, 403);
      const runtimeStudioId = requestContext.runtimeContext?.studioId || null;
      const principalStudioId = requestContext.authPrincipal?.studioId || null;
      // Same-Studio projection v0: paired clients may see the legacy session store
      // only when their authenticated Studio is the server's current Studio.
      if (runtimeStudioId && principalStudioId && runtimeStudioId !== principalStudioId) {
        return c.json({
          error: "studio_scope_mismatch",
          detail: "authenticated Studio does not match this server Studio",
        }, 403);
      }
      const sessions = await engine.listSessions();
      const attachments = engine.rcState?.listAttachments?.() || [];
      const rcAttachmentByPath = new Map(attachments.map((attachment) => [
        attachment.desktopSessionPath,
        {
          sessionKey: attachment.sessionKey,
          platform: rcPlatformFromSessionKey(attachment.sessionKey),
        },
      ]));
      return c.json(sessions.map(s => {
        const summaryRecord = getSessionSummaryRecord(s.path, s.agentId || null);
        return ({
          path: s.path,
          sessionId: s.sessionId || engine.getSessionIdForPath?.(s.path) || null,
          title: s.title || null,
          firstMessage: (s.firstMessage || "").slice(0, 100),
          modified: s.modified?.toISOString() || null,
          // 磁盘修订点（stat 签名）。web/mobile 端用它对比已缓存会话内容，
          // 决定是否补拉 /rc 接管等离线窗口写入的消息（issue #1610）。
          revision: typeof s.revision === "string" ? s.revision : null,
          messageCount: s.messageCount || 0,
          cwd: s.cwd || null,
          agentId: s.agentId || null,
          agentName: s.agentName || null,
          projectId: s.projectId || null,
          modelId: s.modelId || null,
          modelProvider: s.modelProvider || null,
          workspaceMountId: s.workspaceMountId || null,
          workspaceLabel: s.workspaceLabel || null,
          permissionMode: s.permissionMode || (typeof engine.getSessionPermissionMode === "function"
            ? engine.getSessionPermissionMode(s.path)
            : engine.permissionMode || null),
          pinnedAt: s.pinnedAt || null,
          pinOrder: Number.isFinite(s.pinOrder) ? s.pinOrder : null,
          agentDeleted: s.agentDeleted === true,
          readOnlyReason: s.readOnlyReason || (s.agentDeleted === true ? "agent_deleted" : null),
          continuationAvailable: s.continuationAvailable === true,
          deletedAt: s.deletedAt || null,
          hasSummary: !!summaryRecord,
          rcAttachment: rcAttachmentByPath.get(s.path)
            ? {
              ...(rcAttachmentByPath.get(s.path) as any),
              title: s.title || null,
            }
            : null,
        });
      }));
    } catch (err) {
      return c.json({ error: err.message }, err.status || 500);
    }
  });

  route.get("/sessions/search", async (c) => {
    try {
      const requestContext = createRequestContext(c, engine);
      const auth = authorizeSessionRoute(requestContext, "sessions.read", {
        kind: "studio",
        studioId: requestContext.studioId,
      });
      if (!auth.allowed) return c.json({ error: "insufficient_scope", reason: auth.reason }, 403);
      const runtimeStudioId = requestContext.runtimeContext?.studioId || null;
      const principalStudioId = requestContext.authPrincipal?.studioId || null;
      if (runtimeStudioId && principalStudioId && runtimeStudioId !== principalStudioId) {
        return c.json({
          error: "studio_scope_mismatch",
          detail: "authenticated Studio does not match this server Studio",
        }, 403);
      }

      const query = c.req.query("q") || "";
      const phase = c.req.query("phase") === "content" ? "content" : "title";
      const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
      const trimmedQuery = query.trim();
      if (!trimmedQuery) return c.json({ query, phase, results: [] });
      if ([...trimmedQuery].length > SESSION_SEARCH_QUERY_MAX_LENGTH) {
        return c.json({
          error: "query_too_long",
          maxLength: SESSION_SEARCH_QUERY_MAX_LENGTH,
        }, 400);
      }

      const sessions = await engine.listSessions();
      const results = searchSessions(sessions, trimmedQuery, { phase, limit }).map((s) => ({
        path: s.path,
        sessionId: s.sessionId || engine.getSessionIdForPath?.(s.path) || null,
        title: s.title || null,
        firstMessage: (s.firstMessage || "").slice(0, 100),
        modified: s.modified?.toISOString?.() || s.modified || null,
        messageCount: s.messageCount || 0,
        cwd: s.cwd || null,
        agentId: s.agentId || null,
        agentName: s.agentName || null,
        projectId: s.projectId || null,
        modelId: s.modelId || null,
        modelProvider: s.modelProvider || null,
        workspaceMountId: s.workspaceMountId || null,
        workspaceLabel: s.workspaceLabel || null,
        pinnedAt: s.pinnedAt || null,
        pinOrder: Number.isFinite(s.pinOrder) ? s.pinOrder : null,
        agentDeleted: s.agentDeleted === true,
        readOnlyReason: s.readOnlyReason || (s.agentDeleted === true ? "agent_deleted" : null),
        continuationAvailable: s.continuationAvailable === true,
        deletedAt: s.deletedAt || null,
        matchKind: s.matchKind,
        snippet: s.snippet || "",
        score: s.score,
      }));
      return c.json({ query, phase, results });
    } catch (err) {
      if (err instanceof SessionSearchTokenizerUnavailableError) {
        log.error(`session search tokenizer unavailable: ${err.cause || err}`);
        return c.json({ error: err.message }, 503);
      }
      return c.json({ error: err.message }, 500);
    }
  });

  route.get("/sessions/find", async (c) => {
    try {
      const requestContext = createRequestContext(c, engine);
      const querySessionId = c.req.query("sessionId") || null;
      let queryPath = c.req.query("path") || null;
      if (typeof querySessionId === "string" && querySessionId.trim()) {
        const manifest = engine.getSessionManifest?.(querySessionId.trim()) || null;
        if (!manifest?.currentLocator?.path) {
          return c.json({ error: "Session manifest not found", code: "session_manifest_not_found" }, 404);
        }
        queryPath = manifest.currentLocator.path;
      }
      // 定位语义要求显式目标：禁止回退 engine.currentSessionPath（全局焦点指针）。
      if (!queryPath) return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      if (!isValidSessionPath(queryPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      const auth = authorizeSessionRoute(requestContext, "sessions.read", {
        kind: "session",
        studioId: requestContext.studioId,
        sessionPath: queryPath,
      });
      if (!auth.allowed) return c.json({ error: "insufficient_scope", reason: auth.reason }, 403);

      const query = (c.req.query("q") || "").trim();
      if (!query) {
        return c.json({ query, total: 0, bestIndex: null, tokens: [], matches: [], truncated: false });
      }
      if ([...query].length > SESSION_SEARCH_QUERY_MAX_LENGTH) {
        return c.json({ error: "query_too_long", maxLength: SESSION_SEARCH_QUERY_MAX_LENGTH }, 400);
      }

      // 修订点必须在读取内容之前取（同 messages 路由）：读取期间若有新写入，
      // revision 只会偏旧，下次请求会重新解析，不会把没读到的写入标成已同步。
      const revision = await readSessionFileRevision(queryPath);
      const cached = findEntriesCache.get(queryPath);
      let entries;
      if (revision && cached && cached.revision === revision) {
        entries = cached.entries;
      } else {
        const sourceMessages = await loadSessionHistoryMessages(engine, queryPath);
        const sanitize = (value) => {
          const withoutReminder = stripSessionReminderBlocks(value);
          return isBridgeSessionPath(queryPath)
            ? sanitizeBridgeVisibleText(withoutReminder)
            : withoutReminder;
        };
        entries = collectFindableHistoryEntries(sourceMessages, sanitize);
        if (revision) {
          findEntriesCache.set(queryPath, { revision, entries });
          if (findEntriesCache.size > FIND_ENTRIES_CACHE_MAX) {
            findEntriesCache.delete(findEntriesCache.keys().next().value);
          }
        }
      }
      const result = findInSessionMessages(entries, query);
      return c.json({ query, revision, ...result });
    } catch (err) {
      if (err instanceof SessionSearchTokenizerUnavailableError) {
        log.error(`session find tokenizer unavailable: ${err.cause || err}`);
        return c.json({ error: err.message }, 503);
      }
      return c.json({ error: err.message }, 500);
    }
  });

  // 获取单个 session 的滚动摘要。列表只暴露 hasSummary，正文按需读取。
  route.get("/sessions/summary", async (c) => {
    try {
      const requestContext = createRequestContext(c, engine);
      const sessionPath = c.req.query("path") || null;
      if (!sessionPath) {
        return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      }
      if (!isValidSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      const auth = authorizeSessionRoute(requestContext, "sessions.read", {
        kind: "session",
        studioId: requestContext.studioId,
        sessionPath,
      });
      if (!auth.allowed) return c.json({ error: "insufficient_scope", reason: auth.reason }, 403);

      const record = getSessionSummaryRecord(sessionPath);
      return c.json(serializeSessionSummaryRecord(record));
    } catch (err) {
      return c.json({ error: err.message }, err.status || 500);
    }
  });

  // 置顶 / 取消置顶 session
  route.post("/sessions/pin", async (c) => {
    try {
      const requestContext = createRequestContext(c, engine);
      const body = await safeJson(c);
      const { pinned } = body;
      const sessionRef = resolveSessionLocatorFromBody(body, "setSessionPinned");
      const { sessionId, sessionPath } = sessionRef;
      if (typeof pinned !== "boolean") {
        return c.json({ error: t("error.missingParam", { param: "pinned" }) }, 400);
      }
      if (!isValidSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      if (isDeletedAgentSessionPath(sessionPath) && pinned === true) {
        return rejectDeletedAgentSession(c);
      }
      const auth = authorizeSessionRoute(requestContext, "sessions.write", {
        kind: "session",
        studioId: requestContext.studioId,
        sessionPath,
      });
      if (!auth.allowed) return c.json({ error: "insufficient_scope", reason: auth.reason }, 403);
      const { pinnedAt, pinOrder } = await engine.setSessionPinned({
        ...(sessionId ? { sessionId } : {}),
        sessionPath,
      }, pinned);
      return c.json({
        ok: true,
        pinnedAt,
        pinOrder: Number.isFinite(pinOrder) ? pinOrder : null,
        sessionId: sessionId || engine.getSessionIdForPath?.(sessionPath) || null,
      });
    } catch (err) {
      return c.json(bodyFromRouteError(err), statusFromRouteError(err));
    }
  });

  // 重排置顶区：提交完整有序的 sessionId 列表，服务端整体重新编号
  route.post("/sessions/pin-order", async (c) => {
    try {
      const requestContext = createRequestContext(c, engine);
      const body = await safeJson(c);
      const rawSessionIds = Array.isArray(body?.sessionIds) ? body.sessionIds : null;
      if (!rawSessionIds || rawSessionIds.length === 0) {
        return c.json({ error: t("error.missingParam", { param: "sessionIds" }) }, 400);
      }

      const refs = [];
      const seen = new Set();
      for (const rawSessionId of rawSessionIds) {
        const sessionId = normalizeRequestSessionId(rawSessionId);
        if (!sessionId) {
          return c.json({ error: t("error.missingParam", { param: "sessionIds" }) }, 400);
        }
        if (seen.has(sessionId)) {
          return c.json({
            error: `setSessionPinOrder: duplicate session ${sessionId}`,
            code: "session_pin_order_duplicate",
            sessionId,
          }, 400);
        }
        seen.add(sessionId);
        // 每个 session 都独立解析定位并鉴权：一次请求跨多个 session，
        // 授权不能只看列表里的第一个。
        const sessionRef = resolveSessionLocatorFromBody({ sessionId }, "setSessionPinOrder");
        if (!isValidSessionPath(sessionRef.sessionPath, engine.agentsDir)) {
          return c.json({ error: "Invalid session path" }, 403);
        }
        const auth = authorizeSessionRoute(requestContext, "sessions.write", {
          kind: "session",
          studioId: requestContext.studioId,
          sessionPath: sessionRef.sessionPath,
        });
        if (!auth.allowed) return c.json({ error: "insufficient_scope", reason: auth.reason }, 403);
        refs.push({ sessionId: sessionRef.sessionId });
      }

      const orders = await engine.setSessionPinOrder(refs);
      return c.json({ ok: true, orders });
    } catch (err) {
      return c.json(bodyFromRouteError(err), statusFromRouteError(err));
    }
  });

  route.get("/sessions/authorized-folders", async (c) => {
    try {
      const requestContext = createRequestContext(c, engine);
      const sessionPath = c.req.query("path") || engine.currentSessionPath || null;
      if (!sessionPath) {
        return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      }
      const auth = authorizeSessionRoute(requestContext, "sessions.read", {
        kind: "session",
        studioId: requestContext.studioId,
        sessionPath,
      });
      if (!auth.allowed) return c.json({ error: "insufficient_scope", reason: auth.reason }, 403);
      if (!isActiveDesktopSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      if (isDeletedAgentSessionPath(sessionPath)) {
        return rejectDeletedAgentSession(c);
      }
      if (!(await pathExists(sessionPath))) {
        return c.json({ error: "session not found" }, 404);
      }
      return c.json(sessionFolderScopeResponse(engine.getSessionFolderScope?.(sessionPath)));
    } catch (err) {
      return c.json({ error: err.message, code: err.code || undefined }, err.status || 500);
    }
  });

  route.patch("/sessions/authorized-folders", async (c) => {
    try {
      const requestContext = createRequestContext(c, engine);
      const body = await safeJson(c);
      const sessionPath = body?.path || body?.sessionPath || null;
      if (!sessionPath) {
        return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      }
      const auth = authorizeSessionRoute(requestContext, "sessions.write", {
        kind: "session",
        studioId: requestContext.studioId,
        sessionPath,
      });
      if (!auth.allowed) return c.json({ error: "insufficient_scope", reason: auth.reason }, 403);
      if (!isActiveDesktopSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      if (isDeletedAgentSessionPath(sessionPath)) {
        return rejectDeletedAgentSession(c);
      }
      if (!(await pathExists(sessionPath))) {
        return c.json({ error: "session not found" }, 404);
      }

      const action = typeof body?.action === "string" ? body.action.trim() : "set";
      let scope;
      if (action === "add") {
        const folder = await validateAuthorizedFolder(body?.folder);
        scope = await engine.addSessionAuthorizedFolder?.(sessionPath, folder);
      } else if (action === "remove") {
        const folder = normalizeAuthorizedFolderPath(body?.folder);
        scope = await engine.removeSessionAuthorizedFolder?.(sessionPath, folder);
      } else if (action === "set") {
        const folders = Array.isArray(body?.folders) ? body.folders : [];
        const normalizedFolders = [];
        for (const folder of folders) {
          normalizedFolders.push(await validateAuthorizedFolder(folder));
        }
        scope = await engine.setSessionAuthorizedFolders?.(sessionPath, normalizedFolders);
      } else {
        return c.json({ error: "Invalid action" }, 400);
      }
      return c.json(sessionFolderScopeResponse(scope || engine.getSessionFolderScope?.(sessionPath)));
    } catch (err) {
      const message = err.message || String(err);
      if (/folder (is required|does not exist|must be a directory)/.test(message)) {
        return c.json({ error: message }, 400);
      }
      return c.json({ error: message }, 500);
    }
  });

  // 获取 session 的消息（支持 ?path= 指定 session，否则读焦点 session）
  route.get("/sessions/messages", async (c) => {
    try {
      const requestContext = createRequestContext(c, engine);
      const querySessionId = c.req.query("sessionId") || null;
      let queryPath = c.req.query("path") || null;
      if (typeof querySessionId === "string" && querySessionId.trim()) {
        const manifest = engine.getSessionManifest?.(querySessionId.trim()) || null;
        if (!manifest?.currentLocator?.path) {
          return c.json({ error: "Session manifest not found", code: "session_manifest_not_found" }, 404);
        }
        queryPath = manifest.currentLocator.path;
      }
      if (queryPath && !isValidSessionPath(queryPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      const auth = authorizeSessionRoute(requestContext, "sessions.read", {
        kind: "session",
        studioId: requestContext.studioId,
        sessionPath: queryPath || engine.currentSessionPath || null,
      });
      if (!auth.allowed) return c.json({ error: "insufficient_scope", reason: auth.reason }, 403);
      const resolvedSessionPath = queryPath || engine.currentSessionPath || null;
      // 修订点必须在读取内容之前取：读取期间若有新写入，revision 只会偏旧
      // （前端下次触发时多补拉一次，方向安全），不会偏新（把没读到的写入
      // 标成「已同步」会让 /rc 消息永久漏掉，issue #1610 的反方向竞态）。
      const revision = await readSessionFileRevision(resolvedSessionPath);
      const sourceMessages = await loadSessionHistoryMessages(engine, resolvedSessionPath);
      // annotateOriginMessages 会把 origin custom 条目从数组里摘掉、把 origin/displayText
      // 并进其后第一条 user 消息。下面的主展示循环大量以 sourceIndex 回查
      // sourceMessages[sourceIndex]（nextImmediateDisplayableAssistantIndex、
      // recordDeferredInterlude 等），如果直接把循环换成过滤后的短数组，sourceIndex
      // 会和 sourceMessages 错位，静默污染 deferred/subagent 块的归属。这里改用
      // zip 只取 annotateOriginMessages 的注释结果、映射回原始下标，循环本身仍遍历
      // 原始 sourceMessages，不破坏既有 sourceIndex 语义。
      const originBySourceIndex = new Map();
      {
        const annotatedMessages = annotateOriginMessages(sourceMessages);
        let annotatedIdx = 0;
        for (let i = 0; i < sourceMessages.length; i += 1) {
          const original = sourceMessages[i];
          if (original?.role === "custom" && (
            original.customType === MESSAGE_ORIGIN_RECORD_TYPE
            || original.customType === AGENT_REVIEW_RECORD_TYPE
            || original.customType === MESSAGE_PRESENTATION_RECORD_TYPE
          )) continue;
          const annotated = annotatedMessages[annotatedIdx];
          annotatedIdx += 1;
          if (original?.role === "user" && annotated?.origin) {
            originBySourceIndex.set(i, {
              origin: annotated.origin,
              ...(typeof annotated.displayText === "string" ? { displayText: annotated.displayText } : {}),
            });
          }
        }
      }
      const presentationBySourceIndex = new Map();
      {
        let pendingPresentation = null;
        for (let i = 0; i < sourceMessages.length; i += 1) {
          const message = sourceMessages[i];
          if (message?.role === "custom" && message.customType === MESSAGE_PRESENTATION_RECORD_TYPE) {
            pendingPresentation = message.data || null;
            continue;
          }
          if (message?.role === "user") {
            if (pendingPresentation) presentationBySourceIndex.set(i, pendingPresentation);
            pendingPresentation = null;
          }
        }
      }
      const agentReviewBySourceIndex = new Map();
      {
        let pendingReview = null;
        for (let i = 0; i < sourceMessages.length; i += 1) {
          const message = sourceMessages[i];
          if (message?.role === "custom" && message.customType === AGENT_REVIEW_RECORD_TYPE) {
            pendingReview = message.data || null;
            continue;
          }
          if (message?.role === "user") {
            if (pendingReview?.status === "completed") agentReviewBySourceIndex.set(i, pendingReview);
            pendingReview = null;
          }
        }
      }
      const sanitizeVisibleContent = (value) => {
        const withoutReminder = stripSessionReminderBlocks(value);
        return isBridgeSessionPath(resolvedSessionPath)
          ? sanitizeBridgeVisibleText(withoutReminder)
          : withoutReminder;
      };

      // 分页参数
      const beforeId = c.req.query("before") != null ? Number(c.req.query("before")) : null;
      const limit = Math.min(Number(c.req.query("limit")) || 50, 200);

      // all=1 强制全量返回（流式恢复等特殊场景）
      const forceAll = c.req.query("all") === "1";
      const pageBounds = resolveHistoryPageBounds(sourceMessages, { beforeId, limit, forceAll });

      // 提取可显示的消息（user/assistant 文本 + 文件/artifact 工具结果）。
      // 长会话只完整 hydrate 当前页面窗口；窗口外只做轻量可见性扫描，
      // 避免旧消息的 markdown/block/sidecar 解析拖慢当前模型运行。
      const messages = [];
      const blocks = [];
      const mediaGenerationResults = new Map();
      const standaloneMediaGenerationResults = [];
      const deferredInterludeDeliveryIds = new Set();
      const turnInputConsumptionDeliveryIds = new Set();
      const turnInputConsumptionEntryIds = new Set();
      const turnInputByAssistantEntryId = new Map<string, string>();
      const sourceIndexByEntryId = new Map<string, number>();
      const displayIndexByEntryId = new Map<string, number>();
      const deferredStore = engine.deferredResults;
      const receiverName = resolveDeferredReceiverName(engine, resolvedSessionPath);
      // 草稿卡确认状态持久化（灰测修复 C）：决策 custom 消息本身 display:false
      // 不会进展示（与 origin 记录同理），只用来覆盖后面 toolResult 分支产出的
      // suggestion_card block 的 status，让重开 session 不再回弹 pending。
      const sessionCollabDecisions = collectSessionCollabDecisions(sourceMessages);
      const toolOutcomesByCallId = collectToolOutcomesByCallId(sourceMessages);
      let projectedDisplayIndex = 0;
      for (let sourceIndex = 0; sourceIndex < sourceMessages.length; sourceIndex += 1) {
        const message = sourceMessages[sourceIndex];
        const entryId = typeof message?.id === "string" && message.id.trim() ? message.id.trim() : null;
        if (entryId) sourceIndexByEntryId.set(entryId, sourceIndex);
        if (
          (message?.role === "user" || message?.role === "assistant")
          && isDisplayableHistoryMessage(message)
        ) {
          if (entryId) displayIndexByEntryId.set(entryId, projectedDisplayIndex);
          projectedDisplayIndex += 1;
        }
      }
      for (const message of sourceMessages) {
        if (message?.role !== "custom" || message.customType !== TURN_INPUT_CONSUMPTION_EVENT_TYPE) continue;
        const parsed = parseTurnInputConsumptionRecord(message.data);
        const deliveryId = typeof parsed?.deliveryId === "string" && parsed.deliveryId.trim()
          ? parsed.deliveryId.trim()
          : null;
        const entryId = typeof parsed?.input?.entryId === "string" && parsed.input.entryId.trim()
          ? parsed.input.entryId.trim()
          : null;
        const assistantEntryId = typeof parsed?.assistant?.entryId === "string" && parsed.assistant.entryId.trim()
          ? parsed.assistant.entryId.trim()
          : null;
        if (deliveryId) turnInputConsumptionDeliveryIds.add(deliveryId);
        if (entryId) turnInputConsumptionEntryIds.add(entryId);
        if (assistantEntryId && entryId) turnInputByAssistantEntryId.set(assistantEntryId, entryId);
      }
      const recordMediaGenerationResult = (parsed, afterIndex, sourceIndex = null) => {
        if (!parsed?.taskId || !isMediaGenerationDeferredResult(parsed)) return;
        mediaGenerationResults.set(parsed.taskId, parsed);
        if (parsed.status === "success") {
          standaloneMediaGenerationResults.push({
            ...parsed,
            afterIndex,
            ...(Number.isInteger(sourceIndex) ? { sourceIndex } : {}),
          });
        }
      };
      const recordTurnInputConsumptionInterlude = (message, afterIndex, sourceIndex = null) => {
        const parsed = parseTurnInputConsumptionRecord(message?.data);
        const block = parsed?.block;
        if (!block || block.type !== "interlude") return;
        const assistantEntryId = typeof parsed?.assistant?.entryId === "string" && parsed.assistant.entryId.trim()
          ? parsed.assistant.entryId.trim()
          : null;
        const inputEntryId = typeof parsed?.input?.entryId === "string" && parsed.input.entryId.trim()
          ? parsed.input.entryId.trim()
          : null;
        const assistantDisplayIndex = assistantEntryId
          ? displayIndexByEntryId.get(assistantEntryId)
          : undefined;
        const anchoredAfterIndex = Number.isInteger(assistantDisplayIndex)
          ? Math.max(0, assistantDisplayIndex - 1)
          : afterIndex;
        if (!Number.isInteger(anchoredAfterIndex) || anchoredAfterIndex < 0) return;
        const inputSourceIndex = inputEntryId ? sourceIndexByEntryId.get(inputEntryId) : undefined;
        const anchoredSourceIndex = Number.isInteger(inputSourceIndex) ? inputSourceIndex : sourceIndex;
        const normalizedDeliveryId = typeof parsed.deliveryId === "string" && parsed.deliveryId.trim()
          ? parsed.deliveryId.trim()
          : null;
        if (normalizedDeliveryId && deferredInterludeDeliveryIds.has(normalizedDeliveryId)) return;
        blocks.push({
          ...block,
          ...(normalizedDeliveryId ? { deliveryId: normalizedDeliveryId } : {}),
          afterIndex: anchoredAfterIndex,
          ...(Number.isInteger(anchoredSourceIndex) ? { sourceIndex: anchoredSourceIndex } : {}),
        });
        if (normalizedDeliveryId) deferredInterludeDeliveryIds.add(normalizedDeliveryId);
      };
      const recordTurnInputPresentationInterlude = (message, afterIndex, sourceIndex = null) => {
        if (!Number.isInteger(afterIndex) || afterIndex < 0) return;
        const parsed = parseTurnInputPresentationRecord(message?.data);
        const block = parsed?.block;
        if (!block || block.type !== "interlude") return;
        const normalizedDeliveryId = typeof parsed.deliveryId === "string" && parsed.deliveryId.trim()
          ? parsed.deliveryId.trim()
          : null;
        if (normalizedDeliveryId && deferredInterludeDeliveryIds.has(normalizedDeliveryId)) return;
        blocks.push({
          ...block,
          ...(normalizedDeliveryId ? { deliveryId: normalizedDeliveryId } : {}),
          afterIndex,
          ...(Number.isInteger(sourceIndex) ? { sourceIndex } : {}),
        });
        if (normalizedDeliveryId) deferredInterludeDeliveryIds.add(normalizedDeliveryId);
      };
      const recordDeferredInterlude = (parsed, afterIndex, deliveryId = null, sourceIndex = null) => {
        if (!parsed?.taskId || !Number.isInteger(afterIndex) || afterIndex < 0) return;
        const normalizedDeliveryId = typeof deliveryId === "string" && deliveryId.trim() ? deliveryId.trim() : null;
        const sourceMessage = Number.isInteger(sourceIndex) ? sourceMessages[sourceIndex] : null;
        const sourceEntryId = typeof sourceMessage?.id === "string" && sourceMessage.id.trim()
          ? sourceMessage.id.trim()
          : null;
        if (normalizedDeliveryId && turnInputConsumptionDeliveryIds.has(normalizedDeliveryId)) return;
        if (sourceEntryId && turnInputConsumptionEntryIds.has(sourceEntryId)) return;
        if (normalizedDeliveryId && deferredInterludeDeliveryIds.has(normalizedDeliveryId)) return;
        const task = deferredStore?.query?.(parsed.taskId) || null;
        const run = engine.subagentRuns?.query?.(parsed.taskId) || null;
        const runTask = taskFromSubagentRun(run);
        const metadataTask = mergeSubagentTaskMetadata(runTask, task);
        const metadataMeta = metadataTask?.meta || {};
        const meta = {
          ...metadataMeta,
          type: parsed.type || metadataMeta.type || task?.meta?.type || "background-task",
        };
        const event = {
          taskId: parsed.taskId,
          deliveryId: normalizedDeliveryId,
          status: parsed.status === "failed" || parsed.status === "aborted" ? parsed.status : "success",
          result: Object.prototype.hasOwnProperty.call(parsed, "result") ? parsed.result : metadataTask?.result,
          reason: parsed.reason || metadataTask?.reason || null,
          meta,
        };
        const block = buildDeferredResultInterludeBlock(event, { receiverName });
        if (!block) return;
        blocks.push({
          ...block,
          afterIndex,
          ...(Number.isInteger(sourceIndex) ? { sourceIndex } : {}),
        });
        if (normalizedDeliveryId) deferredInterludeDeliveryIds.add(normalizedDeliveryId);
      };
      let displayIdx = 0;
      let latestTurnInputEntryId: string | null = null;
      let latestTurnInputVisible = false;

      for (let sourceIndex = 0; sourceIndex < sourceMessages.length; sourceIndex += 1) {
        const m = sourceMessages[sourceIndex];
        if (m.role === "user") {
          latestTurnInputEntryId = typeof m.id === "string" && m.id.trim() ? m.id.trim() : null;
          latestTurnInputVisible = !isHiddenTurnInputMessage(m);
          if (!isDisplayableHistoryMessage(m)) continue;
          const currentIndex = displayIdx;
          displayIdx += 1;
          if (currentIndex >= pageBounds.startIdx && currentIndex < pageBounds.endIdx) {
            const { text, images } = extractTextContent(m.content);
            const visibleImages = filterUnreferencedInlineImages(text, images);
            const content = sanitizeVisibleContent(text);
            const originInfo = originBySourceIndex.get(sourceIndex);
            const agentReview = agentReviewBySourceIndex.get(sourceIndex);
            const presentation = presentationBySourceIndex.get(sourceIndex);
            messages.push({
              id: String(currentIndex),
              sourceIndex,
              ...(m.id ? { entryId: m.id } : {}),
              role: "user",
              content,
              images: visibleImages.length ? visibleImages : undefined,
              ...(m.timestamp ? { timestamp: m.timestamp } : {}),
              ...(originInfo?.origin ? { origin: originInfo.origin } : {}),
              ...(typeof originInfo?.displayText === "string" ? { displayText: originInfo.displayText } : {}),
              ...(agentReview ? { agentReview } : {}),
              ...(typeof agentReview?.displayText === "string" ? { displayText: agentReview.displayText } : {}),
              ...(typeof presentation?.displayText === "string" ? { displayText: presentation.displayText } : {}),
              ...(Array.isArray(presentation?.sessionRefs) ? { sessionRefs: presentation.sessionRefs } : {}),
              ...(Array.isArray(presentation?.agentMentions) ? { agentMentions: presentation.agentMentions } : {}),
              ...(presentation?.agentReviewRequest ? { agentReviewRequest: presentation.agentReviewRequest } : {}),
            });
          }
        } else if (m.role === "assistant") {
          if (!isDisplayableHistoryMessage(m)) continue;
          const assistantEntryId = typeof m.id === "string" && m.id.trim() ? m.id.trim() : null;
          const consumedTurnInputEntryId = assistantEntryId
            ? turnInputByAssistantEntryId.get(assistantEntryId) || null
            : null;
          const turnInputEntryId = consumedTurnInputEntryId || latestTurnInputEntryId;
          const turnInputVisible = consumedTurnInputEntryId ? false : latestTurnInputVisible;
          const currentIndex = displayIdx;
          displayIdx += 1;
          if (currentIndex >= pageBounds.startIdx && currentIndex < pageBounds.endIdx) {
            const { text, thinking, toolUses } = extractTextContent(m.content, { stripThink: true });
            const content = sanitizeVisibleContent(text);
            const projectedToolUses = toolUses.map((toolUse) => {
              const outcome = toolUse.id ? toolOutcomesByCallId.get(toolUse.id) : null;
              return {
                ...toolUse,
                ...(outcome || { status: "unknown", success: false }),
              };
            });
            messages.push({
              id: String(currentIndex),
              sourceIndex,
              ...(m.id ? { entryId: m.id } : {}),
              role: "assistant",
              content,
              ...(turnInputEntryId ? { turnInputEntryId, turnInputVisible } : {}),
              ...(contentHasThinkingBlock(m.content, { stripThink: true }) ? { thinking } : {}),
              toolCalls: projectedToolUses.length ? projectedToolUses : undefined,
              ...(m.timestamp ? { timestamp: m.timestamp } : {}),
            });
          }
        } else if (m.role === "toolResult") {
          const afterIndex = displayIdx - 1;
          if (afterIndex >= pageBounds.startIdx && afterIndex < pageBounds.endIdx) {
            const extracted = extractBlocks(m.toolName, m.details, m);
            for (const b of extracted) {
              const overlaid = overlaySessionCollabDecision(b, sessionCollabDecisions);
              blocks.push({ ...overlaid, afterIndex, sourceIndex });
            }
          }
        } else if (m.role === "custom") {
          if (isCustomTurnInputHistoryMessage(m)) {
            latestTurnInputEntryId = typeof m.id === "string" && m.id.trim() ? m.id.trim() : null;
            latestTurnInputVisible = false;
          }
          const afterIndex = displayIdx - 1;
          if (m.display !== false && afterIndex >= pageBounds.startIdx && afterIndex < pageBounds.endIdx) {
            const extracted = extractBlocks(m.customType, m.details, m);
            for (const b of extracted) {
              blocks.push({ ...b, afterIndex, sourceIndex });
            }
          }
          const parsed = parseHistoryDeferredResult(m);
          recordMediaGenerationResult(parsed, afterIndex, sourceIndex);
          if (m.customType === TURN_INPUT_CONSUMPTION_EVENT_TYPE) {
            recordTurnInputConsumptionInterlude(m, afterIndex, sourceIndex);
          }
          if (m.customType === TURN_INPUT_PRESENTATION_EVENT_TYPE) {
            recordTurnInputPresentationInterlude(m, afterIndex, sourceIndex);
          }
          if (m.customType === DEFERRED_RESULT_MESSAGE_TYPE) {
            const nextAssistantIndex = nextImmediateDisplayableAssistantIndex(sourceMessages, sourceIndex, displayIdx);
            recordDeferredInterlude(
              parsed,
              nextAssistantIndex == null ? null : nextAssistantIndex - 1,
              historyDeferredDeliveryId(m, sourceIndex),
              sourceIndex,
            );
          }
        }
      }

      if (resolvedSessionPath && typeof deferredStore?.listBySession === "function") {
        for (const task of deferredStore.listBySession(resolvedSessionPath)) {
          if (!isTerminalDeferredTask(task)) continue;
          const parsed = buildDeferredResultRecord(task.taskId, task);
          recordMediaGenerationResult(parsed, pageBounds.total - 1);
          recordDeferredInterlude(parsed, null);
        }
      }
      const resolvedBlocks = normalizePluginChatSurfaceBlocks(
        dropUninstalledPluginCards(
          resolveMediaGenerationBlocks(
            blocks,
            mediaGenerationResults,
            standaloneMediaGenerationResults,
          ),
          pluginInstalledPredicate(engine),
        ),
        engine,
      );

      // 重映射 afterIndex 到切片内偏移，过滤超出范围的
      const slicedBlocks = forceAll
        ? resolvedBlocks
        : resolvedBlocks
          .filter(b => b.afterIndex >= pageBounds.startIdx && b.afterIndex < pageBounds.endIdx)
          .map(b => ({ ...b, afterIndex: b.afterIndex - pageBounds.startIdx }));
      const hasMore = pageBounds.hasMore;

      // 修正 subagent blocks 的状态：优先从 durable run registry 读长期映射，
      // 再用 deferred store 作为实时投递队列。deferred 会清理，不再承担历史事实源。
      {
        const deferredStore = engine.deferredResults;
        const runStore = engine.subagentRuns;
        const readSessionMeta = createSubagentMetaCache();
        const readSessionSummary = createSubagentSummaryCache();
        for (const b of slicedBlocks) {
          if (b.type !== "subagent" || !b.taskId) continue;
          const task = deferredStore?.query?.(b.taskId) || null;
          const run = runStore?.query?.(b.taskId) || null;
          const runTask = taskFromSubagentRun(run);
          const metadataTask = mergeSubagentTaskMetadata(runTask, task);
          const durableSessionId = run?.childSessionId || null;
          const durableSessionPath = run?.childSessionPath || null;
          const deferredSessionId = task?.meta?.sessionId || null;
          const deferredSessionPath = task?.meta?.sessionPath || null;
          if (!b.sessionId && durableSessionId) b.sessionId = durableSessionId;
          if (!b.sessionId && deferredSessionId) b.sessionId = deferredSessionId;
          if (!b.streamKey && durableSessionPath) b.streamKey = durableSessionPath;
          if (!b.streamKey && deferredSessionPath) b.streamKey = deferredSessionPath;
          {
            const sessionRef = resolveSubagentBlockSession(b, metadataTask, run);
            if (sessionRef.sessionId && !b.sessionId) b.sessionId = sessionRef.sessionId;
            if (sessionRef.sessionPath) b.streamKey = sessionRef.sessionPath;
          }
          patchBlockRequestedMetadata(b, metadataTask);
          patchBlockExecutorMetadata(b, metadataTask, readSessionMeta);
          applySubagentIdentity(b, metadataTask, readSessionMeta);

          if (b.streamStatus !== "running") continue;

          const terminalTask = run && run.status !== "pending" ? runTask : task;

          // subagent 完成状态只能由 durable run registry 或 deferred store 的任务终态确认。
          // 子 session 可能有多轮输出，尾部 assistant 文本只能作为 resolved 后的摘要来源。
          if (terminalTask?.status === "aborted") {
            b.streamStatus = "aborted";
            b.summary = terminalTask.reason || "aborted";
            if (terminalTask.meta?.sessionPath) b.streamKey = terminalTask.meta.sessionPath;
            patchBlockRequestedMetadata(b, terminalTask);
            patchBlockExecutorMetadata(b, terminalTask, readSessionMeta);
            applySubagentIdentity(b, terminalTask, readSessionMeta);
            continue;
          }
          if (terminalTask?.status === "failed") {
            b.streamStatus = "failed";
            b.summary = terminalTask.reason || "failed";
            if (terminalTask.meta?.sessionPath) b.streamKey = terminalTask.meta.sessionPath;
            patchBlockRequestedMetadata(b, terminalTask);
            patchBlockExecutorMetadata(b, terminalTask, readSessionMeta);
            applySubagentIdentity(b, terminalTask, readSessionMeta);
            continue;
          }
          if (terminalTask?.status === "resolved") {
            b.streamStatus = "done";
            if (terminalTask.meta?.sessionPath) b.streamKey = terminalTask.meta.sessionPath;
            patchBlockRequestedMetadata(b, terminalTask);
            patchBlockExecutorMetadata(b, terminalTask, readSessionMeta);
            applySubagentIdentity(b, terminalTask, readSessionMeta);

            const sp = b.streamKey || terminalTask.meta?.sessionPath || null;
            const summary = await readSessionSummary(sp);
            b.summary = summary || (typeof terminalTask.result === "string" ? terminalTask.result.slice(0, 200) : b.summary);
            continue;
          }

          if (run?.status === "pending" && !task) {
            b.streamStatus = "failed";
            b.summary = t("session.subagentRunStateUnrecoverable");
            continue;
          }

          if (!b.streamKey && !run && !task) {
            b.streamStatus = "failed";
            b.summary = t("session.subagentLinkUnrecoverable");
          }
        }
      }

      // workflow inline 概览块回填：block_update patch 是前端瞬时事件、未持久化进 toolResult details，
      // 重启后块保留派单时的 streamStatus:"running" + startedAt，会显示离谱「已运行 Xm」时长。
      // 从 durable runStore 读终态修正，并用 completedAt 补 finishedAt（inline 卡算总时长用）。
      {
        const wfRunStore = engine.subagentRuns;
        const wfDeferredStore = engine.deferredResults;
        for (const b of slicedBlocks) {
          if (b.type !== "workflow" || !b.taskId) continue;
          if (b.streamStatus !== "running") continue;
          const run = wfRunStore?.query?.(b.taskId) || null;
          const task = wfDeferredStore?.query?.(b.taskId) || null;
          const status = run?.status || task?.status || null;
          if (status === "resolved" || status === "done") b.streamStatus = "done";
          else if (status === "failed") b.streamStatus = "failed";
          else if (status === "aborted") b.streamStatus = "aborted";
          else continue; // 仍 pending / 无记录：保持 running，不误判完成
          if (!b.finishedAt && run?.completedAt) {
            const ts = Date.parse(run.completedAt);
            if (Number.isFinite(ts)) b.finishedAt = ts;
          }
          if (!b.summary && typeof run?.summary === "string") b.summary = run.summary;
        }
      }

      patchSessionFileLifecycleBlocks(slicedBlocks, engine, resolvedSessionPath);
      const sessionFiles = listSessionRegistryFiles(engine, resolvedSessionPath, sourceMessages);

      // 从历史中提取最新 todo 状态：branch-aware，沿当前 leaf 回溯到 root，
      // 只在当前分支路径上找最新合法快照。避免从抛弃的分支取到错误状态。
      const todos = extractLatestTodos(sourceMessages);

      // 重启后右侧 workflow 卡复原：ActivityHub 已从持久化背书回灌该会话的 workflow 活动，
      // 这里在「首屏载入」（非翻页）时重发一遍，让前端 agent-activity slice 重新填充。
      // 翻页（beforeId != null）不重发，避免重复广播。WS 是全局广播、前端按 sessionPath 入库。
      if (beforeId == null && resolvedSessionPath) {
        engine.activityHub?.rebroadcastSession?.(resolvedSessionPath);
      }

      return c.json({ messages, blocks: slicedBlocks, todos, hasMore, sessionFiles, revision });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  route.post("/sessions/latest-user-message/replay", async (c) => {
    try {
      const requestContext = createRequestContext(c, engine);
      const body = await safeJson(c);
      const sessionPath = body?.path || body?.sessionPath || null;
      if (!sessionPath) {
        return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      }
      const auth = authorizeSessionRoute(requestContext, "sessions.write", {
        kind: "session",
        studioId: requestContext.studioId,
        sessionPath,
      });
      if (!auth.allowed) return c.json({ error: "insufficient_scope", reason: auth.reason }, 403);
      if (!isActiveDesktopSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      if (isDeletedAgentSessionPath(sessionPath)) {
        return rejectDeletedAgentSession(c);
      }
      if (!(await pathExists(sessionPath))) {
        return c.json({ error: "session not found" }, 404);
      }
      if (engine.isSessionStreaming?.(sessionPath)) {
        return c.json({ error: "session_busy" }, 409);
      }

      const result = await replayLatestUserTurn(engine, {
        sessionPath,
        sourceEntryId: body.sourceEntryId || null,
        clientMessageId: body.clientMessageId || null,
        replacementText: typeof body.text === "string" ? body.text : undefined,
        displayMessage: body.displayMessage || null,
        uiContext: body.uiContext ?? null,
      });
      return c.json({ ok: true, ...result });
    } catch (err) {
      const status = err.message === "session_busy" ? 409 : 400;
      return c.json({ error: err.message }, status);
    }
  });

  route.post("/sessions/turns/retry", async (c) => {
    try {
      const requestContext = createRequestContext(c, engine);
      const body = await safeJson(c);
      const sessionRef = resolveSessionLocatorFromBody(body, "retrySessionTurn");
      assertManifestLifecycle(sessionRef, "active", "retrySessionTurn");
      const { sessionId, sessionPath } = sessionRef;
      const auth = authorizeSessionRoute(requestContext, "sessions.write", {
        kind: "session",
        studioId: requestContext.studioId,
        sessionPath,
      });
      if (!auth.allowed) return c.json({ error: "insufficient_scope", reason: auth.reason }, 403);
      if (!isActiveDesktopSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      if (isDeletedAgentSessionPath(sessionPath)) {
        return rejectDeletedAgentSession(c);
      }
      if (!(await pathExists(sessionPath))) {
        return c.json({ error: "session not found" }, 404);
      }
      if (engine.isSessionStreaming?.(sessionPath)) {
        return c.json({ error: "session_busy" }, 409);
      }

      const result = await retrySessionTurn(engine, {
        sessionId,
        sessionPath,
        target: body?.target,
        clientMessageId: body?.clientMessageId || null,
        replacementText: typeof body?.text === "string" ? body.text : undefined,
        displayMessage: body?.displayMessage || null,
        uiContext: body?.uiContext ?? null,
      });
      return c.json({ ok: true, ...result });
    } catch (err) {
      // 无码默认 400（重放失败绝大多数是请求本身的问题），session_busy 仍单独回 409。
      return c.json(
        bodyFromRouteError(err),
        statusFromRouteError(err, err?.message === "session_busy" ? 409 : 400),
      );
    }
  });

  route.post("/sessions/fork", async (c) => {
    try {
      const requestContext = createRequestContext(c, engine);
      const body = await safeJson(c);
      const sessionRef = resolveSessionLocatorFromBody(body, "forkSessionAtNode");
      assertManifestLifecycle(sessionRef, "active", "forkSessionAtNode");
      const { sessionId, sessionPath } = sessionRef;
      const auth = authorizeSessionRoute(requestContext, "sessions.write", {
        kind: "session",
        studioId: requestContext.studioId,
        sessionPath,
      });
      if (!auth.allowed) return c.json({ error: "insufficient_scope", reason: auth.reason }, 403);
      if (!isActiveDesktopSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      if (isDeletedAgentSessionPath(sessionPath)) {
        return rejectDeletedAgentSession(c);
      }
      if (!(await pathExists(sessionPath))) {
        return c.json({ error: "session not found" }, 404);
      }
      if (engine.isSessionStreaming?.(sessionPath)) {
        return c.json({ error: "session_busy" }, 409);
      }
      if (typeof engine.forkSessionAtNode !== "function") {
        throw routeError("session fork is unavailable", "session_fork_unavailable", 503);
      }

      const result = await engine.forkSessionAtNode({
        sessionId,
        sessionPath,
        target: body?.target,
      });
      const childPath = result?.sessionPath || result?.path || null;
      const childSessionId = result?.sessionId || (childPath ? engine.getSessionIdForPath?.(childPath) : null) || null;
      const permissionMode = result?.permissionMode || engine.getSessionPermissionMode?.(childPath) || "ask";
      const response = {
        ok: true,
        path: childPath,
        sessionPath: childPath,
        sessionId: childSessionId,
        agentId: result?.agentId || null,
        agentName: result?.agentName || engine.getAgent?.(result?.agentId)?.agentName || result?.agentId || null,
        cwd: result?.cwd || null,
        workspaceFolders: Array.isArray(result?.workspaceFolders) ? result.workspaceFolders : [],
        authorizedFolders: Array.isArray(result?.authorizedFolders) ? result.authorizedFolders : [],
        planMode: result?.planMode ?? permissionMode === "read_only",
        permissionMode,
        accessMode: result?.accessMode || (permissionMode === "read_only" ? "read_only" : "operate"),
        thinkingLevel: normalizeSessionThinkingLevel(result?.thinkingLevel),
        projectId: result?.projectId ?? null,
        workspaceMountId: result?.workspaceMountId || null,
        workspaceLabel: result?.workspaceLabel || null,
        sourceSessionId: result?.sourceSessionId || sessionId,
        forkedFromEntryId: result?.forkedFromEntryId || null,
        target: result?.target || body?.target || null,
        sessionFiles: result?.sessionFiles || { files: [], refs: [], fileIdMap: {} },
        visionNotes: result?.visionNotes || { notes: 0, keys: [] },
        memoryModelUnavailableReason: engine.memoryModelUnavailableReason || null,
      };
      hub?.eventBus?.emit?.({
        type: "session_created",
        session: response,
      }, childPath);
      return c.json(response);
    } catch (err) {
      // 无码默认 500（fork 失败多半是文件系统或引擎侧的问题），session_busy 仍单独回 409。
      return c.json(
        bodyFromRouteError(err),
        statusFromRouteError(err, err?.message === "session_busy" ? 409 : 500),
      );
    }
  });

  route.post("/sessions/todos/complete", async (c) => {
    try {
      const requestContext = createRequestContext(c, engine);
      const body = await safeJson(c);
      const sessionPath = body?.path;
      if (!sessionPath) {
        return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      }
      const auth = authorizeSessionRoute(requestContext, "sessions.write", {
        kind: "session",
        studioId: requestContext.studioId,
        sessionPath,
      });
      if (!auth.allowed) return c.json({ error: "insufficient_scope", reason: auth.reason }, 403);
      if (!isActiveDesktopSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      if (isDeletedAgentSessionPath(sessionPath)) {
        return rejectDeletedAgentSession(c);
      }
      try {
        await fs.access(sessionPath);
      } catch {
        return c.json({ error: t("error.sessionNotFound") }, 404);
      }
      if (engine.isSessionStreaming?.(sessionPath)) {
        return c.json({ error: "Cannot complete todos while session is streaming" }, 409);
      }

      const manager = getWritableSessionManager(engine, sessionPath);
      const snapshot = extractLatestTodoSnapshot(
        manager.buildSessionContext?.().messages || [],
      );
      const completedTodos = completeTodoItems(snapshot?.todos || []);
      if (!snapshot?.removed && completedTodos.length > 0) {
        manager.appendCustomMessageEntry(
          TODO_STATE_CUSTOM_TYPE,
          TODO_COMPLETE_MESSAGE,
          false,
          {
            action: "complete_all",
            source: "user",
            removed: true,
            todos: completedTodos,
          },
        );
        engine.syncSessionBranchHead?.(sessionPath, manager, "todo_complete_append");
      }

      engine.emitEvent?.({ type: "todo_update", todos: [] }, sessionPath);
      return c.json({ ok: true, todos: [] });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // 新建 session（可选指定工作目录和 agentId）
  route.post("/sessions/new", async (c) => {
    try {
      const requestContext = createRequestContext(c, engine);
      const auth = authorizeSessionRoute(requestContext, "sessions.write", {
        kind: "studio",
        studioId: requestContext.studioId,
      });
      if (!auth.allowed) return c.json({ error: "insufficient_scope", reason: auth.reason }, 403);
      const body = await safeJson(c);
      const { memoryEnabled, agentId, currentSessionPath: oldSessionPath, thinkingLevel } = body;
      const workspaceSelection = resolveSessionWorkspaceSelection(engine, requestContext, body);
      const cwd = workspaceSelection.cwd;
      const workspaceFolders = Array.isArray(body.workspaceFolders)
        ? body.workspaceFolders.filter(p => typeof p === "string" && p.trim())
        : [];
      const projectId = Object.prototype.hasOwnProperty.call(body, "projectId")
        ? (
            typeof engine.normalizeSessionProjectAssignmentId === "function"
              ? engine.normalizeSessionProjectAssignmentId(body.projectId)
              : (typeof body.projectId === "string" && body.projectId.trim() ? body.projectId.trim() : null)
          )
        : null;
      const memFlag = memoryEnabled !== false; // 默认 true
      log.log(`新建 session ${JSON.stringify({
        hasCwd: !!cwd,
        memoryEnabled: memFlag,
        customAgent: !!agentId,
      })}`);

      // 新建前挂起浏览器（保存当前 session 的浏览器状态）
      const bm = BrowserManager.instance();
      if (oldSessionPath && bm.isRunning(oldSessionPath)) {
        await bm.suspendForSession(oldSessionPath);
      }

      const createOptions: {
        workspaceFolders: any;
        visibleInSessionList: boolean;
        thinkingLevel?: any;
        workspaceMountId?: string;
        workspaceLabel?: string | null;
      } = { workspaceFolders, visibleInSessionList: true };
      if (thinkingLevel !== undefined && thinkingLevel !== null) {
        createOptions.thinkingLevel = thinkingLevel;
      }
      if (workspaceSelection.mount?.mountId) {
        createOptions.workspaceMountId = workspaceSelection.mount.mountId;
        createOptions.workspaceLabel = workspaceSelection.mount.label || null;
      }
      let newSessionPath, newSessionId, newAgentId;
      // @ui-focus-ok: this asks "is the caller switching to a different agent
      // than the one already on screen?", which is a question about the focus
      // itself. The caller's own view wins when it says so; the server's focus
      // is the last resort for deciding whether this is a switch at all, and
      // the agent being switched to is the explicit one either way.
      if (agentId && agentId !== (body.currentAgentId || engine.currentAgentId)) {
        ({ sessionPath: newSessionPath, sessionId: newSessionId, agentId: newAgentId } = await engine.createSessionForAgent(
          agentId,
          cwd || undefined,
          memFlag,
          undefined,
          createOptions,
        ));
      } else {
        ({ sessionPath: newSessionPath, sessionId: newSessionId, agentId: newAgentId } = await engine.createSession(
          null,
          cwd || undefined,
          memFlag,
          undefined,
          createOptions,
        ));
      }
      engine.persistSessionMeta(newSessionPath);
      if (projectId && typeof engine.setSessionProjectAssignment === "function") {
        await engine.setSessionProjectAssignment({ sessionPath: newSessionPath, projectId });
      }

      // 记住工作目录 + 更新历史
      if (cwd) {
        const history = mergeWorkspaceHistory(engine.config.cwd_history, [cwd]);
        await engine.updateConfig({ last_cwd: cwd, cwd_history: history });
      }

      log.log("session 创建完成");
      const response = {
        ok: true,
        path: newSessionPath,
        sessionId: newSessionId || engine.getSessionIdForPath?.(newSessionPath) || null,
        cwd: engine.cwd,
        workspaceFolders: engine.getSessionWorkspaceFolders?.(newSessionPath) || [],
        authorizedFolders: engine.getSessionAuthorizedFolders?.(newSessionPath) || [],
        agentId: newAgentId,
        agentName: engine.getAgent(newAgentId)?.agentName || engine.agentName,
        projectId,
        planMode: engine.planMode,
        permissionMode: engine.permissionMode,
        accessMode: engine.accessMode,
        thinkingLevel: normalizeSessionThinkingLevel(engine.getSessionThinkingLevel?.(newSessionPath) || engine.getThinkingLevel?.()),
        memoryModelUnavailableReason: engine.memoryModelUnavailableReason || null,
        ...sessionWorkspaceMountFields(engine, newSessionPath, workspaceSelection.mount),
      };
      hub?.eventBus?.emit?.({
        type: "session_created",
        session: response,
      }, newSessionPath);
      return c.json(response);
    } catch (err) {
      const classified = classifySessionCreationError(err);
      return c.json(classified.body, classified.status);
    }
  });

  route.post("/sessions/new-detached", async (c) => {
    try {
      const requestContext = createRequestContext(c, engine);
      const auth = authorizeSessionRoute(requestContext, "sessions.write", {
        kind: "studio",
        studioId: requestContext.studioId,
      });
      if (!auth.allowed) return c.json({ error: "insufficient_scope", reason: auth.reason }, 403);
      if (typeof engine.createDetachedSession !== "function") {
        return c.json({ error: "detached session creation unavailable" }, 500);
      }

      const body = await safeJson(c);
      const { memoryEnabled, agentId, permissionMode, thinkingLevel } = body;
      const workspaceSelection = resolveSessionWorkspaceSelection(engine, requestContext, body);
      const cwd = workspaceSelection.cwd;
      const workspaceFolders = Array.isArray(body.workspaceFolders)
        ? body.workspaceFolders.filter(p => typeof p === "string" && p.trim())
        : [];
      const memFlag = memoryEnabled !== false;
      const projectId = Object.prototype.hasOwnProperty.call(body, "projectId")
        ? (
            typeof engine.normalizeSessionProjectAssignmentId === "function"
              ? engine.normalizeSessionProjectAssignmentId(body.projectId)
              : (typeof body.projectId === "string" && body.projectId.trim() ? body.projectId.trim() : null)
          )
        : null;

      const detachedOptions: {
        cwd: any;
        memoryEnabled: boolean;
        agentId: string | null;
        workspaceFolders: any;
        visibleInSessionList: boolean;
        permissionMode: any;
        thinkingLevel?: any;
        workspaceMountId?: string;
        workspaceLabel?: string | null;
      } = {
        cwd: cwd || undefined,
        memoryEnabled: memFlag,
        agentId: typeof agentId === "string" && agentId.trim() ? agentId.trim() : null,
        workspaceFolders,
        visibleInSessionList: true,
        permissionMode: permissionMode || null,
      };
      if (thinkingLevel !== undefined && thinkingLevel !== null) {
        detachedOptions.thinkingLevel = thinkingLevel;
      }
      if (workspaceSelection.mount?.mountId) {
        detachedOptions.workspaceMountId = workspaceSelection.mount.mountId;
        detachedOptions.workspaceLabel = workspaceSelection.mount.label || null;
      }

      const result = await engine.createDetachedSession(detachedOptions);
      const newSessionPath = result.sessionPath;
      const newAgentId = result.agentId;
      const newSessionId = result.sessionId || engine.getSessionIdForPath?.(newSessionPath) || null;
      engine.persistSessionMeta?.(newSessionPath);
      if (projectId && typeof engine.setSessionProjectAssignment === "function") {
        await engine.setSessionProjectAssignment({ sessionPath: newSessionPath, projectId });
      }
      if (cwd && body.recordWorkspaceHistory === true) {
        const history = mergeWorkspaceHistory(engine.config?.cwd_history, [cwd]);
        await engine.updateConfig?.({ last_cwd: cwd, cwd_history: history });
      }

      const resolvedPermissionMode = engine.getSessionPermissionMode?.(newSessionPath)
        || permissionMode
        || engine.permissionMode
        || "ask";
      const response = {
        ok: true,
        path: newSessionPath,
        sessionId: newSessionId,
        cwd: result.session?.sessionManager?.getCwd?.() || cwd || engine.cwd || null,
        workspaceFolders: engine.getSessionWorkspaceFolders?.(newSessionPath) || workspaceFolders,
        authorizedFolders: engine.getSessionAuthorizedFolders?.(newSessionPath) || [],
        agentId: newAgentId,
        agentName: engine.getAgent?.(newAgentId)?.agentName || newAgentId || engine.agentName,
        projectId,
        currentSessionPath: engine.currentSessionPath || null,
        planMode: resolvedPermissionMode === "read_only",
        permissionMode: resolvedPermissionMode,
        accessMode: resolvedPermissionMode === "read_only" ? "read_only" : "operate",
        thinkingLevel: normalizeSessionThinkingLevel(engine.getSessionThinkingLevel?.(newSessionPath) || engine.getThinkingLevel?.()),
        memoryModelUnavailableReason: engine.memoryModelUnavailableReason || null,
        ...sessionWorkspaceMountFields(engine, newSessionPath, workspaceSelection.mount),
      };
      hub?.eventBus?.emit?.({
        type: "session_created",
        session: response,
      }, newSessionPath);
      return c.json(response);
    } catch (err) {
      const classified = classifySessionCreationError(err);
      return c.json(classified.body, classified.status);
    }
  });

  route.post("/sessions/continue-deleted-agent", async (c) => {
    try {
      const requestContext = createRequestContext(c, engine);
      const body = await safeJson(c);
      const sessionPath = body?.path || body?.sessionPath || null;
      if (!sessionPath) {
        return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      }
      const auth = authorizeSessionRoute(requestContext, "sessions.write", {
        kind: "session",
        studioId: requestContext.studioId,
        sessionPath,
      });
      if (!auth.allowed) return c.json({ error: "insufficient_scope", reason: auth.reason }, 403);
      if (!isActiveDesktopSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      if (!isDeletedAgentSessionPath(sessionPath)) {
        return c.json({ error: "agent_not_deleted" }, 400);
      }
      if (!(await pathExists(sessionPath))) {
        return c.json({ error: t("error.sessionNotFound") }, 404);
      }

      const result = await engine.continueDeletedAgentSession(sessionPath);
      const newSessionPath = result.sessionPath;
      const newAgentId = result.agentId;
      const response = {
        ok: true,
        path: newSessionPath,
        sessionId: result.sessionId || engine.getSessionIdForPath?.(newSessionPath) || null,
        cwd: result.cwd || engine.cwd || null,
        workspaceFolders: result.workspaceFolders || engine.getSessionWorkspaceFolders?.(newSessionPath) || [],
        authorizedFolders: result.authorizedFolders || engine.getSessionAuthorizedFolders?.(newSessionPath) || [],
        agentId: newAgentId,
        agentName: result.agentName || engine.getAgent?.(newAgentId)?.agentName || newAgentId,
        projectId: null,
        planMode: engine.planMode,
        permissionMode: engine.permissionMode,
        accessMode: engine.accessMode,
        thinkingLevel: normalizeSessionThinkingLevel(engine.getSessionThinkingLevel?.(newSessionPath) || engine.getThinkingLevel?.()),
        memoryModelUnavailableReason: engine.memoryModelUnavailableReason || null,
        compacted: result.compacted === true,
        compactionError: result.compactionError || null,
      };
      hub?.eventBus?.emit?.({
        type: "session_created",
        session: response,
      }, newSessionPath);
      return c.json(response);
    } catch (err) {
      const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600
        ? err.status
        : 500;
      return c.json({
        error: err.message,
        ...(err?.code ? { code: err.code } : {}),
      }, status);
    }
  });

  // 切换 session（支持跨 agent）
  route.post("/sessions/switch", async (c) => {
    try {
      const body = await safeJson(c);
      const { sessionId, path: legacySessionPath, currentSessionPath: oldSessionPath } = body;
      let sessionPath = typeof legacySessionPath === "string" ? legacySessionPath : null;
      if (typeof sessionId === "string" && sessionId.trim()) {
        const manifest = engine.getSessionManifest?.(sessionId.trim()) || null;
        if (!manifest?.currentLocator?.path) {
          return c.json({ error: "Session manifest not found", code: "session_manifest_not_found" }, 404);
        }
        sessionPath = manifest.currentLocator.path;
      }
      if (!sessionPath) {
        return c.json({ error: t("error.missingParam", { param: "sessionId" }) }, 400);
      }
      // 运行路径只允许 active desktop session。归档会话必须先 restore。
      if (!isActiveDesktopSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      if (isDeletedAgentSessionPath(sessionPath)) {
        return rejectDeletedAgentSession(c);
      }
      // 切换前挂起浏览器（保存当前 session 的浏览器状态）
      const bm = BrowserManager.instance();
      const suspendPath = oldSessionPath;
      if (suspendPath && bm.isRunning(suspendPath)) {
        // viewer 开着就让它跟着切，不再因为切换会话把窗口藏起来
        await bm.suspendForSession(suspendPath, { keepViewerVisible: true });
      }

      await engine.switchSession(sessionPath);

      // 恢复目标 session 的浏览器（若有）。无 browser host 的 server/PWA 环境只记录 typed skip；
      // 一旦判断为可恢复，resumeForSession 内的真实 browser 错误仍会向外抛出。
      const browserResume = await resumeBrowserForSessionSwitch(bm, sessionPath);

      const session = engine.getSessionByPath(sessionPath);

      // viewer 跟随：无论是否 resume 成功都告知 viewer 当前 session（没有标签页组就显示空态）。
      // 不改变窗口可见性，viewer 没开着时这条通知只更新标题缓存。
      void bm.notifyViewerSession(sessionPath, session?.title || null);

      // 从 manifest 归属解析 agentId，避免依赖 engine 焦点指针的时序。
      // switchSession 只接受 agents/{id}/sessions/*.jsonl 布局的路径，归属要么
      // 来自 manifest，要么从这个布局推出来，所以走到这里一定解析得到 agentId。
      const switchedAgentId = engine.resolveSessionOwnership(sessionPath).agentId;
      const switchedAgent = engine.getAgent(switchedAgentId);

      // switchSession 已同步设置焦点到目标 session。
      // cwd/planMode/model 是 session 级状态，此时读焦点是安全的。
      // memoryEnabled 需要返回 session 自身冻结下来的值，而不是当前
      // master && session 的临时组合态；否则现有 session 的缓存前缀身份
      // 会被全局 gate 混淆。
      // agentId/agentName 已从 sessionPath 解析，不依赖焦点。
      const activeModel = session?.model ?? engine.currentModel;
      const modelAvailability = engine.getSessionModelAvailability?.(sessionPath) || null;
      const frozenSessionMemoryEnabled = typeof engine.getSessionMemoryEnabled === "function"
        ? engine.getSessionMemoryEnabled(sessionPath)
        : (switchedAgent?.isSessionMemoryEnabledFor?.(sessionPath) ?? engine.memoryEnabled);
      return c.json({
        ok: true,
        messageCount: session?.messages?.length || 0,
        memoryEnabled: frozenSessionMemoryEnabled,
        planMode: engine.planMode,
        permissionMode: engine.permissionMode,
        accessMode: engine.accessMode,
        thinkingLevel: normalizeSessionThinkingLevel(engine.getSessionThinkingLevel?.(sessionPath) || engine.getThinkingLevel?.()),
        memoryModelUnavailableReason: engine.memoryModelUnavailableReason || null,
        cwd: engine.cwd,
        workspaceFolders: engine.getSessionWorkspaceFolders?.(sessionPath) || [],
        authorizedFolders: engine.getSessionAuthorizedFolders?.(sessionPath) || [],
        ...sessionWorkspaceMountFields(engine, sessionPath),
        agentId: switchedAgentId,
        agentName: switchedAgent?.agentName || switchedAgentId,
        browserRunning: bm.isRunning(sessionPath),
        browserUrl: bm.currentUrl(sessionPath) || null,
        browserResume,
        isStreaming: engine.isSessionStreaming(sessionPath),
        currentModelId: activeModel?.id || null,
        currentModelProvider: activeModel?.provider || null,
        currentModelName: activeModel?.name || null,
        currentModelInput: Array.isArray(activeModel?.input) ? activeModel.input : null,
        currentModelVideo: modelSupportsVideoInput(activeModel),
        currentModelVideoTransport: resolveModelVideoInputTransport(activeModel),
        currentModelVideoTransportSupported: modelSupportsDirectVideoInput(activeModel),
        currentModelAudio: modelSupportsAudioInput(activeModel),
        currentModelAudioTransport: resolveModelAudioInputTransport(activeModel),
        currentModelAudioTransportSupported: modelSupportsDirectAudioInput(activeModel),
        currentModelReasoning: activeModel?.reasoning ?? null,
        currentModelXhigh: modelSupportsXhigh(activeModel),
        currentModelThinkingLevels: activeModel ? getModelThinkingLevels(activeModel) : null,
        currentModelDefaultThinkingLevel: activeModel ? resolveModelDefaultThinkingLevel(activeModel) : null,
        currentModelContextWindow: activeModel?.contextWindow ?? null,
        currentModelAvailable: modelAvailability?.available !== false,
        currentModelUnavailableReason: modelAvailability?.available === false
          ? (modelAvailability.reason || "temporarily_unavailable")
          : null,
      });
    } catch (err) {
      const errDetail = `${err.message}\n${err.stack || ""}`;
      switchLog.error(`error: ${errDetail}`);
      try { appendFileSync(path.join(engine.luccodeHome, "switch-error.log"), `${new Date().toISOString()}\n${errDetail}\n---\n`); } catch {}
      // 日志保持全量，响应按下游语义分层：session-coordinator 抛的 409/404/503
      // 不该在这里被压平成 500，否则用户只看得到"未知错误"，无从判断该刷新还是重试。
      return c.json(bodyFromRouteError(err), statusFromRouteError(err));
    }
  });

  // 显式更新 Agent 能力：fresh compact 压缩旧对话，再用当前配置重建 prompt/工具快照。
  route.post("/sessions/fresh-compact", async (c) => {
    try {
      const body = await safeJson(c);
      const { path: sessionPath } = body || {};
      if (!sessionPath) {
        return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      }
      if (!isActiveDesktopSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      if (isDeletedAgentSessionPath(sessionPath)) {
        return rejectDeletedAgentSession(c);
      }
      const result = await engine.freshCompactDesktopSession(sessionPath);
      return c.json({
        ok: true,
        ...result,
      });
    } catch (err) {
      lifecycleLog.error(`fresh-compact failed: ${err.message}`);
      return c.json(bodyFromRouteError(err), statusFromRouteError(err));
    }
  });

  // 获取所有有浏览器的 session
  route.get("/browser/sessions", async (c) => {
    const bm = BrowserManager.instance();
    return c.json(bm.getBrowserSessions());
  });

  // 获取所有有浏览器痕迹的 session 状态（活跃 / 可恢复 / 不可用）
  route.get("/browser/session-states", async (c) => {
    const bm = BrowserManager.instance();
    return c.json(bm.getBrowserSessionStates());
  });

  // 打开指定 session 的浏览器（侧栏徽章左键入口）：冷状态先恢复，再让 viewer 展示该 session
  route.post("/browser/open-session", async (c) => {
    const body = await safeJson(c);
    const { sessionPath } = body;
    if (!sessionPath) return c.json({ error: "missing sessionPath" }, 400);
    const bm = BrowserManager.instance();
    const resume = await bm.resumeForSessionIfAvailable(sessionPath);
    const session = engine.getSessionByPath(sessionPath);
    await bm.notifyViewerSession(sessionPath, session?.title || null);
    return c.json({ ok: true, resume });
  });

  // 关闭指定 session 的浏览器
  route.post("/browser/close-session", async (c) => {
    const body = await safeJson(c);
    const { sessionPath, revoke } = body;
    if (!sessionPath) return c.json({ error: "missing sessionPath" });
    const bm = BrowserManager.instance();
    // 急停（revoke）不只是关窗，还要撤销该 session 的 agent 浏览器授权。
    if (revoke === true) bm.revokeBrowserAuthorization(sessionPath);
    await bm.closeBrowserForSession(sessionPath);
    hub?.eventBus?.emit?.({ type: "browser_status", running: false, url: null }, sessionPath);
    return c.json({ ok: true, sessions: bm.getBrowserSessionStates() });
  });

  // 重命名 session
  route.post("/sessions/rename", async (c) => {
    try {
      const body = await safeJson(c);
      const { path: sessionPath, title } = body;
      if (!sessionPath) {
        return c.json({ error: t("error.missingParam", { param: "path" }) }, 400);
      }
      if (typeof title !== "string" || !title.trim()) {
        return c.json({ error: t("error.missingParam", { param: "title" }) }, 400);
      }
      if (!isValidSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      if (isDeletedAgentSessionPath(sessionPath)) {
        return rejectDeletedAgentSession(c);
      }
      await engine.saveSessionTitle(sessionPath, title.trim());
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // 清理过期归档 session
  route.post("/sessions/cleanup", async (c) => {
    try {
      const body = await safeJson(c);
      const { maxAgeDays = 90 } = body;
      const cutoff = Date.now() - maxAgeDays * 86400000;
      let deleted = 0;

      // 遍历所有 agent 的 sessions/archived/ 目录
      const agentsDir = engine.agentsDir;
      const agents = await fs.readdir(agentsDir).catch(() => []);
      for (const agentId of agents) {
        const archiveDir = path.join(agentsDir, agentId, "sessions", "archived");
        let files;
        try { files = await fs.readdir(archiveDir); } catch { continue; }
        for (const f of files) {
          if (!isSessionJsonlFilename(f)) continue;
          const fp = path.join(archiveDir, f);
          try {
            const stat = await fs.stat(fp);
            if (stat.mtime.getTime() < cutoff) {
              const activeKey = path.join(agentsDir, agentId, "sessions", f);
              await cleanupSessionLifecycle([activeKey, fp], "parent session deleted");
              await permanentlyDeleteArchivedFile(fp, "session_cleanup");
              deleted++;
              // 清理 titles.json 孤儿（key = 对应的活跃路径）
              try { await engine.clearSessionTitle(activeKey); } catch {}
            }
          } catch {}
        }
      }

      return c.json({ ok: true, deleted, maxAgeDays });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // 列出所有已归档 session（聚合各 agent 的 archived/ 目录）
  route.get("/sessions/archived", async (c) => {
    try {
      const list = await engine.listArchivedSessions();
      return c.json(list);
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // 归档 session（支持跨 agent）
  route.post("/sessions/archive", async (c) => {
    try {
      const body = await safeJson(c);
      const sessionRef = resolveSessionLocatorFromBody(body, "archiveSession");
      assertManifestLifecycle(sessionRef, "active", "archiveSession");
      const { sessionId, sessionPath } = sessionRef;
      // archive 是 lifecycle transition，只允许 active desktop session。
      if (!isActiveDesktopSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }

      // 从 session 路径推导归档目录（同 agent 的 sessions/archived/）
      const destPath = archivedPathForActiveSession(sessionPath);
      return await withSessionLifecycleLock([sessionPath, destPath], async () => {
        const archiveDir = path.dirname(destPath);
        // 确认文件存在
        try {
          await fs.access(sessionPath);
        } catch {
          return c.json({ error: t("error.sessionNotFound") }, 404);
        }
        if (await pathExists(destPath)) {
          return c.json({ error: "Archived path already exists" }, 409);
        }
        if (await pathExists(sessionFileSidecarPath(destPath))) {
          return c.json({ error: "Stage file sidecar destination already exists" }, 409);
        }
        await cleanupSessionLifecycle([sessionPath, destPath], "parent session archived", { skipMemory: true });

        // 再从 engine 的 session map 中移除。
        await engine.setSessionPinned({
          ...(sessionId ? { sessionId } : {}),
          sessionPath,
        }, false);
        await engine.closeSession(sessionPath);

        await fs.mkdir(archiveDir, { recursive: true });
        const manifest = await moveSessionLifecycleOrThrow({
          fromPath: sessionPath,
          toPath: destPath,
          lifecycle: "archived",
          reason: "session_archive",
        });
        try {
          await fs.rename(sessionPath, destPath);
          moveSessionFileSidecarSync(sessionPath, destPath);
        } catch (err) {
          try {
            await moveSessionLifecycleOrThrow({
              fromPath: destPath,
              toPath: sessionPath,
              lifecycle: "active",
              reason: "session_archive_rollback",
            });
          } catch (rollbackErr) {
            lifecycleLog.error(`archive manifest rollback failed for ${sessionPath}: ${rollbackErr.message}`);
          }
          throw err;
        }

        // 将 mtime 置为归档瞬间，使 cleanup 按"归档时间"而非"最后活动时间"判断
        const nowSec = Date.now() / 1000;
        await fs.utimes(destPath, nowSec, nowSec);

        return c.json({ ok: true, sessionId: manifest.sessionId || sessionId || null, archivedPath: destPath });
      });
    } catch (err) {
      return c.json(bodyFromRouteError(err), statusFromRouteError(err));
    }
  });

  // 恢复归档 session → 移回 sessions/
  route.post("/sessions/restore", async (c) => {
    try {
      const body = await safeJson(c);
      const sessionRef = resolveSessionLocatorFromBody(body, "restoreSession");
      assertManifestLifecycle(sessionRef, "archived", "restoreSession");
      const { sessionId, sessionPath } = sessionRef;
      if (!isArchivedDesktopSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      // 必须位于 /archived/ 目录下，防止把活跃 session 当归档路径调用
      const archDir = path.dirname(sessionPath);
      if (path.basename(archDir) !== "archived") {
        return c.json({ error: "Not an archived session path" }, 403);
      }
      try {
        await fs.access(sessionPath);
      } catch {
        return c.json({ error: t("error.sessionNotFound") }, 404);
      }

      const activeDir = path.dirname(archDir);
      const destPath = path.join(activeDir, path.basename(sessionPath));

      return await withSessionLifecycleLock([destPath, sessionPath], async () => {
        try {
          await fs.access(sessionPath);
        } catch {
          return c.json({ error: t("error.sessionNotFound") }, 404);
        }

        await cleanupSessionLifecycle([destPath, sessionPath], "parent session restored", { skipMemory: true });

        // 冲突检测：目标位置已有真实消息时，不自动合并；只有旧 bug 留下的 header-only 文件可修复。
        await repairHeaderOnlyActiveRestoreTarget(destPath);
        if (await pathExists(sessionFileSidecarPath(destPath))) {
          return c.json({ error: "Stage file sidecar destination already exists" }, 409);
        }

        await fs.rename(sessionPath, destPath);
        moveSessionFileSidecarSync(sessionPath, destPath);
        let manifest = null;
        try {
          manifest = await moveSessionLifecycleOrThrow({
            fromPath: sessionPath,
            toPath: destPath,
            lifecycle: "active",
            reason: "session_restore",
          });
        } catch (err) {
          try {
            await fs.mkdir(archDir, { recursive: true });
            await fs.rename(destPath, sessionPath);
            moveSessionFileSidecarSync(destPath, sessionPath);
          } catch (rollbackErr) {
            lifecycleLog.error(`restore file rollback failed for ${destPath}: ${rollbackErr.message}`);
          }
          throw err;
        }
        return c.json({ ok: true, restoredPath: destPath, sessionId: manifest?.sessionId || sessionId || null });
      });
    } catch (err) {
      return c.json(bodyFromRouteError(err), statusFromRouteError(err));
    }
  });

  // 永久删除一条归档 session
  route.post("/sessions/archived/delete", async (c) => {
    try {
      const body = await safeJson(c);
      const sessionRef = resolveSessionLocatorFromBody(body, "deleteArchivedSession");
      assertManifestLifecycle(sessionRef, "archived", "deleteArchivedSession");
      const { sessionId, sessionPath } = sessionRef;
      if (!isArchivedDesktopSessionPath(sessionPath, engine.agentsDir)) {
        return c.json({ error: "Invalid session path" }, 403);
      }
      const archDir = path.dirname(sessionPath);
      if (path.basename(archDir) !== "archived") {
        return c.json({ error: "Not an archived session path" }, 403);
      }
      const activeKey = activePathForArchivedSession(sessionPath);
      return await withSessionLifecycleLock([activeKey, sessionPath], async () => {
        const draftSessionId = sessionId || engine.getSessionIdForPath?.(activeKey) || null;
        await cleanupSessionLifecycle([activeKey, sessionPath], "parent session deleted");
        let deletedManifest;
        try {
          deletedManifest = await permanentlyDeleteArchivedFile(sessionPath, "archived_session_deleted");
        } catch (err) {
          if (err.code === "ENOENT") {
            return c.json({ error: t("error.sessionNotFound") }, 404);
          }
          throw err;
        }
        if (draftSessionId) {
          try { engine.deleteSessionInputDrafts?.(draftSessionId); } catch { /* 草稿清理失败不阻塞删除 */ }
        }
        // 清理 titles.json 孤儿（key = 对应的活跃路径）
        try { await engine.clearSessionTitle(activeKey); } catch {}
        return c.json({ ok: true, sessionId: deletedManifest?.sessionId || sessionId || null });
      });
    } catch (err) {
      return c.json(bodyFromRouteError(err), statusFromRouteError(err));
    }
  });

  return route;
}

function patchSessionFileLifecycleBlocks(blocks, engine, sessionPath) {
  if (!sessionPath) return;
  for (const block of blocks || []) {
    if (!block) continue;
    if (!["file", "artifact", "skill", "screenshot"].includes(block.type)) continue;
    let file = null;
    if (block.fileId && typeof engine?.getSessionFile === "function") {
      file = engine.getSessionFile(block.fileId, { sessionPath });
    }
    if (!file && block.filePath && typeof engine?.getSessionFileByPath === "function") {
      file = engine.getSessionFileByPath(block.filePath, { sessionPath });
    }
    if (!file && block.type === "screenshot" && block.base64 && engine?.luccodeHome && typeof engine?.getSessionFileByPath === "function") {
      try {
        const filePath = browserScreenshotPath(engine.luccodeHome, sessionPath, {
          base64: block.base64,
          mimeType: block.mimeType,
          sessionId: engine.getSessionIdForPath?.(sessionPath) || null,
        });
        file = engine.getSessionFileByPath(filePath, { sessionPath });
        if (file) block.type = "file";
      } catch {}
    }
    if (!file) continue;
    const patch = sessionFileLifecycleFields(file, engine);
    Object.assign(block, patch);
    if (block.type === "skill" && block.installedFile) {
      block.installedFile = { ...block.installedFile, ...patch };
    }
  }
}

function listSessionRegistryFiles(engine, sessionPath, activeReferences = []) {
  if (!sessionPath || typeof engine?.listSessionFiles !== "function") return [];
  return engine.listSessionFiles(sessionPath, { references: activeReferences })
    .map(file => {
      if (typeof engine.serializeSessionFile === "function") return engine.serializeSessionFile(file);
      return serializeSessionFile(file, { runtimeContext: engine?.runtimeContext || null });
    })
    .filter(Boolean);
}

function isMediaGenerationDeferredResult(result) {
  return result?.type === "image-generation" || result?.type === "video-generation";
}

function parseHistoryDeferredResult(message) {
  if (message?.customType === DEFERRED_RESULT_RECORD_TYPE) {
    return parseDeferredResultRecord(message.data);
  }
  if (message?.customType === DEFERRED_RESULT_MESSAGE_TYPE) {
    return parseDeferredResultNotification(message.content);
  }
  return null;
}

function historyDeferredDeliveryId(message, sourceIndex) {
  const details = message?.details && typeof message.details === "object" ? message.details : null;
  const fromDetails = typeof details?.deliveryId === "string" && details.deliveryId.trim()
    ? details.deliveryId.trim()
    : null;
  if (fromDetails) return fromDetails;
  return `history:${sourceIndex}`;
}

function isTerminalDeferredTask(task) {
  return task?.status === "resolved" || task?.status === "failed" || task?.status === "aborted";
}

function sessionFileLifecycleFields(file, engine) {
  const serialized = typeof engine?.serializeSessionFile === "function"
    ? engine.serializeSessionFile(file)
    : file;
  const source = serialized || file;
  const fileId = source.fileId || source.id || file.fileId || file.id || null;
  return {
    ...(fileId ? { fileId } : {}),
    ...(source.filePath ? { filePath: source.filePath } : {}),
    ...(source.label || source.displayName ? { label: source.label || source.displayName } : {}),
    ...(source.ext !== undefined ? { ext: source.ext } : {}),
    ...(source.mime ? { mime: source.mime } : {}),
    ...(source.kind ? { kind: source.kind } : {}),
    ...(source.storageKind ? { storageKind: source.storageKind } : {}),
    ...(source.presentation ? { presentation: source.presentation } : {}),
    ...(source.listed !== undefined ? { listed: source.listed !== false } : {}),
    ...(source.status ? { status: source.status } : {}),
    ...(source.missingAt !== undefined ? { missingAt: source.missingAt } : {}),
    ...(source.mtimeMs !== undefined ? { mtimeMs: source.mtimeMs } : {}),
    ...(source.size !== undefined ? { size: source.size } : {}),
    ...(source.version ? { version: source.version } : {}),
    ...(source.resource ? { resource: source.resource } : {}),
  };
}

// 仅供测试使用的内部函数出口；生产调用一律走 route handler。
// 这个出口跟 classifySessionCreationError 的文案正则兜底同生共死：它存在的唯一理由
// 是让那段兜底可被直接测到。兜底删除之日，这个出口一并删除，不要往里加第二个成员。
export const __testables = { classifySessionCreationError };
