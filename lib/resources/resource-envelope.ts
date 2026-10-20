export const RESOURCE_ENVELOPE_SCHEMA_VERSION = 1;
export const SESSION_FILE_RESOURCE_PREFIX = "res_";

const SESSION_FILE_ID_RE = /^sf_[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function resourceIdForSessionFileId(fileId) {
  if (!isStableSessionFileId(fileId)) return null;
  return `${SESSION_FILE_RESOURCE_PREFIX}${fileId}`;
}

export function fileIdFromSessionFileResourceId(resourceId) {
  if (typeof resourceId !== "string") return null;
  if (!resourceId.startsWith(SESSION_FILE_RESOURCE_PREFIX)) return null;
  const fileId = resourceId.slice(SESSION_FILE_RESOURCE_PREFIX.length);
  return isStableSessionFileId(fileId) ? fileId : null;
}

export function createSessionFileResourceEnvelope(file, { studioId }: { studioId?: string } = {}) {
  const source = file && typeof file === "object" ? file : {};
  if (typeof studioId !== "string" || !studioId.trim()) return null;

  const fileId = source.fileId || source.id;
  const resourceId = resourceIdForSessionFileId(fileId);
  if (!resourceId) return null;

  const status = typeof source.status === "string" && source.status
    ? source.status
    : "available";
  const isDirectory = source.isDirectory === true;
  const displayName = firstString(source.displayName, source.label, source.filename);
  const envelope = {
    schemaVersion: RESOURCE_ENVELOPE_SCHEMA_VERSION,
    resourceId,
    name: `studios/${studioId}/resources/${resourceId}`,
    studioId,
    type: "file",
    source: "session_file",
    sourceId: fileId,
    fileId,
    ...(displayName ? { displayName } : {}),
    ...(source.filename ? { filename: source.filename } : {}),
    ...(source.ext !== undefined ? { ext: source.ext } : {}),
    ...(source.mime ? { mime: source.mime } : {}),
    ...(source.size !== undefined ? { size: source.size } : {}),
    ...(source.kind ? { kind: source.kind } : {}),
    isDirectory,
    ...(source.origin ? { origin: source.origin } : {}),
    ...(Array.isArray(source.operations) ? { operations: [...source.operations] } : {}),
    ...(source.createdAt !== undefined ? { createdAt: source.createdAt } : {}),
    ...(source.mtimeMs !== undefined ? { mtimeMs: source.mtimeMs } : {}),
    lifecycle: {
      status,
      missingAt: source.missingAt ?? null,
    },
    storage: {
      provider: "session_file",
      storageKind: source.storageKind || "external",
      localOnly: true,
    },
    links: {
      self: `/api/resources/${encodeURIComponent(resourceId)}`,
      ...(status === "available" && !isDirectory
        ? { content: `/api/resources/${encodeURIComponent(resourceId)}/content` }
        : {}),
    },
  };

  return deepFreeze(envelope);
}

function isStableSessionFileId(value) {
  return typeof value === "string" && SESSION_FILE_ID_RE.test(value);
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value) return value;
  }
  return null;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
