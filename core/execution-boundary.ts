const LOCAL_EXECUTION_KIND = "local_process";
const DEFAULT_WORKBENCH_KIND = "legacy_agent_workbench";

export function createRuntimeExecutionBoundary(runtimeContext, options: { workbenchRoot?: any; workbenchKind?: string } = {}) {
  if (!runtimeContext || typeof runtimeContext !== "object") {
    throw new Error("execution boundary requires runtimeContext");
  }
  return createLocalExecutionBoundary({
    serverNodeId: runtimeContext.serverNodeId || runtimeContext.serverId,
    studioId: runtimeContext.studioId,
    workbenchRoot: options.workbenchRoot ?? null,
    workbenchKind: options.workbenchKind || DEFAULT_WORKBENCH_KIND,
  });
}

export function createLocalExecutionBoundary({
  serverNodeId,
  studioId,
  workbenchRoot = null,
  workbenchKind = DEFAULT_WORKBENCH_KIND,
}: { serverNodeId?: any; studioId?: any; workbenchRoot?: any; workbenchKind?: string } = {}) {
  assertNonEmptyString(serverNodeId, "execution boundary requires serverNodeId");
  assertNonEmptyString(studioId, "execution boundary requires studioId");
  if (workbenchRoot !== null && !isNonEmptyString(workbenchRoot)) {
    throw new Error("execution boundary workbenchRoot must be null or a non-empty string");
  }
  assertNonEmptyString(workbenchKind, "execution boundary requires workbenchKind");

  return deepFreeze({
    schemaVersion: 1,
    boundaryId: `execb_${toBoundarySegment(serverNodeId)}_${toBoundarySegment(studioId)}`,
    kind: LOCAL_EXECUTION_KIND,
    serverNodeId,
    studioId,
    workbench: {
      kind: workbenchKind,
      root: workbenchRoot,
    },
    sandbox: {
      kind: "legacy_session_permission",
      enforcedBy: "existing_runtime",
    },
    filesystem: {
      policy: "legacy_workbench_scope",
    },
    network: {
      policy: "local_runtime_default",
    },
  });
}

function toBoundarySegment(value) {
  return value.replace(/[^a-zA-Z0-9_:-]+/g, "_");
}

function assertNonEmptyString(value, message) {
  if (!isNonEmptyString(value)) throw new Error(message);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
