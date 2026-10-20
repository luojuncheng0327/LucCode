function lower(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getApi(model: any, context: any = {}) {
  return lower(model?.api || context.api);
}

function getProvider(model: any, context: any = {}) {
  return lower(model?.provider || context.provider);
}

function getBaseUrl(model: any, context: any = {}) {
  return lower(model?.baseUrl || model?.base_url || context.baseUrl || context.base_url);
}

function getBaseHost(model: any, context: any = {}) {
  const raw = model?.baseUrl || model?.base_url || context.baseUrl || context.base_url;
  if (typeof raw !== "string" || raw.length === 0) return "";
  const text = raw.trim();
  try {
    return new URL(text).hostname.toLowerCase();
  } catch {
    try {
      return new URL(`https://${text}`).hostname.toLowerCase();
    } catch {
      return lower(text).split(/[/?#]/)[0].replace(/:\d+$/, "");
    }
  }
}

function getModelId(model: any, context: any = {}) {
  return lower(model?.id || context.id || context.modelId || context.model);
}

function getModelText(model: any, context: any = {}) {
  return [
    model?.id,
    model?.name,
    model?.model,
    model?.modelId,
    context.id,
    context.name,
    context.model,
    context.modelId,
  ].map(lower).filter(Boolean).join(" ");
}

function normalizeBoolean(value: unknown): boolean {
  return value === true;
}

/**
 * DeepSeek 官方 endpoint 的 provider id。一个厂商多条协议通道各占一个 provider id
 * （同 zhipu / zhipu-coding 的先例），新增通道时显式登记，不按前缀猜。
 */
const OFFICIAL_DEEPSEEK_PROVIDERS = new Set([
  "deepseek",
  "deepseek-responses",
]);

/**
 * 是否为 DeepSeek 官方 endpoint，不区分协议通道。
 *
 * 与 provider-compat 的 `isDeepSeekModel`（只认 ChatCompletions 兼容路径）互补：
 * 需要覆盖 DeepSeek 全部通道的关注点（可观测性、成本归属）用这个。
 */
export function isOfficialDeepSeekEndpoint(model: any, context: any = {}) {
  return OFFICIAL_DEEPSEEK_PROVIDERS.has(getProvider(model, context))
    || getBaseUrl(model, context).includes("api.deepseek.com");
}

function isOpenRouterEndpoint(model: any, context: any = {}) {
  if (getProvider(model, context) === "openrouter") return true;
  const host = getBaseHost(model, context);
  return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
}

const OFFICIAL_MIMO_PROVIDERS = new Set([
  "mimo",
  "mimo-token-plan",
  "xiaomi",
  "xiaomi-token",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-sgp",
  "xiaomi-token-plan-cn-ams",
  "xiaomi-token-plan-sgp-ams",
]);

const MODEL_THINKING_FORMATS = new Set([
  "anthropic",
  "qwen",
  "qwen-chat-template",
  "zhipu",
  "deepseek",
  "openrouter",
  "kimi",
  "volcengine",
  "longcat",
]);

const MODEL_REASONING_PROFILES = new Set([
  "anthropic-adaptive-only",
  "deepseek-v4-anthropic",
  "deepseek-v4-openai",
  "deepseek-v4-responses",
  "mimo-openai",
  "openrouter-anthropic-adaptive",
  "zhipu-openai",
  "kimi-openai",
]);

const TOOL_USE_DIALECTS = new Set([
  "openai",
  "anthropic",
  "gemini",
  "mistral",
  "none",
]);

const TOOL_RESULT_FORMATS = new Set([
  "message",
  "content_block",
  "part",
]);

const OUTPUT_CAP_FIELDS = new Set([
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
  "maxOutputTokens",
]);

const REASONING_REPLAY_POLICIES = new Set([
  "none",
  "preserve",
  "require-tool-call",
]);

const REASONING_REPLAY_CARRIERS = new Set([
  "reasoning_content",
  "reasoning_details",
  "thinking_blocks",
  "reasoning_items",
  "thought_signature",
]);

export function normalizeReasoningReplayContract(value: any): Record<string, any> | null {
  if (!isPlainObject(value)) return null;
  const policy = lower(value.policy);
  if (!REASONING_REPLAY_POLICIES.has(policy)) return null;
  if (policy === "none") return { policy: "none" };

  const carrier = lower(value.carrier);
  if (!REASONING_REPLAY_CARRIERS.has(carrier)) return null;
  const out: Record<string, any> = { carrier, policy };
  if (value.clearable === true) out.clearable = true;
  return out;
}

export function normalizeModelProtocolCompat(value: any): Record<string, any> | null {
  if (!isPlainObject(value)) return null;
  const out: Record<string, any> = {};

  const thinkingFormat = lower(value.thinkingFormat);
  if (MODEL_THINKING_FORMATS.has(thinkingFormat)) {
    out.thinkingFormat = thinkingFormat;
  }

  const reasoningProfile = lower(value.reasoningProfile || value.thinkingProfile);
  if (MODEL_REASONING_PROFILES.has(reasoningProfile)) {
    out.reasoningProfile = reasoningProfile;
  }

  if (value.lucVideoInput === true) out.lucVideoInput = true;
  if (value.lucAudioInput === true) out.lucAudioInput = true;
  if (value.outputCapRequired === true) out.outputCapRequired = true;
  if (typeof value.outputCapField === "string" && OUTPUT_CAP_FIELDS.has(value.outputCapField)) {
    out.outputCapField = value.outputCapField;
  }

  if (Object.prototype.hasOwnProperty.call(value, "reasoningReplay")) {
    const reasoningReplay = normalizeReasoningReplayContract(value.reasoningReplay);
    if (reasoningReplay) out.reasoningReplay = reasoningReplay;
  }
  if (typeof value.requiresReasoningContentOnAssistantMessages === "boolean") {
    out.requiresReasoningContentOnAssistantMessages = value.requiresReasoningContentOnAssistantMessages;
  }

  return Object.keys(out).length > 0 ? out : null;
}

export function normalizeToolUseContract(value: any): Record<string, any> | null {
  if (!isPlainObject(value)) return null;
  if (typeof value.supportsTools !== "boolean") return null;

  const dialect = lower(value.dialect);
  if (!TOOL_USE_DIALECTS.has(dialect)) return null;
  const toolResultFormat = lower(value.toolResultFormat);
  if (!TOOL_RESULT_FORMATS.has(toolResultFormat)) return null;

  const out: Record<string, any> = {
    supportsTools: value.supportsTools,
    dialect,
    toolResultFormat,
  };
  if (typeof value.supportsParallelToolCalls === "boolean") {
    out.supportsParallelToolCalls = value.supportsParallelToolCalls;
  }
  if (typeof value.supportsForcedToolChoice === "boolean") {
    out.supportsForcedToolChoice = value.supportsForcedToolChoice;
  }
  if (typeof value.supportsServerTools === "boolean") {
    out.supportsServerTools = value.supportsServerTools;
  }
  return out;
}

export function isOfficialMimoEndpoint(model: any, context: any = {}) {
  const provider = getProvider(model, context);
  if (OFFICIAL_MIMO_PROVIDERS.has(provider)) return true;

  const host = getBaseHost(model, context);
  return host === "xiaomimimo.com" || host.endsWith(".xiaomimimo.com");
}

function isOfficialZhipuEndpoint(model: any, context: any = {}) {
  const provider = getProvider(model, context);
  if (provider === "zhipu") return true;

  const host = getBaseHost(model, context);
  const baseUrl = getBaseUrl(model, context);
  return host === "open.bigmodel.cn"
    || host.endsWith(".open.bigmodel.cn")
    || (
      host === "api.z.ai"
      && (
        baseUrl.includes("/api/paas/v4")
        || baseUrl.includes("/api/coding/paas/v4")
      )
    );
}

function isDeepSeekV4ModelId(id: string): boolean {
  return id === "deepseek-v4" || id.startsWith("deepseek-v4-") || id.startsWith("deepseek-v4.");
}

function isAnthropicAdaptiveOnlyModelId(id: string): boolean {
  return id === "claude-opus-5"
    || id === "claude-sonnet-5"
    || id === "claude-fable-5"
    || id === "claude-mythos-5"
    || id === "anthropic/claude-opus-5"
    || id === "anthropic/claude-sonnet-5"
    || id === "anthropic/claude-fable-5"
    || id === "anthropic/claude-mythos-5";
}

function isDeepSeekThinkingModelId(id: string): boolean {
  return id === "deepseek-reasoner" || isDeepSeekV4ModelId(id);
}

function isOpenAIReasoningApi(model: any, context: any = {}) {
  const api = getApi(model, context);
  return api === "openai-completions" || api === "openai-responses" || api === "";
}

function isOfficialKimiOpenAIEndpoint(model: any, context: any = {}) {
  if (!isOpenAIReasoningApi(model, context)) return false;

  const provider = getProvider(model, context);
  if (provider === "kimi-coding" || provider === "moonshot") return true;

  const host = getBaseHost(model, context);
  const baseUrl = getBaseUrl(model, context);
  return (
    host === "api.kimi.com"
    && baseUrl.includes("/coding/v1")
  ) || host === "api.moonshot.cn";
}

function isKimiCodingEndpoint(model: any, context: any = {}) {
  if (!isOpenAIReasoningApi(model, context)) return false;
  if (getProvider(model, context) === "kimi-coding") return true;
  const host = getBaseHost(model, context);
  return host === "api.kimi.com" && getBaseUrl(model, context).includes("/coding/v1");
}

function isOfficialVolcengineEndpoint(model: any, context: any = {}) {
  if (!isOpenAIReasoningApi(model, context)) return false;

  const provider = getProvider(model, context);
  if (provider === "volcengine" || provider === "volcengine-coding") return true;

  const host = getBaseHost(model, context);
  return host === "ark.cn-beijing.volces.com" || host.endsWith(".volces.com");
}

function isMimoFamilyModel(model: any, context: any = {}) {
  const text = getModelText(model, context);
  if (!/\bmimo[-_]?v\d/.test(text)) return false;
  return !/\bmimo[-_]?v\d+(?:[._-]\d+)?[-_]tts\b/.test(text);
}

function isMimoOpenAIProtocolModel(model: any, context: any = {}) {
  if (!isOpenAIReasoningApi(model, context)) return false;
  if (isOpenRouterEndpoint(model, context)) return false;
  if (isOfficialDeepSeekEndpoint(model, context) || isOfficialZhipuEndpoint(model, context)) return false;
  return isMimoFamilyModel(model, context);
}

export function isDeepSeekFamilyModel(model: any, context: any = {}) {
  if (!isPlainObject(model)) return false;
  const provider = getProvider(model, context);
  const baseUrl = getBaseUrl(model, context);
  const text = getModelText(model, context);
  return provider === "deepseek"
    || provider.includes("deepseek")
    || baseUrl.includes("api.deepseek.com")
    || text.includes("deepseek-ai/")
    || text.includes("deepseek/")
    || text.includes("deepseek-");
}

export function isDeepSeekReasoningModel(model: any, context: any = {}) {
  if (!isDeepSeekFamilyModel(model, context)) return false;
  if (model.reasoning === true) return true;
  if (getThinkingFormat(model, context) || getReasoningProfile(model, context)) return true;

  const text = getModelText(model, context);
  return text.includes("deepseek-reasoner")
    || text.includes("deepseek-r1")
    || text.includes("deepseek-v4");
}

/**
 * Resolve the request-side thinking control format declared by a model.
 *
 * Precedence:
 *   1. Explicit model.compat.thinkingFormat
 *   2. Protocol quirks projected from known-models.json
 *   3. Legacy/runtime derivation for pre-existing models.json entries
 */
export function getThinkingFormat(model: any, context: any = {}) {
  if (!isPlainObject(model)) return null;

  const explicit = lower(model.compat?.thinkingFormat);
  if (explicit) return explicit;

  const quirks = Array.isArray(model.quirks) ? model.quirks : [];
  if (quirks.includes("enable_thinking")) return "qwen";

  const api = getApi(model, context);
  const provider = getProvider(model, context);
  const modelId = getModelId(model, context);

  // New models.json entries should carry compat.thinkingFormat. This branch keeps
  // already-projected runtime model objects working until the next provider sync.
  if (model.reasoning === true && api === "anthropic-messages") {
    return "anthropic";
  }

  // Built-in Anthropic models may arrive without Luc's projected compat object.
  if (provider === "anthropic" && model.reasoning !== false) {
    return "anthropic";
  }

  if (
    isOpenRouterEndpoint(model, context)
    && model.reasoning === true
    && (api === "openai-completions" || api === "")
  ) {
    return "openrouter";
  }

  if (isOfficialKimiOpenAIEndpoint(model, context) && model.reasoning === true) {
    return "kimi";
  }

  if (isOfficialVolcengineEndpoint(model, context) && model.reasoning === true) {
    return "volcengine";
  }

  // DeepSeek 的 thinking / reasoning_effort / max_tokens 字段族只存在于官方
  // ChatCompletions 通道。Anthropic 通道在本函数更前面的分支已经返回，Responses
  // 通道用的是 OpenAI Responses 的 reasoning item 语义，不属于这个 wire 家族。
  if (
    isOfficialDeepSeekEndpoint(model, context)
    && (model.reasoning === true || isDeepSeekThinkingModelId(modelId))
    && (api === "openai-completions" || api === "")
  ) {
    return "deepseek";
  }

  if (isOfficialMimoEndpoint(model, context) && model.reasoning === true) {
    return "qwen-chat-template";
  }

  if (
    isOfficialZhipuEndpoint(model, context)
    && model.reasoning === true
    && (api === "openai-completions" || api === "openai-responses" || api === "")
  ) {
    return "zhipu";
  }

  if (isMimoOpenAIProtocolModel(model, context)) {
    return "qwen-chat-template";
  }

  return null;
}

/**
 * Resolve the narrower provider/model reasoning profile.
 *
 * thinkingFormat answers "what wire family does the request body use";
 * reasoningProfile answers "which provider-specific effort/replay contract
 * applies inside that wire family".
 */
export function getReasoningProfile(model: any, context: any = {}) {
  if (!isPlainObject(model)) return null;

  const explicit = lower(model.compat?.reasoningProfile || model.compat?.thinkingProfile);
  if (explicit) return explicit;

  const modelId = getModelId(model, context);

  if (isOpenRouterEndpoint(model, context)) {
    if (model.reasoning === true && isAnthropicAdaptiveOnlyModelId(modelId)) {
      return "openrouter-anthropic-adaptive";
    }
    return null;
  }

  if (
    model.reasoning === true
    && isAnthropicAdaptiveOnlyModelId(modelId)
    && getThinkingFormat(model, context) === "anthropic"
  ) {
    return "anthropic-adaptive-only";
  }

  if (isOfficialMimoEndpoint(model, context) && model.reasoning === true) {
    const api = getApi(model, context);
    if (api === "openai-completions" || api === "openai-responses" || api === "") {
      return "mimo-openai";
    }
  }

  if (isOfficialZhipuEndpoint(model, context) && model.reasoning === true) {
    const api = getApi(model, context);
    if (api === "openai-completions" || api === "openai-responses" || api === "") {
      return "zhipu-openai";
    }
  }

  if (isOfficialKimiOpenAIEndpoint(model, context) && model.reasoning === true) {
    return "kimi-openai";
  }

  if (isOfficialDeepSeekEndpoint(model, context)) {
    if (!isDeepSeekV4ModelId(modelId)) return null;

    const api = getApi(model, context);
    if (api === "anthropic-messages") return "deepseek-v4-anthropic";
    if (api === "openai-responses") return "deepseek-v4-responses";
    if (api === "openai-completions" || api === "") {
      return "deepseek-v4-openai";
    }
  }

  return isMimoOpenAIProtocolModel(model, context) ? "mimo-openai" : null;
}

/**
 * Endpoint-level reasoning defaults are intentionally narrow. They are used
 * only when a provider catalog entry did not declare `reasoning` and known
 * model metadata has no answer. Explicit model metadata always wins.
 */
export function getEndpointDefaultReasoningCapability(model: any, context: any = {}) {
  if (!isPlainObject(model)) return null;
  return isKimiCodingEndpoint(model, context) ? true : null;
}

/**
 * Resolve how assistant reasoning state must be replayed on the wire.
 *
 * The contract describes protocol semantics, not the SDK currently executing
 * the turn. Explicit model compat is authoritative, including `policy:none`.
 * Inference is limited to protocol/profile facts that are stable without a
 * model-id allowlist.
 */
export function getReasoningReplayContract(model: any, context: any = {}) {
  if (!isPlainObject(model)) return null;

  if (isPlainObject(model.compat)
    && Object.prototype.hasOwnProperty.call(model.compat, "reasoningReplay")) {
    return normalizeReasoningReplayContract(model.compat.reasoningReplay);
  }
  if (model.reasoning === false) return null;

  const api = getApi(model, context);
  const profile = getReasoningProfile(model, context);
  const format = getThinkingFormat(model, context);

  if (profile === "deepseek-v4-anthropic") {
    return { carrier: "thinking_blocks", policy: "preserve" };
  }
  // Responses 协议原生保留思考链（reasoning item），不需要 ChatCompletions 那套
  // reasoning_content 回填与 fail-closed 校验。
  if (profile === "deepseek-v4-responses") {
    return { carrier: "reasoning_items", policy: "preserve" };
  }
  if (
    profile === "deepseek-v4-openai"
    || profile === "mimo-openai"
    || profile === "kimi-openai"
  ) {
    return { carrier: "reasoning_content", policy: "require-tool-call" };
  }
  if (profile === "zhipu-openai") {
    return { carrier: "reasoning_content", policy: "require-tool-call", clearable: true };
  }

  if (format === "anthropic") {
    return { carrier: "thinking_blocks", policy: "preserve" };
  }
  if (format === "openrouter") {
    return { carrier: "reasoning_details", policy: "preserve" };
  }
  if (format === "deepseek" || format === "kimi") {
    return { carrier: "reasoning_content", policy: "require-tool-call" };
  }
  if (format === "zhipu") {
    return { carrier: "reasoning_content", policy: "require-tool-call", clearable: true };
  }

  if (api === "openai-responses" || api === "openai-codex-responses") {
    return model.reasoning === true
      ? { carrier: "reasoning_items", policy: "preserve" }
      : null;
  }
  if (api === "google-generative-ai") {
    return model.reasoning === true
      ? { carrier: "thought_signature", policy: "preserve" }
      : null;
  }

  return null;
}

function sameReasoningReplayContract(left: any, right: any) {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.policy === right.policy
    && left.carrier === right.carrier
    && left.clearable === right.clearable;
}

export function withThinkingFormatCompat(model: any, context: any = {}) {
  if (!isPlainObject(model)) return model;

  const format = getThinkingFormat(model, context);
  const profile = getReasoningProfile(model, context);
  const reasoningReplay = getReasoningReplayContract(model, context);
  if (!format && !profile && !reasoningReplay) return model;

  const compat = isPlainObject(model.compat) ? model.compat : {};
  const existingReplay = Object.prototype.hasOwnProperty.call(compat, "reasoningReplay")
    ? normalizeReasoningReplayContract(compat.reasoningReplay)
    : null;
  const needsKimiEmptyReplayMarker = format === "kimi"
    && reasoningReplay?.carrier === "reasoning_content"
    && reasoningReplay.policy !== "none"
    && compat.requiresReasoningContentOnAssistantMessages === undefined;
  if (
    (!format || lower(compat.thinkingFormat) === format)
    && (!profile || lower(compat.reasoningProfile) === profile)
    && (!reasoningReplay || sameReasoningReplayContract(existingReplay, reasoningReplay))
    && !needsKimiEmptyReplayMarker
  ) {
    return model;
  }

  return {
    ...model,
    compat: {
      ...compat,
      ...(format ? { thinkingFormat: format } : {}),
      ...(profile ? { reasoningProfile: profile } : {}),
      ...(reasoningReplay ? { reasoningReplay } : {}),
      ...(needsKimiEmptyReplayMarker ? { requiresReasoningContentOnAssistantMessages: true } : {}),
    },
  };
}

export const MODEL_IMAGE_TRANSPORTS = Object.freeze({
  NONE: "none",
  OPENAI_IMAGE_URL: "openai-image-url",
  OPENAI_INPUT_IMAGE: "openai-input-image",
  ANTHROPIC_IMAGE: "anthropic-image",
});

export function modelSupportsImageInput(model: any): boolean {
  if (!isPlainObject(model)) return false;
  return Array.isArray(model.input) && model.input.includes("image");
}

export function resolveModelImageInputTransport(model: any, context: any = {}) {
  if (!modelSupportsImageInput(model)) return MODEL_IMAGE_TRANSPORTS.NONE;

  const api = getApi(model, context);
  if (api === "anthropic-messages") return MODEL_IMAGE_TRANSPORTS.ANTHROPIC_IMAGE;
  if (api === "openai-responses" || api === "openai-codex-responses") {
    return MODEL_IMAGE_TRANSPORTS.OPENAI_INPUT_IMAGE;
  }

  return MODEL_IMAGE_TRANSPORTS.OPENAI_IMAGE_URL;
}

export function modelSupportsDirectImageInput(model: any, context: any = {}) {
  const transport = resolveModelImageInputTransport(model, context);
  return transport !== MODEL_IMAGE_TRANSPORTS.NONE;
}

export function modelSupportsVideoInput(model: any): boolean {
  if (!isPlainObject(model)) return false;
  if (model.video === true) return true;
  if (model.compat?.lucVideoInput === true) return true;

  // Legacy runtime objects created before Pi SDK tightened models.json input
  // validation may still carry video in input. Read it for compatibility, but
  // model-sync/migrations must not write it back to Pi-facing JSON.
  return Array.isArray(model.input) && model.input.includes("video");
}

export function modelSupportsAudioInput(model: any): boolean {
  if (!isPlainObject(model)) return false;
  if (model.audio === true) return true;
  if (model.compat?.lucAudioInput === true) return true;
  if (isOfficialMimoAudioInputModel(model)) return true;

  // Legacy/runtime objects may carry audio in input once upstream SDKs allow it.
  return Array.isArray(model.input) && model.input.includes("audio");
}

export const MODEL_AUDIO_TRANSPORTS = Object.freeze({
  NONE: "none",
  MIMO_INPUT_AUDIO: "mimo-input-audio",
  OPENAI_INPUT_AUDIO: "openai-input-audio",
  UNSUPPORTED: "unsupported",
});

export function resolveModelAudioInputTransport(model: any, context: any = {}) {
  if (!modelSupportsAudioInput(model)) return MODEL_AUDIO_TRANSPORTS.NONE;

  const explicit = lower(model?.compat?.audioTransport || model?.compat?.lucAudioTransport);
  if (explicit) {
    if ((Object.values(MODEL_AUDIO_TRANSPORTS) as string[]).includes(explicit)) return explicit;
    return MODEL_AUDIO_TRANSPORTS.UNSUPPORTED;
  }

  if (isOfficialMimoAudioInputModel(model, context)) {
    return MODEL_AUDIO_TRANSPORTS.MIMO_INPUT_AUDIO;
  }

  const api = getApi(model, context);
  const provider = getProvider(model, context);
  if (api === "openai-completions" && provider === "openai") {
    return MODEL_AUDIO_TRANSPORTS.OPENAI_INPUT_AUDIO;
  }

  return MODEL_AUDIO_TRANSPORTS.UNSUPPORTED;
}

export function modelSupportsDirectAudioInput(model: any, context: any = {}) {
  const transport = resolveModelAudioInputTransport(model, context);
  return transport === MODEL_AUDIO_TRANSPORTS.MIMO_INPUT_AUDIO
    || transport === MODEL_AUDIO_TRANSPORTS.OPENAI_INPUT_AUDIO;
}

function isOfficialMimoAudioInputModel(model: any, context: any = {}) {
  if (!isOfficialMimoEndpoint(model, context)) return false;
  const id = getModelId(model, context);
  return id === "mimo-v2.5" || id === "mimo-v2-omni";
}

export const MODEL_VIDEO_TRANSPORTS = Object.freeze({
  NONE: "none",
  GEMINI_INLINE_DATA: "gemini-inline-data",
  OPENAI_VIDEO_URL: "openai-video-url",
  UNSUPPORTED: "unsupported",
});

export function resolveModelVideoInputTransport(model: any, context: any = {}) {
  if (!modelSupportsVideoInput(model)) return MODEL_VIDEO_TRANSPORTS.NONE;

  const api = getApi(model, context);
  if (api === "google-generative-ai") {
    return MODEL_VIDEO_TRANSPORTS.GEMINI_INLINE_DATA;
  }

  if (api === "openai-completions" && usesOpenAiVideoUrlTransport(model, context)) {
    return MODEL_VIDEO_TRANSPORTS.OPENAI_VIDEO_URL;
  }

  return MODEL_VIDEO_TRANSPORTS.UNSUPPORTED;
}

export function modelSupportsDirectVideoInput(model: any, context: any = {}) {
  const transport = resolveModelVideoInputTransport(model, context);
  return transport === MODEL_VIDEO_TRANSPORTS.GEMINI_INLINE_DATA
    || transport === MODEL_VIDEO_TRANSPORTS.OPENAI_VIDEO_URL;
}

function usesOpenAiVideoUrlTransport(model: any, context: any = {}) {
  return isDashScopeEndpoint(model, context)
    || isMoonshotEndpoint(model, context)
    || isOfficialMimoEndpoint(model, context);
}

function isDashScopeEndpoint(model: any, context: any = {}) {
  const provider = getProvider(model, context);
  const baseUrl = getBaseUrl(model, context);
  return provider === "dashscope"
    || provider === "dashscope-coding"
    || baseUrl.includes("dashscope");
}

function isMoonshotEndpoint(model: any, context: any = {}) {
  const provider = getProvider(model, context);
  const baseUrl = getBaseUrl(model, context);
  return provider === "moonshot"
    || provider === "kimi"
    || baseUrl.includes("moonshot.cn")
    || baseUrl.includes("moonshot.ai");
}

export function withLucVideoInputCompat(model: any, enabled: unknown): any {
  if (!isPlainObject(model) || enabled !== true) return model;

  const compat = isPlainObject(model.compat) ? model.compat : {};
  if (compat.lucVideoInput === true) return model;

  return {
    ...model,
    compat: {
      ...compat,
      lucVideoInput: true,
    },
  };
}

export function withLucAudioInputCompat(model: any, enabled: unknown): any {
  if (!isPlainObject(model) || enabled !== true) return model;

  const compat = isPlainObject(model.compat) ? model.compat : {};
  if (compat.lucAudioInput === true) return model;

  return {
    ...model,
    compat: {
      ...compat,
      lucAudioInput: true,
    },
  };
}

/**
 * Resolve stable visual grounding capabilities for an auxiliary vision model.
 *
 * This deliberately reads an explicit capability object instead of inferring
 * from provider or model name. Plain image support means the model can see;
 * grounding means we can ask for coordinates with a known coordinate contract.
 */
export function normalizeVisionCapabilities(value: any): Record<string, any> | null {
  if (!isPlainObject(value)) return null;
  if (!normalizeBoolean(value.grounding) && !normalizeBoolean(value.visualGrounding)) return null;

  const coordinateSpace = value.coordinateSpace === undefined || value.coordinateSpace === "norm-1000"
    ? "norm-1000"
    : null;
  let boxOrder = null;
  if (value.boxOrder === undefined || value.boxOrder === "xyxy") boxOrder = "xyxy";
  if (value.boxOrder === "yxyx") boxOrder = "yxyx";
  const boxes = value.boxes === false ? false : true;
  const points = value.points === true;
  const outputFormat = ["gemini", "qwen", "anchor", "luc"].includes(lower(value.outputFormat))
    ? lower(value.outputFormat)
    : "luc";
  const groundingMode = ["native", "prompted"].includes(lower(value.groundingMode))
    ? lower(value.groundingMode)
    : "native";

  if (!coordinateSpace || !boxOrder) return null;
  if (!boxes && !points) return null;

  return {
    grounding: true,
    boxes,
    points,
    coordinateSpace,
    boxOrder,
    outputFormat,
    groundingMode,
  };
}

export function getVisionCapabilities(model: any): Record<string, any> | null {
  if (!isPlainObject(model)) return null;
  return normalizeVisionCapabilities(model.visionCapabilities);
}

export function modelSupportsVisualGrounding(model: any): boolean {
  return getVisionCapabilities(model)?.grounding === true;
}
