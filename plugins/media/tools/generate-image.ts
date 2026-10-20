import { t } from "../../../lib/i18n.ts";

export const name = "generate-image";
export const description = t("toolDef.generateImage.description");

export const sessionPermission = {
  kind: "external_side_effect",
  describeSideEffect: (input: any = {}) => ({
    kind: "external_generation",
    summary: `Submit image generation${input.provider ? ` to provider ${input.provider}` : ""}.`,
    ruleId: "media-image-generation",
  }),
};

const sessionFileReference = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["session_file"] },
    fileId: { type: "string" },
  },
  required: ["kind", "fileId"],
  additionalProperties: true,
};

const imageReference = sessionFileReference;

export const parameters = {
  type: "object",
  properties: {
    prompt: { type: "string", description: t("toolDef.generateImage.promptDesc") },
    count: { type: "number", description: t("toolDef.generateImage.countDesc") },
    image: {
      ...imageReference,
      description: "Reference image from the current session, for example { kind: \"session_file\", fileId }.",
    },
    referenceImages: {
      type: "array",
      items: imageReference,
      description: "Reference images from the current session.",
    },
    ratio: { type: "string", description: t("toolDef.generateImage.ratioDesc") },
    resolution: { type: "string", description: t("toolDef.generateImage.resolutionDesc") },
    quality: { type: "string", description: t("toolDef.generateImage.qualityDesc") },
    model: { type: "string", description: t("toolDef.generateImage.modelDesc") },
    mode: { type: "string", description: t("toolDef.generateImage.modeDesc") },
    provider: { type: "string", description: t("toolDef.generateImage.providerDesc") },
    options: {
      type: "object",
      description: "Provider-specific optional generation parameters. Use media option discovery before filling uncommon keys.",
      additionalProperties: true,
    },
    suggestedFilename: { type: "string", description: t("toolDef.generateImage.suggestedFilenameDesc") },
  },
  required: ["prompt"],
};

function present(value) {
  return value !== undefined && value !== null && value !== "";
}

function mediaInput(input: any = {}) {
  return {
    prompt: input.prompt,
    ...(present(input.count) ? { count: input.count } : {}),
    ...(present(input.image) ? { image: input.image } : {}),
    ...(Array.isArray(input.referenceImages) ? { referenceImages: input.referenceImages } : {}),
    ...(present(input.ratio) ? { ratio: input.ratio } : {}),
    ...(present(input.resolution) ? { resolution: input.resolution } : {}),
    ...(present(input.quality) ? { quality: input.quality } : {}),
    ...(present(input.mode) ? { mode: input.mode } : {}),
    ...(present(input.model) ? { model: input.model } : {}),
    ...(present(input.provider) ? { provider: input.provider } : {}),
    ...(input.options && typeof input.options === "object" && !Array.isArray(input.options) ? { options: input.options } : {}),
    ...(present(input.suggestedFilename) ? { suggestedFilename: input.suggestedFilename } : {}),
  };
}

function sessionPayload(ctx: any = {}, input) {
  return {
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    ...(ctx.sessionPath ? { sessionPath: ctx.sessionPath } : {}),
    ...(ctx.sessionRef ? { sessionRef: ctx.sessionRef } : {}),
    input,
    ...(ctx.bridgeContext ? { bridgeContext: ctx.bridgeContext } : {}),
    pluginId: ctx.pluginId || "media",
  };
}

export async function execute(input: any = {}, ctx: any = {}) {
  if (typeof ctx?.bus?.request !== "function") {
    return { content: [{ type: "text", text: t("plugin.imageGen.notInitialized") }] };
  }

  let result;
  try {
    result = await ctx.bus.request("media:generate-image", sessionPayload(ctx, mediaInput(input)));
  } catch (err) {
    return {
      content: [{ type: "text", text: `Image submission failed: ${err?.message || t("plugin.imageGen.unknownError")}` }],
    };
  }

  const tasks = Array.isArray(result?.tasks)
    ? result.tasks.filter((task) => task && typeof task.taskId === "string" && task.taskId)
    : [];
  if (!result?.ok || tasks.length === 0) {
    return {
      content: [{ type: "text", text: `Image submission failed: ${result?.error || t("plugin.imageGen.unknownError")}` }],
    };
  }

  return {
    content: [{ type: "text", text: t("toolDef.generateImage.submitted", { count: tasks.length }) }],
    details: {
      mediaGeneration: {
        kind: "image",
        batchId: result.batchId,
        prompt: result.prompt || input.prompt,
        delivery: result.delivery,
        tasks,
      },
    },
  };
}
