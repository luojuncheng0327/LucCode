import fs from "fs";
import path from "path";
import crypto from "crypto";

const TAIL_READ_THRESHOLD = 256 * 1024;

export class SessionBranchError extends Error {
  declare code: string;
  declare details: any;

  constructor(code, message, details: any = {}) {
    super(message);
    this.name = "SessionBranchError";
    this.code = code;
    this.details = details;
  }
}

function parseFullSessionEntries(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    throw new SessionBranchError(
      "session_branch_read_failed",
      `Could not read session JSONL: ${error?.message || error}`,
      { filePath },
    );
  }

  const entries = [];
  for (const [lineIndex, line] of raw.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch (error) {
      throw new SessionBranchError(
        "session_branch_invalid_json",
        `Session JSONL line ${lineIndex + 1} is invalid JSON.`,
        { filePath, line: lineIndex + 1, cause: error?.message || String(error) },
      );
    }
  }
  return entries;
}

function normalizedEntryIdentity(entry) {
  return JSON.stringify({
    id: entry.id,
    parentId: entry.parentId ?? null,
    type: entry.type || null,
    ...(entry.type === "message" && entry.message
      ? {
          timestamp: entry.timestamp || null,
          message: {
            role: entry.message.role || null,
            content: entry.message.content ?? null,
          },
        }
      : {}),
  });
}

export function computeSessionLineageMetadata(lineage: any[] = []) {
  const rootLineageHash = crypto.createHash("sha256").update("").digest("hex");
  let currentHash = rootLineageHash;
  const prefixHashes: Record<string, string> = {};
  const normalized = [];
  for (const entry of lineage) {
    currentHash = crypto
      .createHash("sha256")
      .update(currentHash)
      .update("\n")
      .update(normalizedEntryIdentity(entry))
      .digest("hex");
    prefixHashes[entry.id] = currentHash;
    normalized.push({
      id: entry.id,
      parentId: entry.parentId ?? null,
      type: entry.type || null,
      lineageHash: currentHash,
    });
  }
  return {
    lineage: normalized,
    lineageHash: currentHash,
    rootLineageHash,
    prefixHashes,
  };
}

function buildValidatedEntryIndex(entries, filePath) {
  let sessionEntries = entries.filter((entry) => entry?.type !== "session");
  const entriesWithIds = sessionEntries.filter((entry) => typeof entry?.id === "string" && entry.id);
  let legacySyntheticIds = false;
  if (sessionEntries.length > 0 && entriesWithIds.length === 0) {
    legacySyntheticIds = true;
    sessionEntries = sessionEntries.map((entry, index) => ({
      ...entry,
      id: `legacy-line-${index + 1}`,
      parentId: index === 0 ? null : `legacy-line-${index}`,
    }));
  } else if (entriesWithIds.length !== sessionEntries.length) {
    throw new SessionBranchError(
      "session_branch_invalid_id",
      "Session entries mix stable ids with legacy id-less entries.",
      { filePath },
    );
  }
  const byId = new Map();
  for (const entry of sessionEntries) {
    if (typeof entry?.id !== "string" || !entry.id) {
      throw new SessionBranchError(
        "session_branch_invalid_id",
        "Session entry is missing a stable id.",
        { filePath, entryType: entry?.type || null },
      );
    }
    if (byId.has(entry.id)) {
      throw new SessionBranchError(
        "session_branch_duplicate_id",
        `Session entry id is duplicated: ${entry.id}`,
        { filePath, entryId: entry.id },
      );
    }
    byId.set(entry.id, entry);
  }

  for (const entry of sessionEntries) {
    if (entry.parentId != null && !byId.has(entry.parentId)) {
      throw new SessionBranchError(
        "session_branch_dangling_parent",
        `Session entry ${entry.id} points to missing parent ${entry.parentId}.`,
        { filePath, entryId: entry.id, parentId: entry.parentId },
      );
    }
  }

  const state = new Map();
  const visit = (entry) => {
    const current = state.get(entry.id) || 0;
    if (current === 1) {
      throw new SessionBranchError(
        "session_branch_cycle",
        `Session lineage contains a cycle at ${entry.id}.`,
        { filePath, entryId: entry.id },
      );
    }
    if (current === 2) return;
    state.set(entry.id, 1);
    if (entry.parentId != null) visit(byId.get(entry.parentId));
    state.set(entry.id, 2);
  };
  for (const entry of sessionEntries) visit(entry);

  return { sessionEntries, byId, legacySyntheticIds };
}

function lineageToRoot(leafId, byId) {
  if (leafId == null) return [];
  const reversed = [];
  let current = byId.get(leafId);
  while (current) {
    reversed.push(current);
    current = current.parentId == null ? null : byId.get(current.parentId);
  }
  return reversed.reverse();
}

function isDescendantOf(candidateLeafId, ancestorLeafId, byId) {
  if (candidateLeafId == null) return ancestorLeafId == null;
  if (ancestorLeafId == null) return true;
  let current = byId.get(candidateLeafId);
  while (current) {
    if (current.id === ancestorLeafId) return true;
    current = current.parentId == null ? null : byId.get(current.parentId);
  }
  return false;
}

/**
 * Resolve and read the semantic current branch of a Pi JSONL session.
 *
 * `branchHead` is deliberately a row-or-null value: a missing row means a
 * legacy session, while a present row with `leafId:null` means an explicit
 * selection before the first entry.
 */
export function readCurrentSessionBranch(filePath, opts: { since?: any; branchHead?: any } = {}) {
  const entries = parseFullSessionEntries(filePath);
  return projectCurrentSessionBranchEntries(entries, { ...opts, filePath });
}

export function projectCurrentSessionBranchEntries(
  entries,
  opts: { since?: any; branchHead?: any; filePath?: string } = {},
) {
  const filePath = opts.filePath || "(in-memory session)";
  const { sessionEntries, byId, legacySyntheticIds } = buildValidatedEntryIndex(entries, filePath);
  const physicalTailLeafId = sessionEntries.at(-1)?.id || null;
  const hasPersistedHead = opts.branchHead != null;
  const persistedLeafId = hasPersistedHead ? (opts.branchHead.leafId ?? null) : null;

  if (hasPersistedHead && persistedLeafId != null && !byId.has(persistedLeafId)) {
    throw new SessionBranchError(
      "session_branch_head_missing",
      `Persisted session branch leaf is missing: ${persistedLeafId}`,
      { filePath, leafId: persistedLeafId, sessionId: opts.branchHead.sessionId || null },
    );
  }

  let selectedLeafId = physicalTailLeafId;
  let headResolution = "legacy_tail";
  if (hasPersistedHead) {
    const observedTailLeafId = opts.branchHead.observedTailLeafId ?? null;
    const physicalTailChanged = physicalTailLeafId !== observedTailLeafId;
    const continuesDiscardedObservedTail = observedTailLeafId != null
      && persistedLeafId !== observedTailLeafId
      && isDescendantOf(physicalTailLeafId, observedTailLeafId, byId);
    if (
      physicalTailChanged
      && isDescendantOf(physicalTailLeafId, persistedLeafId, byId)
      && !continuesDiscardedObservedTail
    ) {
      selectedLeafId = physicalTailLeafId;
      headResolution = "append_recovery";
    } else {
      selectedLeafId = persistedLeafId;
      headResolution = "persisted_head";
    }
  }

  const rawLineage = lineageToRoot(selectedLeafId, byId);
  const lineageMetadata = computeSessionLineageMetadata(rawLineage);
  const lineageIndexById = new Map(rawLineage.map((entry, index) => [entry.id, index]));
  const since = opts.since && !Number.isNaN(Date.parse(opts.since))
    ? Date.parse(opts.since)
    : null;
  const messages = [];
  let lastTimestamp = null;
  for (const entry of rawLineage) {
    if (entry.type !== "message" || !entry.message) continue;
    const { role, content } = entry.message;
    if (role !== "user" && role !== "assistant") continue;
    const parsedTimestamp = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    if (since && (Number.isNaN(parsedTimestamp) || parsedTimestamp <= since)) continue;
    messages.push({
      role,
      content,
      timestamp: entry.timestamp || null,
      entryId: entry.id,
      lineageIndex: lineageIndexById.get(entry.id),
    });
    if (entry.timestamp) lastTimestamp = entry.timestamp;
  }

  const recommendedHead = {
    leafId: selectedLeafId,
    observedTailLeafId: physicalTailLeafId,
    reason: headResolution === "append_recovery" ? "append_recovery" : "branch_read",
  };
  return {
    messages,
    lastTimestamp,
    selectedLeafId,
    physicalTailLeafId,
    headResolution,
    legacySyntheticIds,
    recommendedHead,
    ...lineageMetadata,
  };
}

export function sessionIdFromFilename(filename) {
  return filename.replace(/\.jsonl$/, "");
}

export function isSessionJsonlFilename(filename) {
  const name = path.basename(String(filename || ""));
  return !!name
    && name === filename
    && name.endsWith(".jsonl")
    && !name.includes(".repair.jsonl");
}

export function listSessionFiles(sessionDir) {
  const results = [];

  function scanDir(dir, prefix) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!isSessionJsonlFilename(f)) continue;
        const filePath = path.join(dir, f);
        try {
          const stat = fs.statSync(filePath);
          if (stat.isFile()) {
            results.push({
              sessionId: sessionIdFromFilename(path.basename(filePath)),
              filename: prefix ? `${prefix}/${f}` : f,
              filePath,
              mtime: stat.mtime,
            });
          }
        } catch {}
      }
    } catch {}
  }

  if (!sessionDir) return results;
  scanDir(sessionDir, null);
  scanDir(path.join(sessionDir, "bridge", "owner"), "bridge/owner");
  return results;
}

/**
 * 从 session JSONL 文件提取消息列表（带时间戳）。
 *
 * Pi session 是 append-only tree：物理文件可能同时保留已经抛弃的旧分支，
 * 最后一条可解析 tree entry 才是当前 leaf。这里必须先读取完整文件并沿 parentId
 * 回溯 root → leaf，再做时间过滤。只读文件尾部无法证明父链完整，会把记忆/日记
 * 截成残缺上下文；线性扫描则会把隐藏分支重新写进长期记忆。
 *
 * `full` 保留为兼容参数。分支正确性要求所有调用都完整读取。
 */
export function readSessionMessages(filePath, opts: { since?: any; full?: boolean } = {}) {
  const since = opts.since && !Number.isNaN(Date.parse(opts.since))
    ? Date.parse(opts.since)
    : null;
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return { messages: [], lastTimestamp: null };
  }

  const parsedEntries = [];
  let hasTreeEntries = false;
  let leafId = null;
  const byId = new Map();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (!entry || entry.type === "session") continue;
      parsedEntries.push(entry);
      if (typeof entry.id === "string" && entry.id) {
        hasTreeEntries = true;
        leafId = entry.id;
        byId.set(entry.id, entry);
      }
    } catch {
      // 单行损坏只丢弃该行，避免局部坏数据阻断整条记忆/日记链路。
    }
  }

  let activeEntries = parsedEntries;
  if (hasTreeEntries && leafId) {
    const reversed = [];
    const seen = new Set();
    let current = byId.get(leafId);
    while (current && typeof current.id === "string" && !seen.has(current.id)) {
      reversed.push(current);
      seen.add(current.id);
      current = typeof current.parentId === "string" && current.parentId
        ? byId.get(current.parentId)
        : null;
    }
    activeEntries = reversed.reverse();
  }

  const messages = [];
  let lastTimestamp = null;

  for (const entry of activeEntries) {
    if (entry.type !== "message" || !entry.message) continue;
    const { role, content } = entry.message;
    if (role !== "user" && role !== "assistant") continue;
    const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    if (since !== null && (Number.isNaN(ts) || ts <= since)) continue;
    messages.push({ role, content, timestamp: entry.timestamp || null });
    if (entry.timestamp) lastTimestamp = entry.timestamp;
  }

  return { messages, lastTimestamp };
}
