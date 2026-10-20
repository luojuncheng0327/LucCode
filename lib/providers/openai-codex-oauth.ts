/**
 * OpenAI Codex OAuth provider plugin
 *
 * 通过 OAuth 接入，对应 auth.json 中的 openai-codex 条目。
 */

import {
  OPENAI_FLEXIBLE_IMAGE_RATIOS,
  enumParam,
  integerParam,
  mediaMode,
  noReferenceImages,
  referenceImages,
} from "./media-schema-helpers.ts";

const GPT_IMAGE_2_PROPERTIES = {
  ratio: enumParam(OPENAI_FLEXIBLE_IMAGE_RATIOS, "3:2"),
  resolution: enumParam(["1K", "2K"], "2K"),
  quality: enumParam(["auto", "low", "medium", "high"], "auto"),
  format: enumParam(["png", "jpeg", "webp"], "png"),
  background: enumParam(["auto", "opaque"], "auto"),
  output_compression: integerParam({ minimum: 0, maximum: 100 }),
};

const GPT_IMAGE_2_DEFAULTS = { ratio: "3:2", resolution: "2K" };

/** @type {import('../provider-registry.ts').ProviderPlugin} */
export const openaiCodexOAuthPlugin = {
  id: "openai-codex-oauth",
  displayName: "OpenAI Codex (OAuth)",
  authType: "oauth",
  defaultBaseUrl: "https://chatgpt.com/backend-api",
  defaultApi: "openai-codex-responses",
  authJsonKey: "openai-codex",
  // Luc owns the Codex model catalog. A missing Provider Catalog `models`
  // field uses this list; an explicit [] remains an intentional opt-out.
  models: [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.2",
  ],
  capabilities: {
    chat: {
      runtimeProviderId: "openai-codex",
      displayProviderId: "openai-codex",
      projection: "models-json",
      credentialSource: "auth-storage",
      allowListSource: "provider.models",
    },
    media: {
      imageGeneration: {
        defaultModelId: "gpt-image-2",
        credentialLanes: [
          {
            id: "codex-oauth",
            providerId: "openai-codex-oauth",
            authJsonKey: "openai-codex",
            label: "Codex OAuth",
          },
        ],
        models: [
          {
            id: "gpt-image-2",
            displayName: "GPT Image 2",
            protocolId: "openai-codex-responses-image",
            credentialLaneId: "codex-oauth",
            inputs: ["text", "image"],
            outputs: ["image"],
            supportsEdit: true,
            aliases: ["2", "image-2"],
            modes: [
              mediaMode("text2image", "Text to image", GPT_IMAGE_2_PROPERTIES, GPT_IMAGE_2_DEFAULTS, noReferenceImages()),
              mediaMode("image2image", "Image edit/reference", GPT_IMAGE_2_PROPERTIES, GPT_IMAGE_2_DEFAULTS, referenceImages()),
            ],
            ratios: [...OPENAI_FLEXIBLE_IMAGE_RATIOS],
            resolutions: ["1K", "2K"],
          },
        ],
      },
    },
  },
};
