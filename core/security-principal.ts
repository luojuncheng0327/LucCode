const PRINCIPAL_KINDS = new Set([
  "local_user",
  "account_user",
  "device",
  "agent",
  "plugin",
  "bridge",
  "official_service",
  "unknown",
]);

const CREDENTIAL_KINDS = new Set([
  "loopback_token",
  "device_credential",
  "user_session",
  "service_token",
  "plugin_surface_session",
  "none",
]);

const CONNECTION_KINDS = new Set([
  "local",
  "lan",
  "custom_remote",
  "relay",
  "cloud",
]);

const TRUST_STATES = new Set([
  "local",
  "paired",
  "lan",
  "tunnel",
  "cloud",
  "unknown",
]);

export function normalizePrincipal(input: Record<string, any> = {}) {
  const kind = enumValue(input.kind, PRINCIPAL_KINDS, "unknown");
  const principal: Record<string, any> = {
    schemaVersion: 1,
    principalId: stringOrNull(input.principalId) || derivePrincipalId({ ...input, kind }),
    kind,
    userId: stringOrNull(input.userId),
    studioId: stringOrNull(input.studioId),
    serverId: stringOrNull(input.serverId),
    serverNodeId: stringOrNull(input.serverNodeId ?? input.serverId),
    deviceId: stringOrNull(input.deviceId),
    credentialId: stringOrNull(input.credentialId),
    agentId: stringOrNull(input.agentId),
    pluginId: stringOrNull(input.pluginId),
    bridgeAccountId: stringOrNull(input.bridgeAccountId),
    platformAccountId: stringOrNull(input.platformAccountId),
    officialServiceKind: stringOrNull(input.officialServiceKind),
    connectionKind: enumValue(input.connectionKind, CONNECTION_KINDS, null),
    credentialKind: enumValue(input.credentialKind, CREDENTIAL_KINDS, null),
    authMethod: stringOrNull(input.authMethod),
    trustState: enumValue(input.trustState, TRUST_STATES, "unknown"),
    scopes: normalizeScopes(input.scopes),
  };
  if (Array.isArray(input.studioIds)) {
    principal.studioIds = normalizeScopes(input.studioIds);
  }
  return deepFreeze(principal);
}

export function principalSummary(principal) {
  const p = normalizePrincipal(principal);
  return deepFreeze({
    principalId: p.principalId,
    kind: p.kind,
    userId: p.userId,
    studioId: p.studioId,
    serverId: p.serverId,
    serverNodeId: p.serverNodeId,
    deviceId: p.deviceId,
    credentialId: p.credentialId,
    agentId: p.agentId,
    pluginId: p.pluginId,
    bridgeAccountId: p.bridgeAccountId,
    platformAccountId: p.platformAccountId,
    officialServiceKind: p.officialServiceKind,
    connectionKind: p.connectionKind,
    credentialKind: p.credentialKind,
    trustState: p.trustState,
  });
}

export function principalOwnsLocalConnection(principal) {
  const p = normalizePrincipal(principal);
  return p.kind === "local_user"
    && p.connectionKind === "local"
    && p.credentialKind === "loopback_token";
}

export function principalHasScope(principal, required) {
  if (principalOwnsLocalConnection(principal)) return true;
  if (!required) return true;
  const p = normalizePrincipal(principal);
  if (p.scopes.includes(required)) return true;
  const [namespace] = required.split(".");
  return p.scopes.includes(namespace) || p.scopes.includes(`${namespace}.*`);
}

function derivePrincipalId(input) {
  const subject = subjectIdFor(input);
  return [
    "principal",
    input.kind || "unknown",
    subject,
    input.studioId || "no_studio",
    input.serverNodeId || input.serverId || "no_node",
  ].map(toIdSegment).join("_");
}

function subjectIdFor(input) {
  switch (input.kind) {
    case "device":
      return input.deviceId || input.userId || "device";
    case "agent":
      return input.agentId || input.userId || "agent";
    case "plugin":
      return input.pluginId || input.userId || "plugin";
    case "bridge":
      return input.bridgeAccountId || input.userId || "bridge";
    case "official_service":
      return input.officialServiceKind || input.platformAccountId || "service";
    case "account_user":
    case "local_user":
    default:
      return input.userId || input.deviceId || input.platformAccountId || "anon";
  }
}

function normalizeScopes(scopes) {
  if (!Array.isArray(scopes)) return [];
  return [...new Set(scopes
    .filter((scope) => typeof scope === "string" && scope.trim())
    .map((scope) => scope.trim()))];
}

function enumValue(value, allowed, fallback) {
  return typeof value === "string" && allowed.has(value) ? value : fallback;
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toIdSegment(value) {
  return String(value)
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    || "unknown";
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
