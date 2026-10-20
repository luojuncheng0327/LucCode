export const CACHE_STRATEGIES = Object.freeze({
  SESSION_SNAPSHOT: "session_snapshot",
  UTILITY_TEMPLATE: "utility_template",
  CACHE_RECOVERY: "cache_recovery",
});

const KNOWN_STRATEGIES: Set<string> = new Set(Object.values(CACHE_STRATEGIES));

export function normalizeCacheStrategy(value: any) {
  const strategy = String(value || "");
  if (!KNOWN_STRATEGIES.has(strategy)) {
    throw new Error(`unknown cache strategy: ${strategy || "(empty)"}`);
  }
  return strategy;
}

function normalizeString(value: any) {
  return typeof value === "string" ? value : String(value ?? "");
}

function normalizeDiffs(value: any) {
  return Array.isArray(value) ? value : [];
}

export function buildCacheStrategyMetadata({
  cacheStrategy,
  cacheGroup,
  templateVersion = "v1",
  cachePrefixHash = "",
  parentCachePrefixHash = "",
  strict,
  degradeReason = "",
  contractDiffs = [],
}: Record<string, any> = {}) {
  const strategy = normalizeCacheStrategy(cacheStrategy);
  return {
    cacheStrategy: strategy,
    cacheGroup: normalizeString(cacheGroup || "unknown"),
    templateVersion: normalizeString(templateVersion || "v1"),
    strict: typeof strict === "boolean" ? strict : strategy === CACHE_STRATEGIES.SESSION_SNAPSHOT,
    cachePrefixHash: normalizeString(cachePrefixHash),
    parentCachePrefixHash: normalizeString(parentCachePrefixHash),
    degradeReason: normalizeString(degradeReason),
    contractDiffs: normalizeDiffs(contractDiffs),
  };
}
