/**
 * subagent-tool.js — Sub-agent 工具（非阻塞）
 *
 * 将独立子任务派给隔离的 agent session 执行，支持通过 agent 参数指定目标 agent。
 * 任务在后台运行，完成后通过 DeferredResultStore 持久化结果，
 * deferred-result-ext 以 steer 消息注入对话。
 * 调用方无需等待，可继续与用户对话。
 *
 * agent="?" 时列出所有可用 agent（同步返回）。
 */

import { Type } from "../pi-sdk/index.ts";
import path from "node:path";
import { t } from "../i18n.ts";
import { getToolSessionCwd, getToolSessionPath } from "./tool-session.ts";
import { resolveAgentParam } from "./agent-id-resolver.ts";
import { resolveSubagentToolAccess, SubagentAccessDeniedError } from "./subagent-tool-policy.ts";
import {
  mergeExecutorMetadata,
  normalizeExecutorMetadata,
} from "../subagent-executor-metadata.ts";

// subagent 工具访问（剥离 vs 拦截、只读档位）收口在 ./subagent-tool-policy.ts（resolveSubagentToolAccess）。
// 默认甲（Codex 式）：给全集工具 + 拦截层限制（防自递归在 classifySessionPermission 的 subagent 上下文）。
const SUBAGENT_TIMEOUT_MS = 30 * 60 * 1000; // 30 分钟

// 并发限制在 createSubagentTool 闭包内（per-agent），不再全局共享

function directPersistDir(deps) {
  return path.join(deps.agentDir, "subagent-sessions", "direct");
}

function pickLabel(params: Record<string, any> = {}) {
  if (typeof params.label === "string" && params.label.trim()) return params.label.trim();
  // Legacy compatibility: old callers may still pass instance. It is now display-only.
  if (typeof params.instance === "string" && params.instance.trim()) return params.instance.trim();
  return null;
}

function directThreadSnapshot(thread) {
  if (!thread) return null;
  return {
    threadId: thread.threadId || null,
    threadKind: thread.kind || null,
    label: thread.label || null,
    access: thread.access || null,
    agentId: thread.agentId || null,
    agentName: thread.agentName || null,
    childSessionId: thread.childSessionId || null,
    childSessionPath: thread.childSessionPath || null,
    summary: thread.summary || null,
  };
}

function taskIdForSubagentRun() {
  return `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function errorResult(text, details = {}) {
  return { content: [{ type: "text", text }], details };
}

function extractTaskTitle(task) {
  return String(task || "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean) || "";
}

function formatAgentEntry(a) {
  const label = a.name && a.name !== a.id ? `${a.id} (${a.name})` : a.id;
  const parts = [label];
  if (a.model) parts.push(`[${a.model}]`);
  if (a.summary) parts.push(a.summary);
  return parts.join(" — ");
}

function resolveAgentIdentity(listAgents, currentAgentId, agentId) {
  const actualAgentId = agentId || currentAgentId || null;
  if (!actualAgentId) {
    return normalizeExecutorMetadata({});
  }

  const agents = listAgents ? listAgents() : [];
  const target = agents.find(a => a.id === actualAgentId);
  return normalizeExecutorMetadata({
    agentId: actualAgentId,
    agentName: target?.name || target?.agentName || actualAgentId,
  });
}

function sessionIdForPath(deps, sessionPath) {
  const sessionId = deps.getSessionIdForPath?.(sessionPath);
  return typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : null;
}

function textOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function childSessionRefFromReady(deps, sessionPath, ready = null) {
  const readyObj = ready && typeof ready === "object" ? ready : null;
  const readyPath = textOrNull(readyObj?.sessionPath) || textOrNull(sessionPath);
  const sessionId = textOrNull(readyObj?.sessionId) || sessionIdForPath(deps, readyPath);
  return {
    sessionId,
    sessionPath: readyPath,
  };
}

function parentSessionRefForPath(deps, sessionPath) {
  const sessionId = sessionIdForPath(deps, sessionPath);
  return sessionId ? { sessionId, sessionPath } : null;
}

function parentSessionInputForPath(deps, sessionPath) {
  return parentSessionRefForPath(deps, sessionPath) || sessionPath;
}

function sameParentSession(deps, thread, parentSessionPath) {
  if (!thread || !parentSessionPath) return false;
  const parentSessionId = sessionIdForPath(deps, parentSessionPath);
  const threadSessionId = thread.parentSessionId || sessionIdForPath(deps, thread.parentSessionPath);
  if (parentSessionId && threadSessionId) return parentSessionId === threadSessionId;
  return thread.parentSessionPath === parentSessionPath;
}

function resolveDirectThreadForParent(threadStore, requestedThreadId, parentSessionRef, parentSessionPath) {
  const scoped = threadStore?.resolveDirectThreadForSession?.(
    requestedThreadId,
    parentSessionRef || parentSessionPath,
  );
  // Legacy/custom stores may not expose scoped aliases yet. Keeping the exact
  // lookup as a validation fallback preserves the explicit cross-session error;
  // callers still cannot operate on it because sameParentSession rejects it.
  return scoped || threadStore?.get?.(requestedThreadId) || null;
}

function applyRequestedAgentMetadata(target, requestedIdentity) {
  if (!target || !requestedIdentity) return target;
  target.requestedAgentId = requestedIdentity.executorAgentId;
  target.requestedAgentNameSnapshot = requestedIdentity.executorAgentNameSnapshot;
  return target;
}

function collectSessionFiles(result) {
  const files = [];
  const push = (item) => {
    if (item && typeof item === "object") files.push(item);
  };
  if (Array.isArray(result?.sessionFiles)) {
    for (const item of result.sessionFiles) push(item);
  }
  if (Array.isArray(result?.files)) {
    for (const item of result.files) push(item);
  }
  return files;
}

function describeSessionFile(file) {
  const label = file?.label || file?.displayName || file?.filename || file?.name || null;
  const filePath = file?.filePath || file?.path || file?.realPath || null;
  if (label && filePath && label !== filePath) return `${label}: ${filePath}`;
  return filePath || label || null;
}

function formatProducedFiles(files) {
  const lines = files.map(describeSessionFile).filter(Boolean);
  if (!lines.length) return "";
  return t("error.subagentProducedFiles", {
    files: lines.map(line => `- ${line}`).join("\n"),
  });
}

function completionErrorForStopReason(stopReason, errorMessage) {
  if (!stopReason || stopReason === "stop") return null;
  if (stopReason === "error") {
    return errorMessage || t("error.subagentStopError");
  }
  if (stopReason === "length") {
    return t("error.subagentStopLength");
  }
  return t("error.subagentStopReason", { reason: stopReason });
}

function normalizeSubagentOutcome(result) {
  const stopError = completionErrorForStopReason(result?.stopReason, result?.errorMessage);
  if (result?.error) {
    return { ok: false, reason: stopError || String(result.error) };
  }
  if (stopError) return { ok: false, reason: stopError };
  const text = typeof result?.replyText === "string" && result.replyText.trim()
    ? result.replyText
    : "";
  const sessionFiles = collectSessionFiles(result);
  if (text) {
    return { ok: true, text, sessionFiles };
  }
  const fileSummary = formatProducedFiles(sessionFiles);
  if (fileSummary) {
    return { ok: true, text: fileSummary, sessionFiles };
  }
  if (Array.isArray(result?.toolErrors) && result.toolErrors.length) {
    return { ok: false, reason: t("error.subagentToolFailed", { msg: result.toolErrors.filter(Boolean).join("; ") }) };
  }
  return { ok: false, reason: t("error.subagentNoOutput") };
}

/**
 * @param {object} deps
 * @param {(opts: object) => Promise<{ sessionPath: string|null, run: (prompt: string) => Promise }>} deps.prepareIsolatedSession
 * @param {() => string|null} deps.resolveUtilityModel
 * @param {() => import("../deferred-result-store.ts").DeferredResultStore|null} deps.getDeferredStore
 * @param {() => import("../subagent-run-store.ts").SubagentRunStore|null} [deps.getSubagentRunStore]
 * @param {() => import("../subagent-thread-store.ts").SubagentThreadStore|null} [deps.getSubagentThreadStore]
 * @param {() => string|null} deps.getSessionPath
 * @param {(sessionPath: string) => string|null} [deps.getSessionIdForPath] - parent session 的稳定身份
 * @param {(sessionPath: string) => string|null} [deps.getSessionPermissionMode] - 父会话当前权限档（operate/ask/read_only）；省略 access 时 subagent 据此继承
 * @param {() => string|null} [deps.getParentCwd] - parent session 当前工作目录，subagent 继承它
 * @param {() => Array} [deps.listAgents]
 * @param {string} [deps.currentAgentId]
 * @param {(event: object, sessionPath?: string|null) => void} [deps.emitEvent]
 */
export function createSubagentTool(deps) {
  const activeBySession = new Map(); // sessionId || legacy sessionPath → count
  const MAX_PER_SESSION = 10; // 单对话最多 10 个并行 subagent（Codex/cc 式）
  const MAX_GLOBAL = 20;

  function sessionIdentityKey(sessionPath) {
    if (!sessionPath) return null;
    return sessionIdForPath(deps, sessionPath) || sessionPath;
  }
  function getActive(sessionKey) { return activeBySession.get(sessionKey) || 0; }
  function incActive(sessionKey) { activeBySession.set(sessionKey, getActive(sessionKey) + 1); }
  function decActive(sessionKey) {
    const n = getActive(sessionKey) - 1;
    if (n <= 0) activeBySession.delete(sessionKey);
    else activeBySession.set(sessionKey, n);
  }
  function totalActive() {
    let sum = 0;
    for (const v of activeBySession.values()) sum += v;
    return sum;
  }

  const baseDescription =
    "Create a continuable subagent instance for a delegated task. Returns immediately with taskId and threadId; results are delivered back in the background. Use agent to target an agent, or agent=\"?\" to list agents.";
  const delegationDescription = "";

  return {
    name: "subagent",
    label: "Launch Subagent",
    description: baseDescription + delegationDescription,
    parameters: Type.Object({
      task: Type.String({ description: "Complete instructions and required context for the subagent. The subagent cannot see the current conversation history unless you include it here." }),
      model: Type.Optional(Type.String({ description: "Optional model override as provider/id. Omit to use the target agent's configured chat model." })),
      agent: Type.Optional(Type.String({ description: "Target agent id from the team roster, using the value shown in backticks. Choose the agent whose persona, strengths, and model best fit the task; the roster shows each model and summary. Omit for the current agent; pass \"?\" to list agents." })),
      label: Type.Optional(Type.String({ description: "Optional display label, such as \"research 1\" or \"draft 2\". Display-only; resume by passing the returned threadId to subagent_reply." })),
      // Legacy compatibility only. New callers should use label; thread identity is the returned threadId.
      instance: Type.Optional(Type.String({ description: "Legacy field, accepted only as label compatibility. New calls should use label; resume with threadId." })),
      access: Type.Optional(Type.Union(
        [Type.Literal("read"), Type.Literal("write")],
        { description: "Optional permission tier. \"read\": read-only subagent for research, exploration, or review tasks; it cannot edit files or run mutating commands. \"write\": operable subagent for execution, edits, or commands; requires the parent session to be in an operable (non read-only) mode, otherwise the call is rejected with an error. Omit to inherit the current session permission. Pick \"read\" whenever the task does not need to change anything." },
      )),
    }),
    sessionPermission: {
      resolveInvocation: (params) => {
        const agent = typeof params?.agent === "string" ? params.agent.trim() : "";
        if (agent === "?" || agent === "list") {
          return {
            action: "list",
            kind: "read",
            capability: "subagent.list",
          };
        }
        return {
          action: "launch",
          kind: "routine",
          capability: "subagent.launch",
        };
      },
    },

    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      // discovery 模式
      if (params.agent === "?" || params.agent === "list") {
        const listAgents = deps.listAgents;
        if (!listAgents) {
          return { content: [{ type: "text", text: t("error.noOtherAgents") }] };
        }
        const agents = listAgents().filter(a => a.id !== deps.currentAgentId);
        if (!agents.length) {
          return { content: [{ type: "text", text: t("error.noOtherAgents") }] };
        }
        return { content: [{ type: "text", text: agents.map(a => "- " + formatAgentEntry(a)).join("\n") }] };
      }

      // 解析 agent 参数：先按 id 严格匹配，找不到再按 name 唯一匹配兜底（防御 LLM 把显示名当 id 用）
      const allAgents = deps.listAgents ? deps.listAgents() : [];
      const resolved = resolveAgentParam(allAgents, params.agent);
      if (!resolved.ok) {
        const candidates = resolved.ambiguous
          ? resolved.byName
          : allAgents.filter(a => a.id !== deps.currentAgentId);
        return {
          content: [{
            type: "text",
            text: t("error.agentNotFoundAvailable", {
              id: params.agent,
              ids: candidates.map(formatAgentEntry).join("\n") || "(none)",
            }),
          }],
        };
      }
      // self-check：解析后是自己，视为未指定
      const targetAgentId = (resolved.agentId && resolved.agentId !== deps.currentAgentId)
        ? resolved.agentId
        : undefined;
      const requestedIdentity = resolveAgentIdentity(deps.listAgents, deps.currentAgentId, targetAgentId);

      const parentSessionPath = getToolSessionPath(ctx);
      const parentSessionKey = sessionIdentityKey(parentSessionPath);
      const parentSessionRef = parentSessionRefForPath(deps, parentSessionPath);
      const parentSessionId = parentSessionRef?.sessionId || null;
      const parentCwd = getToolSessionCwd(ctx) || deps.getParentCwd?.() || null;

      // Direct subagent：每次创建都会生成一个系统身份 threadId。label/legacy instance
      // 只做展示，不再作为复用开关；续接必须使用 subagent_reply(threadId)。
      const label = pickLabel(params);
      const realAgentId = targetAgentId || deps.currentAgentId || null;

      // 工具访问策略（收口）：默认甲（全集 + 拦截）。权限档（Codex 式）：
      //   显式 access:"read"/"write" 优先；省略则继承父会话当前档（subagent 只有只读/可操作两态）。
      // access 仅取合法枚举，非法值按省略处理（继承父档）。label 与 access 正交，不参与判档。
      const access = params.access === "read" || params.access === "write" ? params.access : undefined;
      const parentPermissionMode = parentSessionPath
        ? (deps.getSessionPermissionMode?.(parentSessionPath) || null)
        : null;
      let toolAccess;
      try {
        toolAccess = resolveSubagentToolAccess({ access, parentPermissionMode });
      } catch (err) {
        // attenuation 拒绝（#1614）：父只读 + access:"write"。显式报错给出路，不静默降级。
        if (err instanceof SubagentAccessDeniedError) {
          return errorResult(t("error.subagentWriteAccessDenied"), { errorCode: err.code });
        }
        throw err;
      }

      // 检查并发限制：per-session + global
      if (parentSessionKey && getActive(parentSessionKey) >= MAX_PER_SESSION) {
        return {
          content: [{ type: "text", text: t("error.subagentMaxConcurrent", { max: MAX_PER_SESSION }) }],
        };
      }
      if (totalActive() >= MAX_GLOBAL) {
        return {
          content: [{ type: "text", text: t("error.subagentMaxConcurrent", { max: MAX_GLOBAL }) }],
        };
      }

      const store = deps.getDeferredStore?.();
      const runStore = deps.getSubagentRunStore?.();
      const threadStore = deps.getSubagentThreadStore?.();

      if (!store || !threadStore || !parentSessionPath) {
        return errorResult(t("error.subagentParentSessionRequired"), {
          errorCode: "SUBAGENT_PARENT_SESSION_REQUIRED",
        });
      }

      const taskId = taskIdForSubagentRun();
      const threadKind = "direct";
      const threadId = taskId;
      const taskTitle = extractTaskTitle(params.task);
      const taskSummary = taskTitle.length > 80
        ? taskTitle.slice(0, 80) + "…"
        : taskTitle;

      store.defer(
        taskId,
        parentSessionInputForPath(deps, parentSessionPath),
        applyRequestedAgentMetadata(
          mergeExecutorMetadata({
            type: "subagent",
            interlude: true,
            deliveryIntent: "trigger_parent_turn",
            threadId,
            threadKind,
            label,
            access,
            summary: taskSummary,
          }, requestedIdentity),
          requestedIdentity,
        ),
      );
      runStore?.register?.(taskId, {
        parentSessionId,
        parentSessionPath,
        threadId,
        threadKind,
        label,
        access,
        summary: taskSummary,
        requestedAgentId: requestedIdentity?.executorAgentId || null,
        requestedAgentNameSnapshot: requestedIdentity?.executorAgentNameSnapshot || null,
        executorAgentId: requestedIdentity?.executorAgentId || null,
        executorAgentNameSnapshot: requestedIdentity?.executorAgentNameSnapshot || null,
        executorMetaVersion: requestedIdentity?.executorMetaVersion || null,
      });
      const hub = deps.getActivityHub?.();
      hub?.upsert({
        id: taskId, kind: "subagent", status: "running",
        sessionId: parentSessionId,
        sessionPath: parentSessionPath,
        threadId,
        threadKind,
        agentId: requestedIdentity?.executorAgentId || null,
        agentName: requestedIdentity?.executorAgentNameSnapshot || null,
        label,
        access,
        summary: taskSummary, startedAt: Date.now(),
      });

      const controller = new AbortController();
      // 超时计时移到 executeForAgent 真正开跑时再起：复用实例可能排队，
      // 排队期间不该计入 30 分钟超时（否则队尾任务没开跑就被误超时）。
      let timeoutTimer = null;

      const registry = deps.getTaskRegistry?.();
      registry?.register(taskId, {
        type: "subagent",
        parentSessionId,
        parentSessionPath,
        parentSessionRef,
        meta: applyRequestedAgentMetadata(
          mergeExecutorMetadata({ summary: taskSummary }, requestedIdentity),
          requestedIdentity,
        ),
      });
      deps.setSubagentController?.(taskId, controller);

      incActive(parentSessionKey);

      // 原子执行，fire-and-forget。sessionPath 通过 onSessionReady 回调后补到前端。
      const executeForAgent = (agentId) => {
        const executorIdentity = resolveAgentIdentity(deps.listAgents, deps.currentAgentId, agentId);
        threadStore?.beginRun?.(threadId, {
          kind: threadKind,
          parentSessionId,
          parentSessionPath,
          agentId: executorIdentity?.executorAgentId || agentId || realAgentId || null,
          agentName: executorIdentity?.executorAgentNameSnapshot || null,
          label,
          access,
          summary: taskSummary,
        });
        // 超时计时在此刻（真正开跑）才起，见上方 timeoutTimer 声明处说明。
        timeoutTimer = setTimeout(() => controller.abort(), SUBAGENT_TIMEOUT_MS);
        if (timeoutTimer.unref) timeoutTimer.unref();
        // 快照 parent session cwd：subagent 在"派出那一刻" parent 所在的目录干活，
        // 即使 parent 之后切了 cwd 也不影响已派出的 subagent。
        const inheritedCwd = parentCwd || undefined;
        return deps.executeIsolated(
          params.task,
          {
            agentId,
            cwd: inheritedCwd,
            parentSessionPath,
            emitEvents: true,
            persist: directPersistDir(deps),
            model: params.model,
            ...(toolAccess.customToolFilter ? { toolFilter: toolAccess.customToolFilter } : {}),
            ...(toolAccess.builtinToolFilter ? { builtinFilter: toolAccess.builtinToolFilter } : {}),
            permissionMode: toolAccess.permissionMode,
            approvalPolicy: "deny_on_prompt",
            allowHumanApproval: false,
            subagentContext: true,
            subagentTaskId: taskId,
            fileReadSessionPaths: parentSessionPath ? [parentSessionPath] : [],
            signal: controller.signal,
	            onSessionReady: (sp, ready = null) => {
              const childSessionRef = childSessionRefFromReady(deps, sp, ready);
              const childSessionPath = childSessionRef.sessionPath || sp;
	              // session 创建后立即后补 streamKey + 实际执行者身份
	              deps.emitEvent?.({
	                type: "block_update", taskId,
	                patch: {
	                  ...(childSessionRef.sessionId ? { sessionId: childSessionRef.sessionId } : {}),
	                  streamKey: childSessionPath,
	                  threadId,
	                  threadKind,
	                  agentId: executorIdentity?.executorAgentId || null,
	                  agentName: executorIdentity?.executorAgentNameSnapshot || null,
	                  executorAgentId: executorIdentity?.executorAgentId || null,
	                  executorAgentNameSnapshot: executorIdentity?.executorAgentNameSnapshot || null,
	                  requestedAgentId: requestedIdentity?.executorAgentId || null,
	                  requestedAgentNameSnapshot: requestedIdentity?.executorAgentNameSnapshot || null,
	                },
              }, parentSessionPath);
              // 持久化子代理 sessionPath + 实际执行者身份到 deferred store meta（历史加载用）
              const task = store.query(taskId);
              if (task?.meta) {
                if (childSessionRef.sessionId) task.meta.sessionId = childSessionRef.sessionId;
                task.meta.sessionPath = childSessionPath;
                task.meta.threadId = threadId;
                task.meta.threadKind = threadKind;
                task.meta.label = label;
                task.meta.access = access;
                mergeExecutorMetadata(task.meta, executorIdentity);
                applyRequestedAgentMetadata(task.meta, requestedIdentity);
              }
              store._save?.();
              runStore?.attachSession?.(taskId, childSessionPath, {
                childSessionId: childSessionRef.sessionId,
                threadId,
                threadKind,
                label,
                access,
                requestedAgentId: requestedIdentity?.executorAgentId || null,
                requestedAgentNameSnapshot: requestedIdentity?.executorAgentNameSnapshot || null,
                executorAgentId: executorIdentity?.executorAgentId || null,
                executorAgentNameSnapshot: executorIdentity?.executorAgentNameSnapshot || null,
                executorMetaVersion: executorIdentity?.executorMetaVersion || null,
              });
              hub?.upsert({
                id: taskId, childSessionId: childSessionRef.sessionId, childSessionPath, threadId, threadKind,
                agentId: executorIdentity?.executorAgentId || null,
                agentName: executorIdentity?.executorAgentNameSnapshot || null,
                label,
                access,
              });
              threadStore?.attachSession?.(threadId, childSessionPath, {
                parentSessionId,
                parentSessionPath,
                childSessionId: childSessionRef.sessionId,
                agentId: executorIdentity?.executorAgentId || agentId || realAgentId || null,
                agentName: executorIdentity?.executorAgentNameSnapshot || null,
                label,
                access,
                summary: taskSummary,
              });
              void deps.persistSubagentSessionMeta?.(childSessionPath, executorIdentity)?.catch?.(() => {});
            },
          },
        );
      };

      const runPromise = threadStore?.runSerialized
        ? threadStore.runSerialized(threadId, () => executeForAgent(targetAgentId))
        : executeForAgent(targetAgentId);
      runPromise.then(result => {
        if (typeof result?.leafEntryId === "string" && result.leafEntryId.trim()) {
          runStore?.upsert?.(taskId, { childLeafEntryId: result.leafEntryId });
        }
        const wasUserAborted = registry?.query(taskId)?.aborted;
        if (wasUserAborted) {
          store.abort(taskId, t("error.subagentAborted"));
          runStore?.abort?.(taskId, t("error.subagentAborted"));
          threadStore?.finishRun?.(threadId, {
            status: "aborted",
            summary: t("error.subagentAborted"),
            close: false,
          });
          hub?.upsert({ id: taskId, status: "aborted", finishedAt: Date.now() });
          deps.emitEvent?.({
            type: "block_update", taskId,
            patch: { streamStatus: "aborted", summary: t("error.subagentAborted") },
          }, parentSessionPath);
          return;
        }
        const outcome = normalizeSubagentOutcome(result);
        if (!outcome.ok) {
          store.fail(taskId, outcome.reason);
          runStore?.fail?.(taskId, outcome.reason);
          threadStore?.finishRun?.(threadId, {
            status: "failed",
            summary: outcome.reason,
            close: false,
          });
        } else {
          store.resolve(taskId, outcome.text);
          runStore?.resolve?.(taskId, outcome.text);
          threadStore?.finishRun?.(threadId, {
            status: "resolved",
            summary: outcome.text,
            close: false,
          });
        }
        hub?.upsert({ id: taskId, status: outcome.ok ? "done" : "failed", finishedAt: Date.now() });
        const summary = outcome.ok ? outcome.text : outcome.reason;
        deps.emitEvent?.({
          type: "block_update", taskId,
          patch: {
            streamStatus: outcome.ok ? "done" : "failed",
            summary: (summary || "").slice(0, 200),
          },
        }, parentSessionPath);
      }).catch(err => {
        const wasUserAborted = registry?.query(taskId)?.aborted;
        const isTimeout = err.name === "AbortError" || err.name === "TimeoutError";
        const reason = wasUserAborted
          ? t("error.subagentAborted")
          : isTimeout
            ? t("error.subagentTimeout", { minutes: SUBAGENT_TIMEOUT_MS / 60000 })
            : err.message || String(err);

        if (wasUserAborted) {
          store.abort(taskId, reason);
          runStore?.abort?.(taskId, reason);
          threadStore?.finishRun?.(threadId, {
            status: "aborted",
            summary: reason,
            close: false,
          });
        } else {
          store.fail(taskId, reason);
          runStore?.fail?.(taskId, reason);
          threadStore?.finishRun?.(threadId, {
            status: "failed",
            summary: reason,
            close: false,
          });
        }
        hub?.upsert({ id: taskId, status: wasUserAborted ? "aborted" : "failed", finishedAt: Date.now() });

        deps.emitEvent?.({
          type: "block_update", taskId,
          patch: { streamStatus: wasUserAborted ? "aborted" : "failed", summary: reason },
        }, parentSessionPath);
      }).finally(() => {
        clearTimeout(timeoutTimer);
        deps.removeSubagentController?.(taskId);
        registry?.remove(taskId);
        decActive(parentSessionKey);
      });

      return {
        content: [{ type: "text", text: t("error.subagentDispatched", { taskId }) }],
        details: {
          taskId,
          threadId,
          threadKind,
          task: params.task,
          taskTitle,
          ...(label ? { label } : {}),
          ...(access ? { access } : {}),
          agentId: requestedIdentity?.executorAgentId || null,
          agentName: requestedIdentity?.executorAgentNameSnapshot || null,
          requestedAgentId: requestedIdentity?.executorAgentId || null,
          requestedAgentNameSnapshot: requestedIdentity?.executorAgentNameSnapshot || null,
          executorAgentId: requestedIdentity?.executorAgentId || null,
          executorAgentNameSnapshot: requestedIdentity?.executorAgentNameSnapshot || null,
          executorMetaVersion: requestedIdentity?.executorMetaVersion || null,
          sessionId: null,
          sessionPath: null,  // 通过 block_update 后补 streamKey
          streamStatus: "running",
        },
      };
    },
  };
}

export function createSubagentReplyTool(deps) {
  return {
    name: "subagent_reply",
    label: "Continue Subagent",
    description: "Append a task to an open subagent instance in the current session. Use current_status with subagents first to see available threadIds.",
    parameters: Type.Object({
      threadId: Type.String({ description: "The threadId of the subagent instance to continue. It must be an open subagent instance in the current session." }),
      task: Type.String({ description: "Complete instructions and required context to append to that subagent." }),
      access: Type.Optional(Type.Union(
        [Type.Literal("read"), Type.Literal("write")],
        { description: "Optional permission tier. \"read\": read-only continuation for research, exploration, or review. \"write\": operable continuation for execution, edits, or commands; requires the parent session to be in an operable (non read-only) mode, otherwise the call is rejected with an error. Omit to reuse the instance access, still bounded by the current session permission." },
      )),
    }),
    sessionPermission: {
      resolveInvocation: () => ({
        action: "continue",
        kind: "routine",
        capability: "subagent_reply.continue",
      }),
    },
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const parentSessionPath = getToolSessionPath(ctx);
      const parentSessionRef = parentSessionRefForPath(deps, parentSessionPath);
      const parentSessionId = parentSessionRef?.sessionId || null;
      const parentCwd = getToolSessionCwd(ctx) || deps.getParentCwd?.() || null;
      const threadStore = deps.getSubagentThreadStore?.() || null;
      if (!threadStore) {
        return errorResult("subagent thread store unavailable", { errorCode: "SUBAGENT_THREAD_STORE_UNAVAILABLE" });
      }
      const requestedThreadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
      const initialThread = resolveDirectThreadForParent(
        threadStore,
        requestedThreadId,
        parentSessionRef,
        parentSessionPath,
      );
      const validation = validateDirectThreadForReply(initialThread, parentSessionPath, (thread, sp) => sameParentSession(deps, thread, sp));
      if (validation) return validation;
      const threadId = initialThread.threadId;

      const store = deps.getDeferredStore?.();
      if (!store || !parentSessionPath) {
        return errorResult("subagent_reply requires an active parent session", { errorCode: "SUBAGENT_PARENT_SESSION_REQUIRED" });
      }

      const explicitAccess = params.access === "read" || params.access === "write" ? params.access : undefined;
      const access = explicitAccess || initialThread.access || undefined;
      const parentPermissionMode = deps.getSessionPermissionMode?.(parentSessionPath) || null;
      let toolAccess;
      try {
        toolAccess = resolveSubagentToolAccess({ access, parentPermissionMode });
      } catch (err) {
        // attenuation 拒绝（#1614）：父只读 + write 档（显式传入或线程残留）。
        // 出路与错误文案一致：切父会话到可操作模式，或显式 access:"read" 续接。
        if (err instanceof SubagentAccessDeniedError) {
          return errorResult(t("error.subagentWriteAccessDenied"), { errorCode: err.code });
        }
        throw err;
      }
      const runStore = deps.getSubagentRunStore?.();
      const hub = deps.getActivityHub?.();
      const registry = deps.getTaskRegistry?.();
      const taskId = taskIdForSubagentRun();
      const threadKind = "direct";
      const taskTitle = extractTaskTitle(params.task);
      const taskSummary = taskTitle.length > 80 ? taskTitle.slice(0, 80) + "…" : taskTitle;
      const executorIdentity = resolveAgentIdentity(deps.listAgents, deps.currentAgentId, initialThread.agentId || undefined);
      const queued = threadStore.isBusy?.(threadId) === true;

      store.defer(taskId, parentSessionInputForPath(deps, parentSessionPath), mergeExecutorMetadata({
        type: "subagent",
        interlude: true,
        deliveryIntent: "trigger_parent_turn",
        threadId,
        threadKind,
        label: initialThread.label || null,
        access: access || null,
        summary: taskSummary,
      }, executorIdentity));
      runStore?.register?.(taskId, {
        parentSessionId,
        parentSessionPath,
        threadId,
        threadKind,
        label: initialThread.label || null,
        access: access || null,
        summary: taskSummary,
        executorAgentId: executorIdentity?.executorAgentId || null,
        executorAgentNameSnapshot: executorIdentity?.executorAgentNameSnapshot || null,
        executorMetaVersion: executorIdentity?.executorMetaVersion || null,
      });
      hub?.upsert({
        id: taskId, kind: "subagent", status: "running",
        sessionId: parentSessionId,
        sessionPath: parentSessionPath,
        threadId,
        threadKind,
        agentId: executorIdentity?.executorAgentId || null,
        agentName: executorIdentity?.executorAgentNameSnapshot || null,
        label: initialThread.label || null,
        access: access || null,
        summary: taskSummary,
        startedAt: Date.now(),
      });

      const controller = new AbortController();
      let timeoutTimer = null;
      registry?.register(taskId, {
        type: "subagent",
        parentSessionId,
        parentSessionPath,
        parentSessionRef,
        meta: mergeExecutorMetadata({ summary: taskSummary }, executorIdentity),
      });
      deps.setSubagentController?.(taskId, controller);

      const executeExistingThread = () => {
        const latest = threadStore.get(threadId);
        if (!latest || latest.kind !== "direct" || latest.status !== "open") {
          throw new Error("subagent thread is no longer open");
        }
        if (!latest.childSessionPath) {
          throw new Error("subagent thread has no child session to resume");
        }
        threadStore.beginRun(threadId, {
          kind: "direct",
          parentSessionId,
          parentSessionPath,
          agentId: latest.agentId || null,
          agentName: latest.agentName || null,
          label: latest.label || null,
          access: access || latest.access || null,
          summary: taskSummary,
        });
        timeoutTimer = setTimeout(() => controller.abort(), SUBAGENT_TIMEOUT_MS);
        if (timeoutTimer.unref) timeoutTimer.unref();
        return deps.executeIsolated(params.task, {
          agentId: latest.agentId || undefined,
          cwd: parentCwd || undefined,
          parentSessionPath,
          emitEvents: true,
          persist: directPersistDir(deps),
          resumeSessionPath: latest.childSessionPath,
          ...(toolAccess.customToolFilter ? { toolFilter: toolAccess.customToolFilter } : {}),
          ...(toolAccess.builtinToolFilter ? { builtinFilter: toolAccess.builtinToolFilter } : {}),
          permissionMode: toolAccess.permissionMode,
          approvalPolicy: "deny_on_prompt",
          allowHumanApproval: false,
          subagentContext: true,
          subagentTaskId: taskId,
          subagentThreadId: threadId,
          subagentThreadKind: threadKind,
          fileReadSessionPaths: parentSessionPath ? [parentSessionPath] : [],
          signal: controller.signal,
          onSessionReady: (sp, ready = null) => {
            const childSessionRef = childSessionRefFromReady(deps, sp, ready);
            const childSessionPath = childSessionRef.sessionPath || sp;
            const task = store.query(taskId);
            if (task?.meta) {
              if (childSessionRef.sessionId) task.meta.sessionId = childSessionRef.sessionId;
              task.meta.sessionPath = childSessionPath;
              task.meta.threadId = threadId;
              task.meta.threadKind = threadKind;
              task.meta.label = latest.label || null;
              task.meta.access = access || latest.access || null;
              mergeExecutorMetadata(task.meta, executorIdentity);
            }
            store._save?.();
            runStore?.attachSession?.(taskId, childSessionPath, {
              childSessionId: childSessionRef.sessionId,
              threadId,
              threadKind,
              label: latest.label || null,
              access: access || latest.access || null,
              executorAgentId: executorIdentity?.executorAgentId || null,
              executorAgentNameSnapshot: executorIdentity?.executorAgentNameSnapshot || null,
              executorMetaVersion: executorIdentity?.executorMetaVersion || null,
            });
            hub?.upsert({
              id: taskId, childSessionId: childSessionRef.sessionId, childSessionPath, threadId, threadKind,
              agentId: executorIdentity?.executorAgentId || null,
              agentName: executorIdentity?.executorAgentNameSnapshot || null,
              label: latest.label || null,
              access: access || latest.access || null,
            });
            threadStore.attachSession(threadId, childSessionPath, {
              parentSessionId,
              parentSessionPath,
              childSessionId: childSessionRef.sessionId,
              agentId: latest.agentId || null,
              agentName: latest.agentName || null,
              label: latest.label || null,
              access: access || latest.access || null,
              summary: taskSummary,
            });
          },
        });
      };

      const runPromise = threadStore.runSerialized(threadId, executeExistingThread);
      runPromise.then(result => {
        if (typeof result?.leafEntryId === "string" && result.leafEntryId.trim()) {
          runStore?.upsert?.(taskId, { childLeafEntryId: result.leafEntryId });
        }
        const wasUserAborted = registry?.query(taskId)?.aborted;
        const outcome: any = wasUserAborted
          ? { ok: false, reason: t("error.subagentAborted"), aborted: true }
          : normalizeSubagentOutcome(result);
        if (outcome.aborted) {
          store.abort(taskId, outcome.reason);
          runStore?.abort?.(taskId, outcome.reason);
          threadStore.finishRun(threadId, { status: "aborted", summary: outcome.reason, close: false });
        } else if (!outcome.ok) {
          store.fail(taskId, outcome.reason);
          runStore?.fail?.(taskId, outcome.reason);
          threadStore.finishRun(threadId, { status: "failed", summary: outcome.reason, close: false });
        } else {
          store.resolve(taskId, outcome.text);
          runStore?.resolve?.(taskId, outcome.text);
          threadStore.finishRun(threadId, { status: "resolved", summary: outcome.text, close: false });
        }
        const finalStatus = outcome.aborted ? "aborted" : outcome.ok ? "done" : "failed";
        const summary = outcome.ok ? outcome.text : outcome.reason;
        hub?.upsert({ id: taskId, status: finalStatus, finishedAt: Date.now() });
        deps.emitEvent?.({
          type: "block_update", taskId,
          patch: { streamStatus: finalStatus, summary: (summary || "").slice(0, 200) },
        }, parentSessionPath);
      }).catch(err => {
        const wasUserAborted = registry?.query(taskId)?.aborted;
        const isTimeout = err.name === "AbortError" || err.name === "TimeoutError";
        const reason = wasUserAborted
          ? t("error.subagentAborted")
          : isTimeout
            ? t("error.subagentTimeout", { minutes: SUBAGENT_TIMEOUT_MS / 60000 })
            : err.message || String(err);
        if (wasUserAborted) {
          store.abort(taskId, reason);
          runStore?.abort?.(taskId, reason);
          threadStore.finishRun(threadId, { status: "aborted", summary: reason, close: false });
        } else {
          store.fail(taskId, reason);
          runStore?.fail?.(taskId, reason);
          threadStore.finishRun(threadId, { status: "failed", summary: reason, close: false });
        }
        hub?.upsert({ id: taskId, status: wasUserAborted ? "aborted" : "failed", finishedAt: Date.now() });
        deps.emitEvent?.({
          type: "block_update", taskId,
          patch: { streamStatus: wasUserAborted ? "aborted" : "failed", summary: reason },
        }, parentSessionPath);
      }).finally(() => {
        clearTimeout(timeoutTimer);
        deps.removeSubagentController?.(taskId);
        registry?.remove(taskId);
      });

      return {
        content: [{ type: "text", text: queued
          ? t("error.subagentThreadQueued", { taskId, threadId })
          : t("error.subagentDispatched", { taskId }) }],
        details: {
          taskId,
          threadId,
          threadKind,
          task: params.task,
          taskTitle,
          ...directThreadSnapshot(initialThread),
          sessionId: initialThread.childSessionId || sessionIdForPath(deps, initialThread.childSessionPath) || null,
          sessionPath: initialThread.childSessionPath || null,
          streamStatus: "running",
        },
      };
    },
  };
}

export function createSubagentCloseTool(deps) {
  return {
    name: "subagent_close",
    label: "Close Subagent",
    description: "Close a no-longer-needed subagent instance in the current session and free a continuable instance slot.",
    parameters: Type.Object({
      threadId: Type.String({ description: "The threadId of the open subagent instance to close." }),
      reason: Type.Optional(Type.String({ description: "Optional closing reason, saved as the instance's final summary." })),
    }),
    sessionPermission: {
      resolveInvocation: () => ({
        action: "close",
        kind: "routine",
        capability: "subagent_close.close",
      }),
    },
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const parentSessionPath = getToolSessionPath(ctx);
      const threadStore = deps.getSubagentThreadStore?.() || null;
      if (!threadStore) {
        return errorResult("subagent thread store unavailable", { errorCode: "SUBAGENT_THREAD_STORE_UNAVAILABLE" });
      }
      const requestedThreadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
      const parentSessionRef = parentSessionRefForPath(deps, parentSessionPath);
      const thread = resolveDirectThreadForParent(
        threadStore,
        requestedThreadId,
        parentSessionRef,
        parentSessionPath,
      );
      const threadId = thread?.threadId || requestedThreadId;
      if (!thread) return errorResult(`Unknown subagent thread: ${requestedThreadId}`, { errorCode: "SUBAGENT_THREAD_NOT_FOUND", threadId: requestedThreadId });
      if (thread.kind !== "direct") return errorResult(`Subagent thread is not a direct instance: ${threadId}`, { errorCode: "SUBAGENT_THREAD_NOT_DIRECT", threadId });
      if (!sameParentSession(deps, thread, parentSessionPath)) {
        return errorResult(`Subagent thread does not belong to this session: ${threadId}`, { errorCode: "SUBAGENT_THREAD_NOT_IN_SESSION", threadId });
      }
      if (thread.status !== "open") {
        return errorResult(`Subagent thread is not open: ${threadId}`, { errorCode: "SUBAGENT_THREAD_NOT_OPEN", threadId });
      }
      if (threadStore.isBusy?.(threadId)) {
        return errorResult(`Subagent thread is busy: ${threadId}`, { errorCode: "SUBAGENT_THREAD_BUSY", threadId });
      }
      const reason = typeof params.reason === "string" && params.reason.trim() ? params.reason.trim() : null;
      const closed = threadStore.closeDirectThread(threadId, {
        summary: reason || thread.summary || null,
        lastRunStatus: thread.lastRunStatus || "resolved",
      });
      return {
        content: [{ type: "text", text: t("error.subagentThreadClosed", { threadId }) }],
        details: {
          threadId,
          streamStatus: "closed",
          ...directThreadSnapshot(closed),
        },
      };
    },
  };
}

function validateDirectThreadForReply(thread, parentSessionPath, matchesParent = null) {
  if (!thread) {
    return errorResult("Unknown subagent thread", { errorCode: "SUBAGENT_THREAD_NOT_FOUND" });
  }
  if (thread.kind !== "direct") {
    return errorResult(`Subagent thread is not a direct instance: ${thread.threadId}`, {
      errorCode: "SUBAGENT_THREAD_NOT_DIRECT",
      threadId: thread.threadId,
    });
  }
  if (matchesParent ? !matchesParent(thread, parentSessionPath) : thread.parentSessionPath !== parentSessionPath) {
    return errorResult(`Subagent thread does not belong to this session: ${thread.threadId}`, {
      errorCode: "SUBAGENT_THREAD_NOT_IN_SESSION",
      threadId: thread.threadId,
    });
  }
  if (thread.status !== "open") {
    return errorResult(`Subagent thread is not open: ${thread.threadId}`, {
      errorCode: "SUBAGENT_THREAD_NOT_OPEN",
      threadId: thread.threadId,
    });
  }
  return null;
}
