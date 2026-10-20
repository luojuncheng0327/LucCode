/**
 * 供应商管理 REST 路由
 */
import fs from "fs";
import path from "path";
import os from "os";
import { Hono } from "hono";
import { emitAppEvent } from "../app-events.ts";
import { safeJson } from "../hono-helpers.ts";
import { appendProviderApiPath, buildProviderRequestHeaders, normalizeProviderBaseUrlForApi, probeProvider } from "../../lib/llm/provider-client.ts";
import {
  collectProviderHeaderSecretPatchPaths,
  maskProviderHeaders,
  resolveProviderHeadersPatch,
} from "../../shared/provider-auth.ts";
import { filterDiscoveredProviderModels } from "../../shared/provider-model-validation.ts";
import { listKnownProviderModels, lookupKnown } from "../../shared/known-models.ts";
import { enrichOllamaModelMetadata } from "../../shared/ollama-model-metadata.ts";
import { clearConfigCache } from "../../lib/memory/config-loader.ts";
import { collectSecretPatchPaths, isMaskedSecretValue, maskSecretValue } from "../../shared/secret-custody.ts";
import { denySecretMutationWithoutScope, denyWithoutScope } from "../http/capability-guard.ts";

// ── Models-cache helpers ──

function getCachePath(engine: any) {
  return path.join(engine.luccodeHome, "models-cache.json");
}

function readModelsCache(engine: any) {
  try {
    return JSON.parse(fs.readFileSync(getCachePath(engine), "utf-8"));
  } catch {
    return {};
  }
}

/** Atomic write: tmp + rename to avoid partial reads */
function writeModelsCache(engine: any, cache: any) {
  const target = getCachePath(engine);
  const tmp = target + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2) + os.EOL);
  fs.renameSync(tmp, target);
}

function getProviderModelId(model: any) {
  if (typeof model === "string") return model.trim();
  return typeof model?.id === "string" ? model.id.trim() : "";
}

function pickProbeModelId(providerRegistry: any, providerId: any, api: any, requestedModelId: any) {
  if (typeof requestedModelId === "string" && requestedModelId.trim()) {
    return requestedModelId.trim();
  }
  if (typeof providerId !== "string" || !providerId.trim()) return "";
  const models = providerRegistry?.getChatModelEntries?.(providerId) || [];
  const matching = models.find((model: any) => {
    const modelApi = typeof model === "object" && model !== null ? model.api : null;
    return !modelApi || modelApi === api;
  });
  return getProviderModelId(matching);
}

export function createProvidersRoute(engine: any) {
  const route = new Hono();

  // ── Cache helper: persist discovered models per-provider ──
  function saveToCache(providerName: any, models: any) {
    if (!providerName || !models?.length) return;
    try {
      const cache = readModelsCache(engine);
      cache[providerName] = { models, fetchedAt: new Date().toISOString() };
      writeModelsCache(engine, cache);
    } catch { /* best-effort; cache miss is harmless */ }
  }

  // ── Provider Summary ──

  /**
   * 统一概览：合并 Provider Catalog + Luc provider defaults + OAuth status
   * 前端新 ProvidersTab 的核心数据源
   */
  route.get("/providers/summary", async (c) => {
    const rawProviders = engine.providerRegistry.getAllProvidersRaw();
    // 补全凭证和模型列表（getAllProvidersRaw 返回 catalog overlay + 本地 Provider Plugin 定义）
    const providers: Record<string, any> = {};
    for (const [name, p] of Object.entries(rawProviders) as [string, any][]) {
      const entry = engine.providerRegistry.get(name);
      providers[name] = {
        base_url: p.base_url || entry?.baseUrl || "",
        api_key: p.api_key || "",
        api: p.api || entry?.api || "",
        headers: p.headers || entry?.headers || {},
        models: p.models || [],
        config_error: p._config_error || null,
      };
    }

    // ProviderRegistry 是 OAuth 判断的唯一权威
    // 只有在 ProviderRegistry 中注册为 authType:"oauth" 的 provider 才是 OAuth provider
    // Pi SDK 内置的危险 OAuth（anthropic/github-copilot 等）不在 Registry 中，不会泄露
    const provRegistry = engine.providerRegistry;

    // OAuth provider 登录状态（Pi SDK AuthStorage，key 是 authJsonKey）
    const oauthProviders = engine.authStorage?.getOAuthProviders?.() || [];
    const oauthLoginMap = new Map();
    for (const p of oauthProviders) {
      const cred = engine.authStorage.get(p.id);
      oauthLoginMap.set(p.id, { name: p.name, loggedIn: cred?.type === "oauth" });
    }

    const result: Record<string, any> = {};

    // OAuth 登录信息查找（oauthLoginMap 用 authJsonKey 索引）
    function getOAuthLoginInfo(name: any) {
      if (oauthLoginMap.has(name)) return oauthLoginMap.get(name);
      const authKey = provRegistry.getAuthJsonKey(name);
      if (authKey !== name && oauthLoginMap.has(authKey)) return oauthLoginMap.get(authKey);
      return null;
    }

    // 先处理 Provider Catalog 中的 provider（保持顺序）
    for (const [name, p] of Object.entries(providers)) {
      const entry = provRegistry.get(name);
      const isOAuth = provRegistry.isOAuth(name);
      const authType = provRegistry.getAuthType?.(name) || (isOAuth ? "oauth" : "api-key");
      const oauthInfo = getOAuthLoginInfo(name);
      // ProviderRegistry 暴露的 runtime provider 数据是模型列表入口；
      // 对本地 Provider Plugin，它已经合并了插件声明和 catalog overlay。
      const rawModels = provRegistry.getChatModelEntries?.(name) || p.models || [];
      const allowsMissingApiKey = !!p.base_url && provRegistry.allowsMissingApiKey?.(name, p.base_url);
      const hasHeaders = Object.keys(p.headers || {}).length > 0;
      const hasCredentials = !!(p.api_key || hasHeaders || (isOAuth && oauthInfo?.loggedIn) || (!isOAuth && allowsMissingApiKey));
      const missingFields = [];
      if (!isOAuth) {
        if (!p.base_url) missingFields.push("base_url");
        if (!hasCredentials) missingFields.push("api_key");
      }
      if (rawModels.length === 0) missingFields.push("models");

      result[name] = {
        type: isOAuth ? "oauth" : "api-key",
        auth_type: authType,
        display_name: oauthInfo?.name || entry?.displayName || name,
        base_url: p.base_url || "",
        api: p.api || "",
        api_key: maskSecretValue(p.api_key || ""),
        headers: maskProviderHeaders(p.headers || {}),
        models: rawModels,
        custom_models: [],
        has_credentials: hasCredentials,
        logged_in: isOAuth ? !!oauthInfo?.loggedIn : undefined,
        supports_oauth: isOAuth,
        is_coding_plan: name.endsWith("-coding"),
        is_configured: true,
        can_delete: !isOAuth || Object.prototype.hasOwnProperty.call(providers, name),
        config_status: p.config_error ? "invalid" : (missingFields.length > 0 ? "needs_setup" : "ok"),
        config_error: p.config_error || null,
        missing_fields: missingFields,
      };
    }

    // 追加没有 Provider Catalog overlay 的 OAuth provider。模型仍来自 Luc plugin 默认清单。
    for (const oauthId of provRegistry.getOAuthProviderIds()) {
      if (result[oauthId]) continue;
      const authKey = provRegistry.getAuthJsonKey(oauthId);
      const loginInfo = oauthLoginMap.get(authKey);
      const entry = provRegistry.get(oauthId);
      const effectiveModels = provRegistry.getChatModelEntries?.(oauthId) || [];
      result[oauthId] = {
        type: "oauth",
        auth_type: "oauth",
        display_name: loginInfo?.name || entry?.displayName || oauthId,
        base_url: entry?.baseUrl || "",
        api: entry?.api || "",
        api_key: "",
        models: effectiveModels,
        custom_models: [],
        has_credentials: !!loginInfo?.loggedIn,
        logged_in: !!loginInfo?.loggedIn,
        supports_oauth: true,
        is_coding_plan: false,
        is_configured: true,
        can_delete: false,
        config_status: effectiveModels.length > 0 && loginInfo?.loggedIn ? "ok" : "needs_setup",
        config_error: null,
        missing_fields: effectiveModels.length > 0 ? [] : ["models"],
      };
    }

    // 追加 ProviderRegistry 中已声明但尚未出现的 provider（未配置状态）
    // 让用户在设置页看到所有可用供应商，点击即可配置
    if (provRegistry) {
      for (const [id, entry] of provRegistry.getAll()) {
        if (result[id]) continue;
        if (entry.authType === "oauth") continue; // OAuth provider 走上面的白名单逻辑
        result[id] = {
          type: "api-key",
          auth_type: entry.authType,
          display_name: entry.displayName || id,
          base_url: entry.baseUrl || "",
          api: entry.api || "",
          api_key: "",
          models: [],
          custom_models: [],
          has_credentials: false,
          logged_in: undefined,
          supports_oauth: false,
          is_coding_plan: id.endsWith("-coding"),
          is_configured: false,
          can_delete: false,
          config_status: "needs_setup",
          config_error: null,
          missing_fields: [
            ...(entry.authType === "none" ? [] : ["api_key"]),
            "models",
          ],
        };
      }
    }

    return c.json({ providers: result });
  });

  /**
   * 显式查看已保存的供应商 API Key。
   * summary 仍然只返回脱敏值；明文读取必须走这个受权限保护的窄端点。
   */
  route.get("/providers/:name/api-key", (c) => {
    const scopeDenied = denyWithoutScope(c, "providers.manage");
    if (scopeDenied) return scopeDenied;
    const secretDenied = denyWithoutScope(c, "secrets.write", {
      error: "secret_read_scope_required",
    });
    if (secretDenied) return secretDenied;

    const providerName = c.req.param("name");
    const creds = engine.resolveProviderCredentials?.(providerName) || {};
    return c.json({ api_key: typeof creds.api_key === "string" ? creds.api_key : "" });
  });

  // ── Fetch / Test ──

  function normalizeRegistryModels(models: any[]) {
    return models.map((model) => ({
      id: model.id,
      name: model.name || model.id,
      context: model.contextWindow ?? model.context ?? null,
      maxOutput: model.maxTokens ?? model.maxOutputTokens ?? model.maxOutput ?? null,
    }));
  }

  function normalizeRemoteModels(data: any, api: any) {
    if (api === "anthropic-messages") {
      return (data.data || []).map(m => ({
        id: m.id,
        name: m.display_name || m.id,
        context: m.max_input_tokens ?? null,
        maxOutput: m.max_tokens ?? null,
      }));
    }

    if (api === "google-generative-ai") {
      return (data.models || []).map(m => {
        const id = m.baseModelId || String(m.name || "").replace(/^models\//, "");
        return {
          id,
          name: m.displayName || id,
          context: m.inputTokenLimit ?? null,
          maxOutput: m.outputTokenLimit ?? null,
        };
      }).filter(m => m.id);
    }

    return (data.data || []).map(m => ({
      id: m.id,
      name: m.id,
      context: m.context_length || m.context_window || m.max_context_length || null,
      maxOutput: m.max_completion_tokens || m.max_output_tokens || null,
    }));
  }

  function filterProviderModels(name: any, models: any, baseUrl = ""): { models: any[]; ignoredModels?: any[] } {
    const { models: filtered, ignoredModels } = filterDiscoveredProviderModels(name, models, { baseUrl });
    const payload: { models: any[]; ignoredModels?: any[] } = { models: filtered };
    if (ignoredModels.length > 0) payload.ignoredModels = ignoredModels;
    return payload;
  }

  function knownCatalogModel(provider: any, id: any) {
    const known = lookupKnown(provider, id);
    return {
      id,
      name: known?.name || id,
      context: known?.context ?? null,
      maxOutput: known?.maxOutput ?? null,
    };
  }

  function supplementRemoteModels(name: any, remoteModels: any[]) {
    if (name !== "zhipu") return remoteModels;
    const seen = new Set();
    const merged = [];
    const append = (model) => {
      const id = typeof model === "string" ? model : model?.id;
      if (!id || seen.has(id)) return;
      seen.add(id);
      merged.push(typeof model === "string" ? knownCatalogModel(name, id) : model);
    };

    for (const model of remoteModels) append(model);
    for (const id of engine.providerRegistry.getDefaultModels?.(name) || []) append(id);
    for (const id of listKnownProviderModels(name)) append(id);
    return merged;
  }

  function enrichDiscoveredModelMetadata(name: any, models: any[]) {
    return models.map((model) => enrichOllamaModelMetadata(name, model));
  }

  async function refreshProviderModels() {
    (clearConfigCache as any)();
    await engine.onProviderChanged();
    // The provider catalog is global: this refresh changes every agent's model
    // list, so the event names no agent. Tagging it with whichever agent the
    // server is focused on would label a global change as one agent's.
    emitAppEvent(engine, "models-changed", { agentId: null });
  }

  /** Registry → defaults 两级 fallback，fetch-models 和 Anthropic 路径共用 */
  function registryOrDefaultsFallback(name: any) {
    if (!name) {
      return { error: "name is required for model discovery fallback", models: [] };
    }

    // 尝试 Pi SDK registry（含内置 OAuth 模型 + models.json 模型，不经过 availableModels 白名单）
    const registryModels = engine.getRegistryModelsForProvider(name);
    if (registryModels.length > 0) {
      const normalized = enrichDiscoveredModelMetadata(name, normalizeRegistryModels(registryModels));
      const payload = filterProviderModels(name, normalized);
      if (payload.models.length === 0 && payload.ignoredModels?.length > 0) {
        return {
          source: "registry",
          error: `Registry only returned invalid model ids for provider "${name}": ${payload.ignoredModels.join(", ")}`,
          models: [],
          ignoredModels: payload.ignoredModels,
        };
      }
      saveToCache(name, payload.models);
      return { source: "registry", ...payload };
    }

    // 回退到 default-models.json（用 authJsonKey 兜底，如 openai-codex-oauth → openai-codex）
    const authKey = engine.providerRegistry.getAuthJsonKey(name);
    const defaults = engine.providerRegistry.getDefaultModels(name)
      || engine.providerRegistry.getDefaultModels(authKey)
      || [];
    if (defaults.length > 0) {
      const builtinModels = enrichDiscoveredModelMetadata(
        name,
        defaults.map(id => ({ id, name: id, context: null, maxOutput: null })),
      );
      const payload = filterProviderModels(name, builtinModels);
      saveToCache(name, payload.models);
      return { source: "builtin", ...payload };
    }

    return { error: `No models found for provider "${name}"`, models: [] };
  }

  function lucCatalogFallback(name: any) {
    if (!name) return { error: "name is required for Luc model catalog", models: [] };
    const resolved = engine.providerRegistry.resolveChatProvider?.(name);
    if (!resolved) return { error: `Provider "${name}" is not registered`, models: [] };
    const sourceProviderId = resolved.sourceProviderId || resolved.entry?.id || name;
    const modelEntries = engine.providerRegistry.getChatDiscoverableModelEntries?.(sourceProviderId) || [];
    const models = modelEntries.map((entry) => {
      const id = typeof entry === "object" ? entry.id : entry;
      const known = knownCatalogModel(sourceProviderId, id);
      return typeof entry === "object"
        ? {
            ...known,
            name: entry.name || known.name,
            context: entry.context ?? entry.contextWindow ?? known.context,
            maxOutput: entry.maxOutput ?? entry.maxTokens ?? entry.maxOutputTokens ?? known.maxOutput,
          }
        : known;
    });
    const payload = filterProviderModels(sourceProviderId, models, resolved.entry?.baseUrl || "");
    saveToCache(sourceProviderId, payload.models);
    if (payload.models.length === 0) {
      return {
        source: "luc-catalog",
        error: `No models found in Luc catalog for provider "${sourceProviderId}"`,
        ...payload,
      };
    }
    return { source: "luc-catalog", ...payload };
  }

  /**
   * 从供应商拉取模型列表
   * 统一瀑布流：凭证解析 → 远程 list models → registry fallback → defaults fallback
   *
   * 远程端点按协议分岔：
   *   - anthropic-messages → GET {base}/v1/models?limit=1000（Anthropic Messages API）
   *   - 其他（openai-completions 等）→ GET {base}/models
   *
   * body: { name, base_url?, api?, api_key? }
   */
  route.post("/providers/fetch-models", async (c) => {
    const body = await safeJson(c);
    const scopeDenied = denyWithoutScope(c, "providers.manage");
    if (scopeDenied) return scopeDenied;
    const secretDenied = denySecretMutationWithoutScope(c, [
      ...collectSecretPatchPaths(body, ["api_key"] as any),
      ...collectProviderHeaderSecretPatchPaths(body.headers, "headers"),
    ]);
    if (secretDenied) return secretDenied;
    const { name, base_url, api: explicitApi, api_key } = body;
    if (!name && !base_url) {
      return c.json({ error: "name or base_url is required" }, 400);
    }

    const chatProvider = name ? engine.providerRegistry.resolveChatProvider?.(name) : null;
    // Luc-owned models-json OAuth catalogs never probe ChatGPT /models. Legacy
    // sdk-auth-alias providers intentionally keep Pi's runtime catalog behavior.
    if (chatProvider?.projection === "models-json" && chatProvider.credentialSource === "auth-storage") {
      return c.json(lucCatalogFallback(name));
    }
    if (chatProvider?.projection === "sdk-auth-alias") {
      return c.json(registryOrDefaultsFallback(name));
    }

    // ── 1. 凭证解析：显式请求凭证跳过 refresh；其余网络探测 fresh resolve ──
    const bodyKey = typeof api_key === "string" ? api_key.trim() : "";
    const hasExplicitBodyCredentials = (
      !!bodyKey && !isMaskedSecretValue(bodyKey)
    ) || collectProviderHeaderSecretPatchPaths(body.headers, "headers").length > 0;
    let saved = { api_key: "", base_url: "", api: "", headers: {} } as any;
    try {
      if (name) {
        if (hasExplicitBodyCredentials) {
          const entry = engine.providerRegistry.get?.(name);
          saved = {
            api_key: "",
            base_url: entry?.baseUrl || "",
            api: entry?.api || "",
            headers: {},
          };
        } else {
          saved = await engine.resolveProviderCredentialsFresh(name);
        }
      }
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err), models: [] });
    }
    const effectiveKey = bodyKey
      ? (isMaskedSecretValue(bodyKey) ? saved.api_key || "" : bodyKey)
      : saved.api_key || "";
    const effectiveBaseUrl = normalizeProviderBaseUrlForApi({
      provider: name,
      baseUrl: base_url || saved.base_url || "",
      api: explicitApi || saved.api || "",
    });
    const effectiveApi = explicitApi || saved.api || "";
    const effectiveHeaders = Object.prototype.hasOwnProperty.call(body, "headers")
      ? (resolveProviderHeadersPatch as any)({ patch: body.headers, existing: saved.headers || {} })
      : saved.headers || {};

    // ── 2. 远程 list models（baseUrl 为空时跳过）──
    if (effectiveBaseUrl) {
      try {
        const base = effectiveBaseUrl.replace(/\/+$/, "");
        const url = effectiveApi === "anthropic-messages"
          ? appendProviderApiPath(base, "/v1/models?limit=1000")
          : `${base}/models`;

        if (effectiveKey && !effectiveApi) {
          return c.json({ error: "api is required when api_key is present", models: [] });
        }
        const headers = (buildProviderRequestHeaders as any)({
          api: effectiveApi,
          apiKey: effectiveKey,
          headers: effectiveHeaders,
          allowMissingApiKey: true,
        });
        const res = await fetch(url, {
          headers,
          signal: AbortSignal.timeout(15000),
        });

        // 401/403：凭证问题，直接返回错误，不 fallback
        if (res.status === 401 || res.status === 403) {
          return c.json({ error: `HTTP ${res.status}: ${res.statusText}`, models: [] });
        }

        if (res.ok) {
          const data = await res.json();
          const remoteModels = enrichDiscoveredModelMetadata(
            name,
            supplementRemoteModels(name, normalizeRemoteModels(data, effectiveApi)),
          );
          const { models, ignoredModels } = filterDiscoveredProviderModels(name, remoteModels, {
            baseUrl: effectiveBaseUrl,
          });
          if (models.length === 0 && ignoredModels.length > 0) {
            return c.json({
              error: `Remote catalog only returned invalid model ids for provider "${name}": ${ignoredModels.join(", ")}`,
              models: [],
              ignoredModels,
            });
          }
          saveToCache(name, models);
          return c.json(ignoredModels.length > 0 ? { models, ignoredModels } : { models });
        }

        // 404 / 其他 → 进入 step 3
      } catch {
        // 网络错误 → 进入 step 3
      }
    }

    // ── 3. Registry + defaults fallback ──
    return c.json(registryOrDefaultsFallback(name));
  });

  /**
   * 读取供应商已发现但尚未添加的模型（缓存）
   * GET /api/providers/:name/discovered-models
   */
  route.get("/providers/:name/discovered-models", (c) => {
    const scopeDenied = denyWithoutScope(c, "providers.manage");
    if (scopeDenied) return scopeDenied;
    const providerName = c.req.param("name");
    const cache = readModelsCache(engine);
    const entry = cache[providerName];
    if (!entry) return c.json({ models: [], fetchedAt: null });
    const creds = engine.resolveProviderCredentials?.(providerName) || {};
    const payload = filterProviderModels(providerName, entry.models || [], creds.base_url || "");
    return c.json({ ...payload, fetchedAt: entry.fetchedAt || null });
  });

  /**
   * 测试供应商连接
   * body: { name?, base_url?, api?, api_key? }
   * 凭证解析优先级与 fetch-models 一致：请求体 > resolveProviderCredentials > 插件默认值
   */
  route.post("/providers/test", async (c) => {
    const body = await safeJson(c);
    const scopeDenied = denyWithoutScope(c, "providers.manage");
    if (scopeDenied) return scopeDenied;
    const secretDenied = denySecretMutationWithoutScope(c, [
      ...collectSecretPatchPaths(body, ["api_key"] as any),
      ...collectProviderHeaderSecretPatchPaths(body.headers, "headers"),
    ]);
    if (secretDenied) return secretDenied;
    const { name } = body;
    // 清洗 API key：去除非 ASCII 字符（防止粘贴时输入法带入中文）
    const bodyKey = (body.api_key || "").replace(/[^\x20-\x7E]/g, "").trim();

    // ── 凭证解析：显式请求凭证跳过 refresh；其余请求在真正探测前 fresh resolve ──
    const hasExplicitBodyCredentials = (
      !!bodyKey && !isMaskedSecretValue(bodyKey)
    ) || collectProviderHeaderSecretPatchPaths(body.headers, "headers").length > 0;
    let saved = { api_key: "", base_url: "", api: "" } as any;
    try {
      if (name) {
        if (hasExplicitBodyCredentials) {
          const entry = engine.providerRegistry.get?.(name);
          saved = {
            api_key: "",
            base_url: entry?.baseUrl || "",
            api: entry?.api || "",
            headers: {},
          };
        } else {
          saved = await engine.resolveProviderCredentialsFresh(name);
        }
      }
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    const api_key = bodyKey
      ? (isMaskedSecretValue(bodyKey) ? saved.api_key || "" : bodyKey)
      : saved.api_key || "";
    const api = body.api || saved.api || "";
    const base_url = normalizeProviderBaseUrlForApi({
      provider: name,
      baseUrl: body.base_url || saved.base_url || "",
      api,
    });
    const headers = Object.prototype.hasOwnProperty.call(body, "headers")
      ? (resolveProviderHeadersPatch as any)({ patch: body.headers, existing: saved.headers || {} })
      : saved.headers || {};

    if (name
      && engine.providerRegistry.resolveChatProvider?.(name)?.credentialSource === "auth-storage"
      && !hasExplicitBodyCredentials
      && !saved.api_key) {
      return c.json({ ok: false, error: `OAuth credentials unavailable for provider "${name}"` });
    }

    if (!base_url) {
      return c.json({ error: "base_url is required" }, 400);
    }
    if (api_key && !api) {
      return c.json({ error: "api is required when api_key is present" }, 400);
    }

    try {
      const modelId = pickProbeModelId(engine.providerRegistry, name, api, body.model_id);
      const result = await (probeProvider as any)({
        baseUrl: base_url,
        api,
        apiKey: api_key,
        headers,
        ...(modelId ? { modelId } : {}),
      });
      return c.json(result);
    } catch (err) {
      return c.json({ ok: false, error: err.message });
    }
  });

  /**
   * 更新模型元数据（context/image/video/reasoning/maxOutput/name）
   * 写回 Provider Catalog → 触发 model-sync → SDK 模型对象更新
   */
  route.put("/providers/:name/models/:modelId", async (c) => {
    const scopeDenied = denyWithoutScope(c, "providers.manage");
    if (scopeDenied) return scopeDenied;
    const providerName = c.req.param("name");
    const modelId = c.req.param("modelId");
    const body = await safeJson(c);
    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid body" }, 400);
    }
    try {
      engine.providerRegistry.updateModelEntry(providerName, modelId, body);
      await refreshProviderModels();
      return c.json({ ok: true });
    } catch (err) {
      const declaredStatus = Number(err?.statusCode);
      const status = Number.isInteger(declaredStatus) && declaredStatus >= 400 && declaredStatus <= 599
        ? declaredStatus
        : (err.message?.includes("not found") ? 404 : 500);
      return c.json({ error: err.message }, status as any);
    }
  });

  /**
   * 删除模型配置
   * 从 Provider Catalog 移除指定模型 → 触发 model-sync
   */
  route.delete("/providers/:name/models/:modelId", async (c) => {
    const scopeDenied = denyWithoutScope(c, "providers.manage");
    if (scopeDenied) return scopeDenied;
    const providerName = c.req.param("name");
    const modelId = c.req.param("modelId");
    try {
      engine.providerRegistry.removeModel(providerName, modelId);
      await refreshProviderModels();
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  return route;
}
