export const AUTO_SEARCH_PROVIDER = "auto";
export const SEARCH_CAPABILITY_KIND = "web.search";

export const SEARCH_API_PROVIDER_IDS = Object.freeze([
  "anysearch",
  "tavily",
  "brave",
  "serper",
] as const);

export const SEARCH_FREE_API_PROVIDER_IDS = Object.freeze([
  "anysearch_free",
] as const);

export const BROWSER_SEARCH_PROVIDER_IDS = Object.freeze([
  "bing_browser",
  "google_browser",
  "duckduckgo_browser",
] as const);

export const SEARCH_CAPABILITY_PROVIDERS = Object.freeze([
  ...SEARCH_API_PROVIDER_IDS.map((id) => ({ id, source: "api", requiresApiKey: true })),
  ...SEARCH_FREE_API_PROVIDER_IDS.map((id) => ({ id, source: "api", requiresApiKey: false })),
  ...BROWSER_SEARCH_PROVIDER_IDS.map((id) => ({ id, source: "browser", requiresApiKey: false })),
]);

const SEARCH_API_PROVIDER_SET = new Set<string>(SEARCH_API_PROVIDER_IDS);
const SEARCH_FREE_API_PROVIDER_SET = new Set<string>(SEARCH_FREE_API_PROVIDER_IDS);
const BROWSER_SEARCH_PROVIDER_SET = new Set<string>(BROWSER_SEARCH_PROVIDER_IDS);

export function normalizeSearchProvider(provider: unknown): string {
  return String(provider || "").trim();
}

export function isSearchApiProvider(provider: unknown): boolean {
  return SEARCH_API_PROVIDER_SET.has(normalizeSearchProvider(provider));
}

export function isFreeSearchApiProvider(provider: unknown): boolean {
  return SEARCH_FREE_API_PROVIDER_SET.has(normalizeSearchProvider(provider));
}

export function isBrowserSearchProvider(provider: unknown): boolean {
  return BROWSER_SEARCH_PROVIDER_SET.has(normalizeSearchProvider(provider));
}

export function isKnownSearchProvider(provider: unknown): boolean {
  const normalized = normalizeSearchProvider(provider);
  return normalized === AUTO_SEARCH_PROVIDER
    || isSearchApiProvider(normalized)
    || isFreeSearchApiProvider(normalized)
    || isBrowserSearchProvider(normalized);
}

export function normalizeSearchApiKeys(raw: unknown): Record<string, string> {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, string> = {};
  for (const provider of SEARCH_API_PROVIDER_IDS) {
    const value = source[provider];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) out[provider] = trimmed;
  }
  return out;
}

export function mergeSearchApiKeys(base: unknown, patch: unknown): Record<string, string> {
  const out = normalizeSearchApiKeys(base);
  const source = patch && typeof patch === "object" && !Array.isArray(patch) ? (patch as Record<string, unknown>) : {};
  for (const provider of SEARCH_API_PROVIDER_IDS) {
    if (!Object.prototype.hasOwnProperty.call(source, provider)) continue;
    const value = source[provider];
    if (value === null || value === undefined || value === "") {
      delete out[provider];
      continue;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) out[provider] = trimmed;
      else delete out[provider];
    }
  }
  return out;
}
