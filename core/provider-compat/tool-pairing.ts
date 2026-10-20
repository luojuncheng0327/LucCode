/**
 * core/provider-compat/tool-pairing.ts — 孤儿 toolResult 配对兜底（provider-agnostic）
 *
 * 处理对象：OpenAI-compatible 序列化 payload（role:"tool" + assistant.tool_calls），
 * 即所有走 `openai-completions` API 的 provider（DeepSeek / OpenAI / Qwen / MiMo / …）。
 *
 * 解决的协议问题（issue #1285）：
 *   agentic 工具循环里，assistant 回包 stopReason=error/aborted 时 Pi SDK agent-loop
 *   立即 return 不执行其 tool calls，但此前已完成轮次的 toolResult 已 push 进 context
 *   并持久化到 jsonl。重放时 Pi SDK transform-messages 整条丢弃 stopReason=error/aborted
 *   的 assistant（连带其 tool_calls）；它的兜底只「补孤儿 toolCall → 合成 toolResult」，
 *   没有反向逻辑删除「父 tool_calls 已被丢弃的孤儿 toolResult」（不对称缺口）。
 *   convertMessages 随后无条件把残留 toolResult 序列化成 role:"tool"，前面缺 tool_calls
 *   → provider 返回 400「Messages with role 'tool' must be a response to a preceding
 *   message with 'tool_calls'」。
 *
 *   本模块补上 SDK 缺的那半：扫描序列化后的 messages，删除「父 tool_calls 已不存在的
 *   孤儿 role:"tool"」，使每个 role:"tool" 都有前驱带匹配 tool_calls 的 assistant。
 *
 * 为什么放在序列化后的 payload（before_provider_request hook）而非 context hook：
 *   SDK 的 transform-messages 在 convertMessages 内部丢弃 error/aborted assistant，
 *   这一步发生在 context hook 之后、payload hook 之前。在 context hook 看，error
 *   assistant 仍持有 tool_calls，配对看起来完整，检测不到孤儿。只有在序列化后的
 *   payload 上，孤儿 role:"tool" 才真正暴露。
 *
 * 为什么是通用补丁而非某个 provider 子模块：
 *   孤儿 toolResult 的 400 是 OpenAI Chat Completions 协议的硬约束，对所有
 *   openai-completions provider 一致，不属于任一 provider 的私有 quirk。
 *
 * 删除条件（build-to-delete）：
 *   上游 Pi SDK transform-messages 自身保证配对完整——丢弃 error/aborted assistant
 *   的 tool_calls 时，同步删除其孤儿 toolResult（补齐反向逻辑）。届时本模块可整块删除，
 *   并从 provider-compat.js 主入口移除调用。
 *
 * 不可变契约：未修改时返回原数组；修改时返回新数组（浅拷贝，元素引用不变）。
 */

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function isToolResultMessage(message) {
  return Boolean(message) && typeof message === "object" && message.role === "tool";
}

function isAssistantMessage(message) {
  return Boolean(message) && typeof message === "object" && message.role === "assistant";
}

/**
 * 收集某条 assistant message 声明的 tool_call id 集合。
 * 只认结构合法（非空字符串 id）的 tool_calls 项，缺 id 的项不进集合，
 * 避免用 undefined/空 id 误把孤儿当成已配对。
 *
 * @param {object} assistant
 * @param {Set<string>} into
 */
function collectToolCallIds(assistant, into) {
  const toolCalls = assistant.tool_calls;
  if (!Array.isArray(toolCalls)) return;
  for (const call of toolCalls) {
    if (call && typeof call === "object" && typeof call.id === "string" && call.id.length > 0) {
      into.add(call.id);
    }
  }
}

/**
 * 删除「父 tool_calls 不存在」的孤儿 role:"tool" 消息。
 *
 * 单遍线性扫描：维护一个「至此已声明的 tool_call id」集合，遇到 assistant 把它的
 * tool_calls id 并入集合；遇到 role:"tool" 时，其 tool_call_id 在集合里才保留，
 * 否则视为孤儿删除。
 *
 * 注意：OpenAI Chat Completions 要求 role:"tool" 紧跟在带匹配 tool_calls 的 assistant
 * 之后，但本兜底只校验「存在前驱声明」这一必要条件（删孤儿），不强制位置相邻——
 * 相邻性由 SDK convertMessages 的输出保证，本模块只补 SDK 漏删的孤儿那半，不替 SDK
 * 重排消息，避免越界改动正常 agentic 序列。
 *
 * @param {Array|any} messages 序列化后的 OpenAI 风格 messages
 * @returns {Array|any} 原数组（无孤儿）或新数组（已剔除孤儿）
 */
export function stripOrphanToolResults(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  // 先判断是否存在孤儿，没有就返回原引用（不可变契约 + 避免无谓拷贝）。
  const declaredToolCallIds = new Set();
  let hasOrphan = false;
  for (const message of messages) {
    if (isAssistantMessage(message)) {
      collectToolCallIds(message, declaredToolCallIds);
      continue;
    }
    if (isToolResultMessage(message)) {
      const id = hasOwn(message, "tool_call_id") ? message.tool_call_id : undefined;
      if (typeof id !== "string" || !declaredToolCallIds.has(id)) {
        hasOrphan = true;
        break;
      }
    }
  }

  if (!hasOrphan) return messages;

  // 重新扫描并过滤孤儿。集合需重置，逻辑与上面一致。
  declaredToolCallIds.clear();
  const result = [];
  for (const message of messages) {
    if (isAssistantMessage(message)) {
      collectToolCallIds(message, declaredToolCallIds);
      result.push(message);
      continue;
    }
    if (isToolResultMessage(message)) {
      const id = hasOwn(message, "tool_call_id") ? message.tool_call_id : undefined;
      if (typeof id === "string" && declaredToolCallIds.has(id)) {
        result.push(message);
      }
      // 否则丢弃孤儿
      continue;
    }
    result.push(message);
  }

  return result;
}
