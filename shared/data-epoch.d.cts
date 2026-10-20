export const DATA_EPOCH_STAMP_SCHEMA_VERSION: 2;
export const DATA_EPOCH_JOURNAL_SCHEMA_VERSION: 1;

export type DataEpochJournalPhase =
  | "prepared"
  | "checkpoint_complete"
  | "barrier_raised"
  | "migrating"
  | "migrated"
  | "validated"
  | "committed";

export const DATA_EPOCH_JOURNAL_PHASES: readonly DataEpochJournalPhase[];

export interface DataEpochStamp {
  schemaVersion: 1 | 2;
  epoch: number;
  minimumReaderEpoch: number;
  committedDataEpoch: number;
  lastVersion: string | null;
  updatedAt: string | null;
}

export interface DataEpochJournal {
  schemaVersion: 1;
  transitionId: string;
  fromEpoch: number;
  toEpoch: number;
  migrationIds: string[];
  affectedStoreIds: string[];
  recoveryModes: Record<string, "resume-idempotent" | "restore-only">;
  phase: DataEpochJournalPhase;
  checkpointId: string | null;
  checkpointReceipt: null | { id: string; [key: string]: unknown };
  createdAt: string;
  updatedAt: string;
  lastVersion: string;
}

export type DataEpochReadResult<T, K extends string> =
  | { status: "missing"; filePath: string }
  | { status: "corrupt"; filePath: string; detail: string }
  | ({ status: "ok"; filePath: string } & Record<K, T>);

export function dataEpochStampPath(homeDir: string): string;
export function dataEpochJournalPath(homeDir: string): string;
export function readDataEpochStamp(homeDir: string): DataEpochReadResult<DataEpochStamp, "stamp"> & { format?: "legacy-v1" | "v2" };
export function readDataEpochJournal(homeDir: string): DataEpochReadResult<DataEpochJournal, "journal">;

export function durableWriteJson(filePath: string, value: unknown): Promise<void>;
export function createDataEpochStamp(input: {
  minimumReaderEpoch: number;
  committedDataEpoch: number;
  lastVersion: string;
  updatedAt?: string;
}): DataEpochStamp & { schemaVersion: 2; lastVersion: string; updatedAt: string };
export function writeDataEpochStamp(homeDir: string, input: {
  minimumReaderEpoch: number;
  committedDataEpoch: number;
  lastVersion: string;
  updatedAt?: string;
}): Promise<DataEpochStamp & { schemaVersion: 2; lastVersion: string; updatedAt: string }>;

export function createDataEpochJournal(input: {
  transitionId: string;
  fromEpoch: number;
  toEpoch: number;
  migrationIds: string[];
  affectedStoreIds: string[];
  recoveryModes: Record<string, "resume-idempotent" | "restore-only">;
  phase: DataEpochJournalPhase;
  checkpointId?: string | null;
  checkpointReceipt?: null | { id: string; [key: string]: unknown };
  createdAt?: string;
  updatedAt?: string;
  lastVersion: string;
}): DataEpochJournal;
export function writeDataEpochJournal(homeDir: string, input: Parameters<typeof createDataEpochJournal>[0]): Promise<DataEpochJournal>;
export function removeDataEpochJournal(homeDir: string): Promise<boolean>;

export function describeDataEpochBlock(args: {
  stampEpoch: number;
  ownEpoch: number;
  stampLastVersion: string | null;
}): string;

export const DATA_EPOCH_RESTORE_JOURNAL_SCHEMA_VERSION: 1;

export type DataEpochRestoreJournalPhase =
  | "restore:starting"
  | "restore:stores_restored"
  | "restore:metadata_republished";

export const DATA_EPOCH_RESTORE_JOURNAL_PHASES: readonly DataEpochRestoreJournalPhase[];

export interface DataEpochRestoreJournal {
  kind: "restore";
  restoreSchemaVersion: 1;
  restoreId: string;
  transitionId: string;
  fromEpoch: number;
  phase: DataEpochRestoreJournalPhase;
  createdAt: string;
  updatedAt: string;
}

export function readDataEpochRestoreJournal(homeDir: string): DataEpochReadResult<DataEpochRestoreJournal, "journal">;
export function createDataEpochRestoreJournal(input: {
  restoreId: string;
  transitionId: string;
  fromEpoch: number;
  phase: DataEpochRestoreJournalPhase;
  createdAt?: string;
  updatedAt?: string;
}): DataEpochRestoreJournal;
export function writeDataEpochRestoreJournal(homeDir: string, input: Parameters<typeof createDataEpochRestoreJournal>[0]): Promise<DataEpochRestoreJournal>;

export function republishDataEpochStampForRestore(args: {
  homeDir: string;
  fromEpoch: number;
  lastVersion: string;
  updatedAt?: string;
}): Promise<DataEpochStamp & { schemaVersion: 2; lastVersion: string; updatedAt: string }>;
