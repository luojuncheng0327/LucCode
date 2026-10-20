import {
  projectCurrentSessionBranchEntries,
  readCurrentSessionBranch,
} from "../lib/session-jsonl.ts";

export class SessionBranchStateError extends Error {
  declare code: string;
  declare details: any;

  constructor(code, message, details: any = {}) {
    super(message);
    this.name = "SessionBranchStateError";
    this.code = code;
    this.details = details;
  }
}

function requireStore(store) {
  if (!store || typeof store.getBranchHead !== "function" || typeof store.setBranchHead !== "function") {
    throw new SessionBranchStateError(
      "session_manifest_unavailable",
      "Session branch persistence is unavailable.",
    );
  }
  return store;
}

function requireSessionId(sessionId) {
  if (typeof sessionId !== "string" || !sessionId.trim()) {
    throw new SessionBranchStateError(
      "session_manifest_ref_required",
      "Session branch operations require a stable sessionId.",
    );
  }
  return sessionId.trim();
}

function managerEntries(sessionManager) {
  if (typeof sessionManager?.getEntries !== "function") {
    throw new SessionBranchStateError(
      "session_branch_manager_unavailable",
      "Session manager does not expose branch entries.",
    );
  }
  return sessionManager.getEntries();
}

export function getPhysicalSessionTailLeafId(sessionManager) {
  const entries = managerEntries(sessionManager);
  return entries.at(-1)?.id || null;
}

function applyLeafToManager(sessionManager, leafId) {
  if (leafId == null) {
    if (typeof sessionManager?.resetLeaf !== "function") {
      throw new SessionBranchStateError(
        "session_branch_manager_unavailable",
        "Session manager cannot reset its branch leaf.",
      );
    }
    sessionManager.resetLeaf();
    return;
  }
  if (typeof sessionManager?.branch !== "function") {
    throw new SessionBranchStateError(
      "session_branch_manager_unavailable",
      "Session manager cannot select a branch leaf.",
    );
  }
  sessionManager.branch(leafId);
}

function headMatches(head, recommendation) {
  return !!head
    && (head.leafId ?? null) === (recommendation.leafId ?? null)
    && (head.observedTailLeafId ?? null) === (recommendation.observedTailLeafId ?? null);
}

export function applyStoredSessionBranchHead({
  store,
  sessionId,
  sessionManager,
  reason = "session_restore",
}: any) {
  const manifestStore = requireStore(store);
  const stableSessionId = requireSessionId(sessionId);
  const branchHead = manifestStore.getBranchHead(stableSessionId);
  const projection = projectCurrentSessionBranchEntries(managerEntries(sessionManager), {
    branchHead,
    filePath: sessionManager.getSessionFile?.() || "(in-memory session)",
  });
  if (projection.legacySyntheticIds) {
    if (branchHead) {
      throw new SessionBranchStateError(
        "session_branch_legacy_head_unresolvable",
        "A persisted branch head cannot be applied to an id-less legacy session.",
        { sessionId: stableSessionId },
      );
    }
    // Pi migrates real persisted sessions before this boundary. Lightweight
    // legacy readers may still expose id-less entries; never branch to or
    // persist their synthetic read-only ids.
    return projection;
  }
  applyLeafToManager(sessionManager, projection.selectedLeafId);

  if (!headMatches(branchHead, projection.recommendedHead)) {
    manifestStore.setBranchHead(stableSessionId, {
      ...projection.recommendedHead,
      reason: projection.headResolution === "append_recovery"
        ? "append_recovery"
        : branchHead
          ? `${reason}_observe_tail`
          : `${reason}_legacy_backfill`,
    });
  }
  return projection;
}

export function persistExplicitSessionBranchHead({
  store,
  sessionId,
  sessionManager,
  leafId = sessionManager?.getLeafId?.() ?? null,
  reason = "explicit_branch",
}: any) {
  const manifestStore = requireStore(store);
  const stableSessionId = requireSessionId(sessionId);
  const projection = projectCurrentSessionBranchEntries(managerEntries(sessionManager), {
    filePath: sessionManager.getSessionFile?.() || "(in-memory session)",
  });
  if (projection.legacySyntheticIds) {
    throw new SessionBranchStateError(
      "session_branch_legacy_write_unsupported",
      "An explicit branch head cannot be persisted for an id-less legacy session.",
      { sessionId: stableSessionId },
    );
  }
  if (leafId != null && typeof sessionManager?.getEntry === "function" && !sessionManager.getEntry(leafId)) {
    throw new SessionBranchStateError(
      "session_branch_head_missing",
      `Cannot persist missing session branch leaf: ${leafId}`,
      { sessionId: stableSessionId, leafId },
    );
  }
  return manifestStore.setBranchHead(stableSessionId, {
    leafId: leafId ?? null,
    observedTailLeafId: getPhysicalSessionTailLeafId(sessionManager),
    reason,
  });
}

export function syncSessionBranchHeadAfterAppend({
  store,
  sessionId,
  sessionManager,
  reason = "append_sync",
}: any) {
  try {
    return persistExplicitSessionBranchHead({
      store,
      sessionId,
      sessionManager,
      leafId: sessionManager?.getLeafId?.() ?? null,
      reason,
    });
  } catch (error) {
    if (error?.code === "session_branch_legacy_write_unsupported") return null;
    throw error;
  }
}

export function readManifestSessionBranch({
  store,
  sessionId,
  sessionPath,
  since = null,
  persistRecovery = true,
}: any) {
  const manifestStore = requireStore(store);
  const stableSessionId = requireSessionId(sessionId);
  const branchHead = manifestStore.getBranchHead(stableSessionId);
  const projection = readCurrentSessionBranch(sessionPath, { branchHead, since });
  if (persistRecovery && !projection.legacySyntheticIds && !headMatches(branchHead, projection.recommendedHead)) {
    manifestStore.setBranchHead(stableSessionId, {
      ...projection.recommendedHead,
      reason: projection.headResolution === "append_recovery"
        ? "append_recovery"
        : branchHead
          ? "branch_read_observe_tail"
          : "branch_read_legacy_backfill",
    });
  }
  return {
    ...projection,
    sessionId: stableSessionId,
    sessionPath,
  };
}

export function restoreSessionManagerLeaf(sessionManager, leafId) {
  applyLeafToManager(sessionManager, leafId ?? null);
}
