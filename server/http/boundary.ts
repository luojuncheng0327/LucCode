import { authorizeCapability } from "../../core/capability-policy.ts";
import { findActiveGrantsForPrincipal } from "../../core/grant-registry.ts";
import { normalizePrincipal } from "../../core/security-principal.ts";
import { assertRouteErrorStatus, jsonRouteError } from "./route-errors.ts";
export { HttpRouteError, jsonRouteError } from "./route-errors.ts";

export function createRequestContext(c, engine) {
  const runtimeContext = readRuntimeContext(engine);
  const authPrincipal = normalizePrincipal(readAuthPrincipal(c) || createAuthPrincipal(runtimeContext));
  const request = {
    method: c?.req?.method || "GET",
    url: c?.req?.url || "http://luc.local/",
    path: safePathname(c?.req?.url || "http://luc.local/"),
  };
  const requestContext = {
    request,
    runtimeContext,
    serverId: authPrincipal?.serverId ?? runtimeContext?.serverId ?? null,
    serverNodeId: authPrincipal?.serverNodeId ?? runtimeContext?.serverNodeId ?? runtimeContext?.serverId ?? null,
    userId: authPrincipal?.userId ?? runtimeContext?.userId ?? null,
    studioId: authPrincipal?.studioId ?? runtimeContext?.studioId ?? null,
    principalId: authPrincipal?.principalId ?? null,
    connectionKind: authPrincipal?.connectionKind ?? runtimeContext?.connectionKind ?? null,
    credentialKind: authPrincipal?.credentialKind ?? runtimeContext?.credentialKind ?? null,
    platformAccountId: authPrincipal?.platformAccountId ?? runtimeContext?.platformAccountId ?? null,
    officialServiceKind: authPrincipal?.officialServiceKind ?? runtimeContext?.officialServiceKind ?? null,
    executionBoundary: runtimeContext?.executionBoundary ?? null,
    authPrincipal,
  };

  return Object.freeze({
    ...requestContext,
    authorize(capability, target = {}) {
      const grants = getActiveGrants(engine, authPrincipal);
      return authorizeCapability({
        principal: authPrincipal,
        grants,
        capability,
        target: {
          studioId: requestContext.studioId,
          ...target,
        },
        connectionKind: requestContext.connectionKind,
      });
    },
  });
}

export function jsonError(c, {
  code,
  detail,
  status = 500,
}) {
  assertRouteErrorStatus(status);
  return jsonRouteError(c, {
    code,
    message: typeof detail === "string" && detail.trim() ? detail : code,
    status,
  });
}

function readRuntimeContext(engine) {
  if (typeof engine?.getRuntimeContext !== "function") return null;
  return engine.getRuntimeContext();
}

function readAuthPrincipal(c) {
  if (typeof c?.get !== "function") return null;
  try {
    return c.get("authPrincipal") || null;
  } catch {
    return null;
  }
}

function createAuthPrincipal(runtimeContext) {
  if (!runtimeContext) {
    return normalizePrincipal({ kind: "unknown" });
  }
  const platformAccountId = runtimeContext.platformAccountId ?? null;
  return normalizePrincipal({
    kind: platformAccountId ? "account_user" : "local_user",
    userId: runtimeContext.userId ?? null,
    studioId: runtimeContext.studioId ?? null,
    serverId: runtimeContext.serverId ?? null,
    serverNodeId: runtimeContext.serverNodeId ?? runtimeContext.serverId ?? null,
    platformAccountId,
    officialServiceKind: runtimeContext.officialServiceKind ?? null,
    connectionKind: runtimeContext.connectionKind ?? null,
    credentialKind: runtimeContext.credentialKind ?? null,
    trustState: runtimeContext.trustState ?? null,
    scopes: Array.isArray(runtimeContext.capabilities) ? [...runtimeContext.capabilities] : [],
  });
}

function getActiveGrants(engine, authPrincipal) {
  if (!authPrincipal?.principalId) return [];
  const implicit = implicitPrincipalGrant(authPrincipal);
  if (!engine?.luccodeHome) return implicit ? [implicit] : [];
  try {
    return [
      ...findActiveGrantsForPrincipal(engine.luccodeHome, authPrincipal.principalId),
      ...(implicit ? [implicit] : []),
    ];
  } catch {
    return implicit ? [implicit] : [];
  }
}

function implicitPrincipalGrant(authPrincipal) {
  if (!authPrincipal?.principalId || !authPrincipal?.studioId) return null;
  if (authPrincipal.kind === "local_user") return null;
  const scopes = expandPrincipalScopes(Array.isArray(authPrincipal.scopes) ? authPrincipal.scopes : []);
  if (scopes.length === 0) return null;
  return {
    schemaVersion: 1,
    grantId: `implicit_${authPrincipal.principalId}`,
    principalId: authPrincipal.principalId,
    subjectKind: authPrincipal.kind === "device" ? "device" : "user",
    scope: { studioId: authPrincipal.studioId },
    capabilities: scopes,
    constraints: {
      ...(authPrincipal.connectionKind ? { transportKinds: [authPrincipal.connectionKind] } : {}),
    },
    status: "active",
    createdAt: null,
    updatedAt: null,
  };
}

function expandPrincipalScopes(scopes) {
  const out = new Set(scopes);
  if (out.has("chat")) {
    out.add("chat.read");
    out.add("chat.write");
    out.add("sessions.read");
    out.add("sessions.write");
  }
  if (out.has("resources")) {
    out.add("resources.read");
    out.add("resources.content");
  }
  if (out.has("files")) {
    out.add("files.read");
    out.add("files.write");
  }
  return [...out];
}

function safePathname(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}
