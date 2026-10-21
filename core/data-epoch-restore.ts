import crypto from "crypto";
import fs from "fs";
import path from "path";
import {
  createDataEpochCheckpointProvider,
  DATA_EPOCH_CHECKPOINTS_DIRNAME,
  expandStorePathPattern,
  sqliteDatabasePatterns,
  type DataEpochCheckpointItem,
  type DataEpochCheckpointMetadata,
} from "./data-epoch-checkpoint-provider.ts";
import {
  describeForeignServerBlock,
  isForeignServerBlocking,
  probeServerInfo,
} from "../shared/server-info-probe.cjs";
import {
  durableWriteJson,
  readDataEpochJournal,
  readDataEpochRestoreJournal,
  removeDataEpochJournal,
  republishDataEpochStampForRestore,
  writeDataEpochRestoreJournal,
  type DataEpochRestoreJournalPhase,
} from "../shared/data-epoch.cjs";
import { fromRoot } from "../shared/luc-root.ts";
import { PERSISTENT_STORES } from "../shared/persistence/store-registry.ts";
import type { StoreDescriptor } from "../shared/persistence/store-registry-types.ts";

/**
 * core/data-epoch-restore.ts
 *
 * The explicit, journaled restore transaction for data-epoch checkpoints:
 * the only path in this codebase allowed to move an affected store's on-disk
 * bytes — and the data epoch stamp itself — back to an earlier, checkpointed
 * epoch. This is a library-level entry point; no CLI command or dialog calls
 * it yet (a user-facing maintenance surface is planned separately). It never
 * mutates coordinator forward semantics, the checkpoint provider
 * (core/data-epoch-checkpoint-provider.ts), or the migration registry.
 *
 * Every affected store's pre-restore bytes are moved (never deleted) into
 * `{homeDir}/data-epoch-restore-quarantine/{restoreId}/{storeId}/…`, the
 * captured checkpoint bytes are copied back in their place, and the result
 * is reconciled file-for-file against the checkpoint's manifest before the
 * epoch stamp is republished and the journal is cleared. Every step records
 * its own journal phase (dataEpochJournalPath, shared with — but a distinct
 * shape from — the forward transition journal) so a crash at any point
 * leaves durable, diagnosable evidence and a rerun with the same arguments
 * finishes the job idempotently.
 */

export const DATA_EPOCH_RESTORE_QUARANTINE_DIRNAME = "data-epoch-restore-quarantine";
export const DATA_EPOCH_RESTORE_LOG_FILENAME = "data-epoch-restores.log";
export const DATA_EPOCH_RESTORE_RECEIPT_FILENAME = "restore-receipt.json";

export type DataEpochRestoreFaultEvent =
  | "restore:journal-written"
  | `restore:store-quarantined:${string}`
  | `restore:store-copied-back:${string}`
  | "restore:stores-restored"
  | "restore:metadata-republished";

export interface DataEpochRestoreReceipt {
  schemaVersion: 1;
  restoreId: string;
  transitionId: string;
  fromEpoch: number;
  toEpoch: number;
  affectedStoreIds: string[];
  itemCount: number;
  totalBytes: number;
  checkpointDir: string;
  quarantineDir: string;
  restoredAt: string;
}

export interface DataEpochRestoreResult {
  restoreId: string;
  transitionId: string;
  fromEpoch: number;
  toEpoch: number;
  affectedStoreIds: string[];
  quarantineDir: string;
  receiptPath: string;
}

interface RestoreLog {
  warn: (message: string) => void;
  log?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function timestamp(clock: (() => Date | string) | undefined): string {
  const value = clock ? clock() : new Date();
  const result = value instanceof Date ? value.toISOString() : value;
  if (typeof result !== "string" || Number.isNaN(Date.parse(result))) {
    throw new Error("data epoch restore clock returned an invalid timestamp");
  }
  return result;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.promises.access(candidate);
    return true;
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function notifyFault(
  hook: ((event: DataEpochRestoreFaultEvent) => Promise<void> | void) | undefined,
  event: DataEpochRestoreFaultEvent,
): Promise<void> {
  if (hook) await hook(event);
}

async function resolvePackageVersion(): Promise<string> {
  const raw = await fs.promises.readFile(fromRoot("package.json"), "utf8");
  const pkg = JSON.parse(raw) as { version?: unknown };
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error("data epoch restore could not resolve the running kernel's package version");
  }
  return pkg.version;
}

// ---------------------------------------------------------------------------
// Same-home probe: refuse to restore while any kernel is live for this home.
// Reuses the shared token-authenticated probe (shared/server-info-probe.cjs)
// that server/index.ts's own startup mutual-exclusion gate is built on —
// only "dead" and "not-luc" are safe to proceed past.
// ---------------------------------------------------------------------------

async function assertNoLiveServer(homeDir: string): Promise<void> {
  const serverInfoPath = path.join(homeDir, "server-info.json");
  let info: unknown = null;
  try {
    info = JSON.parse(await fs.promises.readFile(serverInfoPath, "utf8"));
  } catch {
    return; // missing or unparsable: nothing alive to defend against
  }

  const probe = await probeServerInfo({ info: info as { port?: number; token?: string } });
  if (isForeignServerBlocking(probe.status)) {
    const detail = describeForeignServerBlock({ status: probe.status, info: info as Record<string, unknown> })
      ?? `a kernel is currently responding for this data directory (probe status: ${probe.status})`;
    throw new Error(`restoreDataEpochCheckpoint refuses to run while a kernel is live for this home:\n${detail}`);
  }
}

// ---------------------------------------------------------------------------
// Directory walking + reconciliation. expandStorePathPattern is the
// checkpoint provider's own exported pattern expander (reused, not
// reimplemented); the recursive file walk for tree-kind matches mirrors the
// provider's private walkFilesRecursive — that helper is not exported, and
// widening the provider's export surface just for this would couple the two
// modules tighter than the shared behavior warrants, so the small walk is
// duplicated here.
// ---------------------------------------------------------------------------

function walkFilesRecursive(dirPath: string): string[] {
  const result: string[] = [];
  const stack = [dirPath];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const absPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`data epoch restore refuses to traverse a symbolic link: ${absPath}`);
      }
      if (entry.isDirectory()) {
        stack.push(absPath);
      } else if (entry.isFile()) {
        result.push(absPath);
      } else {
        throw new Error(`data epoch restore found an unsupported filesystem entry: ${absPath}`);
      }
    }
  }
  return result.sort();
}

interface ActualStoreFile {
  relPath: string;
  absPath: string;
}

/**
 * Re-scans a store's registered pathPatterns against the live homeDir right
 * now. Used three times per store: once to decide whether a quarantine +
 * copy-back pass is even necessary (already-idempotent resume), once to
 * gather what must be swept into quarantine, and once — always, whether or
 * not the fast path ran — as the authoritative post-restore reconciliation
 * scan.
 */
function collectActualStoreFiles(homeDir: string, descriptor: StoreDescriptor): ActualStoreFile[] {
  const results: ActualStoreFile[] = [];
  const patterns = new Set([...descriptor.pathPatterns, ...sqliteDatabasePatterns(descriptor).flatMap(pattern => [`${pattern}-wal`, `${pattern}-shm`])]);
  for (const pattern of patterns) {
    const matches = expandStorePathPattern(homeDir, pattern);
    for (const match of matches) {
      if (match.isDirectory) {
        if (descriptor.pathKind !== "tree") {
          throw new Error(
            `data epoch restore found a directory where store "${descriptor.id}" declares pathKind "file": ${match.relPath}`,
          );
        }
        for (const absFile of walkFilesRecursive(match.absPath)) {
          results.push({ relPath: toPosixPath(path.relative(homeDir, absFile)), absPath: absFile });
        }
      } else {
        if (descriptor.pathKind === "tree") {
          throw new Error(
            `data epoch restore found a file where store "${descriptor.id}" declares pathKind "tree": ${match.relPath}`,
          );
        }
        results.push({ relPath: toPosixPath(path.relative(homeDir, match.absPath)), absPath: match.absPath });
      }
    }
  }
  return results;
}

function sha256File(filePath: string): Promise<{ bytes: number; sha256: string }> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    let bytes = 0;
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    stream.on("end", () => resolve({ bytes, sha256: hash.digest("hex") }));
  });
}

/**
 * Never overwrites: an earlier partial attempt may already have quarantined
 * a same-named file (e.g. a crash between copy-back and reconciliation,
 * followed by a retry that re-sweeps). Both copies are kept, attributable,
 * by disambiguating with a `.dup-N` suffix rather than clobbering. Exported
 * so the disambiguation behavior itself has direct, isolated test coverage
 * rather than only being reachable through a contrived multi-attempt
 * end-to-end scenario.
 */
export async function quarantineDestination(quarantineStoreDir: string, relPath: string): Promise<string> {
  const segments = relPath.split("/");
  const base = path.join(quarantineStoreDir, ...segments);
  if (!(await pathExists(base))) return base;
  const dir = path.dirname(base);
  const ext = path.extname(base);
  const stem = path.basename(base, ext);
  for (let attempt = 2; ; attempt += 1) {
    const candidate = path.join(dir, `${stem}.dup-${attempt}${ext}`);
    if (!(await pathExists(candidate))) return candidate;
  }
}

async function restoreOneStore(args: {
  homeDir: string;
  descriptor: StoreDescriptor;
  capturedItems: DataEpochCheckpointItem[];
  checkpointDir: string;
  quarantineRoot: string;
  faultHook: ((event: DataEpochRestoreFaultEvent) => Promise<void> | void) | undefined;
}): Promise<void> {
  const { homeDir, descriptor, capturedItems, checkpointDir, quarantineRoot, faultHook } = args;
  const capturedByRelPath = new Map(capturedItems.map((item) => [item.relPath, item]));

  const existing = collectActualStoreFiles(homeDir, descriptor);
  const alreadyRestored = existing.length === capturedItems.length
    && (await Promise.all(existing.map(async (file) => {
      const captured = capturedByRelPath.get(file.relPath);
      if (!captured) return false;
      const actual = await sha256File(file.absPath);
      return actual.bytes === captured.bytes && actual.sha256 === captured.sha256;
    }))).every(Boolean);

  if (!alreadyRestored) {
    const quarantineStoreDir = path.join(quarantineRoot, descriptor.id);
    for (const file of existing) {
      const destination = await quarantineDestination(quarantineStoreDir, file.relPath);
      await fs.promises.mkdir(path.dirname(destination), { recursive: true });
      await fs.promises.rename(file.absPath, destination);
    }
    await notifyFault(faultHook, `restore:store-quarantined:${descriptor.id}`);

    for (const item of capturedItems) {
      const source = path.join(checkpointDir, "stores", descriptor.id, ...item.relPath.split("/"));
      const destination = path.join(homeDir, ...item.relPath.split("/"));
      await fs.promises.mkdir(path.dirname(destination), { recursive: true });
      await fs.promises.copyFile(source, destination);
    }
    await notifyFault(faultHook, `restore:store-copied-back:${descriptor.id}`);
  }

  // Authoritative reconciliation: the old-kernel-visible file set for this
  // store must now equal the captured manifest exactly, byte-for-byte, with
  // zero extras — this always re-scans fresh, whether or not the fast path
  // above ran, so it also catches a fast-path false positive.
  const reconciled = collectActualStoreFiles(homeDir, descriptor);
  if (reconciled.length !== capturedItems.length) {
    throw new Error(
      `data epoch restore reconciliation failed for store "${descriptor.id}": expected ${capturedItems.length} `
      + `file(s) matching the checkpoint manifest, found ${reconciled.length}`,
    );
  }
  const reconciledByRelPath = new Map(reconciled.map((file) => [file.relPath, file]));
  for (const item of capturedItems) {
    const file = reconciledByRelPath.get(item.relPath);
    if (!file) {
      throw new Error(`data epoch restore reconciliation failed for store "${descriptor.id}": missing ${item.relPath}`);
    }
    const { bytes, sha256 } = await sha256File(file.absPath);
    if (bytes !== item.bytes || sha256 !== item.sha256) {
      throw new Error(
        `data epoch restore reconciliation failed for store "${descriptor.id}" file "${item.relPath}": `
        + `expected ${item.bytes}b/${item.sha256}, found ${bytes}b/${sha256}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Checkpoint metadata: the provider's verify() (reused unmodified) already
// proves this file is well-formed, complete, and every item's bytes/sha256
// reconcile — this only re-parses the same, now-trusted metadata.json to
// read its content (fromEpoch/affectedStoreIds/items). It repeats none of
// verify()'s byte/hash reconciliation.
// ---------------------------------------------------------------------------

async function readCheckpointMetadataForRestore(checkpointDir: string, transitionId: string): Promise<DataEpochCheckpointMetadata> {
  const metadataPath = path.join(checkpointDir, "metadata.json");
  const raw = await fs.promises.readFile(metadataPath, "utf8");
  const value = JSON.parse(raw) as DataEpochCheckpointMetadata;
  if (value.transitionId !== transitionId) {
    throw new Error(
      `data epoch restore: checkpoint metadata transitionId "${value.transitionId}" does not match requested "${transitionId}"`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// The restore transaction.
// ---------------------------------------------------------------------------

export async function restoreDataEpochCheckpoint(args: {
  homeDir: string;
  transitionId: string;
  confirmToken: string;
  log?: RestoreLog;
  clock?: () => Date | string;
  stores?: readonly StoreDescriptor[];
  faultHook?: (event: DataEpochRestoreFaultEvent) => Promise<void> | void;
}): Promise<DataEpochRestoreResult> {
  const {
    homeDir,
    transitionId,
    confirmToken,
    log = console,
    clock,
    stores = PERSISTENT_STORES,
    faultHook,
  } = args;

  if (typeof homeDir !== "string" || homeDir.length === 0) {
    throw new Error("restoreDataEpochCheckpoint requires a non-empty homeDir");
  }
  if (typeof transitionId !== "string" || transitionId.length === 0) {
    throw new Error("restoreDataEpochCheckpoint requires a non-empty transitionId");
  }

  // Precondition 1: confirmToken must exactly equal "restore {transitionId}"
  // — the future user-facing maintenance surface will make the user retype
  // this; the library enforces it regardless so no caller can "accidentally"
  // invoke a downgrade.
  const expectedToken = `restore ${transitionId}`;
  if (confirmToken !== expectedToken) {
    throw new Error(`restoreDataEpochCheckpoint requires the exact confirmation phrase "${expectedToken}"`);
  }

  // Precondition 2: same-home probe — no live server for this home.
  await assertNoLiveServer(homeDir);

  // Precondition 3: checkpoint directory is complete and verifies cleanly.
  // Reuses the provider's own verify() contract rather than re-implementing
  // the byte/sha256 reconciliation.
  const checkpointDir = path.join(homeDir, DATA_EPOCH_CHECKPOINTS_DIRNAME, transitionId);
  const provider = createDataEpochCheckpointProvider({ stores });
  try {
    await provider.verify({ id: transitionId, dir: checkpointDir });
  } catch (error: unknown) {
    throw new Error(
      `restoreDataEpochCheckpoint: checkpoint verification failed for transitionId "${transitionId}": ${errorMessage(error)}`,
    );
  }
  const metadata = await readCheckpointMetadataForRestore(checkpointDir, transitionId);
  const { fromEpoch, toEpoch, affectedStoreIds } = metadata;

  const descriptorsById = new Map(stores.map((store) => [store.id, store]));
  for (const storeId of affectedStoreIds) {
    if (!descriptorsById.has(storeId)) {
      throw new Error(`restoreDataEpochCheckpoint: checkpoint references unknown store id "${storeId}"`);
    }
  }

  // Precondition 4 + resume detection: read whatever journal is on disk.
  // A restore-phase journal for this exact transitionId is a legitimate
  // in-progress restore to resume. A forward journal is only a legitimate
  // starting point when its transitionId matches — restore is its intended
  // exit ramp. Anything else that fails to parse as either shape is
  // genuinely corrupt and this refuses to guess.
  const restoreRead = readDataEpochRestoreJournal(homeDir);
  let restoreId: string;
  let resumeFromPhase: DataEpochRestoreJournalPhase | null = null;
  if (restoreRead.status === "ok") {
    if (restoreRead.journal.transitionId !== transitionId) {
      throw new Error(
        `restoreDataEpochCheckpoint: a restore is already in progress for a different transitionId `
        + `(${restoreRead.journal.transitionId}); refusing to start a restore for ${transitionId}`,
      );
    }
    if (restoreRead.journal.fromEpoch !== fromEpoch) {
      throw new Error(
        `restoreDataEpochCheckpoint: the in-progress restore journal targets fromEpoch=${restoreRead.journal.fromEpoch}, `
        + `but the checkpoint metadata for "${transitionId}" records fromEpoch=${fromEpoch}`,
      );
    }
    restoreId = restoreRead.journal.restoreId;
    resumeFromPhase = restoreRead.journal.phase;
    log.warn(
      `[data-epoch-restore] resuming an interrupted restore for transitionId=${transitionId} `
      + `(restoreId=${restoreId}) from phase ${resumeFromPhase}`,
    );
  } else {
    const forwardRead = readDataEpochJournal(homeDir);
    if (forwardRead.status === "ok") {
      if (forwardRead.journal.transitionId !== transitionId) {
        throw new Error(
          `restoreDataEpochCheckpoint: an in-progress forward transition journal exists for a different `
          + `transitionId (${forwardRead.journal.transitionId}); refusing to restore ${transitionId} over it`,
        );
      }
      // A forward journal for this exact transitionId is its legitimate
      // exit ramp — proceed; step 1 below replaces it with the restore
      // journal shape.
    } else if (forwardRead.status === "corrupt") {
      throw new Error(
        `restoreDataEpochCheckpoint refuses to run while the on-disk transition journal is unreadable: ${forwardRead.detail}`,
      );
    }
    restoreId = crypto.randomUUID();
  }

  const quarantineRoot = path.join(homeDir, DATA_EPOCH_RESTORE_QUARANTINE_DIRNAME, restoreId);
  const receiptPath = path.join(quarantineRoot, DATA_EPOCH_RESTORE_RECEIPT_FILENAME);
  const logPath = path.join(homeDir, DATA_EPOCH_RESTORE_LOG_FILENAME);

  // Step 1: write (or, on resume, keep) the restore-phase journal.
  if (resumeFromPhase === null) {
    await writeDataEpochRestoreJournal(homeDir, {
      restoreId,
      transitionId,
      fromEpoch,
      phase: "restore:starting",
      updatedAt: timestamp(clock),
    });
    resumeFromPhase = "restore:starting";
    await notifyFault(faultHook, "restore:journal-written");
  }

  // Steps 2-3: per affected store, quarantine existing bytes then copy back
  // checkpointed bytes, then reconcile. Skipped once already durable.
  if (resumeFromPhase === "restore:starting") {
    for (const storeId of affectedStoreIds) {
      const descriptor = descriptorsById.get(storeId)!;
      const capturedItems = metadata.items.filter((item) => item.storeId === storeId);
      await restoreOneStore({ homeDir, descriptor, capturedItems, checkpointDir, quarantineRoot, faultHook });
    }
    await writeDataEpochRestoreJournal(homeDir, {
      restoreId,
      transitionId,
      fromEpoch,
      phase: "restore:stores_restored",
      updatedAt: timestamp(clock),
    });
    resumeFromPhase = "restore:stores_restored";
    await notifyFault(faultHook, "restore:stores-restored");
  }

  // Step 4: republish the stamp back to fromEpoch — the sole guarded
  // channel allowed to lower it.
  if (resumeFromPhase === "restore:stores_restored") {
    const lastVersion = await resolvePackageVersion();
    await republishDataEpochStampForRestore({ homeDir, fromEpoch, lastVersion, updatedAt: timestamp(clock) });
    await writeDataEpochRestoreJournal(homeDir, {
      restoreId,
      transitionId,
      fromEpoch,
      phase: "restore:metadata_republished",
      updatedAt: timestamp(clock),
    });
    resumeFromPhase = "restore:metadata_republished";
    await notifyFault(faultHook, "restore:metadata-republished");
  }

  // Steps 5-6: immutable receipt + append-only audit log, then clear the
  // journal. The receipt file's presence is the idempotency marker for this
  // tail — once written it is never rewritten, and a resume that finds it
  // already on disk skips straight to clearing the journal.
  if (!(await pathExists(receiptPath))) {
    const receipt: DataEpochRestoreReceipt = {
      schemaVersion: 1,
      restoreId,
      transitionId,
      fromEpoch,
      toEpoch,
      affectedStoreIds: [...affectedStoreIds],
      itemCount: metadata.items.length,
      totalBytes: metadata.items.reduce((sum, item) => sum + item.bytes, 0),
      checkpointDir,
      quarantineDir: quarantineRoot,
      restoredAt: timestamp(clock),
    };
    await fs.promises.mkdir(path.dirname(logPath), { recursive: true });
    await fs.promises.appendFile(logPath, `${JSON.stringify(receipt)}\n`, "utf8");
    await durableWriteJson(receiptPath, receipt);
  }
  await removeDataEpochJournal(homeDir);

  return {
    restoreId,
    transitionId,
    fromEpoch,
    toEpoch,
    affectedStoreIds: [...affectedStoreIds],
    quarantineDir: quarantineRoot,
    receiptPath,
  };
}
