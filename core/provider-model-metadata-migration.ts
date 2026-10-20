const POSITIVE_NUMBER_FIELDS = [
  "context",
  "contextWindow",
  "maxOutput",
  "maxTokens",
  "maxOutputTokens",
] as const;

const THINKING_LEVEL_MAP_KEYS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

// Keep this list aligned with the model-level credential boundary enforced by
// shared/provider-model-validation.ts. Provider credentials must never be
// inferred from or moved out of a legacy model entry during migration.
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

export interface ProviderModelMetadataRepair {
  providerId: string;
  modelId: string;
  fields: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isValidThinkingLevelValue(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && !!value.trim());
}

/**
 * Repair model metadata accepted by older Provider Catalog writers but rejected
 * by the current startup projection. The input is never mutated, model entries
 * keep their order, and entries without a usable string id are left untouched.
 */
export function repairProviderModelMetadata<T extends Record<string, unknown>>(providers: T) {
  const repairedProviders = structuredClone(providers);
  const repairs: ProviderModelMetadataRepair[] = [];

  if (!isRecord(repairedProviders)) {
    return { providers: repairedProviders, changed: false, repairs };
  }

  for (const [providerId, provider] of Object.entries(repairedProviders)) {
    if (!isRecord(provider) || !Array.isArray(provider.models)) continue;

    for (const model of provider.models) {
      if (!isRecord(model) || typeof model.id !== "string" || !model.id.trim()) continue;

      const fields: string[] = [];

      for (const field of Object.keys(model)) {
        if (!MODEL_CREDENTIAL_FIELDS.has(field.toLowerCase())) continue;
        delete model[field];
        fields.push(field);
      }

      for (const field of POSITIVE_NUMBER_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(model, field)) continue;
        if (isPositiveFiniteNumber(model[field])) continue;
        delete model[field];
        fields.push(field);
      }

      if (Object.prototype.hasOwnProperty.call(model, "api")
        && (typeof model.api !== "string" || !model.api.trim())) {
        delete model.api;
        fields.push("api");
      }

      if (Object.prototype.hasOwnProperty.call(model, "thinkingLevelMap")) {
        const map = model.thinkingLevelMap;
        if (!isRecord(map)) {
          delete model.thinkingLevelMap;
          fields.push("thinkingLevelMap");
        } else {
          for (const [key, value] of Object.entries(map)) {
            if (THINKING_LEVEL_MAP_KEYS.has(key) && isValidThinkingLevelValue(value)) continue;
            delete map[key];
            fields.push(`thinkingLevelMap.${key}`);
          }
          if (Object.keys(map).length === 0) {
            delete model.thinkingLevelMap;
            fields.push("thinkingLevelMap");
          }
        }
      }

      if (fields.length > 0) {
        repairs.push({
          providerId,
          modelId: model.id.trim(),
          fields,
        });
      }
    }
  }

  return {
    providers: repairedProviders,
    changed: repairs.length > 0,
    repairs,
  };
}
