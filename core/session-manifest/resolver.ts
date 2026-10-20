import fs from "fs";
import path from "path";
import { sessionRefFromManifest, sessionRefInputLegacyPath } from "./ref.ts";
import { SessionManifestError } from "./store.ts";

function getLegacyPath(ref) {
  return sessionRefInputLegacyPath(ref);
}

function isJsonlSessionPath(sessionPath) {
  return typeof sessionPath === "string" && path.extname(sessionPath) === ".jsonl";
}

export class SessionManifestResolver {
  declare store: any;

  constructor({ store }) {
    if (!store) throw new Error("SessionManifestResolver requires store");
    this.store = store;
  }

  resolve(ref, opts: any = {}) {
    const sessionId = typeof ref?.sessionId === "string" && ref.sessionId.trim()
      ? ref.sessionId.trim()
      : null;
    if (sessionId) {
      const manifest = this.store.getBySessionId(sessionId);
      if (!manifest) {
        throw new SessionManifestError(
          "session_manifest_not_found",
          `Session manifest not found for sessionId=${sessionId}`,
          { sessionId },
        );
      }
      return manifest;
    }

    const sessionPath = getLegacyPath(ref);
    if (!sessionPath) {
      throw new SessionManifestError(
        "session_manifest_ref_required",
        "Session manifest resolution requires sessionId or legacy sessionPath.",
      );
    }

    const existing = this.store.resolveByLocatorPath(sessionPath);
    if (existing) return existing;

    if (opts.createOnDemand === true && this._canCreateForLegacyPath(sessionPath)) {
      return this.store.createForPath({
        sessionPath,
        ...(opts.manifestDefaults || {}),
        migration: {
          ...(opts.manifestDefaults?.migration || {}),
          legacySessionPath: sessionPath,
          createdBy: "resolver_on_demand",
        },
      });
    }

    throw new SessionManifestError(
      "session_manifest_not_found",
      `Session manifest not found for legacy session path: ${sessionPath}`,
      { sessionPath },
    );
  }

  resolveOptional(ref, opts: any = {}) {
    try {
      return this.resolve(ref, opts);
    } catch (error) {
      if (error?.code === "session_manifest_not_found" || error?.code === "session_manifest_ref_required") {
        return null;
      }
      throw error;
    }
  }

  resolveRef(ref, opts: any = {}) {
    const manifest = this.resolve(ref, opts);
    return sessionRefFromManifest(manifest, getLegacyPath(ref));
  }

  _canCreateForLegacyPath(sessionPath) {
    return isJsonlSessionPath(sessionPath) && fs.existsSync(sessionPath);
  }
}
