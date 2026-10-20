import fs from "fs";
import path from "path";
import { atomicWriteSync } from "../../../shared/safe-fs.ts";

export const DREAM_STATE_SCHEMA_VERSION = 1;

export type DreamRunTrigger = "manual" | "automatic";

export type DreamErrorCode =
  | "dream_unavailable"
  | "dream_memory_disabled"
  | "dream_memory_busy"
  | "dream_already_running"
  | "dream_revision_not_found"
  | "dream_restore_failed"
  | "dream_run_failed"
  | "dream_no_memory"
  | "dream_memory_changed";

const DREAM_ERROR_CODES = new Set<DreamErrorCode>([
  "dream_unavailable",
  "dream_memory_disabled",
  "dream_memory_busy",
  "dream_already_running",
  "dream_revision_not_found",
  "dream_restore_failed",
  "dream_run_failed",
  "dream_no_memory",
  "dream_memory_changed",
]);

export function isDreamErrorCode(value: unknown): value is DreamErrorCode {
  return typeof value === "string" && DREAM_ERROR_CODES.has(value as DreamErrorCode);
}

export type DreamRunReport = {
  runId: string;
  trigger: DreamRunTrigger;
  status: "succeeded" | "failed";
  startedAt: string;
  finishedAt: string;
  logicalDate: string;
  beforeChars: number;
  afterChars: number;
  mergedCount: number;
  forgottenCount: number;
  reviewedCount: number;
  model: string;
  revisionId: string | null;
  notes: string[];
  /** Added in a backward-compatible state extension. Absent in schema-v1 historical reports. */
  changed?: boolean;
  /** Deterministically derived from the applied section diff; never supplied by the model. */
  changedSections?: Array<"facts" | "longterm">;
  /** Number of structured unit operations whose result was actually applied. */
  appliedOperationCount?: number;
  error?: string;
  /** Stable public code; absent in reports persisted before Dream error I18N. */
  errorCode?: DreamErrorCode;
};

export type DreamPersistentState = {
  schemaVersion: number;
  lastAutomaticAttemptDate: string | null;
  lastSuccessfulManualDate: string | null;
  lastRun: DreamRunReport | null;
  updatedAt: string;
};

export function dreamDir(memoryDir: string) {
  return path.join(memoryDir, "dream");
}

export function dreamStatePath(memoryDir: string) {
  return path.join(dreamDir(memoryDir), "state.json");
}

export function emptyDreamState(): DreamPersistentState {
  return {
    schemaVersion: DREAM_STATE_SCHEMA_VERSION,
    lastAutomaticAttemptDate: null,
    lastSuccessfulManualDate: null,
    lastRun: null,
    updatedAt: new Date(0).toISOString(),
  };
}

function validDateString(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function readLastRun(value: unknown): DreamRunReport | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const report = { ...(value as Record<string, unknown>) };
  if (!isDreamErrorCode(report.errorCode)) delete report.errorCode;
  return report as unknown as DreamRunReport;
}

export function readDreamState(memoryDir: string): DreamPersistentState {
  try {
    const raw = JSON.parse(fs.readFileSync(dreamStatePath(memoryDir), "utf-8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyDreamState();
    if (raw.schemaVersion !== DREAM_STATE_SCHEMA_VERSION) return emptyDreamState();
    return {
      schemaVersion: DREAM_STATE_SCHEMA_VERSION,
      lastAutomaticAttemptDate: validDateString(raw.lastAutomaticAttemptDate)
        ? raw.lastAutomaticAttemptDate
        : null,
      lastSuccessfulManualDate: validDateString(raw.lastSuccessfulManualDate)
        ? raw.lastSuccessfulManualDate
        : null,
      lastRun: readLastRun(raw.lastRun),
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString(),
    } as DreamPersistentState;
  } catch (err: any) {
    if (err?.code === "ENOENT") return emptyDreamState();
    throw new Error(`Dream state is unreadable: ${err?.message || err}`);
  }
}

export function writeDreamState(memoryDir: string, state: DreamPersistentState) {
  fs.mkdirSync(dreamDir(memoryDir), { recursive: true });
  const next = {
    ...state,
    schemaVersion: DREAM_STATE_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
  };
  atomicWriteSync(dreamStatePath(memoryDir), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
