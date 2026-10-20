import { createSessionFileResourceEnvelope } from "../resources/resource-envelope.ts";

export function serializeSessionFile(file, options = {}) {
  if (!file) return null;
  const id = file.id || file.fileId || null;
  const studioId = resolveStudioId(options);
  const resource = studioId
    ? createSessionFileResourceEnvelope({ ...file, ...(id ? { id } : {}) }, { studioId })
    : null;
  return {
    ...(id ? { id, fileId: id } : {}),
    ...(file.sessionId ? { sessionId: file.sessionId } : {}),
    ...(file.sessionPath ? { sessionPath: file.sessionPath } : {}),
    filePath: file.filePath,
    ...(file.realPath ? { realPath: file.realPath } : {}),
    ...(Array.isArray(file.legacyFileIds) && file.legacyFileIds.length ? { legacyFileIds: file.legacyFileIds } : {}),
    ...(Array.isArray(file.legacyFilePaths) && file.legacyFilePaths.length ? { legacyFilePaths: file.legacyFilePaths } : {}),
    ...(file.displayName ? { displayName: file.displayName } : {}),
    ...(file.filename ? { filename: file.filename } : {}),
    ...(file.label ? { label: file.label } : {}),
    ...(file.ext !== undefined ? { ext: file.ext } : {}),
    ...(file.mime ? { mime: file.mime } : {}),
    ...(file.size !== undefined ? { size: file.size } : {}),
    ...(file.kind ? { kind: file.kind } : {}),
    ...(file.isDirectory !== undefined ? { isDirectory: file.isDirectory } : {}),
    ...(file.origin ? { origin: file.origin } : {}),
    ...(Array.isArray(file.operations) ? { operations: file.operations } : {}),
    ...(file.createdAt !== undefined ? { createdAt: file.createdAt } : {}),
    ...(file.mtimeMs !== undefined ? { mtimeMs: file.mtimeMs } : {}),
    ...(sessionFileVersion(file) ? { version: sessionFileVersion(file) } : {}),
    ...(file.storageKind ? { storageKind: file.storageKind } : {}),
    ...(file.presentation ? { presentation: file.presentation } : {}),
    ...(file.listed !== undefined ? { listed: file.listed !== false } : {}),
    ...(file.status ? { status: file.status } : {}),
    ...(file.missingAt !== undefined ? { missingAt: file.missingAt } : {}),
    ...(file.transcription ? { transcription: file.transcription } : {}),
    ...(file.waveform ? { waveform: file.waveform } : {}),
    ...(resource ? { resource } : {}),
  };
}

function sessionFileVersion(file) {
  if (!file || typeof file !== "object") return null;
  if (file.version && typeof file.version === "object") {
    const mtimeMs = Number(file.version.mtimeMs);
    const size = Number(file.version.size);
    if (Number.isFinite(mtimeMs) && Number.isFinite(size)) {
      return Object.freeze({
        mtimeMs,
        size,
        ...(file.version.sha256 ? { sha256: String(file.version.sha256) } : {}),
      });
    }
  }
  const mtimeMs = Number(file.mtimeMs);
  const size = Number(file.size);
  if (!Number.isFinite(mtimeMs) || !Number.isFinite(size)) return null;
  return Object.freeze({ mtimeMs, size });
}

export function registerSessionFileFromRequest(engine, {
  sessionPath,
  filePath,
  label,
  origin,
  storageKind,
  presentation,
  listed,
  waveform,
  sourceKey,
}) {
  if (!sessionPath) return null;
  if (typeof engine?.registerSessionFile !== "function") {
    throw new Error("session file registry unavailable");
  }
  const entry = {
    sessionPath,
    filePath,
    label,
    origin,
    storageKind,
    ...(presentation !== undefined ? { presentation } : {}),
    ...(listed !== undefined ? { listed } : {}),
    ...(waveform !== undefined ? { waveform } : {}),
    ...(sourceKey !== undefined ? { sourceKey } : {}),
  };
  return serializeSessionFile(engine.registerSessionFile(entry), { runtimeContext: safeRuntimeContext(engine) });
}

function resolveStudioId(options: { studioId?: string; runtimeContext?: { studioId?: string } } = {}) {
  if (typeof options.studioId === "string" && options.studioId.trim()) return options.studioId;
  if (typeof options.runtimeContext?.studioId === "string" && options.runtimeContext.studioId.trim()) {
    return options.runtimeContext.studioId;
  }
  return null;
}

function safeRuntimeContext(engine) {
  try {
    if (typeof engine?.getRuntimeContext === "function") return engine.getRuntimeContext();
  } catch {}
  return engine?.runtimeContext || null;
}
