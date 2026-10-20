import path from "path";
import {
  SESSION_APPROVAL_POLICIES,
  SESSION_PERMISSION_MODES,
  normalizeSessionPermissionMode,
  resolveSessionApprovalPolicy,
} from "../../core/session-permission-mode.ts";
import { StringEnum, Type } from "../pi-sdk/index.ts";
import { getToolSessionPath } from "./tool-session.ts";
import { toolError, toolOk } from "./tool-result.ts";
import { t } from "../i18n.ts";
import { buildApprovalReviewContext } from "../permission/approval-review-context.ts";

function toStatus(action) {
  if (action === "confirmed") return "confirmed";
  if (action === "timeout") return "timeout";
  if (action === "aborted") return "aborted";
  return "rejected";
}

function folderScopeText(scope) {
  return JSON.stringify({
    session_folders: {
      sessionPath: scope?.sessionPath || null,
      cwd: scope?.cwd || null,
      workspaceFolders: Array.isArray(scope?.workspaceFolders) ? scope.workspaceFolders : [],
      authorizedFolders: Array.isArray(scope?.authorizedFolders) ? scope.authorizedFolders : [],
      sandboxFolders: Array.isArray(scope?.sandboxFolders) ? scope.sandboxFolders : [],
    },
  }, null, 2);
}

function buildFolderApprovalRequest(confirmId, action, folder) {
  const normalizedAction = action === "remove" ? "remove" : "add";
  return {
    type: "session_confirmation",
    confirmId,
    kind: "session_folders",
    surface: "input",
    status: "pending",
    title: t("approval.sessionFolders.title"),
    body: t("approval.sessionFolders.body"),
    subject: {
      label: normalizedAction === "add" ? t("approval.sessionFolders.addLabel") : t("approval.sessionFolders.removeLabel"),
      detail: folder,
    },
    severity: "elevated",
    actions: {
      confirmLabel: t("approval.confirm"),
      rejectLabel: t("approval.reject"),
    },
    payload: { action: normalizedAction, folder },
  };
}

async function askForFolderApproval(action, folder, sessionPath, deps) {
  const confirmStore = deps.getConfirmStore?.() || deps.confirmStore || null;
  if (!confirmStore || !sessionPath) {
    return { allowed: false, status: "rejected", confirmId: "", reason: "confirmation-unavailable" };
  }
  const { confirmId, promise } = confirmStore.create(
    "session_folders",
    { action, folder },
    sessionPath,
  );
  deps.emitEvent?.({
    type: "session_confirmation",
    request: buildFolderApprovalRequest(confirmId, action, folder),
  }, sessionPath);
  const decision = await promise;
  const status = toStatus(decision?.action);
  return {
    allowed: status === "confirmed",
    status,
    confirmId,
  };
}

function stableSessionKey(sessionPath, engine, ctx = null) {
  const ctxSessionId = typeof ctx?.sessionId === "string" && ctx.sessionId.trim()
    ? ctx.sessionId.trim()
    : null;
  const resolved = !ctxSessionId && typeof engine?.getSessionIdForPath === "function"
    ? engine.getSessionIdForPath(sessionPath)
    : null;
  const sessionId = ctxSessionId || (typeof resolved === "string" && resolved.trim() ? resolved.trim() : null);
  return sessionId || sessionPath || "session";
}

function buildFolderGatewayRequest(action, folder, sessionPath, stableKey = null, ctx = null) {
  return {
    id: `${stableKey || sessionPath || "session"}:session_folders:${Date.now()}`,
    kind: "session_folders",
    sessionPath,
    agentId: ctx?.agentId || null,
    toolName: "session_folders",
    actionName: action,
    params: { action, folder },
    target: { type: "directory", label: folder, path: folder },
    blastRadius: "workspace_access",
    reversibility: "moderate",
  };
}

async function reviewFolderApproval(action, folder, sessionPath, deps, engine, ctx = null) {
  const mode = normalizeSessionPermissionMode(
    deps.getPermissionMode?.(sessionPath)
      || engine?.getSessionPermissionMode?.(sessionPath)
      || deps.getPermissionMode?.(),
  );
  if (mode !== SESSION_PERMISSION_MODES.AUTO) return { allowed: false, status: "ask_user" };
  const gateway = deps.getApprovalGateway?.() || deps.approvalGateway || null;
  if (!gateway || typeof gateway.review !== "function") {
    return { allowed: false, status: "ask_user", reason: "approval-gateway-unavailable" };
  }
  const scope = engine?.getSessionFolderScope?.(sessionPath) || {};
  const decision = await gateway.review(
    buildFolderGatewayRequest(action, folder, sessionPath, stableSessionKey(sessionPath, engine, ctx), ctx),
    buildApprovalReviewContext({
      source: {
        ...deps,
        cwd: scope.cwd,
        workspaceFolders: scope.workspaceFolders,
        authorizedFolders: scope.authorizedFolders,
        userIntentSummary: `${action === "remove" ? "Remove" : "Authorize"} this folder for the current session.`,
      },
      ctx,
      sessionPath,
      agentId: ctx?.agentId,
    }),
  );
  if (decision?.action === "allow") {
    return { allowed: true, status: "approved", decision };
  }
  if (decision?.action === "ask_user") {
    return { allowed: false, status: "ask_user", decision, reason: decision.reason };
  }
  return {
    allowed: false,
    status: decision?.action === "hard_deny" ? "blocked" : "denied",
    decision,
    reason: decision?.reason || "auto approval denied this folder authorization",
  };
}

function normalizeFolderParam(folder) {
  if (typeof folder !== "string" || !folder.trim()) return null;
  return path.resolve(folder.trim());
}

export function createSessionFoldersTool(deps: Record<string, any> = {}) {
  return {
    name: "session_folders",
    label: "Session Folders",
    description: "List or request changes to the current session's extra authorized sandbox folders. Use action=list to inspect cwd, prompt-visible workspace folders, user-authorized folders, and effective sandbox roots. Use add/remove only after the user wants this session to gain or drop folder access; auto mode routes the request to the approval reviewer, ask mode asks the user, and the change never modifies CWD or prompt text.",
    parameters: Type.Object({
      action: StringEnum(["list", "add", "remove"], {
        description: "list returns the current folder scope. add/remove requests a scoped authorized-folder change through the current permission mode.",
      }),
      folder: Type.Optional(Type.String({
        description: "Absolute or resolvable folder path for add/remove.",
      })),
    }),
    execute: async (_toolCallId, params: Record<string, any> = {}, _signal, _onUpdate, ctx) => {
      const engine = deps.getEngine?.();
      const sessionPath = getToolSessionPath(ctx) || deps.getSessionPath?.() || null;
      if (!engine) {
        return toolError("session_folders requires the engine runtime.", { errorCode: "ENGINE_UNAVAILABLE" });
      }
      if (!sessionPath) {
        return toolError("session_folders requires a current session.", { errorCode: "SESSION_REQUIRED" });
      }

      const action = params.action || "list";
      if (action === "list") {
        return toolOk(folderScopeText(engine.getSessionFolderScope?.(sessionPath)), { action, sessionPath });
      }

      const folder = normalizeFolderParam(params.folder);
      if (!folder) {
        return toolError("session_folders add/remove requires folder.", {
          errorCode: "FOLDER_REQUIRED",
          action,
          sessionPath,
        });
      }

      const mode = normalizeSessionPermissionMode(
        deps.getPermissionMode?.(sessionPath)
          || engine?.getSessionPermissionMode?.(sessionPath)
          || deps.getPermissionMode?.(),
      );
      const approvalPolicy = resolveSessionApprovalPolicy({
        mode,
        approvalPolicy: ctx?.approvalPolicy || deps.approvalPolicy,
        allowHumanApproval: ctx?.allowHumanApproval ?? deps.allowHumanApproval,
      });
      let approval: { allowed: boolean; status: string; confirmId?: string; reason?: string; decision?: any; reviewStatus?: string } = mode === SESSION_PERMISSION_MODES.OPERATE
        ? { allowed: true, status: "session_preapproved" }
        : await reviewFolderApproval(action, folder, sessionPath, deps, engine, ctx);
      if (!approval.allowed && approval.status === "ask_user") {
        if (approvalPolicy === SESSION_APPROVAL_POLICIES.DENY_ON_PROMPT) {
          approval = {
            ...approval,
            status: "needs_user_approval_but_unavailable",
            reviewStatus: "ask_user",
            reason: approval.reason || "human approval unavailable",
          };
        } else {
          approval = await askForFolderApproval(action, folder, sessionPath, deps);
        }
      }
      if (!approval.allowed) {
        return toolOk("Session folder authorization was not approved.", {
          action,
          confirmed: false,
          confirmation: {
              kind: "session_folders",
              status: approval.status,
              reviewStatus: approval.reviewStatus,
              confirmId: approval.confirmId,
              reason: approval.reason,
              reviewer: approval.decision?.reviewer,
              risk: approval.decision?.risk,
              approvalPolicy: approval.status === "needs_user_approval_but_unavailable" ? approvalPolicy : undefined,
            },
          });
      }

      const scope = action === "remove"
        ? await engine.removeSessionAuthorizedFolder?.(sessionPath, folder)
        : await engine.addSessionAuthorizedFolder?.(sessionPath, folder);
      return toolOk(folderScopeText(scope || engine.getSessionFolderScope?.(sessionPath)), {
        action,
        confirmed: true,
        sessionPath,
        folder,
      });
    },
  };
}
