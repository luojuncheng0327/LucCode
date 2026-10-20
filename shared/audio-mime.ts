export const ALLOWED_CHAT_AUDIO_MIME_TYPES = Object.freeze([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/mp4",
  "audio/ogg",
  "audio/flac",
]);

export const ALLOWED_UPLOAD_AUDIO_MIME_TYPES = Object.freeze([
  ...ALLOWED_CHAT_AUDIO_MIME_TYPES,
  "audio/webm",
]);

export const MAX_CHAT_AUDIO_BASE64_CHARS = 50 * 1024 * 1024;

const MIME_TO_EXT = Object.freeze({
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/mp4": ".m4a",
  "audio/ogg": ".ogg",
  "audio/flac": ".flac",
  "audio/webm": ".weba",
});

const MIME_TO_FORMAT = Object.freeze({
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "audio/webm": "webm",
});

const OPENAI_INPUT_AUDIO_FORMATS = Object.freeze(new Set(["wav", "mp3"]));

export function normalizeAudioMimeType(mimeType) {
  return typeof mimeType === "string" ? mimeType.trim().toLowerCase() : "";
}

export function isAllowedChatAudioMime(mimeType) {
  return ALLOWED_CHAT_AUDIO_MIME_TYPES.includes(normalizeAudioMimeType(mimeType));
}

export function isAllowedUploadAudioMime(mimeType) {
  return ALLOWED_UPLOAD_AUDIO_MIME_TYPES.includes(normalizeAudioMimeType(mimeType));
}

export function extensionFromChatAudioMime(mimeType) {
  return MIME_TO_EXT[normalizeAudioMimeType(mimeType)] || "";
}

export function audioFormatFromMimeType(mimeType) {
  return MIME_TO_FORMAT[normalizeAudioMimeType(mimeType)] || "";
}

export function openAIInputAudioFormatFromMimeType(mimeType) {
  const format = audioFormatFromMimeType(mimeType);
  return OPENAI_INPUT_AUDIO_FORMATS.has(format) ? format : "";
}

export function isChatAudioBase64WithinLimit(base64Data) {
  return typeof base64Data === "string" && base64Data.length <= MAX_CHAT_AUDIO_BASE64_CHARS;
}
