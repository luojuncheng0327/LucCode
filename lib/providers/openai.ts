/**
 * OpenAI provider plugin
 */

import {
  OPENAI_IMAGE_RATIOS,
  enumParam,
  integerParam,
  mediaMode,
  noReferenceImages,
  referenceImages,
} from "./media-schema-helpers.ts";

const GPT_IMAGE_PROPERTIES = {
  ratio: enumParam(OPENAI_IMAGE_RATIOS, "3:2"),
  size: enumParam(["auto", "1024x1024", "1536x1024", "1024x1536"], "1536x1024"),
  resolution: enumParam(["1K"], "1K"),
  quality: enumParam(["auto", "low", "medium", "high"], "auto"),
  format: enumParam(["png", "jpeg", "webp"], "jpeg"),
  background: enumParam(["auto", "opaque", "transparent"], "auto"),
  output_compression: integerParam({ minimum: 0, maximum: 100 }),
  moderation: enumParam(["auto", "low"], "auto"),
  n: integerParam({ minimum: 1, maximum: 10, defaultValue: 1 }),
};

const DALL_E_3_PROPERTIES = {
  ratio: enumParam(["1:1", "16:9", "9:16"], "16:9"),
  size: enumParam(["1024x1024", "1792x1024", "1024x1792"], "1792x1024"),
  quality: enumParam(["standard", "hd"], "standard"),
  style: enumParam(["vivid", "natural"], "vivid"),
  n: integerParam({ minimum: 1, maximum: 1, defaultValue: 1 }),
};

const GPT_IMAGE_DEFAULTS = { ratio: "3:2", resolution: "1K" };
const DALL_E_3_DEFAULTS = { ratio: "16:9", size: "1792x1024" };

function gptImageModel(id, displayName, aliases) {
  return {
    id,
    displayName,
    protocolId: "openai-images",
    inputs: ["text", "image"],
    outputs: ["image"],
    supportsEdit: true,
    aliases,
    modes: [
      mediaMode("text2image", "Text to image", GPT_IMAGE_PROPERTIES, GPT_IMAGE_DEFAULTS, noReferenceImages()),
      mediaMode("image2image", "Image edit/reference", GPT_IMAGE_PROPERTIES, GPT_IMAGE_DEFAULTS, referenceImages()),
    ],
    ratios: [...OPENAI_IMAGE_RATIOS],
    resolutions: ["1K"],
  };
}

/** @type {import('../provider-registry.ts').ProviderPlugin} */
export const openaiPlugin = {
  id: "openai",
  displayName: "OpenAI",
  authType: "api-key",
  defaultBaseUrl: "https://api.openai.com/v1",
  defaultApi: "openai-completions",
  capabilities: {
    media: {
      imageGeneration: {
        defaultModelId: "gpt-image-1.5",
        models: [
          gptImageModel("gpt-image-1.5", "GPT Image 1.5", ["1.5"]),
          gptImageModel("gpt-image-1", "GPT Image 1", ["1"]),
          gptImageModel("gpt-image-1-mini", "GPT Image 1 Mini", ["1-mini", "mini"]),
          {
            id: "dall-e-3",
            displayName: "DALL-E 3",
            protocolId: "openai-images",
            inputs: ["text"],
            outputs: ["image"],
            aliases: ["dalle3"],
            modes: [
              mediaMode("text2image", "Text to image", DALL_E_3_PROPERTIES, DALL_E_3_DEFAULTS, noReferenceImages()),
            ],
            ratios: ["1:1", "16:9", "9:16"],
            resolutions: ["1K"],
          },
        ],
      },
      speechRecognition: {
        defaultModelId: "gpt-4o-mini-transcribe",
        models: [
          { id: "gpt-4o-transcribe", displayName: "GPT-4o Transcribe", protocolId: "openai-audio-transcriptions", inputs: ["audio"], outputs: ["text"] },
          { id: "gpt-4o-mini-transcribe", displayName: "GPT-4o Mini Transcribe", protocolId: "openai-audio-transcriptions", inputs: ["audio"], outputs: ["text"] },
          { id: "whisper-1", displayName: "Whisper 1", protocolId: "openai-audio-transcriptions", inputs: ["audio"], outputs: ["text"] },
        ],
      },
    },
  },
};
