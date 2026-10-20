import { Type } from "../pi-sdk/index.ts";
import { toolError, toolOk } from "../tools/tool-result.ts";
import { resolveToolTarget } from "./agent-tools.ts";

function refForTarget(target, { getSessionPath }) {
  if (target.kind === "session-file") {
    return {
      kind: "session-file",
      fileId: target.fileId,
      sessionPath: target.sessionPath || getSessionPath?.() || null,
    };
  }
  if (target.kind === "local") {
    return { kind: "local-file", path: target.path };
  }
  if (target.kind === "mount") {
    return { kind: "mount", mountId: target.mountId, path: target.path || "" };
  }
  if (target.kind === "resource") {
    return { kind: "resource", resourceId: target.resourceId };
  }
  if (target.kind === "url") {
    return { kind: "url", url: target.url };
  }
  return null;
}

function displayForRef(ref) {
  if (ref.kind === "session-file") return ref.fileId;
  if (ref.kind === "local-file") return ref.path;
  if (ref.kind === "mount") return `mount:${ref.mountId}${ref.path ? `:${ref.path}` : ""}`;
  if (ref.kind === "resource") return ref.resourceId;
  if (ref.kind === "url") return ref.url;
  return "resource";
}

export function createMaterializeTool({
  resourceIO,
  getSessionPath,
  getSessionIdForPath,
  cwd,
}: {
  resourceIO: any;
  getSessionPath?: () => string | null;
  getSessionIdForPath?: (sessionPath: string) => string | null;
  cwd: string;
}) {
  return {
    name: "materialize",
    label: "Materialize",
    description: "Resolve a resource identity to a local absolute path for use in shell commands and other path-based operations. Prefer fileId for session files (uploads, attachments, produced files). Locally this returns the file's real location; remote resources are staged to a local copy first. Read-only: it never modifies the resource.",
    sessionPermission: {
      resolveInvocation: (_params: any = {}) => ({
        action: "materialize",
        kind: "read",
        capability: "materialize.resolve",
      }),
    },
    parameters: Type.Object({
      fileId: Type.Optional(Type.String({
        description: "SessionFile id to resolve. Preferred for files attached or produced in the current session.",
      })),
      sessionPath: Type.Optional(Type.String({
        description: "Optional session JSONL path that owns fileId. Usually omit to use the current session.",
      })),
      resource: Type.Optional(Type.Object({}, {
        description: "ResourceIO target object, such as { kind: 'session-file', fileId }, { kind: 'mount', mountId, path }, { kind: 'resource', resourceId }, or { kind: 'url', url }.",
        additionalProperties: true,
      } as any)),
    }),
    execute: async (_toolCallId, params: any = {}, _signal = null, _onUpdate = null, _ctx: any = {}) => {
      if (!resourceIO || typeof resourceIO.materialize !== "function") {
        return toolError("materialize requires the ResourceIO kernel.", { errorCode: "resource_io_unavailable" });
      }
      const target = resolveToolTarget(params, cwd);
      if (!target) {
        return toolError("materialize requires a target: pass fileId or a resource object.", { errorCode: "target_required" });
      }
      const ref = refForTarget(target, { getSessionPath });
      if (!ref) {
        return toolError(`materialize cannot resolve this target kind: ${target.kind}`, { errorCode: "unsupported_target" });
      }
      const sessionPath = getSessionPath?.() || null;
      const sessionId = sessionPath && typeof getSessionIdForPath === "function"
        ? getSessionIdForPath(sessionPath)
        : null;
      try {
        const materialized = await resourceIO.materialize(ref, {
          source: "agent_tool",
          reason: "materialize",
          ...(sessionId ? { sessionId } : {}),
          ...(sessionPath ? { sessionPath } : {}),
          principal: {
            kind: "agent",
            ...(sessionId ? { sessionId } : {}),
            ...(sessionPath ? { sessionPath } : {}),
          },
          auditRead: true,
        });
        const isDirectory = materialized.isDirectory === true;
        return toolOk(
          `Materialized ${displayForRef(ref)} -> ${materialized.filePath}${isDirectory ? " (directory)" : ""}`,
          {
            filePath: materialized.filePath,
            isDirectory,
            resourceKey: materialized.resourceKey,
          },
        );
      } catch (err) {
        return toolError(err?.message || String(err), { errorCode: "materialize_failed" });
      }
    },
  };
}
