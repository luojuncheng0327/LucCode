import crypto from "crypto";
import fs from "fs";
import path from "path";
import {
  dataEpochJournalPath,
  dataEpochStampPath,
  describeDataEpochBlock,
  readDataEpochJournal,
  readDataEpochStamp,
  removeDataEpochJournal,
  writeDataEpochJournal,
  writeDataEpochStamp,
  type DataEpochJournal,
  type DataEpochStamp,
} from "../shared/data-epoch.cjs";
import { FUTURE_EPOCH_COORDINATOR_PHASE, startupPhaseIndex } from "../shared/persistence/startup-phases.ts";
import { PERSISTENT_STORES } from "../shared/persistence/store-registry.ts";
import type { StoreDescriptor } from "../shared/persistence/store-registry-types.ts";
import {
  DATA_EPOCH_BREAKING_REVIEWS,
  DATA_EPOCH_MIGRATIONS,
  resolveDataEpochMigrationPath,
  type DataEpochBreakingReview,
  type DataEpochMigration,
  type DataEpochMigrationContext,
  type DataEpochRecoveryMode,
  type ResolvedDataEpochMigrationPath,
} from "./data-epoch-migrations.ts";

export interface DataEpochCheckpointProvider {
  create(input: {
    homeDir: string;
    fromEpoch: number;
    toEpoch: number;
    transitionId: string;
    affectedStoreIds: readonly string[];
  }): Promise<{ id: string; [key: string]: unknown }>;
  verify(checkpoint: { id: string; [key: string]: unknown }): Promise<void>;
}

export type DataEpochFaultEvent =
  | "journal:prepared"
  | "checkpoint:starting"
  | "checkpoint:created"
  | "checkpoint:verified"
  | "journal:checkpoint_complete"
  | "stamp:barrier"
  | "journal:barrier_raised"
  | "journal:migrating"
  | `migration:${string}:before`
  | `migration:${string}:after`
  | "journal:migrated"
  | `validation:${string}:before`
  | `validation:${string}:after`
  | "journal:validated"
  | "stamp:committed"
  | "journal:committed"
  | "journal:remove-starting"
  | "journal:removed";

type DataEpochFailureReason =
  | "corrupt-journal"
  | "corrupt-stamp"
  | "corrupt-transition"
  | "ambiguous-unstamped-home"
  | "incomplete-transition"
  | "inconsistent-transition-state"
  | "epoch-downgrade-blocked"
  | "migration-path-unavailable"
  | "migration-contract-invalid"
  | "checkpoint-provider-unavailable"
  | "transition-preflight-failed"
  | "transition-failed";

export type DataEpochStartupResult =
  | {
      allowed: true;
      action: "stamped-new" | "adopted-legacy" | "steady" | "refreshed" | "downgrade-allowed" | "transition-committed" | "committed-tail-cleaned";
      minimumReaderEpoch: number;
      committedDataEpoch: number;
      stampPath: string;
    }
  | {
      allowed: false;
      reason: DataEpochFailureReason;
      detail: string;
      stampPath: string;
      journalPath: string;
      stampEpoch?: number;
      ownEpoch?: number;
      stampLastVersion?: string | null;
      fromEpoch?: number;
      toEpoch?: number;
      phase?: string;
      transitionId?: string;
    };

export type DataEpochMaintenanceContinuation =
  | "continue-before-migration"
  | "resume-idempotent"
  | "restore-only"
  | "commit-validated"
  | "finalize-committed-tail";

export type DataEpochMaintenanceInspection =
  | { status: "none" }
  | { status: "corrupt"; reason: "corrupt-journal" | "corrupt-stamp" | "corrupt-transition" | "inconsistent-transition-state"; detail: string }
  | {
      status: "incomplete";
      transitionId: string;
      fromEpoch: number;
      toEpoch: number;
      phase: DataEpochJournal["phase"];
      checkpointId: string | null;
      affectedStoreIds: string[];
      recoveryModes: Record<string, DataEpochRecoveryMode>;
      continuation: DataEpochMaintenanceContinuation;
    };

export type UnstampedHomeClassification =
  | { classification: "provably-new"; detail: string }
  | { classification: "legacy-baseline"; detail: string }
  | { classification: "ambiguous"; detail: string };

interface BootstrapSafePath {
  relativePath: string;
  kind: "file" | "tree";
}

function toPosix(value: string) {
  return value.split(path.sep).join("/");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
}

function timestamp(clock: (() => Date | string) | undefined) {
  const value = clock?.() ?? new Date();
  const result = value instanceof Date ? value.toISOString() : value;
  if (typeof result !== "string" || Number.isNaN(Date.parse(result))) {
    throw new Error("data epoch clock returned an invalid timestamp");
  }
  return result;
}

function bootstrapSafePaths(stores: readonly StoreDescriptor[]): BootstrapSafePath[] {
  return stores.flatMap((store) => {
    if (!store.bootstrapSafety || store.firstPossibleWritePhase !== "desktop_bootstrap") return [];
    return store.bootstrapSafety.unstampedHomeSafePaths
      .map((entry) => ({ relativePath: toPosix(entry.relativePath), kind: entry.kind }));
  });
}

function classifyRelativePath(relativePath: string, isDirectory: boolean, safePaths: readonly BootstrapSafePath[]) {
  for (const safe of safePaths) {
    if (relativePath === safe.relativePath) {
      const typeMatches = safe.kind === "tree" ? isDirectory : !isDirectory;
      return typeMatches ? "safe" : "unknown";
    }
    if (safe.kind === "tree" && relativePath.startsWith(`${safe.relativePath}/`)) return "safe";
    if (isDirectory && safe.relativePath.startsWith(`${relativePath}/`)) return "safe-ancestor";
  }
  return "unknown";
}

export function classifyUnstampedDataHome(
  homeDir: string,
  stores: readonly StoreDescriptor[] = PERSISTENT_STORES,
): UnstampedHomeClassification {
  const safePaths = bootstrapSafePaths(stores);
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(homeDir);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return { classification: "provably-new", detail: "data home does not exist" };
    return { classification: "ambiguous", detail: `cannot inspect data home: ${errorMessage(error)}` };
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return { classification: "ambiguous", detail: "data home is not a real directory" };
  }

  const pending = [homeDir];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error: unknown) {
      return { classification: "ambiguous", detail: `cannot inspect ${toPosix(path.relative(homeDir, directory)) || "."}: ${errorMessage(error)}` };
    }

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = toPosix(path.relative(homeDir, absolutePath));
      if (entry.isSymbolicLink()) {
        return { classification: "ambiguous", detail: `symbolic link found in unstamped home: ${relativePath}` };
      }
      if (/^data-epoch(?:-transition)?[.]json[.]tmp-/.test(entry.name)) {
        return { classification: "ambiguous", detail: `interrupted epoch metadata write found: ${relativePath}` };
      }
      const isDirectory = entry.isDirectory();
      const ownership = classifyRelativePath(relativePath, isDirectory, safePaths);
      if (ownership === "unknown") {
        if (entry.isDirectory() || entry.isFile()) {
          return { classification: "legacy-baseline", detail: `legacy application data found: ${relativePath}` };
        }
        return { classification: "ambiguous", detail: `special filesystem entry found: ${relativePath}` };
      }
      if (isDirectory) pending.push(absolutePath);
    }
  }

  return { classification: "provably-new", detail: "home is empty or contains only epoch-independent desktop bootstrap state" };
}

function failure(
  homeDir: string,
  reason: DataEpochFailureReason,
  detail: string,
  extra: Omit<Extract<DataEpochStartupResult, { allowed: false }>, "allowed" | "reason" | "detail" | "stampPath" | "journalPath"> = {},
): Extract<DataEpochStartupResult, { allowed: false }> {
  return {
    allowed: false,
    reason,
    detail,
    stampPath: dataEpochStampPath(homeDir),
    journalPath: dataEpochJournalPath(homeDir),
    ...extra,
  };
}

function validateAffectedStores(pathPlan: ResolvedDataEpochMigrationPath, stores: readonly StoreDescriptor[]) {
  const byId = new Map(stores.map((store) => [store.id, store]));
  const coordinatorIndex = startupPhaseIndex(FUTURE_EPOCH_COORDINATOR_PHASE);
  for (const storeId of pathPlan.affectedStoreIds) {
    const store = byId.get(storeId);
    if (!store) throw new Error(`data epoch migration references unknown store: ${storeId}`);
    if (!store.affectedByEpochMigration) {
      throw new Error(`data epoch migration references non-epoch-managed store: ${storeId}`);
    }
    if (startupPhaseIndex(store.firstPossibleWritePhase) < coordinatorIndex) {
      throw new Error(`data epoch migration store writes before ${FUTURE_EPOCH_COORDINATOR_PHASE}: ${storeId}`);
    }
    if (!store.checkpointPolicy.trim() || !store.restorePolicy.trim()) {
      throw new Error(`data epoch migration store lacks checkpoint or restore policy: ${storeId}`);
    }
    if (store.preCoordinatorReadProjection) {
      const migrations = pathPlan.steps.filter((migration) => migration.affectedStoreIds.includes(storeId));
      if (migrations.some((migration) => migration.preCoordinatorReadCompatibility !== "preserved")) {
        throw new Error(`data epoch migration must preserve the pre-coordinator read projection for store: ${storeId}`);
      }
    }
  }
}

function checkpointReceipt(value: unknown): { id: string; [key: string]: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof (value as { id?: unknown }).id !== "string" || (value as { id: string }).id.length === 0) {
    throw new Error("epoch checkpoint provider returned an invalid receipt");
  }
  return value as { id: string; [key: string]: unknown };
}

async function notifyFault(
  hook: ((event: DataEpochFaultEvent) => Promise<void> | void) | undefined,
  event: DataEpochFaultEvent,
) {
  if (hook) await hook(event);
}

function stampState(stamp: DataEpochStamp) {
  return `${stamp.minimumReaderEpoch}/${stamp.committedDataEpoch}`;
}

function transitionConsistency(
  journal: DataEpochJournal,
  stampRead: ReturnType<typeof readDataEpochStamp>,
): { valid: true; targetCommitted: boolean } | { valid: false; detail: string } {
  if (stampRead.status === "corrupt") return { valid: false, detail: `stamp is corrupt: ${stampRead.detail}` };
  const sourceSteady = stampRead.status === "ok"
    && stampRead.stamp.minimumReaderEpoch === journal.fromEpoch
    && stampRead.stamp.committedDataEpoch === journal.fromEpoch;
  const barrierRaised = stampRead.status === "ok"
    && stampRead.stamp.minimumReaderEpoch === journal.toEpoch
    && stampRead.stamp.committedDataEpoch === journal.fromEpoch;
  const targetCommitted = stampRead.status === "ok"
    && stampRead.stamp.minimumReaderEpoch === journal.toEpoch
    && stampRead.stamp.committedDataEpoch === journal.toEpoch;

  let valid = false;
  if (journal.phase === "prepared") valid = stampRead.status === "missing" || sourceSteady;
  else if (journal.phase === "checkpoint_complete") valid = stampRead.status === "missing" || sourceSteady || barrierRaised;
  else if (journal.phase === "committed") valid = targetCommitted;
  else if (journal.phase === "validated") valid = barrierRaised || targetCommitted;
  else valid = barrierRaised;

  if (!valid) {
    const actual = stampRead.status === "missing" ? "missing" : stampState(stampRead.stamp);
    return { valid: false, detail: `journal phase ${journal.phase} contradicts stamp state ${actual}` };
  }
  return { valid: true, targetCommitted };
}

export function inspectDataEpochMaintenance(homeDir: string): DataEpochMaintenanceInspection {
  const journalRead = readDataEpochJournal(homeDir);
  if (journalRead.status === "corrupt") {
    return { status: "corrupt", reason: "corrupt-journal", detail: journalRead.detail };
  }
  const stampRead = readDataEpochStamp(homeDir);
  if (stampRead.status === "corrupt") {
    return { status: "corrupt", reason: "corrupt-stamp", detail: stampRead.detail };
  }
  if (journalRead.status === "missing") {
    if (stampRead.status === "ok" && stampRead.stamp.minimumReaderEpoch !== stampRead.stamp.committedDataEpoch) {
      return {
        status: "corrupt",
        reason: "inconsistent-transition-state",
        detail: "stamp has an uncommitted reader barrier but no transition journal",
      };
    }
    return { status: "none" };
  }

  const journal = journalRead.journal;
  const consistency = transitionConsistency(journal, stampRead);
  if ("detail" in consistency) {
    return { status: "corrupt", reason: "corrupt-transition", detail: consistency.detail };
  }
  const allResumable = Object.values(journal.recoveryModes).every((mode) => mode === "resume-idempotent");
  let continuation: DataEpochMaintenanceContinuation;
  if (consistency.targetCommitted) continuation = "finalize-committed-tail";
  else if (journal.phase === "validated") continuation = "commit-validated";
  else if (journal.phase === "prepared" || journal.phase === "checkpoint_complete") continuation = "continue-before-migration";
  else continuation = allResumable ? "resume-idempotent" : "restore-only";

  return {
    status: "incomplete",
    transitionId: journal.transitionId,
    fromEpoch: journal.fromEpoch,
    toEpoch: journal.toEpoch,
    phase: journal.phase,
    checkpointId: journal.checkpointId,
    affectedStoreIds: [...journal.affectedStoreIds],
    recoveryModes: { ...journal.recoveryModes },
    continuation,
  };
}

async function transitionDataEpoch(args: {
  homeDir: string;
  fromEpoch: number;
  toEpoch: number;
  ownVersion: string;
  migrations: readonly DataEpochMigration[];
  breakingReviews: readonly DataEpochBreakingReview[];
  stores: readonly StoreDescriptor[];
  checkpointProvider?: DataEpochCheckpointProvider;
  faultHook?: (event: DataEpochFaultEvent) => Promise<void> | void;
  clock?: () => Date | string;
  transitionIdFactory?: () => string;
}): Promise<DataEpochStartupResult> {
  const {
    homeDir,
    fromEpoch,
    toEpoch,
    ownVersion,
    migrations,
    breakingReviews,
    stores,
    checkpointProvider,
    faultHook,
    clock,
    transitionIdFactory = () => crypto.randomUUID(),
  } = args;

  let pathPlan: ResolvedDataEpochMigrationPath;
  try {
    pathPlan = resolveDataEpochMigrationPath(fromEpoch, toEpoch, migrations, breakingReviews);
  } catch (error: unknown) {
    return failure(homeDir, "migration-path-unavailable", errorMessage(error), { fromEpoch, toEpoch });
  }
  try {
    validateAffectedStores(pathPlan, stores);
  } catch (error: unknown) {
    return failure(homeDir, "migration-contract-invalid", errorMessage(error), { fromEpoch, toEpoch });
  }
  if (!checkpointProvider) {
    return failure(homeDir, "checkpoint-provider-unavailable", "data epoch transition requires a checkpoint provider", { fromEpoch, toEpoch });
  }
  try {
    for (const migration of pathPlan.steps) {
      await migration.preflight?.({ homeDir, fromEpoch, toEpoch });
    }
  } catch (error: unknown) {
    return failure(homeDir, "transition-preflight-failed", errorMessage(error), { fromEpoch, toEpoch });
  }

  let transitionId: string;
  let createdAt: string;
  try {
    transitionId = transitionIdFactory();
    if (typeof transitionId !== "string" || transitionId.length === 0) {
      throw new Error("transitionIdFactory returned an invalid transition id");
    }
    createdAt = timestamp(clock);
  } catch (error: unknown) {
    return failure(homeDir, "migration-contract-invalid", errorMessage(error), { fromEpoch, toEpoch });
  }
  let checkpoint: { id: string; [key: string]: unknown } | null = null;
  const writeJournal = async (phase: DataEpochJournal["phase"]) => writeDataEpochJournal(homeDir, {
    transitionId,
    fromEpoch,
    toEpoch,
    migrationIds: pathPlan.migrationIds,
    affectedStoreIds: pathPlan.affectedStoreIds,
    recoveryModes: pathPlan.recoveryModes,
    phase,
    checkpointId: checkpoint?.id ?? null,
    checkpointReceipt: checkpoint,
    createdAt,
    updatedAt: timestamp(clock),
    lastVersion: ownVersion,
  });

  try {
    await writeJournal("prepared");
    await notifyFault(faultHook, "journal:prepared");

    await notifyFault(faultHook, "checkpoint:starting");
    checkpoint = checkpointReceipt(await checkpointProvider.create({
      homeDir,
      fromEpoch,
      toEpoch,
      transitionId,
      affectedStoreIds: pathPlan.affectedStoreIds,
    }));
    await notifyFault(faultHook, "checkpoint:created");
    await checkpointProvider.verify(checkpoint);
    await notifyFault(faultHook, "checkpoint:verified");

    await writeJournal("checkpoint_complete");
    await notifyFault(faultHook, "journal:checkpoint_complete");
    await writeDataEpochStamp(homeDir, {
      minimumReaderEpoch: toEpoch,
      committedDataEpoch: fromEpoch,
      lastVersion: ownVersion,
      updatedAt: timestamp(clock),
    });
    await notifyFault(faultHook, "stamp:barrier");

    await writeJournal("barrier_raised");
    await notifyFault(faultHook, "journal:barrier_raised");
    await writeJournal("migrating");
    await notifyFault(faultHook, "journal:migrating");

    const migrationContext: DataEpochMigrationContext = {
      homeDir,
      fromEpoch,
      toEpoch,
      checkpoint,
    };
    for (const migration of pathPlan.steps) {
      await notifyFault(faultHook, `migration:${migration.id}:before`);
      await migration.migrate(migrationContext);
      await notifyFault(faultHook, `migration:${migration.id}:after`);
    }

    await writeJournal("migrated");
    await notifyFault(faultHook, "journal:migrated");
    for (const migration of pathPlan.steps) {
      await notifyFault(faultHook, `validation:${migration.id}:before`);
      await migration.validate(migrationContext);
      await notifyFault(faultHook, `validation:${migration.id}:after`);
    }
    await writeJournal("validated");
    await notifyFault(faultHook, "journal:validated");

    await writeDataEpochStamp(homeDir, {
      minimumReaderEpoch: toEpoch,
      committedDataEpoch: toEpoch,
      lastVersion: ownVersion,
      updatedAt: timestamp(clock),
    });
    await notifyFault(faultHook, "stamp:committed");
    await writeJournal("committed");
    await notifyFault(faultHook, "journal:committed");
    await notifyFault(faultHook, "journal:remove-starting");
    await removeDataEpochJournal(homeDir);
    await notifyFault(faultHook, "journal:removed");

    return {
      allowed: true,
      action: "transition-committed",
      minimumReaderEpoch: toEpoch,
      committedDataEpoch: toEpoch,
      stampPath: dataEpochStampPath(homeDir),
    };
  } catch (error: unknown) {
    return failure(homeDir, "transition-failed", errorMessage(error), {
      fromEpoch,
      toEpoch,
      transitionId,
    });
  }
}

export async function coordinateDataEpochStartup(args: {
  homeDir: string;
  ownEpoch: number;
  ownVersion: string;
  allowDowngrade?: boolean;
  log?: { warn: (message: string) => void };
  migrations?: readonly DataEpochMigration[];
  breakingReviews?: readonly DataEpochBreakingReview[];
  stores?: readonly StoreDescriptor[];
  checkpointProvider?: DataEpochCheckpointProvider;
  faultHook?: (event: DataEpochFaultEvent) => Promise<void> | void;
  clock?: () => Date | string;
  transitionIdFactory?: () => string;
}): Promise<DataEpochStartupResult> {
  const {
    homeDir,
    ownEpoch,
    ownVersion,
    allowDowngrade = false,
    log = console,
    migrations = DATA_EPOCH_MIGRATIONS,
    breakingReviews = DATA_EPOCH_BREAKING_REVIEWS,
    stores = PERSISTENT_STORES,
    checkpointProvider,
    faultHook,
    clock,
    transitionIdFactory,
  } = args;
  if (!Number.isInteger(ownEpoch) || ownEpoch < 1) throw new Error("ownEpoch must be a positive integer");
  if (typeof ownVersion !== "string" || ownVersion.length === 0) throw new Error("ownVersion is required");

  // Journal-first is deliberate: an override may accept a steady-state
  // reader downgrade, but it must never bypass evidence of a partial write.
  const maintenance = inspectDataEpochMaintenance(homeDir);
  if (maintenance.status === "corrupt") {
    return failure(homeDir, maintenance.reason, maintenance.detail);
  }
  if (maintenance.status === "incomplete") {
    if (maintenance.continuation === "finalize-committed-tail" && ownEpoch >= maintenance.toEpoch) {
      try {
        await notifyFault(faultHook, "journal:remove-starting");
        await removeDataEpochJournal(homeDir);
        await notifyFault(faultHook, "journal:removed");
      } catch (error: unknown) {
        return failure(homeDir, "transition-failed", errorMessage(error), {
          fromEpoch: maintenance.fromEpoch,
          toEpoch: maintenance.toEpoch,
          phase: maintenance.phase,
          transitionId: maintenance.transitionId,
        });
      }
      if (ownEpoch > maintenance.toEpoch) {
        return coordinateDataEpochStartup(args);
      }
      return {
        allowed: true,
        action: "committed-tail-cleaned",
        minimumReaderEpoch: maintenance.toEpoch,
        committedDataEpoch: maintenance.toEpoch,
        stampPath: dataEpochStampPath(homeDir),
      };
    }
    return failure(homeDir, "incomplete-transition", `transition is stopped at phase ${maintenance.phase}`, {
      fromEpoch: maintenance.fromEpoch,
      toEpoch: maintenance.toEpoch,
      phase: maintenance.phase,
      transitionId: maintenance.transitionId,
    });
  }

  const stampRead = readDataEpochStamp(homeDir);
  if (stampRead.status === "corrupt") return failure(homeDir, "corrupt-stamp", stampRead.detail);

  if (stampRead.status === "missing") {
    const classification = classifyUnstampedDataHome(homeDir, stores);
    if (classification.classification === "ambiguous") {
      return failure(homeDir, "ambiguous-unstamped-home", classification.detail);
    }
    if (classification.classification === "provably-new") {
      await writeDataEpochStamp(homeDir, {
        minimumReaderEpoch: ownEpoch,
        committedDataEpoch: ownEpoch,
        lastVersion: ownVersion,
        updatedAt: timestamp(clock),
      });
      return {
        allowed: true,
        action: "stamped-new",
        minimumReaderEpoch: ownEpoch,
        committedDataEpoch: ownEpoch,
        stampPath: dataEpochStampPath(homeDir),
      };
    }
    if (ownEpoch === 1) {
      await writeDataEpochStamp(homeDir, {
        minimumReaderEpoch: 1,
        committedDataEpoch: 1,
        lastVersion: ownVersion,
        updatedAt: timestamp(clock),
      });
      return {
        allowed: true,
        action: "adopted-legacy",
        minimumReaderEpoch: 1,
        committedDataEpoch: 1,
        stampPath: dataEpochStampPath(homeDir),
      };
    }
    return transitionDataEpoch({
      homeDir,
      fromEpoch: 1,
      toEpoch: ownEpoch,
      ownVersion,
      migrations,
      breakingReviews,
      stores,
      checkpointProvider,
      faultHook,
      clock,
      transitionIdFactory,
    });
  }

  const stamp = stampRead.stamp;
  if (stamp.minimumReaderEpoch > ownEpoch) {
    if (!allowDowngrade) {
      return failure(homeDir, "epoch-downgrade-blocked", "this kernel is below the minimum reader epoch", {
        stampEpoch: stamp.minimumReaderEpoch,
        ownEpoch,
        stampLastVersion: stamp.lastVersion,
      });
    }
    log.warn(
      `[data-epoch] WARNING: opening minimum reader epoch ${stamp.minimumReaderEpoch} with kernel epoch ${ownEpoch}; `
      + `the explicit downgrade override accepts possible data corruption. `
      + `警告：正在用 epoch=${ownEpoch} 的旧内核打开最低读取要求为 epoch=${stamp.minimumReaderEpoch} 的数据目录，`
      + `显式降级覆盖已接受潜在的数据损坏风险。`,
    );
    return {
      allowed: true,
      action: "downgrade-allowed",
      minimumReaderEpoch: stamp.minimumReaderEpoch,
      committedDataEpoch: stamp.committedDataEpoch,
      stampPath: dataEpochStampPath(homeDir),
    };
  }
  if (stamp.minimumReaderEpoch === ownEpoch) {
    const shouldRefresh = stampRead.format === "legacy-v1" || stamp.lastVersion !== ownVersion;
    if (shouldRefresh) {
      await writeDataEpochStamp(homeDir, {
        minimumReaderEpoch: ownEpoch,
        committedDataEpoch: ownEpoch,
        lastVersion: ownVersion,
        updatedAt: timestamp(clock),
      });
    }
    return {
      allowed: true,
      action: shouldRefresh ? "refreshed" : "steady",
      minimumReaderEpoch: ownEpoch,
      committedDataEpoch: ownEpoch,
      stampPath: dataEpochStampPath(homeDir),
    };
  }

  return transitionDataEpoch({
    homeDir,
    fromEpoch: stamp.committedDataEpoch,
    toEpoch: ownEpoch,
    ownVersion,
    migrations,
    breakingReviews,
    stores,
    checkpointProvider,
    faultHook,
    clock,
    transitionIdFactory,
  });
}

export function describeDataEpochStartupBlock(result: Extract<DataEpochStartupResult, { allowed: false }>) {
  if (result.reason === "epoch-downgrade-blocked") {
    return describeDataEpochBlock({
      stampEpoch: result.stampEpoch!,
      ownEpoch: result.ownEpoch!,
      stampLastVersion: result.stampLastVersion ?? null,
    });
  }

  const location = result.reason === "corrupt-journal" || result.reason === "incomplete-transition" || result.reason === "corrupt-transition"
    ? result.journalPath
    : result.stampPath;
  const repairHint = result.reason === "incomplete-transition" || result.reason === "transition-failed"
    ? "请保留检查点与过渡日志，使用维护/恢复流程处理；普通启动不会自动续跑或回滚。"
    : "请检查文件系统与对应元数据；不要删除未知状态后强行启动。";
  const repairHintEn = result.reason === "incomplete-transition" || result.reason === "transition-failed"
    ? "Keep the checkpoint and transition journal, then use the maintenance/recovery flow; ordinary startup will not auto-resume or roll back."
    : "Inspect the filesystem and metadata; do not delete unknown state merely to force startup.";
  return (
    `[data-epoch] 数据安全闸拒绝启动（${result.reason}）：${result.detail}\n位置：${location}\n${repairHint}\n`
    + `[data-epoch] The data safety gate refused startup (${result.reason}): ${result.detail}\n`
    + `Location: ${location}\n${repairHintEn}`
  );
}
