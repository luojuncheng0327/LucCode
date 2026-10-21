/* global process */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";

const MAX_ZIP_ENTRIES = 30_000;
const MAX_ZIP_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 100;
const IFMT = 0o170000;
const IFDIR = 0o040000;
const IFLNK = 0o120000;
const MAX_ABNORMAL_STDERR_BYTES = 256;

let cancelling = false;
let completedNormally = false;
let abnormalCompletionReported = false;
process.once("disconnect", () => {
  if (!completedNormally) {
    cancelling = true;
    process.exit(1);
  }
});

function reportAbnormalCompletion(reason) {
  if (abnormalCompletionReported) return;
  abnormalCompletionReported = true;
  const suffix = reason ? `: ${reason}` : "";
  try {
    fs.writeSync(2, `Package file worker exited abnormally${suffix}.\n`.slice(0, MAX_ABNORMAL_STDERR_BYTES));
  } catch {
    // The parent may already have closed every inherited handle.
  }
}

process.once("exit", () => {
  if (!completedNormally) reportAbnormalCompletion();
});

class WorkerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function checkCancelled() {
  if (cancelling || !process.connected) throw new WorkerError("INSTALL_CANCELLED", "Installation was cancelled.");
}

function send(message) {
  if (process.connected) process.send?.(message);
}

function sendTerminal(message) {
  return new Promise((resolve, reject) => {
    if (!process.connected || typeof process.send !== "function") {
      reject(new Error("The parent IPC channel is unavailable."));
      return;
    }
    try {
      process.send(message, (error) => error ? reject(error) : resolve());
    } catch (error) {
      reject(error);
    }
  });
}

function reportTerminalDeliveryFailure() {
  reportAbnormalCompletion("terminal response delivery failed");
  process.exitCode = 1;
  if (process.connected) {
    try { process.disconnect?.(); } catch { /* The IPC channel may have closed concurrently. */ }
  }
}

function createProgressReporter() {
  let last = 0;
  let pending = null;
  const flush = () => {
    if (!pending) return;
    const progress = pending;
    pending = null;
    last = Date.now();
    send({ type: "progress", progress });
  };
  return {
    report(progress) {
      pending = progress;
      if (Date.now() - last >= PROGRESS_INTERVAL_MS) flush();
    },
    flush,
  };
}

function assertAbsolutePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new WorkerError("INSTALL_FILE_OPERATION_INVALID", `${label} must be an absolute path.`);
  }
}

function assertOperation(operation) {
  if (!operation || typeof operation !== "object") {
    throw new WorkerError("INSTALL_FILE_OPERATION_INVALID", "Invalid package file operation.");
  }
  switch (operation.kind) {
    case "extract":
      assertAbsolutePath(operation.archivePath, "Archive path");
      assertAbsolutePath(operation.destination, "Destination");
      return;
    case "copy":
    case "move":
      assertAbsolutePath(operation.source, "Source");
      assertAbsolutePath(operation.destination, "Destination");
      return;
    case "hash":
      assertAbsolutePath(operation.directory, "Directory");
      return;
    case "inspect":
      assertAbsolutePath(operation.directory, "Directory");
      return;
    case "remove":
      assertAbsolutePath(operation.target, "Target");
      return;
    default:
      throw new WorkerError("INSTALL_FILE_OPERATION_INVALID", "Invalid package file operation.");
  }
}

function isSymlinkEntry(entry) {
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (mode & IFMT) === IFLNK;
}

function isDirectoryEntry(entry) {
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const madeBy = entry.versionMadeBy >>> 8;
  return (mode & IFMT) === IFDIR || entry.fileName.endsWith("/") || (madeBy === 0 && entry.externalFileAttributes === 16);
}

function zipEntryParts(entry) {
  if (!entry || typeof entry.fileName !== "string") {
    throw new WorkerError("INSTALL_ARCHIVE_INVALID", "Archive has an invalid entry.");
  }
  const name = entry.fileName;
  if (
    name.includes("\0")
    || name.includes("\\")
    || path.posix.isAbsolute(name)
    || path.win32.isAbsolute(name)
  ) {
    throw new WorkerError("INSTALL_ARCHIVE_INVALID", "Archive contains an unsafe entry path.");
  }
  const parts = name.replace(/\/$/, "").split("/");
  if (parts.length === 0 || parts.some((part) => !part || part === "." || part === "..")) {
    throw new WorkerError("INSTALL_ARCHIVE_INVALID", "Archive contains an unsafe entry path.");
  }
  return parts;
}

function validateZipMetadata(entry, totals) {
  if (isSymlinkEntry(entry)) {
    throw new WorkerError("INSTALL_ARCHIVE_SYMLINK", "Archive contains a symbolic link entry.");
  }
  zipEntryParts(entry);
  if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) {
    throw new WorkerError("INSTALL_ARCHIVE_INVALID", "Archive has an entry with an invalid uncompressed size.");
  }
  totals.entries += 1;
  totals.bytes += entry.uncompressedSize;
  if (totals.entries > MAX_ZIP_ENTRIES) {
    throw new WorkerError("INSTALL_ARCHIVE_LIMIT", `Archive exceeds ${MAX_ZIP_ENTRIES} entries.`);
  }
  if (!Number.isSafeInteger(totals.bytes) || totals.bytes > MAX_ZIP_UNCOMPRESSED_BYTES) {
    throw new WorkerError("INSTALL_ARCHIVE_LIMIT", "Archive exceeds the 512 MiB uncompressed size limit.");
  }
}

function openZip(archivePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, {
      lazyEntries: true,
      validateEntrySizes: true,
      strictFileNames: true,
    }, (error, zipfile) => error ? reject(error) : resolve(zipfile));
  });
}

async function scanZip(archivePath) {
  const zipfile = await openZip(archivePath);
  const totals = { entries: 0, bytes: 0 };
  try {
    await new Promise((resolve, reject) => {
      let done = false;
      const fail = (error) => {
        if (done) return;
        done = true;
        try { zipfile.close(); } catch { /* no resource remains useful */ }
        reject(error);
      };
      zipfile.once("error", fail);
      zipfile.on("entry", (entry) => {
        try {
          checkCancelled();
          validateZipMetadata(entry, totals);
          zipfile.readEntry();
        } catch (error) {
          fail(error);
        }
      });
      zipfile.once("end", () => {
        if (done) return;
        done = true;
        try { zipfile.close(); } catch { /* already consumed */ }
        resolve();
      });
      zipfile.readEntry();
    });
  } catch (error) {
    if (error instanceof WorkerError) throw error;
    throw new WorkerError("INSTALL_ARCHIVE_INVALID", "Archive could not be read safely.");
  } finally {
    try { zipfile.close(); } catch { /* already closed */ }
  }
  return totals;
}

async function assertRegularFile(source) {
  const stat = await fsp.lstat(source);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new WorkerError("INSTALL_FILE_SOURCE_INVALID", "Package source must be a regular file.");
  }
}

async function ensureDirectory(directory, mode = 0o755) {
  await fsp.mkdir(directory, { recursive: true, mode });
  const stat = await fsp.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new WorkerError("INSTALL_FILE_DESTINATION_INVALID", "Package destination contains an unsafe directory.");
  }
}

async function ensureZipDirectory(root, parts, mode = 0o755) {
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    await ensureDirectory(current, mode);
  }
  return current;
}

function entryMode(entry, directory) {
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  if (mode === 0) return directory ? 0o755 : 0o644;
  return mode & 0o777;
}

async function extractZip(archivePath, destination, reporter) {
  await assertRegularFile(archivePath);
  // ZIP metadata has to be scanned before a meaningful total exists.
  reporter.report({ phase: "extracting" });
  reporter.flush();
  const totals = await scanZip(archivePath);
  await ensureDirectory(destination);
  const root = await fsp.realpath(destination);
  reporter.report({ phase: "extracting", completed: 0, total: totals.entries, unit: "files" });
  reporter.flush();

  const zipfile = await openZip(archivePath);
  let completed = 0;
  try {
    await new Promise((resolve, reject) => {
      let done = false;
      const fail = (error) => {
        if (done) return;
        done = true;
        try { zipfile.close(); } catch { /* no resource remains useful */ }
        reject(error);
      };
      zipfile.once("error", fail);
      zipfile.on("entry", async (entry) => {
        if (done) return;
        try {
          checkCancelled();
          validateZipMetadata(entry, { entries: 0, bytes: 0 });
          const parts = zipEntryParts(entry);
          const directory = isDirectoryEntry(entry);
          if (directory) {
            await ensureZipDirectory(root, parts, entryMode(entry, true));
          } else {
            const parent = await ensureZipDirectory(root, parts.slice(0, -1));
            const target = path.join(parent, parts.at(-1));
            // A package is staged into an empty, caller-owned directory. wx
            // prevents a repeated ZIP entry from replacing a prior file.
            await pipeline(
              await new Promise((resolveStream, rejectStream) => zipfile.openReadStream(entry, (error, stream) => error ? rejectStream(error) : resolveStream(stream))),
              fs.createWriteStream(target, { flags: "wx", mode: entryMode(entry, false) }),
            );
          }
          completed += 1;
          reporter.report({ phase: "extracting", completed, total: totals.entries, unit: "files" });
          zipfile.readEntry();
        } catch (error) {
          fail(error);
        }
      });
      zipfile.once("end", () => {
        if (done) return;
        done = true;
        try { zipfile.close(); } catch { /* already consumed */ }
        resolve();
      });
      zipfile.readEntry();
    });
  } finally {
    try { zipfile.close(); } catch { /* already closed */ }
  }
  reporter.flush();
}

async function listFiles(root, rejectSymlinks) {
  const files = [];
  async function visit(absolute, relative) {
    checkCancelled();
    const entries = await fsp.readdir(absolute, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(absolute, entry.name);
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const stat = await fsp.lstat(full);
      if (stat.isSymbolicLink()) {
        if (rejectSymlinks) throw new WorkerError("INSTALL_FILE_SYMLINK", "Package source contains a symbolic link.");
        continue;
      }
      if (stat.isDirectory()) {
        await visit(full, rel);
      } else if (stat.isFile()) {
        files.push({ absolute: full, relative: rel, size: stat.size, mode: stat.mode & 0o777 });
      } else if (rejectSymlinks) {
        throw new WorkerError("INSTALL_FILE_SOURCE_INVALID", "Package source contains an unsupported file type.");
      }
    }
  }
  await visit(root, "");
  // This must match Object.keys(hashes).sort() in hashSeedDirectory exactly.
  return files.sort((left, right) => left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0);
}

async function copyDirectories(source, destination) {
  async function visit(absolute, relative) {
    const entries = await fsp.readdir(absolute, { withFileTypes: true });
    for (const entry of entries) {
      checkCancelled();
      const full = path.join(absolute, entry.name);
      const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const stat = await fsp.lstat(full);
      if (stat.isSymbolicLink()) {
        throw new WorkerError("INSTALL_FILE_SYMLINK", "Package source contains a symbolic link.");
      }
      if (stat.isDirectory()) {
        const target = path.join(destination, ...nextRelative.split("/"));
        await fsp.mkdir(target, { recursive: false, mode: stat.mode & 0o777 });
        try { await fsp.chmod(target, stat.mode & 0o777); } catch { /* Windows does not preserve POSIX modes */ }
        await visit(full, nextRelative);
      } else if (!stat.isFile()) {
        throw new WorkerError("INSTALL_FILE_SOURCE_INVALID", "Package source contains an unsupported file type.");
      }
    }
  }
  await visit(source, "");
}

async function hashFile(file, onBytes) {
  const digest = createHash("sha256");
  const stream = fs.createReadStream(file);
  for await (const chunk of stream) {
    checkCancelled();
    digest.update(chunk);
    onBytes(chunk.length);
  }
  return digest.digest("hex");
}

async function hashDirectory(directory, reporter) {
  const source = await fsp.lstat(directory);
  if (source.isSymbolicLink() || !source.isDirectory()) {
    throw new WorkerError("INSTALL_FILE_SOURCE_INVALID", "Package source must be a directory.");
  }
  reporter.report({ phase: "validating" });
  reporter.flush();
  const files = await listFiles(directory, false);
  const total = files.reduce((sum, file) => sum + file.size, 0);
  let completed = 0;
  reporter.report({ phase: "validating", completed: 0, total, unit: "bytes" });
  const aggregate = createHash("sha256");
  for (const file of files) {
    const digest = await hashFile(file.absolute, (bytes) => {
      completed += bytes;
      reporter.report({ phase: "validating", completed, total, unit: "bytes" });
    });
    aggregate.update(file.relative);
    aggregate.update("\0");
    aggregate.update(digest);
    aggregate.update("\0");
  }
  reporter.report({ phase: "validating", completed: total, total, unit: "bytes" });
  reporter.flush();
  return aggregate.digest("hex");
}

async function inspectDirectory(directory, reporter) {
  const source = await fsp.lstat(directory);
  if (source.isSymbolicLink() || !source.isDirectory()) {
    throw new WorkerError("INSTALL_FILE_SOURCE_INVALID", "Package source must be a directory.");
  }
  reporter.report({ phase: "validating" });
  reporter.flush();
  const files = await listFiles(directory, true);
  const size = files.reduce((sum, file) => sum + file.size, 0);
  reporter.report({ phase: "validating", completed: files.length, total: files.length, unit: "files" });
  reporter.flush();
  return { size, files: files.length };
}

async function copyFile(source, destination, mode, progress) {
  await ensureDirectory(path.dirname(destination));
  await pipeline(
    fs.createReadStream(source),
    fs.createWriteStream(destination, { flags: "wx", mode }),
  );
  try { await fsp.chmod(destination, mode); } catch { /* Windows does not preserve POSIX modes */ }
  progress();
}

async function copyDirectory(source, destination, reporter) {
  const sourceStat = await fsp.lstat(source);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    throw new WorkerError("INSTALL_FILE_SOURCE_INVALID", "Package source must be a directory.");
  }
  reporter.report({ phase: "installing" });
  reporter.flush();
  const files = await listFiles(source, true);
  const total = files.reduce((sum, file) => sum + file.size, 0);
  let completed = 0;
  const parent = path.dirname(destination);
  await ensureDirectory(parent);
  const existing = await fsp.lstat(destination).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (existing?.isSymbolicLink()) {
    throw new WorkerError("INSTALL_FILE_DESTINATION_INVALID", "Package destination is a symbolic link.");
  }
  const temporary = path.join(parent, `.${path.basename(destination)}.install-${randomUUID()}`);
  const backup = path.join(parent, `.${path.basename(destination)}.backup-${randomUUID()}`);
  try {
    await fsp.mkdir(temporary, { recursive: false, mode: sourceStat.mode & 0o777 });
    reporter.report({ phase: "installing", completed: 0, total, unit: "bytes" });
    await copyDirectories(source, temporary);
    for (const file of files) {
      const target = path.join(temporary, ...file.relative.split("/"));
      await copyFile(file.absolute, target, file.mode, () => {
        completed += file.size;
        reporter.report({ phase: "installing", completed, total, unit: "bytes" });
      });
    }
    if (existing) await fsp.rename(destination, backup);
    try {
      await fsp.rename(temporary, destination);
    } catch (error) {
      if (existing) await fsp.rename(backup, destination).catch(() => {});
      throw error;
    }
    if (existing) await fsp.rm(backup, { recursive: true, force: true }).catch(() => {});
  } catch (error) {
    await fsp.rm(temporary, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  reporter.report({ phase: "installing", completed: total, total, unit: "bytes" });
  reporter.flush();
}

async function moveDirectory(source, destination, reporter) {
  reporter.report({ phase: "installing" });
  reporter.flush();
  const sourceStat = await fsp.lstat(source);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    throw new WorkerError("INSTALL_FILE_SOURCE_INVALID", "Package source must be a directory.");
  }
  await ensureDirectory(path.dirname(destination));
  // A same-filesystem rename would otherwise carry links from a package
  // straight into its installed location, bypassing copy's source checks.
  await listFiles(source, true);
  try {
    await fsp.rename(source, destination);
    reporter.report({ phase: "installing" });
    reporter.flush();
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    await copyDirectory(source, destination, reporter);
    await removeTarget(source, reporter);
  }
}

async function removeTarget(target, reporter) {
  const stat = await fsp.lstat(target).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (stat) await fsp.rm(target, { recursive: true, force: true, maxRetries: 2 });
  reporter.report({ phase: "cleaning" });
  reporter.flush();
}

async function run(operation, reporter) {
  assertOperation(operation);
  checkCancelled();
  switch (operation.kind) {
    case "extract":
      await extractZip(operation.archivePath, operation.destination, reporter);
      return {};
    case "copy":
      await copyDirectory(operation.source, operation.destination, reporter);
      return {};
    case "hash":
      return { sha256: await hashDirectory(operation.directory, reporter) };
    case "inspect":
      return inspectDirectory(operation.directory, reporter);
    case "remove":
      await removeTarget(operation.target, reporter);
      return {};
    case "move":
      await moveDirectory(operation.source, operation.destination, reporter);
      return {};
  }
}

process.once("message", async (message) => {
  const reporter = createProgressReporter();
  let terminalSendAttempted = false;
  try {
    if (!message || message.type !== "operation") {
      throw new WorkerError("INSTALL_FILE_OPERATION_INVALID", "Invalid package file operation.");
    }
    const result = await run(message.operation, reporter);
    reporter.flush();
    terminalSendAttempted = true;
    await sendTerminal({ type: "result", result });
    completedNormally = true;
    process.disconnect?.();
  } catch (error) {
    if (terminalSendAttempted) {
      reportTerminalDeliveryFailure();
      return;
    }
    reporter.flush();
    const code = typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code)
      ? error.code : "INSTALL_FILE_OPERATION_FAILED";
    const messageText = error instanceof Error ? error.message : "Package file operation failed.";
    terminalSendAttempted = true;
    try {
      await sendTerminal({ type: "error", code, message: messageText });
      completedNormally = true;
      process.disconnect?.();
    } catch {
      reportTerminalDeliveryFailure();
    }
  }
});
