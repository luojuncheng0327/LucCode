/**
 * Agnes AI provider plugin.
 *
 * Docs:
 * - Chat: https://agnes-ai.com/doc/agnes-20-flash
 * - Image: https://agnes-ai.com/doc/agnes-image-21-flash
 * - Video: https://agnes-ai.com/doc/agnes-video-v20
 */

import {
  enumParam,
  integerParam,
  mediaMode,
  noReferenceImages,
  referenceImages,
} from "./media-schema-helpers.ts";

const AGNES_IMAGE_RATIOS = ["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16", "21:9"];
const AGNES_VIDEO_RATIOS = ["3:2"];
const AGNES_VIDEO_RESOLUTIONS = ["720p"];

const AGNES_IMAGE_PROPERTIES = {
  ratio: enumParam(AGNES_IMAGE_RATIOS, "3:2"),
  resolution: enumParam(["1K"], "1K"),
};
const AGNES_IMAGE_DEFAULTS = { ratio: "3:2", resolution: "1K" };

const AGNES_VIDEO_PROPERTIES = {
  ratio: enumParam(AGNES_VIDEO_RATIOS, "3:2"),
  video_resolution: enumParam(AGNES_VIDEO_RESOLUTIONS, "720p"),
  duration: integerParam({ minimum: 3, maximum: 18, defaultValue: 5 }),
  frame_rate: integerParam({ minimum: 1, maximum: 60, defaultValue: 24 }),
  num_frames: integerParam({ minimum: 81, maximum: 441 }),
};
const AGNES_VIDEO_DEFAULTS = { ratio: "3:2", video_resolution: "720p", duration: 5, frame_rate: 24 };

/** @type {import('../../core/provider-registry.ts').ProviderPlugin} */
export const agnesPlugin = {
  id: "agnes",
  displayName: "Agnes AI",
  authType: "api-key",
  defaultBaseUrl: "https://apihub.agnes-ai.com/v1",
  defaultApi: "openai-completions",
  capabilities: {
    media: {
      imageGeneration: {
        defaultModelId: "agnes-image-2.1-flash",
        models: [
          {
            id: "agnes-image-2.1-flash",
            displayName: "Agnes Image 2.1 Flash",
            protocolId: "agnes-images",
            inputs: ["text", "image"],
            outputs: ["image"],
            supportsEdit: true,
            modes: [
              mediaMode("text2image", "Text to image", AGNES_IMAGE_PROPERTIES, AGNES_IMAGE_DEFAULTS, noReferenceImages()),
              mediaMode("image2image", "Image edit/reference", AGNES_IMAGE_PROPERTIES, AGNES_IMAGE_DEFAULTS, referenceImages()),
            ],
            ratios: AGNES_IMAGE_RATIOS,
            resolutions: ["1K"],
          },
        ],
      },
      videoGeneration: {
        defaultModelId: "agnes-video-v2.0",
        models: [
          {
            id: "agnes-video-v2.0",
            displayName: "Agnes Video V2.0",
            protocolId: "agnes-videos",
            inputs: ["text", "image"],
            outputs: ["video"],
            supportsAsync: true,
            modes: [
              mediaMode("text2video", "Text to video", AGNES_VIDEO_PROPERTIES, AGNES_VIDEO_DEFAULTS, noReferenceImages()),
              mediaMode("image2video", "Image to video", AGNES_VIDEO_PROPERTIES, AGNES_VIDEO_DEFAULTS, referenceImages({ max: 1 })),
              mediaMode("multiframe2video", "Multi-image to video", AGNES_VIDEO_PROPERTIES, AGNES_VIDEO_DEFAULTS, referenceImages({ min: 2 })),
            ],
            ratios: AGNES_VIDEO_RATIOS,
            resolutions: AGNES_VIDEO_RESOLUTIONS,
          },
        ],
      },
    },
  },
};
