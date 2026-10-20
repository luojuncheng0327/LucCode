import { getPiModel } from "../lib/pi-sdk/index.ts";
import { lookupKnown } from "../shared/known-models.ts";
import {
  getEndpointDefaultReasoningCapability,
  normalizeVisionCapabilities,
  withThinkingFormatCompat,
} from "../shared/model-capabilities.ts";
import { inferOllamaModelMetadata } from "../shared/ollama-model-metadata.ts";

const RUNTIME_ENRICHED_PROVIDERS = new Set(["kimi-coding", "ollama", "volcengine-coding"]);
const KIMI_CODING_PROVIDER = "kimi-coding";
const KIMI_CODING_HEADER_MODEL_ID = "kimi-for-coding";

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function getPiBuiltinModel(provider, modelId) {
  if (!provider || !modelId) return null;
  try {
    return getPiModel(provider, modelId) || null;
  } catch {
    return null;
  }
}

function pickHeader(headers, headerName) {
  if (!isPlainObject(headers)) return null;
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === headerName.toLowerCase());
  return entry ? { [entry[0]]: entry[1] } : null;
}

function getPiRequestHeaders(provider, modelId) {
  const exactHeaders = getPiBuiltinModel(provider, modelId)?.headers;
  if (isPlainObject(exactHeaders)) return exactHeaders;
  if (provider !== KIMI_CODING_PROVIDER) return null;

  // Unknown/new Kimi ids inherit only the provider request identity. Model
  // identity, limits, modalities, and cost remain owned by the actual model.
  const providerHeaders = getPiBuiltinModel(provider, KIMI_CODING_HEADER_MODEL_ID)?.headers;
  return pickHeader(providerHeaders, "user-agent");
}

function mergeCompat(model, known) {
  if (!known || model.provider === "openai") return model;
  return {
    ...model,
    compat: {
      supportsDeveloperRole: false,
      ...(isPlainObject(model.compat) ? model.compat : {}),
    },
  };
}

function isOfficialKimiCodingRuntime(model) {
  if (model.provider !== "kimi-coding") return false;
  try {
    const parsed = new URL(String(model.baseUrl || ""));
    return parsed.hostname === "api.kimi.com"
      && parsed.pathname.replace(/\/+$/, "").startsWith("/coding");
  } catch {
    return String(model.baseUrl || "").replace(/\/+$/, "") === "https://api.kimi.com/coding";
  }
}

function normalizeKimiCodingRuntimeTransport(model) {
  if (!isOfficialKimiCodingRuntime(model)) return model;
  const compat = isPlainObject(model.compat) ? { ...model.compat } : {};
  delete compat.thinkingFormat;
  delete compat.reasoningProfile;
  return {
    ...model,
    api: "openai-completions",
    baseUrl: "https://api.kimi.com/coding/v1",
    compat,
  };
}

export function enrichModelFromKnownMetadata(model) {
  if (!isPlainObject(model)) return model;
  if (!RUNTIME_ENRICHED_PROVIDERS.has(model.provider)) return model;

  const normalizedModel = normalizeKimiCodingRuntimeTransport(model);
  const known = lookupKnown(normalizedModel.provider, normalizedModel.id);
  const piRequestHeaders = getPiRequestHeaders(normalizedModel.provider, normalizedModel.id);
  const patch: Record<string, unknown> = {};

  if (normalizedModel.reasoning === undefined && getEndpointDefaultReasoningCapability(normalizedModel) === true) {
    patch.reasoning = true;
  }

  if (!normalizedModel.headers && piRequestHeaders) {
    patch.headers = { ...piRequestHeaders };
  }

  const hasInputContract = Array.isArray(normalizedModel.input);
  const hasImageInput = hasInputContract && normalizedModel.input.includes("image");
  const knownImage = known?.image ?? known?.vision;
  const inferredImage = inferOllamaModelMetadata(normalizedModel.provider, normalizedModel.id)?.image;
  // models.json projection owns explicit user input capability, including
  // `image:false` represented as ["text"]. Known/inferred metadata only fills
  // runtimes that supplied no input contract at all.
  const image = hasInputContract ? hasImageInput : (knownImage === true || inferredImage === true);
  if (image && !hasImageInput) {
    patch.input = ["text", "image"];
  } else if (normalizedModel.provider === "volcengine-coding" && !Array.isArray(normalizedModel.input)) {
    patch.input = ["text"];
  }
  const visionCapabilities = image ? normalizeVisionCapabilities(known?.visionCapabilities) : null;
  if (visionCapabilities && !normalizedModel.visionCapabilities) {
    patch.visionCapabilities = visionCapabilities;
  }

  const withPatch = Object.keys(patch).length > 0 ? { ...normalizedModel, ...patch } : normalizedModel;
  const withCompat = mergeCompat(withPatch, known);
  return withThinkingFormatCompat(withCompat, {
    provider: withCompat.provider,
    api: withCompat.api,
    baseUrl: withCompat.baseUrl,
    id: withCompat.id,
  });
}
