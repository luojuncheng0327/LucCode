/**
 * web-search.js — web_search 自定义工具
 *
 * 对外暴露一个统一的 web_search tool，支持显式 provider 或 auto fallback。
 *
 * 统一返回格式：[{ title, url, snippet }]
 */

import { Type } from "../pi-sdk/index.ts";
import { loadConfig } from "../memory/config-loader.ts";
import { getLocale, t } from "../i18n.ts";
import { safeParseResponse } from "../../shared/safe-parse.ts";
import { BrowserManager } from "../browser/browser-manager.ts";
import {
  AUTO_SEARCH_PROVIDER,
  BROWSER_SEARCH_PROVIDER_IDS,
  SEARCH_API_PROVIDER_IDS,
  isSearchApiProvider,
  mergeSearchApiKeys,
  normalizeSearchApiKeys,
  normalizeSearchProvider,
} from "../../shared/search-providers.ts";
import {
  SearchRateLimitError,
  createSearchRateLimiter,
  retryAfterMsFromHeaders,
} from "./search-rate-limiter.ts";

export const DEFAULT_SEARCH_PROVIDER = AUTO_SEARCH_PROVIDER;
const ANYSEARCH_PROVIDER = "anysearch";
const ANYSEARCH_FREE_PROVIDER = "anysearch_free";
const ANYSEARCH_SEARCH_URL = "https://api.anysearch.com/v1/search";
const DEFAULT_DISPLAY_RESULTS = 10;
const DEFAULT_API_RESULTS = 10;
const ANYSEARCH_DEFAULT_RESULTS = 20;
const ANYSEARCH_MAX_RESULTS = 100;
const TAVILY_MAX_RESULTS = 20;
const BROWSER_MAX_RESULTS = 10;
const defaultSearchRateLimiter = createSearchRateLimiter();

/**
 * @deprecated Module-level singleton — kept for backward compat only.
 * Prefer passing configPath / searchConfigResolver directly to createWebSearchTool().
 */
let _configPath = null;
let _searchConfigResolver = null;

export function initWebSearch(configPath, opts: Record<string, any> = {}) {
  _configPath = configPath;
  if (opts.searchConfigResolver) _searchConfigResolver = opts.searchConfigResolver;
}

export function resetWebSearchRateLimiterForTests() {
  defaultSearchRateLimiter.reset();
}

function throwIfRateLimited(res, label) {
  if (res.status !== 429 && res.status !== 402) return;
  throw new SearchRateLimitError(`${label} API ${res.status}`, {
    status: res.status,
    retryAfterMs: retryAfterMsFromHeaders(res.headers),
  });
}

function throwIfHttpError(res, label, data) {
  if (res.ok) return;
  const message = typeof data?.error === "string"
    ? data.error
    : typeof data?.message === "string"
      ? data.message
      : "";
  throw new Error(`${label} API ${res.status}${message ? `: ${message}` : ""}`);
}

function clampResultsToRange(maxResults, { defaultValue, max, min = 1 }) {
  const value = Number(maxResults);
  if (!Number.isFinite(value)) return defaultValue;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function isAnySearchProvider(provider) {
  return provider === ANYSEARCH_PROVIDER || provider === ANYSEARCH_FREE_PROVIDER;
}

function maxResultsForProvider(provider, maxResults) {
  if (isAnySearchProvider(provider)) {
    return clampResultsToRange(maxResults, {
      defaultValue: ANYSEARCH_DEFAULT_RESULTS,
      max: ANYSEARCH_MAX_RESULTS,
    });
  }
  if (provider === "tavily") {
    return clampResultsToRange(maxResults, {
      defaultValue: DEFAULT_API_RESULTS,
      max: TAVILY_MAX_RESULTS,
    });
  }
  if (BROWSER_SEARCH_PROVIDER_IDS.includes(provider)) {
    return clampResultsToRange(maxResults, {
      defaultValue: DEFAULT_DISPLAY_RESULTS,
      max: BROWSER_MAX_RESULTS,
    });
  }
  return clampResultsToRange(maxResults, {
    defaultValue: DEFAULT_API_RESULTS,
    max: DEFAULT_DISPLAY_RESULTS,
  });
}

function maxResultsForDisplay(maxResults) {
  return clampResultsToRange(maxResults, {
    defaultValue: DEFAULT_DISPLAY_RESULTS,
    max: ANYSEARCH_MAX_RESULTS,
  });
}

function anySearchLanguage(locale) {
  const normalized = String(locale || "").toLowerCase();
  if (normalized.startsWith("zh")) return "zh-CN";
  if (normalized.startsWith("ja")) return "ja";
  if (normalized.startsWith("ko")) return "ko";
  return "en";
}

function anySearchResultsFrom(data) {
  if (Array.isArray(data?.data?.results)) return data.data.results;
  if (Array.isArray(data?.results)) return data.results;
  return [];
}

function anySearchMetadataFrom(data) {
  return data?.data?.metadata || data?.metadata || {};
}

function throwIfAnySearchEnvelopeError(data) {
  if (!data || typeof data !== "object") return;
  if (data.code === undefined || data.code === 0) return;
  const message = typeof data.message === "string" && data.message.trim()
    ? data.message.trim()
    : `code ${data.code}`;
  throw new Error(`AnySearch API ${message}`);
}

// ════════════════════════════════════════
// Provider: Tavily
// ════════════════════════════════════════

async function searchTavily(query, maxResults, apiKey) {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      max_results: maxResults,
      search_depth: "basic",
    }),
    signal: AbortSignal.timeout(30_000),
  });

  throwIfRateLimited(res, "Tavily");
  const data = await safeParseResponse(res, null);
  throwIfHttpError(res, "Tavily", data);
  if (!data) throw new Error(`Tavily API ${res.status}`);

  return (data.results || []).map((r) => ({
    title: r.title || "",
    url: r.url || "",
    snippet: r.content || "",
  }));
}

// ════════════════════════════════════════
// Provider: Serper (Google)
// ════════════════════════════════════════

async function searchSerper(query, maxResults, apiKey) {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": apiKey,
    },
    body: JSON.stringify({ q: query, num: maxResults }),
    signal: AbortSignal.timeout(30_000),
  });

  throwIfRateLimited(res, "Serper");
  const data = await safeParseResponse(res, null);
  throwIfHttpError(res, "Serper", data);
  if (!data) throw new Error(`Serper API ${res.status}`);

  return (data.organic || []).slice(0, maxResults).map((r) => ({
    title: r.title || "",
    url: r.link || "",
    snippet: r.snippet || "",
  }));
}

// ════════════════════════════════════════
// Provider: Brave Search
// ════════════════════════════════════════

async function searchBrave(query, maxResults, apiKey) {
  const params = new URLSearchParams({ q: query, count: String(maxResults) });
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: {
      "Accept": "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": apiKey,
    },
    signal: AbortSignal.timeout(30_000),
  });

  throwIfRateLimited(res, "Brave");
  const data = await safeParseResponse(res, null);
  throwIfHttpError(res, "Brave", data);
  if (!data) throw new Error(`Brave API ${res.status}`);

  return (data.web?.results || []).slice(0, maxResults).map((r) => ({
    title: r.title || "",
    url: r.url || "",
    snippet: r.description || "",
  }));
}

// ════════════════════════════════════════
// Provider: AnySearch paid API and anonymous free tier
// ════════════════════════════════════════

async function searchAnySearch(query, maxResults, apiKey, provider) {
  const resultLimit = maxResultsForProvider(provider, maxResults);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const res = await fetch(ANYSEARCH_SEARCH_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      query,
      max_results: resultLimit,
      language: anySearchLanguage(getLocale()),
    }),
    signal: AbortSignal.timeout(30_000),
  });

  throwIfRateLimited(res, "AnySearch");
  const data = await safeParseResponse(res, null);
  throwIfHttpError(res, "AnySearch", data);
  if (!data) throw new Error(`AnySearch API ${res.status}`);
  throwIfAnySearchEnvelopeError(data);

  const metadata = anySearchMetadataFrom(data);
  return {
    query,
    provider,
    source_type: "api",
    results: anySearchResultsFrom(data).slice(0, resultLimit).map((r, index) => ({
      title: r.title || "",
      url: r.url || "",
      content: r.content || r.description || r.snippet || "",
      rank: r.rank ?? index + 1,
      score: r.score ?? r.quality_score ?? null,
      metadata: {
        description: r.description || "",
        quality_score: r.quality_score ?? null,
        signal_scores: r.signal_scores || {},
        source: r.source || "",
        published_at: r.published_at || null,
      },
    })),
    diagnostics: {
      anonymous: !apiKey,
      total_results: metadata.total_results ?? null,
      search_time_ms: metadata.search_time_ms ?? null,
      request_id: metadata.request_id || "",
      cached: metadata.cached ?? null,
    },
  };
}

async function searchAnySearchFree(query, maxResults) {
  return searchAnySearch(query, maxResults, "", ANYSEARCH_FREE_PROVIDER);
}

const PROVIDERS = {
  [ANYSEARCH_PROVIDER]: { search: searchAnySearch, requiresApiKey: true, sourceType: "api" },
  [ANYSEARCH_FREE_PROVIDER]: { search: searchAnySearchFree, requiresApiKey: false, sourceType: "api" },
  tavily: { search: searchTavily, requiresApiKey: true, sourceType: "api" },
  brave: { search: searchBrave, requiresApiKey: true, sourceType: "api" },
  serper: { search: searchSerper, requiresApiKey: true, sourceType: "api" },
  ...Object.fromEntries(BROWSER_SEARCH_PROVIDER_IDS.map((id) => [
    id,
    { search: searchBrowserProvider, requiresApiKey: false, sourceType: "browser" },
  ])),
};

function providerMeta(provider) {
  const meta = PROVIDERS[provider];
  if (!meta) throw new Error(`Unknown provider: ${provider}`);
  return meta;
}

export function searchProviderRequiresApiKey(provider) {
  if (normalizeSearchProvider(provider) === AUTO_SEARCH_PROVIDER) return false;
  return providerMeta(provider).requiresApiKey;
}

async function searchBrowserProvider(query, maxResults, _apiKey, provider) {
  const response = await BrowserManager.instance().searchWeb({
    provider,
    query,
    maxResults,
    locale: getLocale(),
  });
  const diagnostics = response.diagnostics || {};
  if (diagnostics.blocked || diagnostics.status === "blocked") {
    throw new Error(diagnostics.reason || "search page is blocked");
  }
  if (diagnostics.status === "extraction_failed") {
    throw new Error(diagnostics.reason || "search results could not be extracted");
  }
  return {
    query,
    provider,
    source_type: "browser",
    results: response.results || [],
    diagnostics,
  };
}

/**
 * 验证搜索 API key 是否有效
 * @param {string} provider - tavily / serper / brave
 * @param {string} apiKey - 要验证的 key
 * @returns {Promise<boolean>}
 */
export async function verifySearchKey(provider, apiKey) {
  if (normalizeSearchProvider(provider) === AUTO_SEARCH_PROVIDER) return true;
  const meta = providerMeta(provider);
  if (!meta.requiresApiKey) return true;
  // 用一个简短查询测试 key 是否可用
  await defaultSearchRateLimiter.run(provider, meta.sourceType, () => (
    meta.search("test", 1, apiKey, provider)
  ));
  return true;
}

function normalizeSearchResult(r) {
  return {
    title: r.title || "",
    url: r.url || "",
    content: r.content || r.snippet || "",
    rank: r.rank ?? null,
    score: r.score ?? null,
    metadata: r.metadata || {},
  };
}

function normalizeProviderPayload(query, provider, meta, payload) {
  if (Array.isArray(payload)) {
    return {
      query,
      results: payload.map(normalizeSearchResult),
      provider,
      source_type: meta.sourceType,
      diagnostics: {},
    };
  }
  return {
    query: payload.query || query,
    results: (payload.results || []).map(normalizeSearchResult),
    provider,
    source_type: payload.source_type || meta.sourceType,
    diagnostics: payload.diagnostics || {},
  };
}

async function runProviderSearch({ provider, query, maxResults, apiKey, rateLimiter }) {
  const meta = providerMeta(provider);
  if (meta.requiresApiKey && !apiKey) {
    throw new Error(t("error.searchProviderMissingKey", { provider }));
  }
  const providerMaxResults = maxResultsForProvider(provider, maxResults);
  const limiter = rateLimiter || defaultSearchRateLimiter;
  const payload = await limiter.run(provider, meta.sourceType, () => (
    meta.search(query, providerMaxResults, apiKey, provider)
  ));
  return normalizeProviderPayload(query, provider, meta, payload);
}

function buildSearchRuntimeConfig({ resolverFn, readConfig }) {
  const configSearch = readConfig().search || {};
  const resolved = resolverFn ? (resolverFn() || {}) : {};
  const configProvider = normalizeSearchProvider(configSearch.provider);
  const resolvedProvider = normalizeSearchProvider(resolved.provider);
  const provider = resolvedProvider || configProvider || DEFAULT_SEARCH_PROVIDER;
  let apiKeys = normalizeSearchApiKeys(configSearch.api_keys);
  apiKeys = mergeSearchApiKeys(apiKeys, resolved.api_keys);

  if (isSearchApiProvider(configProvider) && typeof configSearch.api_key === "string" && configSearch.api_key.trim()) {
    apiKeys[configProvider] = apiKeys[configProvider] || configSearch.api_key.trim();
  }
  if (isSearchApiProvider(resolvedProvider) && typeof resolved.api_key === "string" && resolved.api_key.trim()) {
    apiKeys[resolvedProvider] = resolved.api_key.trim();
  }

  const apiKey = isSearchApiProvider(provider)
    ? apiKeys[provider] || ""
    : "";
  return { provider, apiKey, apiKeys };
}

function classifySearchError(err) {
  if (err instanceof SearchRateLimitError || err?.status === 429) return "rate_limited";
  const message = String(err?.message || "");
  if (/402|quota|rate.?limit|too many/i.test(message)) return "rate_limited";
  if (/api key|required|unauthorized|forbidden|401|403/i.test(message)) return "auth";
  if (/blocked|captcha/i.test(message)) return "blocked";
  if (/extract/i.test(message)) return "extraction_failed";
  return "error";
}

function hasCjk(text) {
  return /[\u3400-\u9fff]/.test(String(text || ""));
}

function normalizeQualityText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。、“”‘’：《》？！（）()|_\-\u2014:;,.!?/\\[\]{}]+/g, "");
}

function queryQualityTerms(query) {
  return String(query || "")
    .split(/\s+/)
    .map((term) => normalizeQualityText(term))
    .filter((term) => hasCjk(term) && term.length >= 2);
}

function looksLikeDictionaryResult(result) {
  const text = normalizeQualityText(`${result.title || ""} ${result.url || ""} ${result.content || ""}`);
  return /汉语文字|汉典|字典|词典|基本解释|百度百科|hanyu|zdic|zidian|cidian/.test(text);
}

function isLikelyLowQualityResults(query, results) {
  if (!hasCjk(query) || !Array.isArray(results) || results.length === 0) return false;
  const terms = queryQualityTerms(query);
  if (terms.length < 3) return false;
  const top = results.slice(0, Math.min(3, results.length));
  const topText = normalizeQualityText(top.map((r) => `${r.title || ""} ${r.url || ""} ${r.content || ""}`).join(" "));
  const matchedTerms = terms.filter((term) => topText.includes(term)).length;
  const dictionaryCount = top.filter(looksLikeDictionaryResult).length;
  return dictionaryCount >= Math.min(2, top.length) && matchedTerms <= 1;
}

function attachAutoDiagnostics(payload, attempts, extra = {}) {
  return {
    ...payload,
    diagnostics: {
      ...(payload.diagnostics || {}),
      strategy: AUTO_SEARCH_PROVIDER,
      attempts,
      ...extra,
    },
  };
}

async function doAutoSearch(query, maxResults, { apiKeys, rateLimiter }) {
  const attempts = [];
  const configuredApiProviders = SEARCH_API_PROVIDER_IDS.filter((provider) => !!apiKeys[provider]);
  const chain = [...configuredApiProviders, ANYSEARCH_FREE_PROVIDER, ...BROWSER_SEARCH_PROVIDER_IDS];
  let firstLowQualityPayload = null;

  for (const provider of chain) {
    const meta = providerMeta(provider);
    const attempt: Record<string, any> = { provider, source_type: meta.sourceType };
    try {
      const payload = await runProviderSearch({
        provider,
        query,
        maxResults,
        apiKey: apiKeys[provider] || "",
        rateLimiter,
      });
      attempt.result_count = payload.results.length;
      if (payload.results.length === 0) {
        attempt.status = "empty";
        attempts.push(attempt);
        continue;
      }
      if (isLikelyLowQualityResults(query, payload.results)) {
        attempt.status = "low_quality";
        attempts.push(attempt);
        if (!firstLowQualityPayload) firstLowQualityPayload = payload;
        continue;
      }
      attempt.status = "ok";
      attempts.push(attempt);
      return attachAutoDiagnostics(payload, attempts);
    } catch (err) {
      attempt.status = "error";
      attempt.error_type = classifySearchError(err);
      attempt.message = err instanceof Error ? err.message : String(err);
      if (err instanceof SearchRateLimitError && err.retryAfterMs) {
        attempt.retry_after_ms = err.retryAfterMs;
      }
      attempts.push(attempt);
    }
  }

  if (firstLowQualityPayload) {
    return attachAutoDiagnostics(firstLowQualityPayload, attempts, { selected_status: "low_quality" });
  }

  return {
    query,
    results: [],
    provider: AUTO_SEARCH_PROVIDER,
    source_type: AUTO_SEARCH_PROVIDER,
    diagnostics: {
      strategy: AUTO_SEARCH_PROVIDER,
      attempts,
      status: "all_failed",
    },
  };
}

async function doSearch(query, maxResults, { configPath, searchConfigResolver, rateLimiter }: Record<string, any> = {}) {
  // Use explicitly passed args; fall back to module globals for backward compat
  const resolverFn = searchConfigResolver ?? _searchConfigResolver;
  const cfgPath = configPath ?? _configPath;
  let cfg = null;
  const readConfig = () => {
    if (!cfgPath) return {};
    if (!cfg) cfg = loadConfig(cfgPath);
    return cfg;
  };

  // 优先从 resolver 获取搜索配置，否则从 agent config 读取。
  const { provider, apiKey, apiKeys } = buildSearchRuntimeConfig({ resolverFn, readConfig });

  if (!provider) {
    throw new Error(t("error.searchProviderNotConfigured"));
  }

  if (provider === AUTO_SEARCH_PROVIDER) {
    return doAutoSearch(query, maxResults, { apiKeys, rateLimiter });
  }

  let meta;
  try {
    meta = providerMeta(provider);
  } catch {
    throw new Error(t("error.searchProviderUnknown", { provider }));
  }
  if (meta.requiresApiKey && !apiKey) {
    throw new Error(t("error.searchProviderMissingKey", { provider }));
  }

  try {
    return await runProviderSearch({ provider, query, maxResults, apiKey, rateLimiter });
  } catch (err) {
    throw new Error(t("error.searchFailed", { msg: err.message }));
  }
}

// ════════════════════════════════════════
// Tool 定义
// ════════════════════════════════════════

/**
 * @param {object} [opts]
 * @param {string} [opts.configPath]           - per-agent config.yaml path
 * @param {Function} [opts.searchConfigResolver] - per-agent resolver returning { provider, api_key }
 * @param {object} [opts.rateLimiter]          - test/advanced hook with run(provider, sourceType, op)
 */
export function createWebSearchTool({ configPath, searchConfigResolver, rateLimiter }: Record<string, any> = {}) {
  // Capture per-agent config in the closure so each agent's tool reads its own config
  const closureOpts = { configPath, searchConfigResolver, rateLimiter };

  return {
    name: "web_search",
    label: "Web Search",
    description: "Search the internet for real-time information. Use when you need the latest news, technical docs, current events, or any external knowledge not in memory.",
    parameters: Type.Object({
      query: Type.String({ description: "Search keywords" }),
      maxResults: Type.Optional(
        Type.Number({ description: "Number of results to return, default 10", default: DEFAULT_DISPLAY_RESULTS })
      ),
    }),
    execute: async (_toolCallId, params) => {
      const query = params.query?.trim();
      if (!query) {
        return {
          content: [{ type: "text", text: t("error.searchEmptyQuery") }],
          details: {},
        };
      }

      try {
        const searchPayload = await doSearch(query, params.maxResults, closureOpts);
        const { results, provider } = searchPayload;

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: t("error.searchNoResults", { provider }) }],
            details: searchPayload,
          };
        }

        const displayLimit = maxResultsForDisplay(params.maxResults);
        const formatted = results
          .slice(0, displayLimit)
          .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.content}`)
          .join("\n\n");

        return {
          content: [{ type: "text", text: t("error.searchResults", { provider, results: formatted }) }],
          details: searchPayload,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: t("error.searchError", { msg: err.message }) }],
          details: {},
        };
      }
    },
  };
}
