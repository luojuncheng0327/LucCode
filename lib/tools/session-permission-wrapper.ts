import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import {
  classifySessionPermission,
  normalizeSessionPermissionMode,
  resolveSessionApprovalPolicy,
  SESSION_APPROVAL_POLICIES,
  SESSION_PERMISSION_MODES,
} from "../../core/session-permission-mode.ts";
import { getToolSessionPath, normalizeToolRuntimeContext } from "./tool-session.ts";
import { toolError } from "./tool-result.ts";
import { t } from "../i18n.ts";
import {
  evaluateToolSafetyPolicy,
  prepareStageFilesExecutionParams,
} from "../permission/safety-policy.ts";
import { buildApprovalReviewContext } from "../permission/approval-review-context.ts";
import {
  cloneToolInvocationInput,
  resolveToolInvocationPermission,
  snapshotToolInvocationInput,
} from "../permission/tool-invocation-permission.ts";

const EXTERNAL_APPROVAL_TARGET_TYPES = new Set([
  "url",
  "browser_tab",
  "domain",
  "channel",
  "channel_draft",
  "agent",
  "notification_route",
]);

function findRuntimeCtx(args: any[]) {
  const normalized = normalizeToolRuntimeContext(args[2], args[4]);
  if (normalized.hasExplicitCtx) {
    return {
      ctx: normalized.ctx,
      index: args[4] && typeof args[4] === "object" ? 4 : 2,
    };
  }
  for (let i = args.length - 1; i >= 2; i--) {
    const value = args[i];
    if (value && typeof value === "object" && (value.sessionManager || value.sessionRef || value.sessionId || value.sessionPath || value.agentId || value.model)) {
      return { ctx: value, index: i };
    }
  }
  return { ctx: null, index: -1 };
}

function nonEmptyText(value: any) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizedSessionPath(value: any) {
  const sessionPath = nonEmptyText(value);
  return sessionPath ? path.resolve(sessionPath) : null;
}

function snapshotRuntimeAuthority(value: any, field: string) {
  if (value == null) return { ok: true, value: null } as const;
  const snapshot = snapshotToolInvocationInput(value);
  if (
    snapshot.ok === false
    || !snapshot.value
    || typeof snapshot.value !== "object"
    || Array.isArray(snapshot.value)
  ) {
    return { ok: false, reason: `invalid-${field}` } as const;
  }
  return { ok: true, value: snapshot.value } as const;
}

function captureSessionBinding(ctx: any, deps: any = {}) {
  try {
    const sessionManager = ctx?.sessionManager;
    const explicitLocators = [
      normalizedSessionPath(ctx?.sessionRef?.sessionPath),
      normalizedSessionPath(ctx?.sessionPath),
      normalizedSessionPath(getToolSessionPath(ctx)),
    ].filter(Boolean);
    const uniqueLocators = new Set(explicitLocators);
    if (uniqueLocators.size > 1) {
      return { ok: false, reason: "conflicting-session-locators" } as const;
    }
    const sessionPath = explicitLocators[0]
      || normalizedSessionPath(deps.getSessionPath?.())
      || null;
    const resolvedSessionId = sessionPath && typeof deps.getSessionIdForPath === "function"
      ? nonEmptyText(deps.getSessionIdForPath(sessionPath))
      : null;
    // SessionManager owns a runtime-native identifier (for example, a Pi JSONL
    // ID), not Luc's SessionManifest identity. Freeze it independently so
    // approval revalidation detects runtime drift without comparing namespaces.
    const runtimeNativeSessionId = typeof sessionManager?.getSessionId === "function"
      ? nonEmptyText(sessionManager.getSessionId())
      : null;
    const identityCandidates = [
      nonEmptyText(ctx?.sessionRef?.sessionId),
      nonEmptyText(ctx?.sessionId),
      resolvedSessionId,
    ].filter(Boolean);
    const uniqueSessionIds = new Set(identityCandidates);
    if (uniqueSessionIds.size > 1) {
      return { ok: false, reason: "conflicting-session-identities" } as const;
    }
    const bridgeContext = snapshotRuntimeAuthority(ctx?.bridgeContext, "bridge-context");
    if (bridgeContext.ok === false) return bridgeContext;
    const notificationContext = snapshotRuntimeAuthority(ctx?.notificationContext, "notification-context");
    if (notificationContext.ok === false) return notificationContext;
    return {
      ok: true,
      value: Object.freeze({
        sessionId: identityCandidates[0] || null,
        runtimeNativeSessionId,
        sessionPath,
        sessionCwd: typeof sessionManager?.getCwd === "function"
          ? normalizedSessionPath(sessionManager.getCwd())
          : null,
        bridgeContext: bridgeContext.value,
        notificationContext: notificationContext.value,
      }),
    } as const;
  } catch {
    return { ok: false, reason: "session-binding-resolution-failed" } as const;
  }
}

function createBoundSessionManager(sessionManager: any, sessionBinding: any) {
  if (!sessionManager || (typeof sessionManager !== "object" && typeof sessionManager !== "function")) {
    return sessionManager;
  }
  type ManagerMethod = (...args: unknown[]) => unknown;
  const forwardedMethods = new Map<PropertyKey, ManagerMethod>();
  const fixedMethods = new Map<PropertyKey, ManagerMethod>([
    ["getSessionFile", () => sessionBinding.sessionPath],
    ["getSessionId", () => sessionBinding.runtimeNativeSessionId],
    ["getCwd", () => sessionBinding.sessionCwd],
  ]);
  const facade = Object.create(Object.getPrototypeOf(sessionManager));
  return new Proxy(facade, {
    get(_target, property) {
      const fixed = fixedMethods.get(property);
      if (fixed) return fixed;
      const value = Reflect.get(sessionManager, property, sessionManager);
      if (typeof value !== "function") return value;
      let forwarded = forwardedMethods.get(property);
      if (!forwarded) {
        forwarded = value.bind(sessionManager);
        forwardedMethods.set(property, forwarded);
      }
      return forwarded;
    },
  });
}

function createBoundRuntimeCtx(ctx: any, sessionBinding: any) {
  if (!ctx || typeof ctx !== "object") return ctx;
  const boundCtx = Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx);
  const wasEnumerable = (property: PropertyKey) => Object.prototype.propertyIsEnumerable.call(ctx, property);
  const boundSessionRef = ctx.sessionRef || sessionBinding.sessionId || sessionBinding.sessionPath
    ? Object.freeze({
      sessionId: sessionBinding.sessionId,
      sessionPath: sessionBinding.sessionPath,
    })
    : null;
  const fixedFields: PropertyDescriptorMap = {
    sessionId: {
      value: sessionBinding.sessionId,
      enumerable: wasEnumerable("sessionId"),
      writable: false,
      configurable: false,
    },
    sessionPath: {
      value: sessionBinding.sessionPath,
      enumerable: wasEnumerable("sessionPath"),
      writable: false,
      configurable: false,
    },
  };
  for (const field of ["bridgeContext", "notificationContext"] as const) {
    if (Object.prototype.hasOwnProperty.call(ctx, field) || sessionBinding[field] != null) {
      fixedFields[field] = {
        value: sessionBinding[field],
        enumerable: wasEnumerable(field),
        writable: false,
        configurable: false,
      };
    }
  }
  if (boundSessionRef) {
    fixedFields.sessionRef = {
      value: boundSessionRef,
      enumerable: wasEnumerable("sessionRef"),
      writable: false,
      configurable: false,
    };
  }
  if (ctx.sessionManager) {
    fixedFields.sessionManager = {
      value: createBoundSessionManager(ctx.sessionManager, sessionBinding),
      enumerable: wasEnumerable("sessionManager"),
      writable: false,
      configurable: false,
    };
  }
  Object.defineProperties(boundCtx, fixedFields);
  return boundCtx;
}

function buildToolApprovalRequest(confirmId: any, toolName: any, params: any) {
  return {
    type: "session_confirmation",
    confirmId,
    kind: "tool_action_approval",
    surface: "input",
    status: "pending",
    title: t("approval.toolAction.title"),
    body: t("approval.toolAction.body"),
    subject: {
      label: toolName,
      detail: summarizeParams(params),
    },
    severity: "elevated",
    actions: {
      confirmLabel: t("approval.confirm"),
      rejectLabel: t("approval.reject"),
    },
    payload: { toolName, params },
  };
}

function buildToolApprovalGatewayRequest(toolName: any, params: any, sessionPath: any, stableKey: any, ctx: any = null, deps: any = {}, invocation: any = null, legacySessionPermission: any = null) {
  const target = invocation?.target
    ? {
      type: invocation.target.type,
      id: invocation.target.id,
      label: invocation.target.label || invocation.target.id,
    }
    : approvalTargetForTool(toolName, params);
  const sideEffect = approvalSideEffectForTool(params, invocation, legacySessionPermission);
  return {
    id: `${stableKey || "session"}:${toolName}:${Date.now()}`,
    kind: "tool_action",
    sessionPath,
    agentId: deps.agentId || ctx?.agentId || null,
    toolName,
    actionName: invocation?.action || (typeof params?.action === "string" ? params.action : "execute"),
    params: params && typeof params === "object" ? params : {},
    target,
    blastRadius: EXTERNAL_APPROVAL_TARGET_TYPES.has(target.type) ? "external" : "workspace",
    reversibility: toolName === "bash" || toolName === "exec_command" || toolName === "terminal" || toolName === "write_stdin" ? "unknown" : "moderate",
    ...(sideEffect ? { sideEffect } : {}),
  };
}

function approvalTargetForTool(toolName: any, params: any = {}) {
  const command = typeof params.command === "string"
    ? params.command
    : typeof params.cmd === "string"
      ? params.cmd
      : "";
  if (command) return { type: "command", label: command };
  const path = typeof params.path === "string" ? params.path : typeof params.file_path === "string" ? params.file_path : "";
  if (path) return { type: "file", label: path, path };
  const url = typeof params.url === "string" ? params.url : "";
  if (url) return { type: "url", label: url, url };
  const label = typeof params.label === "string" && params.label.trim()
    ? params.label.trim()
    : toolName;
  return { type: "tool", label };
}

function approvalSideEffectForTool(params: any, invocation: any = null, legacySessionPermission: any = null) {
  if (invocation) {
    return invocation.sideEffect && typeof invocation.sideEffect === "object"
      ? invocation.sideEffect
      : null;
  }
  const describe = legacySessionPermission?.describeSideEffect;
  const sideEffect = typeof describe === "function"
    ? describe(params)
    : legacySessionPermission?.sideEffect;
  return sideEffect && typeof sideEffect === "object" ? sideEffect : null;
}

function permissionContextForTool(tool: any, deps: any = {}, invocation: any = null, legacySessionPermission: any = null) {
  const base = deps.permissionContext && typeof deps.permissionContext === "object"
    ? deps.permissionContext
    : {};
  const hostContext = { ...base };
  delete hostContext.toolInvocation;
  delete hostContext.toolSessionPermission;
  delete hostContext.sessionPermission;
  const toolSessionPermission = legacySessionPermission && typeof legacySessionPermission === "object"
    ? legacySessionPermission
    : null;
  return {
    ...hostContext,
    ...(toolSessionPermission ? { toolSessionPermission } : {}),
    ...(tool?._pluginId ? { isPluginTool: true, pluginId: tool._pluginId } : {}),
    ...(invocation ? { toolInvocation: invocation } : {}),
  };
}

async function executeWithInvocationRevalidation(
  tool: any,
  args: any[],
  params: any,
  expectedInvocation: any,
  mode: any,
  deps: any,
  ctx: any,
  expectedSessionBinding: any,
  executionCtx: any,
  runtimeCtxIndex: number,
  legacySessionPermission: any,
  revalidateAfterWait = true,
) {
  if (revalidateAfterWait) {
    const currentSessionBinding = captureSessionBinding(ctx, deps);
    if (
      currentSessionBinding.ok === false
      || !isDeepStrictEqual(currentSessionBinding.value, expectedSessionBinding)
    ) {
      return toolError("Tool session context changed before execution.", {
        errorCode: "TOOL_SESSION_CONTEXT_CHANGED_BEFORE_EXECUTION",
        ...(currentSessionBinding.ok === false
          ? { sessionContextReason: currentSessionBinding.reason }
          : {}),
        permissionMode: mode,
        toolName: tool.name,
      });
    }
    const current = resolveToolInvocationPermission(tool, params);
    if (current.ok === false) {
      return toolError("Tool invocation could not be revalidated before execution.", {
        errorCode: current.error.code,
        resolverReason: current.error.reason,
        ...(current.error.field ? { resolverField: current.error.field } : {}),
        permissionMode: mode,
        toolName: tool.name,
      });
    }
    if (
      expectedInvocation
      && (current.source !== "descriptor" || !isDeepStrictEqual(current.descriptor, expectedInvocation))
    ) {
      return toolError("Tool invocation target changed before execution and must be reviewed again.", {
        errorCode: "TOOL_INVOCATION_CHANGED_BEFORE_EXECUTION",
        permissionMode: mode,
        toolName: tool.name,
      });
    }
    if (!expectedInvocation && current.source !== "legacy") {
      return toolError("Tool invocation permission source changed before execution.", {
        errorCode: "TOOL_INVOCATION_CHANGED_BEFORE_EXECUTION",
        permissionMode: mode,
        toolName: tool.name,
      });
    }
    if (
      !expectedInvocation
      && current.source === "legacy"
      && !isDeepStrictEqual(current.sessionPermission, legacySessionPermission)
    ) {
      return toolError("Tool invocation permission changed before execution.", {
        errorCode: "TOOL_INVOCATION_CHANGED_BEFORE_EXECUTION",
        permissionMode: mode,
        toolName: tool.name,
      });
    }
  }

  const executionParams = cloneToolInvocationInput(params);
  if (executionParams.ok === false) {
    return toolError("Tool invocation parameters could not be copied safely before execution.", {
      errorCode: "TOOL_INVOCATION_INPUT_INVALID",
      inputReason: executionParams.reason,
      permissionMode: mode,
      toolName: tool.name,
    });
  }
  const preparedExecution = prepareStageFilesExecutionParams({
    toolName: tool.name,
    params: executionParams.value,
  }, deps.permissionBoundary);
  if (preparedExecution.ok === false) {
    return toolError(preparedExecution.error.reason, {
      errorCode: preparedExecution.error.code,
      permissionMode: mode,
      toolName: tool.name,
      reviewer: preparedExecution.error.reviewer,
      risk: preparedExecution.error.risk,
      ruleIds: preparedExecution.error.ruleIds,
    });
  }
  const executionArgs = [...args];
  executionArgs[1] = preparedExecution.params;
  if (runtimeCtxIndex >= 0) executionArgs[runtimeCtxIndex] = executionCtx;
  return tool.execute(...executionArgs);
}

function summarizeParams(params: any) {
  if (!params || typeof params !== "object") return "";
  const keys = ["action", "path", "file_path", "command", "cmd", "process_id", "url", "key", "label"];
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) return `${key}: ${value.trim().slice(0, 160)}`;
  }
  return "";
}

function toStatus(action: any) {
  if (action === "confirmed") return "confirmed";
  if (action === "timeout") return "timeout";
  if (action === "aborted") return "aborted";
  return "rejected";
}

async function askForToolApproval(toolName: any, params: any, sessionPath: any, deps: any) {
  const confirmStore = deps.getConfirmStore?.() || deps.confirmStore || null;
  if (!confirmStore || !sessionPath) {
    return { allowed: false, status: "rejected", confirmId: "", reason: "confirmation-unavailable" };
  }
  const { confirmId, promise } = confirmStore.create(
    "tool_action_approval",
    { toolName, params },
    sessionPath,
  );
  deps.emitEvent?.({
    type: "session_confirmation",
    request: buildToolApprovalRequest(confirmId, toolName, params),
  }, sessionPath);
  const decision = await promise;
  const status = toStatus(decision?.action);
  return {
    allowed: status === "confirmed",
    status,
    confirmId,
  };
}

async function reviewToolApproval(toolName: any, params: any, sessionPath: any, deps: any, ctx: any = null, sessionBinding: any = null, invocation: any = null, legacySessionPermission: any = null) {
  const gateway = deps.getApprovalGateway?.() || deps.approvalGateway || null;
  if (!gateway || typeof gateway.review !== "function") {
    return {
      allowed: false,
      status: "ask_user",
      reason: "approval-gateway-unavailable",
      reasonCode: "approval_gateway_unavailable",
    };
  }
  const request = buildToolApprovalGatewayRequest(toolName, params, sessionPath, sessionBinding?.sessionId || sessionPath || "session", ctx, deps, invocation, legacySessionPermission);
  const decision = await gateway.review(request, buildApprovalReviewContext({
    source: deps,
    ctx,
    sessionPath,
    agentId: request.agentId,
  }));
  if (decision?.action === "allow") {
    return { allowed: true, status: "approved", decision };
  }
  if (decision?.action === "ask_user") {
    return {
      allowed: false,
      status: "ask_user",
      decision,
      reason: decision.reason,
      reasonCode: decision.reasonCode,
    };
  }
  return {
    allowed: false,
    status: decision?.action === "hard_deny" ? "blocked" : "denied",
    decision,
    reasonCode: decision?.reasonCode,
    reason: decision?.reason
      ? `session permission auto-review: ${decision.reason}`
      : "session permission auto-review denied this action",
  };
}

function resolveToolPermissionMode(deps: any, sessionPath: any) {
  if (typeof deps.getPermissionMode !== "function") return SESSION_PERMISSION_MODES.AUTO;
  const scoped = deps.getPermissionMode(sessionPath);
  const raw = scoped ?? deps.getPermissionMode();
  if (raw == null) return SESSION_PERMISSION_MODES.AUTO;
  return normalizeSessionPermissionMode(raw);
}

function toolApprovalUnavailable(toolName: any, status = "needs_user_approval_but_unavailable", reason = "human approval unavailable", extras: any = {}) {
  return toolError("Tool action needs user approval, but this execution context cannot ask the user.", {
    errorCode: "TOOL_APPROVAL_UNAVAILABLE",
    action: toolName,
    confirmed: false,
    confirmation: {
      kind: "tool_action_approval",
      status,
      toolName,
      reason,
      reasonCode: "human_approval_unavailable",
      approvalPolicy: SESSION_APPROVAL_POLICIES.DENY_ON_PROMPT,
      ...extras,
    },
  });
}

export function wrapWithSessionPermission(tools: any[] = [], deps: any = {}) {
  return tools.map((tool: any) => {
    if (!tool?.execute) return tool;
    return {
      ...tool,
      execute: async (...args: any[]) => {
        const inputSnapshot = snapshotToolInvocationInput(args[1] == null ? {} : args[1]);
        if (inputSnapshot.ok === false) {
          return toolError("Tool invocation parameters must be bounded plain JSON data.", {
            errorCode: "TOOL_INVOCATION_INPUT_INVALID",
            inputReason: inputSnapshot.reason,
            toolName: tool.name,
          });
        }
        const params = inputSnapshot.value;
        const runtimeCtx = findRuntimeCtx(args);
        const ctx = runtimeCtx.ctx;
        const runtimeCtxIndex = runtimeCtx.index;
        const sessionBinding = captureSessionBinding(ctx, deps);
        if (sessionBinding.ok === false) {
          return toolError("Tool session context could not be bound safely.", {
            errorCode: "TOOL_SESSION_CONTEXT_INVALID",
            sessionContextReason: sessionBinding.reason,
            toolName: tool.name,
          });
        }
        const executionCtx = createBoundRuntimeCtx(ctx, sessionBinding.value);
        const sessionPath = sessionBinding.value.sessionPath;
        const mode = resolveToolPermissionMode(deps, sessionPath);
        // Raw hard-safety checks run before any tool-owned resolver. A hostile
        // resolver therefore cannot hide a blocked delivery path.
        const rawSafety = evaluateToolSafetyPolicy({
          toolName: tool.name,
          params,
        }, deps.permissionBoundary);
        if (rawSafety?.action === "block") {
          return toolError(rawSafety.reason, {
            errorCode: rawSafety.code,
            permissionMode: mode,
            toolName: tool.name,
            reviewer: rawSafety.reviewer,
            risk: rawSafety.risk,
            ruleIds: rawSafety.ruleIds,
          });
        }
        const invocationResolution = resolveToolInvocationPermission(tool, params);
        if (invocationResolution.ok === false) {
          return toolError(invocationResolution.error.message, {
            errorCode: invocationResolution.error.code,
            resolverReason: invocationResolution.error.reason,
            ...(invocationResolution.error.field ? { resolverField: invocationResolution.error.field } : {}),
            permissionMode: mode,
            toolName: tool.name,
          });
        }
        const invocation = invocationResolution.source === "descriptor"
          ? invocationResolution.descriptor
          : null;
        const legacySessionPermission = invocationResolution.source === "legacy"
          ? invocationResolution.sessionPermission
          : null;
        const approvalPolicy = resolveSessionApprovalPolicy({
          mode,
          approvalPolicy: deps.approvalPolicy,
          allowHumanApproval: deps.allowHumanApproval,
        });
        const decision: any = classifySessionPermission({
          mode,
          toolName: tool.name,
          params,
          context: permissionContextForTool(
            tool,
            deps,
            invocation,
            legacySessionPermission,
          ),
        });
        if (decision.action === "allow") {
          return executeWithInvocationRevalidation(
            tool,
            args,
            params,
            invocation,
            mode,
            deps,
            ctx,
            sessionBinding.value,
            executionCtx,
            runtimeCtxIndex,
            legacySessionPermission,
            false,
          );
        }
        if (decision.action === "deny") {
          return toolError(decision.message, {
            errorCode: decision.code,
            permissionMode: mode,
            toolName: tool.name,
            ...(decision.details || {}),
          });
        }
        if (decision.action === "review") {
          const reviewerParams = cloneToolInvocationInput(params);
          if (reviewerParams.ok === false) {
            return toolError("Tool invocation parameters could not be copied for review.", {
              errorCode: "TOOL_INVOCATION_INPUT_INVALID",
              inputReason: reviewerParams.reason,
              permissionMode: mode,
              toolName: tool.name,
            });
          }
          const review = await reviewToolApproval(tool.name, reviewerParams.value, sessionPath, deps, executionCtx, sessionBinding.value, invocation, legacySessionPermission);
          if (review.allowed) {
            return executeWithInvocationRevalidation(
              tool,
              args,
              params,
              invocation,
              mode,
              deps,
              ctx,
              sessionBinding.value,
              executionCtx,
              runtimeCtxIndex,
              legacySessionPermission,
            );
          }
          if (review.status !== "ask_user") {
            return toolError("Tool action was not approved.", {
              errorCode: "TOOL_APPROVAL_DENIED",
              action: tool.name,
              confirmed: false,
              confirmation: {
                kind: "tool_action_approval",
                status: review.status,
                toolName: tool.name,
                reason: review.reason,
                reasonCode: review.reasonCode,
                reviewer: review.decision?.reviewer,
                risk: review.decision?.risk,
                reviewerFailures: review.decision?.reviewerFailures,
              },
            });
          }
          if (approvalPolicy === SESSION_APPROVAL_POLICIES.DENY_ON_PROMPT) {
            return toolApprovalUnavailable(tool.name, "needs_user_approval_but_unavailable", review.reason || "human approval unavailable", {
              reviewStatus: "ask_user",
              reasonCode: review.reasonCode || review.decision?.reasonCode || "approval_reviewer_unavailable",
              reviewer: review.decision?.reviewer,
              risk: review.decision?.risk,
              reviewerFailures: review.decision?.reviewerFailures,
            });
          }
        }

        if (approvalPolicy === SESSION_APPROVAL_POLICIES.DENY_ON_PROMPT) {
          return toolApprovalUnavailable(tool.name);
        }
        const approvalParams = cloneToolInvocationInput(params);
        if (approvalParams.ok === false) {
          return toolError("Tool invocation parameters could not be copied for approval.", {
            errorCode: "TOOL_INVOCATION_INPUT_INVALID",
            inputReason: approvalParams.reason,
            permissionMode: mode,
            toolName: tool.name,
          });
        }
        const approval = await askForToolApproval(tool.name, approvalParams.value, sessionPath, deps);
        if (!approval.allowed) {
          return toolError("Tool action was not approved.", {
            errorCode: "TOOL_APPROVAL_REJECTED",
            action: tool.name,
            confirmed: false,
            confirmation: {
              kind: "tool_action_approval",
              status: approval.status,
              confirmId: approval.confirmId,
              toolName: tool.name,
              reason: approval.reason,
            },
          });
        }
        return executeWithInvocationRevalidation(
          tool,
          args,
          params,
          invocation,
          mode,
          deps,
          ctx,
          sessionBinding.value,
          executionCtx,
          runtimeCtxIndex,
          legacySessionPermission,
        );
      },
    };
  });
}
