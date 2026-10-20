/**
 * 消息发送前净化器 — capability-aware message adaptation layer
 *
 * 职责：按 Pi SDK Model.input 声明的输入模态，把历史 messages 里不兼容的
 * content block 替换为 TextContent 占位。目前处理 ImageContent / VideoContent /
 * AudioContent。
 *
 * 定位：注册为 Pi SDK "context" extension event handler（engine.js 内）。
 * "context" 事件在每次 LLM 调用前触发，允许修改 messages。
 *
 * 非静默降级：调用方（engine）根据返回的 stripped 计数决定是否通过事件总线
 * 通知 UI，避免用户悄无声息地丢失信息。
 */
import {
  modelSupportsDirectImageInput,
  modelSupportsDirectAudioInput,
  modelSupportsDirectVideoInput,
  modelSupportsAudioInput,
  modelSupportsImageInput,
  modelSupportsVideoInput,
} from "../shared/model-capabilities.ts";

const IMAGE_PLACEHOLDER_TEXT = "[图片已省略：当前模型不支持图像输入]";
const VIDEO_PLACEHOLDER_TEXT = "[视频已省略：当前模型不支持视频输入]";
const AUDIO_PLACEHOLDER_TEXT = "[音频已省略：当前模型不支持音频输入]";
const HISTORICAL_IMAGE_PLACEHOLDER_TEXT = "[图片已省略：历史图片保留为文件引用，避免重复发送原始 base64]";
const HISTORICAL_VIDEO_PLACEHOLDER_TEXT = "[视频已省略：历史视频保留为文件引用，避免重复发送原始 base64]";
const HISTORICAL_AUDIO_PLACEHOLDER_TEXT = "[音频已省略：历史音频保留为文件引用，避免重复发送原始 base64]";
const ATTACHED_IMAGE_MARKER_RE = /\[attached_image:\s*[^\]]+\]/g;
const ATTACHED_VIDEO_MARKER_RE = /\[attached_video:\s*[^\]]+\]/g;
const ATTACHED_AUDIO_MARKER_RE = /\[attached_audio:\s*[^\]]+\]/g;

/**
 * 模型是否支持 image 输入（Pi SDK 标准字段 input 数组）。
 * @param {{ input?: readonly string[] } | null | undefined} model
 */
export function modelSupportsImage(model) {
  return modelSupportsImageInput(model);
}

/**
 * 模型是否支持 video 输入（Luc 扩展能力，兼容读取旧 input 数组）。
 * @param {{ input?: readonly string[] } | null | undefined} model
 */
export function modelSupportsVideo(model) {
  return modelSupportsVideoInput(model);
}

/**
 * 模型是否支持 audio 输入（Luc 扩展能力，兼容读取旧 input 数组）。
 * @param {{ input?: readonly string[] } | null | undefined} model
 */
export function modelSupportsAudio(model) {
  return modelSupportsAudioInput(model);
}

/**
 * 对 messages 做 provider 能力适配。
 *
 * @param {ReadonlyArray<any>} messages
 * @param {{ input?: readonly string[] } | null | undefined} model
 * @returns {{ messages: any[], stripped: number, strippedImages: number, strippedVideos: number, strippedAudios: number }}
 */
export function sanitizeMessagesForModel(messages, model) {
  if (!Array.isArray(messages)) return emptySanitizeResult(messages);
  const supportsImage = modelSupportsDirectImageInput(model);
  const supportsVideo = modelSupportsDirectVideoInput(model);
  const supportsAudio = modelSupportsDirectAudioInput(model);
  if (supportsImage && supportsVideo && supportsAudio) return emptySanitizeResult(messages);

  // 快速探测：没有任何需要剥离的媒体 block 就返回原数组，避免无谓分配
  if (!hasUnsupportedMediaContent(messages, { supportsImage, supportsVideo, supportsAudio })) {
    return emptySanitizeResult(messages);
  }

  let strippedImages = 0;
  let strippedVideos = 0;
  let strippedAudios = 0;
  const out = messages.map((msg) => {
    if (!msg || typeof msg !== "object") return msg;
    // 只扫可能携带 ImageContent 的消息种类：
    //  - user（UserMessage.content 可以是 (text|image)[])
    //  - toolResult（ToolResultMessage.content 可以是 (text|image)[])
    if (msg.role !== "user" && msg.role !== "toolResult") return msg;
    if (typeof msg.content === "string") return msg;
    if (!Array.isArray(msg.content)) return msg;

    let localStripped = 0;
    const newContent = [];
    for (const block of msg.content) {
      if (block && typeof block === "object" && block.type === "image" && !supportsImage) {
        localStripped++;
        strippedImages++;
        newContent.push({ type: "text", text: IMAGE_PLACEHOLDER_TEXT });
      } else if (block && typeof block === "object" && block.type === "video" && !supportsVideo) {
        localStripped++;
        strippedVideos++;
        newContent.push({ type: "text", text: VIDEO_PLACEHOLDER_TEXT });
      } else if (block && typeof block === "object" && block.type === "audio" && !supportsAudio) {
        localStripped++;
        strippedAudios++;
        newContent.push({ type: "text", text: AUDIO_PLACEHOLDER_TEXT });
      } else {
        newContent.push(block);
      }
    }
    if (localStripped === 0) return msg;
    return { ...msg, content: newContent };
  });

  const stripped = strippedImages + strippedVideos + strippedAudios;
  return { messages: out, stripped, strippedImages, strippedVideos, strippedAudios };
}

/**
 * 剥离历史里的 inline media block，但保留最后一个 assistant 之后的媒体。
 *
 * Pi SDK 会在当前 user message 写入 state 后、真正请求 provider 前触发
 * context hook；此时“最后一个 assistant 之后”的 suffix 正是本轮尚未发送给
 * 模型的输入（当前用户图，或工具刚返回给下一次 assistant 的图）。
 *
 * @param {ReadonlyArray<any>} messages
 * @returns {{ messages: any[], stripped: number, strippedImages: number, strippedVideos: number, strippedAudios: number }}
 */
export function stripHistoricalInlineMediaForReplay(messages) {
  if (!Array.isArray(messages)) return emptySanitizeResult(messages);
  const lastAssistantIndex = findLastAssistantIndex(messages);
  if (lastAssistantIndex < 0) return emptySanitizeResult(messages);
  return stripInlineMediaBlocks(messages, {
    shouldStripMessage: (_msg, index) => index < lastAssistantIndex,
    imagePlaceholder: HISTORICAL_IMAGE_PLACEHOLDER_TEXT,
    videoPlaceholder: HISTORICAL_VIDEO_PLACEHOLDER_TEXT,
    audioPlaceholder: HISTORICAL_AUDIO_PLACEHOLDER_TEXT,
  });
}

/**
 * 剥离所有 inline media block。用于一轮请求结束后清理 session 持久化和
 * runtime state；此时模型已经看过当前轮图片，历史里只应留下轻量引用。
 *
 * @param {ReadonlyArray<any>} messages
 * @returns {{ messages: any[], stripped: number, strippedImages: number, strippedVideos: number, strippedAudios: number }}
 */
export function stripAllInlineMediaForHistory(messages) {
  if (!Array.isArray(messages)) return emptySanitizeResult(messages);
  return stripInlineMediaBlocks(messages, {
    shouldStripMessage: () => true,
    imagePlaceholder: HISTORICAL_IMAGE_PLACEHOLDER_TEXT,
    videoPlaceholder: HISTORICAL_VIDEO_PLACEHOLDER_TEXT,
    audioPlaceholder: HISTORICAL_AUDIO_PLACEHOLDER_TEXT,
  });
}

function emptySanitizeResult(messages) {
  return { messages, stripped: 0, strippedImages: 0, strippedVideos: 0, strippedAudios: 0 };
}

/** 快速判断 messages 里是否存在至少一个当前模型不支持的媒体 block。 */
function hasUnsupportedMediaContent(messages, { supportsImage, supportsVideo, supportsAudio }) {
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    if (msg.role !== "user" && msg.role !== "toolResult") continue;
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "image" && !supportsImage) return true;
      if (block.type === "video" && !supportsVideo) return true;
      if (block.type === "audio" && !supportsAudio) return true;
    }
  }
  return false;
}

function findLastAssistantIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "assistant") return i;
  }
  return -1;
}

function stripInlineMediaBlocks(messages, {
  shouldStripMessage,
  imagePlaceholder,
  videoPlaceholder,
  audioPlaceholder,
}) {
  let strippedImages = 0;
  let strippedVideos = 0;
  let strippedAudios = 0;
  let changed = false;

  const out = messages.map((msg, index) => {
    if (!msg || typeof msg !== "object") return msg;
    if (msg.role !== "user" && msg.role !== "toolResult") return msg;
    if (!Array.isArray(msg.content)) return msg;
    if (!shouldStripMessage(msg, index)) return msg;

    let localStripped = 0;
    let usedImageMarkers = 0;
    let usedVideoMarkers = 0;
    let usedAudioMarkers = 0;
    const text = contentText(msg.content);
    const imageMarkerCount = countMatches(text, ATTACHED_IMAGE_MARKER_RE);
    const videoMarkerCount = countMatches(text, ATTACHED_VIDEO_MARKER_RE);
    const audioMarkerCount = countMatches(text, ATTACHED_AUDIO_MARKER_RE);
    const newContent = [];

    for (const block of msg.content) {
      if (!block || typeof block !== "object") {
        newContent.push(block);
        continue;
      }
      if (block.type === "image") {
        localStripped++;
        strippedImages++;
        if (usedImageMarkers < imageMarkerCount) {
          usedImageMarkers++;
          continue;
        }
        newContent.push({ type: "text", text: imagePlaceholder });
        continue;
      }
      if (block.type === "video") {
        localStripped++;
        strippedVideos++;
        if (usedVideoMarkers < videoMarkerCount) {
          usedVideoMarkers++;
          continue;
        }
        newContent.push({ type: "text", text: videoPlaceholder });
        continue;
      }
      if (block.type === "audio") {
        localStripped++;
        strippedAudios++;
        if (usedAudioMarkers < audioMarkerCount) {
          usedAudioMarkers++;
          continue;
        }
        newContent.push({ type: "text", text: audioPlaceholder });
        continue;
      }
      newContent.push(block);
    }
    if (localStripped === 0) return msg;
    changed = true;
    return { ...msg, content: newContent };
  });

  const stripped = strippedImages + strippedVideos + strippedAudios;
  return {
    messages: changed ? out : messages,
    stripped,
    strippedImages,
    strippedVideos,
    strippedAudios,
  };
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function countMatches(text, re) {
  return String(text || "").match(re)?.length || 0;
}
