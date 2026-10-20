/**
 * automation-tool.js — Agent-created scheduled automations
 *
 * User-facing automations are modeled as Agent runs. The tool returns a
 * pending suggestion (desktop interactive card / bridge text protocol) and
 * writes only when that suggestion is applied.
 */

import { Type, StringEnum } from "../pi-sdk/index.ts";
import { getToolSessionCwd, getToolSessionPath, resolveToolSessionRef } from "./tool-session.ts";
import { createAgentSessionAutomationExecutor } from "../desk/agent-run-automation.ts";
import { applyConfirmedAutomationDraft } from "./automation-draft.ts";
import { parseSessionKey } from "../bridge/session-key.ts";

function normalizeSchedule(params, existing: any = null) {
  const type = params.scheduleType || params.type || existing?.type;
  let schedule = params.schedule ?? existing?.schedule;
  if (!type || schedule === undefined || schedule === null || schedule === "") {
    throw new Error("scheduleType and schedule are required");
  }
  if (type === "every" && params.schedule !== undefined) {
    const minutes = parseInt(schedule, 10);
    if (isNaN(minutes) || minutes <= 0) {
      throw new Error("every schedule must be a positive number of minutes");
    }
    schedule = minutes * 60_000;
  }
  return { type, schedule };
}

function contextForTool(ctx, {
  getSessionPath,
  getAgentId,
  getSessionCwd,
  getSessionWorkspaceFolders,
  getSessionAuthorizedFolders,
  getHomeCwd,
  targetAgentId,
}: {
  getSessionPath?: any;
  getAgentId?: any;
  getSessionCwd?: any;
  getSessionWorkspaceFolders?: any;
  getSessionAuthorizedFolders?: any;
  getHomeCwd?: any;
  targetAgentId?: any;
} = {}) {
  const runtimeSessionRef = resolveToolSessionRef(ctx);
  const sessionId = runtimeSessionRef?.sessionId || null;
  const sessionPath = runtimeSessionRef?.sessionPath
    || getToolSessionPath(ctx)
    || getSessionPath?.()
    || null;
  const sourceAgentId = getAgentId?.() || null;
  const actorAgentId = typeof targetAgentId === "string" && targetAgentId.trim()
    ? targetAgentId.trim()
    : sourceAgentId;
  const usesDifferentAgent = !!actorAgentId && !!sourceAgentId && actorAgentId !== sourceAgentId;
  const sessionCwd = getToolSessionCwd(ctx)
    || (sessionPath ? getSessionCwd?.(sessionPath) : null)
    || null;
  const agentHomeCwd = actorAgentId ? getHomeCwd?.(actorAgentId) : null;
  const cwd = usesDifferentAgent
    ? (agentHomeCwd || null)
    : (sessionCwd || agentHomeCwd || null);
  const workspaceFolders = sessionPath
    ? (usesDifferentAgent ? [] : (getSessionWorkspaceFolders?.(sessionPath) || []))
    : [];
  const authorizedFolders = sessionPath
    ? (usesDifferentAgent ? [] : (getSessionAuthorizedFolders?.(sessionPath) || []))
    : [];
  const bridgeContext = ctx?.bridgeContext?.isBridgeSession === true
    ? ctx.bridgeContext
    : null;
  const bridgeDeliveryTarget = bridgeDeliveryTargetForContext(bridgeContext, actorAgentId);
  const notificationContext = bridgeDeliveryTarget
    ? { bridgeDeliveryTarget }
    : null;
  return {
    sessionId,
    sessionPath,
    bridgeContext,
    notificationContext,
    actorAgentId,
    executionContext: {
      kind: "session_workspace",
      cwd,
      workspaceFolders,
      authorizedFolders,
      sourceSessionId: usesDifferentAgent ? null : sessionId,
      sourceBridgeSessionKey: usesDifferentAgent ? null : bridgeContext?.sessionKey || null,
      sourceSessionPath: usesDifferentAgent ? null : sessionPath,
      createdByAgentId: actorAgentId,
      ...(notificationContext ? { notificationContext } : {}),
    },
  };
}

function bridgeDeliveryTargetForContext(bridgeContext, fallbackAgentId = null) {
  if (bridgeContext?.isBridgeSession !== true) return null;
  if (bridgeContext.role && bridgeContext.role !== "owner") return null;
  if (bridgeContext.chatType && bridgeContext.chatType !== "dm") return null;
  const platform = typeof bridgeContext.platform === "string" && bridgeContext.platform.trim()
    ? bridgeContext.platform.trim()
    : null;
  const chatId = typeof bridgeContext.chatId === "string" && bridgeContext.chatId.trim()
    ? bridgeContext.chatId.trim()
    : null;
  const sessionKey = typeof bridgeContext.sessionKey === "string" && bridgeContext.sessionKey.trim()
    ? bridgeContext.sessionKey.trim()
    : null;
  const parsed = sessionKey ? parseSessionKey(sessionKey) : null;
  const fallbackParts = bridgeSessionKeyFallbackParts(sessionKey);
  const resolvedChatId = chatId || fallbackParts.chatId;
  if (!platform || (!resolvedChatId && !sessionKey)) return null;
  const agentId = typeof bridgeContext.agentId === "string" && bridgeContext.agentId.trim()
    ? bridgeContext.agentId.trim()
    : (parsed?.agentId || fallbackParts.agentId || (typeof fallbackAgentId === "string" && fallbackAgentId.trim() ? fallbackAgentId.trim() : null));
  return {
    kind: "bridge",
    platform,
    chatType: "dm",
    ...(resolvedChatId ? { chatId: resolvedChatId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(agentId ? { agentId } : {}),
  };
}

function bridgeSessionKeyFallbackParts(sessionKey) {
  const value = typeof sessionKey === "string" ? sessionKey.trim() : "";
  if (!value) return { chatId: null, agentId: null };
  const atIndex = value.lastIndexOf("@");
  const head = atIndex >= 0 ? value.slice(0, atIndex) : value;
  const agentId = atIndex >= 0 && value.slice(atIndex + 1).trim()
    ? value.slice(atIndex + 1).trim()
    : null;
  const match = head.match(/^(?:wechat|wx|telegram|tg|feishu|fs|dingtalk|dt|qq)_dm_(.+)$/);
  return {
    chatId: match?.[1] || null,
    agentId,
  };
}

function targetAgentIdFor(params, fallbackAgentId) {
  return typeof params.agentId === "string" && params.agentId.trim()
    ? params.agentId.trim()
    : fallbackAgentId;
}

/**
 * Agent 可见的"建议已登记，等待用户确认"文案（#1619）。
 *
 * 文本指令平台（微信等 bridge）没有可点击的确认卡片：必须告诉 Agent
 * 真实的确认协议是用户回复 /apply（bridge 出站层还会把建议详情和
 * /apply 指引附加在 Agent 回复之后，见 core/bridge-session-manager.ts
 * 的 formatAutomationSuggestionText），否则 Agent 会沿用桌面认知，
 * 反复引导用户"点击确认按钮"。桌面端（无 bridgeContext）文案不变。
 */
function pendingSuggestionText(bridgeContext = null, suggestion = null) {
  if (bridgeContext?.interactionCapabilities?.confirmationMode === "text_command" && suggestion) {
    const shortCode = typeof suggestion.shortCode === "string" && suggestion.shortCode.trim()
      ? suggestion.shortCode.trim()
      : "";
    const applyVariants = shortCode ? `/apply 或 /apply ${shortCode}` : "/apply";
    return `我准备了一项自动任务建议${shortCode ? `（建议ID：${shortCode}）` : ""}，建议详情和「回复 /apply 创建」的指引会自动附加在本次回复之后发给用户。`
      + `当前平台是纯文本对话，没有可点击的确认卡片或按钮：任务只会在用户回复 ${applyVariants} 之后创建，回复「确认」等普通文字不会生效。`
      + "如果用户还没创建，请引导对方回复 /apply，不要让用户点击任何按钮或卡片。";
  }
  return "我准备了一项自动任务建议，等你确认后再创建。";
}

function labelFor(params, prompt = "", existing: any = null) {
  if (typeof params.label === "string" && params.label.trim()) return params.label;
  if (typeof existing?.label === "string" && existing.label.trim()) return existing.label;
  return typeof prompt === "string" ? prompt.slice(0, 40) : "";
}

function isDraftMutationAction(params) {
  return params?.action === "create" || params?.action === "update";
}

function automationDraftSideEffect() {
  return {
    kind: "deferred_mutation_draft",
    commit: "requires_user_confirmation",
    ruleId: "automation-draft-no-write",
    summary: "Automation create/update generates a pending suggestion; cron store writes only after the suggestion is applied.",
  };
}

function automationDirectCommitSideEffect(operation) {
  return {
    kind: "automation_configuration_mutation",
    operation,
    summary: `Directly ${operation === "update" ? "update" : "create"} a scheduled automation.`,
  };
}

function genericAgentRun(params, context, existing: any = null) {
  const prompt = typeof params.prompt === "string" && params.prompt.trim()
    ? params.prompt
    : (typeof existing?.prompt === "string" ? existing.prompt : "");
  if (!prompt) throw new Error("prompt is required");
  const model = params.model ?? existing?.model ?? "";
  const existingActorAgentId = typeof existing?.actorAgentId === "string" && existing.actorAgentId.trim()
    ? existing.actorAgentId.trim()
    : typeof existing?.executor?.agentId === "string" && existing.executor.agentId.trim()
      ? existing.executor.agentId.trim()
      : null;
  const executionContext = existing
    && existingActorAgentId === context.actorAgentId
    && existing.executionContext
    ? existing.executionContext
    : context.executionContext;
  return {
    prompt,
    executor: createAgentSessionAutomationExecutor({
      agentId: context.actorAgentId,
      prompt,
      model,
      executionContext,
    }),
  };
}

function jobDataFieldsForMutation(jobData) {
  const fields = { ...(jobData || {}) };
  for (const key of [
    "id",
    "createdAt",
    "lastRunAt",
    "nextRunAt",
    "consecutiveErrors",
    "legacyRef",
    "studioId",
    "configRevision",
    "authorization",
    "requestedGrants",
  ]) {
    delete fields[key];
  }
  return fields;
}

function commitAutomationDraft({ cronStore, operation, jobData, confirmationValue, confirmation, getHomeCwd }: {
  cronStore: any;
  operation: "create" | "update";
  jobData: any;
  confirmationValue?: any;
  confirmation?: { suggestionId?: string; confirmedAt?: string; receipt?: object } | null;
  getHomeCwd?: ((agentId: string | null) => string | null) | null;
}) {
  const confirmedJobData = applyConfirmedAutomationDraft(
    jobData,
    confirmationValue,
    { getHomeCwd },
  ) as any;
  const suggestionReceipt = confirmation?.receipt || null;
  const writeOptions = suggestionReceipt ? { suggestionReceipt } : {};
  if (operation === "update") {
    if (!confirmedJobData?.id) throw new Error("id is required");
    const fields = jobDataFieldsForMutation(confirmedJobData);
    return suggestionReceipt
      ? cronStore.updateJob(confirmedJobData.id, fields, writeOptions)
      : cronStore.updateJob(confirmedJobData.id, fields);
  }
  const fields = jobDataFieldsForMutation(confirmedJobData);
  return suggestionReceipt
    ? cronStore.addJob(fields, writeOptions)
    : cronStore.addJob(fields);
}

function suggestionDetails({ suggestion, operation, jobData, jobs }: {
  suggestion?: any;
  operation: "create" | "update";
  jobData: any;
  jobs: any;
}) {
  const suggestionId = suggestion?.suggestionId || "";
  const shortCode = suggestion?.shortCode || suggestion?.suggestionShortCode || "";
  return {
    action: operation === "update" ? "pending_update" : "pending_add",
    operation,
    jobs,
    jobData,
    suggestionId,
    suggestionShortCode: shortCode,
    automationSuggestion: {
      suggestionId,
      shortCode,
      operation,
      jobData,
    },
  };
}

export function createAutomationTool(cronStore, {
  getAutoApprove,
  autoApprove = false,
  automationSuggestionStore,
  getAutomationSuggestionStore,
  getSessionPath,
  getAgentId,
  getSessionCwd,
  getSessionWorkspaceFolders,
  getSessionAuthorizedFolders,
  getHomeCwd,
}: {
  getAutoApprove?: any;
  autoApprove?: boolean;
  confirmStore?: any;
  getConfirmStore?: any;
  automationSuggestionStore?: any;
  getAutomationSuggestionStore?: any;
  emitEvent?: any;
  getSessionPath?: any;
  getAgentId?: any;
  getSessionCwd?: any;
  getSessionWorkspaceFolders?: any;
  getSessionAuthorizedFolders?: any;
  getHomeCwd?: any;
} = {}) {
  return {
    name: "automation",
    label: "Automation",
    description: "Create and update scheduled automation suggestions. The suggestion is presented to the user for confirmation — an interactive card on desktop, or a reply-with-/apply text instruction on text-only bridge platforms — and the task is written only after the user applies it. Automations run as background Agent sessions.",
    sessionPermission: {
      resolveInvocation: (params: any = {}) => {
        if (params.action === "list") {
          return { action: "list", kind: "read", capability: "automation.list" };
        }
        if (isDraftMutationAction(params)) {
          const directlyCommits = getAutoApprove ? getAutoApprove() === true : autoApprove === true;
          return {
            action: params.action,
            kind: directlyCommits ? "review" : "routine",
            capability: `automation.${params.action}`,
            sideEffect: directlyCommits
              ? automationDirectCommitSideEffect(params.action)
              : automationDraftSideEffect(),
          };
        }
        return null;
      },
      describeSideEffect: (params) => {
        if (!isDraftMutationAction(params)) return null;
        const directlyCommits = getAutoApprove ? getAutoApprove() === true : autoApprove === true;
        return directlyCommits ? null : automationDraftSideEffect();
      },
    },
    parameters: Type.Object({
      action: StringEnum(["list", "create", "update"], {
        description: "Action to perform. create and update produce a pending suggestion instead of directly saving.",
      }),
      id: Type.Optional(Type.String({ description: "Automation job id for update." })),
      agentId: Type.Optional(Type.String({ description: "Target Agent id. Defaults to the current Agent." })),
      scheduleType: Type.Optional(StringEnum(["at", "every", "cron"], {
        description: "Trigger type for create/update actions.",
      })),
      schedule: Type.Optional(Type.String({
        description: "Trigger schedule. For every, use minutes. For cron, use a 5-field cron expression.",
      })),
      label: Type.Optional(Type.String({ description: "Short display label." })),
      prompt: Type.Optional(Type.String({ description: "What the target Agent should do when this automation runs." })),
      model: Type.Optional(Type.Any({ description: "Optional execution model for the background Agent run." })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const activeCronStore = typeof cronStore?.captureCurrent === "function"
        ? cronStore.captureCurrent()
        : cronStore;
      try {
        if (params.action === "list") {
          const jobs = activeCronStore.listJobs();
          return { content: [{ type: "text", text: JSON.stringify(jobs, null, 2) }], details: { action: "list", jobs } };
        }

        if (!["create", "update"].includes(params.action)) {
          throw new Error(`unknown automation action: ${params.action}`);
        }

        const operation = params.action === "update" ? "update" : "create";
        const existingJob = operation === "update"
          ? activeCronStore.getJob?.(params.id)
          : null;
        if (operation === "update" && !params.id) throw new Error("id is required");
        if (operation === "update" && !existingJob) throw new Error(`Automation not found: ${params.id}`);
        const sourceAgentId = getAgentId?.() || null;
        const targetAgentId = targetAgentIdFor(params, existingJob?.actorAgentId || sourceAgentId);
        const context = contextForTool(ctx, {
          getSessionPath,
          getAgentId,
          getSessionCwd,
          getSessionWorkspaceFolders,
          getSessionAuthorizedFolders,
          getHomeCwd,
          targetAgentId,
        });
        const { type, schedule } = normalizeSchedule(params, existingJob);
        const run = genericAgentRun(params, context, existingJob);
        const jobData = {
          ...(existingJob || {}),
          ...(activeCronStore?.studioId ? { studioId: activeCronStore.studioId } : {}),
          type,
          schedule,
          prompt: run.prompt,
          label: labelFor(params, run.prompt, existingJob),
          model: params.model ?? existingJob?.model ?? "",
          actorAgentId: context.actorAgentId,
          executionContext: run.executor.executionContext,
          executor: run.executor,
          createdBy: {
            kind: "agent",
            agentId: context.actorAgentId,
            sourceSessionId: context.sessionId,
            sourceBridgeSessionKey: context.bridgeContext?.sessionKey || null,
            sourceSessionPath: context.sessionPath,
          },
        };
        delete jobData.authorization;
        delete jobData.requestedGrants;

        if (getAutoApprove ? getAutoApprove() : autoApprove) {
          const job = commitAutomationDraft({ cronStore: activeCronStore, operation, jobData, getHomeCwd });
          return {
            content: [{ type: "text", text: `Automation ${operation === "update" ? "updated" : "created"}: ${job.label} (${job.id})` }],
            details: { action: operation === "update" ? "updated" : "added", operation, job, jobs: activeCronStore.listJobs(), jobData, confirmed: true },
          };
        }

        const runtimeSuggestionStore = getAutomationSuggestionStore?.() || automationSuggestionStore || null;
        const bridgeSessionKey = typeof context.bridgeContext?.sessionKey === "string"
          && context.bridgeContext.sessionKey.trim()
          ? context.bridgeContext.sessionKey.trim()
          : null;
        let suggestion = null;
        const canCreateSuggestion = !!bridgeSessionKey || !!context.sessionId;
        if (runtimeSuggestionStore?.create && canCreateSuggestion) {
          suggestion = runtimeSuggestionStore.create({
            sessionId: context.sessionId,
            sessionPath: context.sessionPath,
            bridgeSessionKey,
            studioId: activeCronStore?.studioId || null,
            operation,
            jobId: operation === "update" ? existingJob?.id || null : null,
            baseConfigRevision: operation === "update" ? existingJob?.configRevision || null : null,
            jobData,
            apply: (value, confirmation) => commitAutomationDraft({
              cronStore: activeCronStore,
              operation,
              jobData,
              confirmationValue: value,
              confirmation,
              getHomeCwd,
            }),
          });
        }

        return {
          content: [{ type: "text", text: pendingSuggestionText(context.bridgeContext, suggestion) }],
          details: suggestionDetails({
            suggestion,
            operation,
            jobs: activeCronStore.listJobs(),
            jobData,
          }),
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: err.message }],
          details: { action: params.action, error: err.message, jobs: activeCronStore.listJobs() },
        };
      }
    },
  };
}
