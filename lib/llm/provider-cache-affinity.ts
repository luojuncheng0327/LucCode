const PROVIDER_CACHE_AFFINITY_MAX_LENGTH = 64;

export function normalizeProviderCacheAffinityKey(value: any, fallback: any = null): string | null {
  const candidate = typeof value === "string" && value.trim()
    ? value.trim()
    : (typeof fallback === "string" && fallback.trim() ? fallback.trim() : "");
  if (!candidate) return null;
  return Array.from(candidate).slice(0, PROVIDER_CACHE_AFFINITY_MAX_LENGTH).join("");
}

export function applyProviderCacheAffinityToPayload(payload: any, affinityKey: any) {
  const normalized = normalizeProviderCacheAffinityKey(affinityKey);
  if (!normalized || !payload || typeof payload !== "object" || Array.isArray(payload)) return payload;

  let next = payload;
  for (const field of ["prompt_cache_key", "promptCacheKey"]) {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) continue;
    if (next === payload) next = { ...payload };
    next[field] = normalized;
  }
  return next;
}

function affinityHeadersForModel(model: any, affinityKey: string) {
  switch (model?.api) {
    case "openai-responses":
      return {
        ...(model?.compat?.sendSessionIdHeader === false ? {} : { session_id: affinityKey }),
        "x-client-request-id": affinityKey,
      };
    case "openai-completions":
      return model?.compat?.sendSessionAffinityHeaders === true
        ? {
            session_id: affinityKey,
            "x-client-request-id": affinityKey,
            "x-session-affinity": affinityKey,
          }
        : {};
    case "mistral-conversations":
      return { "x-affinity": affinityKey };
    case "anthropic-messages":
      return model?.compat?.sendSessionAffinityHeaders === true
        ? { "x-session-affinity": affinityKey }
        : {};
    default:
      return {};
  }
}

/**
 * Preserve the real Pi Session ID for transport/resource ownership while
 * routing provider prefix-cache fields through the immutable Fork lineage key.
 */
export function withProviderCacheAffinity(options: any, model: any, affinityKey: any) {
  const normalized = normalizeProviderCacheAffinityKey(affinityKey);
  if (!normalized || options?.cacheRetention === "none") return options;

  const baseOptions = options && typeof options === "object" ? options : {};
  const baseOnPayload = typeof baseOptions.onPayload === "function" ? baseOptions.onPayload : null;
  const affinityHeaders = affinityHeadersForModel(model, normalized);
  return {
    ...baseOptions,
    ...(Object.keys(affinityHeaders).length > 0
      ? { headers: { ...(baseOptions.headers || {}), ...affinityHeaders } }
      : {}),
    onPayload: async (payload: any, requestModel: any) => {
      const transformed = baseOnPayload
        ? await baseOnPayload(payload, requestModel)
        : payload;
      return applyProviderCacheAffinityToPayload(
        transformed === undefined ? payload : transformed,
        normalized,
      );
    },
  };
}
