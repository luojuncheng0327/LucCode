import crypto from "crypto";
import {
  normalizePrincipal,
  principalOwnsLocalConnection,
} from "./security-principal.ts";

export function authorizeCapability({
  principal,
  grants = [],
  capability,
  target,
  connectionKind,
  now = new Date().toISOString(),
}: { principal?: any; grants?: any[]; capability?: any; target?: any; connectionKind?: any; now?: string } = {}) {
  const normalizedTarget = normalizeTarget(target);
  const normalizedCapability = typeof capability === "string" ? capability.trim() : "";
  if (!normalizedCapability) {
    return decision({
      allowed: false,
      reason: "missing_capability",
      capability: normalizedCapability,
      principalId: null,
      target: normalizedTarget,
    });
  }
  if (!principal) {
    return decision({
      allowed: false,
      reason: "missing_principal",
      capability: normalizedCapability,
      principalId: null,
      target: normalizedTarget,
    });
  }

  const normalizedPrincipal = normalizePrincipal(principal);
  if (principalOwnsLocalConnection(normalizedPrincipal)) {
    return decision({
      allowed: true,
      reason: "local_owner",
      capability: normalizedCapability,
      principalId: normalizedPrincipal.principalId,
      target: normalizedTarget,
    });
  }

  if (!normalizedTarget.studioId) {
    return decision({
      allowed: false,
      reason: "scope_mismatch",
      capability: normalizedCapability,
      principalId: normalizedPrincipal.principalId,
      target: normalizedTarget,
    });
  }

  const activeGrants = (Array.isArray(grants) ? grants : []).filter((grant) => isGrantActive(grant, now));
  if (activeGrants.length === 0) {
    return decision({
      allowed: false,
      reason: "missing_grant",
      capability: normalizedCapability,
      principalId: normalizedPrincipal.principalId,
      target: normalizedTarget,
    });
  }

  const transport = connectionKind || normalizedPrincipal.connectionKind;
  for (const grant of activeGrants) {
    if (grant.principalId !== normalizedPrincipal.principalId) continue;
    if (!grantAllowsCapability(grant, normalizedCapability)) continue;
    if (!grantAllowsTransport(grant, transport)) {
      return decision({
        allowed: false,
        reason: "transport_not_allowed",
        capability: normalizedCapability,
        principalId: normalizedPrincipal.principalId,
        target: normalizedTarget,
        grantId: grant.grantId,
      });
    }
    if (!grantScopeContainsTarget(grant.scope, normalizedTarget)) continue;
    return decision({
      allowed: true,
      reason: "allowed",
      capability: normalizedCapability,
      principalId: normalizedPrincipal.principalId,
      target: normalizedTarget,
      grantId: grant.grantId,
    });
  }

  return decision({
    allowed: false,
    reason: "insufficient_capability",
    capability: normalizedCapability,
    principalId: normalizedPrincipal.principalId,
    target: normalizedTarget,
  });
}

export function capabilityDecisionSummary(value) {
  if (!value || typeof value !== "object") return null;
  return Object.freeze({
    decisionId: value.decisionId || null,
    allowed: !!value.allowed,
    reason: value.reason || "unknown",
    capability: value.capability || null,
    principalId: value.principalId || null,
    grantId: value.grantId || null,
    target: value.target || null,
  });
}

function decision({ allowed, reason, capability, principalId, target, grantId = null }) {
  return Object.freeze({
    decisionId: `decision_${crypto.randomUUID()}`,
    allowed,
    reason,
    capability,
    principalId,
    grantId,
    target,
  });
}

function normalizeTarget(target) {
  const source = target && typeof target === "object" ? target : {};
  const out: Record<string, any> = {
    kind: stringOrNull(source.kind) || "unknown",
  };
  for (const key of ["studioId", "agentId", "sessionId", "sessionPath", "resourceId", "mountId", "serverNodeId"]) {
    const value = stringOrNull(source[key]);
    if (value) out[key] = value;
  }
  return Object.freeze(out);
}

function grantAllowsCapability(grant, capability) {
  if (!Array.isArray(grant?.capabilities)) return false;
  if (grant.capabilities.includes(capability)) return true;
  const [namespace] = capability.split(".");
  return grant.capabilities.includes(namespace) || grant.capabilities.includes(`${namespace}.*`);
}

function grantAllowsTransport(grant, connectionKind) {
  const allowed = grant?.constraints?.transportKinds;
  if (!Array.isArray(allowed) || allowed.length === 0) return true;
  return allowed.includes(connectionKind);
}

function grantScopeContainsTarget(scope, target) {
  if (!scope || typeof scope !== "object") return false;
  if (scope.studioId !== target.studioId) return false;
  for (const key of ["agentId", "sessionId", "sessionPath", "resourceId", "mountId", "serverNodeId"]) {
    if (scope[key] && scope[key] !== target[key]) return false;
  }
  return true;
}

function isGrantActive(grant, now) {
  if (!grant || grant.status !== "active") return false;
  if (grant.constraints?.expiresAt && Date.parse(grant.constraints.expiresAt) <= Date.parse(now)) return false;
  return true;
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
