/**
 * MiniMax provider plugin (API key)
 *
 * MiniMax 按量付费 API 接入。
 * 文档：https://platform.minimax.io/docs
 */

import {
  COMMON_IMAGE_RATIOS,
  booleanParam,
  enumParam,
  integerParam,
  mediaMode,
  noReferenceImages,
  referenceImages,
} from "./media-schema-helpers.ts";

const MINIMAX_IMAGE_PROPERTIES = {
  ratio: enumParam(COMMON_IMAGE_RATIOS, "3:2"),
  width: integerParam({ minimum: 512, maximum: 2048 }),
  height: integerParam({ minimum: 512, maximum: 2048 }),
  n: integerParam({ minimum: 1, maximum: 9, defaultValue: 1 }),
  seed: integerParam(),
  prompt_optimizer: booleanParam(false),
};

function minimaxImageModel(id, displayName) {
  return {
    id,
    displayName,
    protocolId: "minimax-images",
    inputs: ["text", "image"],
    outputs: ["image"],
    supportsEdit: true,
    modes: [
      mediaMode("text2image", "Text to image", MINIMAX_IMAGE_PROPERTIES, { ratio: "3:2" }, noReferenceImages()),
      mediaMode("image2image", "Subject reference", MINIMAX_IMAGE_PROPERTIES, { ratio: "3:2" }, referenceImages()),
    ],
    ratios: [...COMMON_IMAGE_RATIOS],
  };
}

export const minimaxImageGenerationCapability = {
  defaultModelId: "image-01",
  credentialLanes: [
    { id: "minimax", providerId: "minimax", label: "MiniMax" },
    { id: "minimax-token-plan", providerId: "minimax-token-plan", label: "MiniMax Token Plan" },
  ],
  models: [
    minimaxImageModel("image-01", "MiniMax Image 01"),
    minimaxImageModel("image-01-live", "MiniMax Image 01 Live"),
  ],
};

/** @type {import('../../core/provider-registry.ts').ProviderPlugin} */
export const minimaxPlugin = {
  id: "minimax",
  displayName: "MiniMax",
  authType: "api-key",
  defaultBaseUrl: "https://api.minimaxi.com/anthropic",
  defaultApi: "anthropic-messages",
  capabilities: {
    media: {
      imageGeneration: minimaxImageGenerationCapability,
    },
  },
};
