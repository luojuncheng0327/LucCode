/**
 * ProviderRegistry — 声明式 provider 插件注册表
 *
 * 职责：
 *   - 管理所有已知 provider 的静态声明（能力、协议、认证类型）
 *   - 将插件声明与 Provider Catalog 用户配置合并为 ProviderEntry
 *   - 读取 provider 凭证（api_key / base_url / api）
 *   - 管理 provider 的模型列表（CRUD + 持久化）
 *
 * 设计来源：OpenClaw 的插件注册表模式
 */

import fs from "fs";
import path from "path";
import YAML from "js-yaml";
import { writeSecretFileSync } from "../shared/secret-fs.ts";
import { fromRoot } from "../shared/luc-root.ts";
import { lookupKnown } from "../shared/known-models.ts";
import {
  normalizeProviderHeaders,
  normalizeProviderAuthType,
  providerCredentialAllowsMissingApiKey,
  stripCredentialHeaders,
} from "../shared/provider-auth.ts";
import { validateProviderModels } from "../shared/provider-model-validation.ts";
import {
  normalizeModelProtocolCompat,
  normalizeToolUseContract,
  normalizeVisionCapabilities,
} from "../shared/model-capabilities.ts";
import { validateProviderRuntime } from "./media-runtime-contract.ts";
import { capabilityKey, inferMediaProtocolId } from "./media-protocols.ts";
import { ProviderCatalogStore } from "./provider-catalog.ts";
import {
  LocalProviderPluginStore,
  isLocalProviderPlugin,
  isSafeLocalProviderPluginProviderId,
  mergeProviderModelEntries,
  providerConfigHasLocalDefinition,
  providerPluginToCatalogDefinition,
  splitLocalProviderConfig,
} from "./local-provider-plugin-store.ts";

const _defaultModels = JSON.parse(
  fs.readFileSync(fromRoot("lib", "default-models.json"), "utf-8"),
);

const MALFORMED_PROVIDER_CONFIG = "malformed_provider_config";
const INVALID_MODELS_CONFIG = "invalid_models_config";
const DELETED_PROVIDERS_KEY = "_deleted_providers";
const PROVIDER_RUNTIME_META_KEYS = new Set(["_config_error"]);
const THINKING_LEVEL_VALUES = new Set(["auto", "off", "low", "medium", "high", "xhigh", "max"]);
const CHAT_CREDENTIAL_SOURCES = new Set(["provider-catalog", "auth-storage", "none"]);
const MEDIA_USER_CONFIG_KEYS = {
  imageGeneration: "image_generation",
  videoGeneration: "video_generation",
  speechGeneration: "speech_generation",
  speechRecognition: "speech_recognition",
};

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cloneData(value) {
  return structuredClone(value);
}

function normalizeDeletedProviders(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim()))]
    : [];
}

function normalizeModelDefaults(value) {
  if (!isPlainObject(value)) return {};
  const out: any = {};
  for (const [rawModelId, rawEntry] of Object.entries(value) as [string, any][]) {
    const modelId = typeof rawModelId === "string" ? rawModelId.trim() : "";
    if (!modelId || !isPlainObject(rawEntry)) continue;
    const rawLevel = rawEntry.thinking_level ?? rawEntry.thinkingLevel;
    if (typeof rawLevel !== "string" || !THINKING_LEVEL_VALUES.has(rawLevel)) continue;
    out[modelId] = { thinking_level: rawLevel };
  }
  return out;
}

function normalizeProviderUserConfig(value) {
  if (!isPlainObject(value)) {
    return { _config_error: MALFORMED_PROVIDER_CONFIG };
  }

  const next = { ...value };
  if (Object.prototype.hasOwnProperty.call(next, "models") && !Array.isArray(next.models)) {
    delete next.models;
    next._config_error = next._config_error || INVALID_MODELS_CONFIG;
  } else if (Array.isArray(next.models)) {
    const models = [];
    for (const model of next.models) {
      if (typeof model === "string" && model.trim()) {
        models.push(model.trim());
        continue;
      }
      if (isPlainObject(model) && typeof model.id === "string" && model.id.trim()) {
        models.push({ ...model, id: model.id.trim() });
        continue;
      }
      next._config_error = next._config_error || INVALID_MODELS_CONFIG;
    }
    next.models = models;
  }
  if (Object.prototype.hasOwnProperty.call(next, "model_defaults")) {
    const modelDefaults = normalizeModelDefaults(next.model_defaults);
    if (Object.keys(modelDefaults).length > 0) {
      next.model_defaults = modelDefaults;
    } else {
      delete next.model_defaults;
    }
  }
  return next;
}

function normalizeProviderUserConfigMap(providers) {
  if (!isPlainObject(providers)) return {};
  const normalized: any = {};
  for (const [providerId, config] of Object.entries(providers)) {
    if (!providerId) continue;
    normalized[providerId] = normalizeProviderUserConfig(config);
  }
  return normalized;
}

function stripProviderRuntimeMeta(config) {
  const normalized = normalizeProviderUserConfig(config);
  const clean: any = {};
  for (const [key, value] of Object.entries(normalized)) {
    if (PROVIDER_RUNTIME_META_KEYS.has(key)) continue;
    clean[key] = value;
  }
  return clean;
}

function stripProviderRuntimeMetaMap(providers) {
  if (!isPlainObject(providers)) return {};
  const clean: any = {};
  for (const [providerId, config] of Object.entries(providers)) {
    clean[providerId] = stripProviderRuntimeMeta(config);
  }
  return clean;
}

function mediaUserConfigKey(capability) {
  const key = capabilityKey(capability);
  return MEDIA_USER_CONFIG_KEYS[key] || capability;
}

function defaultCredentialSource(authType) {
  if (authType === "oauth") return "auth-storage";
  if (authType === "none") return "none";
  return "provider-catalog";
}

function defaultChatCapability(providerId, authType = "api-key") {
  return {
    runtimeProviderId: providerId,
    displayProviderId: providerId,
    projection: "models-json",
    credentialSource: defaultCredentialSource(authType),
    allowListSource: "provider.models",
  };
}

function normalizeProviderSource(plugin, isBuiltin) {
  if (plugin?.source?.kind) return plugin.source;
  if (plugin?._pluginId) return { kind: "plugin", pluginId: plugin._pluginId };
  return { kind: isBuiltin ? "builtin" : "user" };
}

function normalizeMediaModel(model, fallback: any = {}) {
  if (!model) return null;
  const isObj = typeof model === "object";
  const id = isObj ? model.id : model;
  if (typeof id !== "string" || !id.trim()) return null;
  const protocolId = (isObj && (model.protocolId || model.protocol_id)) || fallback.protocolId || fallback.protocol_id;
  return {
    ...(isObj ? model : {}),
    id: id.trim(),
    displayName: (isObj && (model.displayName || model.display_name || model.name)) || fallback.displayName || fallback.name || id.trim(),
    ...(protocolId ? { protocolId } : {}),
  };
}

function normalizeCredentialLane(lane, fallbackProviderId) {
  if (!isPlainObject(lane)) return null;
  const providerId = lane.providerId || lane.provider_id || fallbackProviderId;
  if (typeof providerId !== "string" || !providerId.trim()) return null;
  const id = lane.id || providerId;
  return {
    ...lane,
    id,
    providerId: providerId.trim(),
    label: lane.label || providerId,
  };
}

function allowMediaModelWithoutProtocol(entry) {
  const kind = entry?.source?.kind;
  return kind === "user" || kind === "local-provider-plugin";
}

function normalizeMediaCapability(capability, entry, capabilityName) {
  if (!capability || typeof capability !== "object") return null;
  const models = [];
  const seen = new Set();
  for (const model of capability.models || []) {
    const rawId = getModelId(model);
    const inferredProtocolId = inferMediaProtocolId(entry.id, capabilityName, rawId, providerProtocolContext(entry));
    const normalized = normalizeMediaModel(model, { protocolId: entry?.runtime?.protocolId || inferredProtocolId });
    if (!normalized) continue;
    if (seen.has(normalized.id)) {
      throw new Error(`Duplicate media model "${normalized.id}" in provider "${entry.id}"`);
    }
    if (!normalized.protocolId && !allowMediaModelWithoutProtocol(entry)) {
      throw new Error(`Media model "${normalized.id}" in provider "${entry.id}" missing protocolId`);
    }
    seen.add(normalized.id);
    models.push(normalized);
  }
  const credentialLanes = [];
  const laneSeen = new Set();
  for (const rawLane of capability.credentialLanes || []) {
    const lane = normalizeCredentialLane(rawLane, entry.id);
    if (!lane) continue;
    if (laneSeen.has(lane.id)) {
      throw new Error(`Duplicate credential lane "${lane.id}" in provider "${entry.id}"`);
    }
    laneSeen.add(lane.id);
    credentialLanes.push(lane);
  }
  return {
    ...capability,
    ...(credentialLanes.length > 0 ? { credentialLanes } : {}),
    models,
  };
}

function normalizeCapabilities(plugin, entry) {
  const raw = plugin?.capabilities || {};
  const chatDefaults = defaultChatCapability(entry.id, entry.authType);
  const capabilities = {
    ...raw,
    chat: raw.chat ? { ...chatDefaults, ...raw.chat } : chatDefaults,
  };
  if (!CHAT_CREDENTIAL_SOURCES.has(capabilities.chat?.credentialSource)) {
    throw new Error(`Invalid chat credentialSource "${capabilities.chat?.credentialSource}" for provider "${entry.id}"`);
  }
  const rawMedia = raw.media || {};
  const media: any = {};
  for (const [rawKey, rawCapability] of Object.entries(rawMedia)) {
    const key = capabilityKey(rawKey);
    const normalized = normalizeMediaCapability(rawCapability, entry, rawKey);
    if (normalized) media[key] = normalized;
    else if (rawCapability !== undefined) media[key] = rawCapability;
  }
  if (Object.keys(media).length > 0) {
    capabilities.media = media;
  }
  return capabilities;
}

function getModelId(modelEntry) {
  return typeof modelEntry === "object" && modelEntry !== null ? modelEntry.id : modelEntry;
}

function omitUndefined(value) {
  const result: any = {};
  for (const [key, item] of Object.entries(value || {})) {
    if (item !== undefined) result[key] = item;
  }
  return result;
}

function assertAllowedOAuthHttpBaseUrl(providerId, baseUrl, runtime) {
  if (runtime?.kind !== "oauth-http") return;
  let baseUrlOrigin;
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new Error("not a safe HTTPS URL");
    }
    baseUrlOrigin = parsed.origin;
  } catch {
    throw new Error(`OAuth HTTP provider "${providerId}" requires a valid HTTPS baseUrl`);
  }
  if (!runtime.allowedBaseUrlOrigins.includes(baseUrlOrigin)) {
    throw new Error(
      `OAuth HTTP provider "${providerId}" rejects baseUrl origin "${baseUrlOrigin}"; ` +
      `allowed origins: ${runtime.allowedBaseUrlOrigins.join(", ")}`,
    );
  }
}

function mergeModelMetadata(base, patch) {
  const merged = { ...base, ...patch };
  if (patch.compat) {
    merged.compat = {
      ...(isPlainObject(base.compat) ? base.compat : {}),
      ...patch.compat,
    };
  }
  if (!merged.name) delete merged.name;
  return merged;
}

function getModelType(providerId, modelEntry) {
  const isObj = typeof modelEntry === "object" && modelEntry !== null;
  const id = getModelId(modelEntry);
  const known = lookupKnown(providerId, id);
  return (isObj && modelEntry.type) || known?.type || "chat";
}

/** ProviderEntry → 推断上下文（唯一构造点，避免两个调用方各传一套字段） */
function providerProtocolContext(entry) {
  const kind = entry?.source?.kind;
  return { api: entry?.api, sourceKind: kind === "local-provider-plugin" ? "user" : kind };
}

function normalizeUserMediaModels(providerId, userConfig, capabilityName, declaredModels, entry) {
  const snake = capabilityName;
  const camel = capabilityKey(capabilityName);
  const mediaConfig = userConfig?.media?.[snake] || userConfig?.media?.[camel] || {};
  const rawModels = [];
  if (Array.isArray(mediaConfig.models)) rawModels.push(...mediaConfig.models);
  if (camel === "imageGeneration" && Array.isArray(userConfig?.models)) {
    rawModels.push(...userConfig.models.filter((model) => getModelType(providerId, model) === "image"));
  }
  const declaredById = new Map(declaredModels.map((model) => [model.id, model]));
  const result = [];
  const seen = new Set();
  for (const raw of rawModels) {
    const id = getModelId(raw);
    const fallback = declaredById.get(id)
      || { protocolId: inferMediaProtocolId(providerId, capabilityName, id, providerProtocolContext(entry)) || entry?.runtime?.protocolId };
    const model = normalizeMediaModel(raw, fallback);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    result.push(model);
  }
  return result;
}

function normalizeRuntimeCapabilityError(error) {
  return {
    code: typeof error?.code === "string" && error.code.trim()
      ? error.code.trim()
      : "runtime_capability_refresh_failed",
    message: error?.message || String(error || "Runtime media capability refresh failed"),
  };
}

function publicRuntimeCapabilityState(state) {
  if (!state) return { status: "pending" };
  const { media: _media, fingerprint: _fingerprint, ...publicState } = state;
  return cloneData(publicState);
}

// ── 内置插件 ────────────────────────────────────────────────────────────────

import { dashscopePlugin } from "../lib/providers/dashscope.ts";
import { agnesPlugin } from "../lib/providers/agnes.ts";
import { openaiPlugin } from "../lib/providers/openai.ts";
import { anthropicPlugin } from "../lib/providers/anthropic.ts";
import { deepseekPlugin } from "../lib/providers/deepseek.ts";
import { deepseekResponsesPlugin } from "../lib/providers/deepseek-responses.ts";
import { geminiPlugin } from "../lib/providers/gemini.ts";
import { openrouterPlugin } from "../lib/providers/openrouter.ts";
import { opencodePlugin } from "../lib/providers/opencode.ts";
import { opencodeGoPlugin } from "../lib/providers/opencode-go.ts";
import { ollamaPlugin } from "../lib/providers/ollama.ts";
import { minimaxPlugin } from "../lib/providers/minimax.ts";
import { minimaxTokenPlanPlugin } from "../lib/providers/minimax-token-plan.ts";
import { openaiCodexOAuthPlugin } from "../lib/providers/openai-codex-oauth.ts";
// 中国
import { siliconflowPlugin } from "../lib/providers/siliconflow.ts";
import { zhipuPlugin } from "../lib/providers/zhipu.ts";
import { moonshotPlugin } from "../lib/providers/moonshot.ts";
import { baichuanPlugin } from "../lib/providers/baichuan.ts";
import { stepfunPlugin } from "../lib/providers/stepfun.ts";
import { volcenginePlugin } from "../lib/providers/volcengine.ts";
import { volcengineSpeechPlugin } from "../lib/providers/volcengine-speech.ts";
import { hunyuanPlugin } from "../lib/providers/hunyuan.ts";
import { baiduCloudPlugin } from "../lib/providers/baidu-cloud.ts";
import { modelscopePlugin } from "../lib/providers/modelscope.ts";
import { infiniPlugin } from "../lib/providers/infini.ts";
import { mimoPlugin } from "../lib/providers/mimo.ts";
import { mimoTokenPlanPlugin } from "../lib/providers/mimo-token-plan.ts";
import { systemSpeechPlugin } from "../lib/providers/system-speech.ts";
// 国际
import { groqPlugin } from "../lib/providers/groq.ts";
import { togetherPlugin } from "../lib/providers/together.ts";
import { fireworksPlugin } from "../lib/providers/fireworks.ts";
import { mistralPlugin } from "../lib/providers/mistral.ts";
import { perplexityPlugin } from "../lib/providers/perplexity.ts";
import { xaiPlugin } from "../lib/providers/xai.ts";
import { xaiOAuthPlugin } from "../lib/providers/xai-oauth.ts";
// Coding Plan
import { dashscopeCodingPlugin } from "../lib/providers/dashscope-coding.ts";
import { kimiCodingPlugin } from "../lib/providers/kimi-coding.ts";
import { volcegineCodingPlugin } from "../lib/providers/volcengine-coding.ts";
import { zhipuCodingPlugin } from "../lib/providers/zhipu-coding.ts";

const BUILTIN_PLUGINS = [
  agnesPlugin,
  dashscopePlugin,
  openaiPlugin,
  anthropicPlugin,
  deepseekPlugin,
  deepseekResponsesPlugin,
  geminiPlugin,
  openrouterPlugin,
  opencodePlugin,
  opencodeGoPlugin,
  ollamaPlugin,
  minimaxPlugin,
  minimaxTokenPlanPlugin,
  openaiCodexOAuthPlugin,
  // 中国
  siliconflowPlugin,
  zhipuPlugin,
  moonshotPlugin,
  baichuanPlugin,
  stepfunPlugin,
  volcenginePlugin,
  volcengineSpeechPlugin,
  hunyuanPlugin,
  baiduCloudPlugin,
  modelscopePlugin,
  infiniPlugin,
  mimoPlugin,
  mimoTokenPlanPlugin,
  systemSpeechPlugin,
  // 国际
  groqPlugin,
  togetherPlugin,
  fireworksPlugin,
  mistralPlugin,
  perplexityPlugin,
  xaiPlugin,
  xaiOAuthPlugin,
  // Coding Plan
  dashscopeCodingPlugin,
  kimiCodingPlugin,
  volcegineCodingPlugin,
  zhipuCodingPlugin,
];

// ── Types (JSDoc) ─────────────────────────────────────────────────────────────

/**
 * @typedef {object} ProviderPlugin
 * @property {string} id
 * @property {string} displayName
 * @property {"api-key"|"oauth"|"none"|"optional"} authType
 * @property {string} defaultBaseUrl
 * @property {string} defaultApi
 * @property {string} [authJsonKey] - OAuth provider 在 auth.json 中的 key（不同于 id 时）
 * @property {Array<string|object>} [models] - 固定 chat 模型列表（本地 Provider Plugin 可直接声明）
 * @property {Record<string, Record<string, string>>|((modelId: string) => Record<string, string>)} [modelExecutionHeaders]
 *   Provider-owned per-model protocol/routing headers. Credential-bearing names are filtered from this lane.
 * @property {object} [capabilities]
 * @property {object} [runtime]
 * @property {{providerId: string, config: import('../lib/pi-sdk/index.ts').SdkProviderRegistrationConfig}} [sdkProvider]
 * @property {object} [source]
 */

/**
 * @typedef {object} ProviderEntry
 * @property {string} id
 * @property {string} displayName
 * @property {"api-key"|"oauth"|"none"|"optional"} authType
 * @property {string} baseUrl        - 生效的 base URL（用户覆盖 > 插件默认）
 * @property {string} api            - 生效的 API 协议
 * @property {string} [authJsonKey]
 * @property {boolean} isBuiltin     - 是否为内置插件
 */

// ── ProviderRegistry ─────────────────────────────────────────────────────────

export class ProviderRegistry {
  declare _addedModelsCache: any;
  declare _addedModelsMtime: any;
  declare _authJsonCache: any;
  declare _authJsonMtime: any;
  declare _builtinPlugins: any;
  declare _catalog: ProviderCatalogStore;
  declare _entries: any;
  declare _lucHome: any;
  declare _localProviderPlugins: LocalProviderPluginStore;
  declare _plugins: any;
  declare _runtimeMediaCapabilities: any;
  declare _runtimeMediaCapabilitySources: any;
  declare _runtimeMediaRefreshes: any;
  /**
   * @param {string} lucHome - 用户数据根目录（如 ~/.luccode-dev）
   */
  constructor(lucHome) {
    this._lucHome = lucHome;
    this._catalog = new ProviderCatalogStore(lucHome);
    this._localProviderPlugins = new LocalProviderPluginStore(lucHome);
    /** @type {Map<string, ProviderPlugin>} id → plugin */
    this._plugins = new Map();
    this._builtinPlugins = new Map();
    /** @type {Map<string, ProviderEntry>} id → entry（合并后） */
    this._entries = new Map();
    /** @type {Map<string, {owner: object, refresh: Function}>} provider id → transient discovery source */
    this._runtimeMediaCapabilitySources = new Map();
    /** @type {Map<string, object>} provider id → last runtime capability snapshot/status */
    this._runtimeMediaCapabilities = new Map();
    /** @type {Map<string, Promise<object>>} provider id → in-flight refresh */
    this._runtimeMediaRefreshes = new Map();

    // mtime 缓存：避免热路径上重复读盘解析 YAML/JSON
    /** @private */ this._addedModelsCache = null;
    /** @private */ this._addedModelsMtime = 0;
    /** @private */ this._authJsonCache = null;
    /** @private */ this._authJsonMtime = 0;

    // 注册内置插件
    for (const plugin of BUILTIN_PLUGINS) {
      this._plugins.set(plugin.id, plugin);
      this._builtinPlugins.set(plugin.id, plugin);
    }
    this._reloadLocalProviderPlugins();
  }

  _isBuiltinPlugin(id, plugin) {
    return this._builtinPlugins.get(id) === plugin;
  }

  _reloadLocalProviderPlugins() {
    for (const [id, plugin] of [...this._plugins.entries()]) {
      if (isLocalProviderPlugin(plugin)) this._plugins.delete(id);
    }
    for (const plugin of this._localProviderPlugins.readAll()) {
      validateProviderRuntime(plugin.runtime);
      this._plugins.set(plugin.id, plugin);
    }
  }

  _mergeRawProviderConfig(providerId, overlay = {}) {
    const plugin = this._plugins.get(providerId);
    if (!isLocalProviderPlugin(plugin)) return cloneData(overlay || {});
    const definition: Record<string, any> = providerPluginToCatalogDefinition(plugin);
    const rawOverlay: Record<string, any> = overlay || {};
    const merged: Record<string, any> = {
      ...definition,
      ...rawOverlay,
    };
    if (Object.prototype.hasOwnProperty.call(definition, "models") || Object.prototype.hasOwnProperty.call(rawOverlay, "models")) {
      merged.models = mergeProviderModelEntries(definition.models, rawOverlay.models);
    }
    return {
      ...merged,
    };
  }

  _writeLocalProviderPlugin(providerId, config, existingPlugin = null) {
    const { plugin, overlay } = splitLocalProviderConfig(providerId, config, existingPlugin);
    const runtime = validateProviderRuntime(plugin.runtime);
    assertAllowedOAuthHttpBaseUrl(providerId, plugin.defaultBaseUrl, runtime);
    validateProviderModels(providerId, plugin.models, { baseUrl: plugin.defaultBaseUrl });
    const saved = this._localProviderPlugins.writeProvider(providerId, plugin);
    this._plugins.set(providerId, saved);
    return overlay;
  }

  _migrateCatalogOnlyProvidersToLocalPlugins(userConfig) {
    let changed = false;
    const nextConfig = cloneData(userConfig || {});
    for (const [providerId, config] of Object.entries(userConfig || {}) as [string, any][]) {
      if (this._plugins.has(providerId)) continue;
      if (!isSafeLocalProviderPluginProviderId(providerId)) continue;
      if (!providerConfigHasLocalDefinition(config)) continue;
      nextConfig[providerId] = this._writeLocalProviderPlugin(providerId, config, null);
      changed = true;
    }
    if (!changed) return userConfig;
    this._saveAddedModels(nextConfig, {
      localProviderPluginsMigratedAt: new Date().toISOString(),
    });
    return this._loadAddedModels();
  }

  /**
   * 注册 provider 插件
   * 同一 id 注册两次会覆盖（方便测试/扩展）
   * @param {ProviderPlugin} plugin
   */
  register(plugin) {
    if (!plugin?.id) throw new Error("ProviderPlugin must have an id");
    validateProviderRuntime(plugin.runtime);
    this._plugins.set(plugin.id, plugin);
    // 让 reload() 在下次调用时重新合并
    this._entries.delete(plugin.id);
  }

  registerProviderContribution(plugin) {
    this.register(plugin);
  }

  /**
   * Register a process-local media capability discovery source. Runtime facts
   * never enter Provider Catalog; the provider plugin remains responsible for
   * querying its own executable or service.
   */
  registerRuntimeMediaCapabilitySource(providerId, source, owner: any = {}) {
    if (typeof providerId !== "string" || !providerId.trim()) {
      throw new Error("Runtime media capability source requires providerId");
    }
    if (!source || typeof source.refresh !== "function") {
      throw new Error(`Runtime media capability source for "${providerId}" requires refresh()`);
    }
    const normalizedProviderId = providerId.trim();
    const existing = this._runtimeMediaCapabilitySources.get(normalizedProviderId);
    const existingOwner = existing?.owner?.pluginId;
    const nextOwner = owner?.pluginId;
    if (existing && existingOwner && nextOwner && existingOwner !== nextOwner) {
      throw new Error(
        `Runtime media capability source for "${normalizedProviderId}" is already owned by "${existingOwner}"`,
      );
    }
    this._runtimeMediaCapabilitySources.set(normalizedProviderId, {
      owner: cloneData(owner || {}),
      refresh: source.refresh,
    });
    if (existing?.refresh !== source.refresh) {
      this._runtimeMediaCapabilities.delete(normalizedProviderId);
    }
  }

  unregisterRuntimeMediaCapabilitySource(providerId, owner: any = {}) {
    const existing = this._runtimeMediaCapabilitySources.get(providerId);
    if (!existing) return false;
    const existingOwner = existing.owner?.pluginId;
    const requestedOwner = owner?.pluginId;
    if (existingOwner && requestedOwner && existingOwner !== requestedOwner) {
      throw new Error(
        `Runtime media capability source for "${providerId}" is owned by "${existingOwner}"`,
      );
    }
    this._runtimeMediaCapabilitySources.delete(providerId);
    this._runtimeMediaCapabilities.delete(providerId);
    this._runtimeMediaRefreshes.delete(providerId);
    return true;
  }

  getRuntimeMediaCapabilitySourceOwner(providerId) {
    const owner = this._runtimeMediaCapabilitySources.get(providerId)?.owner;
    return owner ? cloneData(owner) : null;
  }

  getRuntimeMediaCapabilityState(providerId) {
    if (!this._runtimeMediaCapabilitySources.has(providerId)) return null;
    return publicRuntimeCapabilityState(this._runtimeMediaCapabilities.get(providerId));
  }

  async refreshRuntimeMediaCapabilities({ providerId, capability }: any = {}) {
    const targets = providerId
      ? [providerId]
      : [...this._runtimeMediaCapabilitySources.keys()];
    const results: any = {};
    await Promise.all(targets.map(async (targetProviderId) => {
      if (!this._runtimeMediaCapabilitySources.has(targetProviderId)) return;
      results[targetProviderId] = await this._refreshRuntimeMediaCapability(targetProviderId, capability);
    }));
    return results;
  }

  async _refreshRuntimeMediaCapability(providerId, capability) {
    const existingRefresh = this._runtimeMediaRefreshes.get(providerId);
    if (existingRefresh) return existingRefresh;

    const refreshPromise = (async () => {
      const source = this._runtimeMediaCapabilitySources.get(providerId);
      if (!source) return null;
      const previous = this._runtimeMediaCapabilities.get(providerId);
      try {
        if (this._entries.size === 0) this.reload();
        const entry = this._entries.get(providerId) || this.get(providerId);
        if (!entry) throw new Error(`Runtime media provider "${providerId}" is not registered`);
        const snapshot = await source.refresh({ providerId, capability });
        if (this._runtimeMediaCapabilitySources.get(providerId) !== source) return null;
        if (!isPlainObject(snapshot?.media)) {
          throw new Error(`Runtime media capability source for "${providerId}" returned no media snapshot`);
        }
        const media: any = {};
        let modelCount = 0;
        for (const [rawKey, rawCapability] of Object.entries(snapshot.media)) {
          const key = capabilityKey(rawKey);
          const normalized = normalizeMediaCapability(rawCapability, entry, rawKey);
          if (!normalized) continue;
          if (normalized.defaultModelId && !normalized.models.some((model) => model.id === normalized.defaultModelId)) {
            throw new Error(
              `Runtime media default model "${normalized.defaultModelId}" is absent for "${providerId}/${key}"`,
            );
          }
          media[key] = normalized;
          modelCount += normalized.models.length;
        }
        if (modelCount === 0) {
          throw new Error(`Runtime media capability source for "${providerId}" returned no models`);
        }
        const next = {
          status: "ready",
          media,
          ...(snapshot.version !== undefined ? { version: cloneData(snapshot.version) } : {}),
          ...(snapshot.fingerprint !== undefined ? { fingerprint: cloneData(snapshot.fingerprint) } : {}),
          updatedAt: new Date().toISOString(),
        };
        this._runtimeMediaCapabilities.set(providerId, next);
        return publicRuntimeCapabilityState(next);
      } catch (error) {
        if (this._runtimeMediaCapabilitySources.get(providerId) !== source) return null;
        const next = {
          ...(previous || {}),
          status: previous?.media ? "stale" : "error",
          error: normalizeRuntimeCapabilityError(error),
          updatedAt: new Date().toISOString(),
        };
        this._runtimeMediaCapabilities.set(providerId, next);
        return publicRuntimeCapabilityState(next);
      }
    })();
    this._runtimeMediaRefreshes.set(providerId, refreshPromise);
    try {
      return await refreshPromise;
    } finally {
      if (this._runtimeMediaRefreshes.get(providerId) === refreshPromise) {
        this._runtimeMediaRefreshes.delete(providerId);
      }
    }
  }

  /**
   * 一次性迁移：将 agent config.models.overrides 的模型能力字段迁移到 Provider Catalog
   * @param {string} agentsDir - agents 目录
   * @param {Function} [log] - 日志函数
   */
  migrateOverridesToAddedModels(agentsDir, log: (...args: any[]) => void = () => {}) {
    // 能力字段白名单：image 是新标准名；vision 是旧名，读到时转写为 image
    const CAPABILITY_KEYS = ["context", "maxOutput", "image", "video", "reasoning"];
    // Migration code must distinguish an unreadable catalog from an empty
    // one. Runtime reads may degrade to an empty view, but cleanup must not.
    const userConfig = normalizeProviderUserConfigMap(this._catalog.load().providers);
    let changed = false;
    const pendingConfigWrites = [];
    const sourceErrors: string[] = [];

    // 扫描所有 agent 的 config.yaml
    let agentDirs;
    try { agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true }).filter(d => d.isDirectory()); }
    catch (err) {
      if (err?.code === "ENOENT") return;
      throw err;
    }

    for (const dir of agentDirs) {
      const cfgPath = path.join(agentsDir, dir.name, "config.yaml");
      let cfg;
      try {
        cfg = YAML.load(fs.readFileSync(cfgPath, "utf-8"));
        if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
          throw new Error("config root must be an object");
        }
      } catch (err) {
        if (err?.code !== "ENOENT") sourceErrors.push(`${dir.name}/config.yaml: ${err.message}`);
        continue;
      }
      if (!cfg?.models?.overrides) continue;

      const overrides = cfg.models.overrides;
      let cfgChanged = false;

      for (const [modelId, ov] of Object.entries(overrides) as [string, any][]) {
        if (!ov || typeof ov !== "object") continue;
        const meta: any = {};
        for (const key of CAPABILITY_KEYS) {
          const value = key === "image" && ov.image === undefined ? ov.vision : ov[key];
          if (value !== undefined) meta[key] = value;
        }
        if (Object.keys(meta).length === 0) continue;

        // Only clean the source after finding a durable destination. Unknown
        // model overrides remain valid user intent and must stay untouched.
        let target = null;
        for (const [provName, prov] of Object.entries(userConfig) as [string, any][]) {
          if (!prov.models || !Array.isArray(prov.models)) continue;
          const idx = prov.models.findIndex(m => (typeof m === "object" ? m.id : m) === modelId);
          if (idx === -1) continue;
          target = { provName, prov, idx };
          break;
        }
        if (!target) {
          log(`[migrate] override ${modelId}: no provider model destination; source preserved`);
          continue;
        }

        const existing = typeof target.prov.models[target.idx] === "object"
          ? target.prov.models[target.idx]
          : { id: modelId };
        target.prov.models[target.idx] = { ...existing, ...meta };
        changed = true;
        delete ov.vision;
        for (const key of CAPABILITY_KEYS) delete ov[key];
        cfgChanged = true;
        log(`[migrate] override ${modelId}: ${Object.keys(meta).join(",")} → Provider Catalog`);
      }

      // 清理空的 override 条目，保存 config.yaml
      if (cfgChanged) {
        for (const [modelId, ov] of Object.entries(overrides)) {
          if (ov && typeof ov === "object" && Object.keys(ov).length === 0) {
            delete overrides[modelId];
          }
        }
        if (Object.keys(overrides).length === 0) {
          delete cfg.models.overrides;
        }
        pendingConfigWrites.push({ cfgPath, cfg });
      }
    }

    if (changed) {
      // Copy to the destination before cleaning any agent source. A failed
      // catalog write therefore leaves every override available for retry.
      this._saveAddedModels(userConfig);
      const header = "# LucCode 助手配置\n# 由设置页面管理，手动编辑也可以\n\n";
      for (const { cfgPath, cfg } of pendingConfigWrites) {
        const yamlStr = header + YAML.dump(cfg, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: '"', forceQuotes: false });
        writeSecretFileSync(cfgPath, yamlStr);
      }
      log("[migrate] model overrides migrated to Provider Catalog");
    }
    if (sourceErrors.length > 0) {
      throw new Error(`Unreadable agent config prevents override migration completion: ${sourceErrors.join("; ")}`);
    }
  }

  /** 从 Provider Catalog v2 读取用户 provider 配置（mtime 缓存，文件未变时跳过磁盘读取） */
  _loadAddedModels() {
    try {
      const catalog = this._catalog.load();
      const mtime = fs.statSync(this._catalog.catalogPath).mtimeMs;
      if (this._addedModelsCache && mtime === this._addedModelsMtime) {
        return cloneData(this._addedModelsCache);
      }
      this._addedModelsCache = normalizeProviderUserConfigMap(catalog.providers);
      this._addedModelsMtime = mtime;
      return cloneData(this._addedModelsCache);
    } catch {
      return {};
    }
  }

  /** 将 providers 对象写入 Provider Catalog v2 */
  _saveAddedModels(providers, meta: any = {}) {
    this._catalog.saveProviders(stripProviderRuntimeMetaMap(providers), meta);
    // 写入后失效缓存，下次 _loadAddedModels 会重读
    this._addedModelsCache = null;
    this._addedModelsMtime = 0;
  }

  /**
   * 从 Provider Catalog 加载用户配置，与所有插件声明合并
   * 每次 Provider Catalog 变更后调用
   */
  reload() {
    this._entries.clear();
    this._reloadLocalProviderPlugins();
    const userConfig = this._migrateCatalogOnlyProvidersToLocalPlugins(this._loadAddedModels());

    // 1. 先处理所有已注册插件（内置 + 外部注册的）
    for (const [id, plugin] of this._plugins) {
      const uc = userConfig[id] || {};
      this._entries.set(id, this._merge(plugin, uc, this._isBuiltinPlugin(id, plugin)));
    }

    // 2. 处理 Provider Catalog 中有但没有对应插件的条目（用户自定义 provider）
    for (const [id, uc] of Object.entries(userConfig) as [string, any][]) {
      if (this._entries.has(id)) continue;
      // 没有插件声明，从配置推断
      const syntheticPlugin = {
        id,
        displayName: uc.display_name || id,
        authType: normalizeProviderAuthType(uc.auth_type),
        defaultBaseUrl: uc.base_url || "",
        defaultApi: uc.api || "openai-completions",
        runtime: uc.runtime,
        capabilities: uc.capabilities,
        source: { kind: "user" },
      };
      this._entries.set(id, this._merge(syntheticPlugin, uc, false));
    }
  }

  /**
   * 合并插件声明和用户配置
   * @private
   */
  _merge(plugin, userConfig, isBuiltin) {
    const runtime = plugin.runtime ? validateProviderRuntime(plugin.runtime) : null;
    const entry: any = {
      id: plugin.id,
      displayName: userConfig.display_name || plugin.displayName,
      authType: normalizeProviderAuthType(userConfig.auth_type || plugin.authType),
      baseUrl: userConfig.base_url || plugin.defaultBaseUrl,
      api: userConfig.api || plugin.defaultApi,
      headers: normalizeProviderHeaders(userConfig.headers || plugin.headers),
      authJsonKey: plugin.authJsonKey || plugin.id,
      isBuiltin,
      source: normalizeProviderSource(plugin, isBuiltin),
      ...(runtime ? { runtime } : {}),
    };
    assertAllowedOAuthHttpBaseUrl(entry.id, entry.baseUrl, runtime);
    entry.capabilities = normalizeCapabilities(plugin, entry);
    return entry;
  }

  /**
   * Return dynamic SDK provider registrations after catalog overrides have
   * been merged. OAuth functions remain in the plugin declaration; credentials
   * stay exclusively in AuthStorage.
   */
  getSdkProviderRegistrations() {
    if (this._entries.size === 0) this.reload();
    const registrations = [];
    const owners = new Map();
    for (const [sourceProviderId, plugin] of this._plugins) {
      if (!plugin?.sdkProvider) continue;
      const entry = this._entries.get(sourceProviderId);
      if (!entry) continue;
      const providerId = plugin.sdkProvider.providerId;
      if (typeof providerId !== "string" || !providerId.trim()) {
        throw new Error(`SDK provider registration for "${sourceProviderId}" requires providerId`);
      }
      const runtimeProviderId = entry.capabilities?.chat?.runtimeProviderId || entry.id;
      if (providerId !== runtimeProviderId) {
        throw new Error(
          `SDK provider registration for "${sourceProviderId}" targets "${providerId}" ` +
          `but chat runtime targets "${runtimeProviderId}"`,
        );
      }
      const previousOwner = owners.get(providerId);
      if (previousOwner && previousOwner !== sourceProviderId) {
        throw new Error(
          `SDK provider registration collision: "${previousOwner}" and "${sourceProviderId}" ` +
          `both register "${providerId}"`,
        );
      }
      owners.set(providerId, sourceProviderId);
      const pluginConfig = plugin.sdkProvider.config || {};
      const mergedHeaders = normalizeProviderHeaders({
        ...(pluginConfig.headers || {}),
        ...(entry.headers || {}),
      });
      registrations.push({
        sourceProviderId,
        providerId,
        config: {
          ...pluginConfig,
          name: entry.displayName,
          baseUrl: entry.baseUrl,
          api: entry.api,
          ...(Object.keys(mergedHeaders).length > 0 ? { headers: mergedHeaders } : {}),
        },
      });
    }
    return registrations;
  }

  /**
   * 获取所有 provider entry（已合并）
   * @returns {Map<string, ProviderEntry>}
   */
  getAll() {
    if (this._entries.size === 0) this.reload();
    return this._entries;
  }

  /**
   * 获取单个 provider entry
   * @param {string} providerId
   * @returns {ProviderEntry|null}
   */
  get(providerId) {
    if (this._entries.size === 0) this.reload();
    const direct = this._entries.get(providerId);
    if (direct?.isBuiltin) return direct;
    // 反向查找：providerId 可能是某个 OAuth provider 的 authJsonKey
    // 如 "openai-codex" → "openai-codex-oauth"
    for (const entry of this._entries.values()) {
      if (entry.authJsonKey === providerId && entry.id !== providerId) return entry;
    }
    if (direct) return direct;
    return null;
  }

  getProviderCapabilities(providerId) {
    return this.get(providerId)?.capabilities || null;
  }

  getCapabilityRegistry() {
    return cloneData(this._catalog.load().capabilities || {});
  }

  getCapabilityProviders(capability) {
    if (typeof capability !== "string" || !capability.trim()) return [];
    const config = this.getCapabilityRegistry()[capability.trim()];
    return Array.isArray(config?.providers) ? cloneData(config.providers) : [];
  }

  resolveChatProvider(providerId) {
    const entry = this.get(providerId);
    if (!entry) return null;
    const chat = entry.capabilities?.chat || defaultChatCapability(entry.id, entry.authType);
    return {
      originalProviderId: providerId,
      sourceProviderId: entry.id,
      providerId: chat.runtimeProviderId || entry.id,
      displayProviderId: chat.displayProviderId || chat.runtimeProviderId || entry.id,
      projection: chat.projection || "models-json",
      credentialSource: chat.credentialSource || defaultCredentialSource(entry.authType),
      allowListSource: chat.allowListSource || "provider.models",
      entry,
    };
  }

  getChatProjection(providerId) {
    return this.resolveChatProvider(providerId)?.projection || "models-json";
  }

  getChatModelSelection(providerId) {
    const resolved = this.resolveChatProvider(providerId);
    if (!resolved) return null;
    const canonicalProviderId = resolved.sourceProviderId;
    const raw = this.getAllProvidersRaw();
    const explicitConfig = Object.prototype.hasOwnProperty.call(raw, canonicalProviderId)
      ? raw[canonicalProviderId]
      : raw[providerId];
    const configError = isPlainObject(explicitConfig) && typeof explicitConfig._config_error === "string"
      ? explicitConfig._config_error
      : null;
    const hasExplicitModels = isPlainObject(explicitConfig)
      && Object.prototype.hasOwnProperty.call(explicitConfig, "models");
    const selectedModels = configError
      ? []
      : hasExplicitModels
      ? explicitConfig.models
      : this.getDefaultModelEntries(canonicalProviderId);
    const models = Array.isArray(selectedModels)
      ? cloneData(selectedModels).filter((model) => getModelType(canonicalProviderId, model) === "chat")
      : [];
    return {
      sourceProviderId: canonicalProviderId,
      explicitConfig: cloneData(explicitConfig || {}),
      configError,
      hasExplicitModels,
      selectionMode: configError
        ? "invalid"
        : (!hasExplicitModels ? "default" : (models.length === 0 ? "disabled" : "allowlist")),
      models,
    };
  }

  getChatModelEntries(providerId) {
    return this.getChatModelSelection(providerId)?.models || [];
  }

  /**
   * 设置页“发现模型”使用的可重新选择目录。它与运行时 allowlist 分离：
   * 即使用户明确写了 models: []，仍返回 provider 默认模型；用户显式模型
   * 与默认同 ID 时，用户对象元数据覆盖默认条目。
   */
  getChatDiscoverableModelEntries(providerId) {
    const resolved = this.resolveChatProvider(providerId);
    if (!resolved) return [];
    const sourceProviderId = resolved.sourceProviderId;
    const selection = this.getChatModelSelection(sourceProviderId);
    const explicitModels = selection?.hasExplicitModels
      ? selection.explicitConfig?.models
      : [];
    return mergeProviderModelEntries(
      this.getDefaultModelEntries(sourceProviderId),
      explicitModels,
    ).filter((model) => getModelType(sourceProviderId, model) === "chat");
  }

  getChatModelIds(providerId) {
    return this.getChatModelEntries(providerId)
      .filter((model) => getModelType(providerId, model) === "chat")
      .map(getModelId)
      .filter(Boolean);
  }

  /**
   * 返回 chat provider 的生效配置。models 的三态语义在这里集中解析：
   * 缺少字段 → Luc/plugin 默认；[] → 明确关闭；非空 → 用户 allowlist。
   */
  getEffectiveChatProviderConfig(providerId) {
    const resolved = this.resolveChatProvider(providerId);
    if (!resolved) return null;
    const selection = this.getChatModelSelection(providerId);
    const explicitConfig = selection?.explicitConfig || {};
    const entry = resolved.entry;
    return {
      ...cloneData(explicitConfig || {}),
      base_url: explicitConfig?.base_url || entry.baseUrl || "",
      api: explicitConfig?.api || entry.api || "openai-completions",
      headers: explicitConfig?.headers || entry.headers || {},
      auth_type: explicitConfig?.auth_type || entry.authType || "api-key",
      models: selection?.models || [],
    };
  }

  /**
   * 将 Luc provider 身份解析为唯一的运行时投影计划。
   * 多个配置源指向同一 runtime provider 时显式报错，禁止静默覆盖。
   */
  getChatProjectionPlans() {
    if (this._entries.size === 0) this.reload();
    const raw = this.getAllProvidersRaw();
    const candidates = new Set(Object.keys(raw));
    for (const [providerId, plugin] of this._plugins) {
      if (Array.isArray(plugin?.models) || plugin?.capabilities?.chat?.projection === "sdk-auth-alias") {
        candidates.add(providerId);
      }
    }

    const sourceOwners = new Map();
    for (const candidate of candidates) {
      const resolved = this.resolveChatProvider(candidate);
      if (!resolved) continue;
      const owner = resolved.sourceProviderId;
      const previous = sourceOwners.get(owner);
      if (previous && previous !== candidate) {
        throw new Error(`Chat provider config collision: "${previous}" and "${candidate}" both resolve to "${owner}"`);
      }
      sourceOwners.set(owner, candidate);
    }

    const plans = [];
    const runtimeOwners = new Map();
    for (const [sourceProviderId, configuredAs] of sourceOwners) {
      const resolved = this.resolveChatProvider(sourceProviderId);
      if (!resolved) continue;
      const runtimeProviderId = resolved.providerId;
      const previous = runtimeOwners.get(runtimeProviderId);
      if (previous && previous !== sourceProviderId) {
        throw new Error(`Chat runtime provider collision: "${previous}" and "${sourceProviderId}" both project to "${runtimeProviderId}"`);
      }
      runtimeOwners.set(runtimeProviderId, sourceProviderId);
      const selection = this.getChatModelSelection(configuredAs);
      const modelExecutionHeaders = {};
      for (const model of selection?.models || []) {
        const modelId = getModelId(model);
        if (!modelId) continue;
        const headers = this.getChatModelExecutionHeaders(sourceProviderId, modelId);
        if (Object.keys(headers).length > 0) modelExecutionHeaders[modelId] = headers;
      }
      plans.push({
        sourceProviderId,
        configuredAs,
        runtimeProviderId,
        displayProviderId: resolved.displayProviderId,
        projection: resolved.projection,
        credentialSource: resolved.credentialSource,
        allowListSource: resolved.allowListSource,
        hasExplicitModels: selection?.hasExplicitModels === true,
        selectionMode: selection?.selectionMode === "invalid"
          ? "invalid"
          : resolved.projection === "sdk-auth-alias" && selection?.hasExplicitModels !== true
          ? "runtime-catalog"
          : (selection?.selectionMode || "disabled"),
        modelExecutionHeaders,
        config: this.getEffectiveChatProviderConfig(configuredAs),
      });
    }
    return plans;
  }

  getMediaModels(providerId, capability) {
    if (this._entries.size === 0) this.reload();
    const entry = this._entries.get(providerId) || this.get(providerId);
    if (!entry) return [];
    const key = capabilityKey(capability);
    const hasRuntimeSource = this._runtimeMediaCapabilitySources.has(providerId);
    const runtimeState = this._runtimeMediaCapabilities.get(providerId);
    const declared = hasRuntimeSource
      ? (runtimeState?.media?.[key]?.models || [])
      : (entry.capabilities?.media?.[key]?.models || []);
    const userConfig = this.getAllProvidersRaw()[providerId] || {};
    const userModels = normalizeUserMediaModels(providerId, userConfig, capability, declared, entry);
    const byId = new Map();
    for (const model of declared) byId.set(model.id, model);
    for (const model of userModels) {
      if (hasRuntimeSource && !byId.has(model.id)) continue;
      byId.set(model.id, { ...(byId.get(model.id) || {}), ...model });
    }
    return [...byId.values()];
  }

  getMediaCredentialLanes(providerId, capability = "image_generation") {
    if (this._entries.size === 0) this.reload();
    const entry = this._entries.get(providerId) || this.get(providerId);
    if (!entry) return [];
    const key = capabilityKey(capability);
    const mediaCapability = entry.capabilities?.media?.[key] || {};
    const lanes = Array.isArray(mediaCapability.credentialLanes)
      ? mediaCapability.credentialLanes
        .map((lane) => normalizeCredentialLane(lane, providerId))
        .filter(Boolean)
      : [];
    if (lanes.length > 0) return lanes;
    return [{
      id: providerId,
      providerId,
      label: entry.displayName || providerId,
    }];
  }

  getMediaProviderCredentialStatus(providerId, capability = "image_generation") {
    if (this._entries.size === 0) this.reload();
    const entry = this._entries.get(providerId) || this.get(providerId);
    if (!entry) {
      return {
        hasCredentials: false,
        unavailableReason: "provider_not_found",
        lanes: [],
      };
    }
    const lanes = this.getMediaCredentialLanes(providerId, capability);
    if (this._runtimeMediaCapabilitySources.has(providerId)) {
      const runtimeState = this._runtimeMediaCapabilities.get(providerId);
      if (runtimeState?.status !== "ready") {
        return {
          hasCredentials: false,
          unavailableReason: runtimeState?.error?.code || "runtime_capability_pending",
          unavailableMessage: runtimeState?.error?.message || "Runtime media capabilities have not been discovered yet",
          lanes,
        };
      }
    }
    for (const lane of lanes) {
      const laneProviderId = lane.providerId || providerId;
      const authType = normalizeProviderAuthType(lane.authType || this.getAuthType(laneProviderId) || entry.authType);
      if (authType === "none") {
        return {
          hasCredentials: true,
          unavailableReason: null,
          activeLaneId: lane.id,
          activeProviderId: laneProviderId,
          lanes,
        };
      }
      const creds = this.getCredentials(laneProviderId);
      const hasHeaders = !!creds?.headers && Object.keys(creds.headers).length > 0;
      if (creds?.apiKey || hasHeaders) {
        return {
          hasCredentials: true,
          unavailableReason: null,
          activeLaneId: lane.id,
          activeProviderId: laneProviderId,
          lanes,
        };
      }
    }
    return {
      hasCredentials: false,
      unavailableReason: "no_credentials",
      lanes,
    };
  }

  getMediaProviders(capability) {
    if (this._entries.size === 0) this.reload();
    const key = capabilityKey(capability);
    const providers = [];
    for (const entry of this._entries.values()) {
      const models = this.getMediaModels(entry.id, capability);
      const runtimeCapability = this.getRuntimeMediaCapabilityState(entry.id);
      const runtimeMedia = this._runtimeMediaCapabilities.get(entry.id)?.media;
      const exposesCapability = entry.capabilities?.media?.[key] !== undefined || runtimeMedia?.[key] !== undefined;
      if (models.length === 0 && (!runtimeCapability || !exposesCapability)) continue;
      providers.push({
        providerId: entry.id,
        displayName: entry.displayName,
        authType: entry.authType,
        source: entry.source,
        runtime: entry.runtime || null,
        credentialLanes: this.getMediaCredentialLanes(entry.id, capability),
        ...(runtimeCapability ? { runtimeCapability } : {}),
        models,
      });
    }
    return providers;
  }

  resolveMediaModel(ref) {
    const providerId = ref?.providerId || ref?.provider;
    const modelId = ref?.modelId || ref?.id || ref?.model;
    const capability = ref?.capability || "image_generation";
    if (!providerId) throw new Error("Media provider required");
    if (!modelId) throw new Error("Media model required");
    const entry = this._entries.get(providerId) || this.get(providerId);
    if (!entry) throw new Error(`Media provider "${providerId}" not found`);
    if (this._runtimeMediaCapabilitySources.has(providerId)) {
      const runtimeState = this._runtimeMediaCapabilities.get(providerId);
      if (runtimeState?.status !== "ready") {
        throw new Error(
          runtimeState?.error?.message || `Runtime media capabilities for "${providerId}" are not ready`,
        );
      }
    }
    const models = this.getMediaModels(providerId, capability);
    const model = models.find((item) => item.id === modelId || item.aliases?.includes?.(modelId));
    if (!model) throw new Error(`Media model "${providerId}/${modelId}" not found`);
    const key = capabilityKey(capability);
    const mediaCapability = entry.capabilities?.media?.[key] || {};
    const credentialLaneId = ref?.credentialLaneId || model.credentialLaneId;
    const credentialLane = credentialLaneId
      ? (mediaCapability.credentialLanes || []).find((lane) => lane.id === credentialLaneId)
      : null;
    if (credentialLaneId && !credentialLane) {
      throw new Error(`Credential lane "${credentialLaneId}" not found for provider "${providerId}"`);
    }
    return {
      capability,
      providerId,
      provider: entry,
      model,
      credentialLane: credentialLane || null,
      runtime: entry.runtime || null,
    };
  }

  /**
   * 批量获取 provider entry
   * @param {string[]} providerIds
   * @returns {Map<string, ProviderEntry>}
   */
  getBatch(providerIds) {
    const result = new Map();
    for (const id of providerIds) {
      const entry = this.get(id);
      if (entry) result.set(id, entry);
    }
    return result;
  }

  /**
   * 列出所有 authType 为 "oauth" 的 provider id
   * @returns {string[]}
   */
  getOAuthProviderIds() {
    const all = this.getAll();
    return [...all.values()]
      .filter(e => e.authType === "oauth")
      .map(e => e.id);
  }

  /**
   * 获取 OAuth provider 在 auth.json 中的实际 key
   * （部分 provider 的 authJsonKey 与 id 不同，如 openai-codex-oauth → openai-codex）
   * @param {string} providerId
   * @returns {string}
   */
  getAuthJsonKey(providerId) {
    return this.get(providerId)?.authJsonKey || providerId;
  }

  /**
   * 获取某 provider 的默认模型 ID 列表（公开兼容契约）。
   * @param {string} providerId
   * @returns {string[]}
   */
  getDefaultModels(providerId) {
    return this.getDefaultModelEntries(providerId).map(getModelId).filter(Boolean);
  }

  /**
   * Resolve provider-owned, non-credential request metadata for one chat model.
   * Function contributions are process-local plugin behavior; object maps also
   * support serializable provider declarations.
   */
  getChatModelExecutionHeaders(providerId, modelId) {
    const resolved = this.resolveChatProvider(providerId);
    if (!resolved || typeof modelId !== "string" || !modelId.trim()) return {};
    const plugin = this._plugins.get(resolved.sourceProviderId);
    const contribution = plugin?.modelExecutionHeaders;
    const headers = typeof contribution === "function"
      ? contribution(modelId.trim())
      : contribution?.[modelId.trim()];
    return stripCredentialHeaders(headers);
  }

  /**
   * 获取某 provider 的完整默认模型声明。Catalog 投影必须走这里，避免
   * 将 ProviderPlugin 内的协议与能力元数据压缩成裸 ID。
   * @param {string} providerId
   * @returns {Array<string|object>}
   */
  getDefaultModelEntries(providerId) {
    if (_defaultModels[providerId]) return cloneData(_defaultModels[providerId]);
    const plugin = this._plugins.get(providerId);
    if (Array.isArray(plugin?.models)) {
      return cloneData(plugin.models).filter((model) => getModelId(model));
    }
    return [];
  }

  /**
   * 更新 provider 的用户配置（写 Provider Catalog）
   * 只更新非凭证字段（base_url / api / display_name / auth_type）
   * @param {string} providerId
   * @param {{ base_url?: string, api?: string, display_name?: string, auth_type?: string }} overrides
   */
  setUserConfig(providerId, overrides) {
    this.saveProvider(providerId, overrides);
  }

  /**
   * 删除一个 provider（仅从 Provider Catalog 用户配置删除，内置插件声明保留）
   * @param {string} providerId
   */
  remove(providerId) {
    const userConfig = this._loadAddedModels();
    const plugin = this._plugins.get(providerId);
    const hasCatalogEntry = Object.prototype.hasOwnProperty.call(userConfig, providerId);
    const hasLocalPlugin = isLocalProviderPlugin(plugin);
    if (!hasCatalogEntry && !hasLocalPlugin) return;
    if (hasCatalogEntry) delete userConfig[providerId];
    if (hasLocalPlugin) {
      this._localProviderPlugins.removeProvider(providerId);
      this._plugins.delete(providerId);
    }
    const deletedProviders = this._catalog.getDeletedProviders();
    if (!deletedProviders.includes(providerId)) deletedProviders.push(providerId);
    this._saveAddedModels(userConfig, { deletedProviders });
    this._entries.delete(providerId);
    // 如果有内置插件声明，以默认值重建 entry
    if (this._plugins.has(providerId)) {
      const remainingPlugin = this._plugins.get(providerId);
      this._entries.set(providerId, this._merge(remainingPlugin, {}, this._isBuiltinPlugin(providerId, remainingPlugin)));
    }
  }

  /**
   * 检查某个 id 是否是已知的 OAuth provider
   * @param {string} providerId
   */
  isOAuth(providerId) {
    return this.get(providerId)?.authType === "oauth";
  }

  /**
   * 获取 provider 的标准化认证类型。
   * 旧 YAML 没有 auth_type 时，从内置/插件声明推导；未知 provider 默认 api-key。
   * @param {string} providerId
   * @returns {"api-key"|"oauth"|"none"|"optional"}
   */
  getAuthType(providerId) {
    return normalizeProviderAuthType(this.get(providerId)?.authType);
  }

  /**
   * 判断 provider 是否允许缺省 API key。
   * provider 契约优先，loopback 放行只作为旧本地配置兼容。
   * @param {string} providerId
   * @param {string} [baseUrl]
   */
  allowsMissingApiKey(providerId, baseUrl = "") {
    return providerCredentialAllowsMissingApiKey({
      authType: this.getAuthType(providerId),
      baseUrl,
    });
  }

  // ── credential read + model CRUD ──────────────────────────────────────────

  /**
   * 读取 provider 的凭证信息（apiKey, baseUrl, api）
   * 从 Provider Catalog 读取用户配置值，baseUrl/api 不存在时回退到插件默认值。
   * OAuth provider 若 YAML 无 api_key，自动从 auth.json 补全 access token；
   * 若 auth.json 含 resourceUrl 且 YAML 未配 base_url，用 resourceUrl 作为 baseUrl。
   * @param {string} providerId
   * @returns {{ apiKey: string, baseUrl: string, api: string, headers?: Record<string, string>, accountId?: string } | null}
   */
  getCredentials(providerId) {
    const userConfig = this._loadAddedModels();
    const entry = this.get(providerId);
    const candidateIds = [];
    const addCandidate = (id) => {
      if (id && !candidateIds.includes(id)) candidateIds.push(id);
    };
    addCandidate(providerId);
    addCandidate(entry?.id);
    addCandidate(entry?.authJsonKey);

    const configId = candidateIds.find(id => Object.prototype.hasOwnProperty.call(userConfig, id));
    const uc = configId ? userConfig[configId] : null;
    const plugin = this._plugins.get(entry?.id || providerId);
    const authType = normalizeProviderAuthType(uc?.auth_type || entry?.authType || plugin?.authType);
    if (!uc && authType !== "oauth") return null;

    let apiKey = uc?.api_key || "";
    let oauthBaseUrl = "";
    let oauthAccountId = "";

    // OAuth provider: YAML 没有 api_key，从 auth.json 取 access token + resourceUrl
    if (!apiKey) {
      if (authType === "oauth") {
        const authJsonKey = entry?.authJsonKey || plugin?.authJsonKey || providerId;
        const oauth = this._readOAuthEntry(authJsonKey);
        apiKey = oauth.token;
        oauthBaseUrl = oauth.resourceUrl;
        oauthAccountId = oauth.accountId;
      }
    }

    const headers = normalizeProviderHeaders(uc?.headers || entry?.headers || plugin?.headers);
    return {
      apiKey,
      baseUrl: uc?.base_url || oauthBaseUrl || entry?.baseUrl || plugin?.defaultBaseUrl || "",
      api: uc?.api || entry?.api || plugin?.defaultApi || "",
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(oauthAccountId ? { accountId: oauthAccountId } : {}),
    };
  }

  /**
   * 从 auth.json 读取 OAuth 条目（token + resourceUrl）
   * @private
   * @param {string} authJsonKey - auth.json 中的 key
   * @returns {{ token: string, resourceUrl: string, accountId: string }}
   */
  _readOAuthEntry(authJsonKey) {
    try {
      const authPath = path.join(this._lucHome, "auth.json");
      // mtime 缓存：auth.json 只在 OAuth 回调写入时变化
      const mtime = fs.statSync(authPath).mtimeMs;
      if (!this._authJsonCache || mtime !== this._authJsonMtime) {
        this._authJsonCache = JSON.parse(fs.readFileSync(authPath, "utf-8"));
        this._authJsonMtime = mtime;
      }
      const entry = this._authJsonCache?.[authJsonKey];
      if (!entry) return { token: "", resourceUrl: "", accountId: "" };
      if (typeof entry === "string") return { token: entry, resourceUrl: "", accountId: "" };
      let token = "";
      if (typeof entry.access === "string") token = entry.access;
      else if (typeof entry.apiKey === "string") token = entry.apiKey;
      else if (typeof entry.token === "string") token = entry.token;
      return {
        token,
        resourceUrl: entry.resourceUrl || "",
        accountId: entry.accountId || "",
      };
    } catch {
      return { token: "", resourceUrl: "", accountId: "" };
    }
  }

  clearAuthCache() {
    this._authJsonCache = null;
    this._authJsonMtime = 0;
  }

  /**
   * 读取某 provider 在 Provider Catalog 中的模型 ID 列表
   * 模型条目可以是字符串或 {id, name?, context?, maxOutput?} 对象，统一提取 id
   * @param {string} providerId
   * @returns {string[]}
   */
  getProviderModels(providerId) {
    const uc = this.getAllProvidersRaw()[providerId];
    if (!uc?.models || !Array.isArray(uc.models)) return [];
    return uc.models.map((m) => (typeof m === "object" ? m.id : m));
  }

  /**
   * 返回运行时 provider 数据。
   * Built-in/plugin provider 只返回用户 catalog overlay；本地 Provider Plugin 会把
   * 插件声明合并进去，让模型同步和设置页仍能看到用户自定义 provider 的完整定义。
   * @returns {Record<string, any>}
   */
  getAllProvidersRaw() {
    const userConfig = this._loadAddedModels();
    const raw = cloneData(userConfig);
    for (const [providerId, plugin] of this._plugins) {
      if (!isLocalProviderPlugin(plugin)) continue;
      raw[providerId] = this._mergeRawProviderConfig(providerId, raw[providerId] || {});
    }
    return raw;
  }

  _providerConfigIdForModelDefaults(providerId) {
    const entry = this.get(providerId);
    return entry?.id || providerId;
  }

  _providerConfigForModelMutation(providerId) {
    const ownerProviderId = this.resolveChatProvider(providerId)?.sourceProviderId || providerId;
    const rawProvider = this.getAllProvidersRaw()[ownerProviderId] || {};
    const models = Object.prototype.hasOwnProperty.call(rawProvider, "models")
      ? rawProvider.models
      : this.getChatModelEntries(ownerProviderId);
    return {
      ownerProviderId,
      rawProvider,
      models: Array.isArray(models) ? models : [],
    };
  }

  getModelDefaultThinkingLevel(providerId, modelId) {
    if (!providerId || !modelId) return null;
    const userConfig = this._loadAddedModels();
    const entry = this.get(providerId);
    const providerIds = [
      providerId,
      entry?.id,
      entry?.authJsonKey,
    ].filter(Boolean);
    for (const id of [...new Set(providerIds)]) {
      const level = userConfig[id]?.model_defaults?.[modelId]?.thinking_level;
      if (typeof level === "string" && THINKING_LEVEL_VALUES.has(level)) return level;
    }
    return null;
  }

  setModelDefaultThinkingLevel(providerId, modelId, level) {
    if (!providerId || !modelId) {
      throw new Error("setModelDefaultThinkingLevel: providerId and modelId required");
    }
    if (typeof level !== "string" || !THINKING_LEVEL_VALUES.has(level)) {
      throw new Error(`invalid thinking level: ${level}`);
    }
    const userConfig = this._loadAddedModels();
    const ownerProviderId = this._providerConfigIdForModelDefaults(providerId);
    if (!userConfig[ownerProviderId]) userConfig[ownerProviderId] = {};
    const defaults = isPlainObject(userConfig[ownerProviderId].model_defaults)
      ? userConfig[ownerProviderId].model_defaults
      : {};
    const existing = isPlainObject(defaults[modelId]) ? defaults[modelId] : {};
    defaults[modelId] = { ...existing, thinking_level: level };
    userConfig[ownerProviderId].model_defaults = normalizeModelDefaults(defaults);
    this._saveAddedModels(userConfig);
    this._entries.clear();
    return { provider: ownerProviderId, modelId, thinkingLevel: level };
  }

  /**
   * 向某 provider 的 models 列表添加一个模型，立即持久化
   * 不会添加重复项（按 id 判断）
   * @param {string} providerId
   * @param {string | { id: string, name?: string, context?: number, maxOutput?: number }} model
   */
  addModel(providerId, model) {
    const { ownerProviderId, rawProvider, models } = this._providerConfigForModelMutation(providerId);

    const newId = typeof model === "object" ? model.id : model;
    const exists = models.some(
      (m) => (typeof m === "object" ? m.id : m) === newId,
    );
    if (exists) return;

    const nextModels = [...models, model];
    validateProviderModels(ownerProviderId, nextModels, { baseUrl: rawProvider.base_url });
    this.saveProvider(ownerProviderId, { models: nextModels });
  }

  /**
   * 从某 provider 的 models 列表移除一个模型（按 id 匹配），立即持久化
   * @param {string} providerId
   * @param {string} modelId
   */
  removeModel(providerId, modelId) {
    const { ownerProviderId, models: currentModels } = this._providerConfigForModelMutation(providerId);
    const models = currentModels.filter(
      (m) => (typeof m === "object" ? m.id : m) !== modelId,
    );
    this.saveProvider(ownerProviderId, { models });
  }

  /**
   * 更新某 provider 的模型条目（按 id 查找并替换），立即持久化
   * 裸字符串条目会被升级为对象
   * @param {string} providerId
   * @param {string} modelId
   * @param {{ name?: string, api?: string, context?: number, contextWindow?: number, maxOutput?: number, maxTokens?: number, maxOutputTokens?: number, image?: boolean, video?: boolean, audio?: boolean, reasoning?: boolean, xhigh?: boolean, thinkingLevels?: string[], thinkingLevelMap?: object, defaultThinkingLevel?: string, compat?: object, toolUse?: object, visionCapabilities?: object }} meta
   */
  updateModelEntry(providerId, modelId, meta) {
    const { ownerProviderId, rawProvider, models } = this._providerConfigForModelMutation(providerId);

    // 兼容前端仍可能发来 vision 字段（过渡期）：转写为 image
    if (meta && typeof meta === "object" && meta.vision !== undefined && meta.image === undefined) {
      meta = { ...meta, image: meta.vision };
    }
    if (meta && typeof meta === "object" && meta.contextWindow !== undefined && meta.context === undefined) {
      meta = { ...meta, context: meta.contextWindow };
    }
    if (meta && typeof meta === "object" && meta.maxTokens !== undefined && meta.maxOutput === undefined) {
      meta = { ...meta, maxOutput: meta.maxTokens };
    }
    if (meta && typeof meta === "object" && meta.maxOutputTokens !== undefined && meta.maxOutput === undefined) {
      meta = { ...meta, maxOutput: meta.maxOutputTokens };
    }

    // 白名单：只允许模型能力字段（image 是标准名，vision 为旧名不写入）
    const ALLOWED = ["name", "api", "context", "maxOutput", "image", "video", "audio", "reasoning", "xhigh", "thinkingLevels", "thinkingLevelMap", "type", "defaultThinkingLevel"];
    const safe: any = {};
    for (const key of ALLOWED) {
      if (meta[key] !== undefined) safe[key] = meta[key];
    }
    const compat = normalizeModelProtocolCompat(meta?.compat);
    if (compat) safe.compat = compat;
    const toolUse = normalizeToolUseContract(meta?.toolUse);
    if (meta?.toolUse !== undefined && !toolUse) {
      throw new Error(`invalid toolUse contract for model "${modelId}"`);
    }
    if (toolUse) safe.toolUse = toolUse;
    const visionCapabilities = normalizeVisionCapabilities(meta?.visionCapabilities);
    if (visionCapabilities) safe.visionCapabilities = visionCapabilities;

    let found = false;
    const nextModels = models.map((m) => {
      const mid = typeof m === "object" ? m.id : m;
      if (mid !== modelId) return m;
      found = true;
      const base = typeof m === "object" ? m : { id: mid };
      // 删除旧字段 vision，避免残留
      if (base.vision !== undefined) {
        const { vision: _vision, ...cleaned } = base;
        return mergeModelMetadata(cleaned, safe);
      }
      return mergeModelMetadata(base, safe);
    });

    // upsert：模型不在列表中时自动添加
    if (!found) {
      nextModels.push({ id: modelId, ...safe });
    }

    validateProviderModels(ownerProviderId, nextModels, { baseUrl: rawProvider.base_url });
    this.saveProvider(ownerProviderId, { models: nextModels });
  }

  _ensureMediaConfig(userConfig, providerId, capability) {
    if (!userConfig[providerId]) userConfig[providerId] = {};
    const provider = userConfig[providerId];
    if (!isPlainObject(provider.media)) provider.media = {};
    const mediaKey = mediaUserConfigKey(capability);
    if (!isPlainObject(provider.media[mediaKey])) provider.media[mediaKey] = {};
    if (!Array.isArray(provider.media[mediaKey].models)) provider.media[mediaKey].models = [];
    return provider.media[mediaKey];
  }

  _mediaModelFallback(providerId, capability, modelId) {
    const entry = this.get(providerId);
    const key = capabilityKey(capability);
    const declared = entry?.capabilities?.media?.[key]?.models || [];
    return declared.find((model) => model.id === modelId)
      || { protocolId: inferMediaProtocolId(providerId, capability, modelId, providerProtocolContext(entry)) || entry?.runtime?.protocolId };
  }

  _assertMediaModelCatalogMutable(providerId) {
    if (this._runtimeMediaCapabilitySources.has(providerId)) {
      throw new Error(`Runtime-discovered provider "${providerId}" does not allow manual model changes`);
    }
  }

  addMediaModel(providerId, capability, model) {
    this._assertMediaModelCatalogMutable(providerId);
    const userConfig = this._loadAddedModels();
    const modelId = getModelId(model);
    if (!modelId) throw new Error("media model id is required");
    const mediaConfig = this._ensureMediaConfig(userConfig, providerId, capability);
    const exists = mediaConfig.models.some((item) => getModelId(item) === modelId);
    if (exists) return;

    const fallback = this._mediaModelFallback(providerId, capability, modelId);
    const normalized = normalizeMediaModel(model, fallback);
    if (!normalized?.protocolId) {
      throw new Error(`Media model "${providerId}/${modelId}" missing protocolId`);
    }
    mediaConfig.models = [...mediaConfig.models, normalized];
    this._saveAddedModels(userConfig);
    this._entries.clear();
  }

  updateMediaModelEntry(providerId, capability, modelId, patch) {
    this._assertMediaModelCatalogMutable(providerId);
    if (!modelId) throw new Error("media model id is required");
    const userConfig = this._loadAddedModels();
    const mediaConfig = this._ensureMediaConfig(userConfig, providerId, capability);
    const fallback = this._mediaModelFallback(providerId, capability, modelId);
    const safePatch = omitUndefined(patch);
    let found = false;
    mediaConfig.models = mediaConfig.models.map((item) => {
      if (getModelId(item) !== modelId) return item;
      found = true;
      const base = typeof item === "object" && item !== null ? item : { id: modelId };
      const normalized = normalizeMediaModel({ ...base, ...safePatch, id: modelId }, fallback);
      if (!normalized?.protocolId) {
        throw new Error(`Media model "${providerId}/${modelId}" missing protocolId`);
      }
      return normalized;
    });
    if (!found) {
      const normalized = normalizeMediaModel({ id: modelId, ...safePatch }, fallback);
      if (!normalized?.protocolId) {
        throw new Error(`Media model "${providerId}/${modelId}" missing protocolId`);
      }
      mediaConfig.models.push(normalized);
    }
    this._saveAddedModels(userConfig);
    this._entries.clear();
  }

  removeMediaModel(providerId, capability, modelId) {
    this._assertMediaModelCatalogMutable(providerId);
    const userConfig = this._loadAddedModels();
    const provider = userConfig[providerId];
    const mediaKey = mediaUserConfigKey(capability);
    const mediaConfig = provider?.media?.[mediaKey];
    if (!Array.isArray(mediaConfig?.models)) return;
    mediaConfig.models = mediaConfig.models.filter((item) => getModelId(item) !== modelId);
    this._saveAddedModels(userConfig);
    this._entries.clear();
  }

  /**
   * 创建或更新一个 provider 条目（合并写入 Provider Catalog）
   * @param {string} providerId
   * @param {Record<string, any>} data - 要写入的字段（api_key, base_url, api, models 等）
   */
  saveProvider(providerId, data) {
    const userConfig = this._loadAddedModels();
    const { seed_default_models: seedDefaultModels, ...providerData } = data || {};
    if (Object.prototype.hasOwnProperty.call(providerData, "headers")) {
      providerData.headers = normalizeProviderHeaders(providerData.headers);
    }
    const nextProvider = { ...(userConfig[providerId] || {}), ...providerData };
    const existingPlugin = this._plugins.get(providerId);
    const persistAsLocalPlugin = isLocalProviderPlugin(existingPlugin) || !existingPlugin;

    if (seedDefaultModels && (!Array.isArray(nextProvider.models) || nextProvider.models.length === 0)) {
      const defaults = this.getDefaultModelEntries(providerId);
      if (defaults.length > 0) nextProvider.models = [...defaults];
    }

    if (persistAsLocalPlugin) {
      userConfig[providerId] = this._writeLocalProviderPlugin(providerId, nextProvider, existingPlugin);
    } else {
      const runtime = existingPlugin?.runtime
        ? validateProviderRuntime(existingPlugin.runtime)
        : null;
      assertAllowedOAuthHttpBaseUrl(
        providerId,
        nextProvider.base_url || existingPlugin?.defaultBaseUrl,
        runtime,
      );
      validateProviderModels(providerId, nextProvider.models, { baseUrl: nextProvider.base_url });
      userConfig[providerId] = nextProvider;
    }
    const deletedProviders = this._catalog.getDeletedProviders()
      .filter((id) => id !== providerId);
    this._saveAddedModels(userConfig, { deletedProviders });
    this._entries.clear();
  }

  /**
   * 删除一个 provider（remove 的显式别名）
   * @param {string} providerId
   */
  removeProvider(providerId) {
    this.remove(providerId);
  }

  /**
   * Get models of a specific type for a provider.
   * Type resolution: model entry type field → known-models.json type → default "chat"
   * @param {string} providerId
   * @param {string} type - "chat" | "image" | ...
   * @returns {{ id: string, name?: string, type: string }[]}
   */
  getModelsByType(providerId, type) {
    const raw = this.getAllProvidersRaw();
    const models = raw[providerId]?.models || [];
    const results = [];
    for (const m of models) {
      const isObj = typeof m === "object" && m !== null;
      const id = isObj ? m.id : m;
      if (!id) continue;
      const known = lookupKnown(providerId, id);
      const resolvedType = (isObj && m.type) || known?.type || "chat";
      if (resolvedType !== type) continue;
      results.push({ id, name: (isObj && m.name) || known?.name || id, type: resolvedType });
    }
    return results;
  }

  /**
   * Get all models of a specific type across all providers.
   * @param {string} type
   * @returns {{ provider: string, id: string, name?: string, type: string }[]}
   */
  getAllModelsByType(type) {
    const raw = this.getAllProvidersRaw();
    const results = [];
    for (const providerId of Object.keys(raw)) {
      for (const entry of this.getModelsByType(providerId, type)) {
        results.push({ ...entry, provider: providerId });
      }
    }
    return results;
  }
}
