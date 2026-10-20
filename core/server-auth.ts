import { authenticateDeviceCredential } from "./device-registry.ts";
import { normalizePrincipal } from "./security-principal.ts";
import { authenticateWebSession } from "./web-session-store.ts";

export function createServerAuthService({
  lucHome,
  loopbackToken,
  runtimeContext,
}) {
  if (!lucHome) throw new Error("lucHome required");
  if (!isNonEmptyString(loopbackToken)) throw new Error("loopbackToken required");

  function resolveRuntimeContext() {
    return typeof runtimeContext === "function" ? runtimeContext() : runtimeContext;
  }

  function authenticateRequest({
    authorization = null,
    queryToken = null,
    cookieHeader = null,
    allowQueryToken = false,
    connectionKind = "local",
    now = undefined as any,
  } = {}) {
    return authenticateRequestDetailed({
      authorization,
      queryToken,
      cookieHeader,
      allowQueryToken,
      connectionKind,
      now,
    }).principal;
  }

  function authenticateRequestDetailed({
    authorization = null,
    queryToken = null,
    cookieHeader = null,
    allowQueryToken = false,
    connectionKind = "local",
    now = undefined as any,
  } = {}) {
    const parsed = parseCredential({ authorization, queryToken, allowQueryToken, connectionKind });
    if (!parsed) {
      const webPrincipal = authenticateWebSession(lucHome, cookieHeader, { now });
      if (!webPrincipal) {
        return denyAuth("missing_credential", { connectionKind });
      }
      if (!principalAllowsConnection(webPrincipal, connectionKind)) {
        return denyAuth("connection_not_allowed", {
          credentialSource: "cookie",
          connectionKind,
        });
      }
      return allowAuth(normalizePrincipal({
        ...webPrincipal,
        connectionKind: connectionKind === "local"
          ? (webPrincipal.connectionKind || connectionKind)
          : connectionKind,
      }));
    }

    if (parsed.token === loopbackToken) {
      if (connectionKind !== "local") {
        return denyAuth("loopback_token_requires_local_transport", {
          credentialSource: parsed.source,
          connectionKind,
        });
      }
      return allowAuth(createLocalPrincipal(resolveRuntimeContext()));
    }

    const devicePrincipal = authenticateDeviceCredential(lucHome, parsed.token, { now });
    if (!devicePrincipal) {
      return denyAuth("invalid_credential", {
        credentialSource: parsed.source,
        connectionKind,
      });
    }
    if (!principalAllowsConnection(devicePrincipal, connectionKind)) {
      return denyAuth("connection_not_allowed", {
        credentialSource: parsed.source,
        connectionKind,
      });
    }
    return allowAuth(normalizePrincipal({
      ...devicePrincipal,
      connectionKind: connectionKind === "local" ? devicePrincipal.connectionKind : connectionKind,
    }));
  }

  function authenticateToken(token, options = {}) {
    return authenticateRequest({
      ...options,
      authorization: token ? `Bearer ${token}` : null,
    });
  }

  return Object.freeze({
    authenticateRequest,
    authenticateRequestDetailed,
    authenticateToken,
  });
}

export function parseBearerAuthorization(authorization) {
  if (!isNonEmptyString(authorization)) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match ? match[1].trim() : null;
}

function parseCredential({ authorization, queryToken, allowQueryToken, connectionKind }) {
  const bearer = parseBearerAuthorization(authorization);
  if (bearer) return { token: bearer, source: "authorization" };
  if (!allowQueryToken || !isNonEmptyString(queryToken)) return null;
  if (connectionKind !== "local") return null;
  return { token: queryToken.trim(), source: "query" };
}

function createLocalPrincipal(runtimeContext) {
  return normalizePrincipal({
    kind: "local_user",
    credentialKind: "loopback_token",
    connectionKind: "local",
    trustState: "local",
    serverId: runtimeContext?.serverId ?? null,
    serverNodeId: runtimeContext?.serverNodeId ?? runtimeContext?.serverId ?? null,
    userId: runtimeContext?.userId ?? null,
    studioId: runtimeContext?.studioId ?? null,
    platformAccountId: runtimeContext?.platformAccountId ?? null,
    officialServiceKind: runtimeContext?.officialServiceKind ?? null,
    scopes: Array.isArray(runtimeContext?.capabilities) ? [...runtimeContext.capabilities] : ["chat", "resources", "tools"],
  });
}

function principalAllowsConnection(principal, connectionKind) {
  if (!principal) return false;
  if (principal.kind === "local_user") return connectionKind === "local";
  if (principal.kind !== "device") return true;
  if (connectionKind === "local") return true;
  if (principal.trustState === "tunnel") return connectionKind === "custom_remote";
  return connectionKind === "lan";
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function allowAuth(principal) {
  return Object.freeze({ principal, denied: null });
}

function denyAuth(reason, details = {}) {
  return Object.freeze({
    principal: null,
    denied: Object.freeze({
      error: "forbidden",
      reason,
      ...details,
    }),
  });
}
