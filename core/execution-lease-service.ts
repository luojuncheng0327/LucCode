import crypto from "crypto";
import {
  consumeExecutionLease,
  issueExecutionLease,
  revokeExecutionLease,
} from "./execution-lease-registry.ts";

export function issueRemoteWriteLease({
  lucHome,
  requestContext,
  decision,
  agentId,
  sessionId = "mobile_workbench",
  resourceIds = [],
  mountId = null,
  now = new Date().toISOString(),
  ttlMs = 5 * 60 * 1000,
}: {
  lucHome?: any;
  requestContext?: any;
  decision?: any;
  agentId?: any;
  sessionId?: string;
  resourceIds?: any[];
  mountId?: any;
  now?: string;
  ttlMs?: number;
} = {}) {
  if (!lucHome || isLocalOwner(requestContext)) return null;
  const principal = requestContext?.authPrincipal;
  if (!principal || principal.kind === "unknown") return null;
  if (!principal?.principalId) return null;
  const issuedAtMs = Date.parse(now);
  const lease = issueExecutionLease(lucHome, {
    schemaVersion: 1,
    leaseId: `lease_${crypto.randomUUID()}`,
    studioId: requestContext.studioId || principal.studioId || "studio_unknown",
    targetServerNodeId: requestContext.serverNodeId || requestContext.serverId || principal.serverNodeId || "server_node_unknown",
    agentId: agentId || "agent_unknown",
    sessionId,
    actorPrincipalId: principal.principalId,
    capabilityDecisionId: decision?.decisionId || null,
    commandClass: "write_files",
    sandboxProfile: "workspace_write",
    backupPolicy: "snapshot_before_write",
    resourceIds,
    mountId,
    expiresAt: new Date(issuedAtMs + ttlMs).toISOString(),
    createdAt: new Date(issuedAtMs).toISOString(),
  }, { now });
  return lease;
}

export function consumeRemoteWriteLease(lucHome, lease, { now = new Date().toISOString() } = {}) {
  if (!lucHome || !lease?.leaseId) return null;
  return consumeExecutionLease(lucHome, lease.leaseId, { now });
}

export function revokeRemoteWriteLease(lucHome, lease, { now = new Date().toISOString() } = {}) {
  if (!lucHome || !lease?.leaseId) return null;
  return revokeExecutionLease(lucHome, lease.leaseId, { now });
}

function isLocalOwner(requestContext) {
  const principal = requestContext?.authPrincipal;
  return principal?.kind === "local_user"
    && principal?.connectionKind === "local"
    && principal?.credentialKind === "loopback_token";
}
