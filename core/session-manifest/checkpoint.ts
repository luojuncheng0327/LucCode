import fs from "fs";
import path from "path";
import { atomicWriteSync, safeCopyDir } from "../../shared/safe-fs.ts";
import { moveSessionManifestDbFilesAside } from "./db-files.ts";

export const SESSION_MANIFEST_CHECKPOINT_SCHEMA_VERSION = 1;
export const SESSION_MANIFEST_CHECKPOINT_KIND = "session-manifest-migration-checkpoint";
export const DEFAULT_SESSION_MANIFEST_CHECKPOINT_INCLUDES = [
  "agents",
  "session-files",
  "bridge",
  "phone",
  "plugins",
];

function sanitizeTimestamp(value) {
  return String(value)
    .replace(/:/g, "-")
    .replace(/\./g, "-");
}

function readPackageVersion() {
  try {
    const packagePath = path.resolve("package.json");
    return JSON.parse(fs.readFileSync(packagePath, "utf-8")).version || null;
  } catch {
    return null;
  }
}

function assertDirectoryWritable(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const probe = path.join(directory, `.write-probe-${Date.now()}`);
  fs.writeFileSync(probe, "ok");
  fs.unlinkSync(probe);
}

function readCheckpointReceipt(checkpointDirectory) {
  const receiptPath = path.join(checkpointDirectory, "checkpoint.json");
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf-8"));
  if (receipt?.kind !== SESSION_MANIFEST_CHECKPOINT_KIND) {
    throw new Error(`Invalid session manifest checkpoint: ${checkpointDirectory}`);
  }
  return receipt;
}

export function createSessionManifestCheckpoint(opts: any = {}) {
  if (!opts.lucHome) throw new Error("createSessionManifestCheckpoint requires lucHome");
  const lucHome = path.resolve(opts.lucHome);
  const createdAt = opts.createdAt || new Date().toISOString();
  const id = opts.id || sanitizeTimestamp(createdAt);
  const checkpointRoot = opts.checkpointRoot
    ? path.resolve(opts.checkpointRoot)
    : path.join(lucHome, "checkpoints", "session-manifest");
  const checkpointDirectory = path.join(checkpointRoot, id);
  const includes = opts.includes || DEFAULT_SESSION_MANIFEST_CHECKPOINT_INCLUDES;

  if (fs.existsSync(checkpointDirectory)) {
    throw new Error(`Session manifest checkpoint already exists: ${checkpointDirectory}`);
  }
  assertDirectoryWritable(checkpointRoot);
  fs.mkdirSync(checkpointDirectory, { recursive: true });

  const includeReceipts = [];
  try {
    for (const name of includes) {
      const source = path.join(lucHome, name);
      const target = path.join(checkpointDirectory, name);
      if (!fs.existsSync(source)) {
        includeReceipts.push({ name, source, checkpointPath: target, exists: false });
        continue;
      }
      safeCopyDir(source, target);
      includeReceipts.push({ name, source, checkpointPath: target, exists: true });
    }

    const receipt = {
      kind: SESSION_MANIFEST_CHECKPOINT_KIND,
      schemaVersion: SESSION_MANIFEST_CHECKPOINT_SCHEMA_VERSION,
      id,
      appVersion: opts.appVersion || readPackageVersion(),
      createdAt,
      lucHome,
      gitAnchors: opts.gitAnchors || {},
      includes: includeReceipts,
    };
    atomicWriteSync(path.join(checkpointDirectory, "checkpoint.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    return { ...receipt, directory: checkpointDirectory };
  } catch (error) {
    try { fs.rmSync(checkpointDirectory, { recursive: true, force: true }); } catch {}
    throw error;
  }
}

export function restoreSessionManifestCheckpoint(opts: any = {}) {
  if (!opts.checkpointDirectory) {
    throw new Error("restoreSessionManifestCheckpoint requires checkpointDirectory");
  }
  const checkpointDirectory = path.resolve(opts.checkpointDirectory);
  const receipt = readCheckpointReceipt(checkpointDirectory);
  const lucHome = path.resolve(opts.lucHome || receipt.lucHome);
  const restoredAt = opts.restoredAt || new Date().toISOString();
  const restoreId = sanitizeTimestamp(restoredAt);
  assertDirectoryWritable(lucHome);

  const movedManifestFiles = moveSessionManifestDbFilesAside({
    lucHome,
    suffix: `rollback-${restoreId}`,
  });
  const movedManifestDbTo = movedManifestFiles.find((entry) => (
    path.basename(entry.from) === "session-manifest.db"
  ))?.to || null;

  for (const entry of receipt.includes || []) {
    if (!entry?.exists) continue;
    const source = path.join(checkpointDirectory, entry.name);
    const target = path.join(lucHome, entry.name);
    safeCopyDir(source, target);
  }

  return {
    checkpointDirectory,
    lucHome,
    restoredAt,
    movedManifestDbTo,
    movedManifestFiles,
    restored: (receipt.includes || []).filter((entry) => entry?.exists).map((entry) => entry.name),
  };
}
