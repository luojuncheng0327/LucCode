import fs from "fs";
import path from "path";
import { loadStudioMountRegistry } from "./studio-mounts.ts";
import { createSandboxResourceIO } from "../lib/resource-io/sandbox-resource-io.ts";

const SEARCH_LIMIT = 80;

export class MountAwareFileError extends Error {
  declare code: string;
  declare status: number;

  constructor(message, { code = "file_action_failed", status = 400 } = {}) {
    super(message);
    this.name = "MountAwareFileError";
    this.code = code;
    this.status = status;
  }
}

export class MountAwareFileService {
  declare _lucHome: string;
  declare _defaultRoot: string;
  declare _studioId: string;
  declare _createCheckpoint: any;
  declare _discloseNativeRoot: boolean;
  declare _resourceIO: any;
  declare _operationContext: Record<string, any>;

  constructor({
    lucHome,
    defaultRoot,
    studioId,
    createCheckpoint,
    discloseNativeRoot = false,
    resourceIO = null,
    operationContext = null,
  }: Record<string, any> = {}) {
    if (!lucHome) throw new Error("lucHome required");
    this._lucHome = lucHome;
    this._defaultRoot = defaultRoot || null;
    this._studioId = studioId || null;
    this._createCheckpoint = typeof createCheckpoint === "function" ? createCheckpoint : null;
    // 本地 owner（桌面端 loopback principal）可以拿到 local_fs 根的 native 绝对路径，
    // 用于"打开文件夹/拖拽真实路径"等本地集成；远端 principal 一律不披露。
    this._discloseNativeRoot = discloseNativeRoot === true;
    this._resourceIO = isResourceIO(resourceIO)
      ? resourceIO
      : createServiceResourceIO({
        lucHome,
        defaultRoot: this._defaultRoot,
        studioId: this._studioId,
      });
    this._operationContext = normalizeOperationContext(operationContext);
  }

  resolveRoot(rootId = "default") {
    return publicRoot(this._resolveRootInternal(rootId), this._discloseNativeRoot);
  }

  resolveDirectory(rootId = "default", subdir = "") {
    const root = this._resolveRootInternal(rootId);
    const normalized = normalizeSubdirOrThrow(subdir);
    const dir = resolveInsideRoot(root.path, normalized);
    if (!dir) throw fileError("invalid path", "invalid_path", 400);
    return dir;
  }

  async listFiles(rootId = "default", subdir = "") {
    const root = this._resolveRootInternal(rootId);
    requireCapability(root, "list");
    const normalized = normalizeSubdirOrThrow(subdir);
    const dir = resolveInsideRoot(root.path, normalized);
    if (!dir) throw fileError("invalid path", "invalid_path", 400);
    const listed = await this._resourceIO.list(resourceRefForRoot(root, normalized));
    return {
      rootId: root.id,
      mountId: root.mountId || root.id,
      mount: publicRoot(root, this._discloseNativeRoot),
      subdir: normalized,
      files: listItemsForWorkbench(listed.items),
    };
  }

  async searchFiles(rootId = "default", query = "") {
    const root = this._resolveRootInternal(rootId);
    requireCapability(root, "list");
    const q = String(query || "").trim();
    const result = q
      ? await this._resourceIO.search(resourceRefForRoot(root, ""), {
        query: q,
        mode: "name",
        limit: SEARCH_LIMIT,
      })
      : { matches: [] };
    return {
      rootId: root.id,
      mountId: root.mountId || root.id,
      mount: publicRoot(root, this._discloseNativeRoot),
      query: q,
      results: searchMatchesForWorkbench(root.path, result.matches || []),
    };
  }

  contentTarget(rootId = "default", subdir = "", name) {
    const root = this._resolveRootInternal(rootId);
    requireCapability(root, "read");
    const normalized = normalizeSubdirOrThrow(subdir);
    const filename = normalizePlainNameOrThrow(name);
    const dir = resolveInsideRoot(root.path, normalized);
    if (!dir) throw fileError("invalid path", "invalid_path", 400);
    const filePath = resolveFileTarget(root.path, dir, filename);
    if (!filePath) throw fileError("invalid path", "invalid_path", 400);
    return { root, filePath, filename };
  }

  async readText(rootId, subdir, name) {
    const target = this.contentTarget(rootId, subdir, name);
    const subpath = this._normalizeTargetSubpath(subdir, target.filename);
    const ref = resourceRefForTarget(target.root, subpath);
    const stat = await this._resourceIO.stat(ref);
    if (!stat.exists) return { exists: false, content: null, version: null };
    const read = await this._resourceIO.read(ref);
    return {
      exists: true,
      content: Buffer.isBuffer(read.content)
        ? read.content.toString("utf-8")
        : Buffer.from(read.content || "").toString("utf-8"),
      version: read.version || null,
    };
  }

  async mkdir(rootId, subdir, body: Record<string, any> = {}, options: Record<string, any> = {}) {
    const { root, dir } = this._writeDir(rootId, subdir);
    const name = normalizePlainNameOrThrow(body.name);
    const target = resolveFileTarget(root.path, dir, name);
    if (!target) throw fileError("invalid path", "invalid_path", 400);
    const stat = await this._resourceIO.stat(resourceRefForTarget(root, this._normalizeTargetSubpath(subdir, name)));
    if (stat.exists) throw fileError("already exists", "already_exists", 409);
    await this._resourceIO.mkdir(resourceRefForTarget(root, this._normalizeTargetSubpath(subdir, name)), this._mutationOptions(options));
    return workbenchWriteResult(root, "mkdir", { files: await this.filesForDirectory(root.id, subdir) }, this._discloseNativeRoot);
  }

  async writeText(rootId, subdir, body: Record<string, any> = {}, options: Record<string, any> = {}) {
    const { root, dir } = this._writeDir(rootId, subdir);
    const name = normalizePlainNameOrThrow(body.name);
    const target = resolveFileTarget(root.path, dir, name);
    if (!target) throw fileError("invalid path", "invalid_path", 400);
    const expectedVersion = normalizeExpectedVersionOrNull(body.expectedVersion);
    const targetRef = resourceRefForTarget(root, this._normalizeTargetSubpath(subdir, name));
    const stat = await this._resourceIO.stat(targetRef);
    if (options.mustNotExist && stat.exists) {
      throw fileError("target already exists", "target_already_exists", 409);
    }
    if (stat.exists && this._createCheckpoint) {
      await this._createCheckpoint({ filePath: target, reason: "mobile-workbench-edit" }).catch(() => null);
    }
    const writeResult = expectedVersion
      ? await this._resourceIO.writeExpectedVersion(targetRef, String(body.content ?? ""), expectedVersion, this._mutationOptions(options))
      : await this._resourceIO.write(targetRef, String(body.content ?? ""), this._mutationOptions(options));
    if (writeResult?.conflict) {
      return {
        ok: false,
        action: body.action,
        rootId: root.id,
        mountId: root.mountId || root.id,
        mount: publicRoot(root, this._discloseNativeRoot),
        conflict: true,
        version: writeResult.version || null,
        files: await this.filesForDirectory(root.id, subdir),
      };
    }
    return {
      ok: true,
      action: body.action,
      rootId: root.id,
      mountId: root.mountId || root.id,
      mount: publicRoot(root, this._discloseNativeRoot),
      version: writeResult.version || null,
      files: await this.filesForDirectory(root.id, subdir),
    };
  }

  async rename(rootId, subdir, body: Record<string, any> = {}, options: Record<string, any> = {}) {
    const { root, dir } = this._writeDir(rootId, subdir);
    const oldName = normalizePlainNameOrThrow(body.oldName);
    const newName = normalizePlainNameOrThrow(body.newName);
    const source = resolveFileTarget(root.path, dir, oldName);
    const target = resolveFileTarget(root.path, dir, newName);
    if (!source || !target) throw fileError("invalid path", "invalid_path", 400);
    await this._resourceIO.rename(
      resourceRefForTarget(root, this._normalizeTargetSubpath(subdir, oldName)),
      resourceRefForTarget(root, this._normalizeTargetSubpath(subdir, newName)),
      this._mutationOptions(options),
    );
    return workbenchWriteResult(root, "rename", { files: await this.filesForDirectory(root.id, subdir) }, this._discloseNativeRoot);
  }

  async move(rootId, subdir, body: Record<string, any> = {}, options: Record<string, any> = {}) {
    const { root, dir } = this._writeDir(rootId, subdir);
    const name = normalizePlainNameOrThrow(body.name);
    const destSubdir = normalizeSubdirOrThrow(body.destSubdir || "");
    const source = resolveFileTarget(root.path, dir, name);
    const destDir = resolveInsideRoot(root.path, destSubdir);
    if (!source || !destDir) throw fileError("invalid path", "invalid_path", 400);
    await this._resourceIO.mkdir(resourceRefForRoot(root, destSubdir), this._mutationOptions({ ...options, emit: false }));
    await this._resourceIO.move(
      resourceRefForTarget(root, this._normalizeTargetSubpath(subdir, name)),
      resourceRefForTarget(root, this._normalizeTargetSubpath(destSubdir, name)),
      this._mutationOptions(options),
    );
    return workbenchWriteResult(root, "move", { files: await this.filesForDirectory(root.id, subdir) }, this._discloseNativeRoot);
  }

  async movePaths(rootId, body: Record<string, any> = {}, options: Record<string, any> = {}) {
    const root = this._resolveRootInternal(rootId);
    requireCapability(root, "write");
    const items = Array.isArray(body.items) ? body.items : [];
    const destSubdir = normalizeSubdirOrThrow(body.destSubdir || "");
    const currentSubdir = normalizeSubdirOrThrow(body.currentSubdir || "");
    const destDir = resolveInsideRoot(root.path, destSubdir);
    if (!destDir) throw fileError("invalid path", "invalid_path", 400);
    if (body.createDestIfMissing === false) {
      const destStat = await this._resourceIO.stat(resourceRefForRoot(root, destSubdir));
      if (!destStat.exists || !destStat.isDirectory) throw fileError("destSubdir is not a directory", "dest_not_directory", 400);
    } else {
      await this._resourceIO.mkdir(resourceRefForRoot(root, destSubdir), this._mutationOptions({ ...options, emit: false }));
    }

    const touchedSubdirs = new Set([currentSubdir, destSubdir]);
    const results = [];
    for (const item of items) {
      const sourceSubdir = normalizeSubdirOrThrow(item?.sourceSubdir || "");
      const name = normalizePlainNameOrThrow(item?.name);
      const sourceDir = resolveInsideRoot(root.path, sourceSubdir);
      if (!sourceDir) throw fileError("invalid path", "invalid_path", 400);
      const source = resolveFileTarget(root.path, sourceDir, name);
      const target = resolveFileTarget(root.path, destDir, name);
      if (!source || !target) throw fileError("invalid path", "invalid_path", 400);
      const sourceRef = resourceRefForTarget(root, this._normalizeTargetSubpath(sourceSubdir, name));
      const targetRef = resourceRefForTarget(root, this._normalizeTargetSubpath(destSubdir, name));
      const sourceStat = await this._resourceIO.stat(sourceRef);
      const targetStat = await this._resourceIO.stat(targetRef);
      if (!sourceStat.exists) {
        results.push({ name, error: "not found" });
        continue;
      }
      if (sourceStat.resourceKey === targetStat.resourceKey) {
        results.push({ name, ok: true, skipped: true });
        continue;
      }
      if (targetStat.exists) {
        results.push({ name, error: "target already exists" });
        continue;
      }
      const sourceRel = sourceSubdir ? `${sourceSubdir}/${name}` : name;
      if (sourceStat.isDirectory && (destSubdir === sourceRel || destSubdir.startsWith(`${sourceRel}/`))) {
        results.push({ name, error: "cannot move folder into itself" });
        continue;
      }
      try {
        await this._resourceIO.move(sourceRef, targetRef, this._mutationOptions(options));
        touchedSubdirs.add(sourceSubdir);
        touchedSubdirs.add(destSubdir);
        results.push({ name, ok: true });
      } catch (err) {
        results.push({ name, error: err?.code || err?.message || "move_failed" });
      }
    }

    const filesByPath = {};
    for (const subdir of touchedSubdirs) {
      const dir = resolveInsideRoot(root.path, subdir);
      if (dir) filesByPath[subdir] = await this.filesForDirectory(root.id, subdir);
    }
    const currentDir = resolveInsideRoot(root.path, currentSubdir);
    return workbenchWriteResult(root, "movePaths", {
      results,
      filesByPath,
      files: currentDir ? await this.filesForDirectory(root.id, currentSubdir) : [],
    }, this._discloseNativeRoot);
  }

  async safeDelete(rootId, subdir, body: Record<string, any> = {}, options: Record<string, any> = {}) {
    const { root, dir, normalizedSubdir } = this._writeDir(rootId, subdir);
    const name = normalizePlainNameOrThrow(body.name);
    const source = resolveFileTarget(root.path, dir, name);
    if (!source) throw fileError("invalid path", "invalid_path", 400);
    const result = await this._resourceIO.trash(
      resourceRefForTarget(root, this._normalizeTargetSubpath(subdir, name)),
      {
        namespace: "mobile-workbench",
        metadata: {
          rootId: root.id,
          mountId: root.mountId || root.id,
          originalName: name,
          originalSubdir: normalizedSubdir,
        },
      },
      this._mutationOptions(options),
    );
    return workbenchWriteResult(root, "safeDelete", {
      trashId: result.trashId,
      files: await this.filesForDirectory(root.id, subdir),
    }, this._discloseNativeRoot);
  }

  async safeDeleteIfExists(rootId, subdir, name, options: Record<string, any> = {}) {
    const target = this.contentTarget(rootId, subdir, name);
    const subpath = this._normalizeTargetSubpath(subdir, target.filename);
    const stat = await this._resourceIO.stat(resourceRefForTarget(target.root, subpath));
    if (!stat.exists) {
      return workbenchWriteResult(target.root, "safeDelete", {
        trashId: null,
        files: await this.filesForDirectory(target.root.id, subdir),
      }, this._discloseNativeRoot);
    }
    return this.safeDelete(rootId, subdir, { name: target.filename }, options);
  }

  writeFileTarget(rootId, subdir, name) {
    const { root, dir } = this._writeDir(rootId, subdir);
    const filename = normalizePlainNameOrThrow(name);
    const target = resolveFileTarget(root.path, dir, filename);
    if (!target) throw fileError("invalid path", "invalid_path", 400);
    return { root, dir, filename, target };
  }

  async writeFileContent(rootId, subdir, name, content, options: Record<string, any> = {}) {
    const target = this.writeFileTarget(rootId, subdir, name);
    const subpath = this._normalizeTargetSubpath(subdir, target.filename);
    const result = await this._resourceIO.write(
      resourceRefForTarget(target.root, subpath),
      content,
      this._mutationOptions(options),
    );
    return { ...target, result };
  }

  async copyLocalPathIntoDirectory(rootId, subdir, sourcePath, options: Record<string, any> = {}) {
    if (!path.isAbsolute(sourcePath)) throw fileError("invalid path", "invalid_path", 400);
    const target = this.writeFileTarget(rootId, subdir, path.basename(sourcePath));
    const subpath = this._normalizeTargetSubpath(subdir, target.filename);
    const result = await this._resourceIO.copy(
      { kind: "local-file", path: sourcePath },
      resourceRefForTarget(target.root, subpath),
      this._mutationOptions(options),
    );
    return { ...target, result };
  }

  async filesForDirectory(rootId, subdir) {
    return (await this.listFiles(rootId, subdir)).files;
  }

  _normalizeTargetSubpath(subdir, name) {
    return joinResourcePath(normalizeSubdirOrThrow(subdir), normalizePlainNameOrThrow(name));
  }

  _writeDir(rootId = "default", subdir = "") {
    const root = this._resolveRootInternal(rootId);
    requireCapability(root, "write");
    const normalizedSubdir = normalizeSubdirOrThrow(subdir);
    const dir = resolveInsideRoot(root.path, normalizedSubdir);
    if (!dir) throw fileError("invalid path", "invalid_path", 400);
    return { root, dir, normalizedSubdir };
  }

  _mutationOptions(options: Record<string, any> = {}) {
    return mutationOptions(options, this._operationContext);
  }

  _resolveRootInternal(rootId = "default") {
    const id = typeof rootId === "string" && rootId.trim() ? rootId.trim() : "default";
    if (id === "default") {
      if (!this._defaultRoot) throw fileError("no workspace", "no_workspace", 400);
      fs.mkdirSync(this._defaultRoot, { recursive: true });
      return {
        id: "default",
        mountId: "default",
        workspaceId: "default",
        label: "Default",
        presentation: "folder",
        path: this._defaultRoot,
        capabilities: ["list", "read", "write"],
        sourceKind: "storage",
        provider: "local_fs",
      };
    }
    const mount = findLocalFsMount(this._lucHome, this._studioId, id);
    if (!mount) throw fileError("unknown root", "unknown_root", 404);
    const rootPath = mount.rootLocator?.path;
    if (typeof rootPath !== "string" || !path.isAbsolute(rootPath)) {
      throw fileError("invalid mount root", "invalid_mount_root", 400);
    }
    fs.mkdirSync(rootPath, { recursive: true });
    return {
      id: mount.mountId,
      mountId: mount.mountId,
      workspaceId: mount.mountId,
      label: mount.label,
      presentation: mount.presentation,
      path: rootPath,
      capabilities: mount.capabilities,
      sourceKind: mount.sourceKind,
      provider: mount.provider,
    };
  }
}

function workbenchWriteResult<T extends Record<string, any> = Record<string, never>>(
  root,
  action,
  extra: T = {} as T,
  discloseNativeRoot = false,
): {
  ok: true;
  action: any;
  rootId: any;
  mountId: any;
  mount: any;
} & T {
  return {
    ok: true,
    action,
    rootId: root.id,
    mountId: root.mountId || root.id,
    mount: publicRoot(root, discloseNativeRoot),
    ...extra,
  } as {
    ok: true;
    action: any;
    rootId: any;
    mountId: any;
    mount: any;
  } & T;
}

function createServiceResourceIO({ lucHome, defaultRoot, studioId }) {
  if (!defaultRoot) throw fileError("resource io unavailable", "resource_io_unavailable", 500);
  return createSandboxResourceIO({
    cwd: defaultRoot,
    agentDir: defaultRoot,
    workspace: defaultRoot,
    workspaceFolders: [defaultRoot],
    authorizedFolders: [defaultRoot],
    lucHome,
    getSandboxEnabled: () => false,
    getSessionPath: () => null,
    emitEvent: () => {},
    studioId,
  });
}

function isResourceIO(value) {
  return value
    && typeof value.stat === "function"
    && typeof value.read === "function"
    && typeof value.write === "function"
    && typeof value.list === "function";
}

function mutationOptions(options: Record<string, any> = {}, base: Record<string, any> = {}) {
  const out: Record<string, any> = {
    source: options.source || base.source || "api",
  };
  for (const key of ["reason", "sessionId", "sessionPath", "requestId", "principal"]) {
    const value = options[key] !== undefined ? options[key] : base[key];
    if (value !== undefined) out[key] = value;
  }
  if (options.emit === false || base.emit === false) out.emit = false;
  return out;
}

function normalizeOperationContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return {
    ...value,
    ...(value.principal && typeof value.principal === "object" && !Array.isArray(value.principal)
      ? { principal: { ...value.principal } }
      : {}),
  };
}

function resourceRefForRoot(root, subpath = "") {
  const normalized = normalizeSubdirOrThrow(subpath);
  if (root.id === "default") {
    return {
      kind: "local-file",
      path: normalized ? path.join(root.path, ...normalized.split("/")) : root.path,
    };
  }
  return {
    kind: "mount",
    mountId: root.mountId || root.id,
    path: normalized,
  };
}

function resourceRefForTarget(root, subpath = "") {
  const normalized = String(subpath || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (root.id === "default") {
    return {
      kind: "local-file",
      path: normalized ? path.join(root.path, ...normalized.split("/")) : root.path,
    };
  }
  return {
    kind: "mount",
    mountId: root.mountId || root.id,
    path: normalized,
  };
}

function listItemsForWorkbench(items = []) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item && !String(item.name || "").startsWith("."))
    .map((item) => ({
      name: item.name,
      isDir: Boolean(item.isDirectory),
      size: item.isDirectory ? null : item.size ?? null,
      mtime: new Date(item.mtimeMs || 0).toISOString(),
    }))
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, "zh");
    });
}

function searchMatchesForWorkbench(rootPath, matches = []) {
  return (Array.isArray(matches) ? matches : [])
    .filter((match) => match && !String(match.name || path.basename(match.filePath || "")).startsWith("."))
    .map((match) => ({
      name: match.name || path.basename(match.filePath || ""),
      relativePath: match.relativePath || toPortableRelative(rootPath, match.filePath || rootPath),
      parentSubdir: match.parentSubdir || toPortableRelative(rootPath, path.dirname(match.filePath || rootPath)),
      isDir: Boolean(match.isDirectory),
      size: match.isDirectory ? null : match.size ?? null,
      mtime: new Date(match.mtimeMs || Date.now()).toISOString(),
    }))
    .slice(0, SEARCH_LIMIT);
}

function joinResourcePath(...parts) {
  return parts
    .flatMap((part) => String(part || "").split("/"))
    .map((part) => part.trim())
    .filter(Boolean)
    .join("/");
}

function findLocalFsMount(lucHome, studioId, rootId) {
  if (!studioId) return null;
  let registry;
  try {
    registry = loadStudioMountRegistry(lucHome);
  } catch {
    return null;
  }
  return registry.mounts.find((mount) => mount.mountId === rootId
    && mount.hostStudioId === studioId
    && mount.status === "active"
    && mount.sourceKind === "storage"
    && mount.provider === "local_fs") || null;
}

function publicRoot(root, discloseNativeRoot = false) {
  const { path: rootPath, ...safe } = root;
  if (discloseNativeRoot && root.sourceKind === "storage" && root.provider === "local_fs"
    && typeof rootPath === "string" && rootPath) {
    return { ...safe, nativeRootPath: rootPath };
  }
  return safe;
}

function requireCapability(root, capability) {
  if (!root.capabilities?.includes(capability)) {
    throw fileError("mount capability denied", "mount_capability_denied", 403);
  }
}

function normalizeExpectedVersionOrNull(value) {
  if (value == null) return null;
  const mtimeMs = Number(value.mtimeMs);
  const size = Number(value.size);
  if (!Number.isFinite(mtimeMs) || !Number.isFinite(size)) {
    throw fileError("invalid expected version", "invalid_expected_version", 400);
  }
  return {
    mtimeMs,
    size,
    sha256: typeof value.sha256 === "string" ? value.sha256 : undefined,
  };
}

function resolveInsideRoot(rootPath, subdir) {
  const rootReal = realPath(rootPath);
  if (!rootReal) return null;
  const target = subdir ? path.join(rootPath, subdir) : rootPath;
  const targetReal = realPath(target);
  if (targetReal) {
    return targetReal === rootReal || targetReal.startsWith(rootReal + path.sep) ? targetReal : null;
  }
  const full = resolveMissingPath(rootReal, target);
  if (!full) return null;
  return full === rootReal || full.startsWith(rootReal + path.sep) ? full : null;
}

function resolveFileTarget(rootPath, dir, name) {
  const target = path.join(dir, name);
  const rootReal = realPath(rootPath);
  if (!rootReal) return null;
  const resolved = realPath(target);
  if (resolved) return resolved === rootReal || resolved.startsWith(rootReal + path.sep) ? resolved : null;
  const parentReal = realPath(path.dirname(target));
  if (!parentReal) return null;
  const full = path.join(parentReal, path.basename(target));
  return full === rootReal || full.startsWith(rootReal + path.sep) ? full : null;
}

function resolveMissingPath(rootReal, target) {
  const pending = [];
  let current = path.resolve(target);
  while (true) {
    const existing = realPath(current);
    if (existing) return path.join(existing, ...pending.reverse());
    const parent = path.dirname(current);
    if (parent === current) return null;
    pending.push(path.basename(current));
    current = parent;
    const parentRel = path.relative(rootReal, current);
    if (parentRel.startsWith("..") || path.isAbsolute(parentRel)) return null;
  }
}

function normalizeSubdirOrThrow(value) {
  const raw = String(value || "").replace(/^\/+|\/+$/g, "");
  if (!raw) return "";
  if (raw.includes("\\") || raw.split("/").some((part) => part === ".." || part === "." || part.startsWith("."))) {
    throw fileError("invalid_subdir", "invalid_subdir", 400);
  }
  return raw;
}

function normalizePlainNameOrThrow(value) {
  const name = String(value || "").trim();
  if (!name || name.includes("/") || name.includes("\\") || name === "." || name === ".." || name.startsWith(".")) {
    throw fileError("invalid name", "invalid_name", 400);
  }
  return name;
}

function toPortableRelative(root, target) {
  return path.relative(root, target).split(path.sep).filter(Boolean).join("/");
}

function fileError(message, code, status) {
  return new MountAwareFileError(message, { code, status });
}

function realPath(p) {
  try {
    return fs.realpathSync(path.resolve(p));
  } catch {
    return null;
  }
}
