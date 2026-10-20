import { Hono } from "hono";
import { safeJson } from "../hono-helpers.ts";
import { createRequestContext } from "../http/boundary.ts";

/**
 * HTTP surface for the MCP connector manager.
 *
 * The sub-app is mounted twice: at `/mcp` (first-class) and at `/plugins/mcp`
 * (the path this API lived on while MCP shipped as a bundled plugin). The alias
 * keeps already-installed clients and previously issued OAuth redirect URIs
 * working; both mounts serve the identical handlers.
 */
export function createMcpRoute(engine) {
  const sub = new Hono();
  const runtime = () => engine?.mcp;

  async function currentState(c) {
    const rt = runtime();
    if (!rt) return c.json({ error: "not initialized" }, 503);
    const agentId = c.req.query("agentId") || c.get("agentId") || null;
    const config = await rt.getAgentConfig(agentId);
    return c.json({
      ...rt.getState(config),
      // The built-in defer switch lives in preferences, not mcp config; the
      // state view composes both so the settings tab has one source to read.
      builtinDeferEnabled: engine?.preferences?.getBuiltinToolDeferEnabled?.() === true,
    });
  }

  // The callback always points at the first-class path. The legacy path stays
  // routable for redirect URIs issued before the move.
  function redirectUriForRequest(c) {
    const url = new URL(c.req.url);
    return new URL("/api/mcp/oauth/callback", url.origin).href;
  }

  function htmlPage(title, body) {
    return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><body style="font-family:system-ui,-apple-system,sans-serif;padding:32px;line-height:1.5;color:#333;background:#faf8f2"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></body>`;
  }

  sub.get("/state", currentState);

  // Grant one tool invocation for the rest of this session. The capability
  // string comes from the permission descriptor the user was just asked about,
  // so a grant never widens past that exact invocation. Nothing is persisted:
  // the grant dies with the session runtime.
  sub.post("/session-permissions", async (c) => {
    try {
      const requestContext = createRequestContext(c, engine);
      const body = await safeJson(c);
      const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
      const capability = typeof body?.capability === "string" ? body.capability.trim() : "";
      if (!sessionId) return c.json({ error: "missing_param", param: "sessionId" }, 400);
      if (!capability) return c.json({ error: "missing_param", param: "capability" }, 400);

      const manifest = engine.getSessionManifest?.(sessionId) || null;
      const sessionPath = manifest?.currentLocator?.path || null;
      if (!sessionPath) return c.json({ error: "session_manifest_not_found" }, 404);

      if (requestContext.authPrincipal?.kind !== "unknown") {
        if (typeof requestContext.authorize !== "function") {
          return c.json({ error: "insufficient_scope", reason: "missing_policy" }, 403);
        }
        const auth = requestContext.authorize("sessions.write", {
          kind: "session",
          studioId: requestContext.studioId,
          sessionPath,
        });
        if (!auth.allowed) return c.json({ error: "insufficient_scope", reason: auth.reason }, 403);
      }

      const result = engine.allowSessionInvocationCapability({ sessionId, sessionPath }, capability);
      return c.json(result);
    } catch (err: any) {
      return c.json(
        { error: err?.code || "session_permission_grant_failed", message: err?.message || String(err) },
        err?.status || 500,
      );
    }
  });

  sub.get("/apps", (c) => {
    const rt = runtime();
    if (!rt) return c.json({ error: "not initialized" }, 503);
    return c.json({ apps: rt.listApps(), state: rt.getState() });
  });

  async function setGlobalEnabled(c) {
    const rt = runtime();
    if (!rt) return c.json({ error: "not initialized" }, 503);
    const { enabled } = await c.req.json();
    try {
      await rt.setEnabled(enabled === true);
      return currentState(c);
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  }

  sub.put("/settings/enabled", setGlobalEnabled);
  sub.put("/enabled", setGlobalEnabled);

  // Deferred-loading knobs. Both fields are optional; an absent one is left as
  // it is rather than reset, so the two controls can move independently.
  sub.put("/settings/defer", async (c) => {
    const rt = runtime();
    if (!rt) return c.json({ error: "not initialized" }, 503);
    const body = await safeJson(c);
    const patch: Record<string, unknown> = {};
    if (body?.deferEnabled !== undefined) {
      if (typeof body.deferEnabled !== "boolean") {
        return c.json({ error: "deferEnabled must be a boolean" }, 400);
      }
      patch.deferEnabled = body.deferEnabled;
    }
    if (body?.deferThreshold !== undefined) {
      const threshold = body.deferThreshold;
      if (typeof threshold !== "number" || !Number.isSafeInteger(threshold) || threshold <= 0) {
        return c.json({ error: "deferThreshold must be a positive integer" }, 400);
      }
      patch.deferThreshold = threshold;
    }
    if (body?.builtinDeferEnabled !== undefined) {
      if (typeof body.builtinDeferEnabled !== "boolean") {
        return c.json({ error: "builtinDeferEnabled must be a boolean" }, 400);
      }
    }
    try {
      if (Object.keys(patch).length > 0) await rt.setDeferSettings(patch);
      if (typeof body?.builtinDeferEnabled === "boolean") {
        engine?.preferences?.setBuiltinToolDeferEnabled?.(body.builtinDeferEnabled);
      }
      return currentState(c);
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  async function addConnector(c) {
    const rt = runtime();
    if (!rt) return c.json({ error: "not initialized" }, 503);
    try {
      const connector = rt.addConnector(await c.req.json());
      // Adding a connector is a request to use it. Starting is not awaited so a
      // slow or unreachable server cannot hold up the add result; a failure is
      // recorded as the connector's error instead.
      void Promise.resolve(rt.autoStartAfterAdd(connector.id)).catch(() => {});
      const state = rt.getState();
      const publicConnector = state.connectors.find((item) => item.id === connector.id) || connector;
      return c.json({ connector: publicConnector, server: publicConnector, state });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  }

  // Import several connectors at once. The manager validates the whole batch
  // before writing any of it, so a bad row rejects the request without leaving
  // a partial import behind; `results` still names the offending row either way.
  async function addConnectorsBulk(c) {
    const rt = runtime();
    if (!rt) return c.json({ error: "not initialized" }, 503);
    const body = await safeJson(c);
    const connectors = body?.connectors;
    if (!Array.isArray(connectors)) {
      return c.json({ error: "connectors must be an array" }, 400);
    }
    try {
      const results = rt.addConnectors(connectors);
      // Starting is deliberately not awaited: a connector that is slow or down
      // must not hold up the import result.
      for (const result of results) {
        // A fire-and-forget promise must never become an unhandled rejection.
        if (result?.ok && result.id) void Promise.resolve(rt.autoStartAfterAdd(result.id)).catch(() => {});
      }
      return c.json({ results, state: rt.getState() });
    } catch (err: any) {
      return c.json({ error: err.message, ...(err.results ? { results: err.results } : {}) }, 400);
    }
  }

  async function updateConnector(c) {
    const rt = runtime();
    if (!rt) return c.json({ error: "not initialized" }, 503);
    try {
      const connector = await rt.updateConnector(c.req.param("id"), await c.req.json());
      const state = rt.getState();
      const publicConnector = state.connectors.find((item) => item.id === connector.id) || connector;
      return c.json({ connector: publicConnector, server: publicConnector, state });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  }

  async function removeConnector(c) {
    const rt = runtime();
    if (!rt) return c.json({ error: "not initialized" }, 503);
    try {
      await rt.removeConnector(c.req.param("id"));
      return c.json(rt.getState());
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  }

  async function connectorAction(c, action) {
    const rt = runtime();
    if (!rt) return c.json({ error: "not initialized" }, 503);
    try {
      const id = c.req.param("id");
      // The switch is persisted before the transport is touched, so the user's
      // decision survives a restart whether or not the connection succeeds.
      if (action === "start") {
        await rt.setConnectorEnabled(id, true);
        await rt.startConnector(id);
      } else if (action === "stop") {
        await rt.setConnectorEnabled(id, false);
        await rt.stopConnector(id);
      }
      else if (action === "refresh-tools") {
        const tools = await rt.refreshTools(id);
        return c.json({ tools, state: rt.getState() });
      }
      return c.json(rt.getState());
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  }

  async function updateAgentConnector(c) {
    const rt = runtime();
    if (!rt) return c.json({ error: "not initialized" }, 503);
    try {
      const patch = await c.req.json();
      const config = await rt.updateAgentMcpConnector(
        c.req.param("agentId"),
        c.req.param("id"),
        patch,
      );
      return c.json({ config });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  }

  sub.post("/connectors", addConnector);
  sub.post("/servers", addConnector);
  // Registered before the ":id" routes so "bulk" is never read as a connector id.
  sub.post("/connectors/bulk", addConnectorsBulk);
  sub.post("/servers/bulk", addConnectorsBulk);
  sub.put("/connectors/:id", updateConnector);
  sub.put("/servers/:id", updateConnector);
  sub.delete("/connectors/:id", removeConnector);
  sub.delete("/servers/:id", removeConnector);

  sub.post("/connectors/:id/start", (c) => connectorAction(c, "start"));
  sub.post("/servers/:id/start", (c) => connectorAction(c, "start"));
  sub.post("/connectors/:id/stop", (c) => connectorAction(c, "stop"));
  sub.post("/servers/:id/stop", (c) => connectorAction(c, "stop"));
  sub.post("/connectors/:id/refresh-tools", (c) => connectorAction(c, "refresh-tools"));
  sub.post("/servers/:id/refresh-tools", (c) => connectorAction(c, "refresh-tools"));

  async function launchApp(c) {
    const rt = runtime();
    if (!rt) return c.json({ error: "not initialized" }, 503);
    try {
      const body = await readOptionalJson(c);
      return c.json(rt.launchApp(c.req.param("id"), c.req.param("toolName"), {
        launchInput: body?.launchInput ?? body?.input ?? {},
      }));
    } catch (err) {
      return jsonError(c, err);
    }
  }

  async function readResource(c) {
    const rt = runtime();
    if (!rt) return c.json({ error: "not initialized" }, 503);
    const uri = c.req.query("uri") || "";
    if (!uri) return c.json({ error: "uri is required" }, 400);
    try {
      const result = await rt.readResource(c.req.param("id"), uri);
      const content = selectResourceContent(result, uri);
      if (!content) return c.json({ error: "resource content not found" }, 404);
      return resourceContentResponse(content);
    } catch (err) {
      return jsonError(c, err);
    }
  }

  async function callAppTool(c) {
    const rt = runtime();
    if (!rt) return c.json({ error: "not initialized" }, 503);
    try {
      const body = await readOptionalJson(c);
      const result = await rt.callAppTool(
        c.req.param("id"),
        c.req.param("toolName"),
        body?.arguments ?? body?.args ?? body?.input ?? {},
      );
      return c.json({ result });
    } catch (err) {
      return jsonError(c, err);
    }
  }

  sub.post("/connectors/:id/apps/:toolName/launch", launchApp);
  sub.post("/servers/:id/apps/:toolName/launch", launchApp);
  sub.get("/connectors/:id/resources", readResource);
  sub.get("/servers/:id/resources", readResource);
  sub.post("/connectors/:id/app-tools/:toolName/call", callAppTool);
  sub.post("/servers/:id/app-tools/:toolName/call", callAppTool);

  sub.put("/agents/:agentId/connectors/:id", updateAgentConnector);
  sub.put("/agents/:agentId/servers/:id", updateAgentConnector);

  async function startOAuth(c) {
    const rt = runtime();
    if (!rt) return c.json({ error: "not initialized" }, 503);
    try {
      return c.json(await rt.startOAuth(c.req.param("id"), redirectUriForRequest(c)));
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  }

  async function logoutOAuth(c) {
    const rt = runtime();
    if (!rt) return c.json({ error: "not initialized" }, 503);
    try {
      const connector = await rt.logoutOAuth(c.req.param("id"));
      const state = rt.getState();
      const publicConnector = state.connectors.find((item) => item.id === connector.id) || connector;
      return c.json({ connector: publicConnector, state });
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  }

  // End a browser round trip the user gave up on. The wait is abandoned, not
  // failed: nothing about the connector's saved credentials changes.
  function cancelOAuth(c) {
    const rt = runtime();
    if (!rt) return c.json({ error: "not initialized" }, 503);
    try {
      return c.json(rt.cancelOAuth(c.req.param("id")));
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  }

  sub.post("/connectors/:id/oauth/start", startOAuth);
  sub.post("/servers/:id/oauth/start", startOAuth);
  sub.post("/connectors/:id/oauth/cancel", cancelOAuth);
  sub.post("/servers/:id/oauth/cancel", cancelOAuth);
  sub.post("/connectors/:id/oauth/logout", logoutOAuth);
  sub.post("/servers/:id/oauth/logout", logoutOAuth);

  sub.get("/oauth/callback", async (c) => {
    const rt = runtime();
    if (!rt) return c.html(htmlPage("MCP Connector OAuth", "MCP runtime is not initialized."), 503);
    const url = new URL(c.req.url);
    try {
      await rt.completeOAuth({
        state: url.searchParams.get("state") || "",
        code: url.searchParams.get("code") || "",
        error: url.searchParams.get("error") || "",
      });
      return c.html(htmlPage("Connector connected", "You can close this window and return to Luc."));
    } catch (err) {
      return c.html(htmlPage("Connector OAuth failed", err.message), 400);
    }
  });

  sub.get("/oauth/poll/:sessionId", (c) => {
    const rt = runtime();
    if (!rt) return c.json({ error: "not initialized" }, 503);
    return c.json(rt.getOAuthStatus(c.req.param("sessionId")));
  });

  const app = new Hono();
  app.route("/mcp", sub);
  // Legacy alias. It is registered here, ahead of the generic
  // /plugins/:pluginId/* proxy, so these paths never fall through to a plugin
  // lookup that would now miss.
  app.route("/plugins/mcp", sub);
  return app;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function readOptionalJson(c) {
  const contentType = c.req.header("content-type") || "";
  if (!contentType.includes("application/json")) return {};
  try {
    return await c.req.json();
  } catch {
    throw new Error("invalid JSON request body");
  }
}

function jsonError(c, err) {
  const message = err?.message || "MCP request failed";
  return c.json({ error: message }, statusForError(message));
}

function statusForError(message) {
  if (/not initialized/i.test(message)) return 503;
  if (/not found|content not found/i.test(message)) return 404;
  if (/not visible|does not expose/i.test(message)) return 403;
  if (/not running|disabled globally/i.test(message)) return 409;
  // One connector switched off by the user. Its sibling states above already
  // answer 409, and this is the same kind of answer: nothing upstream failed,
  // the system is simply in a state that conflicts with the request, and the
  // remedy is a switch the user owns. Matched on the shared part of the wording
  // so both refusals land here — the one raised when something needs the
  // connector, and the one raised when a start is refused outright.
  if (/is disabled; enable it in Settings/i.test(message)) return 409;
  if (/must start with ui:\/\/|uri is required|invalid JSON request body/i.test(message)) return 400;
  return 502;
}

function selectResourceContent(result, uri) {
  const contents = Array.isArray(result?.contents) ? result.contents : [];
  if (!contents.length) return null;
  const html = contents.find((item) => contentMimeType(item).startsWith("text/html"));
  if (html) return html;
  return contents.find((item) => item?.uri === uri) || contents[0] || null;
}

function resourceContentResponse(content) {
  const mimeType = contentMimeType(content) || "text/plain; charset=utf-8";
  const headers = { "Content-Type": mimeType };
  if (typeof content.text === "string") {
    return new Response(content.text, { status: 200, headers });
  }
  if (typeof content.blob === "string") {
    return new Response(Buffer.from(content.blob, "base64"), { status: 200, headers });
  }
  return new Response(JSON.stringify({ error: "resource content has no text or blob" }), {
    status: 502,
    headers: { "Content-Type": "application/json" },
  });
}

function contentMimeType(content) {
  return typeof content?.mimeType === "string" ? content.mimeType : "";
}
