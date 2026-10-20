import fs from "fs";
import path from "path";
import crypto from "crypto";
import { ResourceIOError, resourceAccessDenied, resourceNotFound, targetAlreadyExists } from "../errors.ts";
import { normalizeResourceRef, resourceKeyForRef } from "../resource-refs.ts";
import type {
  MaterializeResult,
  ResourceDescriptor,
  ResourceEdit,
  ResourceListResult,
  ResourceMutationResult,
  ResourceReadResult,
  ResourceRef,
  ResourceSearchResult,
  ResourceStat,
  ResourceTrashOptions,
  ResourceTrashResult,
  ResourceVersion,
  ResourceWriteExpectedVersionResult,
  ResourceMoveResult,
} from "../types.ts";
import type { ResourceAccessDecision } from "../resource-access-policy.ts";

type GuardDecision = ResourceAccessDecision | {
  allowed: boolean;
  reason?: string;
  code?: string;
  safeMessage?: string;
};

type Guard = {
  check: (absolutePath: string, operation: "read" | "write" | "delete") => GuardDecision;
};

type LocalFsProviderOptions = {
  cwd: string;
  guard?: Guard;
  trashRoot?: string | null;
};

const SEARCH_SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage"]);

export class LocalFsProvider {
  readonly id = "local_fs" as const;

  declare cwd: string;
  declare guard: Guard | null;
  declare trashRoot: string | null;

  constructor({ cwd, guard = null, trashRoot = null }: LocalFsProviderOptions) {
    this.cwd = cwd || process.cwd();
    this.guard = guard;
    this.trashRoot = trashRoot || null;
  }

  capabilities() {
    return {
      stat: true,
      read: true,
      write: true,
      writeExpectedVersion: true,
      edit: true,
      list: true,
      search: true,
      watch: true,
      materialize: true,
      copy: true,
      rename: true,
      move: true,
      trash: Boolean(this.trashRoot),
      delete: true,
      mkdir: true,
    };
  }

  async stat(ref: ResourceRef | unknown): Promise<ResourceStat> {
    const filePath = this.resolvePath(ref);
    this.assertAllowed(filePath, "read");
    if (!fs.existsSync(filePath)) {
      return {
        resourceKey: localResourceKey(filePath),
        resource: this.resourceForPath(filePath),
        exists: false,
        isDirectory: false,
        filePath,
      };
    }
    const stat = fs.statSync(filePath);
    return {
      resourceKey: localResourceKey(filePath),
      resource: this.resourceForPath(filePath),
      exists: true,
      isDirectory: stat.isDirectory(),
      version: versionFromStat(stat),
      filePath,
    };
  }

  async read(ref: ResourceRef | unknown): Promise<ResourceReadResult> {
    const filePath = this.resolvePath(ref);
    this.assertAllowed(filePath, "read");
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error(`resource is not a file: ${filePath}`);
    return {
      resourceKey: localResourceKey(filePath),
      resource: this.resourceForPath(filePath),
      content: fs.readFileSync(filePath),
      version: versionFromStat(stat),
      filePath,
    };
  }

  async write(ref: ResourceRef | unknown, content: string | Buffer): Promise<ResourceMutationResult> {
    const filePath = this.resolvePath(ref);
    this.assertAllowed(filePath, "write");
    const existed = fs.existsSync(filePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return this.mutationResult(filePath, existed ? "modified" : "created");
  }

  async writeExpectedVersion(ref: ResourceRef | unknown, content: string | Buffer, expectedVersion: ResourceVersion): Promise<ResourceWriteExpectedVersionResult> {
    const filePath = this.resolvePath(ref);
    this.assertAllowed(filePath, "write");
    const currentVersion = statFileVersionOrNull(filePath);
    if (!currentVersion || !fileVersionsMatch(currentVersion, expectedVersion)) {
      return {
        ok: false,
        conflict: true,
        resourceKey: localResourceKey(filePath),
        resource: this.resourceForPath(filePath),
        ...(currentVersion ? { version: currentVersion } : {}),
        filePath,
      };
    }
    return this.write(ref, content);
  }

  async edit(ref: ResourceRef | unknown, edits: ResourceEdit[]): Promise<ResourceMutationResult> {
    const filePath = this.resolvePath(ref);
    this.assertAllowed(filePath, "read");
    this.assertAllowed(filePath, "write");
    let text = fs.readFileSync(filePath, "utf-8");
    for (const edit of edits || []) {
      if (typeof edit?.oldText !== "string" || typeof edit?.newText !== "string") {
        throw new Error("resource edit requires oldText and newText");
      }
      if (!text.includes(edit.oldText)) {
        throw new Error("resource edit oldText not found");
      }
      text = text.replace(edit.oldText, edit.newText);
    }
    fs.writeFileSync(filePath, text, "utf-8");
    return this.mutationResult(filePath, "modified");
  }

  async mkdir(ref: ResourceRef | unknown): Promise<ResourceMutationResult> {
    const filePath = this.resolvePath(ref);
    this.assertAllowed(filePath, "write");
    const existed = fs.existsSync(filePath);
    fs.mkdirSync(filePath, { recursive: true });
    return this.mutationResult(filePath, existed ? "modified" : "created");
  }

  async delete(ref: ResourceRef | unknown): Promise<ResourceMutationResult> {
    const filePath = this.resolvePath(ref);
    this.assertAllowed(filePath, "delete");
    const result = this.mutationResult(filePath, "modified");
    fs.rmSync(filePath, { recursive: true, force: false });
    return result;
  }

  async copy(from: ResourceRef | unknown, to: ResourceRef | unknown): Promise<ResourceMutationResult> {
    const sourcePath = this.resolvePath(from);
    const targetPath = this.resolvePath(to);
    this.assertAllowed(sourcePath, "read");
    this.assertAllowed(targetPath, "write");
    const existed = fs.existsSync(targetPath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const sourceStat = fs.statSync(sourcePath);
    if (sourceStat.isDirectory()) {
      fs.cpSync(sourcePath, targetPath, { recursive: true });
    } else {
      fs.copyFileSync(sourcePath, targetPath);
    }
    return this.mutationResult(targetPath, existed ? "modified" : "created");
  }

  async rename(from: ResourceRef | unknown, to: ResourceRef | unknown): Promise<ResourceMoveResult> {
    return this.move(from, to);
  }

  async move(from: ResourceRef | unknown, to: ResourceRef | unknown): Promise<ResourceMoveResult> {
    const sourcePath = this.resolvePath(from);
    const targetPath = this.resolvePath(to);
    this.assertAllowed(sourcePath, "delete");
    this.assertAllowed(targetPath, "write");
    if (!fs.existsSync(sourcePath)) throw resourceNotFound(sourcePath);
    if (fs.existsSync(targetPath)) throw targetAlreadyExists(targetPath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.renameSync(sourcePath, targetPath);
    return this.moveResult(sourcePath, targetPath);
  }

  async trash(ref: ResourceRef | unknown, options: ResourceTrashOptions = {}): Promise<ResourceTrashResult> {
    if (!this.trashRoot) {
      throw new ResourceIOError("ResourceIO trash root is unavailable", {
        code: "provider_not_available",
        status: 501,
      });
    }
    const filePath = this.resolvePath(ref);
    this.assertAllowed(filePath, "delete");
    if (!fs.existsSync(filePath)) throw resourceNotFound(filePath);
    const trashId = `trash_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const namespace = normalizeTrashNamespace(options.namespace || "resource-io");
    const trashPath = path.join(this.trashRoot, namespace, trashId);
    fs.mkdirSync(trashPath, { recursive: true });
    const payloadPath = path.join(trashPath, "payload");
    fs.renameSync(filePath, payloadPath);
    fs.writeFileSync(path.join(trashPath, "metadata.json"), JSON.stringify({
      schemaVersion: 1,
      trashId,
      originalPath: filePath,
      originalName: path.basename(filePath),
      deletedAt: new Date().toISOString(),
      ...(options.metadata && typeof options.metadata === "object" ? options.metadata : {}),
    }, null, 2) + "\n", "utf-8");
    return {
      resourceKey: localResourceKey(filePath),
      resource: this.resourceForPath(filePath),
      trashId,
      trashPath,
      payloadPath,
      filePath,
    };
  }

  async materialize(ref: ResourceRef | unknown): Promise<MaterializeResult> {
    const filePath = this.resolvePath(ref);
    this.assertAllowed(filePath, "read");
    const stat = fs.statSync(filePath);
    return {
      resourceKey: localResourceKey(filePath),
      resource: this.resourceForPath(filePath),
      filePath,
      version: versionFromStat(stat),
    };
  }

  watchTarget(ref: ResourceRef | unknown) {
    const filePath = this.resolvePath(ref);
    this.assertAllowed(filePath, "read");
    const isDirectory = safeIsDirectory(filePath);
    return {
      ref: { kind: "local-file" as const, path: filePath },
      filePath,
      isDirectory,
      resourceKey: localResourceKey(filePath),
      resource: this.resourceForPath(filePath),
      toResource: (changedPath: string) => {
        const eventPath = normalizeWatchEventPath(filePath, changedPath, isDirectory);
        return {
          resourceKey: localResourceKey(eventPath),
          resource: this.resourceForPath(eventPath),
          filePath: eventPath,
        };
      },
    };
  }

  async list(ref: ResourceRef | unknown): Promise<ResourceListResult> {
    const dirPath = this.resolvePath(ref);
    this.assertAllowed(dirPath, "read");
    const items = fs.readdirSync(dirPath, { withFileTypes: true })
      .map((entry) => {
        const fullPath = path.join(dirPath, entry.name);
        const stat = fs.statSync(fullPath);
        return {
          name: entry.name,
          isDirectory: entry.isDirectory(),
          size: entry.isDirectory() ? null : stat.size,
          mtimeMs: stat.mtimeMs,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      resourceKey: localResourceKey(dirPath),
      resource: this.resourceForPath(dirPath),
      items,
    };
  }

  async search(ref: ResourceRef | unknown, { query, mode, limit }: { query?: string; mode?: string; limit?: number } = {}): Promise<ResourceSearchResult> {
    const rootPath = this.resolvePath(ref);
    this.assertAllowed(rootPath, "read");
    const needle = String(query || "");
    const matches = needle
      ? mode === "name"
        ? searchNames(rootPath, needle, this.guard, limit)
        : searchText(rootPath, needle, this.guard)
      : [];
    return {
      resourceKey: localResourceKey(rootPath),
      resource: this.resourceForPath(rootPath),
      matches,
    };
  }

  resolvePath(ref: ResourceRef | unknown): string {
    const normalized = normalizeResourceRef(ref);
    if (normalized.kind !== "local-file") {
      throw new Error(`local_fs provider cannot resolve ${normalized.kind}`);
    }
    const rawPath = path.isAbsolute(normalized.path)
      ? path.normalize(normalized.path)
      : path.resolve(this.cwd, normalized.path);
    return realOrResolved(rawPath);
  }

  resourceForPath(filePath: string): ResourceDescriptor {
    return {
      kind: "local-file",
      path: filePath,
      filePath,
      provider: "local_fs",
    };
  }

  mutationResult(filePath: string, changeType: "created" | "modified"): ResourceMutationResult {
    const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
    return {
      changeType,
      resourceKey: localResourceKey(filePath),
      resource: this.resourceForPath(filePath),
      ...(stat ? { version: versionFromStat(stat) } : {}),
      filePath,
    };
  }

  moveResult(sourcePath: string, targetPath: string): ResourceMoveResult {
    return {
      oldResourceKey: localResourceKey(sourcePath),
      newResourceKey: localResourceKey(targetPath),
      oldResource: this.resourceForPath(sourcePath),
      newResource: this.resourceForPath(targetPath),
      oldFilePath: sourcePath,
      newFilePath: targetPath,
    };
  }

  assertAllowed(filePath: string, operation: "read" | "write" | "delete"): void {
    if (!this.guard) return;
    const result = this.guard.check(filePath, operation);
    if (result.allowed !== true) {
      throw resourceAccessDenied(operation, filePath, result.code || result.reason, {
        safeMessage: result.safeMessage,
      });
    }
  }
}

function localResourceKey(filePath: string): string {
  return resourceKeyForRef({ kind: "local-file", path: filePath });
}

function versionFromStat(stat: fs.Stats): ResourceVersion {
  return {
    mtimeMs: stat.mtime.getTime(),
    size: stat.isDirectory() ? null : stat.size,
  };
}

function statFileVersionOrNull(filePath: string): ResourceVersion | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    return versionFromStat(stat);
  } catch {
    return null;
  }
}

function fileVersionsMatch(current: ResourceVersion, expected: ResourceVersion): boolean {
  if (expected.mtimeMs != null && current.mtimeMs !== expected.mtimeMs) return false;
  if (expected.size != null && current.size !== expected.size) return false;
  if (expected.sha256 && current.sha256 !== expected.sha256) return false;
  if (expected.etag && current.etag !== expected.etag) return false;
  if (expected.sequence != null && current.sequence !== expected.sequence) return false;
  return true;
}

function normalizeTrashNamespace(value: string): string {
  const raw = String(value || "").trim();
  if (!raw || raw.includes("/") || raw.includes("\\") || raw === "." || raw === "..") {
    throw new ResourceIOError("invalid trash namespace", {
      code: "invalid_trash_namespace",
      status: 400,
    });
  }
  return raw;
}

function normalizeWatchEventPath(rootPath: string, changedPath: string, rootIsDirectory: boolean): string {
  if (!changedPath) return rootPath;
  const value = String(changedPath);
  if (path.isAbsolute(value)) return path.normalize(value);
  return rootIsDirectory ? path.join(rootPath, value) : rootPath;
}

function safeIsDirectory(targetPath: string): boolean {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function realOrResolved(filePath: string): string {
  try {
    return path.normalize(fs.realpathSync(filePath));
  } catch {
    const parts: string[] = [];
    let current = path.resolve(filePath);
    while (true) {
      try {
        const real = fs.realpathSync(current);
        return path.join(path.normalize(real), ...parts.reverse());
      } catch {
        const parent = path.dirname(current);
        if (parent === current) return path.resolve(filePath);
        parts.push(path.basename(current));
        current = parent;
      }
    }
  }
}

function searchText(rootPath: string, query: string, guard: Guard | null) {
  const matches: { filePath: string; line: number; text: string }[] = [];
  const visit = (current: string) => {
    const stat = fs.statSync(current);
    if (stat.isDirectory()) {
      if (SEARCH_SKIP_DIRS.has(path.basename(current))) return;
      for (const entry of fs.readdirSync(current)) visit(path.join(current, entry));
      return;
    }
    if (!stat.isFile()) return;
    if (guard) {
      const allowed = guard.check(current, "read");
      if (!allowed.allowed) return;
    }
    const text = fs.readFileSync(current, "utf-8");
    text.split(/\r?\n/).forEach((line, index) => {
      if (line.includes(query)) matches.push({ filePath: current, line: index + 1, text: line });
    });
  };
  visit(rootPath);
  return matches.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line);
}

function searchNames(rootPath: string, query: string, guard: Guard | null, limit = 80) {
  const needle = query.toLowerCase();
  const max = Number.isFinite(limit) && Number(limit) > 0 ? Number(limit) : 80;
  const matches: {
    filePath: string;
    line: number;
    text: string;
    name: string;
    relativePath: string;
    parentSubdir: string;
    isDirectory: boolean;
    size: number | null;
    mtimeMs: number;
  }[] = [];
  const visit = (current: string) => {
    if (matches.length >= max) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (matches.length >= max) break;
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory() && SEARCH_SKIP_DIRS.has(entry.name)) continue;
      const fullPath = path.join(current, entry.name);
      if (guard) {
        const allowed = guard.check(fullPath, "read");
        if (!allowed.allowed) continue;
      }
      if (entry.name.toLowerCase().includes(needle)) {
        try {
          const stat = fs.statSync(fullPath);
          matches.push({
            filePath: fullPath,
            line: 0,
            text: entry.name,
            name: entry.name,
            relativePath: toSlashRelative(rootPath, fullPath),
            parentSubdir: toSlashRelative(rootPath, path.dirname(fullPath)),
            isDirectory: entry.isDirectory(),
            size: entry.isDirectory() ? null : stat.size,
            mtimeMs: stat.mtimeMs,
          });
        } catch {}
      }
      if (entry.isDirectory()) visit(fullPath);
    }
  };
  visit(rootPath);
  return matches.slice(0, max);
}

function toSlashRelative(rootPath: string, filePath: string): string {
  return path.relative(rootPath, filePath).split(path.sep).filter(Boolean).join("/");
}
