/**
 * Volcengine (火山引擎 / 豆包) provider plugin
 *
 * 注意：火山引擎的 model ID 实际是用户在控制台创建的 endpoint ID（如 ep-xxxxxx），
 * 不是标准模型名，故无默认模型列表，用户需通过设置页手动配置。
 *
 * 文档：https://www.volcengine.com/docs/82379/1399008
 */

import {
  COMMON_IMAGE_RATIOS,
  booleanParam,
  enumParam,
  integerParam,
  mediaMode,
  noReferenceImages,
  numberParam,
  referenceImages,
} from "./media-schema-helpers.ts";

const SEEDREAM_DEFAULT_RATIO = "3:2";

function seedreamBaseProperties(resolutions) {
  return {
    ratio: enumParam(COMMON_IMAGE_RATIOS, SEEDREAM_DEFAULT_RATIO),
    resolution: enumParam(resolutions, resolutions[resolutions.length - 1]),
    watermark: booleanParam(false),
  };
}

function seedreamDefaults(resolutions) {
  return {
    ratio: SEEDREAM_DEFAULT_RATIO,
    resolution: resolutions[resolutions.length - 1],
  };
}

const SEEDREAM_3_RESOLUTIONS = ["1K"];
const SEEDREAM_REFERENCE_RESOLUTIONS = ["1K", "2K", "4K"];

const SEEDREAM_3_PROPERTIES = {
  ...seedreamBaseProperties(SEEDREAM_3_RESOLUTIONS),
  guidance_scale: numberParam({ minimum: 1, maximum: 10 }),
  seed: integerParam({ minimum: 0, maximum: 2147483647 }),
};

const SEEDREAM_5_PROPERTIES = {
  ...seedreamBaseProperties(SEEDREAM_REFERENCE_RESOLUTIONS),
  format: enumParam(["jpeg", "png"], "jpeg"),
};

const SEEDREAM_REFERENCE_PROPERTIES = seedreamBaseProperties(SEEDREAM_REFERENCE_RESOLUTIONS);

function seedreamTextOnlyModel(id, displayName, aliases) {
  return {
    id,
    displayName,
    protocolId: "volcengine-images",
    inputs: ["text"],
    outputs: ["image"],
    aliases,
    modes: [
      mediaMode("text2image", "文生图", SEEDREAM_3_PROPERTIES, seedreamDefaults(SEEDREAM_3_RESOLUTIONS), noReferenceImages()),
    ],
    ratios: [...COMMON_IMAGE_RATIOS],
    resolutions: SEEDREAM_3_RESOLUTIONS,
  };
}

function seedreamReferenceModel(id, displayName, aliases, properties = SEEDREAM_REFERENCE_PROPERTIES) {
  return {
    id,
    displayName,
    protocolId: "volcengine-images",
    inputs: ["text", "image"],
    outputs: ["image"],
    aliases,
    supportsEdit: true,
    modes: [
      mediaMode("text2image", "文生图", properties, seedreamDefaults(SEEDREAM_REFERENCE_RESOLUTIONS), noReferenceImages()),
      mediaMode("image2image", "参考图生图", properties, seedreamDefaults(SEEDREAM_REFERENCE_RESOLUTIONS), referenceImages()),
    ],
    ratios: [...COMMON_IMAGE_RATIOS],
    resolutions: SEEDREAM_REFERENCE_RESOLUTIONS,
  };
}

/** @type {import('../../core/provider-registry.ts').ProviderPlugin} */
export const volcenginePlugin = {
  id: "volcengine",
  displayName: "火山引擎 (豆包)",
  authType: "api-key",
  defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  defaultApi: "openai-completions",
  capabilities: {
    media: {
      imageGeneration: {
        defaultModelId: "doubao-seedream-5-0-lite-260128",
        credentialLanes: [
          {
            id: "volcengine",
            providerId: "volcengine",
            label: "火山引擎 API Key",
          },
          {
            id: "volcengine-coding",
            providerId: "volcengine-coding",
            label: "火山引擎 Coding Plan",
          },
        ],
        models: [
          seedreamTextOnlyModel("doubao-seedream-3-0-t2i", "Seedream 3.0", ["3.0"]),
          seedreamReferenceModel("doubao-seedream-4-0-250828", "Seedream 4.0", ["4.0"]),
          seedreamReferenceModel("doubao-seedream-4-5-251128", "Seedream 4.5", ["4.5"]),
          seedreamReferenceModel("doubao-seedream-5-0-lite-260128", "Seedream 5.0 Lite", ["5.0-lite"], SEEDREAM_5_PROPERTIES),
          seedreamReferenceModel("doubao-seedream-5-0-260128", "Seedream 5.0", ["5.0"], SEEDREAM_5_PROPERTIES),
        ],
      },
    },
  },
};
