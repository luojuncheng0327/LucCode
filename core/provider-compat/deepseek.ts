/**
 * DeepSeek provider 兼容层
 *
 * 处理 provider:
 *   - provider === "deepseek"
 *   - baseUrl 包含 "api.deepseek.com"
 *
 * 解决的协议问题：
 *   1. 思考模式开启字段：thinking: {type: "enabled" | "disabled"}
 *   2. reasoning_effort 归一化：low/medium → high；xhigh → max
 *      Anthropic 格式下对应 output_config.effort
 *   3. max_tokens 抬升：思考模式下需 ≥ 32768
 *   4. utility mode 主动关思考（短输出场景思考链既无意义又耗光预算）
 *   5. 工具调用轮次必须回传真实 reasoning_content（issue #468 根因；缺失时 fail closed，不伪造空占位）
 *      官方文档：https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
 *
 * 删除条件：
 *   - DeepSeek 不再要求回传 reasoning_content（协议变更）
 *   - 或 pi-ai 直接以 reasoning_content 字段处理 DeepSeek 思考链
 *     （不再借用 thinkingSignature 字段当协议字段名路标）
 *   - 或 luc 不再支持 DeepSeek
 *
 * 接口契约：见 ./README.md
 */

import { getReasoningProfile, getThinkingFormat } from "../../shared/model-capabilities.ts";
import { resolveMissingOutputBudget } from "./deepseek-thinking-budget.ts";
import {
  ensureAssistantContentForToolCalls,
  ensureReasoningContentForToolCalls as ensureReasoningContentForToolCallsBase,
  extractReasoningFromContent,
  stripReasoningContent,
} from "./reasoning-content-replay.ts";

export { ensureAssistantContentForToolCalls, extractReasoningFromContent };

const DEEPSEEK_ROLEPLAY_MARKER_SIGNATURES = [
  "〖角色沉浸要求〗",
  "[Role immersion instruction]",
  "Luc DeepSeek roleplay reasoning patch",
];

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const MISSING_ANTHROPIC_TOOL_THINKING_ERROR =
  "DeepSeek Anthropic thinking mode history is missing non-empty thinking content for a tool call. "
  + "Compact this session or start a new session before continuing with DeepSeek Anthropic thinking mode.";

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function positiveInteger(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export function matches(model) {
  if (!model || typeof model !== "object") return false;
  // Responses 协议归 ./deepseek-responses.ts。这里显式排除，避免模型被显式声明
  // compat.thinkingFormat = "deepseek" 时绕过 dispatcher 的前置顺序落回本模块。
  if (lower(model.api) === "openai-responses") return false;
  if (getThinkingFormat(model) === "deepseek") return true;
  const provider = lower(model.provider);
  // base_url: 兼容上游 SDK 偶发的 snake_case 别名（pi-ai SDK / 用户自定 model 配置）
  const baseUrl = lower(model.baseUrl || model.base_url);
  return provider === "deepseek" || baseUrl.includes("api.deepseek.com");
}

function isKnownThinkingModelId(id) {
  const normalized = lower(id);
  return normalized === "deepseek-reasoner" || normalized.startsWith("deepseek-v4-");
}

function isDeepSeekV4ModelId(id) {
  const normalized = lower(id);
  return normalized === "deepseek-v4"
    || normalized.startsWith("deepseek-v4-")
    || normalized.startsWith("deepseek-v4.");
}

function isDeepSeekAnthropicProfile(model) {
  if (getReasoningProfile(model) === "deepseek-v4-anthropic") return true;
  return lower(model?.api) === "anthropic-messages" && isDeepSeekV4ModelId(model?.id);
}

function isThinkingOff(level) {
  return level === "off" || level === "none" || level === "disabled";
}

/**
 * Luc 思考档位 → DeepSeek reasoning_effort。
 *
 * 官方取值只有 low / high（默认）/ max，且服务端自己会把 medium 归到 high、
 * xhigh 归到 max，所以这里只需要处理 DeepSeek 词汇表里没有的档位：minimal
 * 归到最接近的 low。低档不再被吞成 high —— low 是官方有效档位。
 *
 * 注意 deepseek-v4-pro 目前把 low 当 high 处理，那是服务端的降级，不在这里预判。
 * 文档：https://api-docs.deepseek.com/zh-cn/api/create-chat-completion
 */
function reasoningEffortForLevel(level) {
  if (!level) return null;
  if (level === "xhigh" || level === "max") return "max";
  if (level === "minimal" || level === "low") return "low";
  if (level === "medium" || level === "high") return "high";
  return null;
}

function applyRequestedReasoningLevel(payload, level) {
  const effort = reasoningEffortForLevel(level);
  if (effort) payload.reasoning_effort = effort;
}

function enableThinking(payload) {
  payload.thinking = { type: "enabled" };
}

function normalizeAnthropicThinking(thinking) {
  if (!thinking || typeof thinking !== "object" || Array.isArray(thinking)) {
    return { type: "enabled" };
  }
  const next: { type: string; budget_tokens?: number } = { type: "enabled" };
  if (positiveInteger(thinking.budget_tokens)) {
    next.budget_tokens = positiveInteger(thinking.budget_tokens);
  }
  return next;
}

function shouldUseThinking(payload, model, reasoningLevel) {
  if (payload.thinking?.type === "disabled") return false;
  if (isThinkingOff(reasoningLevel)) return false;
  const knownThinkingModel = model?.reasoning === true || isKnownThinkingModelId(model?.id || payload.model);
  return Boolean(
    payload.reasoning_effort
    || (knownThinkingModel && reasoningEffortForLevel(reasoningLevel))
    || knownThinkingModel
  );
}

/**
 * 把 payload 里已有的 effort 收敛到 DeepSeek 词汇表。
 *
 * medium / xhigh 服务端自己会映射，留着也对；只有 minimal 是 DeepSeek 完全不认
 * 的 OpenAI 专有档位，需要归到 low。
 */
function normalizeReasoningEffort(payload) {
  if (!hasOwn(payload, "reasoning_effort")) return;
  if (payload.reasoning_effort === "minimal") {
    payload.reasoning_effort = "low";
  }
}

function disableThinking(payload) {
  delete payload.reasoning_effort;
  payload.thinking = { type: "disabled" };
  if (Array.isArray(payload.messages)) {
    const stripped = stripReasoningContent(payload.messages);
    if (stripped !== payload.messages) payload.messages = stripped;
  }
}

function disableAnthropicThinking(payload) {
  delete payload.reasoning_effort;
  delete payload.output_config;
  payload.thinking = { type: "disabled" };
}

function shouldInjectRoleplayReasoningPatch(payload, model, options) {
  const id = model?.id || payload?.model;
  return options?.mode !== "utility"
    && options?.deepseekRoleplayReasoningPatch === true
    && (isDeepSeekV4ModelId(id) || getReasoningProfile(model) === "deepseek-v4-anthropic");
}

function normalizeInlineText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function hasRoleplayReasoningMarker(text) {
  const value = typeof text === "string" ? text : "";
  return DEEPSEEK_ROLEPLAY_MARKER_SIGNATURES.some((signature) => value.includes(signature));
}

function buildRoleplayReasoningMarker(options: Record<string, any> = {}) {
  const context = options.deepseekRoleplayReasoningContext || {};
  const locale = context.locale || options.locale;
  const isZh = !locale || String(locale).startsWith("zh");
  const agentName = normalizeInlineText(context.agentName) || (isZh ? "当前 Agent" : "the current Agent");
  const agentDescription = normalizeInlineText(context.agentDescription);

  if (!isZh) {
    return [
      "[Role immersion instruction] In your reasoning_content / thinking process, follow these rules:",
      `Current agent: ${agentName}`,
      agentDescription ? `Roster description: ${agentDescription}` : null,
      `1. Use first-person inner monologue as the Agent identity "${agentName}" defined in the current system prompt, wrapping inner activity in parentheses.`,
      `2. Describe "${agentName}"'s inner feelings, relationship sense, mood state, and immediate emotional-intellectual response in first person.`,
      `3. Keep thinking immersed in "${agentName}"'s persona, roster description, relationship with the user, mood framework, and task situation while planning the reply.`,
      "4. Keep that inner monologue only in reasoning_content / thinking; final assistant content must still follow the active output contract and answer the user's actual task directly.",
    ].filter(Boolean).join("\n");
  }

  return [
    "〖角色沉浸要求〗在你的思考过程（reasoning_content / thinking）中，请遵守以下规则：",
    `当前 Agent：${agentName}`,
    agentDescription ? `花名册简介：${agentDescription}` : null,
    `1. 请以当前系统提示词中定义的 Agent 身份“${agentName}”进行第一人称内心独白，用括号包裹内心活动。`,
    `2. 用第一人称描写“${agentName}”的内心感受、关系感、mood 状态和即时反应。`,
    `3. 思考内容应沉浸在“${agentName}”的人格、花名册简介、与用户的关系、mood 框架和任务现场中，通过内心独白分析情境并规划回复。`,
    "4. 内心独白只允许留在 reasoning_content / thinking 中；最终 assistant content 仍按当前输出契约回答用户的实际任务。",
  ].filter(Boolean).join("\n");
}

function appendMarkerToString(text, marker) {
  const current = typeof text === "string" ? text : "";
  if (hasRoleplayReasoningMarker(current)) return current;
  return current.trim().length > 0
    ? `${current}\n\n${marker}`
    : marker;
}

function appendMarkerToContent(content, marker) {
  if (typeof content === "string") return appendMarkerToString(content, marker);
  if (!Array.isArray(content)) return appendMarkerToString("", marker);
  if (content.some((part) => (
    part
    && typeof part === "object"
    && typeof part.text === "string"
    && hasRoleplayReasoningMarker(part.text)
  ))) {
    return content;
  }
  return [...content, { type: "text", text: marker }];
}

function injectRoleplayReasoningMarker(messages, options) {
  if (!Array.isArray(messages)) return messages;
  const index = messages.findIndex((message) => message?.role === "user");
  if (index < 0) return messages;

  const message = messages[index];
  const marker = buildRoleplayReasoningMarker(options);
  const nextContent = appendMarkerToContent(message.content, marker);
  if (nextContent === message.content) return messages;

  const next = messages.slice();
  next[index] = { ...message, content: nextContent };
  return next;
}

function normalizeMaxTokenField(payload) {
  if (!hasOwn(payload, "max_completion_tokens")) return;
  if (!hasOwn(payload, "max_tokens")) {
    payload.max_tokens = payload.max_completion_tokens;
  }
  delete payload.max_completion_tokens;
}

/**
 * 请求完全没带输出预算时补一个，已有的数值不动。
 *
 * payload 里的 max_tokens 来自 SDK 的 clampMaxTokensToContext，已经是
 * `min(模型输出上限, 剩余窗口 - 安全余量)`。值小只说明剩余窗口紧张，这时放大
 * 只会把请求推过窗口边界（输入和输出共用同一个上下文窗口）。
 */
function ensureOutputBudget(payload, model) {
  if (positiveInteger(payload.max_tokens) === null) {
    payload.max_tokens = resolveMissingOutputBudget(model);
  }
}

/**
 * 恢复/校验：保证所有「带 tool_calls 的 assistant message」都有真实 reasoning_content 字段。
 *
 * 三档策略：
 *   档 1：已有 string reasoning_content（包括合法空字符串）→ 不动
 *   档 2：无 reasoning_content 但能从 message.content 恢复原文 → 注入恢复值
 *   档 3：原文也找不到 → 抛错，阻止远端 400（禁止把缺字段伪造成空字符串）
 *
 * 这条恢复/校验覆盖以下漏字段路径：
 *   - 跨 V4 子版本切换：pi-ai transform-messages 把 thinking block 降级 text
 *   - 空思考被过滤：openai-completions nonEmptyThinkingBlocks filter 掉空内容后补了空字符串
 *   - compaction / 跨 session 续接边界：原文确实丢失（此时本函数 fail closed）
 *
 * 不可变契约：未修改时返回原数组；修改时返回新数组（仅修改的 message 浅拷贝）。
 *
 * @param {Array|any} messages payload.messages
 * @returns {Array|any} 原数组或新数组
 */
export function ensureReasoningContentForToolCalls(messages) {
  return ensureReasoningContentForToolCallsBase(messages, { providerLabel: "DeepSeek" });
}

function hasAgentToolCall(content) {
  return Array.isArray(content) && content.some((block) => {
    if (!block || typeof block !== "object") return false;
    return block.type === "toolCall" || block.type === "tool_use" || block.type === "function_call";
  });
}

function hasNonEmptyThinking(content) {
  return Array.isArray(content) && content.some((block) => {
    return block
      && block.type === "thinking"
      && typeof block.thinking === "string"
      && block.thinking.trim().length > 0;
  });
}

export function normalizeContextMessages(messages, model, options: Record<string, any> = {}) {
  if (!Array.isArray(messages)) return messages;
  if (!isDeepSeekAnthropicProfile(model)) return messages;
  if (options.mode === "utility" || isThinkingOff(options.reasoningLevel)) return messages;

  for (const message of messages) {
    if (!message || typeof message !== "object" || message.role !== "assistant") continue;
    const content = message.content;
    if (!hasAgentToolCall(content)) continue;
    if (!hasNonEmptyThinking(content)) {
      throw new Error(MISSING_ANTHROPIC_TOOL_THINKING_ERROR);
    }
  }

  return messages;
}

function applyAnthropicPayload(payload, model, options: Record<string, any> = {}) {
  const mode = options.mode || "chat";
  const reasoningLevel = options.reasoningLevel;

  let next = payload;
  const editable = () => {
    if (next === payload) next = { ...payload };
    return next;
  };

  if (isThinkingOff(reasoningLevel) || next.thinking?.type === "disabled") {
    disableAnthropicThinking(editable());
    return next;
  }

  if (!shouldUseThinking(next, model, reasoningLevel)) return next;

  if (mode === "utility") {
    disableAnthropicThinking(editable());
    return next;
  }

  const p = editable();
  delete p.reasoning_effort;
  p.thinking = normalizeAnthropicThinking(p.thinking);

  const effort = reasoningEffortForLevel(reasoningLevel);
  if (effort) {
    p.output_config = { effort };
  } else {
    delete p.output_config;
  }

  if (shouldInjectRoleplayReasoningPatch(p, model, options)) {
    const patchedMessages = injectRoleplayReasoningMarker(p.messages, options);
    if (patchedMessages !== p.messages) {
      p.messages = patchedMessages;
    }
  }

  return next;
}

function stripToolChoice(payload) {
  if (!hasOwn(payload, "tool_choice")) return payload;
  const next = { ...payload };
  delete next.tool_choice;
  return next;
}

export function apply(payload, model, options: Record<string, any> = {}) {
  if (!Array.isArray(payload.messages)) return payload;
  if (isDeepSeekAnthropicProfile(model)) {
    return applyAnthropicPayload(payload, model, options);
  }
  const mode = options.mode || "chat";
  const reasoningLevel = options.reasoningLevel;

  let next = payload;
  const editable = () => {
    if (next === payload) next = { ...payload };
    return next;
  };

  if (hasOwn(payload, "max_completion_tokens")) {
    normalizeMaxTokenField(editable());
  }

  if (isThinkingOff(reasoningLevel) || next.thinking?.type === "disabled") {
    disableThinking(editable());
    return next;
  }

  if (!shouldUseThinking(next, model, reasoningLevel)) return next;

  if (mode === "utility") {
    disableThinking(editable());
    return next;
  }

  const p = editable();
  applyRequestedReasoningLevel(p, reasoningLevel);
  normalizeReasoningEffort(p);
  enableThinking(p);
  ensureOutputBudget(p, model);

  if (shouldInjectRoleplayReasoningPatch(p, model, options)) {
    const patchedMessages = injectRoleplayReasoningMarker(p.messages, options);
    if (patchedMessages !== p.messages) {
      p.messages = patchedMessages;
    }
  }

  const contentEnsured = ensureAssistantContentForToolCalls(p.messages);
  if (contentEnsured !== p.messages) {
    p.messages = contentEnsured;
  }

  next = stripToolChoice(p);
  return next;
}
