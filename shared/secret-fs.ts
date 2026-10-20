/**
 * Owner-only writes for files that hold credentials.
 *
 * Why this exists as its own module rather than another option on the generic
 * atomic writer: a generic writer takes the permission mode as an optional
 * argument, so every new call site is one forgotten argument away from writing
 * a credential that the whole machine can read. Here the mode is not an
 * argument at all. Callers cannot get it wrong, and a static scan can tell
 * credential writes apart from ordinary ones by the function name alone.
 *
 * The two kinds of entry point here treat a failed permission change
 * differently, on purpose. Writing records the failure and carries on, because
 * storing the user's data is the job and some filesystems cannot express these
 * permissions at all; refusing to save there would trade a working feature for
 * protection that filesystem cannot deliver anyway. The healing functions throw,
 * because the permission is their only job, so a failure means they did nothing
 * and their caller needs to know.
 *
 * Scope: this only controls who may open the file, which keeps credentials out
 * of reach of other accounts on the machine, of backup snapshots, and of a
 * directory someone shares or syncs by accident. It does not defend against
 * programs running as the same user, since those can read anything the user can
 * read. Protecting against those requires encryption keyed by the operating
 * system's own credential store, which is a separate piece of work.
 *
 * Windows: NTFS does not implement POSIX permission bits, and chmod there
 * succeeds while changing nothing. The user profile directory already excludes
 * other standard accounts through its inherited access control list, so the gap
 * this module closes on Unix does not exist there by default. Rather than
 * pretend otherwise, the mode work is skipped on Windows and the healers report
 * that they changed nothing.
 *
 * Deleting this module means reverting its callers to the generic atomic writer
 * and dropping the healer; nothing else depends on it.
 */
import fs from "fs";

import { AppError } from "./errors.ts";
import { errorBus } from "./error-bus.ts";

/** Credential files: readable and writable by the owner, nobody else. */
export const SECRET_FILE_MODE = 0o600;
/** Directories holding credentials: only the owner may enter or list them. */
export const SECRET_DIR_MODE = 0o700;
/**
 * Suffix of the temporary file a credential write goes through before the
 * rename. Named here so the startup pass that tightens leftovers looks for the
 * same name this module writes, instead of spelling it a second time.
 */
export const SECRET_TMP_SUFFIX = ".tmp";

const SUPPORTS_POSIX_MODE = process.platform !== "win32";

function permissionError(message: string, filePath: string, cause?: unknown) {
  return new AppError("FS_PERMISSION", { message, context: { filePath }, cause });
}

function currentMode(target: string): number | null {
  try {
    return fs.statSync(target).mode & 0o777;
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw permissionError("FS_PERMISSION", target, err);
  }
}

function applyMode(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode);
  } catch (err: any) {
    throw permissionError("FS_PERMISSION", target, err);
  }
}

/**
 * Restrict a file to its owner without letting failure block the write.
 * Reported once per path so an unsupported filesystem leaves a trace instead of
 * complaining on every save.
 */
function tightenBestEffort(target: string): void {
  let failure: unknown = null;
  try {
    fs.chmodSync(target, SECRET_FILE_MODE);
    if ((fs.statSync(target).mode & 0o777) === SECRET_FILE_MODE) return;
  } catch (err) {
    failure = err;
  }
  errorBus.report(
    new AppError("FS_PERMISSION", {
      message: "credential file could not be restricted to its owner",
      context: { filePath: target },
      cause: failure,
    }),
    { route: "silent", dedupeKey: `secret-fs:${target}` },
  );
}

/**
 * Atomically write a credential file so that only its owner can read it.
 *
 * Any leftover temporary file is cleared first: creating a file with a mode has
 * no effect when that file already exists, so a temporary file left behind by a
 * crashed earlier write would hand its own mode to the next secret written
 * through it. Clearing it means the new one carries the intended mode from the
 * moment it exists, and the tightening below is a second line rather than the
 * only one.
 */
export function writeSecretFileSync(filePath: string, content: string): void {
  const tmp = `${filePath}${SECRET_TMP_SUFFIX}`;
  // Best-effort: if this cannot be removed the write below still overwrites it
  // and the tightening step still applies.
  try { fs.rmSync(tmp, { force: true }); } catch { /* overwritten below */ }

  if (!SUPPORTS_POSIX_MODE) {
    try {
      fs.writeFileSync(tmp, content, "utf-8");
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* the write already failed */ }
      throw err;
    }
    try {
      fs.renameSync(tmp, filePath);
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* leave the target untouched */ }
      throw err;
    }
    return;
  }

  try {
    fs.writeFileSync(tmp, content, { encoding: "utf-8", mode: SECRET_FILE_MODE });
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* the write already failed */ }
    throw err;
  }

  // Creating with a mode does not reset an existing file, so set it explicitly.
  // This is deliberately best-effort: storing the data is the job, restricting
  // who can read it is protection layered on top. Filesystems without POSIX
  // permissions (removable media, some network mounts and container volumes)
  // either reject the change or accept it and keep the old mode, and refusing
  // to save a user's configuration there would trade a working feature for an
  // improvement that filesystem cannot deliver anyway. The attempt is recorded
  // so the gap is visible rather than assumed away.
  tightenBestEffort(tmp);

  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* leave the target untouched */ }
    throw err;
  }
}

/**
 * Tighten an existing credential file to owner-only.
 *
 * @returns whether the file needed changing, so callers can report what they healed.
 */
export function ensureSecretFileModeSync(filePath: string): boolean {
  if (!SUPPORTS_POSIX_MODE) return false;
  const mode = currentMode(filePath);
  if (mode === null || mode === SECRET_FILE_MODE) return false;
  applyMode(filePath, SECRET_FILE_MODE);
  // Confirm rather than assume: a filesystem without POSIX permissions accepts
  // the call and keeps the old mode, and reporting that as a correction would
  // claim a change that never happened, every single launch.
  return currentMode(filePath) === SECRET_FILE_MODE;
}

/**
 * Tighten an existing directory that holds credentials to owner-only.
 *
 * @returns whether the directory needed changing.
 */
export function ensureSecretDirModeSync(dirPath: string): boolean {
  if (!SUPPORTS_POSIX_MODE) return false;
  const mode = currentMode(dirPath);
  if (mode === null || mode === SECRET_DIR_MODE) return false;
  applyMode(dirPath, SECRET_DIR_MODE);
  return currentMode(dirPath) === SECRET_DIR_MODE;
}
