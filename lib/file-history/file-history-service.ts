// 文件历史编排：一条存储路径（store.recordSnapshot），三个触发源
// （engine 事件总线 tap / 递归 watcher / 基线扫描）。对 ResourceIO 零依赖，可整块摘除。
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { createHash } from "crypto";
import { FileHistoryStore, type SnapshotOrigin } from "./history-store.ts";
import { createWorkspaceWatcher, type WorkspaceWatcher } from "./workspace-watcher.ts";
import { MAX_SNAPSHOT_BYTES, isIgnoredRelPath, isTrackedFile } from "./text-file-policy.ts";

export const FILE_HISTORY_DEFAULTS = {
  mergeWindowMs: 60_000,
  maxAgeMs: 30 * 24 * 3600 * 1000,
  maxTotalBytes: 500 * 1024 * 1024,
  debounceMs: 150,
  retentionIntervalMs: 24 * 3600 * 1000,
};

export function workspaceHashForRoot(root: string): string {
  const normalized = path.resolve(root).split(path.sep).join("/");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

type WorkspaceEntry = {
  root: string;
  store: FileHistoryStore;
  watcher: WorkspaceWatcher;
  pendingTimers: Map<string, ReturnType<typeof setTimeout>>;
};

export class FileHistoryService {
  declare _historyRoot: string;
  declare _createWatcher: typeof createWorkspaceWatcher;
  declare _log: (message: string) => void;
  declare _now: () => number;
  declare _mergeWindowMs: number;
  declare _maxAgeMs: number;
  declare _maxTotalBytes: number;
  declare _debounceMs: number;
  declare _entries: Map<string, WorkspaceEntry>;
  declare _inflight: Set<Promise<unknown>>;
  declare _retentionTimer: ReturnType<typeof setInterval> | null;

  constructor({
    historyRoot,
    createWatcher = createWorkspaceWatcher,
    log = () => {},
    now = () => Date.now(),
    mergeWindowMs = FILE_HISTORY_DEFAULTS.mergeWindowMs,
    maxAgeMs = FILE_HISTORY_DEFAULTS.maxAgeMs,
    maxTotalBytes = FILE_HISTORY_DEFAULTS.maxTotalBytes,
    debounceMs = FILE_HISTORY_DEFAULTS.debounceMs,
  }: {
    historyRoot: string;
    createWatcher?: typeof createWorkspaceWatcher;
    log?: (message: string) => void;
    now?: () => number;
    mergeWindowMs?: number;
    maxAgeMs?: number;
    maxTotalBytes?: number;
    debounceMs?: number;
  }) {
    this._historyRoot = historyRoot;
    this._createWatcher = createWatcher;
    this._log = log;
    this._now = now;
    this._mergeWindowMs = mergeWindowMs;
    this._maxAgeMs = maxAgeMs;
    this._maxTotalBytes = maxTotalBytes;
    this._debounceMs = debounceMs;
    this._entries = new Map();
    this._inflight = new Set();
    this._retentionTimer = null;
  }

  async syncWorkspaces(roots: string[]): Promise<void> {
    const wanted = new Set(roots.map(root => path.resolve(root)));

    for (const [key, entry] of [...this._entries]) {
      if (wanted.has(key)) continue;
      this._entries.delete(key);
      for (const timer of entry.pendingTimers.values()) clearTimeout(timer);
      await entry.watcher.close().catch(() => {});
      entry.store.close();
    }

    for (const root of wanted) {
      if (this._entries.has(root)) continue;
      let stat: fs.Stats;
      try { stat = fs.statSync(root); } catch { continue; }
      if (!stat.isDirectory()) continue;

      const store = new FileHistoryStore({
        dbPath: path.join(this._historyRoot, workspaceHashForRoot(root), "history.sqlite"),
        mergeWindowMs: this._mergeWindowMs,
        now: this._now,
      });
      const entry: WorkspaceEntry = {
        root,
        store,
        watcher: null as unknown as WorkspaceWatcher,
        pendingTimers: new Map(),
      };
      entry.watcher = this._createWatcher({
        root,
        onChanged: (relPath) => this._captureSoon(entry, relPath, "watcher", null),
        onDeleted: (relPath) => {
          if (isIgnoredRelPath(relPath) || !isTrackedFile(relPath)) return;
          entry.store.markDeleted(relPath, this._now());
        },
        onError: (err) => {
          this._log(`file-history watcher error on ${root}: ${err.message}`);
          this._track(this._sweep(entry));
        },
      });
      this._entries.set(root, entry);
      this._track(this._sweep(entry));
      store.enforceRetention({ maxAgeMs: this._maxAgeMs, maxTotalBytes: this._maxTotalBytes, now: this._now() });
    }

    if (!this._retentionTimer && this._entries.size) {
      this._retentionTimer = setInterval(() => {
        for (const entry of this._entries.values()) {
          try {
            entry.store.enforceRetention({ maxAgeMs: this._maxAgeMs, maxTotalBytes: this._maxTotalBytes, now: this._now() });
          } catch (err) {
            this._log(`file-history retention error: ${(err as Error).message}`);
          }
          // macOS 的 fsevents 在高并发文件系统活动下会静默丢弃事件且不报 error，
          // "watcher 出错时重扫"兜不住这种丢失，靠周期性基线扫描把漏网变更补进历史
          this._track(this._sweep(entry));
        }
      }, FILE_HISTORY_DEFAULTS.retentionIntervalMs);
      this._retentionTimer.unref?.();
    }
  }

  handleResourceEvent(event: any): void {
    try {
      if (!event || typeof event !== "object") return;
      if (event.type === "resource.changed") {
        const located = this._locate(event.resource);
        if (located) this._captureSoon(located.entry, located.relPath, "event", String(event.source || "unknown"));
        return;
      }
      if (event.type === "resource.deleted") {
        const located = this._locate(event.resource);
        if (located && isTrackedFile(located.relPath)) located.entry.store.markDeleted(located.relPath, this._now());
        return;
      }
      if (event.type === "resource.renamed") {
        const from = this._locate(event.oldResource);
        const to = this._locate(event.newResource);
        if (from && to && from.entry === to.entry) {
          from.entry.store.renamePath(from.relPath, to.relPath);
        } else if (from && isTrackedFile(from.relPath)) {
          from.entry.store.markDeleted(from.relPath, this._now());
        }
      }
    } catch (err) {
      this._log(`file-history event error: ${(err as Error).message}`);
    }
  }

  listFiles(root: string) { return this._require(root).store.listFiles(); }
  listVersions(root: string, relPath: string) { return this._require(root).store.listVersions(relPath); }
  getSnapshotContent(root: string, snapshotId: number) { return this._require(root).store.getSnapshotContent(snapshotId); }

  async captureNow(root: string, relPath: string, origin: SnapshotOrigin, opContext: string | null = null): Promise<void> {
    await this._capture(this._require(root), relPath, origin, opContext);
  }

  hasWorkspace(root: string): boolean {
    return this._entries.has(path.resolve(root));
  }

  /** 等待所有在途 capture / sweep 完成（测试与优雅关闭用） */
  async waitForIdle(): Promise<void> {
    await new Promise(r => setTimeout(r, this._debounceMs + 10));
    while (this._inflight.size) {
      await Promise.allSettled([...this._inflight]);
    }
  }

  async close(): Promise<void> {
    if (this._retentionTimer) { clearInterval(this._retentionTimer); this._retentionTimer = null; }
    await this.waitForIdle();
    await this.syncWorkspaces([]);
  }

  _require(root: string): WorkspaceEntry {
    const entry = this._entries.get(path.resolve(root));
    if (!entry) throw new Error(`file-history: workspace not tracked: ${root}`);
    return entry;
  }

  _locate(resource: any): { entry: WorkspaceEntry; relPath: string } | null {
    const absPath = typeof resource?.filePath === "string" ? resource.filePath
      : typeof resource?.path === "string" ? resource.path : null;
    if (!absPath || !path.isAbsolute(absPath)) return null;
    const resolved = path.resolve(absPath);
    let best: WorkspaceEntry | null = null;
    for (const entry of this._entries.values()) {
      if (resolved === entry.root || resolved.startsWith(entry.root + path.sep)) {
        if (!best || entry.root.length > best.root.length) best = entry;
      }
    }
    if (!best) return null;
    const relPath = path.relative(best.root, resolved).split(path.sep).join("/");
    if (!relPath || relPath.startsWith("..")) return null;
    if (isIgnoredRelPath(relPath)) return null;
    return { entry: best, relPath };
  }

  _captureSoon(entry: WorkspaceEntry, relPath: string, origin: SnapshotOrigin, opContext: string | null): void {
    if (isIgnoredRelPath(relPath) || !isTrackedFile(relPath)) return;
    const existing = entry.pendingTimers.get(relPath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      entry.pendingTimers.delete(relPath);
      this._track(this._capture(entry, relPath, origin, opContext));
    }, this._debounceMs);
    timer.unref?.();
    entry.pendingTimers.set(relPath, timer);
  }

  async _capture(entry: WorkspaceEntry, relPath: string, origin: SnapshotOrigin, opContext: string | null): Promise<void> {
    try {
      const absPath = path.join(entry.root, ...relPath.split("/"));
      const stat = await fsp.stat(absPath).catch(() => null);
      if (!stat || !stat.isFile()) return;
      if (stat.size > MAX_SNAPSHOT_BYTES) {
        this._log(`file-history skip oversized file: ${relPath} (${stat.size} bytes)`);
        return;
      }
      const content = await fsp.readFile(absPath);
      entry.store.recordSnapshot({ relPath, content, origin, opContext, capturedAt: this._now() });
    } catch (err) {
      this._log(`file-history capture error for ${relPath}: ${(err as Error).message}`);
    }
  }

  async _sweep(entry: WorkspaceEntry): Promise<void> {
    const walk = async (dirAbs: string, dirRel: string): Promise<void> => {
      let dirents;
      try { dirents = await fsp.readdir(dirAbs, { withFileTypes: true }); } catch { return; }
      for (const dirent of dirents) {
        const rel = dirRel ? `${dirRel}/${dirent.name}` : dirent.name;
        if (dirent.isDirectory()) {
          if (isIgnoredRelPath(rel + "/")) continue;
          await walk(path.join(dirAbs, dirent.name), rel);
          continue;
        }
        if (!dirent.isFile() || !isTrackedFile(rel) || isIgnoredRelPath(rel)) continue;
        try {
          const absPath = path.join(dirAbs, dirent.name);
          const stat = await fsp.stat(absPath);
          if (stat.size > MAX_SNAPSHOT_BYTES) continue;
          const content = await fsp.readFile(absPath);
          const hash = createHash("sha256").update(content).digest("hex");
          if (entry.store.latestHash(rel) === hash) continue;
          entry.store.recordSnapshot({ relPath: rel, content, origin: "sweep", opContext: null, capturedAt: this._now() });
        } catch (err) {
          this._log(`file-history sweep error for ${rel}: ${(err as Error).message}`);
        }
      }
    };
    await walk(entry.root, "");
  }

  _track<T>(promise: Promise<T>): void {
    this._inflight.add(promise);
    promise.finally(() => this._inflight.delete(promise));
  }
}
