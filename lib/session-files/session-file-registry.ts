import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { detectMime, extOfName, inferFileKind } from "../file-metadata.ts";
import { isSessionJsonlFilename } from "../session-jsonl.ts";
import { canonicalFilesystemPathSync, filesystemIdentityKeySync } from "../../shared/link-aware-fs.ts";

export const SESSION_FILE_SIDECAR_VERSION = 1;
export const SESSION_FILE_CACHE_INACTIVE_TTL_MS = 72 * 60 * 60 * 1000;
const AUDIO_WAVEFORM_VERSION = 1;
const MAX_AUDIO_WAVEFORM_PEAKS = 160;

export function sessionFileSidecarPath(sessionPath) {
  return `${sessionPath}.files.json`;
}

export function sessionFilesCacheDir(lucHome, sessionRef) {
  if (!lucHome) throw new Error("lucHome is required for session file cache");
  if (!sessionRef) throw new Error("sessionPath is required for session file cache");
  const hash = createHash("sha256").update(sessionFileOwnerKey(sessionRef)).digest("hex").slice(0, 24);
  return path.join(lucHome, "session-files", hash);
}

export function buildSessionFileSourceKey(namespace, parts = []) {
  const ns = String(namespace || "source")
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, 80) || "source";
  const values = Array.isArray(parts) ? parts : [parts];
  const hash = createHash("sha256")
    .update(JSON.stringify(values.map((part) => part == null ? "" : String(part))))
    .digest("hex");
  return `${ns}:${hash}`;
}

export function moveSessionFileSidecarSync(fromSessionPath, toSessionPath) {
  const src = sessionFileSidecarPath(fromSessionPath);
  if (!fs.existsSync(src)) return false;
  const dest = sessionFileSidecarPath(toSessionPath);
  if (fs.existsSync(dest)) throw new Error("stage file sidecar destination already exists");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest);
  return true;
}

export function deleteSessionFileSidecarSync(sessionPath) {
  fs.rmSync(sessionFileSidecarPath(sessionPath), { force: true });
}

export class SessionFileRegistry {
  declare _byId: any;
  declare _idsBySession: any;
  declare _loadedSessions: any;
  declare _managedCacheRoot: any;
  declare _now: any;
  declare _getSessionIdForPath: any;
  declare _sidecarsBySession: any;
  constructor({ now = () => Date.now(), managedCacheRoot = null, getSessionIdForPath = null }: any = {}) {
    this._now = now;
    this._getSessionIdForPath = typeof getSessionIdForPath === "function" ? getSessionIdForPath : null;
    this._managedCacheRoot = managedCacheRoot ? canonicalFilesystemPathSync(managedCacheRoot) : null;
    this._byId = new Map();
    this._idsBySession = new Map();
    this._sidecarsBySession = new Map();
    this._loadedSessions = new Set();
  }

  setSessionIdResolver(resolver) {
    this._getSessionIdForPath = typeof resolver === "function" ? resolver : null;
  }

  registerFile({
    sessionId = null,
    sessionPath,
    filePath,
    label,
    origin = "unknown",
    storageKind = "external",
    operation = null,
    presentation = "attachment",
    listed = true,
    waveform = null,
    sourceKey = null,
  }: any = {}) {
    if (!sessionPath) throw new Error("sessionPath is required to register a session file");
    if (!filePath || !path.isAbsolute(filePath)) throw new Error("filePath must be an absolute path");
    this._hydrateSession(sessionPath, sessionId);
    const normalizedSourceKey = normalizeSourceKey(sourceKey);

    let incomingRealPath;
    try {
      fs.accessSync(filePath, fs.constants.F_OK);
      incomingRealPath = canonicalFilesystemPathSync(filePath);
    } catch {
      throw new Error(`file not found: ${filePath}`);
    }

    let existing = normalizedSourceKey
      ? this._findSessionFileBySourceKey(sessionPath, normalizedSourceKey) || this._findSessionFileByRealPath(sessionPath, incomingRealPath)
      : this._findSessionFileByRealPath(sessionPath, incomingRealPath);
    const ownerKey = sessionFileOwnerKey({ sessionId, sessionPath });
    const candidateId = buildSessionFileId({ ownerKey, realPath: incomingRealPath, sourceKey: normalizedSourceKey });
    if (!existing && this._byId.has(candidateId)) {
      existing = this._byId.get(candidateId);
    }
    const shouldKeepExistingMaterialization = existing
      && normalizedSourceKey
      && existing.sourceKey === normalizedSourceKey
      && !pathsReferToSameFile(existing.realPath || existing.filePath, incomingRealPath)
      && existingMaterializationExists(existing);
    const materializedFilePath = shouldKeepExistingMaterialization ? existing.filePath : filePath;
    const realPath = shouldKeepExistingMaterialization
      ? canonicalFilesystemPathSync(existing.realPath || existing.filePath)
      : incomingRealPath;

    const stat = fs.statSync(realPath);
    const filename = path.basename(materializedFilePath);
    const ext = extOfName(filename);
    const sample = stat.isFile() ? readSample(realPath) : Buffer.alloc(0);
    const mime = stat.isDirectory()
      ? "inode/directory"
      : detectMime(sample, "application/octet-stream", filename);
    const id = existing?.id || buildSessionFileId({ ownerKey, realPath, sourceKey: normalizedSourceKey });
    const resolvedOperation = operation || inferOperation(origin);
    const operations = addUnique(existing?.operations, resolvedOperation);
    const normalizedWaveform = normalizeAudioWaveform(waveform);

    const entry = Object.freeze({
      ...(existing || {}),
      id,
      ...(sessionId ? { sessionId } : {}),
      sessionPath,
      origin,
      filePath: materializedFilePath,
      realPath,
      ...(normalizedSourceKey ? { sourceKey: normalizedSourceKey } : {}),
      displayName: label || filename,
      filename,
      label: label || filename,
      ext,
      mime,
      size: stat.isDirectory() ? null : stat.size,
      kind: inferFileKind({ mime, ext, isDirectory: stat.isDirectory() }),
      isDirectory: stat.isDirectory(),
      createdAt: existing?.createdAt || this._now(),
      mtimeMs: stat.mtimeMs,
      storageKind,
      presentation: normalizePresentation(presentation),
      listed: listed !== false,
      status: "available",
      missingAt: null,
      operations,
      ...(normalizedWaveform ? { waveform: normalizedWaveform } : {}),
    });

    this._remember(entry, sessionPath);
    const sidecarKey = this._sessionKeyForPath(sessionPath, sessionId);
    const sidecar = this._sidecarsBySession.get(sidecarKey) || emptySidecar(sessionPath, this._now(), sessionId);
    if (sessionId) sidecar.sessionId = sessionId;
    sidecar.files[id] = entry;
    if (shouldAppendRef(sidecar.refs, { fileId: id, origin, operation: resolvedOperation, sourceKey: normalizedSourceKey })) {
      sidecar.refs.push({
        fileId: id,
        origin,
        operation: resolvedOperation,
        storageKind,
        ...(normalizedSourceKey ? { sourceKey: normalizedSourceKey } : {}),
        createdAt: this._now(),
      });
    }
    sidecar.updatedAt = this._now();
    this._sidecarsBySession.set(sidecarKey, sidecar);
    this._saveSidecar(sessionPath, sessionId);
    return entry;
  }

  get(fileId, { sessionId = null, sessionPath = null }: any = {}) {
    if (!fileId) return null;
    let resolvedFileId = fileId;
    if (sessionPath) {
      this._hydrateSession(sessionPath, sessionId);
      const sessionKey = this._sessionKeyForPath(sessionPath, sessionId);
      resolvedFileId = this._resolveScopedFileId(fileId, sessionKey);
      if (!resolvedFileId) return null;
    } else if (sessionId) {
      resolvedFileId = this._resolveScopedFileId(fileId, normalizeSessionId(sessionId));
      if (!resolvedFileId) return null;
    }
    const entry = this._byId.get(resolvedFileId) || null;
    if (!entry) return null;
    if (sessionId && entry.sessionId && entry.sessionId !== sessionId) return null;
    return entry;
  }

  getByFilePath(filePath, { sessionId = null, sessionPath = null }: any = {}) {
    if (!filePath) return null;
    if (sessionPath) this._hydrateSession(sessionPath, sessionId);
    const target = filesystemIdentityKeyOrNull(filePath);
    if (!target) return null;
    const ids = sessionPath
      ? (this._idsBySession.get(this._sessionKeyForPath(sessionPath, sessionId)) || [])
      : Array.from(this._byId.keys());
    for (const id of ids) {
      const entry = this._byId.get(id);
      if (!entry) continue;
      const candidates = [
        entry.filePath,
        entry.realPath,
        ...(sessionPath ? normalizeStringList(entry.legacyFilePaths) : []),
      ].filter(Boolean);
      if (candidates.some((candidate) => filesystemIdentityKeyOrNull(candidate) === target)) {
        return entry;
      }
    }
    return null;
  }

  getBySourceKey(sourceKey, { sessionId = null, sessionPath = null }: any = {}) {
    const normalizedSourceKey = normalizeSourceKey(sourceKey);
    if (!normalizedSourceKey) return null;
    if (sessionPath) this._hydrateSession(sessionPath, sessionId);
    return this._findSessionFileBySourceKey(sessionPath, normalizedSourceKey, sessionId);
  }

  updateTranscription(fileId, transcription, { sessionId = null, sessionPath = null }: any = {}) {
    if (!fileId) throw new Error("fileId is required to update transcription");
    const existing = sessionPath
      ? this.get(fileId, { sessionId, sessionPath })
      : this._byId.get(fileId);
    if (!existing) throw new Error(`session file not found: ${fileId}`);
    if (sessionId && existing.sessionId && existing.sessionId !== sessionId) {
      throw new Error(`session file not found: ${fileId}`);
    }
    const ownerSessionPath = sessionPath || existing.sessionPath;
    if (!ownerSessionPath) throw new Error("sessionPath is required to update transcription");
    const ownerSessionId = sessionId || existing.sessionId || null;
    const current = this.get(fileId, { sessionId: ownerSessionId, sessionPath: ownerSessionPath });
    if (!current) throw new Error(`session file not found: ${fileId}`);
    const now = this._now();
    const nextTranscription = normalizeTranscription(transcription, current.transcription, now);
    const next = freezeEntry({
      ...current,
      transcription: nextTranscription,
    });
    this._remember(next, ownerSessionPath);
    const sidecarKey = this._sessionKeyForPath(ownerSessionPath, ownerSessionId || current.sessionId || null);
    const sidecar = this._sidecarsBySession.get(sidecarKey) || emptySidecar(ownerSessionPath, now, ownerSessionId || current.sessionId || null);
    sidecar.files[current.id] = next;
    sidecar.updatedAt = now;
    this._sidecarsBySession.set(sidecarKey, sidecar);
    this._saveSidecar(ownerSessionPath, sessionId || current.sessionId || null);
    return next;
  }

  forkSessionFiles({
    sourceSessionId,
    sourceSessionPath,
    targetSessionId,
    targetSessionPath,
    retainedEntries = [],
    retainedReferences = [],
  }: any = {}) {
    const sourceId = requireSessionId(sourceSessionId, "sourceSessionId");
    const targetId = requireSessionId(targetSessionId, "targetSessionId");
    requireAbsoluteSessionPath(sourceSessionPath, "sourceSessionPath");
    requireAbsoluteSessionPath(targetSessionPath, "targetSessionPath");
    this._assertResolvedSessionIdentity(sourceSessionPath, sourceId, "source");
    this._assertResolvedSessionIdentity(targetSessionPath, targetId, "target");
    if (sourceId === targetId) throw new Error("targetSessionId must differ from sourceSessionId");
    if (pathsReferToSameFile(sourceSessionPath, targetSessionPath)) {
      throw new Error("targetSessionPath must differ from sourceSessionPath");
    }

    const targetSidecarPath = sessionFileSidecarPath(targetSessionPath);
    if (fs.existsSync(targetSidecarPath)) {
      throw new Error(`target session file sidecar already exists: ${targetSidecarPath}`);
    }

    this._hydrateSession(sourceSessionPath, sourceId);
    const sourceKey = this._sessionKeyForPath(sourceSessionPath, sourceId);
    const sourceSidecar = this._sidecarsBySession.get(sourceKey);
    if (!sourceSidecar) {
      throw new Error(`source session file sidecar identity mismatch for ${sourceSessionPath}`);
    }
    const sourceIds = this._idsBySession.get(sourceKey) || [];
    const sourceFiles = sourceIds.map((id) => this._byId.get(id)).filter(Boolean);
    const retainedIdentities = collectSessionFileReferenceIdentities([retainedEntries, retainedReferences]);
    const selectedFiles = sourceFiles.filter((file) => sessionFileIsReachable(file, retainedIdentities));
    if (!selectedFiles.length) {
      return { files: [], refs: [], fileIdMap: {} };
    }

    const managedFiles = selectedFiles.filter(isManagedCache);
    if (managedFiles.length && !this._managedCacheRoot) {
      throw new Error("managedCacheRoot is required to fork managed session files");
    }

    const targetOwner = { sessionId: targetId, sessionPath: targetSessionPath };
    const targetCacheDir = managedFiles.length
      ? sessionFilesCacheDirFromRoot(this._managedCacheRoot, targetOwner)
      : null;
    if (targetCacheDir && fs.existsSync(targetCacheDir)) {
      throw new Error(`target session file cache already exists: ${targetCacheDir}`);
    }
    const stagedCacheDir = targetCacheDir
      ? `${targetCacheDir}.fork-${process.pid}-${Date.now()}.tmp`
      : null;
    const files: Record<string, any> = {};
    const fileIdMap: Record<string, string> = {};
    const usedManagedNames = new Set<string>();
    let installedCacheDir = false;
    let installedSidecar = false;
    let targetKey: string | null = null;

    try {
      if (stagedCacheDir) fs.mkdirSync(stagedCacheDir, { recursive: true });

      for (const sourceFile of selectedFiles) {
        const sourceFileId = normalizeFileId(sourceFile.id || sourceFile.fileId);
        if (!sourceFileId) throw new Error("source session file is missing an id");
        let childFilePath = sourceFile.filePath;
        let childRealPath = sourceFile.realPath || sourceFile.filePath;
        if (isManagedCache(sourceFile)) {
          const managedName = uniqueManagedForkName(sourceFile, usedManagedNames);
          childFilePath = path.join(targetCacheDir, managedName);
          childRealPath = childFilePath;
          const sourceBytesPath = sourceFile.realPath || sourceFile.filePath;
          if (sourceFile.status === "available" && sourceBytesPath && fs.existsSync(sourceBytesPath)) {
            fs.cpSync(sourceBytesPath, path.join(stagedCacheDir, managedName), {
              recursive: !!sourceFile.isDirectory,
              force: false,
              errorOnExist: true,
            });
          }
        }

        const childFileId = buildSessionFileId({
          ownerKey: sessionFileOwnerKey(targetOwner),
          realPath: childRealPath,
          sourceKey: normalizeSourceKey(sourceFile.sourceKey),
        });
        if (files[childFileId]) {
          throw new Error(`forked session file id collision: ${childFileId}`);
        }
        const legacyFileIds = uniqueStrings([
          ...normalizeStringList(sourceFile.legacyFileIds),
          sourceFileId,
        ], [childFileId]);
        const legacyFilePaths = uniqueStrings([
          ...normalizeStringList(sourceFile.legacyFilePaths),
          sourceFile.filePath,
          sourceFile.realPath,
        ], [childFilePath, childRealPath]);
        const childFile = freezeEntry({
          ...sourceFile,
          id: childFileId,
          sessionId: targetId,
          sessionPath: targetSessionPath,
          filePath: childFilePath,
          realPath: childRealPath,
          ...(legacyFileIds.length ? { legacyFileIds } : {}),
          ...(legacyFilePaths.length ? { legacyFilePaths } : {}),
        });
        files[childFileId] = childFile;
        fileIdMap[sourceFileId] = childFileId;
      }

      const refs = forkSessionFileRefs(sourceSidecar.refs, fileIdMap, files, this._now());
      const now = this._now();
      const targetSidecar = {
        version: SESSION_FILE_SIDECAR_VERSION,
        sessionId: targetId,
        sessionPath: targetSessionPath,
        files,
        refs,
        createdAt: now,
        updatedAt: now,
      };

      if (targetCacheDir && stagedCacheDir) {
        fs.mkdirSync(path.dirname(targetCacheDir), { recursive: true });
        fs.renameSync(stagedCacheDir, targetCacheDir);
        installedCacheDir = true;
      }

      targetKey = this._sessionKeyForPath(targetSessionPath, targetId);
      this._sidecarsBySession.set(targetKey, targetSidecar);
      try {
        this._saveSidecar(targetSessionPath, targetId);
      } catch (err) {
        this._sidecarsBySession.delete(targetKey);
        throw err;
      }
      installedSidecar = true;
      this._loadedSessions.add(targetKey);
      for (const childFile of Object.values(files)) {
        this._remember(childFile, targetSessionPath, targetId);
      }
      return { files: Object.values(files), refs, fileIdMap };
    } catch (err) {
      if (installedSidecar) fs.rmSync(targetSidecarPath, { force: true });
      if (targetKey) {
        this._sidecarsBySession.delete(targetKey);
        this._loadedSessions.delete(targetKey);
      }
      if (stagedCacheDir) fs.rmSync(stagedCacheDir, { recursive: true, force: true });
      if (installedCacheDir && targetCacheDir) {
        this._assertManagedCacheTarget(targetCacheDir);
        fs.rmSync(targetCacheDir, { recursive: true, force: true });
      }
      throw err;
    }
  }

  discardForkedSessionFiles({ sessionId, sessionPath }: any = {}) {
    const targetId = requireSessionId(sessionId, "sessionId");
    requireAbsoluteSessionPath(sessionPath, "sessionPath");
    const resolvedSessionId = this._resolveSessionIdForPath(sessionPath);
    if (resolvedSessionId && resolvedSessionId !== targetId) {
      throw new Error(
        `fork session file identity mismatch: ${sessionPath} belongs to ${resolvedSessionId}, not ${targetId}`,
      );
    }

    const sidecarPath = sessionFileSidecarPath(sessionPath);
    let sidecar = null;
    if (fs.existsSync(sidecarPath)) {
      try {
        sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf-8"));
      } catch (err) {
        throw new Error(`failed to read fork session file sidecar: ${sidecarPath}: ${(err as any).message}`);
      }
      const sidecarSessionId = normalizeSessionId(sidecar?.sessionId);
      if (sidecarSessionId !== targetId) {
        throw new Error(
          `fork session file sidecar identity mismatch: expected ${targetId}, found ${sidecarSessionId || "missing"}`,
        );
      }
    }

    const hasManagedFiles = Object.values(sidecar?.files || {}).some(isManagedCache);
    if (hasManagedFiles && !this._managedCacheRoot) {
      throw new Error("managedCacheRoot is required to discard managed session files");
    }
    const targetCacheDir = this._managedCacheRoot
      ? sessionFilesCacheDirFromRoot(this._managedCacheRoot, { sessionId: targetId, sessionPath })
      : null;
    if (targetCacheDir) this._assertManagedCacheTarget(targetCacheDir);

    const unloaded = this.unloadSession(sessionPath, { sessionId: targetId });
    const sidecarDeleted = fs.existsSync(sidecarPath);
    if (sidecarDeleted) fs.rmSync(sidecarPath, { force: true });
    const managedCacheDeleted = !!targetCacheDir && fs.existsSync(targetCacheDir);
    if (managedCacheDeleted) fs.rmSync(targetCacheDir, { recursive: true, force: true });
    return {
      sessionId: targetId,
      sessionPath,
      sidecarDeleted,
      managedCacheDeleted,
      unloaded,
    };
  }

  list(sessionPath) {
    this._hydrateSession(sessionPath);
    const ids = this._idsBySession.get(this._sessionKeyForPath(sessionPath)) || [];
    return ids.map(id => this._byId.get(id)).filter(Boolean);
  }

  /**
   * Project the durable sidecar superset onto one explicit active branch.
   * Hidden branches keep their sidecar records and managed bytes for recovery,
   * while user-facing/session-scoped consumers only receive reachable files.
   */
  listReachable(sessionPath, references = []) {
    const retainedIdentities = collectSessionFileReferenceIdentities(references);
    if (retainedIdentities.size === 0) return [];
    return this.list(sessionPath).filter((file) => sessionFileIsReachable(file, retainedIdentities));
  }

  unloadSession(sessionPath, { sessionId = null }: any = {}) {
    if (!sessionPath) throw new Error("sessionPath is required to unload session files");
    const key = this._sessionKeyForPath(sessionPath, sessionId);
    const ids = new Set(this._idsBySession.get(key) || []);
    const sidecar = this._sidecarsBySession.get(key);
    for (const file of Object.values(sidecar?.files || {}) as any) {
      if ((file as any)?.id) ids.add((file as any).id);
    }
    const hadSession = this._loadedSessions.has(key)
      || this._sidecarsBySession.has(key)
      || this._idsBySession.has(key);

    for (const [indexedSessionPath, indexedIds] of this._idsBySession) {
      const retainedIds = indexedIds.filter(id => !ids.has(id));
      if (retainedIds.length === indexedIds.length) continue;
      if (retainedIds.length) {
        this._idsBySession.set(indexedSessionPath, retainedIds);
      } else {
        this._idsBySession.delete(indexedSessionPath);
      }
    }
    this._sidecarsBySession.delete(key);
    this._loadedSessions.delete(key);

    for (const id of ids) {
      if (!this._isFileIdReferencedByLoadedSession(id)) this._byId.delete(id);
    }
    return hadSession;
  }

  cleanupColdSessionFiles({ sessionPath, maxInactiveMs = SESSION_FILE_CACHE_INACTIVE_TTL_MS }: any = {}) {
    if (!sessionPath) throw new Error("sessionPath is required to clean session files");
    this._hydrateSession(sessionPath);

    let sessionStat;
    try {
      sessionStat = fs.statSync(sessionPath);
    } catch {
      return { sessionPath, cold: false, skipped: "missing_session", expired: 0, deleted: 0 };
    }

    const ageMs = this._now() - sessionStat.mtimeMs;
    if (ageMs < maxInactiveMs) {
      return { sessionPath, cold: false, ageMs, expired: 0, deleted: 0 };
    }

    const sidecarKey = this._sessionKeyForPath(sessionPath);
    const sidecar = this._sidecarsBySession.get(sidecarKey) || emptySidecar(sessionPath, this._now());
    let expired = 0;
    let deleted = 0;
    let changed = false;

    for (const [id, file] of Object.entries(sidecar.files || {}) as any) {
      if (!isManagedCache(file) || file.status === "expired") continue;
      const target = file.realPath || file.filePath;
      if (target) {
        this._assertManagedCacheTarget(target);
        const existed = fs.existsSync(target);
        fs.rmSync(target, { recursive: true, force: true });
        if (existed) deleted += 1;
      }
      const next = freezeEntry({
        ...(file as any),
        status: "expired",
        missingAt: this._now(),
      });
      sidecar.files[id] = next;
      this._remember(next, sessionPath);
      expired += 1;
      changed = true;
    }

    if (changed) {
      sidecar.updatedAt = this._now();
      this._sidecarsBySession.set(sidecarKey, sidecar);
      this._saveSidecar(sessionPath);
    }

    return { sessionPath, cold: true, ageMs, expired, deleted };
  }

  cleanupColdSessions({ agentsDir, maxInactiveMs = SESSION_FILE_CACHE_INACTIVE_TTL_MS }: any = {}) {
    if (!agentsDir) throw new Error("agentsDir is required to clean session files");
    const sessions = collectSessionPaths(agentsDir);
    const results = [];
    for (const sessionPath of sessions) {
      if (!fs.existsSync(sessionFileSidecarPath(sessionPath))) continue;
      results.push(this.cleanupColdSessionFiles({ sessionPath, maxInactiveMs }));
    }
    return results;
  }

  _hydrateSession(sessionPath, sessionId = null) {
    if (!sessionPath) throw new Error("sessionPath is required");
    const key = this._sessionKeyForPath(sessionPath, sessionId);
    if (this._loadedSessions.has(key)) return;
    const sidecar = this._readSidecar(sessionPath, sessionId);
    const resolvedSessionId = sidecar.sessionId || normalizeSessionId(sessionId) || null;
    const sidecarKey = this._sessionKeyForPath(sessionPath, resolvedSessionId);
    this._sidecarsBySession.set(sidecarKey, sidecar);
    this._loadedSessions.add(sidecarKey);
    for (const raw of Object.values(sidecar.files || {}) as any) {
      const entry = freezeEntry({
        ...(raw as any),
        ...(!(raw as any).sessionId && resolvedSessionId ? { sessionId: resolvedSessionId } : {}),
        operations: (raw as any).operations || operationsFromRefs(sidecar.refs, raw),
      });
      this._remember(entry, sessionPath, resolvedSessionId);
    }
  }

  _findSessionFileByRealPath(sessionPath, realPath) {
    const ids = this._idsBySession.get(this._sessionKeyForPath(sessionPath)) || [];
    const target = filesystemIdentityKeyOrNull(realPath);
    if (!target) return null;
    for (const id of ids) {
      const entry = this._byId.get(id);
      if (!entry) continue;
      const entryRealPath = filesystemIdentityKeyOrNull(entry.realPath || entry.filePath);
      if (entryRealPath && entryRealPath === target) return entry;
    }
    return null;
  }

  _findSessionFileBySourceKey(sessionPath, sourceKey, sessionId = null) {
    const normalizedSourceKey = normalizeSourceKey(sourceKey);
    if (!normalizedSourceKey) return null;
    const ids = sessionPath
      ? (this._idsBySession.get(this._sessionKeyForPath(sessionPath, sessionId)) || [])
      : Array.from(this._byId.keys());
    for (const id of ids) {
      const entry = this._byId.get(id);
      if (!entry?.sourceKey) continue;
      if (entry.sourceKey === normalizedSourceKey) return entry;
    }
    return null;
  }

  _resolveScopedFileId(fileId, sessionKey) {
    if (!sessionKey) return null;
    const ids = this._idsBySession.get(sessionKey) || [];
    if (ids.includes(fileId)) return fileId;
    for (const id of ids) {
      const entry = this._byId.get(id);
      if (normalizeStringList(entry?.legacyFileIds).includes(fileId)) return id;
    }
    return null;
  }

  _remember(entry, requestedSessionPath = null, requestedSessionId = null) {
    this._byId.set(entry.id, entry);
    const sessionId = normalizeSessionId(entry.sessionId) || normalizeSessionId(requestedSessionId);
    const keys = sessionId
      ? new Set([sessionId])
      : new Set([entry.sessionPath, requestedSessionPath].filter(Boolean));
    for (const key of keys) {
      if (!this._idsBySession.has(key)) this._idsBySession.set(key, []);
      const ids = this._idsBySession.get(key);
      if (!ids.includes(entry.id)) ids.push(entry.id);
    }
  }

  _isFileIdReferencedByLoadedSession(fileId) {
    for (const ids of this._idsBySession.values()) {
      if (ids.includes(fileId)) return true;
    }
    return false;
  }

  _readSidecar(sessionPath, sessionId = null) {
    const sidecarPath = sessionFileSidecarPath(sessionPath);
    const resolvedSessionId = normalizeSessionId(sessionId) || this._resolveSessionIdForPath(sessionPath);
    if (!fs.existsSync(sidecarPath)) return emptySidecar(sessionPath, this._now(), resolvedSessionId);
    try {
      const raw = JSON.parse(fs.readFileSync(sidecarPath, "utf-8"));
      if (raw?.version !== SESSION_FILE_SIDECAR_VERSION || !raw.files || typeof raw.files !== "object") {
        throw new Error("invalid sidecar schema");
      }
      return {
        version: SESSION_FILE_SIDECAR_VERSION,
        sessionPath: raw.sessionPath || sessionPath,
        ...(normalizeSessionId(raw.sessionId) || resolvedSessionId ? { sessionId: normalizeSessionId(raw.sessionId) || resolvedSessionId } : {}),
        files: raw.files,
        refs: Array.isArray(raw.refs) ? raw.refs : [],
        createdAt: raw.createdAt || this._now(),
        updatedAt: raw.updatedAt || this._now(),
      };
    } catch (err) {
      throw new Error(`failed to read session file sidecar: ${sidecarPath}: ${(err as any).message}`);
    }
  }

  _saveSidecar(sessionPath, sessionId = null) {
    const sidecar = this._sidecarsBySession.get(this._sessionKeyForPath(sessionPath, sessionId));
    if (!sidecar) return;
    const sidecarPath = sessionFileSidecarPath(sessionPath);
    fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
    const tmpPath = `${sidecarPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmpPath, `${JSON.stringify(sidecar, null, 2)}\n`, "utf-8");
      fs.renameSync(tmpPath, sidecarPath);
    } finally {
      fs.rmSync(tmpPath, { force: true });
    }
  }

  _assertManagedCacheTarget(filePath) {
    if (!this._managedCacheRoot) return;
    const realPath = filesystemIdentityKeySync(filePath);
    if (!isInsideRoot(realPath, filesystemIdentityKeySync(this._managedCacheRoot))) {
      throw new Error(`managed cache file is outside session-files root: ${filePath}`);
    }
  }

  _resolveSessionIdForPath(sessionPath) {
    if (!sessionPath || typeof this._getSessionIdForPath !== "function") return null;
    try {
      return normalizeSessionId(this._getSessionIdForPath(sessionPath));
    } catch {
      return null;
    }
  }

  _assertResolvedSessionIdentity(sessionPath, sessionId, label) {
    const resolvedSessionId = this._resolveSessionIdForPath(sessionPath);
    if (resolvedSessionId && resolvedSessionId !== sessionId) {
      throw new Error(
        `${label} session file identity mismatch: ${sessionPath} belongs to ${resolvedSessionId}, not ${sessionId}`,
      );
    }
  }

  _sessionKeyForPath(sessionPath, sessionId = null) {
    return normalizeSessionId(sessionId) || this._resolveSessionIdForPath(sessionPath) || sessionPath;
  }
}

function emptySidecar(sessionPath, now, sessionId = null) {
  return {
    version: SESSION_FILE_SIDECAR_VERSION,
    sessionPath,
    ...(sessionId ? { sessionId } : {}),
    files: {},
    refs: [],
    createdAt: now,
    updatedAt: now,
  };
}

function freezeEntry(raw) {
  const transcription = normalizeTranscription(raw.transcription, null, raw.updatedAt || raw.createdAt || Date.now());
  const waveform = normalizeAudioWaveform(raw.waveform);
  const { transcription: _transcription, waveform: _waveform, ...rest } = raw;
  return Object.freeze({
    ...rest,
    storageKind: raw.storageKind || "external",
    presentation: normalizePresentation(raw.presentation),
    listed: raw.listed !== false,
    status: raw.status || "available",
    missingAt: raw.missingAt ?? null,
    operations: Array.isArray(raw.operations) ? raw.operations : [],
    ...(transcription ? { transcription } : {}),
    ...(waveform ? { waveform } : {}),
  });
}

function normalizeTranscription(value, existing = null, now = Date.now()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = ["pending", "ready", "failed"].includes(value.status) ? value.status : null;
  if (!status) return null;
  const text = typeof value.text === "string" ? value.text.trim() : "";
  const error = typeof value.error === "string" ? value.error.trim() : "";
  const createdAt = Number.isFinite(Number(value.createdAt))
    ? Number(value.createdAt)
    : Number.isFinite(Number(existing?.createdAt))
      ? Number(existing.createdAt)
      : now;
  return {
    status,
    ...(text ? { text } : {}),
    ...(typeof value.providerId === "string" && value.providerId.trim() ? { providerId: value.providerId.trim() } : {}),
    ...(typeof value.modelId === "string" && value.modelId.trim() ? { modelId: value.modelId.trim() } : {}),
    ...(typeof value.protocolId === "string" && value.protocolId.trim() ? { protocolId: value.protocolId.trim() } : {}),
    ...(typeof value.language === "string" && value.language.trim() ? { language: value.language.trim() } : {}),
    ...(Number.isFinite(Number(value.durationMs)) ? { durationMs: Number(value.durationMs) } : {}),
    ...(error ? { error } : {}),
    createdAt,
    updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : now,
  };
}

function isManagedCache(file) {
  return file?.storageKind === "managed_cache";
}

function normalizeAudioWaveform(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!Array.isArray(value.peaks)) return null;
  const peaks = value.peaks
    .slice(0, MAX_AUDIO_WAVEFORM_PEAKS)
    .map((peak) => clampPeak(Number(peak)))
    .filter((peak) => Number.isFinite(peak));
  if (!peaks.length) return null;
  const durationMs = Number(value.durationMs);
  const source = value.source === "fallback" ? "fallback" : "computed";
  return {
    version: AUDIO_WAVEFORM_VERSION,
    peaks,
    ...(Number.isFinite(durationMs) && durationMs > 0 ? { durationMs } : {}),
    source,
  };
}

function clampPeak(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function collectSessionPaths(agentsDir) {
  let agents = [];
  try { agents = fs.readdirSync(agentsDir, { withFileTypes: true }); } catch { return []; }
  const sessions = [];
  for (const agent of agents) {
    if (!agent.isDirectory()) continue;
    const sessionsDir = path.join(agentsDir, agent.name, "sessions");
    collectJsonlFiles(sessionsDir, sessions);
    collectJsonlFiles(path.join(sessionsDir, "archived"), sessions);
  }
  return sessions;
}

function collectJsonlFiles(dir, out) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.isFile() && isSessionJsonlFilename(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
}

/**
 * Identity key for comparing two paths, not for storing: it canonicalizes through
 * the OS and folds case where the platform ignores it, so the same file spelled
 * two ways compares equal. Anything that reads or mounts the file must use the
 * canonical path instead, which keeps the spelling the filesystem reports.
 */
function filesystemIdentityKeyOrNull(filePath) {
  if (typeof filePath !== "string" || !filePath) return null;
  return filesystemIdentityKeySync(filePath);
}

function pathsReferToSameFile(a, b) {
  const left = filesystemIdentityKeyOrNull(a);
  const right = filesystemIdentityKeyOrNull(b);
  if (!left || !right) return false;
  return left === right;
}

function existingMaterializationExists(file) {
  if (!file || file.status === "expired") return false;
  const target = file.realPath || file.filePath;
  return !!target && fs.existsSync(target);
}

function isInsideRoot(filePath, root) {
  const rel = path.relative(root, filePath);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function readSample(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(8192);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

function buildSessionFileId({ ownerKey, realPath, sourceKey }) {
  const hash = createHash("sha256")
    .update(JSON.stringify([ownerKey, sourceKey || filesystemIdentityKeySync(realPath)]))
    .digest("hex")
    .slice(0, 16);
  return `sf_${hash}`;
}

function sessionFileOwnerKey(value) {
  if (value && typeof value === "object") {
    const sessionId = typeof value.sessionId === "string" && value.sessionId.trim()
      ? value.sessionId.trim()
      : null;
    if (sessionId) return `id:${sessionId}`;
    const sessionPath = typeof value.sessionPath === "string" && value.sessionPath.trim()
      ? value.sessionPath
      : null;
    if (sessionPath) return `path:${sessionPath}`;
  }
  return `path:${String(value)}`;
}

function normalizeSessionId(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeSourceKey(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new Error("sourceKey must be a string");
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 512) throw new Error("sourceKey is too long");
  return trimmed;
}

function requireSessionId(value, fieldName) {
  const sessionId = normalizeSessionId(value);
  if (!sessionId) throw new Error(`${fieldName} is required to fork session files`);
  return sessionId;
}

function requireAbsoluteSessionPath(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${fieldName} is required to fork session files`);
  }
  if (!path.isAbsolute(value)) throw new Error(`${fieldName} must be an absolute path`);
}

function normalizeFileId(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => item.trim());
}

function uniqueStrings(values, excluded = []) {
  const excludedSet = new Set((excluded || []).filter(Boolean));
  const result = [];
  const seen = new Set();
  for (const value of values || []) {
    if (typeof value !== "string" || !value.trim()) continue;
    const normalized = value.trim();
    if (excludedSet.has(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function sessionFilesCacheDirFromRoot(managedCacheRoot, sessionRef) {
  const hash = createHash("sha256")
    .update(sessionFileOwnerKey(sessionRef))
    .digest("hex")
    .slice(0, 24);
  return path.join(managedCacheRoot, hash);
}

const SESSION_FILE_MARKER_RE = /\[SessionFile\]\s+(\{[^\r\n]*\})/g;
const ATTACHED_MEDIA_MARKER_RE = /\[attached_(?:image|video|audio):\s*([^\]]+)\]/g;

function addReferenceIdentity(result, value) {
  if (typeof value !== "string") return;
  const normalized = value.trim();
  if (normalized) result.add(normalized);
}

function collectSessionFileReferenceObject(value, result) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const explicitType = value.type === "session_file"
    || value.type === "session-file"
    || value.kind === "session_file"
    || value.kind === "session-file";
  const fileId = normalizeFileId(value.fileId);
  if (fileId) result.add(fileId);
  if (explicitType && !fileId) addReferenceIdentity(result, value.id);
  if (fileId || explicitType || typeof value.filePath === "string" || typeof value.realPath === "string") {
    addReferenceIdentity(result, value.filePath);
    addReferenceIdentity(result, value.realPath);
    if (fileId || explicitType) addReferenceIdentity(result, value.path);
  }
}

function collectSessionFileReferenceText(value, result) {
  SESSION_FILE_MARKER_RE.lastIndex = 0;
  for (const match of value.matchAll(SESSION_FILE_MARKER_RE)) {
    try {
      collectSessionFileReferenceObject(JSON.parse(match[1]), result);
    } catch {
      // Malformed visible text is not an authorization-bearing file reference.
    }
  }
  ATTACHED_MEDIA_MARKER_RE.lastIndex = 0;
  for (const match of value.matchAll(ATTACHED_MEDIA_MARKER_RE)) {
    addReferenceIdentity(result, match[1]);
  }
}

function collectSessionFileReferenceIdentities(value, result = new Set(), visited = new WeakSet()) {
  if (typeof value === "string") {
    collectSessionFileReferenceText(value, result);
    return result;
  }
  if (!value || typeof value !== "object") return result;
  if (visited.has(value)) return result;
  visited.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectSessionFileReferenceIdentities(item, result, visited);
    return result;
  }
  collectSessionFileReferenceObject(value, result);
  for (const item of Object.values(value)) {
    collectSessionFileReferenceIdentities(item, result, visited);
  }
  return result;
}

function sessionFileIsReachable(file, retainedIdentities) {
  const identities = uniqueStrings([
    file?.id,
    file?.fileId,
    file?.filePath,
    file?.realPath,
    ...normalizeStringList(file?.legacyFileIds),
    ...normalizeStringList(file?.legacyFilePaths),
  ]);
  return identities.some((identity) => retainedIdentities.has(identity));
}

function uniqueManagedForkName(file, usedNames) {
  const sourceId = String(file?.id || file?.fileId || "session-file")
    .replace(/[^a-zA-Z0-9_.-]/g, "_")
    .slice(0, 80) || "session-file";
  const basename = (path.basename(file?.filePath || file?.realPath || "file") || "file").slice(-160);
  const initial = `${sourceId}-${basename}`;
  let candidate = initial;
  let suffix = 2;
  while (usedNames.has(candidate)) {
    candidate = `${sourceId}-${suffix}-${basename}`;
    suffix += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

function forkSessionFileRefs(
  sourceRefs,
  fileIdMap: Record<string, string>,
  files: Record<string, any>,
  now,
) {
  const refs = [];
  const mappedSourceIds = new Set();
  for (const ref of Array.isArray(sourceRefs) ? sourceRefs : []) {
    const sourceId = normalizeFileId(ref?.fileId);
    const targetId = sourceId ? fileIdMap[sourceId] : null;
    if (!targetId) continue;
    mappedSourceIds.add(sourceId);
    refs.push({ ...ref, fileId: targetId });
  }
  for (const [sourceId, targetId] of Object.entries(fileIdMap)) {
    if (mappedSourceIds.has(sourceId)) continue;
    const file = files[targetId];
    refs.push({
      fileId: targetId,
      origin: file?.origin || "session_fork",
      operation: Array.isArray(file?.operations) && file.operations.length
        ? file.operations[file.operations.length - 1]
        : inferOperation(file?.origin),
      storageKind: file?.storageKind || "external",
      ...(file?.sourceKey ? { sourceKey: file.sourceKey } : {}),
      createdAt: file?.createdAt || now,
    });
  }
  return refs;
}

function inferOperation(origin) {
  switch (origin) {
    case "stage_files":
      return "staged";
    case "user_upload":
      return "uploaded";
    case "user_attachment":
    case "bridge_inbound":
      return "attached";
    case "agent_write":
    case "agent_artifact":
    case "plugin_output":
    case "install_skill_output":
      return "created";
    case "agent_edit":
      return "modified";
    case "browser_screenshot":
      return "captured";
    case "skill_install_source":
    case "plugin_install_source":
      return "referenced";
    case "bridge_manual_send":
      return "sent";
    case "voice_input":
      return "recorded";
    default:
      return "registered";
  }
}

function normalizePresentation(value) {
  return value === "voice-input" ? "voice-input" : "attachment";
}

function addUnique(existing, value) {
  const out = Array.isArray(existing) ? [...existing] : [];
  if (value && !out.includes(value)) out.push(value);
  return out;
}

function shouldAppendRef(refs, next) {
  if (next.sourceKey && (refs || []).some(ref =>
    ref?.fileId === next.fileId
    && ref?.origin === next.origin
    && (ref?.operation || inferOperation(ref?.origin)) === next.operation
    && ref?.sourceKey === next.sourceKey
  )) {
    return false;
  }
  if (next.operation !== "staged") return true;
  return !(refs || []).some(ref =>
    ref?.fileId === next.fileId
    && ref?.origin === next.origin
    && (ref?.operation || inferOperation(ref?.origin)) === next.operation
  );
}

function operationsFromRefs(refs, file) {
  const operations = [];
  for (const ref of refs || []) {
    if (ref?.fileId !== file?.id) continue;
    const operation = ref.operation || inferOperation(ref.origin);
    if (operation && !operations.includes(operation)) operations.push(operation);
  }
  return operations;
}
