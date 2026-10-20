import fs from "fs";
import path from "path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  MountAwareFileError,
  MountAwareFileService,
} from "../../core/mount-aware-file-service.ts";
import {
  consumeRemoteWriteLease,
  issueRemoteWriteLease,
  revokeRemoteWriteLease,
} from "../../core/execution-lease-service.ts";
import { safeJson } from "../hono-helpers.ts";
import { serveFileContent } from "../http/file-content.ts";
import { createRequestContext } from "../http/boundary.ts";
import { createApiResourceOperationContext, requestIdFromHono } from "../http/resource-operation-context.ts";
import { recordSecurityAuditEvent } from "../http/security-audit.ts";
import { isLocalOwnerPrincipal } from "../http/route-security.ts";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
// 25MB decoded bytes become ~34MB base64 JSON; 80MB keeps normal multi-file uploads while bounding total request memory.
const MAX_UPLOAD_BODY_BYTES = 80 * 1024 * 1024;
const uploadBodyLimit = bodyLimit({
  maxSize: MAX_UPLOAD_BODY_BYTES,
  onError: (c) => c.json({ error: "payload_too_large" }, 413),
});

export function createMobileWorkbenchRoute(engine) {
  const route = new Hono();

  route.get("/mobile/bootstrap", (c) => {
    engine.gcWorkspacePersistence?.();
    return c.json({
      locale: engine.getLocale?.() || engine.config?.locale || "zh-CN",
      agentName: engine.agentName || "Luc",
      userName: engine.userName || "User",
      // @ui-focus-ok: this is the phone's first-load handshake. It reports which
      // agent the server is currently on so the phone can open there; the phone
      // names an agent explicitly on every request after this one.
      currentAgentId: engine.currentAgentId || null,
      agentYuan: engine.agent?.config?.agent?.yuan || "luc",
      homeFolder: engine.homeCwd || null,
      cwdHistory: Array.isArray(engine.config?.cwd_history) ? engine.config.cwd_history : [],
      memoryMasterEnabled: engine.agent?.memoryMasterEnabled !== false,
      memoryEnabled: engine.config?.memory?.enabled !== false,
      thinkingLevel: engine.getThinkingLevel?.() || "medium",
      editor: engine.config?.editor || {},
      avatars: readAvatarAvailability(engine),
      agents: typeof engine.listAgents === "function" ? sanitizeAgents(engine.listAgents(), engine) : [],
      appearance: engine.getAppearance?.() || {},
    });
  });

  const listWorkbenchFiles = async (c) => {
    try {
      const auth = authorizeWorkbench(c, engine, "files.read");
      if (auth.response) return auth.response;
      return c.json(await fileService(engine, auth.requestContext)
        .listFiles(workbenchMountIdFromRequest(c), c.req.query("subdir") || ""));
    } catch (err) {
      return workbenchError(c, err);
    }
  };
  route.get("/mobile/workbench/files", listWorkbenchFiles);
  route.get("/workbench/files", listWorkbenchFiles);

  const searchWorkbenchFiles = async (c) => {
    try {
      const auth = authorizeWorkbench(c, engine, "files.read");
      if (auth.response) return auth.response;
      return c.json(await fileService(engine, auth.requestContext)
        .searchFiles(workbenchMountIdFromRequest(c), c.req.query("q") || ""));
    } catch (err) {
      return workbenchError(c, err);
    }
  };
  route.get("/mobile/workbench/search", searchWorkbenchFiles);
  route.get("/workbench/search", searchWorkbenchFiles);

  route.get("/mobile/workbench/content", (c) => serveContent(c, engine, false));
  route.on("HEAD", "/mobile/workbench/content", (c) => serveContent(c, engine, true));
  route.get("/workbench/content", (c) => serveContent(c, engine, false));
  route.on("HEAD", "/workbench/content", (c) => serveContent(c, engine, true));

  const runWorkbenchAction = async (c) => {
    const auth = authorizeWorkbench(c, engine, "files.write");
    if (auth.response) return auth.response;
    const body = await safeJson(c);
    const files = fileService(engine, auth.requestContext, c, body);
    const mountId = workbenchMountIdFromBody(body);
    const subdir = body.subdir || "";

    try {
      switch (body.action) {
        case "mkdir":
          return await writeActionResponse(c, engine, "mobile_workbench.mkdir", auth, mountId, (options) => files.mkdir(mountId, subdir, body, options));
        case "create":
        case "writeText":
          return await writeActionResponse(c, engine, "mobile_workbench.write", auth, mountId, (options) => files.writeText(mountId, subdir, body, options));
        case "rename":
          return await writeActionResponse(c, engine, "mobile_workbench.rename", auth, mountId, (options) => files.rename(mountId, subdir, body, options));
        case "move":
          return await writeActionResponse(c, engine, "mobile_workbench.move", auth, mountId, (options) => files.move(mountId, subdir, body, options));
        case "movePaths":
          return await writeActionResponse(c, engine, "mobile_workbench.move_paths", auth, mountId, (options) => files.movePaths(mountId, body, options));
        case "safeDelete":
          return await writeActionResponse(c, engine, "mobile_workbench.safe_delete", auth, mountId, (options) => files.safeDelete(mountId, subdir, body, options));
        default:
          return c.json({ error: "unknown_action" }, 400);
      }
    } catch (err) {
      return workbenchError(c, err);
    }
  };
  route.post("/mobile/workbench/actions", runWorkbenchAction);
  route.post("/workbench/actions", runWorkbenchAction);

  const uploadWorkbenchFiles = async (c) => {
    const auth = authorizeWorkbench(c, engine, "files.write");
    if (auth.response) return auth.response;
    try {
      const body = await safeJson(c);
      const filesService = fileService(engine, auth.requestContext, c, body);
      const mountId = workbenchMountIdFromBody(body);
      const subdir = body.subdir || "";
      const files = Array.isArray(body.files) ? body.files : [body];

      return await writeActionResponse(c, engine, "mobile_workbench.upload", auth, mountId, async (options) => {
        const results = [];
        for (const file of files) {
          try {
            const contentBase64 = String(file.contentBase64 || "");
            if (!contentBase64) throw routeError("contentBase64 required", "invalid_upload", 400);
            const buffer = Buffer.from(contentBase64, "base64");
            if (buffer.byteLength > MAX_UPLOAD_BYTES) throw routeError("file too large", "file_too_large", 413);
            const target = await filesService.writeFileContent(mountId, subdir, file.name, buffer, options);
            results.push({ name: target.filename, ok: true, size: buffer.byteLength });
          } catch (err) {
            results.push({ name: file?.name || null, ok: false, error: err.code || "upload_failed" });
          }
        }
        return {
          ok: results.every((item) => item.ok),
          rootId: mountId,
          mountId,
          results,
          files: await filesService.filesForDirectory(mountId, subdir),
        };
      });
    } catch (err) {
      return workbenchError(c, err);
    }
  };
  route.post("/mobile/workbench/upload", uploadBodyLimit, uploadWorkbenchFiles);
  route.post("/workbench/upload", uploadBodyLimit, uploadWorkbenchFiles);

  return route;
}

function readAvatarAvailability(engine) {
  const avatars = {};
  for (const role of ["agent", "user"]) {
    const baseDir = role === "user" ? engine.userDir : engine.agentDir;
    avatars[role] = false;
    if (!baseDir) continue;
    const dir = path.join(baseDir, "avatars");
    try {
      const files = fs.readdirSync(dir);
      avatars[role] = files.some((file) => /\.(png|jpe?g|webp)$/i.test(file));
    } catch {}
  }
  return avatars;
}

function sanitizeAgents(agents, engine) {
  if (!Array.isArray(agents)) return [];
  return agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    yuan: agent.yuan,
    isPrimary: !!agent.isPrimary,
    isCurrent: !!agent.isCurrent,
    hasAvatar: !!agent.hasAvatar,
    chatModel: agent.chatModel || null,
    homeFolder: agent.homeFolder || null,
    effectiveHomeFolder: engine.getHomeCwd?.(agent.id) || agent.homeFolder || null,
    memoryMasterEnabled: agent.memoryMasterEnabled !== false,
  }));
}

function serveContent(c, engine, headOnly) {
  try {
    const auth = authorizeWorkbench(c, engine, "files.read");
    if (auth.response) return auth.response;
    const target = fileService(engine, auth.requestContext)
      .contentTarget(workbenchMountIdFromRequest(c), c.req.query("subdir") || "", c.req.query("name"));
    const { filePath, filename } = target;
    if (!fs.existsSync(filePath)) return c.json({ error: "file_not_found" }, 404);
    return serveFileContent(c, { filePath, filename, headOnly });
  } catch (err) {
    return workbenchError(c, err);
  }
}

function authorizeWorkbench(c, engine, capability) {
  const requestContext = createRequestContext(c, engine);
  if (requestContext.authPrincipal?.kind === "unknown") return { requestContext, decision: null };
  const decision = requestContext.authorize(capability, {
    kind: "studio",
    studioId: requestContext.studioId,
  });
  if (decision.allowed) return { requestContext, decision };
  recordSecurityAuditEvent(c, engine, {
    action: `mobile_workbench.${capability}`,
    target: { kind: "studio", studioId: requestContext.studioId },
    result: "denied",
    decision,
    errorCode: decision.reason,
  } as any);
  return {
    requestContext,
    decision,
    response: c.json({
      error: "insufficient_scope",
      reason: decision.reason,
      capability,
    }, 403),
  };
}

async function writeActionResponse(c, engine, action, auth, mountId, operation) {
  let lease = null;
  try {
    lease = issueRemoteWriteLease({
      lucHome: engine?.luccodeHome,
      requestContext: auth?.requestContext,
      decision: auth?.decision,
      // The mobile workbench writes files as a subsystem: no agent asked for
      // this and no agent owns the result. Both identity fields name the
      // subsystem, so the audit trail says what actually performed the write
      // rather than whichever agent the server was focused on at the time.
      agentId: "mobile_workbench",
      sessionId: "mobile_workbench",
      resourceIds: [mountId || "default"],
      mountId: mountId && mountId !== "default" ? mountId : null,
    } as any);
    const result = await operation({ reason: action });
    if (lease) consumeRemoteWriteLease(engine?.luccodeHome, lease);
    return auditActionResult(c, engine, action, result, auth, lease);
  } catch (err) {
    if (lease) revokeRemoteWriteLease(engine?.luccodeHome, lease);
    throw err;
  }
}

function workbenchMountIdFromRequest(c) {
  return normalizeWorkbenchMountId(c.req.query("mountId") || c.req.query("rootId"));
}

function workbenchMountIdFromBody(body) {
  return normalizeWorkbenchMountId(body?.mountId || body?.rootId);
}

function normalizeWorkbenchMountId(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "default";
}

function auditActionResult(c, engine, action, result, auth, lease = null) {
  recordSecurityAuditEvent(c, engine, {
    action,
    target: { kind: "studio", studioId: auth?.requestContext?.studioId || null },
    result: result?.ok === false ? "failed" : "success",
    decision: auth?.decision || null,
    leaseId: lease?.leaseId || null,
  } as any);
  return c.json(result);
}

function routeError(message, code, status) {
  const err: any = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function fileService(engine, requestContext, c = null, body = null) {
  const resourceIO = resourceIOForEngine(engine);
  return new MountAwareFileService({
    lucHome: engine.luccodeHome,
    defaultRoot: engine.defaultDeskCwd || engine.homeCwd || engine.deskCwd,
    studioId: requestContext?.studioId || engine.getRuntimeContext?.()?.studioId || null,
    createCheckpoint: typeof engine.createUserEditCheckpoint === "function"
      ? (args) => engine.createUserEditCheckpoint(args)
      : null,
    // 只对桌面端 local owner 披露 local_fs 根的 native 路径；远端/配对设备不披露。
    discloseNativeRoot: isLocalOwnerPrincipal(requestContext?.authPrincipal),
    resourceIO,
    operationContext: createApiResourceOperationContext({
      requestContext,
      sessionId: body?.sessionId,
      sessionPath: body?.sessionPath,
      requestId: body?.requestId || requestIdFromHono(c),
    }),
  });
}

function resourceIOForEngine(engine) {
  const candidate = engine?.resourceIO || engine?.getResourceIO?.();
  return candidate
    && typeof candidate.stat === "function"
    && typeof candidate.write === "function"
    && typeof candidate.list === "function"
    ? candidate
    : null;
}

function workbenchError(c, err) {
  if (err instanceof MountAwareFileError) {
    return c.json({ error: err.code, detail: err.message }, err.status);
  }
  return c.json({ error: err.code || "file_action_failed", detail: err.message }, err.status || 400);
}
