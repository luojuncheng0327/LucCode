export type DataEpochRecoveryMode = "resume-idempotent" | "restore-only";

export interface DataEpochMigrationContext {
  homeDir: string;
  fromEpoch: number;
  toEpoch: number;
  checkpoint: { id: string; [key: string]: unknown };
}

export interface DataEpochMigration {
  id: string;
  fromEpoch: number;
  toEpoch: number;
  affectedStoreIds: readonly string[];
  recoveryMode: DataEpochRecoveryMode;
  preCoordinatorReadCompatibility?: "preserved";
  preflight?: (context: Omit<DataEpochMigrationContext, "checkpoint">) => Promise<void> | void;
  migrate: (context: DataEpochMigrationContext) => Promise<void> | void;
  validate: (context: DataEpochMigrationContext) => Promise<void> | void;
}

export interface DataEpochBreakingReview {
  fromEpoch: number;
  toEpoch: number;
  affectedStoreIds: readonly string[];
  checkpointPolicy: string;
  restorePolicy: string;
}

export interface ResolvedDataEpochMigrationPath {
  steps: DataEpochMigration[];
  migrationIds: string[];
  affectedStoreIds: string[];
  recoveryModes: Record<string, DataEpochRecoveryMode>;
}

// Production remains at DATA_EPOCH=1. A future breaking format change must
// land one adjacent migration edge and its schema-review contract before the
// epoch constant is raised; the coordinator refuses an incomplete path.
export const DATA_EPOCH_MIGRATIONS: readonly DataEpochMigration[] = Object.freeze([]);
export const DATA_EPOCH_BREAKING_REVIEWS: readonly DataEpochBreakingReview[] = Object.freeze([]);

function requirePositiveEpoch(value: number, label: string) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
}

function uniqueSortedStrings(values: readonly string[], label: string) {
  if (!Array.isArray(values) || values.length === 0
    || values.some((value) => typeof value !== "string" || value.length === 0)
    || new Set(values).size !== values.length) {
    throw new Error(`${label} requires unique non-empty values`);
  }
  return [...values].sort();
}

function validateMigration(migration: DataEpochMigration) {
  if (!migration || typeof migration !== "object") throw new Error("data epoch migration must be an object");
  if (typeof migration.id !== "string" || migration.id.length === 0) throw new Error("data epoch migration requires an id");
  requirePositiveEpoch(migration.fromEpoch, `migration ${migration.id} fromEpoch`);
  requirePositiveEpoch(migration.toEpoch, `migration ${migration.id} toEpoch`);
  if (migration.toEpoch !== migration.fromEpoch + 1) {
    throw new Error(`migration ${migration.id} must declare one adjacent epoch edge`);
  }
  uniqueSortedStrings(migration.affectedStoreIds, `migration ${migration.id} affectedStoreIds`);
  if (migration.recoveryMode !== "resume-idempotent" && migration.recoveryMode !== "restore-only") {
    throw new Error(`migration ${migration.id} requires an explicit recoveryMode`);
  }
  if (typeof migration.migrate !== "function" || typeof migration.validate !== "function") {
    throw new Error(`migration ${migration.id} requires migrate and validate functions`);
  }
}

function reviewForEdge(
  fromEpoch: number,
  toEpoch: number,
  reviews: readonly DataEpochBreakingReview[],
) {
  const matches = reviews.filter((review) => review.fromEpoch === fromEpoch && review.toEpoch === toEpoch);
  if (matches.length !== 1) {
    throw new Error(`data epoch edge ${fromEpoch} -> ${toEpoch} requires exactly one breaking review contract`);
  }
  const review = matches[0];
  const affectedStoreIds = uniqueSortedStrings(review.affectedStoreIds, `breaking review ${fromEpoch} -> ${toEpoch} affectedStoreIds`);
  if (typeof review.checkpointPolicy !== "string" || review.checkpointPolicy.trim().length === 0) {
    throw new Error(`breaking review ${fromEpoch} -> ${toEpoch} requires a checkpointPolicy`);
  }
  if (typeof review.restorePolicy !== "string" || review.restorePolicy.trim().length === 0) {
    throw new Error(`breaking review ${fromEpoch} -> ${toEpoch} requires a restorePolicy`);
  }
  return { ...review, affectedStoreIds };
}

export function resolveDataEpochMigrationPath(
  fromEpoch: number,
  toEpoch: number,
  registry: readonly DataEpochMigration[] = DATA_EPOCH_MIGRATIONS,
  reviews: readonly DataEpochBreakingReview[] = DATA_EPOCH_BREAKING_REVIEWS,
): ResolvedDataEpochMigrationPath {
  requirePositiveEpoch(fromEpoch, "fromEpoch");
  requirePositiveEpoch(toEpoch, "toEpoch");
  if (toEpoch <= fromEpoch) throw new Error("toEpoch must be greater than fromEpoch");

  const ids = new Set<string>();
  for (const migration of registry) {
    validateMigration(migration);
    if (ids.has(migration.id)) throw new Error(`duplicate data epoch migration id: ${migration.id}`);
    ids.add(migration.id);
  }

  const steps: DataEpochMigration[] = [];
  for (let epoch = fromEpoch; epoch < toEpoch; epoch += 1) {
    const edge = registry
      .filter((migration) => migration.fromEpoch === epoch && migration.toEpoch === epoch + 1)
      .sort((left, right) => left.id.localeCompare(right.id));
    if (edge.length === 0) throw new Error(`missing data epoch migration edge ${epoch} -> ${epoch + 1}`);

    const review = reviewForEdge(epoch, epoch + 1, reviews);
    const edgeAffectedStoreIds = [...new Set(edge.flatMap((migration) => [...migration.affectedStoreIds]))].sort();
    if (JSON.stringify(edgeAffectedStoreIds) !== JSON.stringify(review.affectedStoreIds)) {
      throw new Error(
        `data epoch edge ${epoch} -> ${epoch + 1} affected-store union does not match its breaking review: `
        + `migrations=[${edgeAffectedStoreIds.join(",")}], review=[${review.affectedStoreIds.join(",")}]`,
      );
    }
    steps.push(...edge);
  }

  const migrationIds = steps.map((migration) => migration.id);
  const affectedStoreIds = [...new Set(steps.flatMap((migration) => [...migration.affectedStoreIds]))].sort();
  const recoveryModes = Object.fromEntries(steps.map((migration) => [migration.id, migration.recoveryMode]));
  return { steps, migrationIds, affectedStoreIds, recoveryModes };
}
