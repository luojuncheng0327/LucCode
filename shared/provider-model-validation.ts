const OFFICIAL_DEEPSEEK_PROVIDER_ID = "deepseek";
const OFFICIAL_DEEPSEEK_HOST = "api.deepseek.com";
const OFFICIAL_DEEPSEEK_RESERVED_MODEL_IDS = new Set(["deepseek"]);
const THINKING_LEVEL_MAP_KEYS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
const MODEL_CREDENTIAL_FIELDS = new Set([
  "api_key",
  "apikey",
  "token",
  "access",
  "accesstoken",
  "access_token",
  "refresh",
  "refresh_token",
  "refreshtoken",
  "accountid",
  "account_id",
  "authorization",
  "cookie",
  "headers",
  "resourceurl",
  "resource_url",
  "expires",
]);

function modelIdOf(modelEntry) {
  if (typeof modelEntry === "object" && modelEntry !== null) {
    return typeof modelEntry.id === "string" ? modelEntry.id : "";
  }
  return typeof modelEntry === "string" ? modelEntry : "";
}

function normalizedModelId(modelEntry) {
  return modelIdOf(modelEntry).trim().toLowerCase();
}

function hostnameOf(baseUrl = "") {
  if (!baseUrl || typeof baseUrl !== "string") return "";
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return baseUrl.toLowerCase();
  }
}

function isOfficialDeepSeekProvider(providerId, baseUrl = "") {
  const normalizedProvider = typeof providerId === "string" ? providerId.trim().toLowerCase() : "";
  if (normalizedProvider === OFFICIAL_DEEPSEEK_PROVIDER_ID) return true;
  return hostnameOf(baseUrl) === OFFICIAL_DEEPSEEK_HOST;
}

function isReservedOfficialDeepSeekModelId(providerId, modelEntry, options: Record<string, any> = {}) {
  if (!isOfficialDeepSeekProvider(providerId, options.baseUrl)) return false;
  return OFFICIAL_DEEPSEEK_RESERVED_MODEL_IDS.has(normalizedModelId(modelEntry));
}

export class ProviderModelValidationError extends Error {
  declare code: string;
  declare statusCode: number;

  constructor(providerId, modelId) {
    super(
      `Invalid model id "${modelId}" for provider "${providerId}": ` +
      `"${modelId}" is a provider id, not a model id. Use a concrete model id such as deepseek-v4-pro or deepseek-v4-flash.`,
    );
    this.name = "ProviderModelValidationError";
    this.code = "INVALID_PROVIDER_MODEL_ID";
    this.statusCode = 400;
  }
}

export class ProviderModelMetadataValidationError extends Error {
  declare code: string;
  declare statusCode: number;

  constructor(providerId, modelId, field, detail) {
    super(`Invalid ${field} for model "${providerId}/${modelId}": ${detail}`);
    this.name = "ProviderModelMetadataValidationError";
    this.code = "INVALID_PROVIDER_MODEL_METADATA";
    this.statusCode = 400;
  }
}

function validatePositiveNumber(providerId, modelId, model, field) {
  if (!Object.prototype.hasOwnProperty.call(model, field)) return;
  const value = model[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ProviderModelMetadataValidationError(providerId, modelId, field, "expected a positive finite number");
  }
}

function validateModelMetadata(providerId, model) {
  if (!model || typeof model !== "object" || Array.isArray(model)) return;
  const rawModelId = modelIdOf(model);
  const modelId = typeof rawModelId === "string" && rawModelId.trim() ? rawModelId.trim() : "unknown";
  for (const field of Object.keys(model)) {
    if (MODEL_CREDENTIAL_FIELDS.has(field.toLowerCase())) {
      throw new ProviderModelMetadataValidationError(
        providerId,
        modelId,
        field,
        "credentials belong to the provider or AuthStorage, not a model entry",
      );
    }
  }
  if (Object.prototype.hasOwnProperty.call(model, "api")
    && (typeof model.api !== "string" || !model.api.trim())) {
    throw new ProviderModelMetadataValidationError(providerId, modelId, "api", "expected a non-empty string");
  }
  for (const field of ["context", "contextWindow", "maxOutput", "maxTokens", "maxOutputTokens"]) {
    validatePositiveNumber(providerId, modelId, model, field);
  }
  if (!Object.prototype.hasOwnProperty.call(model, "thinkingLevelMap")) return;
  const map = model.thinkingLevelMap;
  if (!map || typeof map !== "object" || Array.isArray(map)) {
    throw new ProviderModelMetadataValidationError(providerId, modelId, "thinkingLevelMap", "expected an object");
  }
  for (const [key, value] of Object.entries(map)) {
    if (!THINKING_LEVEL_MAP_KEYS.has(key)) {
      throw new ProviderModelMetadataValidationError(providerId, modelId, `thinkingLevelMap.${key}`, "unsupported thinking level");
    }
    if (value !== null && (typeof value !== "string" || !value.trim())) {
      throw new ProviderModelMetadataValidationError(providerId, modelId, `thinkingLevelMap.${key}`, "expected a non-empty string or null");
    }
  }
}

export function getInvalidProviderModelIds(providerId, models, options = {}) {
  if (!Array.isArray(models)) return [];
  const invalid = [];
  for (const modelEntry of models) {
    if (!isReservedOfficialDeepSeekModelId(providerId, modelEntry, options)) continue;
    const id = modelIdOf(modelEntry).trim();
    if (id && !invalid.includes(id)) invalid.push(id);
  }
  return invalid;
}

export function validateProviderModels(providerId, models, options = {}) {
  if (Array.isArray(models)) {
    for (const model of models) validateModelMetadata(providerId, model);
  }
  const invalid = getInvalidProviderModelIds(providerId, models, options);
  if (invalid.length === 0) return;
  throw new ProviderModelValidationError(providerId, invalid[0]);
}

export function filterDiscoveredProviderModels(providerId, models, options = {}) {
  if (!Array.isArray(models)) return { models: [], ignoredModels: [] };
  const filtered = [];
  const ignoredModels = [];
  for (const model of models) {
    if (isReservedOfficialDeepSeekModelId(providerId, model, options)) {
      const id = modelIdOf(model).trim();
      if (id && !ignoredModels.includes(id)) ignoredModels.push(id);
      continue;
    }
    filtered.push(model);
  }
  return { models: filtered, ignoredModels };
}
