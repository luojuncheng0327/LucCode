import fs from "fs";
import path from "path";
import { loadStudioMountRegistry } from "../../../core/studio-mounts.ts";
import { capabilityDenied, providerNotAvailable, ResourceIOError } from "../errors.ts";
import { resourceKeyForRef } from "../resource-refs.ts";
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

type LocalFsProviderFactory = (options: { cwd: string; guard: { check: (filePath: string, operation: "read" | "write" | "delete") => { allowed: boolean; reason?: string } } }) => any;

type Options = {
  lucHome: string;
  studioId: string;
  localFsProviderFactory: LocalFsProviderFactory;
};

export class MountProvider {
  readonly id = "mount" as const;

  declare luccodeHome: string;
  declare studioId: string;
  declare localFsProviderFactory: LocalFsProviderFactory;

  constructor({ lucHome, studioId, localFsProviderFactory }: Options) {
    if (!lucHome) throw new Error("lucHome is required");
    if (!studioId) throw new Error("studioId is required");
    this.luccodeHome = lucHome;
    this.studioId = studioId;
    this.localFsProviderFactory = localFsProviderFactory;
  }

  capabilities(ref: ResourceRef) {
    const mount = this.mountForRef(ref);
    const has = (capability: string) => mount.capabilities?.includes(capability);
    const local = mount.sourceKind === "storage" && mount.provider === "local_fs";
    return {
      stat: local && has("read"),
      read: local && has("read"),
      write: local && has("write"),
      writeExpectedVersion: local && has("write"),
      edit: local && has("write"),
      list: local && has("list"),
      search: local && has("list"),
      watch: local && has("watch"),
      materialize: local && has("materialize"),
      copy: local && has("read") && has("write"),
      rename: local && has("write"),
      move: local && has("write"),
      trash: local && has("write"),
      delete: local && has("write"),
      mkdir: local && has("write"),
    };
  }

  async stat(ref: ResourceRef): Promise<ResourceStat> {
    const resolved = this.resolveLocalMount(ref, "read");
    return this.mapResult(ref, await resolved.provider.stat({ kind: "local-file", path: resolved.path }));
  }

  async read(ref: ResourceRef): Promise<ResourceReadResult> {
    const resolved = this.resolveLocalMount(ref, "read");
    return this.mapResult(ref, await resolved.provider.read({ kind: "local-file", path: resolved.path }));
  }

  async write(ref: ResourceRef, content: string | Buffer): Promise<ResourceMutationResult> {
    const resolved = this.resolveLocalMount(ref, "write");
    return this.mapResult(ref, await resolved.provider.write({ kind: "local-file", path: resolved.path }, content));
  }

  async writeExpectedVersion(ref: ResourceRef, content: string | Buffer, expectedVersion: ResourceVersion): Promise<ResourceWriteExpectedVersionResult> {
    const resolved = this.resolveLocalMount(ref, "write");
    return this.mapResult(ref, await resolved.provider.writeExpectedVersion(
      { kind: "local-file", path: resolved.path },
      content,
      expectedVersion,
    ));
  }

  async edit(ref: ResourceRef, edits: ResourceEdit[]): Promise<ResourceMutationResult> {
    const resolved = this.resolveLocalMount(ref, "write");
    return this.mapResult(ref, await resolved.provider.edit({ kind: "local-file", path: resolved.path }, edits));
  }

  async mkdir(ref: ResourceRef): Promise<ResourceMutationResult> {
    const resolved = this.resolveLocalMount(ref, "write");
    return this.mapResult(ref, await resolved.provider.mkdir({ kind: "local-file", path: resolved.path }));
  }

  async delete(ref: ResourceRef): Promise<ResourceMutationResult> {
    const resolved = this.resolveLocalMount(ref, "write");
    return this.mapResult(ref, await resolved.provider.delete({ kind: "local-file", path: resolved.path }));
  }

  async list(ref: ResourceRef): Promise<ResourceListResult> {
    const resolved = this.resolveLocalMount(ref, "list");
    return this.mapResult(ref, await resolved.provider.list({ kind: "local-file", path: resolved.path }));
  }

  async search(ref: ResourceRef, options: Record<string, unknown> = {}): Promise<ResourceSearchResult> {
    const resolved = this.resolveLocalMount(ref, "list");
    return this.mapResult(ref, await resolved.provider.search({ kind: "local-file", path: resolved.path }, options));
  }

  async materialize(ref: ResourceRef): Promise<MaterializeResult> {
    const resolved = this.resolveLocalMount(ref, "materialize");
    return this.mapResult(ref, await resolved.provider.materialize({ kind: "local-file", path: resolved.path }));
  }

  watchTarget(ref: ResourceRef) {
    if (ref.kind !== "mount") {
      throw new ResourceIOError(`mount provider cannot resolve ${ref.kind}`, {
        code: "invalid_resource_ref",
        status: 400,
      });
    }
    const resolved = this.resolveLocalMount(ref, "read");
    if (!resolved.mount.capabilities?.includes("watch")) throw capabilityDenied("watch", "mount");
    const normalizedRef = { kind: "mount" as const, mountId: ref.mountId, path: resolved.mountPath };
    const isDirectory = safeIsDirectory(resolved.path);
    return {
      ref: normalizedRef,
      filePath: resolved.path,
      isDirectory,
      resourceKey: resourceKeyForRef(normalizedRef),
      resource: mountResourceForPath(ref.mountId, resolved.mountPath, resolved.path),
      toResource: (changedPath: string) => {
        const eventPath = normalizeWatchEventPath(resolved.path, changedPath, isDirectory);
        const mountPath = mountPathForNativePath(resolved.mountPath, resolved.path, eventPath);
        const eventRef = { kind: "mount" as const, mountId: ref.mountId, path: mountPath };
        return {
          resourceKey: resourceKeyForRef(eventRef),
          resource: mountResourceForPath(ref.mountId, mountPath, eventPath),
          filePath: eventPath,
        };
      },
    };
  }

  async copy(from: ResourceRef, to: ResourceRef): Promise<ResourceMutationResult> {
    const source = this.resolveLocalMount(from, "read");
    const target = this.resolveLocalMount(to, "write");
    return this.mapResult(to, await target.provider.copy(
      { kind: "local-file", path: source.path },
      { kind: "local-file", path: target.path },
    ));
  }

  async rename(from: ResourceRef, to: ResourceRef): Promise<ResourceMoveResult> {
    assertSameMount(from, to);
    const source = this.resolveLocalMount(from, "write");
    const target = this.resolveLocalMount(to, "write");
    return this.mapMoveResult(from, to, await target.provider.rename(
      { kind: "local-file", path: source.path },
      { kind: "local-file", path: target.path },
    ));
  }

  async move(from: ResourceRef, to: ResourceRef): Promise<ResourceMoveResult> {
    assertSameMount(from, to);
    const source = this.resolveLocalMount(from, "write");
    const target = this.resolveLocalMount(to, "write");
    return this.mapMoveResult(from, to, await target.provider.move(
      { kind: "local-file", path: source.path },
      { kind: "local-file", path: target.path },
    ));
  }

  async trash(ref: ResourceRef, options: ResourceTrashOptions = {}): Promise<ResourceTrashResult> {
    const resolved = this.resolveLocalMount(ref, "write");
    return this.mapTrashResult(ref, await resolved.provider.trash(
      { kind: "local-file", path: resolved.path },
      options,
    ));
  }

  mountForRef(ref: ResourceRef) {
    if (ref.kind !== "mount") {
      throw new ResourceIOError(`mount provider cannot resolve ${ref.kind}`, {
        code: "invalid_resource_ref",
        status: 400,
      });
    }
    let registry;
    try {
      registry = loadStudioMountRegistry(this.luccodeHome);
    } catch (err) {
      throw new ResourceIOError((err as any)?.message || "mount registry unavailable", {
        code: "provider_not_available",
        status: 503,
      });
    }
    const mount = registry.mounts.find((item: any) =>
      item.mountId === ref.mountId
      && item.hostStudioId === this.studioId
      && item.status === "active"
    );
    if (!mount) {
      throw new ResourceIOError(`mount not found: ${ref.mountId}`, {
        code: "resource_not_found",
        status: 404,
      });
    }
    return mount;
  }

  resolveLocalMount(ref: ResourceRef, capability: "read" | "write" | "list" | "materialize") {
    if (ref.kind !== "mount") {
      throw new ResourceIOError(`mount provider cannot resolve ${ref.kind}`, {
        code: "invalid_resource_ref",
        status: 400,
      });
    }
    const mount = this.mountForRef(ref);
    if (!(mount.sourceKind === "storage" && mount.provider === "local_fs")) {
      throw providerNotAvailable(`mount.${mount.provider || mount.sourceKind || ref.mountId}`);
    }
    const required = capability === "materialize" ? "materialize" : capability;
    if (!mount.capabilities?.includes(required)) throw capabilityDenied(required, "mount");
    const rootPath = mount.rootLocator?.path;
    if (typeof rootPath !== "string" || !path.isAbsolute(rootPath)) {
      throw new ResourceIOError(`invalid mount root: ${ref.mountId}`, {
        code: "invalid_mount_root",
        status: 500,
      });
    }
    const mountPath = normalizeMountPath(ref.path);
    const targetPath = mountPath ? path.join(rootPath, ...mountPath.split("/")) : rootPath;
    const rootReal = realOrResolved(rootPath);
    const targetReal = realOrResolved(targetPath);
    if (!isInside(rootReal, targetReal)) {
      throw new ResourceIOError("mount path escapes root", {
        code: "invalid_path",
        status: 400,
      });
    }
    const provider = this.localFsProviderFactory({
      cwd: rootReal,
      guard: {
        check: (filePath, operation) => {
          const candidate = realOrResolved(filePath);
          if (!isInside(rootReal, candidate)) return { allowed: false, reason: "mount path escapes root" };
          if (operation === "read" && !mount.capabilities?.includes("read")) return { allowed: false, reason: "mount read denied" };
          if ((operation === "write" || operation === "delete") && !mount.capabilities?.includes("write")) {
            return { allowed: false, reason: "mount write denied" };
          }
          return { allowed: true };
        },
      },
    });
    return { mount, rootPath: rootReal, path: targetReal, mountPath, provider };
  }

  mapResult<T extends { resourceKey: string; resource: any; filePath?: string }>(ref: ResourceRef, result: T): T {
    if (ref.kind !== "mount") return result;
    const mountPath = normalizeMountPath(ref.path);
    return {
      ...result,
      resourceKey: resourceKeyForRef({ kind: "mount", mountId: ref.mountId, path: mountPath }),
      resource: {
        kind: "mount",
        mountId: ref.mountId,
        path: mountPath,
        provider: "mount",
        ...(result.filePath || result.resource?.filePath ? { filePath: result.filePath || result.resource.filePath } : {}),
      } satisfies ResourceDescriptor,
    };
  }

  mapMoveResult(from: ResourceRef, to: ResourceRef, result: ResourceMoveResult): ResourceMoveResult {
    if (from.kind !== "mount" || to.kind !== "mount") return result;
    const oldMountPath = normalizeMountPath(from.path);
    const newMountPath = normalizeMountPath(to.path);
    const oldFilePath = result.oldFilePath || result.oldResource?.filePath;
    const newFilePath = result.newFilePath || result.newResource?.filePath;
    return {
      ...result,
      oldResourceKey: resourceKeyForRef({ kind: "mount", mountId: from.mountId, path: oldMountPath }),
      newResourceKey: resourceKeyForRef({ kind: "mount", mountId: to.mountId, path: newMountPath }),
      oldResource: mountResourceForPath(from.mountId, oldMountPath, oldFilePath || ""),
      newResource: mountResourceForPath(to.mountId, newMountPath, newFilePath || ""),
      ...(oldFilePath ? { oldFilePath } : {}),
      ...(newFilePath ? { newFilePath } : {}),
    };
  }

  mapTrashResult(ref: ResourceRef, result: ResourceTrashResult): ResourceTrashResult {
    if (ref.kind !== "mount") return result;
    const mountPath = normalizeMountPath(ref.path);
    const filePath = result.filePath || result.resource?.filePath || "";
    return {
      ...result,
      resourceKey: resourceKeyForRef({ kind: "mount", mountId: ref.mountId, path: mountPath }),
      resource: mountResourceForPath(ref.mountId, mountPath, filePath),
      ...(filePath ? { filePath } : {}),
    };
  }
}

function assertSameMount(from: ResourceRef, to: ResourceRef): void {
  if (from.kind !== "mount" || to.kind !== "mount" || from.mountId !== to.mountId) {
    throw new ResourceIOError("mount move requires the same mount provider", {
      code: "cross_provider_move_unsupported",
      status: 501,
    });
  }
}

function mountResourceForPath(mountId: string, mountPath: string, filePath: string): ResourceDescriptor {
  return {
    kind: "mount",
    mountId,
    path: mountPath,
    provider: "mount",
    filePath,
  };
}

function mountPathForNativePath(rootMountPath: string, rootNativePath: string, changedPath: string): string {
  const relative = path.relative(rootNativePath, changedPath);
  if (!relative) return rootMountPath;
  if (relative.startsWith("..") || path.isAbsolute(relative)) return rootMountPath;
  return joinMountPath(rootMountPath, relative.split(path.sep).join("/"));
}

function joinMountPath(rootMountPath: string, relativeSlashPath: string): string {
  const root = rootMountPath.replace(/^\/+|\/+$/g, "");
  const relative = relativeSlashPath.replace(/^\/+|\/+$/g, "");
  return [root, relative].filter(Boolean).join("/");
}

function normalizeMountPath(value: string): string {
  const raw = String(value || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!raw) return "";
  if (path.isAbsolute(raw) || raw.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new ResourceIOError("invalid mount path", {
      code: "invalid_path",
      status: 400,
    });
  }
  return raw;
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

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}
