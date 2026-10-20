import { filesystemIdentityKeySync } from "../../shared/link-aware-fs.ts";

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeWorkspaceFolders(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => text(item))
    .filter((item): item is string => !!item);
}

function filesystemScopePaths(value: string[]) {
  return [...new Set(value.map((item) => filesystemIdentityKeySync(item)))]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function normalizeBridgeDeliveryTarget(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const target = value as Record<string, unknown>;
  if (target.kind && target.kind !== "bridge") return null;
  const platform = text(target.platform);
  const chatId = text(target.chatId);
  const sessionKey = text(target.sessionKey);
  if (!platform || (!chatId && !sessionKey)) return null;
  const agentId = text(target.agentId);
  return {
    kind: "bridge",
    platform,
    chatType: "dm",
    ...(chatId ? { chatId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(agentId ? { agentId } : {}),
  };
}

function normalizeNotificationContext(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const context = value as Record<string, unknown>;
  const target = normalizeBridgeDeliveryTarget(
    context.bridgeDeliveryTarget || context.deliveryTarget,
  );
  return target ? { bridgeDeliveryTarget: target } : null;
}

export function normalizeAutomationExecutionContext(
  value: unknown,
  { actorAgentId = null }: { actorAgentId?: string | null } = {},
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      kind: "missing",
      cwd: null,
      workspaceFolders: [],
      authorizedFolders: [],
      sourceSessionId: null,
      sourceBridgeSessionKey: null,
      sourceSessionPath: null,
      createdByAgentId: text(actorAgentId),
      notificationContext: null,
    };
  }
  const context = value as Record<string, unknown>;
  return {
    kind: text(context.kind) || "session_workspace",
    cwd: text(context.cwd),
    workspaceFolders: normalizeWorkspaceFolders(context.workspaceFolders),
    authorizedFolders: normalizeWorkspaceFolders(context.authorizedFolders),
    sourceSessionId: text(context.sourceSessionId),
    sourceBridgeSessionKey: text(context.sourceBridgeSessionKey),
    sourceSessionPath: text(context.sourceSessionPath),
    createdByAgentId: text(context.createdByAgentId) || text(actorAgentId),
    notificationContext: normalizeNotificationContext(context.notificationContext),
  };
}

export function requireAutomationExecutionContext(
  value: unknown,
  actorAgentId: string | null,
) {
  const normalized = normalizeAutomationExecutionContext(value, { actorAgentId });
  if (normalized.kind === "missing") {
    throw new Error("cron job requires executionContext");
  }
  const normalizedActorAgentId = text(actorAgentId);
  if (!normalizedActorAgentId) {
    throw new Error("cron job requires actorAgentId");
  }
  if (normalized.createdByAgentId !== normalizedActorAgentId) {
    throw new Error("executionContext.createdByAgentId must match actorAgentId");
  }
  return normalized;
}

/**
 * Exact unattended-execution scope. Locator paths are deliberately excluded:
 * stable session/Bridge identity owns the source, while cwd and workspace paths
 * remain explicit authority-bearing resources.
 */
export function automationExecutionScopeKey(value: unknown) {
  const context = normalizeAutomationExecutionContext(value);
  const notificationTarget = context.notificationContext?.bridgeDeliveryTarget || null;
  return JSON.stringify({
    schemaVersion: 2,
    kind: context.kind,
    cwd: context.cwd ? filesystemIdentityKeySync(context.cwd) : null,
    workspaceFolders: filesystemScopePaths(context.workspaceFolders),
    authorizedFolders: filesystemScopePaths(context.authorizedFolders),
    sourceSessionId: context.sourceSessionId,
    sourceBridgeSessionKey: context.sourceBridgeSessionKey,
    createdByAgentId: context.createdByAgentId,
    notificationTarget: notificationTarget
      ? {
        platform: notificationTarget.platform,
        chatId: notificationTarget.chatId || null,
        sessionKey: notificationTarget.sessionKey || null,
        agentId: notificationTarget.agentId || null,
      }
      : null,
  });
}
