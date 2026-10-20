import path from "path";
import { fileURLToPath } from "url";
import { normalizeWin32ShellPath } from "../sandbox/win32-path.ts";

const RESOURCE_IO_FILE_TOOL_NAMES = new Set(["read", "write", "edit", "grep", "find", "ls"]);
const WRITE_TOOL_NAMES = new Set(["write", "edit"]);
const MATERIALIZED_TOOL_NAMES = new Set(["grep", "find"]);
const SESSION_FILE_TOOL_NAMES = new Set(["read", "ls", "grep", "find"]);
const SYNTHETIC_RESOURCE_ROOT = ".luc-resource-io-targets";

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function pathParam(params) {
  if (!isObject(params)) return null;
  return nonEmptyString(params.path)
    || nonEmptyString(params.file_path)
    || nonEmptyString(params.filePath);
}

function normalizeLocalPath(rawPath, cwd) {
  if (!rawPath) return null;
  if (process.platform === "win32") {
    return normalizeWin32ShellPath(rawPath, cwd, { allowRelative: true });
  }
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
}

function parseResourceString(value, cwd) {
  const raw = nonEmptyString(value);
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) {
    return { kind: "url", url: raw };
  }
  if (/^file:\/\//i.test(raw)) {
    return { kind: "local", path: fileURLToPath(raw) };
  }
  const sessionMatch = raw.match(/^(session-file|session_file|sessionfile):(.+)$/i);
  if (sessionMatch) {
    return { kind: "session-file", fileId: sessionMatch[2].trim() };
  }
  return { kind: "local", path: normalizeLocalPath(raw, cwd) };
}

function parseResourceObject(resource, cwd) {
  if (!isObject(resource)) return null;

  const kind = nonEmptyString(resource.kind) || nonEmptyString(resource.type) || nonEmptyString(resource.provider);
  const normalizedKind = kind ? kind.toLowerCase().replace(/_/g, "-") : "";
  const mountId = nonEmptyString(resource.mountId) || nonEmptyString(resource.rootId);
  if (normalizedKind === "mount" || mountId) {
    return mountId ? {
      kind: "mount",
      mountId,
      path: nonEmptyString(resource.path)
        || nonEmptyString(resource.filePath)
        || nonEmptyString(resource.file_path)
        || "",
    } : null;
  }
  const resourceId = nonEmptyString(resource.resourceId)
    || (normalizedKind === "resource" ? nonEmptyString(resource.id) : null);
  if (normalizedKind === "resource" || resourceId) {
    return resourceId ? { kind: "resource", resourceId } : null;
  }
  if (normalizedKind === "url" || normalizedKind === "remote-url" || normalizedKind === "http") {
    const url = nonEmptyString(resource.url) || nonEmptyString(resource.href) || nonEmptyString(resource.uri);
    return url ? { kind: "url", url } : null;
  }
  if (normalizedKind === "session-file" || normalizedKind === "sessionfile") {
    const fileId = nonEmptyString(resource.fileId) || nonEmptyString(resource.id);
    const sessionPath = nonEmptyString(resource.sessionPath);
    return fileId ? { kind: "session-file", fileId, sessionPath } : null;
  }
  if (
    normalizedKind === "local"
    || normalizedKind === "local-path"
    || normalizedKind === "local-file"
    || normalizedKind === "path"
    || normalizedKind === "file"
    || normalizedKind === "local-fs"
  ) {
    const rawPath = nonEmptyString(resource.path)
      || nonEmptyString(resource.filePath)
      || nonEmptyString(resource.file_path);
    return rawPath ? { kind: "local", path: normalizeLocalPath(rawPath, cwd) } : null;
  }

  const uri = nonEmptyString(resource.uri) || nonEmptyString(resource.url);
  if (uri) return parseResourceString(uri, cwd);
  const rawPath = nonEmptyString(resource.path) || nonEmptyString(resource.filePath) || nonEmptyString(resource.file_path);
  if (rawPath) return { kind: "local", path: normalizeLocalPath(rawPath, cwd) };
  return null;
}

export function resolveToolTarget(params, cwd) {
  if (!isObject(params)) return null;

  const resource = params.resource ?? params.ref ?? params.target;
  if (typeof resource === "string") {
    const parsed = parseResourceString(resource, cwd);
    if (parsed) return parsed;
  } else if (isObject(resource)) {
    const parsed = parseResourceObject(resource, cwd);
    if (parsed) return parsed;
  }

  const url = nonEmptyString(params.url) || nonEmptyString(params.href);
  if (url) return { kind: "url", url };

  const fileId = nonEmptyString(params.fileId);
  if (fileId) {
    return {
      kind: "session-file",
      fileId,
      sessionPath: nonEmptyString(params.sessionPath),
    };
  }

  const mountId = nonEmptyString(params.mountId) || nonEmptyString(params.rootId);
  if (mountId) {
    return {
      kind: "mount",
      mountId,
      path: pathParam(params) || "",
    };
  }

  const resourceId = nonEmptyString(params.resourceId);
  if (resourceId) {
    return { kind: "resource", resourceId };
  }

  const rawPath = pathParam(params);
  return rawPath ? { kind: "local", path: normalizeLocalPath(rawPath, cwd) } : null;
}

function stripResourceParams(params) {
  if (!isObject(params)) return params;
  const {
    resource: _resource,
    ref: _ref,
    target: _target,
    url: _url,
    href: _href,
    mountId: _mountId,
    rootId: _rootId,
    resourceId: _resourceId,
    fileId: _fileId,
    sessionPath: _sessionPath,
    ...rest
  } = params;
  return rest;
}

function paramsForLocalTarget(params, absolutePath) {
  return {
    ...stripResourceParams(params),
    path: absolutePath,
  };
}

function paramsForSyntheticTarget(params, syntheticPath) {
  return {
    ...stripResourceParams(params),
    path: syntheticPath,
  };
}

function syntheticSegment(value) {
  return encodeURIComponent(String(value || "root")).replace(/%/g, "_");
}

function splitResourcePath(value) {
  const raw = String(value || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return raw ? raw.split("/").filter(Boolean) : [];
}

function syntheticRootForTarget(target) {
  if (target.kind === "mount") {
    return path.join(SYNTHETIC_RESOURCE_ROOT, "mount", syntheticSegment(target.mountId));
  }
  if (target.kind === "resource") {
    return path.join(SYNTHETIC_RESOURCE_ROOT, "resource", syntheticSegment(target.resourceId));
  }
  return path.join(SYNTHETIC_RESOURCE_ROOT, "unknown");
}

function syntheticPathForTarget(target) {
  const root = syntheticRootForTarget(target);
  if (target.kind === "mount") {
    const segments = splitResourcePath(target.path);
    return segments.length ? path.join(root, ...segments) : root;
  }
  return root;
}

function rootRefForTarget(target) {
  if (target.kind === "mount") {
    return { kind: "mount", mountId: target.mountId, path: "" };
  }
  if (target.kind === "resource") {
    return { kind: "resource", resourceId: target.resourceId };
  }
  return null;
}

function displayTarget(target) {
  if (target.kind === "mount") {
    const resourcePath = String(target.path || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    return `mount:${target.mountId}${resourcePath ? `:${resourcePath}` : ""}`;
  }
  if (target.kind === "resource") return `resource:${target.resourceId}`;
  return target.path || target.url || target.fileId || "resource";
}

function replaceSyntheticPathInResult(result, syntheticPath, displayPath) {
  if (!result || !Array.isArray(result.content)) return result;
  return {
    ...result,
    content: result.content.map((item) => {
      if (!item || item.type !== "text" || typeof item.text !== "string") return item;
      return {
        ...item,
        text: item.text.split(syntheticPath).join(displayPath),
      };
    }),
  };
}

function removePathFromRequired(required) {
  if (!Array.isArray(required)) return required;
  return required.filter((name) => !["path", "file_path", "filePath"].includes(name));
}

function addResourceParameters(parameters, toolName) {
  if (!parameters || typeof parameters !== "object") return parameters;
  const properties = parameters.properties && typeof parameters.properties === "object"
    ? parameters.properties
    : {};
  return {
    ...parameters,
    required: removePathFromRequired(parameters.required),
    properties: {
      ...properties,
      resource: {
        type: "object",
        description: "Optional ResourceIO target. Use { kind: 'local-file', path }, { kind: 'mount', mountId, path }, { kind: 'session-file', fileId }, { kind: 'resource', resourceId }, or { kind: 'url', url }. Existing path/fileId/url parameters also work.",
        additionalProperties: true,
      },
      url: {
        type: "string",
        description: toolName === "read"
          ? "Optional URL to read as text through ResourceIO. URLs are read-only."
          : "URL targets are read-only and are rejected by this tool.",
      },
      fileId: {
        type: "string",
        description: SESSION_FILE_TOOL_NAMES.has(toolName)
          ? "SessionFile id resolved through ResourceIO. Files support read; directory SessionFiles support ls/grep/find."
          : "SessionFile ids are references and cannot be written or edited directly.",
      },
      sessionPath: {
        type: "string",
        description: "Optional session JSONL path that owns fileId. Usually omit to use the current session.",
      },
    },
  };
}

async function readUrlAsText(url, resourceIO) {
  if (!resourceIO || typeof resourceIO.read !== "function") {
    return textResult("ResourceIO URL reads require the ResourceIO kernel.");
  }
  const result = await resourceIO.read({ kind: "url", url });
  const text = Buffer.isBuffer(result.content)
    ? result.content.toString("utf-8")
    : Buffer.from(result.content || "").toString("utf-8");
  return textResult([
    `URL: ${url}`,
    result.version?.etag ? `ETag: ${result.version.etag}` : null,
    "",
    text,
  ].filter((part) => part !== null).join("\n"));
}

function wrapResourceIoTool(tool, options) {
  const toolName = tool?.name;
  if (!RESOURCE_IO_FILE_TOOL_NAMES.has(toolName)) return tool;

  return {
    ...tool,
    parameters: addResourceParameters(tool.parameters, toolName),
    execute: async (toolCallId, params = {}, ...rest) => {
      if (!options.resourceIO) {
        return textResult(`ResourceIO kernel unavailable; ${toolName} cannot run through legacy file tools.`);
      }

      const target: any = resolveToolTarget(params, options.cwd);
      if (!target) return tool.execute(toolCallId, params, ...rest);

      if (target.kind === "url") {
        if (toolName === "read") return readUrlAsText(target.url, options.resourceIO);
        return textResult(`ResourceIO URL targets are read-only; ${toolName} cannot operate on ${target.url}.`);
      }

      if (target.kind === "session-file") {
        if (!SESSION_FILE_TOOL_NAMES.has(toolName)) {
          return textResult(`SessionFile ${target.fileId} is a reference and cannot be written or edited directly. Resolve or materialize it to a local path first.`);
        }
        if (typeof options.resourceIO.materialize !== "function") {
          return textResult("SessionFile access requires the ResourceIO kernel.");
        }
        const materialized = await options.resourceIO.materialize({
          kind: "session-file",
          fileId: target.fileId,
          sessionPath: target.sessionPath || options.getSessionPath?.() || null,
        });
        if (toolName === "read" && materialized.isDirectory === true) {
          return textResult(`SessionFile ${target.fileId} is a directory. Use ls, grep, or find with the same fileId to browse it.`);
        }
        return tool.execute(toolCallId, paramsForLocalTarget(params, materialized.filePath), ...rest);
      }

      if (target.kind === "mount" || target.kind === "resource") {
        if (target.kind === "resource" && WRITE_TOOL_NAMES.has(toolName)) {
          return textResult(`Resource ${target.resourceId} is read-only for Agent ${toolName}. Resolve a writable mount or local path first.`);
        }
        if (MATERIALIZED_TOOL_NAMES.has(toolName)) {
          if (typeof options.resourceIO.materialize !== "function") {
            return textResult(`ResourceIO ${target.kind} ${toolName} requires materialize support.`);
          }
          const materialized = await options.resourceIO.materialize(target);
          const normalizedParams = paramsForLocalTarget(params, materialized.filePath);
          if (typeof options.withResourceTarget === "function") {
            return options.withResourceTarget({
              rootPath: materialized.filePath,
              ref: target,
            }, () => tool.execute(toolCallId, normalizedParams, ...rest));
          }
          return tool.execute(toolCallId, normalizedParams, ...rest);
        }

        if (typeof options.withResourceTarget !== "function") {
          return textResult(`ResourceIO ${target.kind} targets require bound file-tool operations.`);
        }
        const syntheticRoot = syntheticRootForTarget(target);
        const syntheticPath = syntheticPathForTarget(target);
        const rootRef = rootRefForTarget(target);
        const normalizedParams = paramsForSyntheticTarget(params, syntheticPath);
        const result = await options.withResourceTarget({
          rootPath: syntheticRoot,
          ref: rootRef,
        }, () => tool.execute(toolCallId, normalizedParams, ...rest));
        return replaceSyntheticPathInResult(result, syntheticPath, displayTarget(target));
      }

      if (!target.path) return tool.execute(toolCallId, params, ...rest);

      const normalizedParams = paramsForLocalTarget(params, target.path);
      if (!WRITE_TOOL_NAMES.has(toolName)) {
        return tool.execute(toolCallId, normalizedParams, ...rest);
      }

      return tool.execute(toolCallId, normalizedParams, ...rest);
    },
  };
}

function dedupeToolsByName(tools) {
  const seen = new Set();
  return tools.filter((tool) => {
    const name = tool?.name;
    if (!name) return true;
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

export function wrapResourceIoFileTools(tools, options) {
  if (!Array.isArray(tools)) return tools;
  return dedupeToolsByName(tools.map((tool) => wrapResourceIoTool(tool, options)));
}

export const __resourceIoAgentToolsForTest = {
  resolveToolTarget,
  addResourceParameters,
};
