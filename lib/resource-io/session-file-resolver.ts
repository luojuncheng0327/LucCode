import fs from "fs";
import path from "path";
import { ResourceIOError } from "./errors.ts";
import type { ResourceRef, SessionFileResolution } from "./types.ts";

type Options = {
  sessionFiles: {
    get: (fileId: string, options?: { sessionId?: string | null; sessionPath?: string | null }) => any;
  };
};

export class SessionFileResolver {
  declare sessionFiles: Options["sessionFiles"];

  constructor({ sessionFiles }: Options) {
    if (!sessionFiles) throw new Error("sessionFiles is required");
    this.sessionFiles = sessionFiles;
  }

  resolve(ref: ResourceRef): SessionFileResolution {
    if (ref.kind !== "session-file") {
      throw new ResourceIOError(`session file resolver cannot resolve ${ref.kind}`, {
        code: "invalid_resource_ref",
        status: 400,
      });
    }
    const options = {
      ...(ref.sessionId ? { sessionId: ref.sessionId } : {}),
      ...(ref.sessionPath ? { sessionPath: ref.sessionPath } : {}),
    };
    const entry = this.sessionFiles.get(ref.fileId, options);
    if (!entry) {
      throw new ResourceIOError(`session file not found: ${ref.fileId}`, {
        code: "resource_not_found",
        status: 404,
      });
    }
    if (entry.status === "expired") {
      throw new ResourceIOError(`session file expired: ${ref.fileId}`, {
        code: "resource_expired",
        status: 410,
      });
    }
    const filePath = entry.realPath || entry.filePath;
    if (!filePath || !path.isAbsolute(filePath)) {
      throw new ResourceIOError(`session file path is invalid: ${ref.fileId}`, {
        code: "invalid_resource_path",
        status: 500,
      });
    }
    return {
      ref,
      entry,
      filePath: resolveExistingPath(filePath),
      ...(entry.sourceRef && typeof entry.sourceRef === "object" ? { sourceRef: entry.sourceRef } : {}),
      displayName: entry.displayName || entry.filename || path.basename(filePath),
      storageKind: entry.storageKind || undefined,
    };
  }
}

function resolveExistingPath(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch (err) {
    if ((err as any)?.code === "ENOENT") {
      throw new ResourceIOError(`session file payload missing: ${filePath}`, {
        code: "resource_not_found",
        status: 404,
      });
    }
    throw err;
  }
}
