import { Hono } from "hono";
import { createServerRuntimeContext, toServerIdentityResponse } from "../../core/server-runtime-context.ts";
import { readAuthPrincipal } from "../http/capability-guard.ts";
import { SERVER_PROTOCOL_VERSION } from "../../shared/contract-versions.cjs";

export function createServerIdentityRoute({ lucHome, appVersion = "?", getRuntimeContext }: { lucHome?: string; appVersion?: string; getRuntimeContext?: () => any } = {}) {
  const route = new Hono();

  route.get("/server/identity", (c) => {
    try {
      const runtimeContext = typeof getRuntimeContext === "function"
        ? getRuntimeContext()
        : createServerRuntimeContext({ lucHome, appVersion });
      // Additive field, not part of toServerIdentityResponse's own shape:
      // the protocol version is a fixed property of this server build (like
      // its own source constant), not something derived from identity
      // registries — see shared/contract-versions.cjs for why it exists and
      // the renderer-side comparison this feeds (diagnostic only, never a
      // gate; a running install's renderer and server are always supposed
      // to match since they ship together).
      return c.json({
        ...toServerIdentityResponse(
          contextForPrincipal(runtimeContext, readAuthPrincipal(c)),
          { appVersion },
        ),
        serverProtocol: SERVER_PROTOCOL_VERSION,
      });
    } catch (err: any) {
      return c.json({
        error: "invalid server identity registry",
        detail: err.message,
      }, 500);
    }
  });

  return route;
}

function contextForPrincipal(runtimeContext, principal) {
  if (!principal || principal.kind === "local_user") return runtimeContext;
  return {
    ...runtimeContext,
    connectionKind: principal.connectionKind || runtimeContext.connectionKind,
    trustState: principal.trustState || runtimeContext.trustState,
    authState: principal.kind === "device" ? "paired" : "user",
    credentialKind: principal.credentialKind || runtimeContext.credentialKind,
    platformAccountId: principal.platformAccountId ?? null,
    officialServiceKind: principal.officialServiceKind ?? null,
    userId: principal.userId || runtimeContext.userId,
    studioId: principal.studioId || runtimeContext.studioId,
    capabilities: capabilitiesForPrincipal(principal, runtimeContext.capabilities),
  };
}

function capabilitiesForPrincipal(principal, fallback = []) {
  const scopes = Array.isArray(principal?.scopes) ? principal.scopes : [];
  if (scopes.length === 0) return Array.isArray(fallback) ? [...fallback] : [];
  const out = new Set();
  for (const scope of scopes) {
    out.add(scope);
    if (scope === "chat") out.add("chat");
    else if (scope === "resources" || scope.startsWith("resources.")) out.add("resources");
    else if (scope === "files" || scope.startsWith("files.")) out.add("files");
    else if (scope === "tools" || scope.startsWith("tools.")) out.add("tools");
    else if (scope === "settings" || scope.startsWith("settings.")) out.add("settings");
  }
  return [...out];
}
