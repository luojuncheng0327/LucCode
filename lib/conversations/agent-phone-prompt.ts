import path from "path";
import { loadConfig } from "../memory/config-loader.ts";

export const DEFAULT_AGENT_PHONE_GUARD_LIMIT_PER_MEMBER = 12;

export const DEFAULT_AGENT_PHONE_SETTINGS = Object.freeze({
  toolMode: "read_only",
  replyMinChars: null,
  replyMaxChars: null,
  proactiveEnabled: true,
  reminderIntervalMinutes: 31,
  guardLimit: defaultAgentPhoneGuardLimit(3),
  modelOverrideEnabled: false,
  modelOverrideModel: null,
});

export const AGENT_PHONE_REFLECTION_GUIDES = Object.freeze({
  luc: { zhName: "MOOD", enName: "MOOD", tag: "mood" },
  butter: { zhName: "PULSE", enName: "PULSE", tag: "pulse" },
  ming: { zhName: "沉思", enName: "Reflect", tag: "reflect" },
});

export function positiveIntegerOrNull(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.floor(num);
}

export function positiveIntegerOrDefault(value, defaultValue) {
  return positiveIntegerOrNull(value) || defaultValue;
}

export function defaultAgentPhoneGuardLimit(memberCount = 3) {
  const count = Number(memberCount);
  const normalized = Number.isFinite(count) && count > 0 ? Math.floor(count) : 3;
  return Math.max(1, normalized) * DEFAULT_AGENT_PHONE_GUARD_LIMIT_PER_MEMBER;
}

export function resolveAgentPhoneGuardLimit(value, memberCount = 3) {
  return positiveIntegerOrDefault(value, defaultAgentPhoneGuardLimit(memberCount));
}

export function readBoolean(value) {
  return value === true || value === "true";
}

export function normalizeAgentPhoneModelOverride({ enabled, id, provider }: { enabled?: any; id?: any; provider?: any } = {}) {
  if (!readBoolean(enabled)) return { enabled: false, model: null };
  const modelId = typeof id === "string" ? id.trim() : "";
  const modelProvider = typeof provider === "string" ? provider.trim() : "";
  if (!modelId || !modelProvider) return { enabled: false, model: null };
  return { enabled: true, model: { id: modelId, provider: modelProvider } };
}

export function resolveAgentPhoneReflectionGuide({ agentId, agent = null, agentsDir = null }: { agentId?: any; agent?: any; agentsDir?: any } = {}) {
  try {
    let cfg = agent?.config || null;
    if (!cfg && agentsDir && agentId) {
      cfg = loadConfig(path.join(agentsDir, agentId, "config.yaml"));
    }
    const yuan = cfg?.agent?.yuan || null;
    return yuan ? (AGENT_PHONE_REFLECTION_GUIDES[yuan] || null) : null;
  } catch {
    return null;
  }
}

function formatRangeText({ min, max, isZh }) {
  if (min && max) {
    return isZh
      ? `${min} 到 ${max} 字之间`
      : `between ${min} and ${max} characters`;
  }
  if (min) {
    return isZh ? `不少于 ${min} 字` : `at least ${min} characters`;
  }
  return isZh ? `不超过 ${max} 字` : `at most ${max} characters`;
}

export function formatAgentPhonePromptGuidance({
  agentId,
  agent = null,
  agentsDir = null,
  settings = DEFAULT_AGENT_PHONE_SETTINGS,
  isZh = false,
  zhConversationName = "对话",
  enConversationName = "conversation",
}: { agentId?: any; agent?: any; agentsDir?: any; settings?: any; isZh?: boolean; zhConversationName?: string; enConversationName?: string } = {}) {
  const guide = resolveAgentPhoneReflectionGuide({ agentId, agent, agentsDir });
  const lines = [];
  if (guide) {
    lines.push(isZh
      ? `- 你的系统提示词已加载 ${guide.zhName}（${guide.enName}）内省模板；本轮请遵循 ${guide.zhName} / ${guide.enName}，并使用 <${guide.tag}>...</${guide.tag}>。这段只显示在手机动态里，不会发到${zhConversationName}`
      : `- Your system prompt has loaded the ${guide.enName} (${guide.zhName}) reflection template. For this turn, follow ${guide.enName} / ${guide.zhName} and use <${guide.tag}>...</${guide.tag}>. It appears only in phone activity and is not posted to the ${enConversationName}`);
  } else {
    lines.push(isZh
      ? `- 你的系统提示词已加载当前 Agent 的内省模板；本轮请遵循系统提示词里的内省区块与标签要求。这段只显示在手机动态里，不会发到${zhConversationName}`
      : `- Your system prompt has loaded this agent's reflection template. For this turn, follow the reflection block and tag requirement in the system prompt. It appears only in phone activity and is not posted to the ${enConversationName}`);
  }
  lines.push(isZh
    ? `- 实际发到${zhConversationName}的回复正文要像即时通讯里的自然发言，优先口语化、轻一点，避免写成正式文章；如果内容很长，或需要清单、步骤、代码、严谨解释，可以改用清楚的结构化表达。这条只约束最终发送正文，不约束内省、工具调用记录或手机动态`
    : `- The reply body posted to the ${enConversationName} should sound like natural instant-message speech: conversational, lighter, and not essay-like. If the content is long or needs lists, steps, code, or precision, use clear structured writing instead. This only constrains the final posted reply, not reflection, tool logs, or phone activity`);
  if (settings.replyMinChars || settings.replyMaxChars) {
    const rangeText = formatRangeText({
      min: settings.replyMinChars,
      max: settings.replyMaxChars,
      isZh,
    });
    lines.push(isZh
      ? `- 当前${zhConversationName}希望你把实际发送的回复正文控制在${rangeText}；这是写作提醒，不会改变 API 输出预算`
      : `- This ${enConversationName} prefers the posted reply body to be ${rangeText}. This is writing guidance and does not change the API output budget`);
  }
  return lines.join("\n");
}
