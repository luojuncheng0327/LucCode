import { Buffer } from "node:buffer";
import * as piSdk from "../lib/pi-sdk/index.ts";

export const MODEL_IMAGE_INPUT_POLICY = Object.freeze({
  maxWidth: 2000,
  maxHeight: 2000,
  // Same headroom used by Pi SDK's CLI/read-tool image path.
  maxImageBase64Bytes: 4.5 * 1024 * 1024,
  // Keep the whole JSON request comfortably below common 32 MB provider caps.
  totalBase64BudgetBytes: 24 * 1024 * 1024,
  jpegQuality: 80,
});

function imagePreprocessError(message: any) {
  const error: any = new Error(`image input preprocessing failed: ${message}`);
  error.code = "IMAGE_INPUT_PREPROCESS_FAILED";
  return error;
}

function byteLengthBase64(data) {
  return Buffer.byteLength(String(data || ""), "utf-8");
}

function normalizePolicy(policy = {}) {
  const merged = { ...MODEL_IMAGE_INPUT_POLICY, ...(policy || {}) };
  const numericKeys = [
    "maxWidth",
    "maxHeight",
    "maxImageBase64Bytes",
    "totalBase64BudgetBytes",
    "jpegQuality",
  ];
  for (const key of numericKeys) {
    if (!Number.isFinite(merged[key]) || merged[key] <= 0) {
      throw imagePreprocessError(`invalid policy.${key}`);
    }
  }
  return merged;
}

function assertImageInput(image, index) {
  if (!image || typeof image !== "object") {
    throw imagePreprocessError(`image ${index + 1} is not an object`);
  }
  if (image.type && image.type !== "image") {
    throw imagePreprocessError(`image ${index + 1} has unsupported type "${image.type}"`);
  }
  if (typeof image.data !== "string" || image.data.length === 0) {
    throw imagePreprocessError(`image ${index + 1} has empty base64 data`);
  }
  if (image.mimeType && !String(image.mimeType).startsWith("image/")) {
    throw imagePreprocessError(`image ${index + 1} has unsupported mimeType "${image.mimeType}"`);
  }
}

function parseImageData(data, index) {
  const raw = String(data || "").trim();
  const dataUrlMatch = raw.match(/^data:([^;,]+);base64,(.*)$/is);
  if (raw.startsWith("data:") && !dataUrlMatch) {
    throw imagePreprocessError(`image ${index + 1} has malformed data URL`);
  }
  return {
    declaredMimeType: dataUrlMatch?.[1]?.trim().toLowerCase() || "",
    base64: dataUrlMatch ? dataUrlMatch[2] : raw,
  };
}

function decodeBase64Image(data, index) {
  const compact = String(data || "").replace(/\s+/g, "");
  if (!compact) {
    throw imagePreprocessError(`image ${index + 1} has empty base64 data`);
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) {
    throw imagePreprocessError(`image ${index + 1} has malformed base64 data`);
  }
  const padded = compact + "=".repeat((4 - (compact.length % 4)) % 4);
  const bytes = Buffer.from(padded, "base64");
  if (!bytes.length) {
    throw imagePreprocessError(`image ${index + 1} has empty image bytes`);
  }
  const canonical = bytes.toString("base64").replace(/=+$/, "");
  const source = compact.replace(/=+$/, "");
  if (canonical !== source) {
    throw imagePreprocessError(`image ${index + 1} has malformed base64 data`);
  }
  return bytes;
}

function sniffImageMimeType(bytes) {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  if (
    bytes.length >= 6 &&
    (bytes.toString("ascii", 0, 6) === "GIF87a" || bytes.toString("ascii", 0, 6) === "GIF89a")
  ) {
    return "image/gif";
  }
  return "";
}

export function normalizeModelImageInput(image, index = 0) {
  assertImageInput(image, index);
  const parsed = parseImageData(image.data, index);
  if (parsed.declaredMimeType && !parsed.declaredMimeType.startsWith("image/")) {
    throw imagePreprocessError(`image ${index + 1} has unsupported mimeType "${parsed.declaredMimeType}"`);
  }
  const bytes = decodeBase64Image(parsed.base64, index);
  const detectedMimeType = sniffImageMimeType(bytes);
  if (!detectedMimeType) {
    throw imagePreprocessError(`image ${index + 1} has unsupported or corrupt image bytes`);
  }
  return {
    ...image,
    type: "image",
    data: bytes.toString("base64"),
    mimeType: detectedMimeType,
  };
}

function escapeXmlAttr(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeXmlText(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function buildDimensionNoteLine(note, _path, index) {
  const name = `image-${index + 1}`;
  return `<file name="${escapeXmlAttr(name)}">${escapeXmlText(note)}</file>`;
}

function appendDimensionNotes(text, notes) {
  if (!notes.length) return text;
  const noteText = notes.map(({ note, path, index }) => buildDimensionNoteLine(note, path, index)).join("\n");
  const sourceText = typeof text === "string" ? text : String(text ?? "");
  if (!sourceText) return noteText;

  const lines = sourceText.split("\n");
  let markerEnd = 0;
  while (markerEnd < lines.length && /^\[attached_image: .+\]$/.test(lines[markerEnd])) {
    markerEnd += 1;
  }

  if (markerEnd === 0) return `${noteText}\n${sourceText}`;
  const before = lines.slice(0, markerEnd).join("\n");
  const after = lines.slice(markerEnd).join("\n");
  return after ? `${before}\n${noteText}\n${after}` : `${before}\n${noteText}`;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  throw error;
}

export async function prepareSingleModelImageInputForPrompt({
  image,
  index = 0,
  imageCount = 1,
  imagePolicy,
  resizeImage,
  formatDimensionNote,
  signal,
}: {
  image?: any;
  index?: number;
  imageCount?: number;
  imagePolicy?: any;
  resizeImage?: any;
  formatDimensionNote?: any;
  signal?: AbortSignal;
} = {}) {
  const effectiveResizeImage = resizeImage ?? piSdk.resizeModelImageInput;
  const effectiveFormatDimensionNote = formatDimensionNote ?? piSdk.formatModelImageDimensionNote;
  if (typeof effectiveResizeImage !== "function") {
    throw imagePreprocessError("image resize adapter unavailable");
  }
  if (typeof effectiveFormatDimensionNote !== "function") {
    throw imagePreprocessError("image dimension-note adapter unavailable");
  }

  const policy = normalizePolicy(imagePolicy);
  const safeImageCount = Math.max(1, Math.floor(Number(imageCount) || 1));
  const perImageMaxBytes = Math.max(
    1,
    Math.floor(Math.min(policy.maxImageBase64Bytes, policy.totalBase64BudgetBytes / safeImageCount))
  );
  const resizeOptions = {
    maxWidth: policy.maxWidth,
    maxHeight: policy.maxHeight,
    maxBytes: perImageMaxBytes,
    jpegQuality: policy.jpegQuality,
  };

  throwIfAborted(signal);
  const normalized = normalizeModelImageInput(image, index);
  const resized = await effectiveResizeImage(normalized, resizeOptions);
  throwIfAborted(signal);

  if (!resized?.data) {
    throw imagePreprocessError(
      `image ${index + 1} could not be compressed below ${perImageMaxBytes} base64 bytes`
    );
  }

  const preparedImage = normalizeModelImageInput({
    ...normalized,
    type: "image",
    data: resized.data,
    mimeType: resized.mimeType || normalized.mimeType,
  }, index);

  return {
    image: preparedImage,
    note: await effectiveFormatDimensionNote(resized),
    resizeOptions,
    resizeResult: resized,
  };
}

/**
 * Normalize image payloads before they reach Pi SDK's AgentSession.prompt().
 *
 * Pi SDK does not currently resize images supplied via prompt options. Its CLI
 * file processor and read tool do resize, so Luc applies the same policy at
 * the model-input boundary and keeps UI/session-file ownership untouched.
 *
 * @param {object} params
 * @param {string} params.text
 * @param {object} [params.opts]
 * @param {object} [params.imagePolicy]
 * @param {(image: object, options: object) => Promise<object|null>} [params.resizeImage]
 * @param {(result: object) => string|undefined|Promise<string|undefined>} [params.formatDimensionNote]
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{text: string, opts: object|undefined}>}
 */
export async function prepareModelImageInputsForPrompt({
  text,
  opts,
  imagePolicy,
  resizeImage,
  formatDimensionNote,
  signal,
}: {
  text?: any;
  opts?: any;
  imagePolicy?: any;
  resizeImage?: any;
  formatDimensionNote?: any;
  signal?: AbortSignal;
} = {}) {
  if (!Array.isArray(opts?.images) || opts.images.length === 0) {
    return { text, opts };
  }
  if (opts.modelImageInputsPrepared) {
    return { text, opts };
  }

  const policy = normalizePolicy(imagePolicy);
  const nextImages = [];
  const dimensionNotes = [];

  for (let index = 0; index < opts.images.length; index += 1) {
    const prepared = await prepareSingleModelImageInputForPrompt({
      image: opts.images[index],
      index,
      imageCount: opts.images.length,
      imagePolicy: policy,
      resizeImage,
      formatDimensionNote,
      signal,
    });
    nextImages.push(prepared.image);

    const note = prepared.note;
    if (note) {
      dimensionNotes.push({
        note,
        index,
        path: Array.isArray(opts.imageAttachmentPaths) ? opts.imageAttachmentPaths[index] : undefined,
      });
    }
  }

  const totalBytes = nextImages.reduce((sum, image) => sum + byteLengthBase64(image.data), 0);
  if (totalBytes > policy.totalBase64BudgetBytes) {
    throw imagePreprocessError(
      `compressed images exceed the ${policy.totalBase64BudgetBytes} base64-byte request budget`
    );
  }

  return {
    text: appendDimensionNotes(text, dimensionNotes),
    opts: {
      ...opts,
      images: nextImages,
      modelImageInputsPrepared: true,
    },
  };
}
