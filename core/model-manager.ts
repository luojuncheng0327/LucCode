/**
 * ModelManager -- 模型发现、切换、凭证解析
 *
 * 管理 Pi SDK AuthStorage / ModelRegistry 基础设施，
 * 以及模型选择、provider 凭证查找、utility 配置解析。
 * 从 Engine 提取，Engine 通过 manager 访问模型状态。
 *
 * _availableModels 是唯一的模型真理源。所有模型解析、enrichment
 * 都在这个数组上完成，不再经过中间层。
 */
import path from "path";
import {
  AuthStorage,
  FileAuthStorageBackend,
  createModelRegistry,
  registerModelProvider,
  unregisterModelProvider,
} from "../lib/pi-sdk/index.ts";
import { forceRefreshOAuthApiKey } from "./oauth-force-refresh.ts";
import { t } from "../lib/i18n.ts";
import { ProviderRegistry } from "./provider-registry.ts";
import { ExecutionRouter } from "./execution-router.ts";
import { composeResolvedModelExecution } from "./model-execution-config.ts";
import { findModel, parseModelRef } from "../shared/model-ref.ts";
import { isLocalBaseUrl } from "../shared/net-utils.ts";
import { normalizeProviderHeaders, stripCredentialHeaders } from "../shared/provider-auth.ts";
import { syncModels } from "./model-sync.ts";
import { enrichModelFromKnownMetadata } from "./model-known-enrichment.ts";
import { lookupKnownProvider } from "../shared/known-models.ts";
import { migrateLegacyApiKeyAuthToProviders } from "./provider-auth-migration.ts";
import {
  normalizePiSdkThinkingLevel,
  normalizeSessionThinkingLevel,
  normalizeThinkingLevelChoices,
  normalizeThinkingLevelForModel,
  resolveModelDefaultThinkingLevel,
} from "./session-thinking-level.ts";

function isRecord(value): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function modelEntryId(modelEntry: unknown) {
  return isRecord(modelEntry) ? modelEntry.id : modelEntry;
}

function modelMetadataKey(provider, modelId) {
  return `${provider || ""}\0${modelId || ""}`;
}

function providerModelDefault(rawProvider: Record<string, unknown>, modelId: string) {
  const modelDefaults = isRecord(rawProvider.model_defaults) ? rawProvider.model_defaults : null;
  const entry = isRecord(modelDefaults?.[modelId]) ? modelDefaults[modelId] : null;
  const level = entry?.thinking_level ?? entry?.thinkingLevel;
  return typeof level === "string" ? level : undefined;
}

function buildProviderModelMetadataMap(projectionPlans: unknown) {
  const map = new Map<string, Record<string, unknown>>();
  const plans = Array.isArray(projectionPlans) ? projectionPlans : [];
  for (const plan of plans) {
    const provider = plan?.sourceProviderId;
    const runtimeProvider = plan?.runtimeProviderId || provider;
    if (typeof provider !== "string" || !provider) continue;
    const rawProvider = isRecord(plan?.config) ? plan.config : {};
    const models = Array.isArray(rawProvider.models) ? rawProvider.models : [];
    for (const modelEntry of models) {
      const modelId = modelEntryId(modelEntry);
      if (typeof modelId !== "string" || !modelId) continue;
      const known = lookupKnownProvider(provider, modelId);
      const meta: Record<string, unknown> = {};
      if (isRecord(modelEntry)) {
        if (modelEntry.xhigh !== undefined) meta.xhigh = modelEntry.xhigh === true;
        if (modelEntry.defaultThinkingLevel !== undefined) meta.defaultThinkingLevel = modelEntry.defaultThinkingLevel;
        const thinkingLevels = normalizeThinkingLevelChoices(modelEntry.thinkingLevels);
        if (thinkingLevels) meta.thinkingLevels = thinkingLevels;
        if (modelEntry.thinkingLevelMap !== undefined && isRecord(modelEntry.thinkingLevelMap)) {
          meta.thinkingLevelMap = structuredClone(modelEntry.thinkingLevelMap);
        }
        if (modelEntry.toolUse !== undefined) meta.toolUse = structuredClone(modelEntry.toolUse);
        if (modelEntry.visionCapabilities !== undefined) meta.visionCapabilities = structuredClone(modelEntry.visionCapabilities);
      }
      const executionHeaders = normalizeProviderHeaders(plan?.modelExecutionHeaders?.[modelId]);
      if (Object.keys(executionHeaders).length > 0) meta.headers = executionHeaders;
      if (meta.defaultThinkingLevel === undefined && typeof known?.defaultThinkingLevel === "string") {
        meta.defaultThinkingLevel = known.defaultThinkingLevel;
      }
      if (meta.thinkingLevels === undefined) {
        const knownThinkingLevels = normalizeThinkingLevelChoices(known?.thinkingLevels);
        if (knownThinkingLevels) meta.thinkingLevels = knownThinkingLevels;
      }
      if (meta.thinkingLevelMap === undefined && known?.thinkingLevelMap && isRecord(known.thinkingLevelMap)) {
        meta.thinkingLevelMap = structuredClone(known.thinkingLevelMap);
      }
      if (typeof known?.maxContext === "number") meta.maxContext = known.maxContext;
      const defaultThinkingLevel = providerModelDefault(rawProvider, modelId);
      if (defaultThinkingLevel !== undefined) meta.defaultThinkingLevel = defaultThinkingLevel;
      if ((Array.isArray(meta.thinkingLevels) && meta.thinkingLevels.includes("max"))
        || isRecord(meta.thinkingLevelMap) && typeof meta.thinkingLevelMap.xhigh === "string") {
        if (meta.xhigh === undefined) meta.xhigh = true;
      }
      if (Object.keys(meta).length > 0) {
        map.set(modelMetadataKey(runtimeProvider, modelId), meta);
        map.set(modelMetadataKey(provider, modelId), meta);
      }
    }
  }
  return map;
}

function applyProviderModelMetadata(model, metadataByModel) {
  const meta = metadataByModel.get(modelMetadataKey(model?.provider, model?.id));
  if (!meta) return model;
  const merged = { ...model, ...meta };
  const thinkingLevels = normalizeThinkingLevelChoices(merged.thinkingLevels);
  if (thinkingLevels) {
    merged.thinkingLevels = thinkingLevels;
    if (thinkingLevels.includes("max")) merged.xhigh = true;
  } else {
    delete merged.thinkingLevels;
  }
  if (typeof merged.defaultThinkingLevel === "string") {
    merged.defaultThinkingLevel = normalizeThinkingLevelForModel(merged.defaultThinkingLevel, merged);
  }
  return merged;
}

export class ModelManager {
  declare _authBackend: any;
  declare _authStorage: any;
  declare _availableModels: any;
  declare _defaultModel: any;
  declare _lucHome: any;
  declare _modelRegistry: any;
  declare _registeredSdkProviderIds: Set<string>;
  declare executionRouter: any;
  declare providerRegistry: any;
  /**
   * @param {object} opts
   * @param {string} opts.luccodeHome - 用户数据根目录
   */
  constructor({ lucHome }) {
    this._lucHome = lucHome;
    this._authStorage = null;
    this._authBackend = null;
    this._modelRegistry = null;
    this._registeredSdkProviderIds = new Set();
    this._defaultModel = null;   // 设置页面选的，持久化，bridge 用这个
    this._availableModels = [];

    // 新架构模块（init() 后可用）
    this.providerRegistry = new ProviderRegistry(lucHome);
    this.executionRouter = null;
  }

  /** 初始化 AuthStorage + ModelRegistry + 新架构模块 */
  init() {
    this._authStorage = AuthStorage.create(path.join(this._lucHome, "auth.json"));
    // Same file, same lock: forced OAuth rotation writes through this backend.
    this._authBackend = new FileAuthStorageBackend(path.join(this._lucHome, "auth.json"));
    this.providerRegistry.reload();
    this._removeApiKeyProviderAuthEntries();
    const projection = this._buildChatProjectionInputs();
    this._applyRuntimeApiKeyOverrides(projection);
    syncModels(projection.providers, {
      modelsJsonPath: this.modelsJsonPath,
      chatProjectionPlans: projection.planMap,
    });
    this._modelRegistry = createModelRegistry(
      this._authStorage,
      path.join(this._lucHome, "models.json"),
    );
    this._syncSdkProviderRegistrations();

    this.executionRouter = new ExecutionRouter(
      (ref) => this._resolveFromAvailable(ref),
      this.providerRegistry,
      (provider) => this.resolveProviderCredentialsFresh(provider),
    );
  }

  // ── Getters ──

  get authStorage() { return this._authStorage; }
  get modelRegistry() { return this._modelRegistry; }
  get defaultModel() { return this._defaultModel; }
  set defaultModel(m) { this._defaultModel = m; }
  get currentModel() { return this._defaultModel; }
  get availableModels() { return this._availableModels; }
  get modelsJsonPath() { return path.join(this._lucHome, "models.json"); }
  get authJsonPath() { return path.join(this._lucHome, "auth.json"); }

  // ── 模型解析：_availableModels 唯一真理源 ──

  /**
   * 从 _availableModels 解析模型引用。
   *
   * 合法输入（通过 parseModelRef 规整后必须带 provider）：
   *   - {id, provider} 对象
   *   - "provider/id" 字符串
   *
   * 裸 id 字符串**不合法**——历史数据走 migrations #5，运行期调用方必须显式带 provider。
   * ref 无法解析出 provider 时返 null（不按 id 降级猜）。
   *
   * @param {string|object} ref - 模型引用
   * @returns {object|null} SDK 模型对象
   */
  _resolveFromAvailable(ref) {
    const parsed = parseModelRef(ref);
    if (!parsed?.id || !parsed.provider) return null;
    return findModel(this._availableModels, parsed.id, parsed.provider) || null;
  }

  // ── 刷新 ──

  _getPersistedModelDefaultThinkingLevel(model) {
    if (!model?.provider || !model.id) return null;
    if (typeof this.providerRegistry.getModelDefaultThinkingLevel !== "function") return null;
    return this.providerRegistry.getModelDefaultThinkingLevel(model.provider, model.id);
  }

  _withPersistedModelDefaultThinkingLevel(model) {
    const level = this._getPersistedModelDefaultThinkingLevel(model);
    return level ? { ...model, defaultThinkingLevel: level } : model;
  }

  /** 刷新可用模型列表，用 Provider Catalog v2 过滤 */
  async refreshAvailable() {
    const allModels = await this._modelRegistry.getAvailable();
    const plans = this.providerRegistry.getChatProjectionPlans();
    const effectiveModelSets = new Map();
    const legacyRuntimeCatalogProviders = new Set();
    for (const plan of plans) {
      if (plan.projection === "none") continue;
      if (plan.projection === "sdk-auth-alias" && plan.selectionMode === "runtime-catalog") {
        legacyRuntimeCatalogProviders.add(plan.runtimeProviderId);
        continue;
      }
      const ids = new Set((plan.config?.models || []).map(modelEntryId).filter(Boolean));
      effectiveModelSets.set(plan.runtimeProviderId, ids);
    }
    const metadataByModel = buildProviderModelMetadataMap(plans);
    this._availableModels = allModels.filter(m => {
      if (legacyRuntimeCatalogProviders.has(m.provider)) return true;
      const allowed = effectiveModelSets.get(m.provider);
      return !!allowed && allowed.has(m.id);
    })
      .map(m => applyProviderModelMetadata(m, metadataByModel))
      .map(enrichModelFromKnownMetadata)
      .map(m => this._withPersistedModelDefaultThinkingLevel(m));
    return this._availableModels;
  }

  /**
   * 同步 Provider Catalog provider configs → models.json，然后刷新 ModelRegistry。
   *
   * ⚠ 刷新后 _availableModels 是全新数组，旧的 model 对象引用（含烤在字段里的
   * 过期 baseUrl）会失效。本方法负责把 _defaultModel 指针也重新定位到新数组里
   * 的对应对象——否则新建 session 会继续用旧 baseUrl 发请求（provider 改端点后
   * 出现 429 的根因）。
   *
   * @returns {boolean} 是否有变化
   */
  async syncAndRefresh() {
    this._removeApiKeyProviderAuthEntries();
    const projection = this._buildChatProjectionInputs();
    const changed = syncModels(projection.providers, {
      modelsJsonPath: this.modelsJsonPath,
      chatProjectionPlans: projection.planMap,
    });
    this._applyRuntimeApiKeyOverrides(projection);
    if (changed) {
      this._modelRegistry.refresh();
    }
    await this.refreshAvailable();
    this._rebindDefaultModel();
    return changed;
  }

  /**
   * Reconcile ProviderRegistry-owned dynamic SDK declarations with this
   * ModelRegistry instance. The set belongs to ModelManager because dynamic
   * registration is lifecycle state of this concrete SDK registry.
   */
  _syncSdkProviderRegistrations() {
    if (!this._modelRegistry) return;
    const registrations = this.providerRegistry.getSdkProviderRegistrations();
    const nextIds = new Set<string>(registrations.map((registration) => registration.providerId));
    // ModelRegistry.registerProvider is an upsert: omitted fields survive from
    // the prior config. Remove every previously owned declaration first so a
    // catalog/plugin reload has exact replacement semantics, including deleted
    // oauth, headers, or hooks.
    for (const providerId of this._registeredSdkProviderIds) {
      unregisterModelProvider(this._modelRegistry, providerId);
    }
    const appliedIds: string[] = [];
    try {
      for (const registration of registrations) {
        registerModelProvider(
          this._modelRegistry,
          registration.providerId,
          registration.config,
        );
        appliedIds.push(registration.providerId);
      }
    } catch (error) {
      for (const providerId of appliedIds) {
        unregisterModelProvider(this._modelRegistry, providerId);
      }
      this._registeredSdkProviderIds = new Set();
      throw error;
    }
    this._registeredSdkProviderIds = nextIds;
  }

  _buildChatProjectionInputs() {
    const plans = this.providerRegistry.getChatProjectionPlans();
    const providers: Record<string, any> = {};
    const planMap: Record<string, any> = {};
    for (const plan of plans) {
      providers[plan.sourceProviderId] = plan.config;
      planMap[plan.sourceProviderId] = {
        sourceProviderId: plan.sourceProviderId,
        runtimeProviderId: plan.runtimeProviderId,
        projection: plan.projection,
        credentialSource: plan.credentialSource,
        selectionMode: plan.selectionMode,
        hasExplicitModels: plan.hasExplicitModels,
        modelExecutionHeaders: plan.modelExecutionHeaders,
      };
    }
    return { plans, providers, planMap };
  }

  _applyRuntimeApiKeyOverrides(projection) {
    if (!this._authStorage?.setRuntimeApiKey) return;
    for (const plan of projection?.plans || []) {
      const provider = projection.providers?.[plan.sourceProviderId] || {};
      const runtimeProviderId = plan.runtimeProviderId || plan.sourceProviderId;
      const cleanupIds = new Set([runtimeProviderId, plan.sourceProviderId]);
      if (plan.credentialSource === "provider-catalog"
        && typeof provider.api_key === "string"
        && provider.api_key.length > 0) {
        this._authStorage.setRuntimeApiKey(runtimeProviderId, provider.api_key);
        for (const providerId of cleanupIds) {
          if (providerId !== runtimeProviderId) this._authStorage.removeRuntimeApiKey?.(providerId);
        }
      } else {
        for (const providerId of cleanupIds) this._authStorage.removeRuntimeApiKey?.(providerId);
      }
    }
  }

  /**
   * _availableModels 重建后，把 _defaultModel 重新绑到新数组里的对应对象。
   * 找不到则置 null（provider 被删、模型消失等）。
   * @private
   */
  _rebindDefaultModel() {
    if (!this._defaultModel) return;
    const { id, provider } = this._defaultModel;
    if (!id || !provider) {
      this._defaultModel = null;
      return;
    }
    this._defaultModel = findModel(this._availableModels, id, provider) || null;
  }

  /**
   * Luc 的 API-key provider 凭证源是 Provider Catalog → models.json。
   * AuthStorage 只保留 OAuth 条目，避免 Pi SDK 优先读取 stale auth.json。
   * @private
   */
  _removeApiKeyProviderAuthEntries() {
    if (!this._authStorage || !this.providerRegistry) return;
    migrateLegacyApiKeyAuthToProviders({
      lucHome: this._lucHome,
      providerRegistry: this.providerRegistry,
    });
    this._authStorage.reload?.();

    const entries = [...this.providerRegistry.getAll().values()];
    const oauthOwnedAuthKeys = new Set();
    for (const entry of entries) {
      if (entry.authType !== "oauth") continue;
      if (entry.id) oauthOwnedAuthKeys.add(entry.id);
      if (entry.authJsonKey) oauthOwnedAuthKeys.add(entry.authJsonKey);
    }

    for (const entry of entries) {
      if (entry.authType === "oauth") continue;
      const authKeys = new Set([entry.id, entry.authJsonKey]);
      for (const authKey of authKeys) {
        // A malformed/synthetic provider may collide with an OAuth runtime alias
        // (for example `openai-codex`). Projection validation will reject that
        // catalog, but cleanup must never delete the OAuth owner's credentials
        // while surfacing the collision.
        if (oauthOwnedAuthKeys.has(authKey)) continue;
        if (!authKey || !this._authStorage.has?.(authKey)) continue;
        this._authStorage.remove(authKey);
      }
    }
  }

  /**
   * 设置 agent 默认模型
   * @returns {object} 新模型对象
   */
  setDefaultModel(modelId, provider) {
    const model = findModel(this._availableModels, modelId, provider);
    if (!model) throw new Error(t("error.modelNotFound", { id: modelId }));
    this._defaultModel = model;
    return model;
  }

  /** Convert Luc-visible thinking levels to the Pi SDK session contract. */
  resolveThinkingLevel(level) {
    return normalizePiSdkThinkingLevel(level);
  }

  _resolveModelForThinkingDefault(modelRef) {
    if (!modelRef) return this.currentModel;
    if (typeof modelRef === "object" && modelRef.id && modelRef.provider) {
      return findModel(this._availableModels, modelRef.id, modelRef.provider) || modelRef;
    }
    return this.resolveExecutionModel(modelRef);
  }

  getModelDefaultThinkingLevel(modelRef = null, fallback = "medium") {
    const model = this._resolveModelForThinkingDefault(modelRef);
    const effectiveModel = this._withPersistedModelDefaultThinkingLevel(model);
    return resolveModelDefaultThinkingLevel(effectiveModel, normalizeSessionThinkingLevel(fallback));
  }

  async setModelDefaultThinkingLevel(modelRef, level) {
    const model = this._resolveModelForThinkingDefault(modelRef);
    if (!model?.id || !model.provider) {
      throw new Error("setModelDefaultThinkingLevel: model id and provider required");
    }
    const nextLevel = normalizeThinkingLevelForModel(level, model);
    this.providerRegistry.setModelDefaultThinkingLevel(model.provider, model.id, nextLevel);
    await this.syncAndRefresh();
    await this.refreshAvailable();
    this._rebindDefaultModel();
    const refreshed = findModel(this._availableModels, model.id, model.provider)
      || { ...model, defaultThinkingLevel: nextLevel };
    return {
      model: refreshed,
      thinkingLevel: resolveModelDefaultThinkingLevel(refreshed, nextLevel),
    };
  }

  /**
   * 将模型引用（provider/id 或 {id, provider}）解析成 SDK 可用的模型对象
   * 只查 _availableModels（唯一真理源）
   */
  resolveExecutionModel(modelRef) {
    if (!modelRef) return this.currentModel;
    if (typeof modelRef === "string" && !modelRef.trim()) return this.currentModel;

    const parsed = parseModelRef(modelRef);
    const model = parsed?.id && parsed.provider
      ? findModel(this._availableModels, parsed.id, parsed.provider)
      : null;
    if (model) return model;

    const id = parsed?.id
      ? (parsed.provider ? `${parsed.provider}/${parsed.id}` : parsed.id)
      : String(modelRef);
    throw new Error(t("error.modelNotFound", { id }));
  }

  /**
   * 根据 provider 名称查找凭证
   * 委托 ProviderRegistry，返回 snake_case 格式（兼容 callProviderText 消费方）
   * @param {string} provider
   * @returns {{ api_key: string, base_url: string, api: string, headers?: Record<string, string>, accountId?: string }}
   */
  resolveProviderCredentials(provider) {
    if (!provider) return { api_key: "", base_url: "", api: "" };
    const cred = this.providerRegistry.getCredentials(provider);
    if (cred) {
      return {
        api_key: cred.apiKey || "",
        base_url: cred.baseUrl || "",
        api: cred.api || "",
        headers: cred.headers || {},
        ...(cred.accountId ? { accountId: cred.accountId } : {}),
      };
    }
    return { api_key: "", base_url: "", api: "" };
  }

  /**
   * OAuth-aware provider credential resolution for non-chat runtimes.
   *
   * Chat execution goes through Pi SDK ModelRegistry, whose AuthStorage path
   * refreshes OAuth tokens. Media adapters historically bypassed that path by
   * reading ProviderRegistry credentials directly, so they could keep using an
   * expired access token until a chat request refreshed it. This method makes
   * the refresh boundary explicit without moving adapter-specific semantics into
   * ProviderRegistry.
   *
   * `options.forceRefresh` goes one step further: it rotates the OAuth
   * credential regardless of the locally recorded expiry, for callers whose
   * request was just rejected by the provider. `options.staleApiKey` is the
   * token that got rejected, so a concurrent rotation is not repeated.
   *
   * @param {string} provider
   * @param {{ forceRefresh?: boolean, staleApiKey?: string }} [options]
   * @returns {Promise<{ api_key: string, base_url: string, api: string, accountId?: string }>}
   */
  async resolveProviderCredentialsFresh(provider, options: { forceRefresh?: boolean, staleApiKey?: string } = {}) {
    if (!provider) return { api_key: "", base_url: "", api: "" };
    const chatProvider = this.providerRegistry.resolveChatProvider?.(provider);
    const entry = chatProvider?.entry || this.providerRegistry.get(provider);
    const credentialSource = chatProvider?.credentialSource
      || (this.providerRegistry.getAuthType(provider) === "oauth" ? "auth-storage" : "provider-catalog");
    if (!entry) return { api_key: "", base_url: "", api: "" };
    let refreshedOAuthKey = null;
    if (credentialSource === "auth-storage") {
      if (!entry) {
        throw new Error(t("error.providerMissingCreds", { provider }));
      }
      const rawProvider = this.providerRegistry.getAllProvidersRaw?.()[entry.id] || {};
      const authKey = this.providerRegistry.getAuthJsonKey(provider);
      if (!this._authStorage || typeof this._authStorage.getApiKey !== "function") {
        throw new Error(`${t("error.providerMissingCreds", { provider })} (auth: ${authKey})`);
      }
      refreshedOAuthKey = options.forceRefresh
        ? await forceRefreshOAuthApiKey({
            authStorage: this._authStorage,
            backend: this._authBackend,
            authKey,
            staleApiKey: options.staleApiKey,
          })
        : await this._authStorage.getApiKey(authKey, { includeFallback: false });
      this._authStorage.reload?.();
      this.providerRegistry.clearAuthCache?.();
      if (!refreshedOAuthKey) {
        throw new Error(`${t("error.providerMissingCreds", { provider })} (auth: ${authKey})`);
      }
      const authEntry = this._authStorage.get?.(authKey) || null;
      const cred = this.providerRegistry.getCredentials(provider);
      const accountId = authEntry?.accountId || authEntry?.account_id || cred?.accountId || "";
      return {
        // OAuth execution credentials belong exclusively to AuthStorage. In particular,
        // never let a stale Provider Catalog api_key or Authorization/Cookie header
        // override the token that was just refreshed under the AuthStorage lock.
        api_key: refreshedOAuthKey || "",
        base_url: authEntry?.resourceUrl
          || authEntry?.resource_url
          || rawProvider.base_url
          || cred?.baseUrl
          || entry.baseUrl
          || "",
        api: rawProvider.api || entry.api || cred?.api || "",
        headers: stripCredentialHeaders(entry.headers || {}),
        credential_source: "auth-storage",
        ...(accountId ? { accountId } : {}),
      };
    }
    if (credentialSource === "provider-catalog" && entry) {
      const allRawProviders = this.providerRegistry.getAllProvidersRaw?.() || {};
      const rawProvider = allRawProviders[entry.id] || allRawProviders[provider] || {};
      return {
        api_key: rawProvider.api_key || "",
        base_url: rawProvider.base_url || entry.baseUrl || "",
        api: rawProvider.api || entry.api || "",
        headers: rawProvider.headers || entry.headers || {},
        credential_source: "provider-catalog",
      };
    }
    if (credentialSource === "none" && entry) {
      const allRawProviders = this.providerRegistry.getAllProvidersRaw?.() || {};
      const rawProvider = allRawProviders[entry.id] || allRawProviders[provider] || {};
      return {
        api_key: "",
        base_url: rawProvider.base_url || entry.baseUrl || "",
        api: rawProvider.api || entry.api || "",
        headers: rawProvider.headers || entry.headers || {},
        credential_source: "none",
      };
    }
    throw new Error(`Unsupported credentialSource "${credentialSource}" for provider "${provider}"`);
  }

  _resolvedModelCredentialResult(entry, creds) {
    const provider = entry?.provider;
    if (!provider) {
      throw new Error(t("error.modelNoProvider", { role: "resolve", model: String(entry?.id || "") }));
    }
    const declaredCredentialSource = creds?.credential_source || creds?.credentialSource;
    const inferredCredentialSource = declaredCredentialSource
      || this.providerRegistry?.resolveChatProvider?.(provider)?.credentialSource
      || (this.providerRegistry?.getAuthType?.(provider) === "oauth" ? "auth-storage" : "");
    const execution = composeResolvedModelExecution({
      model: entry,
      credential: inferredCredentialSource
        ? { ...creds, credential_source: inferredCredentialSource }
        : creds,
    });
    if (!execution.api) {
      throw new Error(t("error.providerMissingApi", { provider }));
    }
    const allowsMissingApiKey = this.providerRegistry?.allowsMissingApiKey?.(provider, execution.baseUrl)
      ?? isLocalBaseUrl(execution.baseUrl);
    const credentialHeaders = creds?.headers && typeof creds.headers === "object" ? creds.headers : {};
    const hasCredentialHeaders = Object.keys(credentialHeaders).length > 0;
    if (!execution.baseUrl || (!execution.apiKey && !hasCredentialHeaders && !allowsMissingApiKey)) {
      throw new Error(t("error.providerMissingCreds", { provider }));
    }
    return {
      model: execution.model,
      provider,
      api: execution.api,
      api_key: execution.apiKey,
      base_url: execution.baseUrl,
      headers: execution.headers,
      ...(execution.credentialSource ? { credential_source: execution.credentialSource } : {}),
      ...(execution.accountId ? { accountId: execution.accountId } : {}),
    };
  }

  /**
   * Provider 配置变更后 reload registry + 重新同步模型。
   * 由 engine.onProviderChanged() 调用，不要直接用。
   */
  async reloadAndSync() {
    this.providerRegistry.reload();
    this._syncSdkProviderRegistrations();
    await this.syncAndRefresh();
  }

  /**
   * 统一解析：模型引用 -> { model, provider, api, api_key, base_url }
   *
   * model 字段是**完整 model 对象**（不再是裸 id 字符串）。所有 callText 消费方
   * 解构出 model 后直接传给 callText，由 callText 内部走 provider-compat。
   *
   * @param {string|object} modelRef
   * @returns {{ model: object, provider: string, api: string, api_key: string, base_url: string }}
   */
  resolveModelWithCredentials(modelRef) {
    const entry = this.resolveExecutionModel(modelRef);
    const provider = entry?.provider;
    if (!provider) {
      throw new Error(t("error.modelNoProvider", { role: "resolve", model: String(modelRef) }));
    }
    return this._resolvedModelCredentialResult(entry, this.resolveProviderCredentials(provider));
  }

  /**
   * 请求时解析模型与凭证。模型身份始终先从 Luc availableModels 解析，
   * 其协议和规范化 endpoint 保持权威。凭证随后在请求边界刷新并只补充
   * auth/account/headers；OAuth 的动态 resourceUrl 是 endpoint 唯一例外。
   * 不会回退到 ProviderRegistry 缓存中的旧 access token。
   */
  async resolveModelWithCredentialsFresh(modelRef) {
    const entry = this.resolveExecutionModel(modelRef);
    const provider = entry?.provider;
    if (!provider) {
      throw new Error(t("error.modelNoProvider", { role: "resolve", model: String(modelRef) }));
    }
    const creds = await this.resolveProviderCredentialsFresh(provider);
    return this._resolvedModelCredentialResult(entry, creds);
  }

  /**
   * 解析 utility 模型 + API 凭证完整配置
   * 委托 ExecutionRouter
   */
  resolveUtilityConfig(agentConfig, sharedModels, utilApi, options = {}) {
    if (!this.executionRouter) {
      throw new Error(t("error.noUtilityModel"));
    }
    return this.executionRouter.resolveUtilityConfig(agentConfig, sharedModels, utilApi, options);
  }

  async resolveUtilityConfigFresh(agentConfig, sharedModels, utilApi, options = {}) {
    if (!this.executionRouter) {
      throw new Error(t("error.noUtilityModel"));
    }
    return this.executionRouter.resolveUtilityConfigFresh(agentConfig, sharedModels, utilApi, options);
  }

  /**
   * 从 Pi SDK registry 获取某 provider 的所有模型（不经过 Provider Catalog 过滤）
   * 用于模型发现（fetch-models），不影响主应用的 availableModels
   * @param {string} name - provider ID
   * @returns {object[]}
   */
  getRegistryModelsForProvider(name) {
    const authKey = this.providerRegistry.getAuthJsonKey(name);
    const all = this._modelRegistry.getAll();
    return all.filter(m => m.provider === name || m.provider === authKey);
  }
}
