// core/media-adapters/volcengine.ts
import fs from "fs";
import path from "path";
import { saveImage } from "../media/download.ts";
import { resolveModelId } from "./model-catalog.ts";
import { t } from "../../lib/i18n.ts";

const FORMAT_TO_MIME = {
  png: "image/png",
  jpeg: "image/jpeg",
};

const OUTPUT_FORMATS = new Set(["jpeg", "png"]);

const SIZE_TABLE = {
  "1K": {
    "1:1": "1024x1024", "4:3": "1152x864", "3:4": "864x1152",
    "16:9": "1280x720", "9:16": "720x1280", "3:2": "1248x832",
    "2:3": "832x1248", "21:9": "1536x656",
  },
  "2K": {
    "1:1": "2048x2048", "4:3": "2304x1728", "3:4": "1728x2304",
    "16:9": "2736x1536", "9:16": "1536x2736", "3:2": "2496x1664",
    "2:3": "1664x2496", "21:9": "3136x1344",
  },
  "4K": {
    "1:1": "4096x4096", "4:3": "3456x2592", "3:4": "2592x3456",
    "16:9": "3840x2160", "9:16": "2160x3840", "3:2": "3840x2560",
    "2:3": "2560x3840", "21:9": "4096x1760",
  },
};
const SEEDREAM_RATIOS = Object.freeze(Object.keys(SIZE_TABLE["1K"]));

function normalizeSeedreamSizeTier(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const match = raw.toLowerCase().match(/^([124])\s*k$/);
  if (!match) return raw;
  return `${match[1]}K`;
}

function isPixelSize(value) {
  return /^\d{3,5}x\d{3,5}$/i.test(String(value || "").trim());
}

function supportedSeedreamPixelSizes(supportedResolutions) {
  const values = new Set();
  for (const resolution of supportedResolutions) {
    for (const size of Object.values(SIZE_TABLE[resolution] || {})) values.add(size);
  }
  return values;
}

function resolveSize(size, aspectRatio, providerDefaults, modelCapabilities) {
  const supportedResolutions = modelCapabilities.supportedResolutions;
  const effectiveRatio = aspectRatio || providerDefaults?.aspect_ratio || providerDefaults?.ratio || "3:2";
  const explicitSize = size || providerDefaults?.size || providerDefaults?.resolution || modelCapabilities.defaultResolution;
  const effectiveSize = normalizeSeedreamSizeTier(explicitSize);

  if (isPixelSize(effectiveSize)) {
    const allowed = supportedSeedreamPixelSizes(supportedResolutions);
    if (!allowed.has(effectiveSize)) {
      throw new Error(`Seedream size "${effectiveSize}" is unsupported for model "${modelCapabilities.modelId}"`);
    }
    return effectiveSize;
  }

  if (!supportedResolutions.includes(effectiveSize)) {
    throw new Error(`Seedream resolution "${explicitSize}" is unsupported for model "${modelCapabilities.modelId}"; supported resolutions: ${supportedResolutions.join(", ")}`);
  }
  if (!SEEDREAM_RATIOS.includes(effectiveRatio)) {
    throw new Error(`Seedream ratio "${effectiveRatio}" is unsupported`);
  }
  return SIZE_TABLE[effectiveSize][effectiveRatio];
}

function resolveOutputFormat(format) {
  const normalized = String(format || "jpeg").trim().toLowerCase();
  const value = normalized === "jpg" ? "jpeg" : normalized;
  if (!OUTPUT_FORMATS.has(value)) {
    throw new Error(t("plugin.imageGen.volcengineUnsupportedFormat", { format }));
  }
  return value;
}

function getModelCapabilities(modelId) {
  const id = String(modelId || "").toLowerCase();
  const isSeedream5 = id.includes("seedream-5-0") || id.includes("seedream5.0");
  const isSeedream3 = id.includes("seedream-3-0") || id.includes("seedream3.0");

  return {
    modelId,
    supportsOutputFormat: isSeedream5,
    supportsGuidanceScale: isSeedream3,
    supportsSeed: isSeedream3,
    supportsReferenceImages: !isSeedream3,
    supportedResolutions: isSeedream3 ? ["1K"] : ["1K", "2K", "4K"],
    defaultResolution: isSeedream3 ? "1K" : "4K",
  };
}

async function resolveVolcengineCredentials(ctx, preferredProviderId = null) {
  if (preferredProviderId) {
    const preferred = await ctx.bus.request("provider:credentials", { providerId: preferredProviderId });
    if (!preferred.error && preferred.apiKey) return preferred;
  }
  const primary = await ctx.bus.request("provider:credentials", { providerId: "volcengine" });
  if (!primary.error && primary.apiKey) return primary;

  const coding = await ctx.bus.request("provider:credentials", { providerId: "volcengine-coding" });
  if (!coding.error && coding.apiKey) return coding;

  return {
    error: primary.error || coding.error || "no_credentials",
  };
}

export const volcengineImageAdapter = {
  id: "volcengine",
  protocolId: "volcengine-images",
  aliases: ["volcengine-coding"],
  name: t("plugin.imageGen.volcengineAdapterName"),
  types: ["image"],
  capabilities: {
    ratios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"],
    resolutions: ["1K", "2K", "4K"],
  },

  async checkAuth(ctx) {
    try {
      const creds = await resolveVolcengineCredentials(ctx);
      if (creds.error || !creds.apiKey) {
        return { ok: false, message: creds.error || t("plugin.imageGen.apiKeyNotConfigured") };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err.message || String(err) };
    }
  },

  async submit(params, ctx) {
    // 1. Resolve model before any external work. A missing model uses the catalog
    //    default; an explicit unknown model must fail instead of silently using Lite.
    const rawModel = params.modelId || params.model || ctx.config?.get?.("defaultImageModel")?.id;
    const modelId = resolveModelId("volcengine", rawModel);

    // 2. Fetch credentials — try volcengine first, fall back to volcengine-coding
    const creds = await resolveVolcengineCredentials(ctx, params.credentialProviderId || params.providerId);
    if (creds.error || !creds.apiKey) {
      throw new Error(t("plugin.imageGen.providerNoApiKey", { providerId: "volcengine" }));
    }

    const { apiKey, baseUrl } = creds;

    // 3. Get provider defaults
    const allDefaults = ctx.config?.get?.("providerDefaults") || {};
    const providerDefaults = allDefaults["volcengine"] || {};

    // 4. Translate params → API body
    const modelCapabilities = getModelCapabilities(modelId);
    const body: any = {
      model: modelId,
      prompt: params.prompt,
      response_format: "b64_json",
      size: resolveSize(
        params.size || params.resolution,
        params.aspect_ratio || params.aspectRatio || params.ratio,
        providerDefaults,
        modelCapabilities,
      ),
    };

    let mimeType = "image/jpeg";
    if (modelCapabilities.supportsOutputFormat) {
      const outputFormat = resolveOutputFormat(params.format || providerDefaults?.format || "jpeg");
      body.output_format = outputFormat;
      mimeType = FORMAT_TO_MIME[outputFormat] || mimeType;
    }

    // 5. Handle reference image (local path → base64 data URL)
    if (params.image) {
      if (!modelCapabilities.supportsReferenceImages) {
        throw new Error(`Volcengine model "${modelId}" does not support reference images`);
      }
      const images = Array.isArray(params.image) ? params.image : [params.image];
      body.image = await Promise.all(images.map(async img => {
        if (path.isAbsolute(img) && fs.existsSync(img)) {
          const buf = await fs.promises.readFile(img);
          const ext = path.extname(img).slice(1).toLowerCase();
          const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" }[ext] || "image/png";
          return `data:${mime};base64,${buf.toString("base64")}`;
        }
        return img; // URL 或已经是 base64
      }));
    }

    // Apply provider-specific defaults (watermark defaults to false)
    body.watermark = params.watermark ?? providerDefaults?.watermark ?? false;
    if (providerDefaults || params) {
      const guidanceScale = params.guidance_scale ?? params.guidanceScale ?? providerDefaults.guidance_scale ?? providerDefaults.guidanceScale;
      if (modelCapabilities.supportsGuidanceScale && guidanceScale !== undefined) {
        body.guidance_scale = guidanceScale;
      }
      const seed = params.seed ?? providerDefaults.seed;
      if (modelCapabilities.supportsSeed && seed !== undefined) {
        body.seed = seed;
      }
    }

    // 6. Call HTTP API
    const url = `${baseUrl.replace(/\/+$/, "")}/images/generations`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      let msg = `API error ${res.status}`;
      try {
        const err = await res.json();
        if (err.error?.message) msg = `${msg}: ${err.error.message}`;
      } catch {}
      throw new Error(msg);
    }

    const data = await res.json();
    const responseImages = data.data || [];
    if (responseImages.length === 0) {
      throw new Error("API returned no images");
    }

    // 7. Save files using saveImage() — it appends /generated/ internally, so pass ctx.dataDir
    const taskId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const files = [];
    for (let i = 0; i < responseImages.length; i++) {
      const buffer = Buffer.from(responseImages[i].b64_json, "base64");
      const customName = params.filename
        ? (responseImages.length > 1 ? `${params.filename}-${i + 1}` : params.filename)
        : null;
      const { filename } = await saveImage(buffer, mimeType, ctx.dataDir, customName);
      files.push(filename);
    }

    // 8. Return taskId + files
    return { taskId, files };
  },
  // No query() needed — files returned in submit = fake-async
};
