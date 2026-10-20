import { t } from "../../../lib/i18n.ts";

export const name = "generate-video";
export const description = t("toolDef.generateVideo.description");

export const sessionPermission = {
  kind: "external_side_effect",
  describeSideEffect: (input: any = {}) => ({
    kind: "external_generation",
    summary: `Submit video generation${input.provider ? ` to provider ${input.provider}` : ""}.`,
    ruleId: "media-video-generation",
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

export const parameters = {
  type: "object",
  properties: {
    prompt: { type: "string", description: t("toolDef.generateVideo.promptDesc") },
    image: {
      ...sessionFileReference,
      description: "Reference image for image-to-video from the current session, for example { kind: \"session_file\", fileId }.",
    },
    duration: { type: "number", description: t("toolDef.generateVideo.durationDesc") },
    ratio: { type: "string", description: t("toolDef.generateVideo.ratioDesc") },
    resolution: { type: "string", description: "Optional video resolution or provider-specific resolution tier." },
    mode: { type: "string", description: "Advanced mode override such as text2video or image2video. Omit for ordinary generation; the host infers the mode from whether an image is present." },
    model: { type: "string", description: t("toolDef.generateVideo.modelDesc") },
    provider: { type: "string", description: t("toolDef.generateVideo.providerDesc") },
    options: {
      type: "object",
      description: "Advanced provider-specific generation overrides. Omit for ordinary generation; use media option discovery only when uncommon keys are explicitly needed.",
      additionalProperties: true,
    },
  },
  required: ["prompt"],
};

function present(value) {
  return value !== undefined && value !== null && value !== "";
}

function mediaInput(input: any = {}) {
  return {
    prompt: input.prompt,
    ...(present(input.image) ? { image: input.image } : {}),
    ...(present(input.duration) ? { duration: input.duration } : {}),
    ...(present(input.ratio) ? { ratio: input.ratio } : {}),
    ...(present(input.resolution) ? { resolution: input.resolution } : {}),
    ...(present(input.mode) ? { mode: input.mode } : {}),
    ...(present(input.model) ? { model: input.model } : {}),
    ...(present(input.provider) ? { provider: input.provider } : {}),
    ...(input.options && typeof input.options === "object" && !Array.isArray(input.options) ? { options: input.options } : {}),
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
    return { content: [{ type: "text", text: t("toolDef.generateVideo.notInitialized") }] };
  }

  let result;
  try {
    result = await ctx.bus.request("media:generate-video", sessionPayload(ctx, mediaInput(input)));
  } catch (err) {
    return {
      content: [{ type: "text", text: t("toolDef.generateVideo.submitFailed", { error: err?.message || t("plugin.imageGen.unknownError") }) }],
    };
  }

  const tasks = Array.isArray(result?.tasks)
    ? result.tasks.filter((task) => task && typeof task.taskId === "string" && task.taskId)
    : [];
  if (!result?.ok || tasks.length === 0) {
    return {
      content: [{ type: "text", text: t("toolDef.generateVideo.submitFailedUnknown") }],
    };
  }

  return {
    content: [{ type: "text", text: t("toolDef.generateVideo.submitted") }],
    details: {
      mediaGeneration: {
        kind: "video",
        batchId: result.batchId,
        prompt: result.prompt || input.prompt,
        delivery: result.delivery,
        tasks,
      },
    },
  };
}
