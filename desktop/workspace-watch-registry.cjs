const path = require("path");

const DEFAULT_IGNORED_SEGMENTS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  "coverage",
]);

function normalizeWatchPath(filePath) {
  const normalized = path.resolve(filePath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isInsidePath(targetPath, rootPath) {
  const rel = path.relative(rootPath, targetPath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function shouldIgnoreWorkspacePath(rootPath, filePath) {
  if (!filePath || typeof filePath !== "string") return false;
  const resolvedRoot = path.resolve(rootPath);
  const resolvedPath = path.resolve(filePath);
  if (!isInsidePath(resolvedPath, resolvedRoot)) return false;
  const rel = path.relative(resolvedRoot, resolvedPath);
  if (!rel) return false;
  const segments = rel.split(path.sep).filter(Boolean);
  return segments.some(segment => segment.startsWith(".") || DEFAULT_IGNORED_SEGMENTS.has(segment));
}

function affectedDirectory(rootPath, eventType, changedPath) {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedChanged = path.resolve(changedPath);
  if (normalizeWatchPath(resolvedChanged) === normalizeWatchPath(resolvedRoot)) return resolvedRoot;
  if (eventType === "addDir" || eventType === "unlinkDir") {
    return path.dirname(resolvedChanged);
  }
  return path.dirname(resolvedChanged);
}

function safeCloseWatcher(watcher) {
  try {
    const result = watcher?.close?.();
    if (result && typeof result.catch === "function") {
      result.catch(() => {});
    }
  } catch {}
}

function createWorkspaceWatchRegistry({
  watch,
  notifySubscriber,
  debounceMs = 80,
  onError,
} = {}) {
  if (typeof watch !== "function") {
    throw new Error("createWorkspaceWatchRegistry: watch function required");
  }
  if (typeof notifySubscriber !== "function") {
    throw new Error("createWorkspaceWatchRegistry: notifySubscriber function required");
  }

  // rootKey -> { rootPath, watcher, subscribers:Set<number>, debounceTimers:Map<string, Timer> }
  const entries = new Map();
  const rootsBySubscriber = new Map(); // subscriberId -> Set<rootKey>

  function bindSubscriber(rootKey, subscriberId) {
    let roots = rootsBySubscriber.get(subscriberId);
    if (!roots) {
      roots = new Set();
      rootsBySubscriber.set(subscriberId, roots);
    }
    roots.add(rootKey);
  }

  function unbindSubscriber(rootKey, subscriberId) {
    const roots = rootsBySubscriber.get(subscriberId);
    if (!roots) return;
    roots.delete(rootKey);
    if (roots.size === 0) rootsBySubscriber.delete(subscriberId);
  }

  function closeEntry(rootKey, entry) {
    for (const timer of entry.debounceTimers.values()) clearTimeout(timer);
    entry.debounceTimers.clear();
    safeCloseWatcher(entry.watcher);
    entries.delete(rootKey);
  }

  function scheduleNotify(entry, eventType, changedPath) {
    if (!changedPath || shouldIgnoreWorkspacePath(entry.rootPath, changedPath)) return;
    const affectedDir = affectedDirectory(entry.rootPath, eventType, changedPath);
    const affectedKey = normalizeWatchPath(affectedDir);
    const previous = entry.debounceTimers.get(affectedKey);
    if (previous) clearTimeout(previous);
    const payload = {
      rootPath: entry.rootPath,
      changedPath: path.resolve(changedPath),
      affectedDir,
      eventType,
    };
    const timer = setTimeout(() => {
      entry.debounceTimers.delete(affectedKey);
      const current = entries.get(entry.rootKey);
      if (!current) return;
      for (const subscriberId of [...current.subscribers]) {
        notifySubscriber(subscriberId, payload);
      }
    }, debounceMs);
    entry.debounceTimers.set(affectedKey, timer);
  }

  function ensureEntry(rootPath) {
    const resolvedRoot = path.resolve(rootPath);
    const rootKey = normalizeWatchPath(resolvedRoot);
    let entry = entries.get(rootKey);
    if (entry) return entry;

    const watcher = watch(resolvedRoot, {
      ignoreInitial: true,
      persistent: false,
      atomic: true,
      depth: 0,
      awaitWriteFinish: false,
      ignorePermissionErrors: true,
      ignored: (filePath) => shouldIgnoreWorkspacePath(resolvedRoot, filePath),
    });
    entry = {
      rootKey,
      rootPath: resolvedRoot,
      watcher,
      subscribers: new Set(),
      debounceTimers: new Map(),
    };
    watcher.on("all", (eventType, changedPath) => {
      if (
        eventType !== "add"
        && eventType !== "change"
        && eventType !== "unlink"
        && eventType !== "addDir"
        && eventType !== "unlinkDir"
      ) {
        return;
      }
      scheduleNotify(entry, eventType, changedPath);
    });
    watcher.on("error", (err) => {
      if (typeof onError === "function") onError(err, resolvedRoot);
    });
    entries.set(rootKey, entry);
    return entry;
  }

  function watchWorkspace(rootPath, subscriberId) {
    try {
      const entry = ensureEntry(rootPath);
      entry.subscribers.add(subscriberId);
      bindSubscriber(entry.rootKey, subscriberId);
      return true;
    } catch {
      return false;
    }
  }

  function unwatchWorkspace(rootPath, subscriberId) {
    const rootKey = normalizeWatchPath(rootPath);
    const entry = entries.get(rootKey);
    if (!entry) {
      unbindSubscriber(rootKey, subscriberId);
      return true;
    }
    entry.subscribers.delete(subscriberId);
    unbindSubscriber(rootKey, subscriberId);
    if (entry.subscribers.size === 0) {
      closeEntry(rootKey, entry);
    }
    return true;
  }

  function unwatchAllForSubscriber(subscriberId) {
    const roots = rootsBySubscriber.get(subscriberId);
    if (!roots) return;
    for (const rootKey of [...roots]) {
      const entry = entries.get(rootKey);
      if (entry) unwatchWorkspace(entry.rootPath, subscriberId);
      else unbindSubscriber(rootKey, subscriberId);
    }
  }

  return {
    watchWorkspace,
    unwatchWorkspace,
    unwatchAllForSubscriber,
  };
}

module.exports = {
  createWorkspaceWatchRegistry,
  shouldIgnoreWorkspacePath,
};
