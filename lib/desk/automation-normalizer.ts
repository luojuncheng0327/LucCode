import {
  buildNotifyAgentRunPrompt,
  buildPluginActionAgentRunPrompt,
  createAgentSessionAutomationExecutor,
} from "./agent-run-automation.ts";
export const AUTOMATION_SCHEMA_VERSION = 4;

function clone(value: any) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function hasOwn(object: any, key: string) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function normalizeSchemaVersion(value: any) {
  if (Number.isInteger(value) && value > AUTOMATION_SCHEMA_VERSION) {
    return value;
  }
  return AUTOMATION_SCHEMA_VERSION;
}

function normalizeConfigRevision(value: any) {
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function normalizeStudioId(job: any) {
  return typeof job?.studioId === "string" && job.studioId.trim()
    ? job.studioId.trim()
    : null;
}

function normalizeActorAgentId(job: any) {
  if (typeof job?.actorAgentId === "string" && job.actorAgentId.trim()) {
    return job.actorAgentId.trim();
  }
  if (typeof job?.legacyRef?.agentId === "string" && job.legacyRef.agentId.trim()) {
    return job.legacyRef.agentId.trim();
  }
  return null;
}

function normalizeStoredExecutionContext(value: any) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value ?? null;
  const normalized = clone(value);
  const sourceSessionId = typeof normalized.sourceSessionId === "string" && normalized.sourceSessionId.trim()
    ? normalized.sourceSessionId.trim()
    : null;
  const sourceSessionPath = typeof normalized.sourceSessionPath === "string" && normalized.sourceSessionPath.trim()
    ? normalized.sourceSessionPath
    : null;
  if (!sourceSessionId && sourceSessionPath) {
    normalized.cwd = null;
    normalized.workspaceFolders = [];
    normalized.authorizedFolders = [];
    normalized.sourceSessionId = null;
    normalized.sourceSessionPath = null;
  }
  return normalized;
}

function deriveTriggerFromLegacyCronJob(job: any = {}) {
  if (job.type === "at") return { kind: "at", schedule: job.schedule };
  if (job.type === "every") {
    const intervalMs = typeof job.schedule === "number" ? job.schedule : parseInt(job.schedule, 10);
    return { kind: "every", intervalMs };
  }
  if (job.type === "cron") return { kind: "cron", expression: job.schedule };
  return null;
}

export function triggerFromLegacyCronJob(job: any = {}) {
  const existing = job.trigger && typeof job.trigger === "object" && !Array.isArray(job.trigger)
    ? clone(job.trigger)
    : null;
  const derived = deriveTriggerFromLegacyCronJob(job);
  if (existing && derived && existing.kind === derived.kind) {
    return { ...existing, ...derived };
  }
  if (derived) return derived;
  if (existing) return existing;
  return { kind: "unknown", schedule: job.schedule };
}

export function executorFromLegacyCronJob(job: any = {}) {
  const existing = job.executor && typeof job.executor === "object" && !Array.isArray(job.executor)
    ? clone(job.executor)
    : null;
  const actorAgentId = normalizeActorAgentId(job);

  if (existing?.kind === "direct_action" && existing.action === "notify") {
    const prompt = buildNotifyAgentRunPrompt(existing.params || {});
    return createAgentSessionAutomationExecutor({
      agentId: existing.agentId || actorAgentId,
      prompt,
      model: hasOwn(job, "model") ? clone(job.model ?? "") : "",
      executionContext: hasOwn(job, "executionContext") ? clone(job.executionContext || null) : null,
      migratedFrom: {
        kind: "direct_action",
        action: "notify",
      },
    });
  }

  if (existing?.kind === "plugin_action") {
    const pluginId = typeof existing.pluginId === "string" ? existing.pluginId.trim() : "";
    const actionId = typeof existing.actionId === "string" ? existing.actionId.trim() : "";
    if (pluginId && actionId) {
      const prompt = buildPluginActionAgentRunPrompt({
        pluginId,
        actionId,
        params: existing.params && typeof existing.params === "object" && !Array.isArray(existing.params)
          ? existing.params
          : {},
      });
      return createAgentSessionAutomationExecutor({
        agentId: existing.agentId || actorAgentId,
        prompt,
        model: hasOwn(job, "model") ? clone(job.model ?? "") : "",
        executionContext: hasOwn(job, "executionContext") ? clone(job.executionContext || null) : null,
        migratedFrom: {
          kind: "plugin_action",
          pluginId,
          actionId,
        },
      });
    }
  }

  if (existing && existing.kind !== "agent_session") {
    return existing;
  }

  if (existing?.kind === "agent_session") {
    const existingAgentId = typeof existing.agentId === "string" && existing.agentId.trim()
      ? existing.agentId.trim()
      : null;
    return createAgentSessionAutomationExecutor({
      agentId: actorAgentId || existingAgentId,
      prompt: typeof job.prompt === "string"
        ? job.prompt
        : typeof existing.prompt === "string"
          ? existing.prompt
          : "",
      model: hasOwn(job, "model") ? clone(job.model ?? "") : clone(existing.model ?? ""),
      executionContext: hasOwn(job, "executionContext")
        ? clone(job.executionContext || null)
        : clone(existing.executionContext ?? null),
      migratedFrom: existing.migratedFrom || null,
    });
  }

  return {
    kind: "agent_session",
    agentId: actorAgentId,
    prompt: typeof job.prompt === "string" ? job.prompt : "",
    model: clone(job.model ?? ""),
    executionContext: clone(job.executionContext || null),
  };
}

export function createdByFromLegacyCronJob(job: any = {}) {
  if (job.createdBy && typeof job.createdBy === "object" && !Array.isArray(job.createdBy)) {
    return clone(job.createdBy);
  }
  const agentId = normalizeActorAgentId(job);
  return agentId ? { kind: "agent", agentId } : { kind: "unknown" };
}

export function normalizeAutomationJob(job: any = {}) {
  const rawExecutionContext = hasOwn(job, "executionContext")
    ? job.executionContext
    : job.executor?.kind === "agent_session" && hasOwn(job.executor, "executionContext")
      ? job.executor.executionContext
      : undefined;
  const hasExecutionContext = rawExecutionContext !== undefined;
  const executionContext = hasExecutionContext
    ? normalizeStoredExecutionContext(rawExecutionContext)
    : undefined;
  const sourceJob = hasExecutionContext ? { ...job, executionContext } : job;
  const trigger = triggerFromLegacyCronJob(sourceJob);
  const executor = executorFromLegacyCronJob(sourceJob);
  const studioId = normalizeStudioId(job);
  const configRevision = normalizeConfigRevision(job.configRevision);
  const prompt = typeof job.prompt === "string" && job.prompt
    ? job.prompt
    : executor?.kind === "agent_session" && typeof executor.prompt === "string"
      ? executor.prompt
      : job.prompt;
  const normalizedJob = { ...job };
  // A short-lived development version persisted exact per-job grants. The
  // runtime now follows the same read/routine/review boundary for interactive
  // and scheduled sessions, so those fields are never part of a job contract.
  delete normalizedJob.authorization;
  delete normalizedJob.requestedGrants;
  delete normalizedJob.permissionMode;
  delete normalizedJob.approvalPolicy;
  delete normalizedJob.allowHumanApproval;
  return {
    ...normalizedJob,
    prompt,
    schemaVersion: normalizeSchemaVersion(job.schemaVersion),
    ...(studioId ? { studioId } : {}),
    ...(hasExecutionContext ? { executionContext } : {}),
    configRevision,
    trigger,
    executor,
    createdBy: createdByFromLegacyCronJob(job),
  };
}

export function normalizeAutomationJobs(jobs: any[] = []) {
  return Array.isArray(jobs) ? jobs.map((job: any) => normalizeAutomationJob(job)) : [];
}

export function patchAutomationJobForMigration(job: any = {}) {
  const normalized = normalizeAutomationJob(job);
  return {
    ...normalized,
    prompt: normalized.prompt,
    schemaVersion: normalized.schemaVersion,
    trigger: normalized.trigger,
    executor: normalized.executor,
    createdBy: normalized.createdBy,
  };
}
