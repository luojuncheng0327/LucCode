const OPENAI_MIN_PIXELS = 655_360;
const OPENAI_MAX_PIXELS = 8_294_400;
const OPENAI_MAX_EDGE = 3840;
const OPENAI_MAX_RATIO = 3;

const OPENAI_TIER_LONG_EDGE = {
  "1k": 1024,
  "2k": 2048,
  "4k": 3840,
};

const OPENAI_STANDARD_SIZES_BY_RATIO = {
  "1:1": "1024x1024",
  "3:2": "1536x1024",
  "2:3": "1024x1536",
};

const OPENAI_STANDARD_SIZES = Object.freeze(["1024x1024", "1536x1024", "1024x1536"]);

export const OPENAI_IMAGE_RATIOS = Object.freeze([
  "1:1",
  "4:3",
  "3:4",
  "16:9",
  "9:16",
  "3:2",
  "2:3",
  "21:9",
]);

export const OPENAI_STANDARD_IMAGE_RATIOS = Object.freeze([
  "1:1",
  "3:2",
  "2:3",
]);

export const OPENAI_FLEXIBLE_IMAGE_RATIOS = OPENAI_IMAGE_RATIOS;

export const OPENAI_STANDARD_RESOLUTION_TIERS = Object.freeze(["1K"]);
export const OPENAI_FLEXIBLE_RESOLUTION_TIERS = Object.freeze(["1K", "2K", "4K"]);
export const CODEX_IMAGE_RESOLUTION_TIERS = Object.freeze(["1K", "2K"]);
export const IMAGE_RESOLUTION_TIERS = OPENAI_FLEXIBLE_RESOLUTION_TIERS;

function errorPrefix(sourceName) {
  return sourceName ? `${sourceName} ` : "";
}

function parseRatio(value) {
  const match = String(value || "").trim().match(/^(\d+)\s*:\s*(\d+)$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { label: `${width}:${height}`, value: width / height };
}

function parsePixelSize(value) {
  const match = String(value || "").trim().match(/^(\d{2,5})\s*[x*]\s*(\d{2,5})$/i);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height, size: `${width}x${height}` };
}

export function normalizeResolutionTier(value, source = "resolution") {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const normalized = raw.toLowerCase();
  if (normalized === "auto") return "auto";
  const match = normalized.match(/^([124])\s*k$/);
  if (match) return `${match[1]}k`;
  throw new Error(`image ${source} "${raw}" is unsupported`);
}

function normalizedSupportedResolutions(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  return values.map((value) => normalizeResolutionTier(value)).filter(Boolean);
}

function assertSupportedResolutionTier(tier, rawValue, supportedResolutions, sourceName = "OpenAI image") {
  const supported = normalizedSupportedResolutions(supportedResolutions);
  if (!supported || supported.includes(tier)) return;
  throw new Error(`${errorPrefix(sourceName)}resolution "${rawValue}" is unsupported; supported resolutions: ${supportedResolutions.join(", ")}`);
}

export function normalizeRatio(value, supportedRatios = OPENAI_IMAGE_RATIOS, sourceName = "image") {
  if (!value) return null;
  const parsed = parseRatio(value);
  if (!parsed || !supportedRatios.includes(parsed.label)) {
    throw new Error(`${errorPrefix(sourceName)}ratio "${value}" is unsupported`);
  }
  return parsed.label;
}

function validateOpenAiFlexiblePixelSize(pixelSize, sourceName = "OpenAI image", constraints: any = {}) {
  const { width, height, size } = pixelSize;
  const maxEdge = constraints.maxEdge || OPENAI_MAX_EDGE;
  const maxPixels = constraints.maxPixels || OPENAI_MAX_PIXELS;
  const minPixels = constraints.minPixels || OPENAI_MIN_PIXELS;
  const maxRatio = constraints.maxRatio || OPENAI_MAX_RATIO;
  if (width % 16 !== 0 || height % 16 !== 0) {
    throw new Error(`${errorPrefix(sourceName)}size "${size}" is unsupported: width and height must be multiples of 16`);
  }
  if (Math.max(width, height) > maxEdge) {
    throw new Error(`${errorPrefix(sourceName)}size "${size}" is unsupported: maximum edge is ${maxEdge}px`);
  }
  const edgeRatio = Math.max(width, height) / Math.min(width, height);
  if (edgeRatio > maxRatio) {
    throw new Error(`${errorPrefix(sourceName)}size "${size}" is unsupported: aspect ratio exceeds ${maxRatio}:1`);
  }
  const pixels = width * height;
  if (pixels < minPixels || pixels > maxPixels) {
    throw new Error(`${errorPrefix(sourceName)}size "${size}" is unsupported: total pixels must be between ${minPixels} and ${maxPixels}`);
  }
  return size;
}

function nearestOpenAiStandardSize(ratioLabel = "1:1", sourceName = "OpenAI image") {
  const ratio = parseRatio(ratioLabel);
  if (!ratio) throw new Error(`${errorPrefix(sourceName)}ratio "${ratioLabel}" is unsupported`);
  let best = null;
  for (const size of OPENAI_STANDARD_SIZES) {
    const pixelSize = parsePixelSize(size);
    const actualRatio = pixelSize.width / pixelSize.height;
    const ratioError = Math.abs(Math.log(actualRatio / ratio.value));
    const candidate = { size, pixels: pixelSize.width * pixelSize.height, ratioError };
    if (
      !best
      || candidate.ratioError < best.ratioError
      || (candidate.ratioError === best.ratioError && candidate.pixels > best.pixels)
    ) {
      best = candidate;
    }
  }
  return best.size;
}

function nearestOpenAiFlexibleSize(tier, ratioLabel, sourceName = "OpenAI image", constraints: any = {}) {
  const normalizedTier = normalizeResolutionTier(tier, "resolution") || "1k";
  if (normalizedTier === "auto") return "auto";
  const ratio = parseRatio(ratioLabel || "1:1");
  if (!ratio) throw new Error(`${errorPrefix(sourceName)}ratio "${ratioLabel}" is unsupported`);

  const targetLongEdge = OPENAI_TIER_LONG_EDGE[normalizedTier];
  const maxEdge = constraints.maxEdge || OPENAI_MAX_EDGE;
  const maxPixels = constraints.maxPixels || OPENAI_MAX_PIXELS;
  const minPixels = constraints.minPixels || OPENAI_MIN_PIXELS;
  const maxRatio = constraints.maxRatio || OPENAI_MAX_RATIO;
  if (!targetLongEdge) {
    throw new Error(`${errorPrefix(sourceName)}resolution "${tier}" is unsupported`);
  }

  let best = null;
  for (let width = 16; width <= maxEdge; width += 16) {
    const idealHeight = width / ratio.value;
    const roundedHeight = Math.max(16, Math.round(idealHeight / 16) * 16);
    for (const height of [roundedHeight - 16, roundedHeight, roundedHeight + 16]) {
      if (height < 16 || height > maxEdge || height % 16 !== 0) continue;
      const edgeRatio = Math.max(width, height) / Math.min(width, height);
      if (edgeRatio > maxRatio) continue;
      const pixels = width * height;
      if (pixels < minPixels || pixels > maxPixels) continue;

      const longEdge = Math.max(width, height);
      const actualRatio = width / height;
      const ratioError = Math.abs(Math.log(actualRatio / ratio.value));
      const longEdgeError = normalizedTier === "4k"
        ? Math.max(0, targetLongEdge - longEdge)
        : Math.abs(longEdge - targetLongEdge);
      const pixelScore = normalizedTier === "4k" ? -pixels : Math.abs(pixels - targetLongEdge * targetLongEdge);
      const candidate = { width, height, pixels, ratioError, longEdgeError, pixelScore };

      if (
        !best
        || candidate.longEdgeError < best.longEdgeError
        || (candidate.longEdgeError === best.longEdgeError && candidate.ratioError < best.ratioError)
        || (
          candidate.longEdgeError === best.longEdgeError
          && candidate.ratioError === best.ratioError
          && candidate.pixelScore < best.pixelScore
        )
      ) {
        best = candidate;
      }
    }
  }

  if (!best) {
    throw new Error(`${errorPrefix(sourceName)}could not resolve ${normalizedTier} ${ratioLabel || "1:1"} to a supported size`);
  }
  return `${best.width}x${best.height}`;
}

function normalizeOpenAiSizeInput(value, { ratio, flexible, sourceName, supportedResolutions, constraints }) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (raw.toLowerCase() === "auto") return "auto";

  const pixelSize = parsePixelSize(raw);
  if (pixelSize) {
    if (flexible) return validateOpenAiFlexiblePixelSize(pixelSize, sourceName, constraints);
    if (Object.values(OPENAI_STANDARD_SIZES_BY_RATIO).includes(pixelSize.size)) return pixelSize.size;
    throw new Error(`${errorPrefix(sourceName)}size "${raw}" is unsupported`);
  }

  const tier = normalizeResolutionTier(raw, "size");
  if (tier) {
    assertSupportedResolutionTier(tier, raw, supportedResolutions, sourceName);
    return flexible
      ? nearestOpenAiFlexibleSize(tier, ratio || "1:1", sourceName, constraints)
      : nearestOpenAiStandardSize(ratio || "1:1", sourceName);
  }

  throw new Error(`${errorPrefix(sourceName)}size "${raw}" is unsupported`);
}

export function resolveOpenAiImageSize( params: any = {}, providerDefaults: any = {}, options: any = {}): string | null {
  const sourceName = options.sourceName || "OpenAI image";
  const flexible = options.flexible !== false;
  const supportedRatios = options.supportedRatios || (flexible ? OPENAI_FLEXIBLE_IMAGE_RATIOS : OPENAI_STANDARD_IMAGE_RATIOS);
  const supportedResolutions = options.supportedResolutions || (flexible ? OPENAI_FLEXIBLE_RESOLUTION_TIERS : OPENAI_STANDARD_RESOLUTION_TIERS);
  const constraints = options.constraints || {};
  const effectiveRatio = params.aspect_ratio
    || params.aspectRatio
    || params.ratio
    || providerDefaults.aspect_ratio
    || providerDefaults.aspectRatio
    || providerDefaults.ratio
    || options.defaultRatio;
  const ratio = normalizeRatio(effectiveRatio, supportedRatios, sourceName);

  if (params.size) {
    return normalizeOpenAiSizeInput(params.size, { ratio, flexible, sourceName, supportedResolutions, constraints });
  }

  if (params.resolution) {
    return normalizeOpenAiSizeInput(params.resolution, { ratio: ratio || "1:1", flexible, sourceName, supportedResolutions, constraints });
  }

  if (ratio) {
    const defaultResolution = providerDefaults.resolution || options.defaultResolution;
    if (defaultResolution) {
      return normalizeOpenAiSizeInput(defaultResolution, { ratio, flexible, sourceName, supportedResolutions, constraints });
    }
    return nearestOpenAiStandardSize(ratio, sourceName);
  }

  if (providerDefaults.size) {
    return normalizeOpenAiSizeInput(providerDefaults.size, { ratio, flexible, sourceName, supportedResolutions, constraints });
  }

  if (providerDefaults.resolution) {
    return normalizeOpenAiSizeInput(providerDefaults.resolution, { ratio: options.defaultRatio || "1:1", flexible, sourceName, supportedResolutions, constraints });
  }

  return null;
}
