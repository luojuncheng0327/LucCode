import {
  MEDIA_GENERATION_GUIDE,
  MEDIA_GENERATION_GUIDE_VERSION,
} from "../lib/generation-guide.ts";

export const name = "get-guide";
export const description = "Return the Luc media generation guide: tool routing, parameter rules, and provider override policy for image and video generation.";

export const promptGuidelines = [
  "Call media_get-guide before your first media_generate-image, media_generate-video, or media_describe-options call in a session.",
  "Media generation is asynchronous: the generation tools return a pending block immediately, and the result appears on its own. Never wait for it and never call stage_files for generated media.",
].join("\n");

export const sessionPermission = { readOnly: true };

export const parameters = {
  type: "object",
  properties: {},
};

export async function execute() {
  return {
    content: [{ type: "text", text: MEDIA_GENERATION_GUIDE }],
    details: { version: MEDIA_GENERATION_GUIDE_VERSION },
  };
}
