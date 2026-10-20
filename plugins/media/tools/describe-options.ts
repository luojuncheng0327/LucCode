import { inferMediaMode } from "../../../core/media/media-parameters.ts";

export const name = "describe-options";
export const description = "Describe optional advanced image/video provider, model, mode, and parameter overrides. The returned candidates are not a required menu; ordinary generation should omit provider and model so the host resolves them.";

export const sessionPermission = { readOnly: true };

export const parameters = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: ["image", "video"],
      description: "Media kind to inspect.",
    },
    provider: {
      type: "string",
      description: "Optional provider id to inspect, for example jimeng-cli. Omit to inspect all advanced override candidates; generation does not require choosing one.",
    },
    model: {
      type: "string",
      description: "Optional model id within the provider to inspect. This is an advanced override, not a required generation parameter.",
    },
    mode: {
      type: "string",
      description: "Optional generation mode such as text2video, image2video, text2image, or image2image.",
    },
  },
  required: ["kind"],
};

function capabilityForKind(kind) {
  return kind === "video" ? "video_generation" : "image_generation";
}

function compactModel(model: any = {}) {
  return {
    id: model.id,
    name: model.displayName || model.name || model.id,
    inputs: model.inputs || [],
    outputs: model.outputs || [],
    supportsEdit: !!model.supportsEdit,
    inputLimits: model.inputLimits || null,
    modes: Array.isArray(model.modes)
      ? model.modes.map((mode) => ({
        id: mode.id,
        label: mode.label || mode.id,
        inputLimits: mode.inputLimits || null,
      }))
      : [],
  };
}

function describeSelection(selection: any) {
  const defaultConfigured = typeof selection?.defaultConfigured === "boolean"
    ? selection.defaultConfigured
    : null;
  const selectionPolicy = selection?.selectionPolicy === "configured_default"
    || selection?.selectionPolicy === "first_available_fallback"
    ? selection.selectionPolicy
    : "host_resolved";
  return {
    defaultConfigured,
    selectionPolicy,
    overrideRequired: false,
    defaultInvocation: {
      provider: "omit",
      model: "omit",
      mode: "omit_unless_needed",
      options: "omit_unless_needed",
    },
    instruction: typeof selection?.instruction === "string" && selection.instruction.trim()
      ? selection.instruction
      : "These providers and models are optional advanced overrides, not a required menu. For ordinary generation, omit provider and model so the host resolves its configured default or fallback.",
  };
}

export async function execute(input: any = {}, ctx: any = {}) {
  const kind = input.kind === "video" ? "video" : "image";
  const capability = capabilityForKind(kind);
  const result = await ctx.bus?.request?.("provider:media-providers", { capability });
  const providers = result?.providers && typeof result.providers === "object" ? result.providers : {};
  const selection = describeSelection(result?.selection);
  const providerIds = Object.keys(providers);
  if (!input.provider) {
    const summary = {
      kind,
      selection,
      providers: providerIds.map((providerId) => ({
        providerId,
        displayName: providers[providerId].displayName || providerId,
        models: (providers[providerId].models || []).map(compactModel),
      })),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      details: { mediaOptions: summary },
    };
  }

  const provider = providers[input.provider];
  if (!provider) {
    const summary = { kind, selection, providers: providerIds };
    return {
      content: [{ type: "text", text: `Media provider not found: ${input.provider}\n${selection.instruction}` }],
      details: { mediaOptions: summary },
    };
  }

  const models = provider.models || [];
  const model = input.model
    ? models.find((item) => item.id === input.model || item.aliases?.includes?.(input.model))
    : models[0];
  if (!model) {
    const summary = { kind, selection, providerId: input.provider, models: models.map(compactModel) };
    return {
      content: [{ type: "text", text: `Media model not found for provider: ${input.provider}\n${selection.instruction}` }],
      details: { mediaOptions: summary },
    };
  }

  const modeId = input.mode || inferMediaMode(kind, {});
  const modes = Array.isArray(model.modes) ? model.modes : [];
  const mode = modes.find((item) => item.id === modeId) || modes[0] || null;
  const summary = {
    kind,
    selection,
    providerId: input.provider,
    providerName: provider.displayName || input.provider,
    model: compactModel(model),
    mode: mode ? {
      id: mode.id,
      label: mode.label || mode.id,
      parameterSchema: mode.parameterSchema || model.parameterSchema || null,
      defaults: mode.defaults || {},
      inputLimits: mode.inputLimits || model.inputLimits || null,
      pricing: mode.pricing || model.pricing || null,
      agentHints: mode.agentHints || model.agentHints || null,
    } : null,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
    details: { mediaOptions: summary },
  };
}
