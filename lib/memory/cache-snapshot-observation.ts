import fs from "fs";
import path from "path";
import { atomicWriteSync } from "../../shared/safe-fs.ts";
import {
  CACHE_STRATEGIES,
  normalizeCacheStrategy,
} from "../llm/cache-strategy-contract.ts";

export const CACHE_SNAPSHOT_OBSERVATION_RELATIVE_PATH = path.join(
  "experiments",
  "cache-snapshot-reflection",
  "latest.json",
);

export function cacheSnapshotObservationPath(agentDir) {
  return path.join(agentDir, CACHE_SNAPSHOT_OBSERVATION_RELATIVE_PATH);
}

function finiteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function normalizeDiagnostics(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const requestModel = raw.requestModel && typeof raw.requestModel === "object" && !Array.isArray(raw.requestModel)
    ? {
      id: String(raw.requestModel.id || ""),
      provider: String(raw.requestModel.provider || ""),
      api: String(raw.requestModel.api || ""),
      hasBaseUrl: raw.requestModel.hasBaseUrl === true,
      hasQuirks: raw.requestModel.hasQuirks === true,
    }
    : null;
  return {
    errorName: String(raw.errorName || ""),
    stack: Array.isArray(raw.stack) ? raw.stack.slice(0, 4).map((line) => String(line || "")) : [],
    requestModel,
  };
}

function normalizeObservation(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("cache snapshot observation must be an object");
  }
  const status = ["success", "failed", "skipped"].includes(raw.status) ? raw.status : "failed";
  const mode = ["shadow", "write"].includes(raw.mode) ? raw.mode : "shadow";
  return {
    version: 1,
    agentId: String(raw.agentId || ""),
    sessionPath: String(raw.sessionPath || ""),
    trigger: String(raw.trigger || "unknown"),
    createdAt: raw.createdAt && !Number.isNaN(Date.parse(raw.createdAt))
      ? new Date(raw.createdAt).toISOString()
      : new Date().toISOString(),
    mode,
    status,
    reason: String(raw.reason || ""),
    usage: {
      model: String(raw.usage?.model || ""),
      cachedTokens: finiteNumber(raw.usage?.cachedTokens),
      missTokens: finiteNumber(raw.usage?.missTokens),
      latencyMs: finiteNumber(raw.usage?.latencyMs),
    },
    summaryPreview: String(raw.summaryPreview || ""),
    memoryMdPreview: String(raw.memoryMdPreview || ""),
    baseMemoryMdHash: String(raw.baseMemoryMdHash || ""),
    cacheStrategy: normalizeCacheStrategy(raw.cacheStrategy || CACHE_STRATEGIES.CACHE_RECOVERY),
    strict: raw.strict === true,
    cachePrefixHash: String(raw.cachePrefixHash || ""),
    parentCachePrefixHash: String(raw.parentCachePrefixHash || ""),
    contractDiffs: Array.isArray(raw.contractDiffs) ? raw.contractDiffs : [],
    degradeReason: String(raw.degradeReason || ""),
    diagnostics: normalizeDiagnostics(raw.diagnostics),
  };
}

export function writeCacheSnapshotObservation(agentDir, observation) {
  const normalized = normalizeObservation(observation);
  const filePath = cacheSnapshotObservationPath(agentDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWriteSync(filePath, JSON.stringify(normalized, null, 2) + "\n");
  return normalized;
}

export function readCacheSnapshotObservation(agentDir) {
  try {
    return normalizeObservation(JSON.parse(fs.readFileSync(cacheSnapshotObservationPath(agentDir), "utf-8")));
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

export function deleteCacheSnapshotObservation(agentDir) {
  try {
    fs.unlinkSync(cacheSnapshotObservationPath(agentDir));
    return true;
  } catch (err) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
}
