"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DATA_EPOCH_STAMP_SCHEMA_VERSION = 2;
const DATA_EPOCH_JOURNAL_SCHEMA_VERSION = 1;
const DATA_EPOCH_JOURNAL_PHASES = Object.freeze([
  "prepared",
  "checkpoint_complete",
  "barrier_raised",
  "migrating",
  "migrated",
  "validated",
  "committed",
]);

function dataEpochStampPath(homeDir) {
  return path.join(homeDir, "data-epoch.json");
}

function dataEpochJournalPath(homeDir) {
  return path.join(homeDir, "data-epoch-transition.json");
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value >= 1;
}

function isTimestamp(value) {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function corrupt(filePath, detail) {
  return { status: "corrupt", filePath, detail };
}

function readJsonFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "missing", filePath };
    return corrupt(filePath, error instanceof Error ? error.message : String(error));
  }

  try {
    return { status: "present", filePath, value: JSON.parse(raw) };
  } catch (error) {
    return corrupt(filePath, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Reads both the legacy v1 high-water stamp and the v2 transition-aware
 * stamp. v1 had no schemaVersion and one `epoch` field; it maps to a fully
 * committed state at that epoch. v2 separates the minimum reader barrier
 * from the last epoch whose migration was committed.
 */
function readDataEpochStamp(homeDir) {
  const filePath = dataEpochStampPath(homeDir);
  const read = readJsonFile(filePath);
  if (read.status !== "present") return read;

  const value = read.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return corrupt(filePath, "stamp must be a JSON object");
  }

  if (value.schemaVersion === undefined) {
    if (!isPositiveInteger(value.epoch)) {
      return corrupt(filePath, "legacy stamp is missing a positive integer `epoch`");
    }
    if (value.lastVersion !== undefined && typeof value.lastVersion !== "string") {
      return corrupt(filePath, "legacy stamp has an invalid `lastVersion`");
    }
    if (value.updatedAt !== undefined && !isTimestamp(value.updatedAt)) {
      return corrupt(filePath, "legacy stamp has an invalid `updatedAt`");
    }
    return {
      status: "ok",
      filePath,
      format: "legacy-v1",
      stamp: {
        schemaVersion: 1,
        epoch: value.epoch,
        minimumReaderEpoch: value.epoch,
        committedDataEpoch: value.epoch,
        lastVersion: typeof value.lastVersion === "string" ? value.lastVersion : null,
        updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
      },
    };
  }

  if (value.schemaVersion !== DATA_EPOCH_STAMP_SCHEMA_VERSION) {
    return corrupt(filePath, `unsupported stamp schemaVersion: ${String(value.schemaVersion)}`);
  }
  if (!isPositiveInteger(value.epoch) || !isPositiveInteger(value.minimumReaderEpoch)) {
    return corrupt(filePath, "v2 stamp requires positive integer `epoch` and `minimumReaderEpoch`");
  }
  if (value.epoch !== value.minimumReaderEpoch) {
    return corrupt(filePath, "v2 stamp requires `epoch` to equal `minimumReaderEpoch`");
  }
  if (!isPositiveInteger(value.committedDataEpoch)) {
    return corrupt(filePath, "v2 stamp requires a positive integer `committedDataEpoch`");
  }
  if (value.committedDataEpoch > value.minimumReaderEpoch) {
    return corrupt(filePath, "v2 stamp cannot commit a higher epoch than its minimum reader barrier");
  }
  if (typeof value.lastVersion !== "string" || value.lastVersion.length === 0) {
    return corrupt(filePath, "v2 stamp requires a non-empty `lastVersion`");
  }
  if (!isTimestamp(value.updatedAt)) {
    return corrupt(filePath, "v2 stamp requires a valid `updatedAt`");
  }

  return {
    status: "ok",
    filePath,
    format: "v2",
    stamp: {
      schemaVersion: DATA_EPOCH_STAMP_SCHEMA_VERSION,
      epoch: value.epoch,
      minimumReaderEpoch: value.minimumReaderEpoch,
      committedDataEpoch: value.committedDataEpoch,
      lastVersion: value.lastVersion,
      updatedAt: value.updatedAt,
    },
  };
}

function readDataEpochJournal(homeDir) {
  const filePath = dataEpochJournalPath(homeDir);
  const read = readJsonFile(filePath);
  if (read.status !== "present") return read;

  const value = read.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return corrupt(filePath, "transition journal must be a JSON object");
  }
  if (value.schemaVersion !== DATA_EPOCH_JOURNAL_SCHEMA_VERSION) {
    return corrupt(filePath, `unsupported transition journal schemaVersion: ${String(value.schemaVersion)}`);
  }
  if (typeof value.transitionId !== "string" || value.transitionId.length === 0) {
    return corrupt(filePath, "transition journal requires a non-empty transitionId");
  }
  if (!isPositiveInteger(value.fromEpoch) || !isPositiveInteger(value.toEpoch) || value.fromEpoch >= value.toEpoch) {
    return corrupt(filePath, "transition journal requires fromEpoch < toEpoch");
  }
  if (!DATA_EPOCH_JOURNAL_PHASES.includes(value.phase)) {
    return corrupt(filePath, `transition journal has an invalid phase: ${String(value.phase)}`);
  }
  if (!Array.isArray(value.migrationIds)
    || value.migrationIds.length === 0
    || value.migrationIds.some((id) => typeof id !== "string" || id.length === 0)
    || new Set(value.migrationIds).size !== value.migrationIds.length) {
    return corrupt(filePath, "transition journal requires unique migrationIds");
  }
  if (!value.recoveryModes || typeof value.recoveryModes !== "object" || Array.isArray(value.recoveryModes)) {
    return corrupt(filePath, "transition journal requires recoveryModes");
  }
  const recoveryModeKeys = Object.keys(value.recoveryModes).sort();
  const migrationIds = [...value.migrationIds];
  if (JSON.stringify(recoveryModeKeys) !== JSON.stringify([...migrationIds].sort())
    || recoveryModeKeys.some((id) => !["resume-idempotent", "restore-only"].includes(value.recoveryModes[id]))) {
    return corrupt(filePath, "transition journal recoveryModes must exactly cover migrationIds");
  }
  if (!Array.isArray(value.affectedStoreIds)
    || value.affectedStoreIds.length === 0
    || value.affectedStoreIds.some((id) => typeof id !== "string" || id.length === 0)
    || new Set(value.affectedStoreIds).size !== value.affectedStoreIds.length) {
    return corrupt(filePath, "transition journal requires unique affectedStoreIds");
  }
  if (typeof value.lastVersion !== "string" || value.lastVersion.length === 0) {
    return corrupt(filePath, "transition journal requires a non-empty lastVersion");
  }
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)) {
    return corrupt(filePath, "transition journal requires valid timestamps");
  }
  const checkpointRequired = value.phase !== "prepared";
  if (checkpointRequired) {
    if (typeof value.checkpointId !== "string" || value.checkpointId.length === 0
      || !value.checkpointReceipt || typeof value.checkpointReceipt !== "object" || Array.isArray(value.checkpointReceipt)
      || value.checkpointReceipt.id !== value.checkpointId) {
      return corrupt(filePath, `transition journal phase ${value.phase} requires a checkpoint receipt`);
    }
  } else if (value.checkpointId !== null || value.checkpointReceipt !== null) {
    return corrupt(filePath, "prepared transition journal must not claim a completed checkpoint");
  }

  return {
    status: "ok",
    filePath,
    journal: {
      schemaVersion: DATA_EPOCH_JOURNAL_SCHEMA_VERSION,
      transitionId: value.transitionId,
      fromEpoch: value.fromEpoch,
      toEpoch: value.toEpoch,
      migrationIds,
      phase: value.phase,
      recoveryModes: { ...value.recoveryModes },
      lastVersion: value.lastVersion,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      affectedStoreIds: [...value.affectedStoreIds],
      checkpointId: value.checkpointId,
      checkpointReceipt: value.checkpointReceipt,
    },
  };
}

async function syncParentDirectory(filePath) {
  // Windows does not expose a portable directory-fsync contract. The file
  // itself is still fsynced before atomic rename; on POSIX we additionally
  // fsync the parent directory so the rename survives a power loss.
  if (process.platform === "win32") return;
  const handle = await fs.promises.open(path.dirname(filePath), "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function durableWriteJson(filePath, value) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  let handle = null;
  try {
    handle = await fs.promises.open(temporaryPath, "wx");
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temporaryPath, filePath);
    await syncParentDirectory(filePath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

function createDataEpochStamp({ minimumReaderEpoch, committedDataEpoch, lastVersion, updatedAt = new Date().toISOString() }) {
  if (!isPositiveInteger(minimumReaderEpoch) || !isPositiveInteger(committedDataEpoch)) {
    throw new Error("data epoch stamp requires positive integer epochs");
  }
  if (committedDataEpoch > minimumReaderEpoch) {
    throw new Error("committedDataEpoch cannot exceed minimumReaderEpoch");
  }
  if (typeof lastVersion !== "string" || lastVersion.length === 0) {
    throw new Error("data epoch stamp requires lastVersion");
  }
  if (!isTimestamp(updatedAt)) throw new Error("data epoch stamp requires a valid updatedAt timestamp");
  return {
    schemaVersion: DATA_EPOCH_STAMP_SCHEMA_VERSION,
    epoch: minimumReaderEpoch,
    minimumReaderEpoch,
    committedDataEpoch,
    lastVersion,
    updatedAt,
  };
}

async function writeDataEpochStamp(homeDir, input) {
  const stamp = createDataEpochStamp(input);
  await durableWriteJson(dataEpochStampPath(homeDir), stamp);
  return stamp;
}

function createDataEpochJournal(input) {
  const now = input.updatedAt ?? new Date().toISOString();
  const journal = {
    schemaVersion: DATA_EPOCH_JOURNAL_SCHEMA_VERSION,
    transitionId: input.transitionId,
    fromEpoch: input.fromEpoch,
    toEpoch: input.toEpoch,
    migrationIds: [...input.migrationIds],
    affectedStoreIds: [...input.affectedStoreIds],
    recoveryModes: { ...input.recoveryModes },
    phase: input.phase,
    checkpointId: input.checkpointId ?? null,
    checkpointReceipt: input.checkpointReceipt ?? null,
    createdAt: input.createdAt ?? now,
    updatedAt: now,
    lastVersion: input.lastVersion,
  };
  const validation = readJournalValueForValidation(journal);
  if (validation !== null) throw new Error(validation);
  return journal;
}

function readJournalValueForValidation(value) {
  if (typeof value.transitionId !== "string" || value.transitionId.length === 0) return "transition journal requires transitionId";
  if (!isPositiveInteger(value.fromEpoch) || !isPositiveInteger(value.toEpoch) || value.fromEpoch >= value.toEpoch) {
    return "transition journal requires fromEpoch < toEpoch";
  }
  if (!DATA_EPOCH_JOURNAL_PHASES.includes(value.phase)) return `invalid transition journal phase: ${String(value.phase)}`;
  if (!Array.isArray(value.migrationIds) || value.migrationIds.length === 0
    || value.migrationIds.some((id) => typeof id !== "string" || id.length === 0)
    || new Set(value.migrationIds).size !== value.migrationIds.length) {
    return "transition journal requires unique migrationIds";
  }
  if (!Array.isArray(value.affectedStoreIds) || value.affectedStoreIds.length === 0
    || value.affectedStoreIds.some((id) => typeof id !== "string" || id.length === 0)
    || new Set(value.affectedStoreIds).size !== value.affectedStoreIds.length) {
    return "transition journal requires unique affectedStoreIds";
  }
  if (!value.recoveryModes || typeof value.recoveryModes !== "object" || Array.isArray(value.recoveryModes)
    || JSON.stringify(Object.keys(value.recoveryModes).sort()) !== JSON.stringify([...value.migrationIds].sort())
    || Object.values(value.recoveryModes).some((mode) => mode !== "resume-idempotent" && mode !== "restore-only")) {
    return "transition journal recoveryModes must exactly cover migrationIds";
  }
  if (typeof value.lastVersion !== "string" || value.lastVersion.length === 0) return "transition journal requires lastVersion";
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)) return "transition journal requires valid timestamps";
  if (value.phase === "prepared" && (value.checkpointId !== null || value.checkpointReceipt !== null)) {
    return "prepared transition journal cannot contain a checkpoint";
  }
  if (value.phase !== "prepared"
    && (typeof value.checkpointId !== "string" || value.checkpointId.length === 0
      || !value.checkpointReceipt || typeof value.checkpointReceipt !== "object" || Array.isArray(value.checkpointReceipt)
      || value.checkpointReceipt.id !== value.checkpointId)) {
    return `transition journal phase ${value.phase} requires a checkpoint receipt`;
  }
  return null;
}

async function writeDataEpochJournal(homeDir, input) {
  const journal = createDataEpochJournal(input);
  await durableWriteJson(dataEpochJournalPath(homeDir), journal);
  return journal;
}

async function removeDataEpochJournal(homeDir) {
  const filePath = dataEpochJournalPath(homeDir);
  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  await syncParentDirectory(filePath);
  return true;
}

// ---------------------------------------------------------------------------
// Restore journal + guarded stamp republish.
//
// A restore is the only path in this codebase allowed to lower the epoch
// stamp. It writes its own journal shape to the SAME on-disk path as the
// forward transition journal (dataEpochJournalPath) but under a distinct
// `kind`/`restoreSchemaVersion` pair that deliberately does not satisfy
// readDataEpochJournal's schema — any kernel (old or new) that inspects the
// journal through the forward reader sees `status: "corrupt"` and fails
// closed, exactly the same way it already fails closed on any other
// unrecognized journal shape (see "rejects malformed or unknown journal
// phases instead of guessing" in tests/data-epoch.test.ts). That is
// intentional: while a restore is mid-flight, ordinary startup must refuse
// rather than guess. Only core/data-epoch-restore.ts, reading through
// readDataEpochRestoreJournal, understands this shape and can resume or
// complete it.
// ---------------------------------------------------------------------------

const DATA_EPOCH_RESTORE_JOURNAL_SCHEMA_VERSION = 1;
const DATA_EPOCH_RESTORE_JOURNAL_PHASES = Object.freeze([
  "restore:starting",
  "restore:stores_restored",
  "restore:metadata_republished",
]);

function restoreJournalValidationProblem(value) {
  if (value.kind !== "restore") return 'restore journal requires kind "restore"';
  if (value.restoreSchemaVersion !== DATA_EPOCH_RESTORE_JOURNAL_SCHEMA_VERSION) {
    return `unsupported restore journal restoreSchemaVersion: ${String(value.restoreSchemaVersion)}`;
  }
  if (typeof value.restoreId !== "string" || value.restoreId.length === 0) {
    return "restore journal requires a non-empty restoreId";
  }
  if (typeof value.transitionId !== "string" || value.transitionId.length === 0) {
    return "restore journal requires a non-empty transitionId";
  }
  if (!isPositiveInteger(value.fromEpoch)) {
    return "restore journal requires a positive integer fromEpoch";
  }
  if (!DATA_EPOCH_RESTORE_JOURNAL_PHASES.includes(value.phase)) {
    return `invalid restore journal phase: ${String(value.phase)}`;
  }
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)) {
    return "restore journal requires valid timestamps";
  }
  return null;
}

/**
 * Reads the on-disk transition journal as a restore-phase journal. This is a
 * distinct shape from readDataEpochJournal's forward-transition journal even
 * though both live at dataEpochJournalPath — a file holding a forward
 * journal (or anything else that isn't a restore journal) reads back here as
 * `status: "corrupt"`, the mirror image of how a restore journal reads back
 * as `status: "corrupt"` through readDataEpochJournal. Callers that need to
 * tell "genuinely corrupt" apart from "it's the other kind of journal" must
 * consult both readers, exactly as core/data-epoch-restore.ts does.
 */
function readDataEpochRestoreJournal(homeDir) {
  const filePath = dataEpochJournalPath(homeDir);
  const read = readJsonFile(filePath);
  if (read.status !== "present") return read;

  const value = read.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return corrupt(filePath, "transition journal must be a JSON object");
  }
  const problem = restoreJournalValidationProblem(value);
  if (problem !== null) return corrupt(filePath, problem);

  return {
    status: "ok",
    filePath,
    journal: {
      kind: "restore",
      restoreSchemaVersion: DATA_EPOCH_RESTORE_JOURNAL_SCHEMA_VERSION,
      restoreId: value.restoreId,
      transitionId: value.transitionId,
      fromEpoch: value.fromEpoch,
      phase: value.phase,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    },
  };
}

function createDataEpochRestoreJournal(input) {
  const now = input.updatedAt ?? new Date().toISOString();
  const journal = {
    kind: "restore",
    restoreSchemaVersion: DATA_EPOCH_RESTORE_JOURNAL_SCHEMA_VERSION,
    restoreId: input.restoreId,
    transitionId: input.transitionId,
    fromEpoch: input.fromEpoch,
    phase: input.phase,
    createdAt: input.createdAt ?? now,
    updatedAt: now,
  };
  const problem = restoreJournalValidationProblem(journal);
  if (problem !== null) throw new Error(problem);
  return journal;
}

async function writeDataEpochRestoreJournal(homeDir, input) {
  const journal = createDataEpochRestoreJournal(input);
  await durableWriteJson(dataEpochJournalPath(homeDir), journal);
  return journal;
}

/**
 * The sole channel in this codebase allowed to write a lower epoch stamp.
 * Every other write path (writeDataEpochStamp, and the coordinator's
 * --allow-data-downgrade override, which only ever *accepts* an existing
 * lower stamp — it never writes one) can only hold or raise the stamp. This
 * function's hard precondition is proof, read fresh off disk, that a restore
 * transaction which has already finished restoring store bytes is in
 * progress; without that journal in place it throws and writes nothing.
 */
async function republishDataEpochStampForRestore({ homeDir, fromEpoch, lastVersion, updatedAt } = {}) {
  const restoreJournalRead = readDataEpochRestoreJournal(homeDir);
  const restorePhasesAllowingRepublish = ["restore:stores_restored", "restore:metadata_republished"];
  if (restoreJournalRead.status !== "ok" || !restorePhasesAllowingRepublish.includes(restoreJournalRead.journal.phase)) {
    throw new Error(
      "republishDataEpochStampForRestore requires an on-disk restore journal that has finished restoring store "
      + "bytes; this is the only channel allowed to lower the data epoch stamp",
    );
  }
  if (restoreJournalRead.journal.fromEpoch !== fromEpoch) {
    throw new Error(
      `republishDataEpochStampForRestore: the restore journal targets fromEpoch=${restoreJournalRead.journal.fromEpoch}, `
      + `but was called with fromEpoch=${String(fromEpoch)}`,
    );
  }
  const stamp = createDataEpochStamp({ minimumReaderEpoch: fromEpoch, committedDataEpoch: fromEpoch, lastVersion, updatedAt });
  await durableWriteJson(dataEpochStampPath(homeDir), stamp);
  return stamp;
}

function describeDataEpochBlock({ stampEpoch, ownEpoch, stampLastVersion }) {
  const lastVersionNote = stampLastVersion ? ` (last opened by version ${stampLastVersion})` : "";
  return (
    `此数据目录要求数据 epoch=${stampEpoch} 或更高版本的内核${lastVersionNote}，本内核 epoch=${ownEpoch}。`
    + `继续使用旧内核可能静默损坏数据。请升级到较新版本，或在确认风险后设置 `
    + `LUC_ALLOW_DATA_DOWNGRADE=1（或对 luc serve 传 --allow-data-downgrade）。\n`
    + `This data directory requires a kernel at data epoch=${stampEpoch} or newer${lastVersionNote}; `
    + `this kernel is epoch=${ownEpoch}. Continuing with an older kernel risks silent corruption. `
    + `Upgrade, or explicitly accept the risk with LUC_ALLOW_DATA_DOWNGRADE=1 `
    + `(or --allow-data-downgrade for luc serve).`
  );
}

module.exports = {
  DATA_EPOCH_STAMP_SCHEMA_VERSION,
  DATA_EPOCH_JOURNAL_SCHEMA_VERSION,
  DATA_EPOCH_JOURNAL_PHASES,
  dataEpochStampPath,
  dataEpochJournalPath,
  readDataEpochStamp,
  readDataEpochJournal,
  durableWriteJson,
  createDataEpochStamp,
  writeDataEpochStamp,
  createDataEpochJournal,
  writeDataEpochJournal,
  removeDataEpochJournal,
  describeDataEpochBlock,
  DATA_EPOCH_RESTORE_JOURNAL_SCHEMA_VERSION,
  DATA_EPOCH_RESTORE_JOURNAL_PHASES,
  readDataEpochRestoreJournal,
  createDataEpochRestoreJournal,
  writeDataEpochRestoreJournal,
  republishDataEpochStampForRestore,
};
