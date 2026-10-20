/**
 * media-protocols.ts — media capability 命名与 protocol 推断的唯一入口
 *
 * Provider 声明一个媒体模型存在，protocolId 决定由哪个 adapter 执行它。
 * 所有"模型缺 protocolId 时怎么补"的判定都必须走 inferMediaProtocolId()，
 * 禁止在注册处 / 迁移处 / 过滤处各自维护一份推断规则（#1627 的根因之一）。
 */

/** capability 别名 → 规范 camelCase key */
export const MEDIA_CAPABILITY_KEYS = {
  image_generation: "imageGeneration",
  image: "imageGeneration",
  video_generation: "videoGeneration",
  video: "videoGeneration",
  speech_generation: "speechGeneration",
  speech_recognition: "speechRecognition",
  speechRecognition: "speechRecognition",
  transcription: "speechRecognition",
  asr: "speechRecognition",
  speech: "speechGeneration",
};

export function capabilityKey(capability) {
  return MEDIA_CAPABILITY_KEYS[capability] || capability;
}

/**
 * 自定义 provider 中视为"OpenAI 兼容网关"的 api 协议。
 * 这类网关约定俗成在同一 base_url 下提供 OpenAI Images API（/images/generations）。
 */
const OPENAI_COMPATIBLE_APIS = new Set(["openai-completions", "openai-responses"]);

/**
 * 推断媒体模型的 protocolId。
 *
 * @param {string} providerId
 * @param {string} capability - 支持 snake/camel 别名（见 MEDIA_CAPABILITY_KEYS）
 * @param {string} modelId
 * @param {{ api?: string, sourceKind?: string }} [provider] - provider 上下文：
 *   - api: provider 生效的 API 协议（ProviderEntry.api）
 *   - sourceKind: provider 来源（"builtin" | "plugin" | "user"）；"user" 表示
 *     added-models.yaml 里用户自定义、无插件声明的 provider。
 *   调用方掌握多少上下文就传多少：迁移层不知道来源时不传，
 *   依赖来源的规则（自定义 provider → openai-images）就不会触发。
 * @returns {string} 推断出的 protocolId；无法判定时返回 ""（调用方必须显式处理，不允许静默丢弃）
 */
export function inferMediaProtocolId(providerId, capability, modelId, provider: { api?: string; sourceKind?: string } = {}) {
  const key = capabilityKey(capability);
  const id = String(modelId || "");

  if (key === "imageGeneration") {
    // 内置 provider 的显式规则
    if (providerId === "openai-codex-oauth") return "openai-codex-responses-image";
    if (providerId === "openai" && (id.startsWith("gpt-image") || id.startsWith("dall-e"))) return "openai-images";
    if (providerId === "volcengine" && id.includes("seedream")) return "volcengine-images";
    if (providerId === "dashscope" && id.startsWith("wan")) return "dashscope-wan-images";
    if (providerId === "dashscope" && id.startsWith("qwen-image-2")) return "dashscope-qwen-multimodal-image";
    if (providerId === "dashscope" && id.startsWith("qwen-image")) return "dashscope-qwen-text2image";
    if (providerId === "minimax" && id.startsWith("image-")) return "minimax-images";
    if (providerId === "gemini" && id.includes("image")) return "gemini-generate-content-image";
    // 用户自定义 provider：OpenAI 兼容网关的图片模型按 OpenAI Images API 执行（#1627）。
    // 仅对 sourceKind === "user" 生效，内置 / 插件 provider 行为不变。
    if (provider.sourceKind === "user" && OPENAI_COMPATIBLE_APIS.has(provider.api)) return "openai-images";
    return "";
  }

  if (key === "speechRecognition") {
    if (providerId === "openai" && (id.includes("transcribe") || id === "whisper-1")) return "openai-audio-transcriptions";
    if ((providerId === "mimo" || providerId === "mimo-token-plan") && id.includes("asr")) return "mimo-chat-completions-asr";
    if (providerId === "dashscope" && id.includes("asr")) return "dashscope-qwen-asr-chat";
    if (providerId === "volcengine-speech" && id.includes("bigasr")) return "volcengine-bigasr-transcription";
    if (providerId === "system-speech") return "system-speech-recognition";
    return "";
  }

  return "";
}
