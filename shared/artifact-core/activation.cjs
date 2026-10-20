"use strict";

/**
 * shared/artifact-core/activation.cjs
 *
 * Archive activation + boot resolution + crash-sentinel primitives for
 * signed runtime artifacts.
 *
 * `activateFromArchive` is the sole path by which a downloaded (or seed)
 * archive becomes a bootable version: quarantine short-circuit -> sha256
 * verify -> [protection check] -> extract into a temp dir -> `.verified`
 * receipt -> atomic swap into the versioned directory -> `next` pointer
 * write. Boot itself never re-hashes trees; it trusts the `.verified`
 * receipt plus the pointer's own signed-manifest provenance
 * (`resolveBoot`).
 *
 * Two invariants this module exists to hold, both learned from a real
 * incident (an update train reusing the same version-directory name as
 * the build a user was actively running; on Windows the old code's
 * unconditional `rm` of that directory hit a file locked by the running
 * process and aborted mid-delete, leaving a half-installed app):
 *
 * 1. Build-new-before-removing-old. The archive is extracted into a
 *    sibling temp directory first; the live/final directory is only
 *    touched once the new content is fully staged and its `.verified`
 *    receipt written. If extraction fails, the final directory is left
 *    exactly as it was — there is never a state where the old content
 *    has been removed but the new content isn't in place yet.
 * 2. A version directory currently referenced by ANY pointer (any
 *    channel, any slot — current/previous/next) is protected. If the
 *    incoming archive's sha256 matches what that pointer already
 *    recorded, the directory is claimed as-is for the new pointer write
 *    (no filesystem writes at all — this is the "same train re-announced,
 *    or a rollback re-announcing an old version" case). If the sha256
 *    differs, activation is refused with a loud error instead of silently
 *    overwriting a directory something else still depends on. Callers
 *    that need to bypass this (first-boot seed extraction and crash
 *    self-repair, where nothing has started running yet) opt in via
 *    `opts.allowReplaceProtected`.
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const ustar = require("./ustar.cjs");
const pointerStore = require("./pointer-store.cjs");

/**
 * @param {string} filePath
 * @returns {Promise<string>} lowercase hex sha256
 */
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function selectArtifactEntry(manifest, kind, platformArch) {
  if (kind === "renderer") return manifest.artifacts && manifest.artifacts.renderer;
  if (kind === "server") {
    return manifest.artifacts && manifest.artifacts.server && manifest.artifacts.server[platformArch];
  }
  return undefined;
}

function versionDirName(kind, artifactEntry, platformArch) {
  return kind === "renderer" ? artifactEntry.version : `${artifactEntry.version}-${platformArch}`;
}

/**
 * @param {string} targetPath
 * @returns {Promise<boolean>}
 */
async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Reads every pointer file under `pointers/` — every channel, every slot
 * (current/previous/next), not just the one this activation is targeting
 * — and returns the ones whose recorded `versionDir` resolves to
 * `targetDir`. Mirrors the cross-channel pointer scan `artifact-gc.cjs`
 * uses for its own keep-set: protection can't be scoped to "this
 * activation's own channel", because the whole point is catching a
 * directory-name collision with something ELSE that's using it.
 *
 * Conservative on read failure: if any pointer file fails to parse as
 * JSON, throws instead of returning a partial result — an unreadable
 * pointer could be hiding a reference to `targetDir`, so the caller must
 * treat that as "protected, can't verify" rather than "no protection
 * found".
 * @param {string} homeDir
 * @param {string} targetDir
 * @returns {Promise<Array<{file: string, pointer: object}>>}
 */
async function findProtectingPointers(homeDir, targetDir) {
  const dir = pointerStore.pointersDir(homeDir);
  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }

  const resolvedTarget = path.resolve(targetDir);
  const matches = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const filePath = path.join(dir, name);
    let raw;
    try {
      raw = await fsp.readFile(filePath, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") continue; // removed between readdir and read
      throw err;
    }
    let pointer;
    try {
      pointer = JSON.parse(raw);
    } catch {
      throw new Error(
        `activateFromArchive: pointer file ${filePath} failed to parse as JSON; refusing to determine `
          + `whether ${targetDir} is safe to replace (treating it as protected rather than guessing)`,
      );
    }
    if (pointer && typeof pointer.versionDir === "string" && path.resolve(pointer.versionDir) === resolvedTarget) {
      matches.push({ file: filePath, pointer });
    }
  }
  return matches;
}

// On Windows, antivirus real-time scanning or the built-in search indexer
// can hold a handle open on a file inside a directory tree without granting
// FILE_SHARE_DELETE — and freshly extracted files (hundreds of them landing
// on disk at once) are exactly what those scanners/indexers reach for next.
// Renaming a directory while any file inside it is held that way fails with
// EPERM/EACCES/EBUSY. The lock is transient: it clears once the scanner
// finishes with the file, so a bounded retry with backoff turns what would
// otherwise be an immediate startup crash into an invisible wait.
const WIN32_RENAME_RETRYABLE_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const WIN32_RENAME_RETRY_DELAYS_MS = [100, 250, 500, 1000, 2000, 4000, 8000];

function defaultRenameRetrySleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * `fsp.rename`, but on win32 a transient EPERM/EACCES/EBUSY is retried with
 * bounded backoff instead of propagating immediately (see the constants
 * above for why: a directory tree just written by `ustar.extract` is the
 * prime target for antivirus/indexer file handles). On every other
 * platform, and for every other error code even on win32, this is a single
 * passthrough call — no retry, no delay, original error rethrown as-is.
 * Holds no state of its own between calls; `opts` exists only so tests can
 * inject a fake `rename`/`sleep`/`platform` — production call sites never
 * pass it.
 * @param {string} from
 * @param {string} to
 * @param {{rename?: typeof fsp.rename, sleep?: (ms: number) => Promise<void>, platform?: string}} [opts]
 * @returns {Promise<void>}
 */
async function renameWithBusyRetry(from, to, opts = {}) {
  const rename = opts.rename || fsp.rename;
  const sleep = opts.sleep || defaultRenameRetrySleep;
  const platform = opts.platform || process.platform;

  if (platform !== "win32") {
    return rename(from, to);
  }

  let attempt = 0;
  for (;;) {
    try {
      return await rename(from, to);
    } catch (err) {
      const retryable = err && WIN32_RENAME_RETRYABLE_CODES.has(err.code);
      if (!retryable || attempt >= WIN32_RENAME_RETRY_DELAYS_MS.length) {
        throw err;
      }
      await sleep(WIN32_RENAME_RETRY_DELAYS_MS[attempt]);
      attempt += 1;
    }
  }
}

/**
 * Moves the fully-staged `tmpDir` into `versionedDir`. If `versionedDir`
 * doesn't exist yet, this is a single atomic rename. If it does, the
 * existing directory is renamed aside first (atomic; if this step fails,
 * `versionedDir` is untouched) and only then is `tmpDir` renamed into the
 * now-empty slot. If that second rename fails, the aside copy is renamed
 * straight back — recovering the pre-activation state — and the original
 * error is rethrown. In the vanishingly rare case where even that
 * recovery rename fails, neither directory is deleted: the error is
 * marked so the caller preserves both `tmpDir` and the aside copy on disk
 * for manual recovery instead of guessing which one is safe to discard.
 * @param {string} tmpDir
 * @param {string} versionedDir
 * @param {boolean} finalExists
 * @returns {Promise<void>}
 */
async function swapIntoPlace(tmpDir, versionedDir, finalExists) {
  if (!finalExists) {
    await renameWithBusyRetry(tmpDir, versionedDir);
    return;
  }

  const oldDir = `${versionedDir}.old-${Date.now()}`;
  await renameWithBusyRetry(versionedDir, oldDir);
  try {
    await renameWithBusyRetry(tmpDir, versionedDir);
  } catch (swapErr) {
    try {
      await renameWithBusyRetry(oldDir, versionedDir);
    } catch (recoverErr) {
      const err = new Error(
        `activateFromArchive: failed to move new content into ${versionedDir} after moving the `
          + `previous content aside, and moving it back also failed. Nothing was deleted: the `
          + `previous content is at ${oldDir} and the newly extracted content is at ${tmpDir}. `
          + `Manual recovery required. Swap error: ${swapErr.message}; recovery error: ${recoverErr.message}`,
      );
      err.lucPreserveTmp = true;
      throw err;
    }
    throw swapErr;
  }
  // No longer referenced by any pointer we're about to write; best
  // effort only — a leftover `.old-*` dir doesn't match the GC naming
  // pattern and isn't picked up as a valid version, so at worst it's an
  // orphan a human can clean up by hand.
  await fsp.rm(oldDir, { recursive: true, force: true }).catch(() => {});
}

/**
 * Activates a downloaded/seed archive: verifies its sha256 against the
 * manifest's artifact entry, then either claims, refuses, or (re)builds
 * the versioned directory under `{homeDir}/artifacts/{kind}/...` — see
 * the module header for the "build new before removing old" and
 * "protect directories any pointer still references" invariants this
 * implements. Writes a `.verified` receipt into the final directory and
 * atomically writes the channel's `next` pointer. Does NOT touch
 * `current`/`previous` — promotion to `current` happens at boot
 * (`pointer-store.promote`), never mid-session: running sessions are not
 * hot-swapped.
 *
 * Short-circuits (throws immediately, no filesystem work) if
 * `manifest.train` is already quarantined on this channel.
 *
 * @param {string} archivePath - downloaded/seed `.tar.gz`
 * @param {object} manifest - already schema+signature-verified manifest
 * @param {{homeDir: string, channel: string, kind: "renderer"|"server", platformArch?: string, allowReplaceProtected?: boolean}} opts
 *   `allowReplaceProtected` (default false) skips the pointer-protection
 *   check entirely and always fully replaces the target directory. Only
 *   safe for first-boot seed extraction and crash self-repair, where the
 *   activation runs before anything has started using the target — never
 *   for a background/OTA activation running alongside a live process.
 * @returns {Promise<object>} the pointer value written to `next`
 */
async function activateFromArchive(archivePath, manifest, opts) {
  const { homeDir, channel, kind } = opts || {};
  if (!homeDir) throw new Error("activateFromArchive: opts.homeDir is required");
  if (!channel) throw new Error("activateFromArchive: opts.channel is required");
  if (kind !== "renderer" && kind !== "server") {
    throw new Error(`activateFromArchive: unsupported kind ${JSON.stringify(kind)}`);
  }
  if (kind === "server" && !opts.platformArch) {
    throw new Error("activateFromArchive: opts.platformArch is required for kind 'server'");
  }

  if (await pointerStore.isQuarantined(homeDir, channel, manifest.train)) {
    throw new Error(
      `activateFromArchive: train ${manifest.train} on channel ${JSON.stringify(channel)} is quarantined; refusing to activate`,
    );
  }

  const artifactEntry = selectArtifactEntry(manifest, kind, opts.platformArch);
  if (!artifactEntry) {
    throw new Error(
      `activateFromArchive: manifest has no ${kind} artifact entry${opts.platformArch ? ` for ${opts.platformArch}` : ""}`,
    );
  }

  const actualSha256 = await sha256File(archivePath);
  if (actualSha256 !== artifactEntry.sha256) {
    throw new Error(
      `activateFromArchive: sha256 mismatch for ${kind} artifact (expected ${artifactEntry.sha256}, got ${actualSha256})`,
    );
  }

  const dirName = versionDirName(kind, artifactEntry, opts.platformArch);
  const kindRoot = path.join(pointerStore.artifactsRoot(homeDir), kind);
  const versionedDir = path.join(kindRoot, dirName);
  const allowReplaceProtected = opts.allowReplaceProtected === true;

  const finalExists = await pathExists(versionedDir);

  if (finalExists && !allowReplaceProtected) {
    const protectingPointers = await findProtectingPointers(homeDir, versionedDir);
    if (protectingPointers.length > 0) {
      const mismatched = protectingPointers.filter((entry) => entry.pointer.sha256 !== actualSha256);
      if (mismatched.length > 0) {
        const detail = mismatched
          .map((entry) => `${entry.file} (recorded sha256 ${entry.pointer.sha256})`)
          .join(", ");
        throw new Error(
          `activateFromArchive: refusing to replace ${versionedDir} — it is referenced by `
            + `${mismatched.length} pointer(s) whose recorded sha256 does not match the incoming `
            + `archive (incoming sha256 ${actualSha256}): ${detail}`,
        );
      }
      // Every pointer referencing this directory already recorded the
      // exact bytes we were about to extract (the train got
      // re-announced, or a rollback re-announced an old version).
      // Claim it for the new pointer slot: no rm, no rename, no
      // re-extraction, no touching the existing `.verified` receipt.
      const activatedAt = new Date().toISOString();
      const pointerValue = {
        train: manifest.train,
        channel,
        kind,
        version: artifactEntry.version,
        platformArch: opts.platformArch || null,
        versionDir: versionedDir,
        sha256: actualSha256,
        activatedAt,
      };
      await pointerStore.writePointer(homeDir, channel, "next", pointerValue);
      return pointerValue;
    }
  }

  // Build the new content in a sibling temp directory first. The
  // live/final directory is never touched until the new tree is fully
  // extracted and its receipt is written — a failure anywhere in this
  // block leaves the final directory exactly as it was.
  const tmpDir = `${versionedDir}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    await ustar.extract(archivePath, tmpDir);

    const activatedAt = new Date().toISOString();
    const receipt = {
      sha256: actualSha256,
      train: manifest.train,
      version: artifactEntry.version,
      activatedAt,
    };
    await pointerStore.atomicWriteJson(path.join(tmpDir, ".verified"), receipt);
    await swapIntoPlace(tmpDir, versionedDir, finalExists);

    const pointerValue = {
      train: manifest.train,
      channel,
      kind,
      version: artifactEntry.version,
      platformArch: opts.platformArch || null,
      versionDir: versionedDir,
      sha256: actualSha256,
      activatedAt,
    };
    await pointerStore.writePointer(homeDir, channel, "next", pointerValue);
    return pointerValue;
  } catch (err) {
    if (!err.lucPreserveTmp) {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
    throw err;
  }
}

async function isPointerActivationValid(pointer) {
  if (!pointer || !pointer.versionDir) return false;
  let receipt;
  try {
    receipt = JSON.parse(await fsp.readFile(path.join(pointer.versionDir, ".verified"), "utf8"));
  } catch {
    return false;
  }
  if (receipt.sha256 !== pointer.sha256) return false;
  try {
    const stat = await fsp.stat(pointer.versionDir);
    if (!stat.isDirectory()) return false;
  } catch {
    return false;
  }
  return true;
}

/**
 * Boot-time resolution: `current` -> `previous` -> `null`. A slot
 * is valid only if its `.verified` receipt exists and its recorded
 * sha256 matches the pointer's own sha256, and the versioned directory
 * still exists. Returns `null` when no slot is bootable, at which point
 * the caller falls back to first-run seed extraction.
 * @param {string} channel
 * @param {string} homeDir
 * @returns {Promise<{slot: "current"|"previous", pointer: object}|null>}
 */
async function resolveBoot(channel, homeDir) {
  for (const slot of ["current", "previous"]) {
    const pointer = await pointerStore.readPointer(homeDir, channel, slot);
    if (!pointer) continue;
    if (await isPointerActivationValid(pointer)) {
      return { slot, pointer };
    }
  }
  return null;
}

// ---- crash sentinel --------------------------------------------------------

function sentinelPath(homeDir, channel) {
  return path.join(pointerStore.artifactsRoot(homeDir), `${channel}.sentinel.json`);
}

/**
 * Boot writes a sentinel for the train it's about to run. Consecutive
 * writes for the SAME train increment a counter; a boot for a different
 * train (or a fresh channel) resets it to 1. Pair with `clearSentinel`
 * once the boot is confirmed healthy; a healthy 60-second window clears it.
 * @param {string} homeDir
 * @param {string} channel
 * @param {number} train
 * @returns {Promise<{train: number, counter: number, writtenAt: string}>}
 */
async function writeSentinel(homeDir, channel, train) {
  const filePath = sentinelPath(homeDir, channel);
  let counter = 0;
  try {
    const existing = JSON.parse(await fsp.readFile(filePath, "utf8"));
    if (existing.train === train) counter = existing.counter || 0;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const value = { train, counter: counter + 1, writtenAt: new Date().toISOString() };
  await pointerStore.atomicWriteJson(filePath, value);
  return value;
}

/**
 * @param {string} homeDir
 * @param {string} channel
 */
async function clearSentinel(homeDir, channel) {
  try {
    await fsp.unlink(sentinelPath(homeDir, channel));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

/**
 * @param {string} homeDir
 * @param {string} channel
 * @returns {Promise<number>} 0 if no sentinel is on disk
 */
async function consecutiveFailures(homeDir, channel) {
  try {
    const value = JSON.parse(await fsp.readFile(sentinelPath(homeDir, channel), "utf8"));
    return value.counter || 0;
  } catch (err) {
    if (err.code === "ENOENT") return 0;
    throw err;
  }
}

module.exports = {
  sha256File,
  activateFromArchive,
  resolveBoot,
  writeSentinel,
  clearSentinel,
  consecutiveFailures,
  renameWithBusyRetry,
};
