/**
 * DeepSeek Responses 协议兼容层
 *
 * 处理 provider:
 *   - DeepSeek 官方 endpoint（provider 前缀 "deepseek" 或 baseUrl 含 "api.deepseek.com"）
 *   - 且 api === "openai-responses"
 *
 * 解决的协议问题：
 *   1. effort 枚举不同源：Pi SDK 的 OpenAIResponsesOptions.reasoningEffort 是
 *      OpenAI 枚举（含 minimal），DeepSeek 的词汇表是 low/high/max 加关思考的
 *      none。DeepSeek 对不支持的取值静默忽略而非报错，minimal 不翻译就等于档位
 *      悄悄失效。medium / xhigh 服务端自己会映射，不必代劳。
 *   2. 输出预算字段名：Responses 用 max_output_tokens，ChatCompletions 用 max_tokens。
 *      漏搬同样会被静默忽略。注意这里只搬字段名，不改数值 —— 预算大小由 SDK 的
 *      clampMaxTokensToContext 决定，它才拿得到真实 token 数。
 *   3. ChatCompletions 残留字段：thinking / 顶层 reasoning_effort 只在 DeepSeek 的
 *      ChatCompletions 通道有效，发到 Responses 是无效噪声。
 *   4. 关思考：DeepSeek 的思考模式默认开启，关掉必须显式发 effort:"none"。这条
 *      通道没有 thinking:{type:"disabled"} 可用，删掉 reasoning 字段等于落回
 *      默认的思考开启，用户选的 off 档会静默失效。
 *
 *   官方文档：https://api-docs.deepseek.com/guides/responses_api/
 *             https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
 *
 * 删除条件：
 *   - DeepSeek Responses 接受 OpenAI 原生 effort 枚举（不再需要 minimal 翻译），
 *     且 Pi SDK 通过 model.thinkingLevelMap 完成映射
 *   - 或 luc 不再支持 DeepSeek Responses 通道
 *
 * 接口契约：见 ./README.md
 */

import { resolveMissingOutputBudget } from "./deepseek-thinking-budget.ts";

const RESPONSES_API = "openai-responses";
const OFFICIAL_DEEPSEEK_PROVIDERS = new Set(["deepseek", "deepseek-responses"]);

/** ChatCompletions 专属，发到 Responses 端点只会被静默忽略。 */
const CHAT_COMPLETIONS_ONLY_FIELDS = ["thinking", "reasoning_effort"];
/** Responses 端点的输出预算只认 max_output_tokens，其余同义字段需要搬运后删除。 */
const LEGACY_OUTPUT_CAP_FIELDS = ["max_tokens", "max_completion_tokens", "maxOutputTokens"];

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function lower(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function positiveInteger(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export function matches(model) {
  if (!model || typeof model !== "object") return false;
  if (lower(model.api) !== RESPONSES_API) return false;
  if (OFFICIAL_DEEPSEEK_PROVIDERS.has(lower(model.provider))) return true;
  // base_url: 兼容上游 SDK 偶发的 snake_case 别名（pi-ai SDK / 用户自定 model 配置）
  return lower(model.baseUrl || model.base_url).includes("api.deepseek.com");
}

/** DeepSeek 关闭思考的官方取值。 */
const EFFORT_NONE = "none";

function isThinkingOff(level) {
  return level === "off" || level === EFFORT_NONE || level === "disabled";
}

/**
 * 收敛到 DeepSeek 的 effort 词汇表：low / high / max，外加关思考用的 none。
 *
 * medium 和 xhigh 服务端自己会映射到 high / max，原样透传即可；minimal 是
 * OpenAI 专有档位，DeepSeek 不认，归到最接近的 low。
 * 文档：https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
 */
function translateEffort(effort) {
  const normalized = lower(effort);
  if (!normalized) return null;
  if (isThinkingOff(normalized)) return EFFORT_NONE;
  if (normalized === "minimal") return "low";
  return normalized;
}

/**
 * 解析本次请求最终要发的 max_output_tokens：只做字段搬运，不改数值。
 *
 * 预算大小由 SDK 的 clampMaxTokensToContext 决定（`min(模型输出上限,
 * 剩余窗口 - 安全余量)`），兼容层不覆盖 —— 它拿不到真实 token 数，覆盖只会
 * 在剩余窗口紧张时把请求推过窗口边界。
 */
function resolveOutputCap(payload) {
  const explicit = positiveInteger(payload.max_output_tokens);
  if (explicit) return explicit;
  for (const field of LEGACY_OUTPUT_CAP_FIELDS) {
    const value = positiveInteger(payload[field]);
    if (value) return value;
  }
  return null;
}

/**
 * 决定本次请求的 reasoning 字段。
 *
 * DeepSeek 的思考模式默认开启，关思考必须显式发 `effort: "none"` —— 删掉
 * reasoning 字段只会落回"思考开启"的服务端默认，用户选的 off 档就没生效。
 */
function resolveReasoning(payload, thinkingDisabled) {
  const current = payload.reasoning && typeof payload.reasoning === "object"
    ? payload.reasoning
    : null;

  if (thinkingDisabled) {
    if (current?.effort === EFFORT_NONE) return current;
    return { ...(current || {}), effort: EFFORT_NONE };
  }

  if (!current) return null;
  const effort = translateEffort(current.effort);
  // 没带 effort 就别凭空造一个，服务端默认 high。
  if (!effort) return current;
  return effort === current.effort ? current : { ...current, effort };
}

export function apply(payload, model, options: Record<string, any> = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;

  const thinkingDisabled = options.mode === "utility" || isThinkingOff(options.reasoningLevel);
  // 官方没有公布 max_output_tokens 的默认值，只建议显式声明，所以完全没带预算时补一个。
  const resolvedCap = resolveOutputCap(payload);
  const outputCap = resolvedCap === null && !thinkingDisabled
    ? resolveMissingOutputBudget(model)
    : resolvedCap;
  const nextReasoning = resolveReasoning(payload, thinkingDisabled);
  const staleFields = [
    ...CHAT_COMPLETIONS_ONLY_FIELDS,
    ...LEGACY_OUTPUT_CAP_FIELDS,
  ].filter((field) => hasOwn(payload, field));

  const reasoningChanged = nextReasoning !== (payload.reasoning ?? null);
  const outputCapChanged = outputCap !== null
    && positiveInteger(payload.max_output_tokens) !== outputCap;

  if (!staleFields.length && !reasoningChanged && !outputCapChanged) return payload;

  const next = { ...payload };
  for (const field of staleFields) delete next[field];
  if (outputCap !== null) next.max_output_tokens = outputCap;
  if (nextReasoning) next.reasoning = nextReasoning;
  else delete next.reasoning;

  return next;
}
