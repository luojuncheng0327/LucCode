import crypto from "crypto";
import { buildCompiledMemoryMarkdown } from "../compile.ts";
import {
  atomizeDreamMemory,
  composeDreamMemory,
  dedupeDreamMemory,
  dreamModelId,
  optimizeDreamMemory,
  verifyDreamSections,
} from "./model-runner.ts";
import {
  applyDreamSections,
  createDreamRevision,
  recoverPendingDreamApply,
  restoreDreamRevision as restoreRevisionFiles,
  snapshotDreamSections,
  type DreamSections,
} from "./revision-store.ts";
import {
  emptyDreamState,
  isDreamErrorCode,
  readDreamState,
  writeDreamState,
  type DreamErrorCode,
  type DreamPersistentState,
  type DreamRunReport,
  type DreamRunTrigger,
} from "./state-store.ts";

export class DreamAlreadyRunningError extends Error {
  readonly code = "dream_already_running" as const;

  constructor() {
    super("A Memory Dream is already running for this agent");
  }
}

class DreamOperationError extends Error {
  readonly code: DreamErrorCode;

  constructor(code: DreamErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "DreamOperationError";
    this.code = code;
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

function persistedDreamErrorCode(error: unknown): DreamErrorCode {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return isDreamErrorCode(code) ? code : "dream_run_failed";
}

function isRevisionNotFoundError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /dream revision not found/i.test(message);
}

type DreamRuntimeStatus = {
  status: "idle" | "running" | "succeeded" | "failed";
  runId: string | null;
  startedAt: string | null;
  lastRun: DreamRunReport | null;
};

type CreateMemoryDreamRunnerOptions = {
  memoryDir: string;
  memoryMdPath: string;
  getResolvedMemoryModel: () => Promise<any>;
  getLogicalDate: () => string;
  onCompiled?: () => void;
};

function editableBodyChars(sections: DreamSections) {
  return sections.facts.length + sections.longterm.length;
}

function compiledChars(sections: DreamSections) {
  return buildCompiledMemoryMarkdown({
    facts: sections.facts,
    today: sections.today,
    week: sections.weekDays.map((entry) => `### ${entry.date}\n\n${entry.body}`).join("\n\n"),
    longterm: sections.longterm,
  }).length;
}

function inputHash(sections: DreamSections) {
  return crypto.createHash("sha256").update(JSON.stringify(sections)).digest("hex");
}

function changedEditableSections(before: DreamSections, after: DreamSections) {
  const changed: Array<"facts" | "longterm"> = [];
  if (before.facts !== after.facts) changed.push("facts");
  if (before.longterm !== after.longterm) changed.push("longterm");
  return changed;
}

export function createMemoryDreamRunner(options: CreateMemoryDreamRunnerOptions) {
  let running: Promise<DreamRunReport> | null = null;
  let abortController: AbortController | null = null;
  let stateLoaded = false;
  let state: DreamPersistentState = emptyDreamState();
  let runtime: DreamRuntimeStatus = {
    status: "idle",
    runId: null,
    startedAt: null,
    lastRun: null,
  };

  const ensureState = () => {
    if (!stateLoaded) {
      state = readDreamState(options.memoryDir);
      runtime.lastRun = state.lastRun;
      if (state.lastRun) runtime.status = state.lastRun.status;
      stateLoaded = true;
    }
    return state;
  };

  const persist = (next: DreamPersistentState) => {
    state = writeDreamState(options.memoryDir, next);
    stateLoaded = true;
  };

  const runCore = async ({
    runId,
    trigger,
    logicalDate,
    startedAt,
    signal,
  }: {
    runId: string;
    trigger: DreamRunTrigger;
    logicalDate: string;
    startedAt: string;
    signal: AbortSignal;
  }) => {
    let before: DreamSections | null = null;
    let model = "";
    try {
      if (recoverPendingDreamApply(options.memoryDir, options.memoryMdPath)) {
        options.onCompiled?.();
      }
      before = snapshotDreamSections(options.memoryDir);
      const beforeHash = inputHash(before);
      if (editableBodyChars(before) === 0) {
        throw new DreamOperationError("dream_no_memory", "There is no memory to organize yet");
      }

      const resolvedModel = await options.getResolvedMemoryModel();
      model = dreamModelId(resolvedModel);
      const atomized = await atomizeDreamMemory({
        current: before,
        resolvedModel,
        trigger,
        signal,
      });
      const deduped = await dedupeDreamMemory({
        units: atomized.units,
        resolvedModel,
        trigger,
        signal,
      });
      const optimization = await optimizeDreamMemory({
        current: before,
        sourceBlocks: atomized.sourceBlocks,
        atomicUnits: atomized.units,
        dedupePlan: deduped,
        resolvedModel,
        trigger,
        signal,
      });
      let writerResult = await composeDreamMemory({
        current: before,
        optimization,
        resolvedModel,
        trigger,
        signal,
      });
      const firstVerification = await verifyDreamSections({
        current: before,
        plan: writerResult,
        resolvedModel,
        trigger,
        signal,
      });
      if (firstVerification.insufficientCompression) {
        writerResult = await composeDreamMemory({
          current: before,
          optimization,
          resolvedModel,
          trigger,
          compressionRepair: {
            previousParagraphs: writerResult.paragraphs,
            feedback: firstVerification.compressionFeedback,
          },
          signal,
        });
        // Compression is a soft objective. A second advisory is accepted, while
        // verifyDreamSections still throws for every semantic/provenance failure.
        await verifyDreamSections({
          current: before,
          plan: writerResult,
          resolvedModel,
          trigger,
          signal,
        });
      }

      if (signal.aborted) throw new DOMException("Dream aborted", "AbortError");
      const current = snapshotDreamSections(options.memoryDir);
      if (inputHash(current) !== beforeHash) {
        throw new DreamOperationError(
          "dream_memory_changed",
          "Memory changed while Dream was running; no changes were applied",
        );
      }

      const proposedHash = inputHash(writerResult.sections);
      if (proposedHash === beforeHash) {
        const finishedAt = new Date().toISOString();
        const report: DreamRunReport = {
          runId,
          trigger,
          status: "succeeded",
          startedAt,
          finishedAt,
          logicalDate,
          beforeChars: compiledChars(before),
          afterChars: compiledChars(before),
          mergedCount: 0,
          forgottenCount: 0,
          reviewedCount: 0,
          model,
          revisionId: null,
          notes: [],
          changed: false,
          changedSections: [],
          appliedOperationCount: 0,
        };
        const currentState = ensureState();
        persist({
          ...currentState,
          lastSuccessfulManualDate: trigger === "manual" ? logicalDate : currentState.lastSuccessfulManualDate,
          lastRun: report,
        });
        return report;
      }

      const revision = createDreamRevision(options.memoryDir, { runId, trigger, before });
      const applied = applyDreamSections(options.memoryDir, {
        revision,
        next: writerResult.sections,
        memoryMdPath: options.memoryMdPath,
      });
      options.onCompiled?.();

      const finishedAt = new Date().toISOString();
      const changedSections = changedEditableSections(before, applied);
      const report: DreamRunReport = {
        runId,
        trigger,
        status: "succeeded",
        startedAt,
        finishedAt,
        logicalDate,
        beforeChars: compiledChars(before),
        afterChars: compiledChars(applied),
        mergedCount: writerResult.mergedCount,
        forgottenCount: writerResult.forgottenCount,
        reviewedCount: 0,
        model,
        revisionId: revision.revisionId,
        notes: [],
        changed: true,
        changedSections,
        appliedOperationCount: writerResult.operations.length,
      };
      const currentState = ensureState();
      persist({
        ...currentState,
        lastSuccessfulManualDate: trigger === "manual" ? logicalDate : currentState.lastSuccessfulManualDate,
        lastRun: report,
      });
      return report;
    } catch (err: any) {
      const finishedAt = new Date().toISOString();
      const report: DreamRunReport = {
        runId,
        trigger,
        status: "failed",
        startedAt,
        finishedAt,
        logicalDate,
        beforeChars: before ? compiledChars(before) : 0,
        afterChars: before ? compiledChars(before) : 0,
        mergedCount: 0,
        forgottenCount: 0,
        reviewedCount: 0,
        model,
        revisionId: null,
        notes: [],
        changed: false,
        changedSections: [],
        appliedOperationCount: 0,
        error: err?.message || String(err),
        errorCode: persistedDreamErrorCode(err),
      };
      const currentState = ensureState();
      persist({ ...currentState, lastRun: report });
      return report;
    }
  };

  function start({
    trigger = "manual",
    logicalDate = options.getLogicalDate(),
  }: {
    trigger?: DreamRunTrigger;
    logicalDate?: string;
  } = {}) {
    if (running) throw new DreamAlreadyRunningError();
    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    abortController = new AbortController();
    runtime = { status: "running", runId, startedAt, lastRun: ensureState().lastRun };

    if (trigger === "automatic") {
      persist({ ...ensureState(), lastAutomaticAttemptDate: logicalDate });
    }

    const promise = runCore({
      runId,
      trigger,
      logicalDate,
      startedAt,
      signal: abortController.signal,
    });
    running = promise;
    promise.then((report) => {
      runtime = { status: report.status, runId: null, startedAt: null, lastRun: report };
    }).finally(() => {
      if (running === promise) running = null;
      abortController = null;
    });
    return { status: "running" as const, runId, startedAt, lastRun: runtime.lastRun };
  }

  function startAutomaticIfEligible(logicalDate = options.getLogicalDate()) {
    const currentState = ensureState();
    if (currentState.lastAutomaticAttemptDate === logicalDate) return null;
    if (currentState.lastSuccessfulManualDate === logicalDate) return null;
    if (running) return null;
    return start({ trigger: "automatic", logicalDate });
  }

  function getStatus() {
    ensureState();
    return { ...runtime, lastRun: runtime.lastRun ? { ...runtime.lastRun } : null };
  }

  async function restoreRevision(revisionId: string) {
    if (running) throw new DreamAlreadyRunningError();
    try {
      if (recoverPendingDreamApply(options.memoryDir, options.memoryMdPath)) {
        options.onCompiled?.();
      }
      const restored = restoreRevisionFiles(options.memoryDir, revisionId, options.memoryMdPath);
      options.onCompiled?.();
      return { revisionId, restoredChars: compiledChars(restored) };
    } catch (error) {
      const existingCode = error && typeof error === "object"
        ? (error as { code?: unknown }).code
        : undefined;
      if (isDreamErrorCode(existingCode)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new DreamOperationError(
        isRevisionNotFoundError(error) ? "dream_revision_not_found" : "dream_restore_failed",
        message,
        error,
      );
    }
  }

  async function stop() {
    abortController?.abort();
    if (running) await running.catch(() => {});
  }

  function isRunning() {
    return running !== null;
  }

  return {
    start,
    startAutomaticIfEligible,
    getStatus,
    restoreRevision,
    stop,
    isRunning,
  };
}
