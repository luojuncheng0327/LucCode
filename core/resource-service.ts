import fs from "fs";
import path from "path";
import {
  createSessionFileResourceEnvelope,
  fileIdFromSessionFileResourceId,
} from "../lib/resources/resource-envelope.ts";

export class ResourceError extends Error {
  declare status: number;
  declare code: string;

  constructor(message, { status = 500, code = "resource_error" } = {}) {
    super(message);
    this.name = "ResourceError";
    this.status = status;
    this.code = code;
  }
}

export class ResourceService {
  declare _agentsDir: any;
  declare _sessionFiles: any;
  declare _runtimeContext: any;
  declare _now: () => number;
  declare _sessionRefByFileId: Map<string, any>;

  constructor({ agentsDir, sessionFiles, runtimeContext, now = () => Date.now() }: { agentsDir?: any; sessionFiles?: any; runtimeContext?: any; now?: () => number } = {}) {
    if (!agentsDir) throw new Error("agentsDir is required for ResourceService");
    if (!sessionFiles) throw new Error("sessionFiles is required for ResourceService");
    if (!runtimeContext?.studioId) throw new Error("runtimeContext.studioId is required for ResourceService");
    this._agentsDir = agentsDir;
    this._sessionFiles = sessionFiles;
    this._runtimeContext = runtimeContext;
    this._now = now;
    this._sessionRefByFileId = new Map();
  }

  getResource(resourceId) {
    const file = this._reconcileFileAvailability(this._findSessionFileByResourceId(resourceId));
    if (!file) return null;
    return createSessionFileResourceEnvelope(file, { studioId: this._runtimeContext.studioId });
  }

  resolveContent(resourceId) {
    const file = this._reconcileFileAvailability(this._findSessionFileByResourceId(resourceId));
    if (!file) {
      throw new ResourceError("resource not found", {
        status: 404,
        code: "resource_not_found",
      });
    }

    const resource = createSessionFileResourceEnvelope(file, { studioId: this._runtimeContext.studioId });
    if (!resource) {
      throw new ResourceError("invalid resource id", {
        status: 400,
        code: "invalid_resource_id",
      });
    }
    if (file.status === "expired") {
      throw new ResourceError("resource expired", {
        status: 410,
        code: "resource_expired",
      });
    }
    if (file.isDirectory) {
      throw new ResourceError("resource content is not available for directories", {
        status: 409,
        code: "resource_is_directory",
      });
    }

    const sourcePath = file.realPath || file.filePath;
    if (!sourcePath || !path.isAbsolute(sourcePath)) {
      throw new ResourceError("resource content path is invalid", {
        status: 500,
        code: "invalid_resource_content_path",
      });
    }

    let realPath;
    try {
      realPath = fs.realpathSync(sourcePath);
    } catch {
      throw new ResourceError("resource content missing", {
        status: 404,
        code: "resource_content_missing",
      });
    }

    const stat = fs.statSync(realPath);
    if (!stat.isFile()) {
      throw new ResourceError("resource content is not a regular file", {
        status: 409,
        code: "resource_not_file",
      });
    }

    return {
      resourceId: resource.resourceId,
      resource,
      filePath: realPath,
      mime: file.mime || "application/octet-stream",
      size: stat.size,
      filename: file.filename || file.displayName || file.label || path.basename(realPath),
      mtimeMs: stat.mtimeMs,
      etag: `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`,
    };
  }

  _findSessionFileByResourceId(resourceId) {
    const fileId = fileIdFromSessionFileResourceId(resourceId);
    if (!fileId) {
      throw new ResourceError("invalid resource id", {
        status: 400,
        code: "invalid_resource_id",
      });
    }

    const sessionRef = this._findSessionRefForFileId(fileId);
    // The owning session resolves ids the registry knows only as legacy aliases,
    // so an unscoped lookup here would drop that resolution instead of adding to it.
    if (sessionRef) return this._sessionFiles.get(fileId, sessionRef);

    return this._sessionFiles.get(fileId);
  }

  _reconcileFileAvailability(file) {
    if (!file || file.status === "expired") return file;

    const sourcePath = file.realPath || file.filePath;
    if (!sourcePath || !path.isAbsolute(sourcePath)) return file;

    let realPath;
    let stat;
    try {
      realPath = fs.realpathSync(sourcePath);
      stat = fs.statSync(realPath);
    } catch {
      return {
        ...file,
        status: "missing",
        missingAt: file.missingAt ?? this._now(),
      };
    }

    const size = stat.isDirectory() ? null : stat.size;
    const isDirectory = stat.isDirectory();
    if (
      file.status === "available"
      && file.realPath === realPath
      && file.mtimeMs === stat.mtimeMs
      && file.size === size
      && file.isDirectory === isDirectory
      && file.missingAt == null
    ) {
      return file;
    }

    return {
      ...file,
      realPath,
      status: "available",
      missingAt: null,
      mtimeMs: stat.mtimeMs,
      size,
      isDirectory,
    };
  }

  _findSessionRefForFileId(fileId) {
    if (this._sessionRefByFileId.has(fileId)) {
      return this._sessionRefByFileId.get(fileId);
    }

    // A file id a session still owns outranks the same id kept as a fork's alias,
    // so aliases only decide once the whole scan finds no current owner.
    let aliasRef = null;
    for (const sidecarPath of collectSessionFileSidecars(this._agentsDir)) {
      let raw;
      try {
        raw = JSON.parse(fs.readFileSync(sidecarPath, "utf-8"));
      } catch {
        continue;
      }
      if (raw?.version !== 1 || !raw.files || typeof raw.files !== "object") continue;

      const sessionPath = raw.sessionPath || sidecarPath.slice(0, -".files.json".length);
      const sidecarSessionId = typeof raw.sessionId === "string" && raw.sessionId.trim()
        ? raw.sessionId.trim()
        : null;
      for (const id of Object.keys(raw.files)) {
        const entry = raw.files[id];
        const entrySessionId = typeof entry?.sessionId === "string" && entry.sessionId.trim()
          ? entry.sessionId.trim()
          : null;
        const sessionRef = {
          sessionId: entrySessionId || sidecarSessionId,
          sessionPath,
        };
        if (!this._sessionRefByFileId.has(id)) {
          this._sessionRefByFileId.set(id, sessionRef);
        }
        if (!aliasRef && legacyFileIdsOf(entry).includes(fileId)) aliasRef = sessionRef;
      }
      if (Object.prototype.hasOwnProperty.call(raw.files, fileId)) {
        return this._sessionRefByFileId.get(fileId);
      }
    }

    if (aliasRef) {
      this._sessionRefByFileId.set(fileId, aliasRef);
      return aliasRef;
    }

    return null;
  }
}

function legacyFileIdsOf(entry: any) {
  if (!Array.isArray(entry?.legacyFileIds)) return [];
  return entry.legacyFileIds
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim());
}

function collectSessionFileSidecars(rootDir: any) {
  const out = [];
  collectSidecarsRecursive(rootDir, out);
  return out;
}

function collectSidecarsRecursive(dir: any, out: any[]) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSidecarsRecursive(fullPath, out);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl.files.json")) {
      out.push(fullPath);
    }
  }
}
