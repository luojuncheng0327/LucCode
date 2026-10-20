function cloneMemorySnapshot(value: any) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

/**
 * Atomically invalidate the mutable memory derived from one Session.
 *
 * The summary lives on disk while deep facts live in SQLite. FactStore deletes
 * one Session with a single SQLite statement, so a thrown delete leaves facts
 * unchanged; in that case we compensate the preceding summary mutation from a
 * durable snapshot. Already-compiled aggregate memory is intentionally outside
 * this transaction.
 */
export function invalidateSessionDerivedStateSync(input: any = {}) {
  const sessionId = typeof input.sessionId === "string" ? input.sessionId.trim() : "";
  const summaryManager = input.summaryManager;
  const factStore = input.factStore;
  if (!sessionId) throw new Error("memory invalidation requires sessionId");
  if (typeof summaryManager?.invalidateSession !== "function") {
    throw new Error("session summary invalidation is unavailable");
  }
  if (typeof factStore?.deleteBySession !== "function") {
    throw new Error("session fact invalidation is unavailable");
  }
  if (typeof summaryManager?.getSummary !== "function" || typeof summaryManager?.saveSummary !== "function") {
    throw new Error("session summary invalidation rollback is unavailable");
  }

  const retainedMessageCount = Number(input.retainedMessageCount);
  const summarySnapshot = cloneMemorySnapshot(summaryManager.getSummary(sessionId));
  let summaryInvalidated = false;
  let factsDeleted = 0;
  try {
    summaryInvalidated = Number.isInteger(retainedMessageCount) && retainedMessageCount >= 0
      ? summaryManager.invalidateSession(sessionId, { retainedMessageCount })
      : summaryManager.invalidateSession(sessionId);
    factsDeleted = factStore.deleteBySession(sessionId);
  } catch (error) {
    try {
      if (summarySnapshot) summaryManager.saveSummary(sessionId, summarySnapshot);
      else summaryManager.invalidateSession(sessionId);
    } catch (rollbackError) {
      const rollbackFailure: any = new Error(
        `session memory invalidation failed and summary rollback was incomplete (${rollbackError?.message || rollbackError})`,
        { cause: error },
      );
      rollbackFailure.code = "session_memory_rollback_failed";
      rollbackFailure.status = 500;
      throw rollbackFailure;
    }
    throw error;
  }

  return {
    sessionId,
    summaryInvalidated,
    factsDeleted,
    aggregateHistoryPreserved: true,
  };
}
