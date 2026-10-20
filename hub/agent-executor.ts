/**
 * AgentExecutor — Agent 会话执行器
 *
 * 使用 Engine 中的长驻 Agent 实例（不再创建临时 Agent），
 * 创建临时 session 执行多轮 prompt，捕获标记了 capture: true 的轮次输出。
 *
 * ChannelRouter 和 DmRouter 共用这个执行器。
 */

import fs from "fs";
import path from "path";
import { createAgentSession, SessionManager } from "../lib/pi-sdk/index.ts";
import { debugLog } from "../lib/debug-log.ts";
import { getLocale, t } from "../lib/i18n.ts";
import { createDefaultSettings } from "../core/session-defaults.ts";
import {
  installDynamicCompactionReserve,
  installMidRunCompaction,
} from "../core/session-compaction-runtime.ts";
import { SESSION_PERMISSION_MODES } from "../core/session-permission-mode.ts";
import { teardownSessionResources } from "../core/session-teardown.ts";
import {
  applyConversationScopedMemorySearch,
  filterAgentPhoneTools,
  getAgentPhoneActiveToolNames,
  getAgentPhonePermissionMode,
  getAgentPhoneSessionDir,
  shouldReuseAgentPhoneSession,
} from "../lib/conversations/agent-phone-session.ts";
import {
  ensureAgentPhoneProjection,
  updateAgentPhoneProjectionMeta,
} from "../lib/conversations/agent-phone-projection.ts";
import {
  readAgentPhoneRuntime,
  resolveAgentPhoneRuntimeSessionPath,
  updateAgentPhoneRuntime,
} from "../lib/conversations/agent-phone-runtime.ts";
import { findModel, requireModelRef } from "../shared/model-ref.ts";
import {
  buildSessionPromptSnapshot,
  createPromptSnapshotResourceLoader,
  normalizeSessionPromptSnapshot,
} from "../core/session-prompt-snapshot.ts";
import { stripClosedInternalNarrationBlocks } from "../lib/text/internal-narration.ts";
import { formatWorkspaceScopePrompt } from "../shared/workspace-scope.ts";
import { buildWorkspaceInstructionPrompt } from "../core/workspace-instruction-files.ts";
import { agentPersonaFilePaths } from "../core/persona-source.ts";

function resolveAgentPhoneModel(engine, ctx, agentConfig, modelOverride) {
  if (!modelOverride) return ctx.resolveModel(agentConfig);
  const ref = requireModelRef(modelOverride);
  const found = findModel(engine.availableModels || [], ref.id, ref.provider);
  if (!found) {
    throw new Error(`Agent phone model override not available: ${ref.provider}/${ref.id}`);
  }
  return found;
}

function textOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function establishRuntimeSessionRef(engine, sessionPath, defaults, operation) {
  if (!sessionPath) throw new Error(`${operation}: session locator unavailable before runtime assembly`);
  if (typeof engine?.ensureSessionRefForPath !== "function") {
    const error: any = new Error(`${operation}: session identity service is unavailable`);
    error.code = "session_manifest_unavailable";
    throw error;
  }
  const sessionRef = engine.ensureSessionRefForPath(sessionPath, defaults);
  if (!sessionRef?.sessionId || !sessionRef?.sessionPath) {
    throw new Error(`${operation}: SessionRef could not be established`);
  }
  if (path.resolve(sessionRef.sessionPath) !== path.resolve(sessionPath)) {
    const error: any = new Error(`${operation}: runtime locator does not match SessionRef`);
    error.code = "session_identity_conflict";
    throw error;
  }
  return sessionRef;
}

function modelIdFromModel(model) {
  return textOrNull(model?.id ?? model?.modelId);
}

function agentPhoneModelMeta(model) {
  return {
    provider: textOrNull(model?.provider),
    id: modelIdFromModel(model),
    name: textOrNull(model?.name),
    api: textOrNull(model?.api),
  };
}

function agentPhoneModelMetaForUsage(message, model) {
  return {
    provider: textOrNull(message?.provider) ?? textOrNull(model?.provider),
    modelId: textOrNull(message?.model) ?? modelIdFromModel(model),
    api: textOrNull(message?.api) ?? textOrNull(model?.api),
  };
}

function recordAgentPhoneAssistantUsage({
  ledger,
  event,
  sessionPath,
  agentId,
  conversationId,
  conversationType,
  model,
}) {
  if (!ledger || event?.type !== "message_end" || event.message?.role !== "assistant") return null;
  const usageContext = {
    source: {
      subsystem: "session",
      operation: "phone_reply",
      surface: conversationType === "channel" ? "channel" : "dm",
      trigger: "delivery",
    },
    attribution: {
      kind: "phone",
      agentId: agentId || null,
      conversationId,
      conversationType,
      sessionPath,
    },
  };
  const modelMeta = agentPhoneModelMetaForUsage(event.message, model);
  if (event.message?.usage) {
    return ledger.record?.({
      model: modelMeta,
      usage: event.message.usage,
      usageContext,
      costRates: model?.cost,
    });
  }
  const errorMessage = event.message?.errorMessage || event.message?.error?.message || null;
  if (event.message?.stopReason === "error" || errorMessage) {
    const request = ledger.start?.({
      model: modelMeta,
      usageContext,
      costRates: model?.cost,
    });
    return ledger.recordError?.(request?.requestId, new Error(errorMessage || "provider request failed"));
  }
  return null;
}

function buildAgentPhonePromptSnapshot(agent, ctx, systemPrompt, cwd) {
  const locale = agent.config?.locale || getLocale();
  const baseAppend = ctx.resourceLoader?.getAppendSystemPrompt?.() || [];
  const workspacePrompt = formatWorkspaceScopePrompt({
    primaryCwd: cwd,
    workspaceFolders: [],
    locale,
  });
  const workspaceInstructions = buildWorkspaceInstructionPrompt({
    cwd,
    workspaceContext: agent.config?.workspace_context,
    locale,
    excludeFiles: agentPersonaFilePaths(agent.agentDir),
  });
  return buildSessionPromptSnapshot({
    systemPrompt,
    appendSystemPrompt: [
      ...(Array.isArray(baseAppend) ? baseAppend : []),
      ...(workspacePrompt ? [workspacePrompt] : []),
      ...(workspaceInstructions ? [workspaceInstructions] : []),
    ],
    skillsResult: ctx.getSkillsForAgent?.(agent),
    agentsFilesResult: ctx.resourceLoader?.getAgentsFiles?.(),
  });
}

function isAgentPhoneEnabled(engine) {
  return engine?.isChannelsEnabled?.() !== false;
}

function assertAgentPhoneEnabled(engine) {
  if (!isAgentPhoneEnabled(engine)) {
    throw new Error("Agent phone is disabled");
  }
}

async function getRuntimeAgent(engine, agentId, reason) {
  await engine.ensureAgentRuntime?.(agentId, {
    priority: "background",
    reason,
  });
  const agent = engine.getAgent(agentId);
  if (!agent) {
    throw new Error(t("error.agentExecNotInit", { id: agentId }));
  }
  return agent;
}

/**
 * 以指定 agentId 的身份跑一次临时会话。
 *
 * @param {string} agentId
 * @param {Array<{text: string, capture?: boolean}>} rounds  按序执行的 prompts
 * @param {object} opts
 * @param {import('../core/engine.ts').LucEngine} opts.engine
 * @param {AbortSignal} [opts.signal]
 * @param {string} [opts.sessionSuffix="temp"]
 * @param {string} [opts.systemAppend] - 追加到 system prompt 末尾
 * @param {boolean} [opts.keepSession=false] - 是否保留 session 文件
 * @param {boolean} [opts.noMemory=false] - 不注入记忆，只用 personality
 * @param {boolean} [opts.noTools=false] - 不注入工具
 * @param {boolean} [opts.readOnly=false] - 只读执行权限（保留工具 schema，调用时拦截副作用工具）
 * @returns {Promise<string>}  capture 轮的输出（已去掉 MOOD 块）
 */
export async function runAgentSession(agentId, rounds, { engine, signal, sessionSuffix = "temp", ephemeralDir, systemAppend, keepSession = false, noMemory = false, noTools = false, readOnly = false }: { engine?: any; signal?: any; sessionSuffix?: string; ephemeralDir?: any; systemAppend?: any; keepSession?: boolean; noMemory?: boolean; noTools?: boolean; readOnly?: boolean } = {}) {
  // 1. 从长驻 Map 获取 Agent 实例
  const agent = await getRuntimeAgent(engine, agentId, "agent-session");
  const agentDir = agent.agentDir;

  // 2. 临时 ResourceLoader
  const ctx = engine.createSessionContext();
  const tempResourceLoader = Object.create(ctx.resourceLoader);

  // noMemory 模式：只用 personality（identity + yuan + AGENTS.md），不注入记忆/用户档案等
  const basePrompt = noMemory ? agent.personality : agent.systemPrompt;
  tempResourceLoader.getSystemPrompt = () =>
    systemAppend ? `${basePrompt}\n\n${systemAppend}` : basePrompt;
  tempResourceLoader.getSkills = () => ctx.getSkillsForAgent(agent);

  // 3. 临时 session
  const cwd = engine.getHomeCwd(agentId) || process.cwd();
  const sessionDir = ephemeralDir || path.join(agentDir, "sessions", sessionSuffix);
  fs.mkdirSync(sessionDir, { recursive: true });
  const tempSessionMgr = SessionManager.create(cwd, sessionDir);
  const tempSessionPath = tempSessionMgr?.getSessionFile?.() || null;
  const sessionRef = establishRuntimeSessionRef(engine, tempSessionPath, {
    ownerAgentId: agentId,
    domain: "activity",
    kind: keepSession ? "hub_kept" : "hub_temporary",
    lifecycle: "active",
    provenance: {
      createdBy: "hub_agent_executor",
      sessionSuffix,
    },
    locatorReason: "hub_session_create",
  }, "runAgentSession");

  let session = null;
  let unsub = null;
  let onAbort;
  let capturedText = "";
  let isCapturing = false;
  let executionError = null;
  const cleanupErrors = [];
  try {
    // 工具模式：noTools = 无工具；readOnly 只影响执行权限，不裁剪 schema。
    let tools, customTools;
    if (noTools) {
      tools = [];
      customTools = [];
    } else {
      const agentToolsSnapshot = typeof agent.getToolsSnapshot === "function"
        ? agent.getToolsSnapshot({
          forceMemoryEnabled: agent.memoryMasterEnabled !== false,
          ...(typeof agent.experienceEnabled === "boolean"
            ? { forceExperienceEnabled: agent.experienceEnabled === true }
            : {}),
        })
        : agent.tools;
      const permissionMode = readOnly
        ? SESSION_PERMISSION_MODES.READ_ONLY
        : SESSION_PERMISSION_MODES.OPERATE;
      const built = ctx.buildTools(cwd, agentToolsSnapshot, {
        agentDir,
        workspace: engine.getHomeCwd(agentId),
        runtimeSessionRef: sessionRef,
        requireSessionIdentity: true,
        getPermissionMode: () => permissionMode,
      });
      tools = built.tools;
      customTools = built.customTools;
    }
    const model = ctx.resolveModel(agent.config);
    const created = await createAgentSession({
      cwd,
      sessionManager: tempSessionMgr,
      settingsManager: createDefaultSettings(),
      authStorage: ctx.authStorage,
      modelRegistry: ctx.modelRegistry,
      model,
      thinkingLevel: "medium",
      resourceLoader: tempResourceLoader,
      tools,
      customTools,
    });
    session = created.session;
    installDynamicCompactionReserve(session);
    installMidRunCompaction(session, {
      usageLedger: engine.usageLedger || engine.getUsageLedger?.() || null,
      buildUsageContext: (s: any) => ({
        source: {
          subsystem: "compaction",
          operation: "compact",
          surface: "hub",
          trigger: "threshold",
        },
        attribution: {
          kind: "session",
          agentId,
          sessionPath: s?.sessionManager?.getSessionFile?.() || null,
        },
      }),
    });
    const activeSessionPath = session.sessionManager?.getSessionFile?.() || null;
    if (!activeSessionPath || path.resolve(activeSessionPath) !== path.resolve(sessionRef.sessionPath)) {
      const error: any = new Error("runAgentSession: runtime locator does not match SessionRef");
      error.code = "session_identity_conflict";
      throw error;
    }

    if (signal) {
      onAbort = () => { try { session.abort(); } catch {} };
      signal.addEventListener("abort", onAbort, { once: true });
    }
    unsub = session.subscribe((event) => {
      if (!isCapturing) return;
      if (event.type === "message_update") {
        const sub = event.assistantMessageEvent;
        if (sub?.type === "text_delta") capturedText += sub.delta || "";
      }
    });

    debugLog()?.log("agent-executor", `${agentId} session started (${rounds.length} rounds)`);
    for (const round of rounds) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      isCapturing = !!round.capture;
      if (round.capture) capturedText = "";
      await session.prompt(round.text);
    }
  } catch (err) {
    executionError = err;
  } finally {
    try {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    } catch (err) {
      cleanupErrors.push(err);
    }
    try {
      if (session) await teardownSessionResources({
        session,
        unsub,
        label: `hub.runAgentSession[${agentId}]`,
        warn: (msg) => debugLog()?.warn("agent-executor", msg),
      });
    } catch (err) {
      cleanupErrors.push(err);
    }
    if (!keepSession) {
      try {
        engine.tombstoneSessionRef(sessionRef, "hub_temporary_cleanup");
      } catch (err) {
        cleanupErrors.push(err);
      }
      try {
        fs.unlinkSync(sessionRef.sessionPath);
      } catch (err) {
        if (err?.code !== "ENOENT") cleanupErrors.push(err);
      }
    }
  }

  const failures = [...(executionError ? [executionError] : []), ...cleanupErrors];
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, `hub.runAgentSession[${agentId}] cleanup failed`);
  }

  // 7. 去掉已闭合的内省块（backtick 和 XML 两种格式，一次过）。
  const text = stripClosedInternalNarrationBlocks(capturedText);

  debugLog()?.log("agent-executor", `${agentId} done, ${text.length} chars captured`);
  return text;
}

function storedRelativePath(agentDir, filePath) {
  return path.relative(agentDir, filePath).split(path.sep).join("/");
}

/**
 * 以 Agent Phone 方式运行可复用会话。
 *
 * 每个 agent + conversation 复用同一个 session 文件；runtime sidecar 记录
 * session file。该函数不删除 session 文件。
 */
export async function runAgentPhoneSession(agentId, rounds, {
  engine,
  signal,
  conversationId,
  conversationType = "channel",
  systemAppend,
  noMemory = false,
  toolMode = "read_only",
  modelOverride = null,
  onActivity,
  onSessionReady,
  emitEvents = false,
  extraCustomTools = [],
  returnDiagnostics = false,
  now = new Date(),
}: { engine?: any; signal?: any; conversationId?: any; conversationType?: string; systemAppend?: any; noMemory?: boolean; toolMode?: string; modelOverride?: any; onActivity?: any; onSessionReady?: any; emitEvents?: boolean; extraCustomTools?: any[]; returnDiagnostics?: boolean; now?: Date } = {}) {
  if (!conversationId) throw new Error("conversationId is required for agent phone session");
  assertAgentPhoneEnabled(engine);

  const agent = await getRuntimeAgent(engine, agentId, "agent-phone-session");
  const agentDir = agent.agentDir;
  await ensureAgentPhoneProjection({
    agentDir,
    agentId,
    conversationId,
    conversationType,
  });

  const ctx = engine.createSessionContext();
  const basePrompt = noMemory ? agent.personality : agent.systemPrompt;
  const currentSystemPrompt = systemAppend ? `${basePrompt}\n\n${systemAppend}` : basePrompt;

  const cwd = engine.getHomeCwd(agentId) || process.cwd();
  const sessionDir = getAgentPhoneSessionDir(agentDir, conversationId);
  fs.mkdirSync(sessionDir, { recursive: true });

  const runtime = readAgentPhoneRuntime(agentDir, conversationId);
  const existingSessionPath = resolveAgentPhoneRuntimeSessionPath(agentDir, runtime);
  const refreshNow = now instanceof Date ? now : new Date(now);
  const existingSessionExists = !!(existingSessionPath && fs.existsSync(existingSessionPath));
  const openedExistingSession = shouldReuseAgentPhoneSession({
    meta: runtime,
    sessionExists: existingSessionExists,
    now: refreshNow,
  });
  const promptSnapshot = openedExistingSession
    ? (normalizeSessionPromptSnapshot(runtime.promptSnapshot)
      || buildAgentPhonePromptSnapshot(agent, ctx, currentSystemPrompt, cwd))
    : buildAgentPhonePromptSnapshot(agent, ctx, currentSystemPrompt, cwd);
  const tempResourceLoader = createPromptSnapshotResourceLoader(ctx.resourceLoader, promptSnapshot);
  const sessionManager = openedExistingSession && existingSessionPath
    ? SessionManager.open(existingSessionPath, sessionDir)
    : SessionManager.create(cwd, sessionDir);
  const identityPath = sessionManager?.getSessionFile?.() || null;
  const sessionRef = establishRuntimeSessionRef(engine, identityPath, {
    ownerAgentId: agentId,
    domain: "phone",
    kind: "phone_conversation",
    lifecycle: "active",
    provenance: {
      createdBy: "agent_phone",
      conversationId,
      conversationType,
    },
    locatorReason: openedExistingSession ? "phone_session_restore" : "phone_session_create",
  }, "runAgentPhoneSession");

  const agentToolsSnapshot = typeof agent.getToolsSnapshot === "function"
    ? agent.getToolsSnapshot({
      forceMemoryEnabled: agent.memoryMasterEnabled !== false,
      ...(typeof agent.experienceEnabled === "boolean"
        ? { forceExperienceEnabled: agent.experienceEnabled === true }
        : {}),
    })
    : agent.tools;
  const phonePermissionMode = getAgentPhonePermissionMode(toolMode);
  const phoneExtraCustomTools = Array.isArray(extraCustomTools)
    ? extraCustomTools.filter(tool => tool && typeof tool.name === "string" && tool.name.trim())
    : [];
  const built = ctx.buildTools(cwd, agentToolsSnapshot, {
    agentDir,
    workspace: engine.getHomeCwd(agentId),
    runtimeSessionRef: sessionRef,
    requireSessionIdentity: true,
    getPermissionMode: () => phonePermissionMode,
    // 拦截分层（#1614）：标记 conversation surface，read_only 拦截时错误提示
    // 指向"会话设置面板可切换"而非通用 plan 模式提示。
    permissionContext: {
      surface: "conversation",
      // These phone-only decisions are already bound by the host to the
      // current channel and revalidate membership before one delivery.
      preAuthorizedRoutineCapabilities: ["channel_reply.post", "channel_pass.decide"],
    },
    extraCustomTools: phoneExtraCustomTools,
  });
  // @ts-expect-error filterAgentPhoneTools signature accepts 1 arg; second arg ({ toolMode }) is unused at runtime
  const { tools, customTools } = filterAgentPhoneTools(built, { toolMode });
  // 频道会话使用作用域化的 search_memory：默认排除其它频道事实，
  // 跨频道检索需显式 cross_channel 参数（#1670 群聊记忆混淆）。
  const scopedMemorySearch = conversationType === "channel"
    && typeof agent.createConversationScopedMemorySearchTool === "function"
    ? agent.createConversationScopedMemorySearchTool({ kind: "channel", channelId: conversationId })
    : null;
  const sessionCustomTools = [
    ...applyConversationScopedMemorySearch(customTools, scopedMemorySearch),
  ];
  const activeToolNames = getAgentPhoneActiveToolNames({
    tools,
    customTools: sessionCustomTools,
  });
  const model = resolveAgentPhoneModel(engine, ctx, agent.config, modelOverride);
  const effectiveModel = agentPhoneModelMeta(model);
  const requestedModelOverride = modelOverride
    ? agentPhoneModelMeta(requireModelRef(modelOverride))
    : null;
  const modelOverrideApplied = !!(modelOverride
    && effectiveModel.provider === requestedModelOverride?.provider
    && effectiveModel.id === requestedModelOverride?.id);
  const { session } = await createAgentSession({
    cwd,
    sessionManager,
    settingsManager: createDefaultSettings(),
    authStorage: ctx.authStorage,
    modelRegistry: ctx.modelRegistry,
    model,
    thinkingLevel: "medium",
    resourceLoader: tempResourceLoader,
    tools,
    customTools: sessionCustomTools,
  });
  installDynamicCompactionReserve(session);
  installMidRunCompaction(session, {
    usageLedger: engine.usageLedger || engine.getUsageLedger?.() || null,
    buildUsageContext: (s: any) => ({
      source: {
        subsystem: "compaction",
        operation: "compact",
        surface: conversationType === "channel" ? "channel" : "dm",
        trigger: "threshold",
      },
      attribution: {
        kind: "phone",
        agentId: agentId || null,
        conversationId,
        conversationType,
        sessionPath: s?.sessionManager?.getSessionFile?.() || null,
      },
    }),
  });
  let sessionPath = null;
  let usageLedger = null;
  let unregisterPhoneAbort = () => {};
  let onAbort;
  let capturedText = "";
  let isCapturing = false;
  let lastLiveActivity = null;
  let toolCallCount = 0;
  const toolCallNames = [];
  let lastPromptResult = null;
  const recordLiveActivity = (key, state, summary, details = {}) => {
    if (!isCapturing || lastLiveActivity === key) return;
    lastLiveActivity = key;
    Promise.resolve(onActivity?.(state, summary, details)).catch(() => {});
  };
  let unsub = null;

  try {
    session.setActiveToolsByName?.(activeToolNames);
    sessionPath = session.sessionManager?.getSessionFile?.() || null;
    if (!sessionPath || path.resolve(sessionPath) !== path.resolve(sessionRef.sessionPath)) {
      const error: any = new Error("runAgentPhoneSession: runtime locator does not match SessionRef");
      error.code = "session_identity_conflict";
      throw error;
    }
    usageLedger = engine.usageLedger || engine.getUsageLedger?.() || null;
    unregisterPhoneAbort = engine.registerAgentPhoneAbortHandler?.(
      () => {
        try { session.abort?.(); } catch {}
      },
      { agentId, conversationId, conversationType, sessionPath },
    ) || (() => {});

    await updateAgentPhoneRuntime({
      agentDir,
      agentId,
      conversationId,
      conversationType,
      patch: {
        phoneSessionFile: storedRelativePath(agentDir, sessionPath),
        lastPhoneSessionUsedAt: refreshNow.toISOString(),
        phoneSessionStartedAt: openedExistingSession
          ? (runtime.phoneSessionStartedAt || refreshNow.toISOString())
          : refreshNow.toISOString(),
        promptSnapshot,
        effectiveModel,
        modelOverrideApplied,
        ...(requestedModelOverride ? { modelOverrideRequested: requestedModelOverride } : {}),
      },
      timestamp: refreshNow.toISOString(),
    });
    await updateAgentPhoneProjectionMeta({
      agentDir,
      agentId,
      conversationId,
      conversationType,
      patch: {
        toolMode,
        effectiveModel,
        modelOverrideApplied,
        ...(requestedModelOverride ? { modelOverrideRequested: requestedModelOverride } : {}),
      },
      timestamp: refreshNow.toISOString(),
    });
    try { await onSessionReady?.(sessionPath); } catch {}

    if (signal) {
      onAbort = () => { try { session.abort(); } catch {} };
      signal.addEventListener("abort", onAbort, { once: true });
    }

    unsub = session.subscribe((event) => {
      recordAgentPhoneAssistantUsage({
        ledger: usageLedger,
        event,
        sessionPath,
        agentId,
        conversationId,
        conversationType,
        model,
      });
      if (emitEvents && sessionPath && isCapturing) {
        engine.emitEvent?.({ ...event, isolated: true }, sessionPath);
      }
      if (!isCapturing) return;
      if (event.type === "message_update") {
        const sub = event.assistantMessageEvent;
        if (sub?.type === "thinking_delta") {
          recordLiveActivity("thinking", "thinking", "正在思考");
        }
        if (sub?.type === "text_delta") {
          recordLiveActivity("composing", "replying", "正在准备回复");
        }
        if (sub?.type === "text_delta") capturedText += sub.delta || "";
      } else if (event.type === "tool_execution_start") {
        toolCallCount++;
        if (event.toolName) toolCallNames.push(event.toolName);
        if (event.toolName === "channel_reply") {
          recordLiveActivity("channel_reply", "replying", "正在发送频道消息");
        } else if (event.toolName === "channel_pass") {
          recordLiveActivity("channel_pass", "no_reply", "正在选择本轮不发言");
        }
      }
    });

    debugLog()?.log("agent-executor", `${agentId} phone session started (${conversationType}:${conversationId}, ${rounds.length} rounds)`);
    for (const round of rounds) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      isCapturing = !!round.capture;
      if (round.capture) {
        capturedText = "";
        lastLiveActivity = null;
      }
      lastPromptResult = await session.prompt(round.text);
    }
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    try { unregisterPhoneAbort(); } catch {}
    await teardownSessionResources({
      session,
      unsub,
      label: `hub.runAgentPhoneSession[${agentId}:${conversationId}]`,
      warn: (msg) => debugLog()?.warn("agent-executor", msg),
    });
  }

  const text = stripClosedInternalNarrationBlocks(capturedText);

  debugLog()?.log("agent-executor", `${agentId} phone done, ${text.length} chars captured`);
  if (returnDiagnostics) {
    return {
      text,
      diagnostics: {
        activeToolNames,
        toolCallCount,
        toolCallNames,
        ordinaryTextLength: text.length,
        rawTextLength: capturedText.length,
        stopReason: lastPromptResult?.stopReason || lastPromptResult?.finishReason || null,
      },
    };
  }
  return text;
}
