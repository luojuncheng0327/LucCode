export const COMMON_IMAGE_RATIOS = Object.freeze([
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "21:9",
]);

export const OPENAI_IMAGE_RATIOS = Object.freeze([
  "1:1",
  "3:2",
  "2:3",
]);

export const OPENAI_FLEXIBLE_IMAGE_RATIOS = Object.freeze([
  "1:1",
  "4:3",
  "3:4",
  "16:9",
  "9:16",
  "3:2",
  "2:3",
  "21:9",
]);

export const GEMINI_25_IMAGE_RATIOS = Object.freeze([
  "1:1",
  "3:2",
  "2:3",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
]);

export const GEMINI_31_FLASH_IMAGE_RATIOS = Object.freeze([
  "1:1",
  "1:4",
  "1:8",
  "2:3",
  "3:2",
  "3:4",
  "4:1",
  "4:3",
  "4:5",
  "5:4",
  "8:1",
  "9:16",
  "16:9",
  "21:9",
]);

export const GEMINI_3_PRO_IMAGE_RATIOS = Object.freeze([
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
]);

export function enumParam(values, defaultValue = undefined, extra: any = {}) {
  return {
    type: "string",
    enum: [...values],
    ...(defaultValue !== undefined ? { default: defaultValue } : {}),
    ...extra,
  };
}

export function stringParam(defaultValue = undefined, extra: any = {}) {
  return {
    type: "string",
    ...(defaultValue !== undefined ? { default: defaultValue } : {}),
    ...extra,
  };
}

export function booleanParam(defaultValue = undefined, extra: any = {}) {
  return {
    type: "boolean",
    ...(defaultValue !== undefined ? { default: defaultValue } : {}),
    ...extra,
  };
}

export function integerParam({ minimum = undefined, maximum = undefined, defaultValue = undefined }: any = {}) {
  return {
    type: "integer",
    ...(minimum !== undefined ? { minimum } : {}),
    ...(maximum !== undefined ? { maximum } : {}),
    ...(defaultValue !== undefined ? { default: defaultValue } : {}),
  };
}

export function numberParam({ minimum = undefined, maximum = undefined, defaultValue = undefined }: any = {}) {
  return {
    type: "number",
    ...(minimum !== undefined ? { minimum } : {}),
    ...(maximum !== undefined ? { maximum } : {}),
    ...(defaultValue !== undefined ? { default: defaultValue } : {}),
  };
}

export function parameterSchema(properties) {
  return {
    type: "object",
    properties,
  };
}

export function mediaMode(id, label, properties, defaults: any = {}, inputLimits: any = null) {
  return {
    id,
    label,
    parameterSchema: parameterSchema(properties),
    ...(Object.keys(defaults || {}).length > 0 ? { defaults } : {}),
    ...(inputLimits ? { inputLimits } : {}),
  };
}

export function noReferenceImages() {
  return { referenceImages: { min: 0, max: 0 } };
}

export function referenceImages({ min = 1, max = undefined }: any = {}) {
  return {
    referenceImages: {
      min,
      ...(max !== undefined ? { max } : {}),
    },
  };
}
