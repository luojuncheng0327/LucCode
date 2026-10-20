import fsp from "fs/promises";
import { detectMime } from "../lib/file-metadata.ts";
import {
  AGENT_REVIEW_RECORD_TYPE,
  MESSAGE_ORIGIN_RECORD_TYPE,
  MESSAGE_PRESENTATION_RECORD_TYPE,
  submitDesktopSessionMessage,
} from "./desktop-session-submit.ts";
import { extractLatestTodos } from "../lib/tools/todo-compat.ts";
import { acquireSessionOperation } from "./session-operation-lock.ts";
import { invalidateSessionDerivedStateSync } from "../lib/memory/session-derived-state.ts";
import {
  isHiddenTurnInputMessage,
  isSessionTurnInputEntry,
} from "../lib/turn-input-presentation.ts";
import {
  ATTACHMENT_MARKER_RE,
  REFERENCE_BLOCK_END,
  REFERENCE_BLOCK_PREFIX,
  REMINDER_BLOCK_END,
  REMINDER_BLOCK_PREFIX,
  SESSION_FILE_MARKER_RE,
  visiblePromptText,
} from "./session-reminders.ts";

export type SessionNodeTarget =
  | { role: "user"; entryId: string }
  | { role: "assistant"; entryId: string }
  | { role: "assistant_turn"; turnInputEntryId: string };

const LUC_USER_ENVELOPE_TYPES = new Set([
  MESSAGE_PRESENTATION_RECORD_TYPE,
  MESSAGE_ORIGIN_RECORD_TYPE,
  AGENT_REVIEW_RECORD_TYPE,
]);
export const SESSION_BRANCH_RESET_RECORD_TYPE = "luc-session-branch-reset";
const BACKGROUND_TASK_ID_KEYS = new Set(["taskId", "runId", "replacesTaskId"]);
const ACTIVE_BACKGROUND_TASK_STATUSES = new Set(["pending", "running", "paused", "blocked", "recovering"]);

export function normalizeSessionNodeTarget(target: any): SessionNodeTarget {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw new Error("session node target is required");
  }
  const role = typeof target.role === "string" ? target.role.trim() : "";
  if (role === "user" || role === "assistant") {
    const entryId = typeof target.entryId === "string" ? target.entryId.trim() : "";
    if (!entryId) throw new Error(`session node target ${role} entryId is required`);
    return { role, entryId };
  }
  if (role === "assistant_turn") {
    const turnInputEntryId = typeof target.turnInputEntryId === "string"
      ? target.turnInputEntryId.trim()
      : typeof target.precedingUserEntryId === "string"
        ? target.precedingUserEntryId.trim()
        : "";
    if (!turnInputEntryId) {
      throw new Error("session node target assistant_turn turnInputEntryId is required");
    }
    return { role, turnInputEntryId };
  }
  throw new Error("session node target role must be user, assistant, or assistant_turn");
}

/**
 * Resolve a UI node against one explicit active root→leaf branch.
 *
 * Retry maps an Agent node back to its persisted turn input. Normal user inputs
 * branch before Luc's contiguous presentation/origin/review envelope; Pi
 * custom_message inputs branch directly before that context entry. Fork keeps a
 * user node through that entry, while an Agent node keeps the whole logical turn
 * through the entry just before the next turn input.
 */
export function resolveSessionNodeTarget(
  branch: any[],
  rawTarget: any,
  opts: { mode?: "retry" | "fork" } = {},
) {
  if (!Array.isArray(branch)) throw new Error("active session branch is unavailable");
  const mode = opts.mode || "retry";
  if (mode !== "retry" && mode !== "fork") {
    throw new Error("session node resolution mode must be retry or fork");
  }
  const target = normalizeSessionNodeTarget(rawTarget);

  let selectedIndex = -1;
  let selectedEntry = null;
  let turnInputIndex = -1;

  if (target.role === "user" || target.role === "assistant") {
    selectedIndex = branch.findIndex((entry) => entry?.id === target.entryId);
    if (selectedIndex < 0) throw new Error("Requested session node is not on the active branch");
    selectedEntry = branch[selectedIndex];
    if (selectedEntry?.type !== "message" || selectedEntry.message?.role !== target.role) {
      throw new Error(`Requested session node is not a ${target.role} message`);
    }
    if (target.role === "user") {
      turnInputIndex = selectedIndex;
    } else {
      turnInputIndex = findPrecedingTurnInputIndex(branch, selectedIndex);
      if (turnInputIndex < 0) throw new Error("Assistant node has no preceding turn input on the active branch");
    }
  } else {
    turnInputIndex = branch.findIndex((entry) => entry?.id === target.turnInputEntryId);
    if (turnInputIndex < 0) throw new Error("Requested session node is not on the active branch");
    if (!isSessionTurnInputEntry(branch[turnInputIndex])) {
      throw new Error("assistant_turn turnInputEntryId is not a turn input");
    }
  }

  const turnInputEntry = branch[turnInputIndex];
  const userEntry = isUserMessageEntry(turnInputEntry) ? turnInputEntry : null;
  const envelopeStartIndex = userEntry
    ? findUserEnvelopeStartIndex(branch, turnInputIndex)
    : turnInputIndex;
  const retryBranchParentIndex = envelopeStartIndex - 1;
  const retryBranchParentEntry = retryBranchParentIndex >= 0 ? branch[retryBranchParentIndex] : null;

  const nextTurnInputIndex = findNextTurnInputIndex(branch, turnInputIndex + 1);
  const nextEnvelopeStartIndex = nextTurnInputIndex >= 0
    ? (isUserMessageEntry(branch[nextTurnInputIndex])
        ? findUserEnvelopeStartIndex(branch, nextTurnInputIndex)
        : nextTurnInputIndex)
    : branch.length;
  const turnEndIndex = Math.max(turnInputIndex, nextEnvelopeStartIndex - 1);
  const turnEndEntry = branch[turnEndIndex] || turnInputEntry;
  const turnStartAssistantEntry = branch
    .slice(turnInputIndex + 1, nextEnvelopeStartIndex)
    .find((entry) => entry?.type === "message" && entry.message?.role === "assistant") || null;

  if (target.role === "assistant_turn") {
    for (let index = turnEndIndex; index > turnInputIndex; index -= 1) {
      const entry = branch[index];
      if (entry?.type === "message" && entry.message?.role === "assistant") {
        selectedIndex = index;
        selectedEntry = entry;
        break;
      }
    }
    if (!selectedEntry) throw new Error("assistant_turn has no completed assistant message");
  }

  const selectedUser = target.role === "user" ? userEntry : null;
  const precedingUser = target.role === "user" ? null : userEntry;
  const boundaryEntry = mode === "fork"
    ? (target.role === "user" ? turnInputEntry : turnEndEntry)
    : retryBranchParentEntry;

  return {
    target,
    selectedEntry,
    selectedUser,
    precedingUser,
    userEntry,
    turnInputEntry,
    envelopeStartEntry: branch[envelopeStartIndex] || turnInputEntry,
    retryBranchParentId: retryBranchParentEntry?.id || null,
    turnStartAssistantEntry,
    turnEndEntry,
    boundaryEntry,
  };
}

export async function retrySessionTurn(
  engine: any,
  opts: Record<string, any> = {},
  deps: Record<string, any> = {},
) {
  return retrySessionTurnInternal(engine, opts, deps, {
    allowLegacyPath: false,
    latestUserOnly: false,
  });
}

/** Compatibility adapter for the existing latest-user route. */
export async function replayLatestUserTurn(
  engine: any,
  opts: Record<string, any> = {},
  deps: Record<string, any> = {},
) {
  return retrySessionTurnInternal(engine, opts, deps, {
    allowLegacyPath: true,
    latestUserOnly: true,
  });
}

async function retrySessionTurnInternal(engine, opts, deps, compatibility) {
  const submit = deps.submit || submitDesktopSessionMessage;
  const {
    sourceEntryId,
    clientMessageId,
    replacementText,
    displayMessage,
    uiContext,
  } = opts;

  if (!engine || typeof engine.ensureSessionLoaded !== "function") {
    throw new Error("session retry requires engine.ensureSessionLoaded");
  }
  if (replacementText != null && !String(replacementText).trim()) {
    throw new Error("replacement text is required");
  }

  const identity = resolveSessionIdentity(engine, opts, compatibility.allowLegacyPath);
  const { sessionId, sessionPath } = identity;
  const operationKey = sessionId || sessionPath;
  const releaseOperation = acquireSessionOperation(operationKey, "retry");

  try {
    if (typeof engine.isSessionStreaming === "function" && engine.isSessionStreaming(sessionPath)) {
      throw new Error("session_busy");
    }

    const session = await engine.ensureSessionLoaded(sessionPath);
    if (!session?.sessionManager) throw new Error(`failed to load session ${sessionPath}`);

    const branch = session.sessionManager.getBranch();
    let target = opts.target;
    if (compatibility.latestUserOnly) {
      const latest = findLatestUserEntry(branch);
      if (!latest) throw new Error("No latest user message to replay");
      if (sourceEntryId && latest.id !== sourceEntryId) {
        throw new Error("Requested message is not the latest user message");
      }
      target = { role: "user", entryId: latest.id };
    }
    const resolved = resolveSessionNodeTarget(branch, target, { mode: "retry" });
    const customTurnInput = resolved.turnInputEntry?.type === "custom_message";
    if (customTurnInput && replacementText != null) {
      throw new Error("custom turn inputs cannot be edited during retry");
    }
    const projectUserMessage = !!resolved.userEntry
      && !isHiddenTurnInputMessage(resolved.userEntry.message);
    const original = resolved.userEntry
      ? promptPayloadFromUserMessage(resolved.userEntry.message)
      : promptPayloadFromUserMessage({ content: resolved.turnInputEntry?.content });
    const originalEnvelopeDisplay = resolved.userEntry
      ? displayMessageFromUserEnvelope(branch, resolved.userEntry.id)
      : {};
    const originalVisibleText = resolved.userEntry
      ? (originalEnvelopeDisplay.text ?? visibleUserText(original.text))
      : "";
    const promptText = replacementText == null
      ? original.text
      : replaceVisiblePromptText(original.text, originalVisibleText, String(replacementText));

    const imageAttachmentPaths = customTurnInput ? [] : attachedMediaPathsFromText(promptText, "image");
    const videoAttachmentPaths = customTurnInput ? [] : attachedMediaPathsFromText(promptText, "video");
    const audioAttachmentPaths = customTurnInput ? [] : attachedMediaPathsFromText(promptText, "audio");
    const mediaDeps = { ...deps, engine, sessionPath };
    const images = customTurnInput
      ? []
      : await completeMediaPayloads(original.images, imageAttachmentPaths, "image", mediaDeps);
    const videos = customTurnInput
      ? []
      : await completeMediaPayloads(original.videos, videoAttachmentPaths, "video", mediaDeps);
    const audios = customTurnInput
      ? []
      : await completeMediaPayloads(original.audios, audioAttachmentPaths, "audio", mediaDeps);
    const nextDisplayMessage = customTurnInput
      ? {}
      : canonicalizeRetryDisplayMessage(engine, sessionPath, {
          ...originalEnvelopeDisplay,
          ...(displayMessage || {}),
          text: displayMessage?.text
            ?? (replacementText == null ? originalVisibleText : String(replacementText)),
        });

    const retainedEntries = retainedEntriesBeforeRetry(branch, resolved.retryBranchParentId);
    const discardedEntries = branch.slice(retainedEntries.length);
    const retainedTaskIds = collectStructuredBackgroundTaskIds(retainedEntries);
    const discardedTaskIds = collectStructuredBackgroundTaskIds(discardedEntries)
      .filter((taskId) => !retainedTaskIds.includes(taskId));
    const retainedMessageCount = countMemoryMessages(retainedEntries);
    const projectedSessionFiles = projectSessionFilesForRetry(engine, sessionPath, customTurnInput
      ? [retainedEntries]
      : [retainedEntries, promptText, nextDisplayMessage]);
    const invalidateDerivedState = deps.invalidateDerivedState || invalidateSessionDerivedState;
    let branchCommitted = false;
    const commitRetryBranch = () => {
      if (branchCommitted) return;
      if (typeof session.sessionManager.appendCustomEntry !== "function") {
        throw new Error("session retry requires durable branch commits");
      }
      if (typeof engine.setSessionBranchHead !== "function") {
        throw new Error("session branch persistence is unavailable");
      }
      const originalLeafId = session.sessionManager.getLeafId?.() || null;
      let deferredSuppressionReceipt = null;
      let branchHeadPersisted = false;
      let resetMarkerAttempted = false;
      let rollbackReason = "branch_commit_failed";
      try {
        branchBeforeResolvedTurnInput(session, resolved);
        engine.setSessionBranchHead(sessionPath, {
          leafId: session.sessionManager.getLeafId?.() ?? null,
          reason: "replay_rewind",
        });
        branchHeadPersisted = true;
        resetMarkerAttempted = true;
        session.sessionManager.appendCustomEntry(SESSION_BRANCH_RESET_RECORD_TYPE, {
          sourceEntryId: resolved.turnInputEntry.id,
          target: resolved.target,
          retainedMessageCount,
          timestamp: Date.now(),
        });

        rollbackReason = "deferred_suppression_failed";
        const suppression = suppressDiscardedDeferredTasks(engine, {
          sessionId,
          sessionPath,
          taskIds: discardedTaskIds,
        });
        deferredSuppressionReceipt = suppression?.receipt || null;

        rollbackReason = "runtime_projection_failed";
        replaceAgentMessagesFromBranch(session);

        // Derived memory is the final reversible write. If runtime projection
        // fails, keep the old summary/facts intact and restore the old leaf.
        rollbackReason = "memory_invalidation_failed";
        const invalidationResult = invalidateDerivedState(engine, {
          sessionId,
          sessionPath,
          retainedMessageCount,
        });
        if (invalidationResult && typeof invalidationResult.then === "function") {
          throw new TypeError("session retry memory invalidation must be synchronous");
        }
      } catch (error) {
        try {
          restoreDiscardedDeferredTasks(engine, deferredSuppressionReceipt);
        } catch (restoreError) {
          console.warn(`session retry deferred rollback failed for ${sessionId || sessionPath}: ${restoreError.message}`);
        }
        if (resetMarkerAttempted) {
          restoreRetryBranch(
            session,
            originalLeafId,
            resolved,
            rollbackReason,
          );
        } else {
          restoreBranchLeaf(session, originalLeafId);
        }
        if (branchHeadPersisted) {
          try {
            engine.setSessionBranchHead(sessionPath, {
              leafId: originalLeafId,
              reason: "replay_rollback",
            });
          } catch (restoreError) {
            console.warn(`session retry branch-head rollback failed for ${sessionId || sessionPath}: ${restoreError.message}`);
          }
        }
        throw error;
      }
      branchCommitted = true;

      // Delivery is fenced and every reversible commit step has succeeded.
      // Runtime cancellation is intentionally last: AbortController signals
      // cannot be rolled back, while a failed cancellation can no longer leak a
      // result into this session because DeferredResultStore owns delivery.
      cancelDiscardedBackgroundTasks(engine, {
        sessionId,
        sessionPath,
        taskIds: discardedTaskIds,
      });

      const todos = extractLatestTodos(session.sessionManager.buildSessionContext?.().messages || []) || [];
      engine.emitEvent?.({
        type: "session_branch_reset",
        ...(sessionId ? { sessionId } : {}),
        messageId: resolved.turnInputEntry.id,
        projectionMessageId: projectUserMessage
          ? resolved.turnInputEntry.id
          : (resolved.turnStartAssistantEntry?.id || resolved.selectedEntry?.id || null),
        clientMessageId: clientMessageId || null,
        todos,
        sessionFiles: projectedSessionFiles,
        discardedTaskIds,
      }, sessionPath);
    };

    let result;
    if (customTurnInput) {
      const deliverCustomMessage = deps.deliverCustomMessage
        || (typeof engine.deliverCustomMessage === "function"
          ? engine.deliverCustomMessage.bind(engine)
          : null);
      if (!deliverCustomMessage) throw new Error("custom turn retry delivery is unavailable");
      result = await deliverCustomMessage(sessionPath, {
        customType: resolved.turnInputEntry.customType,
        content: resolved.turnInputEntry.content,
        display: resolved.turnInputEntry.display,
        ...(resolved.turnInputEntry.details !== undefined
          ? { details: resolved.turnInputEntry.details }
          : {}),
      }, {
        triggerTurn: true,
        requireIdle: true,
        beforeInputSideEffects: commitRetryBranch,
      });
    } else {
      result = await submit(engine, {
        ...(sessionId ? { sessionId } : {}),
        sessionPath,
        text: promptText,
        images: images.length ? images : undefined,
        imageAttachmentPaths: imageAttachmentPaths.length ? imageAttachmentPaths : undefined,
        videos: videos.length ? videos : undefined,
        videoAttachmentPaths: videoAttachmentPaths.length ? videoAttachmentPaths : undefined,
        audios: audios.length ? audios : undefined,
        audioAttachmentPaths: audioAttachmentPaths.length ? audioAttachmentPaths : undefined,
        clientMessageId: clientMessageId || undefined,
        displayMessage: nextDisplayMessage,
        uiContext,
        preservePromptEnvelope: true,
        projectUserMessage,
        beforeInputSideEffects: commitRetryBranch,
      });
    }
    // Focused test doubles may not invoke the commit hook. A successful delivery
    // still commits exactly once; failed preflight paths never reach here.
    commitRetryBranch();
    return result;
  } finally {
    releaseOperation();
  }
}

function resolveSessionIdentity(engine, opts, allowLegacyPath) {
  const requestedSessionId = typeof opts.sessionId === "string" ? opts.sessionId.trim() : "";
  const requestedSessionPath = typeof opts.sessionPath === "string"
    ? opts.sessionPath
    : (typeof opts.path === "string" ? opts.path : "");

  if (!requestedSessionId) {
    if (!allowLegacyPath) throw new Error("sessionId is required");
    if (!requestedSessionPath) throw new Error("sessionPath is required");
    const resolvedSessionId = safeSessionIdForPath(engine, requestedSessionPath);
    return {
      sessionId: resolvedSessionId,
      sessionPath: requestedSessionPath,
      ownerAgentId: null,
    };
  }

  const manifest = engine.getSessionManifest?.(requestedSessionId) || null;
  if (typeof engine.getSessionManifest === "function" && !manifest) {
    throw new Error(`session not found for ${requestedSessionId}`);
  }
  const canonicalPath = manifest?.currentLocator?.path || requestedSessionPath;
  if (!canonicalPath) throw new Error(`session path not found for ${requestedSessionId}`);
  if (requestedSessionPath && requestedSessionPath !== canonicalPath) {
    throw new Error("session identity mismatch");
  }
  const pathSessionId = safeSessionIdForPath(engine, canonicalPath);
  if (pathSessionId && pathSessionId !== requestedSessionId) {
    throw new Error("session identity mismatch");
  }
  return {
    sessionId: requestedSessionId,
    sessionPath: canonicalPath,
    ownerAgentId: manifest?.ownerAgentId || null,
  };
}

function safeSessionIdForPath(engine, sessionPath) {
  try {
    const sessionId = engine.getSessionIdForPath?.(sessionPath);
    return typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : null;
  } catch {
    return null;
  }
}

function invalidateSessionDerivedState(engine, ref) {
  if (!ref.sessionId) return null; // legacy path-only compatibility has no stable key
  const ownerAgentId = engine.resolveSessionOwnership?.(ref.sessionPath)?.agentId
    || engine.getSessionManifest?.(ref.sessionId)?.ownerAgentId
    || null;
  if (!ownerAgentId) throw new Error(`session owner unavailable for ${ref.sessionId}`);
  const ownerAgent = engine.getAgent?.(ownerAgentId) || null;
  if (!ownerAgent) throw new Error(`session owner runtime unavailable for ${ownerAgentId}`);

  if (typeof ownerAgent.memoryTicker?.invalidateSessionDerivedState === "function") {
    return ownerAgent.memoryTicker.invalidateSessionDerivedState(ref);
  }
  return invalidateSessionDerivedStateSync({
    sessionId: ref.sessionId,
    retainedMessageCount: ref.retainedMessageCount,
    summaryManager: ownerAgent.summaryManager,
    factStore: ownerAgent.factStore,
  });
}

function retainedEntriesBeforeRetry(branch, retryBranchParentId) {
  if (!retryBranchParentId) return [];
  const parentIndex = branch.findIndex((entry) => entry?.id === retryBranchParentId);
  if (parentIndex < 0) throw new Error("session retry branch parent is unavailable");
  return branch.slice(0, parentIndex + 1);
}

export function collectStructuredBackgroundTaskIds(entries) {
  const ids = new Set<string>();
  const seen = new WeakSet<object>();
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const [key, nested] of Object.entries(value)) {
      if (BACKGROUND_TASK_ID_KEYS.has(key) && typeof nested === "string" && nested.trim()) {
        ids.add(nested.trim());
      }
      visit(nested);
    }
  };
  visit(Array.isArray(entries) ? entries : []);
  return [...ids];
}

function suppressDiscardedDeferredTasks(engine, { sessionId, sessionPath, taskIds }) {
  if (!taskIds.length) return { receipt: [] };
  const store = engine.deferredResults;
  if (!store) return { receipt: [] };
  if (typeof store.suppressTaskIdsForSession !== "function") {
    const hasOwnedTask = taskIds.some((taskId) => (
      backgroundRecordBelongsToSession(store.query?.(taskId), { sessionId, sessionPath })
    ));
    if (hasOwnedTask) throw new Error("session retry deferred delivery fencing is unavailable");
    return { receipt: [] };
  }
  return store.suppressTaskIdsForSession(
    { sessionId, sessionPath },
    taskIds,
    "discarded by session retry",
  );
}

function restoreDiscardedDeferredTasks(engine, receipt) {
  if (!receipt?.length) return;
  const store = engine.deferredResults;
  if (typeof store?.restoreSuppressedTaskIds !== "function") {
    throw new Error("session retry deferred delivery rollback is unavailable");
  }
  store.restoreSuppressedTaskIds(receipt);
}

function cancelDiscardedBackgroundTasks(engine, { sessionId, sessionPath, taskIds }) {
  if (!taskIds.length) return;
  const reason = "discarded by session retry";
  const failures = [];
  for (const taskId of taskIds) {
    const task = engine.taskRegistry?.query?.(taskId) || null;
    if (
      ACTIVE_BACKGROUND_TASK_STATUSES.has(task?.status)
      && backgroundRecordBelongsToSession(task, { sessionId, sessionPath })
    ) {
      try {
        const result = engine.taskRegistry.abort?.(taskId, reason);
        if (result === "no_handler") {
          engine.taskRegistry.update?.(taskId, { status: "aborted", error: reason });
        }
      } catch (error) {
        failures.push(`task ${taskId}: ${error.message}`);
      }
    }

    const run = engine.subagentRuns?.query?.(taskId) || null;
    if (run?.status === "pending" && backgroundRecordBelongsToSession(run, { sessionId, sessionPath })) {
      try {
        engine.subagentRuns.abort?.(taskId, reason);
      } catch (error) {
        failures.push(`run ${taskId}: ${error.message}`);
      }
    }
  }
  if (failures.length) {
    console.warn(`session retry background cancellation incomplete for ${sessionId || sessionPath}: ${failures.join("; ")}`);
  }
}

function backgroundRecordBelongsToSession(record, { sessionId, sessionPath }) {
  if (!record || typeof record !== "object") return false;
  const recordSessionId = record.sessionId
    || record.sessionRef?.sessionId
    || record.parentSessionId
    || record.parentSessionRef?.sessionId
    || null;
  if (recordSessionId) return !!sessionId && recordSessionId === sessionId;
  const recordSessionPath = record.sessionPath
    || record.sessionRef?.sessionPath
    || record.parentSessionPath
    || record.parentSessionRef?.sessionPath
    || null;
  return !!sessionPath && recordSessionPath === sessionPath;
}

function countMemoryMessages(entries) {
  return entries.filter((entry) => (
    entry?.type === "message"
    && (entry.message?.role === "user" || entry.message?.role === "assistant")
  )).length;
}

function projectSessionFilesForRetry(engine, sessionPath, references) {
  if (typeof engine.listSessionFiles !== "function") return [];
  const files = engine.listSessionFiles(sessionPath, { references });
  if (!Array.isArray(files)) return [];
  return files
    .map((file) => typeof engine.serializeSessionFile === "function"
      ? engine.serializeSessionFile(file)
      : file)
    .filter(Boolean);
}

function restoreRetryBranch(session, originalLeafId, resolved, reason) {
  if (originalLeafId) session.sessionManager.branch(originalLeafId);
  else session.sessionManager.resetLeaf();
  // Appending on the original leaf makes the rollback itself the last durable
  // tree entry, so reopening the append-only JSONL cannot select the failed branch.
  try {
    session.sessionManager.appendCustomEntry(SESSION_BRANCH_RESET_RECORD_TYPE, {
      sourceEntryId: resolved.turnInputEntry.id,
      target: resolved.target,
      rolledBack: true,
      reason,
      timestamp: Date.now(),
    });
  } finally {
    // Keep the live agent aligned with the restored branch even when persisting
    // the rollback marker fails; the persistence failure still reaches the caller.
    replaceAgentMessagesFromBranch(session);
  }
}

function findLatestUserEntry(branch) {
  if (!Array.isArray(branch)) return null;
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const entry = branch[i];
    if (entry?.type === "message" && entry.message?.role === "user") return entry;
  }
  return null;
}

function isUserMessageEntry(entry) {
  return entry?.type === "message" && entry.message?.role === "user";
}

function findPrecedingTurnInputIndex(branch, beforeIndex) {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    if (isSessionTurnInputEntry(branch[index])) return index;
  }
  return -1;
}

function findNextTurnInputIndex(branch, startIndex) {
  for (let index = startIndex; index < branch.length; index += 1) {
    if (isSessionTurnInputEntry(branch[index])) return index;
  }
  return -1;
}

function findUserEnvelopeStartIndex(branch, userIndex) {
  let index = userIndex;
  while (index > 0 && isLucUserEnvelopeEntry(branch[index - 1])) index -= 1;
  return index;
}

function isLucUserEnvelopeEntry(entry) {
  return entry?.type === "custom" && LUC_USER_ENVELOPE_TYPES.has(entry.customType);
}

function displayMessageFromUserEnvelope(branch, userEntryId) {
  const userIndex = branch.findIndex((entry) => entry?.id === userEntryId);
  if (userIndex < 0) return {};
  const startIndex = findUserEnvelopeStartIndex(branch, userIndex);
  const displayMessage: Record<string, any> = {};
  for (const entry of branch.slice(startIndex, userIndex)) {
    const data = entry?.data && typeof entry.data === "object" ? entry.data : {};
    if (entry.customType === MESSAGE_PRESENTATION_RECORD_TYPE) {
      if (typeof data.displayText === "string") displayMessage.text = data.displayText;
      if (Array.isArray(data.sessionRefs)) displayMessage.sessionRefs = data.sessionRefs;
      if (Array.isArray(data.agentMentions)) displayMessage.agentMentions = data.agentMentions;
      if (data.agentReviewRequest) displayMessage.agentReviewRequest = data.agentReviewRequest;
    } else if (entry.customType === MESSAGE_ORIGIN_RECORD_TYPE) {
      if (data.source) displayMessage.source = data.source;
      if (data.bridgeSessionKey) displayMessage.bridgeSessionKey = data.bridgeSessionKey;
      if (data.origin) displayMessage.origin = data.origin;
      if (displayMessage.text == null && typeof data.displayText === "string") {
        displayMessage.text = data.displayText;
      }
    } else if (entry.customType === AGENT_REVIEW_RECORD_TYPE) {
      displayMessage.agentReview = { ...data };
    }
  }
  return displayMessage;
}

function promptPayloadFromUserMessage(message) {
  const content = message?.content;
  if (typeof content === "string") {
    return { text: content, images: [], videos: [], audios: [] };
  }
  if (!Array.isArray(content)) return { text: "", images: [], videos: [], audios: [] };
  const text = content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
  const media = (kind) => content
    .filter((block) => block?.type === kind)
    .map((block) => ({ ...block }));
  return {
    text,
    images: media("image"),
    videos: media("video"),
    audios: media("audio"),
  };
}

function attachedMediaPathsFromText(text, kind) {
  const re = new RegExp(`\\[attached_${kind}:\\s*([^\\]]+)\\]`, "g");
  const paths = [];
  const seen = new Set();
  for (const match of String(text || "").matchAll(re)) {
    const filePath = String(match[1] || "").trim();
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    paths.push(filePath);
  }
  return paths;
}

async function completeMediaPayloads(existing, paths, kind, deps) {
  const payloads = [...(existing || [])];
  const missingPaths = paths.slice(payloads.length);
  const readFile = deps.readFile || fsp.readFile;
  const fallbackMime = kind === "video" ? "video/mp4" : kind === "audio" ? "audio/wav" : "image/png";
  for (const markerPath of missingPaths) {
    const activeFile = deps.engine?.resolveActiveSessionFile?.({
      filePath: markerPath,
      sessionPath: deps.sessionPath || null,
    }) || null;
    const bytesPath = activeFile?.realPath || activeFile?.filePath || markerPath;
    const bytes = Buffer.from(await readFile(bytesPath));
    payloads.push({
      type: kind,
      data: bytes.toString("base64"),
      mimeType: detectMime(bytes, fallbackMime, markerPath),
    });
  }
  return payloads;
}

function canonicalizeRetryDisplayMessage(engine, sessionPath, displayMessage) {
  if (!Array.isArray(displayMessage?.attachments)) return displayMessage;
  if (typeof engine?.resolveActiveSessionFile !== "function") return displayMessage;
  const attachments = displayMessage.attachments.flatMap((attachment) => {
    const file = engine.resolveActiveSessionFile({
      fileId: attachment?.fileId || null,
      filePath: attachment?.fileId ? null : (attachment?.path || null),
      sessionPath,
    });
    if (!file) return [];
    const fileId = file.id || file.fileId || null;
    const filePath = file.filePath || file.realPath || null;
    if (!fileId || !filePath) return [];
    return [{
      ...attachment,
      fileId,
      path: filePath,
      ...(file.sessionId ? { sessionId: file.sessionId } : {}),
      ...(file.sessionPath ? { sessionPath: file.sessionPath } : {}),
      name: attachment?.name || file.displayName || file.filename || file.label || fileId,
      mimeType: attachment?.mimeType || file.mime,
      isDir: file.isDirectory === true || attachment?.isDir === true,
      status: file.status || attachment?.status,
      missingAt: file.missingAt ?? attachment?.missingAt,
    }];
  });
  return { ...displayMessage, attachments };
}

function replaceVisiblePromptText(originalText, visibleText, replacementText) {
  const original = String(originalText || "");
  const visible = String(visibleText || "");
  if (visible && original.endsWith(visible)) {
    return `${original.slice(0, original.length - visible.length)}${replacementText}`;
  }
  const prefix = leadingPromptEnvelope(original);
  return prefix ? `${prefix}${replacementText}` : replacementText;
}

function leadingPromptEnvelope(text) {
  const lines = String(text || "").split(/\r?\n/);
  const kept = [];
  let index = 0;
  // A prompt may lead with a reference listing, a reminder broadcast, or both,
  // so every envelope at the head is consumed rather than just the first kind.
  while (index < lines.length) {
    const header = lines[index];
    const closing = header.startsWith(REMINDER_BLOCK_PREFIX)
      ? REMINDER_BLOCK_END
      : header.trim() === REFERENCE_BLOCK_PREFIX
        ? REFERENCE_BLOCK_END
        : null;
    if (!closing) break;
    while (index < lines.length) {
      const line = lines[index++];
      kept.push(line);
      if (line.trim() === closing) break;
    }
    while (index < lines.length && !lines[index].trim()) kept.push(lines[index++]);
  }
  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (ATTACHMENT_MARKER_RE.test(trimmed) || SESSION_FILE_MARKER_RE.test(trimmed)) {
      kept.push(line);
      index += 1;
      continue;
    }
    if (!trimmed && kept.length > 0) {
      kept.push(line);
      index += 1;
      continue;
    }
    break;
  }
  return kept.length ? `${kept.join("\n")}\n` : "";
}

function visibleUserText(text) {
  return visiblePromptText(text);
}

function branchBeforeResolvedTurnInput(session, resolved) {
  if (resolved.retryBranchParentId) {
    session.sessionManager.branch(resolved.retryBranchParentId);
  } else {
    session.sessionManager.resetLeaf();
  }
  replaceAgentMessagesFromBranch(session);
}

function restoreBranchLeaf(session, leafId) {
  if (leafId == null) session.sessionManager.resetLeaf();
  else session.sessionManager.branch(leafId);
  replaceAgentMessagesFromBranch(session);
}

function replaceAgentMessagesFromBranch(session) {
  const context = session.sessionManager.buildSessionContext();
  if (session.agent?.replaceMessages) {
    session.agent.replaceMessages(context.messages);
  } else if (session.agent?.state) {
    session.agent.state.messages = context.messages;
  }
}
