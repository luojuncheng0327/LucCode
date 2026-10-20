/**
 * model-sync.js — Provider Catalog provider configs → models.json 单向投影
 *
 * 系统中唯一写 models.json 的地方。从 providers 配置（snake_case）
 * 投影为 Pi SDK 格式（camelCase），附加 known-models.json 元数据。
 */

import fs from "fs";
import { getPiModel } from "../lib/pi-sdk/index.ts";
import { lookupKnown, lookupKnownProvider } from "../shared/known-models.ts";
import { writeSecretFileSync } from "../shared/secret-fs.ts";
import {
  getEndpointDefaultReasoningCapability,
  normalizeModelProtocolCompat,
  normalizeToolUseContract,
  normalizeVisionCapabilities,
  withLucAudioInputCompat,
  withLucVideoInputCompat,
  withThinkingFormatCompat,
} from "../shared/model-capabilities.ts";
import { normalizeProviderHeaders, providerCredentialAllowsMissingApiKey } from "../shared/provider-auth.ts";
import { validateProviderModels } from "../shared/provider-model-validation.ts";
import { buildRuntimeApiKeyRef } from "../shared/runtime-api-key-ref.ts";
import { inferOllamaModelMetadata } from "../shared/ollama-model-metadata.ts";
import { normalizeProviderBaseUrlForApi } from "../lib/llm/provider-client.ts";
import { normalizeThinkingLevelForModel } from "./session-thinking-level.ts";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const PI_BUILTIN_METADATA_PROVIDERS = new Set(["kimi-coding", "opencode", "opencode-go"]);
const PI_BUILTIN_PROVIDER_REUSE = new Set(["kimi-coding", "opencode-go"]);
const KIMI_CODING_PROVIDER = "kimi-coding";
const KIMI_CODING_HEADER_MODEL_ID = "kimi-for-coding";
const CHAT_CREDENTIAL_SOURCES = new Set(["provider-catalog", "auth-storage", "none"]);

/**
 * 模型 ID → 人类可读名
 * "doubao-seed-2-0-pro-260215" → "Doubao Seed 2.0 Pro"
 */
function humanizeName(id) {
  let name = id.replace(/-(\d{6})$/, "");
  name = name.replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  name = name.replace(/(\d) (\d)/g, "$1.$2");
  return name;
}

function getModelId(modelEntry) {
  return typeof modelEntry === "object" && modelEntry !== null ? modelEntry.id : modelEntry;
}

function getProviderModelDefaultThinkingLevel(modelDefaults, modelId) {
  if (!modelDefaults || !modelId) return undefined;
  const entry = modelDefaults[modelId];
  const level = entry?.thinking_level ?? entry?.thinkingLevel;
  return typeof level === "string" ? level : undefined;
}

function resolveModelApi(modelEntry, provider, providerApi) {
  const explicitApi = typeof modelEntry === "object" && modelEntry !== null
    ? modelEntry.api
    : null;
  return explicitApi || lookupKnownProvider(provider, getModelId(modelEntry))?.api || providerApi;
}

const THINKING_LEVEL_MAP_KEYS = ["off", "minimal", "low", "medium", "high", "xhigh"];

function normalizeThinkingLevelMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result: Record<string, string | null> = {};
  for (const key of THINKING_LEVEL_MAP_KEYS) {
    const mapped = value[key];
    if (typeof mapped === "string" || mapped === null) result[key] = mapped;
  }
  return Object.keys(result).length > 0 ? result : null;
}

function buildPiInputModalities({ image = false } = {}) {
  return [
    "text",
    ...(image ? ["image"] : []),
  ];
}

function normalizePiBuiltinCompat(piBuiltin) {
  if (!piBuiltin?.compat || typeof piBuiltin.compat !== "object") return null;
  return normalizeModelProtocolCompat({
    ...piBuiltin.compat,
    outputCapField: piBuiltin.compat.outputCapField || piBuiltin.compat.maxTokensField,
  });
}

function getPiBuiltinModel(provider, modelId) {
  if (!PI_BUILTIN_METADATA_PROVIDERS.has(provider) || !modelId) return null;
  try {
    return getPiModel(provider, modelId) || null;
  } catch {
    return null;
  }
}

function getPiProtocolBaseline(provider, modelId) {
  return provider === "opencode" || provider === "opencode-go"
    ? getPiBuiltinModel(provider, modelId)
    : null;
}

function shouldReusePiBuiltinModel(provider, modelId, api) {
  return PI_BUILTIN_PROVIDER_REUSE.has(provider)
    && api === "anthropic-messages"
    && !!getPiBuiltinModel(provider, modelId);
}

function isKimiCodingProvider(provider) {
  return provider === KIMI_CODING_PROVIDER;
}

function isOfficialKimiCodingBaseUrl(baseUrl) {
  try {
    const parsed = new URL(String(baseUrl || ""));
    return parsed.hostname === "api.kimi.com"
      && (
        parsed.pathname.replace(/\/+$/, "") === "/coding"
        || parsed.pathname.replace(/\/+$/, "") === "/coding/v1"
      );
  } catch {
    return String(baseUrl || "").replace(/\/+$/, "") === "https://api.kimi.com/coding";
  }
}

function getKimiCodingEffectiveApi(provider, baseUrl, api) {
  if (!isKimiCodingProvider(provider)) return api;
  if (!isOfficialKimiCodingBaseUrl(baseUrl)) return api;
  return "openai-completions";
}

function pickHeader(headers, headerName) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return {};
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === headerName.toLowerCase());
  return entry ? { [entry[0]]: entry[1] } : {};
}

function getPiRequestHeaders(provider, modelId) {
  const exactHeaders = getPiBuiltinModel(provider, modelId)?.headers;
  if (exactHeaders && typeof exactHeaders === "object") return exactHeaders;
  if (!isKimiCodingProvider(provider)) return {};

  // New Kimi Coding model ids still need the provider's client identity, but
  // request headers are the only field shared with the Pi default model.
  const providerHeaders = getPiBuiltinModel(provider, KIMI_CODING_HEADER_MODEL_ID)?.headers;
  return pickHeader(providerHeaders, "user-agent");
}

function isZhipuOpenAICompat(provider, baseUrl, api) {
  return api === "openai-completions" && (
    provider === "zhipu"
    || provider === "zhipu-coding"
    || baseUrl.includes("open.bigmodel.cn")
    || (
      baseUrl.includes("api.z.ai")
      && (
        baseUrl.includes("/api/paas/v4")
        || baseUrl.includes("/api/coding/paas/v4")
      )
    )
  );
}

function buildModelOverride(modelEntry, modelDefaults = {}, executionHeaders = {}) {
  const modelDefaultThinkingLevel = getProviderModelDefaultThinkingLevel(modelDefaults, getModelId(modelEntry));
  if (typeof modelEntry !== "object" || modelEntry === null) {
    const override: Record<string, any> = {};
    if (modelDefaultThinkingLevel !== undefined) override.defaultThinkingLevel = modelDefaultThinkingLevel;
    const headers = normalizeProviderHeaders(executionHeaders);
    if (Object.keys(headers).length > 0) override.headers = headers;
    return Object.keys(override).length > 0 ? override : null;
  }

  const override: Record<string, any> = {};
  if (modelEntry.name !== undefined) override.name = modelEntry.name;
  if (modelEntry.context !== undefined) override.contextWindow = modelEntry.context;
  if (modelEntry.contextWindow !== undefined) override.contextWindow = modelEntry.contextWindow;
  const configuredMaxOutput = modelEntry.maxOutput
    ?? modelEntry.maxTokens
    ?? modelEntry.maxOutputTokens;
  if (configuredMaxOutput !== undefined) override.maxTokens = configuredMaxOutput;
  const defaultThinkingLevel = modelEntry.defaultThinkingLevel ?? modelDefaultThinkingLevel;
  if (defaultThinkingLevel !== undefined) {
    override.defaultThinkingLevel = defaultThinkingLevel;
  }
  const image = modelEntry.image ?? modelEntry.vision;
  const video = modelEntry.video;
  const audio = modelEntry.audio;
  if (image !== undefined || video !== undefined) {
    override.input = buildPiInputModalities({
      image: image === true,
    });
  }
  if (modelEntry.reasoning !== undefined) override.reasoning = modelEntry.reasoning;
  if (modelEntry.xhigh !== undefined) override.xhigh = modelEntry.xhigh;
  const thinkingLevelMap = normalizeThinkingLevelMap(modelEntry.thinkingLevelMap);
  if (thinkingLevelMap) override.thinkingLevelMap = thinkingLevelMap;
  const compat = normalizeModelProtocolCompat(modelEntry.compat);
  if (compat) override.compat = compat;
  const headers = normalizeProviderHeaders(executionHeaders);
  if (Object.keys(headers).length > 0) override.headers = headers;
  const toolUse = normalizeToolUseContract(modelEntry.toolUse);
  if (modelEntry.toolUse !== undefined && !toolUse) {
    throw new Error(`invalid toolUse contract for model "${getModelId(modelEntry) || "unknown"}"`);
  }
  if (toolUse) override.toolUse = toolUse;
  const visionCapabilities = image === true
    ? normalizeVisionCapabilities(modelEntry.visionCapabilities)
    : null;
  if (visionCapabilities) override.visionCapabilities = visionCapabilities;

  let finalOverride = video === true ? withLucVideoInputCompat(override, true) : override;
  finalOverride = audio === true ? withLucAudioInputCompat(finalOverride, true) : finalOverride;
  return Object.keys(finalOverride).length > 0 ? finalOverride : null;
}

/**
 * 构建单个模型的 Pi SDK 格式条目
 * @param {string|{id:string, name?:string, context?:number, maxOutput?:number}} modelEntry
 * @param {string} provider - provider 名称（查词典用）
 */
function buildModelEntry(
  modelEntry,
  provider,
  baseUrl = "",
  api = "openai-completions",
  modelDefaults = {},
  executionHeaders = {},
  providerBaseUrl = baseUrl,
) {
  const isObj = typeof modelEntry === "object" && modelEntry !== null;
  const id = getModelId(modelEntry);
  const known = lookupKnown(provider, id);
  const providerKnown = lookupKnownProvider(provider, id);
  const piRequestHeaders = getPiRequestHeaders(provider, id);
  const piProtocolBaseline = getPiProtocolBaseline(provider, id);
  const modelApi = (isObj && modelEntry.api)
    || providerKnown?.api
    || piProtocolBaseline?.api
    || api;
  const endpointReasoning = getEndpointDefaultReasoningCapability({
    id,
    provider,
    api: modelApi,
    baseUrl,
  });

  // 输入模态能力：用户设置 > known-models 词典 > 默认 false
  // 兼容读：migration #7 之前的旧数据用 vision 字段；两个版本后移除 vision fallback
  const userImage = isObj ? (modelEntry.image ?? modelEntry.vision) : undefined;
  const knownImage = known?.image ?? known?.vision ?? piProtocolBaseline?.input?.includes?.("image");
  const inferredImage = inferOllamaModelMetadata(provider, id)?.image;
  const image = userImage !== undefined ? userImage : (knownImage === true || inferredImage === true);
  const userVideo = isObj ? modelEntry.video : undefined;
  const knownVideo = known?.video;
  const video = userVideo !== undefined ? userVideo : (knownVideo === true);
  const userAudio = isObj ? modelEntry.audio : undefined;
  const knownAudio = known?.audio;
  const audio = userAudio !== undefined ? userAudio : (knownAudio === true);
  const userXhigh = isObj ? modelEntry.xhigh : undefined;
  const xhigh = userXhigh !== undefined ? userXhigh : (known?.xhigh === true);
  const entry: Record<string, any> = {
    id,
    name: (isObj && modelEntry.name) || piProtocolBaseline?.name || known?.name || humanizeName(id),
    input: buildPiInputModalities({ image: image === true }),
    contextWindow: (isObj ? (modelEntry.context ?? modelEntry.contextWindow) : undefined)
      ?? piProtocolBaseline?.contextWindow
      ?? known?.context
      ?? DEFAULT_CONTEXT_WINDOW,
    reasoning: (isObj && modelEntry.reasoning !== undefined)
      ? modelEntry.reasoning
      : (
        piProtocolBaseline?.reasoning === true
        || known?.reasoning === true
        || endpointReasoning === true
      ),
  };
  if (baseUrl !== providerBaseUrl) entry.baseUrl = baseUrl;
  if (xhigh === true) entry.xhigh = true;

  const rawThinkingLevelMap = isObj && modelEntry.thinkingLevelMap !== undefined
    ? modelEntry.thinkingLevelMap
    : (piProtocolBaseline?.thinkingLevelMap ?? providerKnown?.thinkingLevelMap);
  const thinkingLevelMap = normalizeThinkingLevelMap(rawThinkingLevelMap);
  if (thinkingLevelMap) entry.thinkingLevelMap = thinkingLevelMap;
  if ((isObj && modelEntry.api) || providerKnown?.api || modelApi !== api) entry.api = modelApi;

  const maxOutput = (isObj
    ? (modelEntry.maxOutput ?? modelEntry.maxTokens ?? modelEntry.maxOutputTokens)
    : undefined) ?? piProtocolBaseline?.maxTokens ?? known?.maxOutput;
  if (maxOutput) entry.maxTokens = maxOutput;
  const configuredDefaultThinkingLevel = getProviderModelDefaultThinkingLevel(modelDefaults, id);
  const defaultThinkingLevel = isObj
    ? (modelEntry.defaultThinkingLevel ?? configuredDefaultThinkingLevel ?? providerKnown?.defaultThinkingLevel)
    : (configuredDefaultThinkingLevel ?? providerKnown?.defaultThinkingLevel);
  if (defaultThinkingLevel !== undefined) {
    entry.defaultThinkingLevel = normalizeThinkingLevelForModel(
      defaultThinkingLevel,
      {
        ...entry,
        provider,
        api: modelApi,
        baseUrl,
        thinkingLevels: (isObj && modelEntry.thinkingLevels) || providerKnown?.thinkingLevels,
      },
    );
  }

  if (known?.quirks?.length) entry.quirks = known.quirks;
  const modelHeaders = normalizeProviderHeaders({
    ...piRequestHeaders,
    ...(isObj ? (modelEntry.headers || {}) : {}),
    ...executionHeaders,
  });
  if (Object.keys(modelHeaders).length > 0) entry.headers = modelHeaders;

  const rawToolUse = isObj && modelEntry.toolUse !== undefined ? modelEntry.toolUse : known?.toolUse;
  const toolUse = normalizeToolUseContract(rawToolUse);
  if (rawToolUse !== undefined && !toolUse) {
    throw new Error(`invalid toolUse contract for model "${id}"`);
  }
  if (toolUse) entry.toolUse = toolUse;

  const rawVisionCapabilities = isObj && modelEntry.visionCapabilities !== undefined
    ? modelEntry.visionCapabilities
    : known?.visionCapabilities;
  const visionCapabilities = image ? normalizeVisionCapabilities(rawVisionCapabilities) : null;
  if (visionCapabilities) entry.visionCapabilities = visionCapabilities;

  // Pi SDK compat 覆盖：
  // 1. 非 OpenAI provider 不发 developer role（dashscope 等不支持）— 与 reasoning 无关
  // 2. thinkingFormat 由 shared/model-capabilities.ts 统一派生，避免请求层按 provider 猜
  // 3. Gemini OpenAI 兼容层（/v1beta/openai）严格校验，不识别 store 字段会 400。
  //    Native google-generative-ai 不走 Chat Completions，不需要这组 OpenAI 字段兼容。
  if (provider !== "openai") {
    const piBuiltinCompat = normalizePiBuiltinCompat(piProtocolBaseline) || {};
    const knownCompat = normalizeModelProtocolCompat(known?.compat) || {};
    const explicitCompat = isObj
      ? (normalizeModelProtocolCompat(modelEntry.compat) || {})
      : {};
    const compat: Record<string, unknown> = {
      ...piBuiltinCompat,
      ...knownCompat,
      ...explicitCompat,
      supportsDeveloperRole: false,
    };
    if (modelApi === "openai-completions" && (
      provider === "gemini"
      || baseUrl.includes("generativelanguage.googleapis.com")
    )) {
      compat.supportsStore = false;
    }
    if (compat.thinkingFormat === "zhipu" || isZhipuOpenAICompat(provider, baseUrl, modelApi)) {
      compat.supportsStore = false;
      compat.supportsReasoningEffort = false;
    }
    entry.compat = compat;
  }

  let mediaAwareEntry = video === true ? withLucVideoInputCompat(entry, true) : entry;
  mediaAwareEntry = audio === true ? withLucAudioInputCompat(mediaAwareEntry, true) : mediaAwareEntry;
  return withThinkingFormatCompat(mediaAwareEntry, { provider, api: modelApi, baseUrl });
}

function filterChatModelEntries(provider, models) {
  return models.filter(m => {
    const isObj = typeof m === "object" && m !== null;
    const id = getModelId(m);
    const known = lookupKnown(provider, id);
    const type = (isObj && m.type) || known?.type || "chat";
    return type === "chat";
  });
}

/**
 * 单向投影：providers 配置 → models.json（Pi SDK 格式）
 *
 * @param {Record<string, object>} providers - Provider Catalog 中的 providers 块（snake_case）
 * @param {object} [opts]
 * @param {string} opts.modelsJsonPath - models.json 输出路径
 * @returns {boolean} 内容是否有变化
 */
export function syncModels(providers, opts: Record<string, any> = {}) {
  const modelsJsonPath = opts.modelsJsonPath;
  const chatProjectionMap = opts.chatProjectionMap || {};
  const chatProjectionPlans = opts.chatProjectionPlans || {};

  // 构建新的 providers 块
  const newProviders = {};
  const runtimeOwners = new Map();

  for (const [name, p] of Object.entries(providers || {}) as [string, Record<string, any>][]) {
    const plan = chatProjectionPlans[name] || {};
    const projection = plan.projection || chatProjectionMap[name] || "models-json";
    const credentialSource = plan.credentialSource || "provider-catalog";
    if (!CHAT_CREDENTIAL_SOURCES.has(credentialSource)) {
      throw new Error(`Invalid chat credentialSource "${credentialSource}" for provider "${name}"`);
    }
    if (projection === "sdk-auth-alias" || projection === "none") continue;
    const provider = plan.sourceProviderId || name;
    const runtimeProviderId = plan.runtimeProviderId || name;
    if (!p.base_url) continue;
    if (!p.models || p.models.length === 0) continue;
    validateProviderModels(provider, p.models, { baseUrl: p.base_url });

    let apiKey = credentialSource === "provider-catalog" ? (p.api_key || "") : "";
    const hasLiteralApiKey = credentialSource === "provider-catalog"
      && typeof p.api_key === "string"
      && p.api_key.length > 0;

    const headers = credentialSource === "auth-storage" ? {} : normalizeProviderHeaders(p.headers);
    const hasHeaders = Object.keys(headers).length > 0;

    // 无凭证时只允许 provider 契约声明无需 key、旧本地 loopback 配置，或显式 provider headers。
    if (credentialSource === "provider-catalog" && !apiKey && !hasHeaders && !providerCredentialAllowsMissingApiKey({
      authType: p.auth_type,
      baseUrl: p.base_url,
    })) continue;

    const effectiveApiKey = apiKey || (hasHeaders ? "headers" : "local");
    const configuredApi = p.api || "openai-completions";
    const effectiveApi = getKimiCodingEffectiveApi(provider, p.base_url, configuredApi);
    const effectiveBaseUrl = normalizeProviderBaseUrlForApi({
      provider,
      baseUrl: p.base_url,
      api: effectiveApi,
    });
    const modelDefaults = p.model_defaults || {};
    const chatModels = filterChatModelEntries(provider, p.models);
    const customModels = [];
    const modelOverrides = {};
    const modelExecutionHeaders = plan.modelExecutionHeaders || {};

    for (const modelEntry of chatModels) {
      const id = getModelId(modelEntry);
      const modelApi = resolveModelApi(modelEntry, provider, effectiveApi);
      if (shouldReusePiBuiltinModel(provider, id, modelApi)) {
        const override = buildModelOverride(modelEntry, modelDefaults, modelExecutionHeaders[id]);
        if (override) modelOverrides[id] = override;
        continue;
      }
      const modelBaseUrl = normalizeProviderBaseUrlForApi({
        provider,
        baseUrl: p.base_url,
        api: modelApi,
      });
      customModels.push(buildModelEntry(
        modelEntry,
        provider,
        modelBaseUrl,
        effectiveApi,
        modelDefaults,
        modelExecutionHeaders[id],
        effectiveBaseUrl,
      ));
    }

    const providerConfig: Record<string, any> = {
      baseUrl: effectiveBaseUrl,
      api: effectiveApi,
    };
    if (credentialSource !== "auth-storage") {
      providerConfig.apiKey = hasLiteralApiKey ? buildRuntimeApiKeyRef(runtimeProviderId) : effectiveApiKey;
    }
    if (Object.keys(headers).length > 0) providerConfig.headers = headers;
    if (customModels.length > 0) providerConfig.models = customModels;
    if (Object.keys(modelOverrides).length > 0) providerConfig.modelOverrides = modelOverrides;

    const previousOwner = runtimeOwners.get(runtimeProviderId);
    if (previousOwner && previousOwner !== provider) {
      throw new Error(`Chat runtime provider collision: "${previousOwner}" and "${provider}" both project to "${runtimeProviderId}"`);
    }
    runtimeOwners.set(runtimeProviderId, provider);
    newProviders[runtimeProviderId] = providerConfig;
  }

  const newJson = { providers: newProviders };
  const newStr = JSON.stringify(newJson, null, 4) + "\n";

  // 比较是否有变化
  let oldStr = "";
  try {
    oldStr = fs.readFileSync(modelsJsonPath, "utf-8");
  } catch {
    // 文件不存在，视为有变化
  }
  if (oldStr === newStr) return false;

  // 原子写入：先写 tmp 文件，再 rename
  writeSecretFileSync(modelsJsonPath, newStr);

  return true;
}
