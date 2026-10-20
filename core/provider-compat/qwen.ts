/**
 * Qwen-style provider 兼容层
 *
 * 处理 provider:
 *   - 任何 model.quirks 包含 "enable_thinking" 的模型（known-models.json 声明）
 *   - DashScope OpenAI-compatible 视频模型（Luc compat 声明 video，且 shared 层确认可走 video_url）
 *
 * 注：dashscope-coding 下托管的 Kimi 系列模型（kimi-k2 / kimi-k2.5）虽然不是 Qwen 模型，
 * 但通过阿里 dashscope 协议暴露，同样使用 enable_thinking 字段控制思考模式，故走本子模块。
 *
 * 解决的协议问题：
 *   1. DashScope 视觉理解 OpenAI 兼容接口要求视频文件使用 video_url：
 *      https://help.aliyun.com/zh/model-studio/vision/
 *   Qwen 思考模式由 enable_thinking: bool 控制（非 OpenAI 标准的 reasoning_effort）。
 *   - chat 路径：Pi SDK 自动处理（compat.thinkingFormat="qwen" + reasoningEffort）
 *     见 node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js
 *   - utility 路径：Pi SDK 不参与（callText 直 fetch），luc 必须自己强制关思考
 *     省 token（utility 是 50~500 token 短输出，思考链耗光预算）
 *
 * 删除条件：
 *   - DashScope OpenAI 兼容接口接受 data:video 的 image_url，且 Pi SDK 直接处理 video_url
 *   - Qwen-style 协议改成 reasoning_effort（不再用 enable_thinking 字段）
 *   - 或 luc 的 quirks 系统重构（known-models.json 数据格式变更）
 *
 * 不可变契约：chat mode 默认返回 input 同一引用；需要显式关闭 thinking 时返回新对象
 * （浅拷贝 + 强制覆盖 enable_thinking）。utility mode 始终强制关 thinking。
 *
 * 接口契约：见 ./README.md
 */
import { modelSupportsVideoInput } from "../../shared/model-capabilities.ts";
import { normalizeOpenAIVideoUrlPayload } from "./openai-video-url.ts";

export function matches(model) {
  if (!model || typeof model !== "object") return false;
  if (
    isDashScopeProvider(model)
    && modelSupportsVideoInput(model)
  ) {
    return true;
  }
  // 按 quirks 单一字段判断而非 provider 名：quirks 是数据层（known-models.json）声明的
  // 协议特征，model-sync 投影时已做过 provider 判断（只有 Qwen-style 协议的 provider 会标
  // enable_thinking 这个 quirk）。在 matches 里再加 provider 守卫是双层冗余，反而把数据层的
  // 归属拆碎，且会漏掉 dashscope-coding / siliconflow / modelscope / infini 等同协议 provider。
  if (!Array.isArray(model.quirks)) return false;
  return model.quirks.includes("enable_thinking");
}

export function apply(payload, model, options = {}) {
  let result = normalizeDashScopeVideoPayload(payload, model);
  // chat 路径默认让 Pi SDK 自己处理（compat.thinkingFormat="qwen" 路径），不动 payload。
  // 当用户明确选择 off，或模型默认声明 reasoning=false 时，Pi SDK 没有 Qwen-style 的
  // "关闭 thinking" 语义，必须按 DashScope/OpenAI-compatible 协议显式发送 enable_thinking=false。
  // utility 路径强制关思考（短输出不需要思考链 + 省 token）
  if (shouldDisableThinking(model, options)) {
    return { ...result, enable_thinking: false };
  }
  return result;
}

function shouldDisableThinking(model, options) {
  if (options?.mode === "utility") return true;
  if (options?.mode !== "chat") return false;
  return isDisabledThinkingLevel(options?.reasoningLevel) || model?.reasoning === false;
}

function isDisabledThinkingLevel(value) {
  if (value === false) return true;
  if (value == null) return false;
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "" || normalized === "none" || normalized === "off" || normalized === "disabled";
}

function normalizeDashScopeVideoPayload(payload, model) {
  if (!isDashScopeVideoModel(model)) return payload;
  return normalizeOpenAIVideoUrlPayload(payload);
}

function isDashScopeVideoModel(model) {
  return isDashScopeProvider(model) && modelSupportsVideoInput(model);
}

function isDashScopeProvider(model) {
  const provider = typeof model?.provider === "string" ? model.provider.toLowerCase() : "";
  const baseUrl = typeof model?.baseUrl === "string" ? model.baseUrl.toLowerCase() : "";
  return provider === "dashscope" || baseUrl.includes("dashscope");
}
