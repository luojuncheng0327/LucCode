export type SessionRef = {
  sessionId: string;
  sessionPath?: string | null;
  legacySessionPath?: string | null;
};

export function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function sessionRefFromManifest(manifest: any, legacySessionPath?: unknown): SessionRef {
  if (!manifest?.sessionId) {
    throw new Error("sessionRefFromManifest requires a manifest with sessionId");
  }
  return {
    sessionId: manifest.sessionId,
    sessionPath: textOrNull(manifest.currentLocator?.path),
    legacySessionPath: textOrNull(legacySessionPath),
  };
}

export function sessionRefInputLegacyPath(ref: any): string | null {
  if (!ref || typeof ref !== "object") return null;
  return textOrNull(ref.sessionPath) || textOrNull(ref.path);
}

function sessionRefError(code: string, message: string) {
  const error: any = new Error(message);
  error.code = code;
  return error;
}

/**
 * Establish the persistent identity for a JSONL locator before a runtime can
 * execute tools or enqueue session-owned work.
 */
export function ensureSessionRefForPath(store: any, sessionPath: unknown, input: any = {}): SessionRef {
  const stableSessionPath = textOrNull(sessionPath);
  if (!store) {
    throw sessionRefError("session_manifest_unavailable", "Session manifest store is unavailable.");
  }
  if (!stableSessionPath) {
    throw sessionRefError("session_locator_required", "Session identity requires a sessionPath locator.");
  }

  const existing = store.resolveByLocatorPath(stableSessionPath);
  if (existing && existing.lifecycle !== "active") {
    throw sessionRefError(
      "session_locator_not_active",
      `Session locator is not active: ${stableSessionPath}`,
    );
  }
  const manifest = existing || store.createForPath({
    ...input,
    sessionPath: stableSessionPath,
  });
  const sessionId = textOrNull(manifest?.sessionId);
  const currentPath = textOrNull(manifest?.currentLocator?.path);
  if (!sessionId || !currentPath) {
    throw sessionRefError(
      "session_manifest_not_established",
      `Session manifest could not be established for locator: ${stableSessionPath}`,
    );
  }
  return { sessionId, sessionPath: currentPath };
}
