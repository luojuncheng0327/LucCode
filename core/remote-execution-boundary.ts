const SCHEMA_VERSION = 1;

const NODE_ROLES = ["authority", "resource_node", "execution_node", "replica"];
const TRANSPORT_KINDS = ["local", "lan", "custom_remote", "relay", "cloud"];
const NODE_CAPABILITIES = [
  "resources.list",
  "resources.read",
  "resources.write",
  "resources.watch",
  "resources.materialize",
  "execution.command",
  "execution.tool",
];
const LINK_STATUSES = ["active", "disabled", "offline"];
const COMMAND_CLASSES = ["read_only", "write_files", "run_script", "tool"];
const SANDBOX_PROFILES = ["read_only", "workspace_write", "explicit_full_access"];
const BACKUP_POLICIES = ["none", "snapshot_before_write", "sandbox_overlay"];
const WRITE_CAPABLE_COMMAND_CLASSES = new Set(["write_files", "run_script", "tool"]);

export function validateServerNodeLink(value) {
  if (!isPlainObject(value)) throw new Error("invalid ServerNodeLink: expected object");
  if (value.schemaVersion !== SCHEMA_VERSION) throw new Error("invalid ServerNodeLink: schemaVersion must be 1");
  assertNonEmptyString(value.linkId, "linkId");
  assertNonEmptyString(value.studioId, "studioId");
  assertNonEmptyString(value.serverNodeId, "serverNodeId");
  if (!NODE_ROLES.includes(value.nodeRole)) {
    throw new Error(`nodeRole must be one of ${NODE_ROLES.join(", ")}`);
  }
  if (!TRANSPORT_KINDS.includes(value.transportKind)) {
    throw new Error(`transportKind must be one of ${TRANSPORT_KINDS.join(", ")}`);
  }
  if (!LINK_STATUSES.includes(value.status)) {
    throw new Error(`status must be one of ${LINK_STATUSES.join(", ")}`);
  }
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    linkId: value.linkId,
    studioId: value.studioId,
    serverNodeId: value.serverNodeId,
    nodeRole: value.nodeRole,
    transportKind: value.transportKind,
    capabilities: normalizeNodeCapabilities(value.capabilities),
    status: value.status,
    createdAt: value.createdAt || null,
    updatedAt: value.updatedAt || null,
  });
}

export function validateExecutionLease(value, { now = new Date().toISOString() } = {}) {
  if (!isPlainObject(value)) throw new Error("invalid ExecutionLease: expected object");
  if (value.schemaVersion !== SCHEMA_VERSION) throw new Error("invalid ExecutionLease: schemaVersion must be 1");
  assertNonEmptyString(value.leaseId, "leaseId");
  assertNonEmptyString(value.studioId, "studioId");
  assertNonEmptyString(value.targetServerNodeId, "targetServerNodeId");
  assertNonEmptyString(value.agentId, "agentId");
  assertNonEmptyString(value.sessionId, "sessionId");
  assertNonEmptyString(value.actorPrincipalId, "actorPrincipalId");
  if (!COMMAND_CLASSES.includes(value.commandClass)) {
    throw new Error(`commandClass must be one of ${COMMAND_CLASSES.join(", ")}`);
  }
  if (!SANDBOX_PROFILES.includes(value.sandboxProfile)) {
    throw new Error(`sandboxProfile must be one of ${SANDBOX_PROFILES.join(", ")}`);
  }
  if (!BACKUP_POLICIES.includes(value.backupPolicy)) {
    throw new Error(`backupPolicy must be one of ${BACKUP_POLICIES.join(", ")}`);
  }
  assertNonEmptyString(value.expiresAt, "expiresAt");
  if (Date.parse(value.expiresAt) <= Date.parse(now)) throw new Error("execution lease expired");
  if (requiresBackupPolicy(value) && value.backupPolicy === "none") {
    throw new Error("write-capable execution lease requires backup policy");
  }
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    leaseId: value.leaseId,
    studioId: value.studioId,
    targetServerNodeId: value.targetServerNodeId,
    agentId: value.agentId,
    sessionId: value.sessionId,
    actorPrincipalId: value.actorPrincipalId,
    capabilityDecisionId: value.capabilityDecisionId ?? null,
    mountId: value.mountId ?? null,
    resourceIds: Array.isArray(value.resourceIds) ? [...value.resourceIds] : [],
    commandClass: value.commandClass,
    sandboxProfile: value.sandboxProfile,
    backupPolicy: value.backupPolicy,
    expiresAt: value.expiresAt,
    createdAt: value.createdAt || null,
  });
}

export function normalizeNodeCapabilities(capabilities) {
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    throw new Error("capabilities must be a non-empty array");
  }
  const seen = new Set();
  for (const capability of capabilities) {
    if (!NODE_CAPABILITIES.includes(capability)) {
      throw new Error(`unknown server node capability: ${capability}`);
    }
    seen.add(capability);
  }
  return NODE_CAPABILITIES.filter((capability) => seen.has(capability));
}

export function requiresBackupPolicy(lease) {
  return WRITE_CAPABLE_COMMAND_CLASSES.has(lease?.commandClass);
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} required`);
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
