import { debugLog } from "../debug-log.ts";

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstNumber(...values) {
  for (const value of values) {
    const n = numberOrNull(value);
    if (n !== null) return n;
  }
  return 0;
}

function maybeNumber(...values) {
  for (const value of values) {
    const n = numberOrNull(value);
    if (n !== null) return n;
  }
  return null;
}

function cacheCreationTokens(usage) {
  const direct = maybeNumber(usage?.cacheWrite, usage?.cacheWriteTokens, usage?.cache_creation_input_tokens);
  if (direct !== null) return direct;

  const creation = usage?.cache_creation;
  if (!creation || typeof creation !== "object") return 0;
  return firstNumber(creation.ephemeral_5m_input_tokens)
    + firstNumber(creation.ephemeral_1h_input_tokens);
}

function costTotalFromUsage(usage) {
  return maybeNumber(usage?.costTotal, usage?.cost?.total);
}

function costTotalFromRates(normalized, costRates) {
  if (!costRates || typeof costRates !== "object") return null;
  const inputTokens = normalized.input.uncachedTokens ?? normalized.input.totalTokens ?? 0;
  const outputTokens = normalized.output.totalTokens ?? 0;
  const cacheReadTokens = normalized.cache.readTokens ?? 0;
  const cacheWriteTokens = normalized.cache.writeTokens ?? 0;
  const input = firstNumber(costRates.input) * inputTokens / 1_000_000;
  const output = firstNumber(costRates.output) * outputTokens / 1_000_000;
  const cacheRead = firstNumber(costRates.cacheRead) * cacheReadTokens / 1_000_000;
  const cacheWrite = firstNumber(costRates.cacheWrite) * cacheWriteTokens / 1_000_000;
  const total = input + output + cacheRead + cacheWrite;
  return Number.isFinite(total) ? total : null;
}

function cacheSupport(options) {
  const support = options?.cacheSupport;
  if (support === "not_reported" || support === "not_supported") return support;
  return "reported";
}

function reasoningTokens(usage) {
  return maybeNumber(
    usage?.reasoningTokens,
    usage?.reasoning_tokens,
    usage?.completion_tokens_details?.reasoning_tokens,
    usage?.output_tokens_details?.reasoning_tokens
  );
}

/**
 * Providers disagree on what the input token count covers. OpenAI-compatible
 * payloads fold the cached part into prompt_tokens, so input is the whole
 * prompt. Pi SDK and Anthropic bill the cached part separately and report input
 * as only the remainder that was processed at full price. Anything that relates
 * input to the cache has to know which of the two shapes it is holding, so the
 * test lives here once instead of being restated at each use.
 */
function inputIncludesCachedTokens(usage) {
  // OpenAI Chat Completions.
  if (numberOrNull(usage?.prompt_tokens) !== null) return true;
  if (numberOrNull(usage?.completion_tokens) !== null) return true;
  // OpenAI Responses reuses Anthropic's input_tokens name for the opposite
  // meaning: the whole prompt, with the cached slice broken out under
  // input_tokens_details. That detail block is the only thing telling the two
  // apart, so it has to count as a signal here.
  if (numberOrNull(usage?.input_tokens_details?.cached_tokens) !== null) return true;
  return false;
}

/** Whole prompt as the provider counted it, cached portions included. */
function promptTokens(inputTokens, cacheReadTokens, cacheWriteTokens, inputCoversCache) {
  if (inputTokens === null) return null;
  if (inputCoversCache) return inputTokens;
  if (cacheReadTokens === null || cacheWriteTokens === null) return null;
  return inputTokens + cacheReadTokens + cacheWriteTokens;
}

function uncachedTokens(inputTokens, cacheReadTokens, cacheMissTokens, support, inputCoversCache) {
  if (support !== "reported") return null;
  if (cacheMissTokens !== null) return cacheMissTokens;
  if (inputTokens === null) return null;
  // Already the uncached remainder — subtracting the cache again would floor it
  // at zero and silently zero the input side of any rate-based cost.
  if (!inputCoversCache) return inputTokens;
  if (cacheReadTokens === null) return null;
  return Math.max(0, inputTokens - cacheReadTokens);
}

function hitRatio(inputTokens, cacheReadTokens, cacheWriteTokens, support, inputCoversCache) {
  if (support !== "reported") return null;
  if (cacheReadTokens === null) return null;
  const prompt = promptTokens(inputTokens, cacheReadTokens, cacheWriteTokens, inputCoversCache);
  if (prompt === null || prompt <= 0) return null;
  return cacheReadTokens / prompt;
}

/**
 * Normalize provider-specific usage payloads into the Pi SDK token vocabulary.
 *
 * Supported inputs:
 * - Pi SDK: { input, output, cacheRead, cacheWrite, totalTokens, cost }
 * - Anthropic: { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }
 * - OpenAI-compatible: { prompt_tokens, completion_tokens, total_tokens, prompt_tokens_details.cached_tokens }
 */
export function normalizeLlmUsage(usage, options: Record<string, any> = {}) {
  if (!usage || typeof usage !== "object") return null;

  const inputTokens = firstNumber(usage.input, usage.inputTokens, usage.input_tokens, usage.prompt_tokens);
  const outputTokens = firstNumber(usage.output, usage.outputTokens, usage.output_tokens, usage.completion_tokens);
  const cacheMissTokens = maybeNumber(usage.cacheMiss, usage.cacheMissTokens, usage.prompt_cache_miss_tokens);
  const support = cacheSupport(options);
  const cacheReadTokens = support === "reported"
    ? firstNumber(
      usage.cacheRead,
      usage.cacheReadTokens,
      usage.cache_read_input_tokens,
      usage.prompt_cache_hit_tokens,
      usage.prompt_tokens_details?.cached_tokens,
      usage.input_tokens_details?.cached_tokens
    )
    : null;
  const cacheWriteTokens = support === "reported" ? cacheCreationTokens(usage) : null;
  const inputCoversCache = inputIncludesCachedTokens(usage);
  const fallbackTotal = inputCoversCache
    ? inputTokens + outputTokens
    : inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const totalTokens = firstNumber(
    usage.totalTokens,
    usage.total_tokens,
    fallbackTotal
  );
  const normalized = {
    input: {
      totalTokens: inputTokens,
      uncachedTokens: uncachedTokens(inputTokens, cacheReadTokens, cacheMissTokens, support, inputCoversCache),
    },
    output: {
      totalTokens: outputTokens,
      reasoningTokens: reasoningTokens(usage),
    },
    cache: {
      readTokens: cacheReadTokens,
      writeTokens: cacheWriteTokens,
      missTokens: support === "reported" ? cacheMissTokens : null,
      hit: support === "reported" ? cacheReadTokens > 0 : null,
      created: support === "reported" ? cacheWriteTokens > 0 : null,
      hitRatio: hitRatio(inputTokens, cacheReadTokens, cacheWriteTokens, support, inputCoversCache),
      support,
    },
    totalTokens,
  };
  const explicitCost = costTotalFromUsage(usage);
  const costTotal = explicitCost !== null ? explicitCost : costTotalFromRates(normalized, options.costRates);

  return {
    costTotal,
    ...normalized,
  };
}

export function flattenNormalizedUsage(normalized) {
  if (!normalized) return null;
  const flat: Record<string, any> = {
    inputTokens: normalized.input?.totalTokens ?? 0,
    outputTokens: normalized.output?.totalTokens ?? 0,
    cacheReadTokens: normalized.cache?.readTokens ?? 0,
    cacheWriteTokens: normalized.cache?.writeTokens ?? 0,
    totalTokens: normalized.totalTokens ?? 0,
    costTotal: normalized.costTotal ?? null,
    cacheHit: normalized.cache?.hit ?? false,
    cacheCreated: normalized.cache?.created ?? false,
  };
  if (normalized.cache?.missTokens != null) flat.cacheMissTokens = normalized.cache.missTokens;
  return flat;
}

export function buildUsageDebugRecord({
  source,
  api = null,
  provider = null,
  modelId = null,
  usage,
  costRates = null,
}: Record<string, any> = {}) {
  const normalized = normalizeLlmUsage(usage, { costRates });
  if (!normalized) return null;

  return {
    source: source ?? null,
    api: api ?? null,
    provider: provider ?? null,
    modelId: modelId ?? null,
    ...flattenNormalizedUsage(normalized),
  };
}

export function logLlmUsage({
  logger = debugLog(),
  source,
  api = null,
  provider = null,
  modelId = null,
  usage,
  costRates = null,
}: Record<string, any> = {}) {
  const record = buildUsageDebugRecord({ source, api, provider, modelId, usage, costRates });
  if (!record || !logger || typeof logger.log !== "function") return record;

  try {
    logger.log("llm-usage", `model_usage ${JSON.stringify(record)}`);
  } catch {
    // Debug logging must never affect model calls.
  }

  return record;
}
