/**
 * Provider media serialization helpers.
 *
 * Luc carries current-turn media internally as canonical content blocks:
 * `{ type: "image" | "video" | "audio", data, mimeType }`.
 *
 * Provider-specific adapters should not leak into UI/session code. This module
 * serializes current-turn media into the closest OpenAI-compatible content
 * shape. Audio uses Chat Completions' official `input_audio` block at the
 * source; provider-compat still accepts older data URL envelopes produced by
 * the Pi SDK chat path.
 */
import { openAIInputAudioFormatFromMimeType } from "../shared/audio-mime.ts";

const DEFAULT_MIME_BY_KIND = Object.freeze({
  image: "image/png",
  video: "video/mp4",
  audio: "audio/wav",
});

export function inlineMediaKind(block) {
  if (!block || typeof block !== "object") return null;
  if (block.type === "image" || block.type === "video" || block.type === "audio") {
    return block.type;
  }
  return null;
}

export function isInlineMediaBlock(block) {
  return inlineMediaKind(block) !== null && typeof block?.data === "string";
}

export function inlineMediaDataUrl(block) {
  const kind = inlineMediaKind(block);
  if (!kind) return null;
  const mime = block?.mimeType || block?.mime || DEFAULT_MIME_BY_KIND[kind];
  const data = block?.data || "";
  return `data:${mime};base64,${data}`;
}

export function serializeOpenAIInputAudioContentBlock(block) {
  const mimeType = block?.mimeType || block?.mime || DEFAULT_MIME_BY_KIND.audio;
  const format = openAIInputAudioFormatFromMimeType(mimeType);
  if (!format || typeof block?.data !== "string") {
    throw new Error(`unsupported OpenAI input_audio payload: ${mimeType || "unknown"}`);
  }
  return {
    type: "input_audio",
    input_audio: {
      data: block.data,
      format,
    },
  };
}

export function serializeOpenAICompatibleContentBlock(block) {
  if (block?.type === "text") return { type: "text", text: block.text || "" };
  if (block?.type === "audio") return serializeOpenAIInputAudioContentBlock(block);
  if (isInlineMediaBlock(block)) {
    return {
      type: "image_url",
      image_url: {
        url: inlineMediaDataUrl(block),
      },
    };
  }
  return { type: "text", text: JSON.stringify(block) };
}

export function serializeResponsesContentBlock(block) {
  if (block?.type === "text") return { type: "input_text", text: block.text || "" };
  if (block?.type === "image") return { type: "input_image", image_url: inlineMediaDataUrl(block) };
  if (block?.type === "audio") return serializeOpenAIInputAudioContentBlock(block);
  return { type: "input_text", text: JSON.stringify(block) };
}
