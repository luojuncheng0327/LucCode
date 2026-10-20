import { createAgentSessionAutomationExecutor } from "../desk/agent-run-automation.ts";

function clonePlain<T>(value: T): T {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as T;
}

const VALID_TYPES = new Set(["at", "every", "cron"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function applyConfirmedAutomationDraft(
  baseJobData: unknown,
  confirmationValue: unknown,
  { getHomeCwd = null }: { getHomeCwd?: ((agentId: string | null) => string | null) | null } = {},
) {
  const base = asRecord(baseJobData);
  const value = asRecord(confirmationValue);
  const draft = asRecord(value?.jobData);
  if (!base || !draft) {
    return baseJobData;
  }

  const next = clonePlain(base);
  delete next.authorization;
  delete next.requestedGrants;

  if (typeof draft.type === "string" && VALID_TYPES.has(draft.type)) {
    next.type = draft.type;
  }
  if (draft.schedule !== undefined) {
    next.schedule = draft.schedule;
  }
  if (typeof draft.prompt === "string") {
    next.prompt = draft.prompt;
  }
  if (typeof draft.label === "string") {
    next.label = draft.label;
  }
  if (Object.prototype.hasOwnProperty.call(draft, "model")) {
    next.model = clonePlain(draft.model);
  }

  const executor = asRecord(next.executor);
  const baseActorAgentId = typeof next.actorAgentId === "string" && next.actorAgentId.trim()
    ? next.actorAgentId.trim()
    : typeof executor?.agentId === "string" && executor.agentId.trim()
      ? executor.agentId.trim()
      : null;
  const targetAgentId = typeof draft.targetAgentId === "string" && draft.targetAgentId.trim()
    ? draft.targetAgentId.trim()
    : baseActorAgentId;
  const targetChanged = !!targetAgentId && targetAgentId !== baseActorAgentId;
  const trustedBaseContext = asRecord(next.executionContext)
    || asRecord(executor?.executionContext)
    || null;
  const targetHome = targetChanged && getHomeCwd ? getHomeCwd(targetAgentId) : null;
  const executionContext = targetChanged
    ? {
        kind: "session_workspace",
        cwd: typeof targetHome === "string" && targetHome.trim() ? targetHome : null,
        workspaceFolders: typeof targetHome === "string" && targetHome.trim() ? [targetHome] : [],
        authorizedFolders: [],
        sourceSessionId: null,
        sourceBridgeSessionKey: null,
        sourceSessionPath: null,
        createdByAgentId: targetAgentId,
        notificationContext: null,
      }
    : trustedBaseContext
      ? {
          ...clonePlain(trustedBaseContext),
          createdByAgentId: targetAgentId,
        }
      : null;

  next.actorAgentId = targetAgentId;
  next.executionContext = executionContext;
  next.executor = createAgentSessionAutomationExecutor({
    agentId: targetAgentId,
    prompt: typeof next.prompt === "string" ? next.prompt : "",
    model: clonePlain(next.model ?? executor?.model ?? ""),
    executionContext,
    migratedFrom: executor?.migratedFrom || null,
  });

  return next;
}
