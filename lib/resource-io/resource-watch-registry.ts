import fs from "fs";
import path from "path";
import crypto from "crypto";
import { ResourceEventBus } from "./resource-event-bus.ts";
import { normalizeResourceRef, resourceKeyForRef } from "./resource-refs.ts";
import type { ResourceRef } from "./types.ts";

type WatchHandle = { close: () => void };
type WatchChange =
  | { kind: "exact"; path: string }
  | { kind: "rescan"; path?: string | null; reason?: string };
type WatchChangeInput = string | null | undefined | WatchChange;
type WatchPath = (targetPath: string, handler: (changedPath?: WatchChangeInput) => void) => WatchHandle;
type WatchResourceSnapshot = {
  resourceKey: string;
  resource: any;
  filePath?: string;
};
type WatchTarget = WatchResourceSnapshot & {
  ref?: ResourceRef;
  filePath: string;
  isDirectory?: boolean;
  toResource?: (changedPath: string) => WatchResourceSnapshot;
};
type ResolveWatchTarget = (resource: unknown) => WatchTarget;
type StatPath = (targetPath: string) => {
  exists: boolean;
  isDirectory: boolean;
  mtimeMs?: number;
  size?: number | null;
};

type Options = {
  emitEvent?: (event: object, sessionPath?: string | null) => void;
  eventBus?: ResourceEventBus;
  debounceMs?: number;
  resolveWatchTarget?: ResolveWatchTarget;
  watchPath?: WatchPath;
  statPath?: StatPath;
};

type Entry = {
  ref: ResourceRef;
  filePath: string;
  resourceKey: string;
  resource: any;
  toResource?: (changedPath: string) => WatchResourceSnapshot;
  isDirectory: boolean;
  refCount: number;
  handle: WatchHandle;
  timer: ReturnType<typeof setTimeout> | null;
  pendingPath: string | null;
  pendingRescan: boolean;
};

type Subscription = {
  subscriptionId: string;
  purpose: string | null;
  sessionPath: string | null;
  resourceKeys: string[];
  releases: Array<() => void>;
};

export class ResourceWatchRegistry {
  declare entries: Map<string, Entry>;
  declare subscriptions: Map<string, Subscription>;
  declare debounceMs: number;
  declare resolveWatchTarget: ResolveWatchTarget;
  declare watchPath: WatchPath;
  declare statPath: StatPath;
  declare eventBus: ResourceEventBus;
  declare droppedEventCount: number;
  declare lastErrorCode: string | null;
  declare lastErrorMessage: string | null;

  constructor({
    emitEvent,
    eventBus,
    debounceMs = 80,
    resolveWatchTarget = defaultResolveWatchTarget,
    watchPath = defaultWatchPath,
    statPath = defaultStatPath,
  }: Options) {
    this.entries = new Map();
    this.subscriptions = new Map();
    this.debounceMs = debounceMs;
    this.resolveWatchTarget = resolveWatchTarget;
    this.watchPath = watchPath;
    this.statPath = statPath;
    this.eventBus = eventBus || new ResourceEventBus({ emit: emitEvent });
    this.droppedEventCount = 0;
    this.lastErrorCode = null;
    this.lastErrorMessage = null;
  }

  subscribe(input: { resources?: unknown[]; resource?: unknown; purpose?: string | null; sessionPath?: string | null }) {
    const resources = Array.isArray(input?.resources)
      ? input.resources
      : input?.resource
        ? [input.resource]
        : [];
    if (!resources.length) throw new Error("ResourceWatchRegistry subscription requires resources");

    const releases: Array<() => void> = [];
    const resourceKeys: string[] = [];
    try {
      for (const resource of resources) {
        const normalized = this.normalizeWatchResource(resource);
        releases.push(this.retain(normalized.ref));
        resourceKeys.push(normalized.resourceKey);
      }
    } catch (err) {
      this.recordError(err);
      for (const release of releases.splice(0).reverse()) release();
      throw err;
    }

    const subscriptionId = crypto.randomUUID();
    this.subscriptions.set(subscriptionId, {
      subscriptionId,
      purpose: typeof input?.purpose === "string" ? input.purpose : null,
      sessionPath: typeof input?.sessionPath === "string" ? input.sessionPath : null,
      resourceKeys,
      releases,
    });
    return { subscriptionId, resourceKeys };
  }

  unsubscribe(subscriptionId: string): boolean {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return false;
    this.subscriptions.delete(subscriptionId);
    for (const release of subscription.releases.reverse()) release();
    return true;
  }

  diagnostics() {
    return {
      subscriptions: this.subscriptions.size,
      droppedEventCount: this.droppedEventCount,
      lastErrorCode: this.lastErrorCode,
      lastErrorMessage: this.lastErrorMessage,
      watches: [...this.entries.values()].map((entry) => ({
        resourceKey: entry.resourceKey,
        refCount: entry.refCount,
        isDirectory: entry.isDirectory,
      })),
    };
  }

  retain(input: unknown): () => void {
    let normalized;
    try {
      normalized = this.normalizeWatchResource(input);
    } catch (err) {
      this.recordError(err);
      throw err;
    }
    const { ref, filePath, resourceKey, resource, toResource, isDirectory } = normalized;
    const existing = this.entries.get(resourceKey);
    if (existing) {
      existing.refCount += 1;
      return () => this.release(resourceKey);
    }

    const entry: Entry = {
      ref,
      filePath,
      resourceKey,
      resource,
      toResource,
      isDirectory,
      refCount: 1,
      handle: this.watchPath(filePath, (changedPath) => this.schedule(entry, changedPath)),
      timer: null,
      pendingPath: null,
      pendingRescan: false,
    };
    this.entries.set(resourceKey, entry);
    return () => this.release(resourceKey);
  }

  normalizeWatchResource(input: unknown) {
    const target = this.resolveWatchTarget(input);
    if (!target?.filePath || !target?.resourceKey || !target?.resource) {
      throw new Error("ResourceWatchRegistry resolver returned an invalid watch target");
    }
    const filePath = normalizeWatchPath(target.filePath);
    return {
      ref: (target.ref || normalizeResourceRef(input)) as ResourceRef,
      filePath,
      resourceKey: target.resourceKey,
      resource: target.resource,
      toResource: target.toResource,
      isDirectory: target.isDirectory === true,
    };
  }

  release(resourceKey: string): void {
    const entry = this.entries.get(resourceKey);
    if (!entry) return;
    if (entry.refCount > 1) {
      entry.refCount -= 1;
      return;
    }
    this.entries.delete(resourceKey);
    if (entry.timer) clearTimeout(entry.timer);
    entry.handle.close();
  }

  schedule(entry: Entry, changedPath?: WatchChangeInput): void {
    if (!this.entries.has(entry.resourceKey)) {
      this.droppedEventCount += 1;
      return;
    }
    const change = normalizeWatchChange(entry.filePath, changedPath, entry.isDirectory);
    if (change.kind === "rescan") {
      entry.pendingRescan = true;
      entry.pendingPath = null;
    } else if (!entry.pendingRescan) {
      entry.pendingPath = change.path;
    }
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      this.emitSnapshot(entry);
    }, this.debounceMs);
  }

  emitSnapshot(entry: Entry): void {
    if (!this.entries.has(entry.resourceKey)) {
      this.droppedEventCount += 1;
      return;
    }
    const eventPath = entry.pendingRescan
      ? entry.filePath
      : normalizeChangedPath(entry.filePath, entry.pendingPath, entry.isDirectory);
    entry.pendingPath = null;
    entry.pendingRescan = false;
    let stat;
    let snapshot;
    try {
      stat = this.statPath(eventPath);
      snapshot = entry.toResource?.(eventPath) || localWatchSnapshot(eventPath);
    } catch (err) {
      this.recordError(err);
      return;
    }
    const { resourceKey } = snapshot;
    const resource = {
      ...snapshot.resource,
      isDirectory: stat.isDirectory,
    };
    if (!stat.exists) {
      this.eventBus.deleted({
        resourceKey,
        resource,
        source: "provider_watch",
        sessionPath: null,
      });
      return;
    }
    this.eventBus.changed({
      changeType: "modified",
      resourceKey,
      resource,
      version: {
        mtimeMs: stat.mtimeMs,
        size: stat.isDirectory ? null : stat.size ?? null,
      },
      source: "provider_watch",
      sessionPath: null,
    });
  }

  recordError(err: unknown): void {
    this.lastErrorCode = typeof (err as any)?.code === "string" && (err as any).code
      ? (err as any).code
      : "resource_watch_failed";
    this.lastErrorMessage = typeof (err as any)?.safeMessage === "string" && (err as any).safeMessage
      ? (err as any).safeMessage
      : "Resource watch failed";
  }
}

function defaultResolveWatchTarget(input: unknown): WatchTarget {
  const ref = normalizeResourceRef(input);
  if (ref.kind !== "local-file") {
    throw new Error(`ResourceWatchRegistry cannot resolve provider watch target for ${ref.kind}`);
  }
  const filePath = normalizeWatchPath(ref.path);
  const snapshot = localWatchSnapshot(filePath);
  return {
    ref: { kind: "local-file", path: filePath },
    filePath,
    isDirectory: safeIsDirectory(filePath),
    ...snapshot,
    toResource: localWatchSnapshot,
  };
}

function normalizeWatchChange(rootPath: string, changedPath: WatchChangeInput, rootIsDirectory = false): WatchChange {
  if (!changedPath) {
    return rootIsDirectory
      ? { kind: "rescan", path: rootPath, reason: "filename_unavailable" }
      : { kind: "exact", path: rootPath };
  }
  if (typeof changedPath === "object" && "kind" in changedPath) {
    if (changedPath.kind === "rescan") {
      return { kind: "rescan", path: changedPath.path || rootPath, reason: changedPath.reason };
    }
    return { kind: "exact", path: changedPath.path };
  }
  const value = String(changedPath);
  if (!value) {
    return rootIsDirectory
      ? { kind: "rescan", path: rootPath, reason: "filename_unavailable" }
      : { kind: "exact", path: rootPath };
  }
  const candidate = path.isAbsolute(value)
    ? normalizeWatchPath(value)
    : rootIsDirectory
      ? path.join(rootPath, value)
      : rootPath;
  if (rootIsDirectory && isDirectorySelfEcho(rootPath, candidate)) {
    return { kind: "rescan", path: rootPath, reason: "directory_self_echo" };
  }
  return { kind: "exact", path: candidate };
}

function normalizeChangedPath(rootPath: string, changedPath?: string | null, rootIsDirectory = false): string {
  if (!changedPath) return rootPath;
  const value = String(changedPath);
  if (path.isAbsolute(value)) return normalizeWatchPath(value);
  return rootIsDirectory ? path.join(rootPath, value) : rootPath;
}

function localWatchSnapshot(filePath: string): WatchResourceSnapshot {
  const normalizedPath = normalizeWatchPath(filePath);
  return {
    resourceKey: resourceKeyForRef({ kind: "local-file", path: normalizedPath }),
    resource: {
      kind: "local-file" as const,
      provider: "local_fs",
      path: normalizedPath,
      filePath: normalizedPath,
    },
    filePath: normalizedPath,
  };
}

function defaultWatchPath(targetPath: string, handler: (changedPath?: WatchChangeInput) => void): WatchHandle {
  const rootPath = path.normalize(targetPath);
  const rootIsDirectory = safeIsDirectory(rootPath);
  const watcher = fs.watch(rootPath, { persistent: false }, (_eventType, filename) => {
    if (rootIsDirectory) {
      if (!filename) {
        handler({ kind: "rescan", path: rootPath, reason: "filename_unavailable" });
        return;
      }
      const value = String(filename);
      const changedPath = path.isAbsolute(value) ? normalizeWatchPath(value) : path.join(rootPath, value);
      handler(isDirectorySelfEcho(rootPath, changedPath)
        ? { kind: "rescan", path: rootPath, reason: "directory_self_echo" }
        : { kind: "exact", path: changedPath });
      return;
    }
    handler(rootPath);
  });
  return { close: () => watcher.close() };
}

function normalizeWatchPath(value: string): string {
  return path.resolve(value);
}

function safeIsDirectory(targetPath: string): boolean {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function safePathExists(targetPath: string): boolean {
  try {
    fs.accessSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isDirectorySelfEcho(rootPath: string, candidatePath: string): boolean {
  const root = normalizeWatchPath(rootPath);
  const candidate = normalizeWatchPath(candidatePath);
  if (candidate === root) return true;
  return path.dirname(candidate) === root
    && path.basename(candidate) === path.basename(root)
    && !safePathExists(candidate);
}

function defaultStatPath(targetPath: string) {
  try {
    const stat = fs.statSync(targetPath);
    return {
      exists: true,
      isDirectory: stat.isDirectory(),
      mtimeMs: stat.mtimeMs,
      size: stat.isDirectory() ? null : stat.size,
    };
  } catch (err) {
    if ((err as any)?.code === "ENOENT") {
      return { exists: false, isDirectory: false, size: null };
    }
    throw err;
  }
}
