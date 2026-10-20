import path from "path";
import type { ResourceProviderId, ResourceRef } from "./types.ts";

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizedKind(value: unknown): string | null {
  return nonEmptyString(value)?.replace(/_/g, "-").toLowerCase() || null;
}

function normalizeSlashPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function nestedResourceCandidate(value: Record<string, unknown>): unknown {
  return value.resource ?? value.ref ?? value.target ?? null;
}

export function normalizeResourceRef(input: unknown): ResourceRef {
  if (!input || typeof input !== "object") throw new Error("ResourceRef is required");
  const value = input as Record<string, unknown>;
  const nested = nestedResourceCandidate(value);
  if (nested && typeof nested === "object") return normalizeResourceRef(nested);

  const kind = normalizedKind(value.kind) || normalizedKind(value.type);
  const pathValue = nonEmptyString(value.path)
    || nonEmptyString(value.file_path)
    || nonEmptyString(value.filePath);
  const fileId = nonEmptyString(value.fileId)
    || nonEmptyString(value.sessionFileId)
    || (kind === "session-file" ? nonEmptyString(value.id) : null);
  const resourceId = nonEmptyString(value.resourceId)
    || (kind === "resource" ? nonEmptyString(value.id) : null);
  const url = nonEmptyString(value.url) || nonEmptyString(value.href);
  const mountId = nonEmptyString(value.mountId) || nonEmptyString(value.rootId);

  if (kind === "local-file" || kind === "local-path" || kind === "path") {
    if (!pathValue) throw new Error("local-file ResourceRef requires path");
    return { kind: "local-file", path: pathValue };
  }
  if (kind === "session-file") {
    if (!fileId) throw new Error("session-file ResourceRef requires fileId");
    return {
      kind: "session-file",
      fileId,
      ...(nonEmptyString(value.sessionId) ? { sessionId: nonEmptyString(value.sessionId)! } : {}),
      ...(nonEmptyString(value.sessionPath) ? { sessionPath: nonEmptyString(value.sessionPath)! } : {}),
    };
  }
  if (kind === "mount") {
    if (!mountId) throw new Error("mount ResourceRef requires mountId");
    return { kind: "mount", mountId, path: pathValue || "" };
  }
  if (kind === "resource") {
    if (!resourceId) throw new Error("resource ResourceRef requires resourceId");
    return { kind: "resource", resourceId };
  }
  if (kind === "url") {
    if (!url) throw new Error("url ResourceRef requires url");
    return { kind: "url", url };
  }

  if (url) return { kind: "url", url };
  if (fileId) return { kind: "session-file", fileId };
  if (resourceId) return { kind: "resource", resourceId };
  if (mountId) return { kind: "mount", mountId, path: pathValue || "" };
  if (pathValue) return { kind: "local-file", path: pathValue };
  throw new Error("unsupported ResourceRef");
}

export function resourceKeyForRef(ref: ResourceRef): string {
  switch (ref.kind) {
    case "local-file":
      return `local_fs:${path.resolve(ref.path).replace(/\\/g, "/")}`;
    case "mount":
      return `mount:${ref.mountId}:${normalizeSlashPath(ref.path)}`;
    case "session-file":
      return `session_file:${ref.fileId}`;
    case "resource":
      return `resource:${ref.resourceId}`;
    case "url":
      return `url:${ref.url}`;
  }
}

export function providerIdForResourceRef(ref: ResourceRef): ResourceProviderId {
  switch (ref.kind) {
    case "local-file":
      return "local_fs";
    case "mount":
      return "mount";
    case "session-file":
      return "session_file";
    case "resource":
      return "resource";
    case "url":
      return "url";
  }
}
