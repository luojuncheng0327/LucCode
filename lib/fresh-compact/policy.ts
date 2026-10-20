import crypto from "crypto";
import { getLogicalDay } from "../time-utils.ts";

export function getFreshCompactDate(now = new Date()) {
  return getLogicalDay(now).logicalDate;
}

function stableStringify(value: any) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringify(value[key])}`
  ).join(",")}}`;
}

export function hashFreshCompactValue(value: any) {
  return crypto
    .createHash("sha256")
    .update(typeof value === "string" ? value : stableStringify(value))
    .digest("hex");
}

export function buildFreshCompactSnapshot({ systemPrompt = "", state = {} } = {}) {
  return {
    promptHash: hashFreshCompactValue(String(systemPrompt || "")),
    stateHash: hashFreshCompactValue(state || {}),
  };
}

/** compaction "无事可做"的错误归类：fresh compact 视为满足（快照仍可刷新），其余照常抛出 */
export function getFreshCompactNoopReason(error: any) {
  const message = error?.message || String(error || "");
  if (message.includes("Already compacted")) return "already_compacted";
  if (message.includes("Nothing to compact")) return "nothing_to_compact";
  return null;
}

export function normalizeFreshCompactNoopReason(reason: any) {
  const value = String(reason || "").trim();
  if (value === "already_compacted" || value === "nothing_to_compact") return value;
  return null;
}

function getStoredFreshMeta(meta: Record<string, any> = {}) {
  const nested = meta?.freshCompact && typeof meta.freshCompact === "object"
    ? meta.freshCompact
    : null;
  return nested || meta || {};
}

export function shouldRunFreshCompact({ meta = {} as Record<string, any>, now = new Date(), force = false } = {}) {
  if (force) return { run: true, reason: "manual" };
  const stored = getStoredFreshMeta(meta);
  const today = getFreshCompactDate(now);
  const lastDate = stored.lastFreshCompactDate || null;
  if (lastDate !== today) return { run: true, reason: "daily" };
  return { run: false, reason: null };
}

export function buildFreshCompactMetaPatch({
  snapshot,
  reason,
  now = new Date(),
  usage = {} as Record<string, any>,
}: { snapshot?: any; reason?: any; now?: Date; usage?: Record<string, any> } = {}) {
  const date = now instanceof Date ? now : new Date(now);
  return {
    lastFreshCompactDate: getFreshCompactDate(date),
    lastFreshCompactedAt: date.toISOString(),
    freshCompactPromptHash: snapshot?.promptHash || null,
    freshCompactStateHash: snapshot?.stateHash || null,
    freshCompactReason: reason || "manual",
    freshCompactTokensBefore: usage?.tokensBefore ?? null,
    freshCompactTokensAfter: usage?.tokensAfter ?? null,
    freshCompactContextWindow: usage?.contextWindow ?? null,
  };
}
