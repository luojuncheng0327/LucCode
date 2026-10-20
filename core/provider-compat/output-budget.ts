/**
 * Generic output budget normalization.
 *
 * This module only handles provider-independent request policy. Provider wire
 * details stay in provider-compat/<provider>.js modules.
 */

export const DEFAULT_CHAT_OUTPUT_TOKENS = 65_536;
const OUTPUT_CAP_FIELDS = [
  "max_completion_tokens",
  "max_tokens",
  "max_output_tokens",
  "maxOutputTokens",
];
const OUTPUT_CAP_FIELD_SET = new Set(OUTPUT_CAP_FIELDS);

const DEFAULT_OUTPUT_CAP_CAPABILITY = Object.freeze({
  id: "default-optional",
  required: false,
  preserveImplicitSdkDefault: false,
});
const OUTPUT_BUDGET_SOURCE_UNSPECIFIED = "unspecified";
const PRESERVED_OUTPUT_BUDGET_SOURCES = new Set(["user", "system"]);

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function positiveInteger(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function getModelOutputLimit(model) {
  return positiveInteger(model?.maxTokens || model?.maxOutput);
}

function isOfficialDeepSeekEndpoint(model) {
  const provider = lower(model?.provider);
  const baseUrl = lower(model?.baseUrl || model?.base_url);
  return provider === "deepseek" || baseUrl.includes("api.deepseek.com");
}

const OUTPUT_CAP_CAPABILITIES = [
  {
    id: "explicit-required",
    required: true,
    preserveImplicitSdkDefault: true,
    matches: (model) => model?.compat?.outputCapRequired === true,
  },
  {
    id: "official-deepseek",
    required: false,
    preserveImplicitSdkDefault: true,
    matches: isOfficialDeepSeekEndpoint,
  },
  {
    id: "anthropic-native",
    required: true,
    preserveImplicitSdkDefault: true,
    matches: (model) => lower(model?.provider) === "anthropic"
      || lower(model?.baseUrl || model?.base_url).includes("api.anthropic.com"),
  },
  {
    id: "bedrock-native",
    required: true,
    preserveImplicitSdkDefault: true,
    matches: (model) => {
      const provider = lower(model?.provider);
      return provider === "amazon-bedrock" || provider === "bedrock";
    },
  },
  {
    id: "anthropic-messages",
    required: true,
    preserveImplicitSdkDefault: true,
    matches: (model) => lower(model?.api) === "anthropic-messages",
  },
];

export function resolveOutputCapCapability(model) {
  if (!model || typeof model !== "object") return DEFAULT_OUTPUT_CAP_CAPABILITY;
  return OUTPUT_CAP_CAPABILITIES.find((capability) => capability.matches(model))
    || DEFAULT_OUTPUT_CAP_CAPABILITY;
}

function hasOutputCap(payload) {
  return OUTPUT_CAP_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(payload, field));
}

function resolveOutputCapField(model) {
  const explicit = model?.compat?.outputCapField;
  if (typeof explicit === "string" && OUTPUT_CAP_FIELD_SET.has(explicit)) return explicit;
  // Responses 协议的输出预算字段是 max_output_tokens；发 max_tokens 会被静默忽略。
  const api = lower(model?.api);
  if (api === "openai-responses" || api === "openai-codex-responses") return "max_output_tokens";
  return "max_tokens";
}

function resolveOutputBudgetSource(options: Record<string, any> = {}) {
  const outputBudgetSource = lower(options.outputBudgetSource);
  if (outputBudgetSource) return outputBudgetSource;
  const maxTokensSource = lower(options.maxTokensSource);
  if (maxTokensSource) return maxTokensSource;
  if (positiveInteger(options.userMaxTokens) !== null) return "user";
  return OUTPUT_BUDGET_SOURCE_UNSPECIFIED;
}

export function resolveOutputBudgetPolicy(model, options: Record<string, any> = {}) {
  const mode = options.mode || "chat";
  const source = resolveOutputBudgetSource(options);
  const capability = resolveOutputCapCapability(model);
  const preserveForSource = PRESERVED_OUTPUT_BUDGET_SOURCES.has(source);
  const modelLimit = getModelOutputLimit(model);
  const defaultMaxTokens = Math.min(modelLimit ?? DEFAULT_CHAT_OUTPUT_TOKENS, DEFAULT_CHAT_OUTPUT_TOKENS);
  const applyChatDefault = mode === "chat" && !preserveForSource;
  // `before_provider_request` sees the final serialized payload. Most current
  // serializers include the SDK-derived cap, but optional providers may omit
  // it. An absent field in ordinary chat still means Luc's default policy,
  // not an invitation to fall back to an unknown provider default.
  const synthesizeChatDefault = applyChatDefault;

  return {
    mode,
    source,
    capability,
    preserveForSource,
    modelLimit,
    defaultMaxTokens,
    applyChatDefault,
    synthesizeChatDefault,
  };
}

/**
 * Normalize the final serialized request budget.
 *
 * Pi SDK already tightens its derived maxTokens to the remaining context before
 * this hook runs. Luc therefore only lowers an existing default-derived cap to
 * its own 64K target; it never raises a smaller value. User/system-owned values
 * may exceed that default target, but still cannot exceed the model's declared
 * output capability.
 */
export function normalizeImplicitOutputBudget(payload, model, options: Record<string, any> = {}) {
  if (!payload || typeof payload !== "object") return payload;
  const policy = resolveOutputBudgetPolicy(model, options);
  let next = payload;

  const hasPromptInput = Array.isArray(next.messages)
    || Array.isArray(next.input)
    || typeof next.input === "string";
  if (!hasOutputCap(next) && hasPromptInput) {
    const synthesizedCap = (policy.synthesizeChatDefault || (policy.applyChatDefault && policy.capability.required))
      ? policy.defaultMaxTokens
      : (policy.capability.required ? policy.modelLimit : null);
    if (synthesizedCap !== null) {
      next = { ...next, [resolveOutputCapField(model)]: synthesizedCap };
    }
  }

  const upperBound = policy.applyChatDefault
    ? policy.defaultMaxTokens
    : policy.modelLimit;
  if (upperBound === null) return next;

  for (const field of OUTPUT_CAP_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(next, field)) continue;
    const current = positiveInteger(next[field]);
    if (current === null) continue;
    const bounded = Math.min(current, upperBound);
    if (bounded === current) continue;
    if (next === payload) next = { ...payload };
    next[field] = bounded;
  }

  return next;
}
