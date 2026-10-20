function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function compactObject(value) {
  const out: Record<string, any> = {};
  for (const [key, item] of Object.entries(value || {})) {
    if (item !== undefined && item !== null && item !== "") out[key] = item;
  }
  return out;
}

function imageCount(input: any = {}) {
  const raw = input.referenceImages || input.images || input.image;
  if (!raw) return 0;
  const images = Array.isArray(raw) ? raw : [raw];
  return images.filter((item) => {
    if (typeof item === "string") return item.trim();
    return isObject(item);
  }).length;
}

export function inferMediaMode(kind, input: any = {}) {
  const requested = text(input.mode) || text(input.options?.mode);
  if (requested) return requested;
  const count = imageCount(input);
  if (kind === "video") {
    if (count > 1) return "multiframe2video";
    if (count === 1) return "image2video";
    return "text2video";
  }
  if (count > 0) return "image2image";
  return "text2image";
}

function findMode(model: any = {}, modeId) {
  if (!Array.isArray(model?.modes) || model.modes.length === 0) return null;
  return model.modes.find((mode) => mode?.id === modeId) || null;
}

function resolveInputLimits(model: any = {}, mode: any = null) {
  if (isObject(mode?.inputLimits)) return mode.inputLimits;
  if (isObject(model?.inputLimits)) return model.inputLimits;
  return null;
}

function withoutNestedDefaults(value: any = {}) {
  const out: Record<string, any> = {};
  for (const [key, item] of Object.entries(value || {})) {
    if (key === "models" || key === "modes" || key === "options") continue;
    out[key] = item;
  }
  return out;
}

function filterDefaultsBySchema(defaults: any = {}, schema: any = null) {
  if (!isObject(defaults)) return {};
  if (!isObject(schema?.properties)) return defaults;
  const props = schema.properties;
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(defaults)) {
    if (Object.prototype.hasOwnProperty.call(props, key)) out[key] = value;
  }
  return out;
}

function providerDefaultsForMode(providerDefaults: any = {}, modelId, modeId) {
  if (!isObject(providerDefaults)) return {};
  const modelDefaults = isObject(providerDefaults.models?.[modelId])
    ? providerDefaults.models[modelId]
    : {};
  const modeDefaults = isObject(modelDefaults.modes?.[modeId])
    ? modelDefaults.modes[modeId]
    : isObject(providerDefaults.modes?.[modeId])
      ? providerDefaults.modes[modeId]
      : {};
  return {
    ...withoutNestedDefaults(providerDefaults),
    ...(isObject(providerDefaults.options) ? providerDefaults.options : {}),
    ...withoutNestedDefaults(modelDefaults),
    ...(isObject(modelDefaults.options) ? modelDefaults.options : {}),
    ...withoutNestedDefaults(modeDefaults),
    ...(isObject(modeDefaults.options) ? modeDefaults.options : {}),
  };
}

function explicitParameters(kind, input: any = {}, schema: any = {}) {
  const props = isObject(schema?.properties) ? schema.properties : {};
  const out: Record<string, any> = {};
  const add = (key, value) => {
    if (value !== undefined && value !== null && value !== "") out[key] = value;
  };
  add("duration", input.duration ?? input.seconds);
  add("ratio", input.ratio ?? input.aspect_ratio ?? input.aspectRatio);
  add("quality", input.quality);
  add("frame_rate", input.frame_rate ?? input.frameRate);
  add("num_frames", input.num_frames ?? input.numFrames);
  add("seed", input.seed);
  if (kind === "video") {
    add("video_resolution", input.video_resolution ?? input.videoResolution);
    if (input.resolution !== undefined) {
      if (props.video_resolution) add("video_resolution", input.resolution);
      else add("resolution", input.resolution);
    }
  } else {
    add("resolution", input.resolution);
    add("resolution_type", input.resolution_type ?? input.resolutionType);
    add("size", input.size);
    add("format", input.format);
  }
  return out;
}

function typeMatches(type, value) {
  if (!type) return true;
  if (Array.isArray(type)) return type.some((item) => typeMatches(item, value));
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isObject(value);
  return true;
}

function validateSchemaValue(key, value, schema: any = {}) {
  if (value === undefined || value === null) return;
  if (!typeMatches(schema.type, value)) {
    throw new Error(`Media parameter "${key}" must be ${Array.isArray(schema.type) ? schema.type.join(" or ") : schema.type}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    throw new Error(`Media parameter "${key}" must be one of: ${schema.enum.join(", ")}`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      throw new Error(`Media parameter "${key}" must be >= ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      throw new Error(`Media parameter "${key}" must be <= ${schema.maximum}`);
    }
  }
}

export function validateMediaParameters(parameters: any = {}, schema: any = {}) {
  if (!isObject(schema) || !isObject(schema.properties)) return;
  for (const [key, value] of Object.entries(parameters || {})) {
    const propertySchema = schema.properties[key];
    if (!propertySchema) continue;
    validateSchemaValue(key, value, propertySchema);
  }
}

function applyExplicitImageSizePrecedence(parameters: any = {}, explicit: any = {}) {
  if (!isObject(parameters) || !isObject(explicit)) return parameters;
  const hasExplicitResolution = Object.prototype.hasOwnProperty.call(explicit, "resolution");
  const hasExplicitSize = Object.prototype.hasOwnProperty.call(explicit, "size");
  const hasExplicitResolutionType = Object.prototype.hasOwnProperty.call(explicit, "resolution_type");

  if (hasExplicitResolution && !hasExplicitSize) delete parameters.size;
  if (hasExplicitResolution && !hasExplicitResolutionType) delete parameters.resolution_type;
  if (hasExplicitSize && !hasExplicitResolution) delete parameters.resolution;
  if (hasExplicitSize && !hasExplicitResolutionType) delete parameters.resolution_type;
  if (hasExplicitResolutionType && !hasExplicitResolution) delete parameters.resolution;
  if (hasExplicitResolutionType && !hasExplicitSize) delete parameters.size;
  return parameters;
}

function validateReferenceImageLimits({
  input = {},
  inputLimits = null,
  providerId = "",
  modelId = "",
  modeId = "",
}: any = {}) {
  if (!isObject(inputLimits?.referenceImages)) return;
  const limits = inputLimits.referenceImages;
  const count = imageCount(input);
  const label = `${providerId}/${modelId}`.replace(/^\/|\/$/g, "") || "selected media model";
  if (typeof limits.max === "number" && count > limits.max) {
    if (limits.max === 0) {
      throw new Error(`Media model "${label}" mode "${modeId}" does not support reference images`);
    }
    throw new Error(`Media model "${label}" mode "${modeId}" supports at most ${limits.max} reference images`);
  }
  if (typeof limits.min === "number" && count < limits.min) {
    throw new Error(`Media model "${label}" mode "${modeId}" requires at least ${limits.min} reference images`);
  }
}

export function resolveMediaParameters({
  kind,
  input = {},
  providerId = "",
  model = null,
  providerDefaults = {},
}: any = {}) {
  const modelId = text(model?.id) || text(input.modelId) || text(input.model);
  const modeId = inferMediaMode(kind, input);
  const mode = findMode(model, modeId);
  if (Array.isArray(model?.modes) && model.modes.length > 0 && !mode) {
    throw new Error(`Media model "${providerId}/${modelId}" does not support mode "${modeId}"`);
  }
  const parameterSchema = mode?.parameterSchema || model?.parameterSchema || null;
  const inputLimits = resolveInputLimits(model, mode);
  validateReferenceImageLimits({ input, inputLimits, providerId, modelId, modeId });
  const explicit = explicitParameters(kind, input, parameterSchema);
  const inheritedDefaults = providerDefaultsForMode(providerDefaults, modelId, modeId);
  const resolvedParameters = compactObject({
    ...(isObject(mode?.defaults) ? clone(mode.defaults) : {}),
    ...filterDefaultsBySchema(inheritedDefaults, parameterSchema),
    ...(isObject(input.options) ? input.options : {}),
    ...explicit,
  });
  if (kind === "image") applyExplicitImageSizePrecedence(resolvedParameters, explicit);
  validateMediaParameters(resolvedParameters, parameterSchema);
  return {
    modeId,
    mode: mode ? clone(mode) : null,
    parameterSchema: clone(parameterSchema),
    inputLimits: clone(inputLimits),
    resolvedParameters,
  };
}
