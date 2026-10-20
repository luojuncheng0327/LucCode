/**
 * Google Gemini provider plugin
 *
 * 通过 Gemini native API 接入。Gemini 3 工具调用需要保留
 * thoughtSignature，Pi SDK 的 google-generative-ai provider 已处理该协议。
 * 文档：https://ai.google.dev/gemini-api/docs
 */

import {
  GEMINI_25_IMAGE_RATIOS,
  GEMINI_31_FLASH_IMAGE_RATIOS,
  GEMINI_3_PRO_IMAGE_RATIOS,
  enumParam,
  mediaMode,
  noReferenceImages,
  referenceImages,
} from "./media-schema-helpers.ts";

function geminiImageProperties(ratios, resolutions = null) {
  const defaultResolution = resolutions
    ? (resolutions.includes("1K") ? "1K" : resolutions[0])
    : null;
  return {
    ratio: enumParam(ratios, ratios.includes("3:2") ? "3:2" : ratios[0]),
    ...(resolutions ? { resolution: enumParam(resolutions, defaultResolution) } : {}),
  };
}

function geminiImageModel(id, displayName, aliases, ratios, resolutions, maxReferenceImages) {
  const properties = geminiImageProperties(ratios, resolutions);
  const defaultResolution = resolutions
    ? (resolutions.includes("1K") ? "1K" : resolutions[0])
    : null;
  const defaults = {
    ratio: ratios.includes("3:2") ? "3:2" : ratios[0],
    ...(resolutions ? { resolution: defaultResolution } : {}),
  };
  return {
    id,
    displayName,
    protocolId: "gemini-generate-content-image",
    inputs: ["text", "image"],
    outputs: ["image"],
    supportsEdit: true,
    aliases,
    modes: [
      mediaMode("text2image", "Text to image", properties, defaults, noReferenceImages()),
      mediaMode("image2image", "Image edit/reference", properties, defaults, referenceImages({ max: maxReferenceImages })),
    ],
    ratios: [...ratios],
    ...(resolutions ? { resolutions: [...resolutions] } : {}),
  };
}

/** @type {import('../provider-registry.ts').ProviderPlugin} */
export const geminiPlugin = {
  id: "gemini",
  displayName: "Google Gemini",
  authType: "api-key",
  defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
  defaultApi: "google-generative-ai",
  capabilities: {
    media: {
      imageGeneration: {
        defaultModelId: "gemini-3.1-flash-image",
        models: [
          geminiImageModel("gemini-2.5-flash-image", "Gemini 2.5 Flash Image", ["nano-banana"], GEMINI_25_IMAGE_RATIOS, null, 3),
          geminiImageModel("gemini-3.1-flash-image", "Gemini 3.1 Flash Image", ["nano-banana-2", "gemini-3.1-flash-image-preview"], GEMINI_31_FLASH_IMAGE_RATIOS, ["512", "1K", "2K", "4K"], 14),
          geminiImageModel("gemini-3-pro-image", "Gemini 3 Pro Image", ["nano-banana-pro", "gemini-3-pro-image-preview"], GEMINI_3_PRO_IMAGE_RATIOS, ["1K", "2K", "4K"], 14),
        ],
      },
    },
  },
};
