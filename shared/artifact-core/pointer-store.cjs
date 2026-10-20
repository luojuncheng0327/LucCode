"use strict";

/**
 * shared/artifact-core/pointer-store.cjs
 *
 * LUC_HOME artifact pointer/quarantine/lock storage. Every write is
 * temp-file-then-atomic-rename so a crash mid-write
 * never corrupts what's already on disk — a reader only ever sees the old
 * complete file or the new complete file, never a partial one. Leftover
 * temp files from an interrupted write carry a random suffix and are
 * never opened by name, so they can never shadow a real pointer read.
 *
 * Directory-level locking uses `fs.open` with the exclusive-create flag
 * ("wx") rather than a native flock — this keeps the whole module
 * dependency-free and Windows-compatible (flock has no faithful Windows
 * equivalent without a native addon).
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

function artifactsRoot(homeDir) {
  if (!homeDir || typeof homeDir !== "string") {
    throw new Error("pointer-store: homeDir is required");
  }
  return path.join(homeDir, "artifacts");
}

function pointersDir(homeDir) {
  return path.join(artifactsRoot(homeDir), "pointers");
}

/**
 * @param {string} homeDir
 * @param {string} channel
 * @param {"current"|"previous"|"next"} slot
 */
function pointerPath(homeDir, channel, slot) {
  return path.join(pointersDir(homeDir), `${channel}.${slot}.json`);
}

function quarantinePath(homeDir) {
  return path.join(artifactsRoot(homeDir), "quarantine.json");
}

function lockPath(homeDir) {
  return path.join(artifactsRoot(homeDir), "lock");
}

/**
 * Writes `value` as JSON to `filePath` via temp-file + fsync + atomic
 * rename. A reader of `filePath` either sees the previous complete
 * contents or the new complete contents, never a torn write.
 * @param {string} filePath
 * @param {unknown} value
 */
async function atomicWriteJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const data = JSON.stringify(value, null, 2);
  const handle = await fsp.open(tmpPath, "w");
  try {
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmpPath, filePath);
}

async function readJsonOrNull(filePath) {
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * @param {string} homeDir
 * @param {string} channel
 * @param {"current"|"previous"|"next"} slot
 * @returns {Promise<object|null>}
 */
function readPointer(homeDir, channel, slot) {
  return readJsonOrNull(pointerPath(homeDir, channel, slot));
}

/**
 * @param {string} homeDir
 * @param {string} channel
 * @param {"current"|"previous"|"next"} slot
 * @param {object} value
 */
function writePointer(homeDir, channel, slot, value) {
  return atomicWriteJson(pointerPath(homeDir, channel, slot), value);
}

async function clearPointer(homeDir, channel, slot) {
  try {
    await fsp.unlink(pointerPath(homeDir, channel, slot));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

/**
 * Promotes `next` -> `current` -> `previous` for a channel before loading.
 * No-op (returns `{ promoted: false }`) if there is no `next` pointer.
 * @param {string} homeDir
 * @param {string} channel
 * @returns {Promise<{promoted: boolean, current?: object, previous?: object|null}>}
 */
async function promote(homeDir, channel) {
  const next = await readPointer(homeDir, channel, "next");
  if (!next) return { promoted: false };
  const current = await readPointer(homeDir, channel, "current");
  if (current) {
    await writePointer(homeDir, channel, "previous", current);
  }
  await writePointer(homeDir, channel, "current", next);
  await clearPointer(homeDir, channel, "next");
  return { promoted: true, current: next, previous: current };
}

/**
 * Demotes `current` back to being the active pointer's fallback: pops
 * `previous` into `current` after three consecutive failures on a train.
 * Leaves `previous` untouched (readers that fall further
 * back than the demoted-from state will find `resolveBoot`'s
 * current->previous chain naturally exhausted).
 * @param {string} homeDir
 * @param {string} channel
 * @returns {Promise<{demoted: boolean, current?: object|null}>}
 */
async function demoteToPrevious(homeDir, channel) {
  const previous = await readPointer(homeDir, channel, "previous");
  if (!previous) return { demoted: false };
  await writePointer(homeDir, channel, "current", previous);
  return { demoted: true, current: previous };
}

// ---- quarantine ----------------------------------------------------------

async function readQuarantine(homeDir) {
  const value = await readJsonOrNull(quarantinePath(homeDir));
  return Array.isArray(value) ? value : [];
}

/**
 * @param {string} homeDir
 * @param {string} channel
 * @param {number} train
 * @returns {Promise<boolean>}
 */
async function isQuarantined(homeDir, channel, train) {
  const list = await readQuarantine(homeDir);
  return list.some((entry) => entry.channel === channel && entry.train === train);
}

/**
 * Appends a train to the quarantine list (idempotent — re-appending an
 * already-quarantined channel/train is a no-op). Quarantined trains are
 * never auto-retried.
 * @param {string} homeDir
 * @param {{channel: string, train: number, reason?: string}} entry
 */
async function appendQuarantine(homeDir, entry) {
  const list = await readQuarantine(homeDir);
  const already = list.some((e) => e.channel === entry.channel && e.train === entry.train);
  if (!already) {
    list.push({ ...entry, quarantinedAt: entry.quarantinedAt || new Date().toISOString() });
    await atomicWriteJson(quarantinePath(homeDir), list);
  }
  return list;
}

// ---- directory-level lock -------------------------------------------------

/**
 * Acquires the artifacts-directory lock via exclusive file creation.
 * Returns `null` if another holder has it and it isn't stale; lock losers
 * skip update work. Stale locks (older than
 * `staleMs`) are stolen so a crashed holder can't wedge updates forever.
 * @param {string} homeDir
 * @param {{staleMs?: number}} [opts]
 * @returns {Promise<{release: () => Promise<void>}|null>}
 */
async function acquireLock(homeDir, opts = {}) {
  const staleMs = opts.staleMs ?? 5 * 60 * 1000;
  await fsp.mkdir(artifactsRoot(homeDir), { recursive: true });
  const filePath = lockPath(homeDir);
  const payload = JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() });

  try {
    const handle = await fsp.open(filePath, "wx");
    await handle.writeFile(payload, "utf8");
    return {
      release: async () => {
        await handle.close();
        await fsp.unlink(filePath).catch((err) => {
          if (err.code !== "ENOENT") throw err;
        });
      },
    };
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    const stat = await fsp.stat(filePath).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs > staleMs) {
      await fsp.unlink(filePath).catch(() => {});
      return acquireLock(homeDir, opts);
    }
    return null;
  }
}

// ---- in-process pointer mutex ---------------------------------------------

const _mutexQueues = new Map(); // resolvedHome -> Promise（队尾）

/**
 * In-process critical section for pointer mutations, keyed by homeDir.
 * The cross-process story is handled elsewhere (Electron single-instance
 * guard + the wx-file `acquireLock`); this serializes the two in-process
 * writers — boot-time promote/demote and OTA activation — whose
 * interleaving could otherwise drop a freshly written `next` pointer.
 * @param {string} homeDir
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
async function withPointerMutex(homeDir, fn) {
  const key = path.resolve(homeDir);
  const previousTail = _mutexQueues.get(key) || Promise.resolve();

  // Wait for the previous turn to settle, ignoring its outcome — a
  // throwing `fn` must never poison the queue for later waiters.
  const previousSettled = previousTail.then(
    () => {},
    () => {},
  );

  // This waiter's own turn only starts once every earlier turn has
  // finished, preserving strict FIFO order for this key.
  const turn = previousSettled.then(fn);

  // The new queue tail is `turn` itself (rejection included) — the next
  // waiter's `previousSettled` swallows it via the two-arg `.then` above.
  _mutexQueues.set(key, turn);

  // Once this turn settles, drop the map entry if nobody queued behind
  // us in the meantime (prevents unbounded growth for idle keys).
  const forget = () => {
    if (_mutexQueues.get(key) === turn) _mutexQueues.delete(key);
  };
  turn.then(forget, forget);

  return turn;
}

module.exports = {
  artifactsRoot,
  pointersDir,
  pointerPath,
  quarantinePath,
  lockPath,
  atomicWriteJson,
  readPointer,
  writePointer,
  clearPointer,
  promote,
  demoteToPrevious,
  readQuarantine,
  isQuarantined,
  appendQuarantine,
  acquireLock,
  withPointerMutex,
};
