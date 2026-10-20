import fs from "fs";
import path from "path";
import {
  createLocalTaskId,
  downloadImageUrls,
  normalizeBaseUrl,
  normalizeImageInput,
  saveBase64Images,
} from "./common.ts";
import { t } from "../../lib/i18n.ts";

const DEFAULT_BASE_URL = "https://apihub.agnes-ai.com/v1";
const DEFAULT_IMAGE_MODEL = "agnes-image-2.1-flash";
const DEFAULT_VIDEO_MODEL = "agnes-video-v2.0";
const DEFAULT_VIDEO_FRAME_RATE = 24;
const DEFAULT_VIDEO_RATIO = "3:2";
const DEFAULT_VIDEO_RESOLUTION = "720p";
const DEFAULT_VIDEO_DURATION = 5;
const MIN_VIDEO_FRAMES = 81;
const MAX_VIDEO_FRAMES = 441;

const AGNES_IMAGE_SIZES = {
  "1:1": "1024x1024",
  "4:3": "1024x768",
  "3:4": "768x1024",
  "3:2": "1152x768",
  "2:3": "768x1152",
  "16:9": "1344x768",
  "9:16": "768x1344",
  "21:9": "1536x640",
};

const AGNES_VIDEO_SIZES = {
  "3:2": { width: 1152, height: 768, resolution: DEFAULT_VIDEO_RESOLUTION },
};
const AGNES_VIDEO_SIZE_VALUES = Object.values(AGNES_VIDEO_SIZES).map((size) => `${size.width}x${size.height}`);

function stripV1(base) {
  return String(base || "").replace(/\/+$/, "").replace(/\/v1$/i, "");
}

function agnesV1Base(baseUrl) {
  const base = normalizeBaseUrl(baseUrl, DEFAULT_BASE_URL);
  return base.endsWith("/v1") ? base : `${base}/v1`;
}

function agnesRootBase(baseUrl) {
  return stripV1(normalizeBaseUrl(baseUrl, DEFAULT_BASE_URL));
}

async function getCredentials(ctx, params: any = {}) {
  const providerId = params.credentialProviderId || params.providerId || "agnes";
  const creds = await ctx.bus.request("provider:credentials", { providerId });
  if (creds.error || !creds.apiKey) {
    throw new Error(t("plugin.imageGen.providerNoApiKey", { providerId }));
  }
  return creds;
}

function resolveImageSize(params, providerDefaults: any = {}) {
  const explicit = params.size || params.resolution || providerDefaults.size || providerDefaults.resolution;
  const ratio = params.aspect_ratio || params.aspectRatio || params.ratio || providerDefaults.aspect_ratio || providerDefaults.ratio;
  if (typeof explicit === "string" && /^\d+x\d+$/i.test(explicit.trim())) {
    const size = explicit.trim();
    if (!Object.values(AGNES_IMAGE_SIZES).includes(size)) {
      throw new Error(`Agnes image size "${size}" is unsupported`);
    }
    return size;
  }
  if (explicit) {
    const resolution = String(explicit).trim().toUpperCase();
    if (resolution !== "1K") {
      throw new Error(`Agnes image resolution "${explicit}" is unsupported; supported resolutions: 1K`);
    }
  }
  const effectiveRatio = ratio || "3:2";
  const size = AGNES_IMAGE_SIZES[effectiveRatio];
  if (!size) {
    throw new Error(`Agnes image ratio "${effectiveRatio}" is unsupported`);
  }
  return size;
}

function collectResponseImages(data) {
  const images = Array.isArray(data?.data) ? data.data : [];
  const base64 = [];
  const urls = [];
  for (const item of images) {
    if (typeof item?.b64_json === "string" && item.b64_json.trim()) base64.push(item.b64_json.trim());
    if (typeof item?.url === "string" && item.url.trim()) urls.push(item.url.trim());
  }
  return { base64, urls };
}

function safeFilenameBase(value, fallback) {
  const text = String(value || fallback || "agnes-video").trim();
  return text
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^\w\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff-]/g, "_")
    .slice(0, 80) || "agnes-video";
}

function extensionFromContentType(contentType) {
  const type = String(contentType || "").toLowerCase();
  if (type.includes("webm")) return "webm";
  if (type.includes("quicktime")) return "mov";
  return "mp4";
}

async function downloadVideoUrl(url, dataDir, filenameBase) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download video failed ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const ext = extensionFromContentType(res.headers?.get?.("content-type"));
  const filename = `${safeFilenameBase(filenameBase, "agnes-video")}.${ext}`;
  const dir = path.join(dataDir, "generated");
  fs.mkdirSync(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, filename), buffer);
  return filename;
}

function resolveVideoSize(params, providerDefaults: any = {}) {
  const resolution = params.video_resolution
    || params.videoResolution
    || params.resolution
    || providerDefaults.video_resolution
    || providerDefaults.videoResolution
    || providerDefaults.resolution
    || DEFAULT_VIDEO_RESOLUTION;
  if (String(resolution).trim().toLowerCase() !== DEFAULT_VIDEO_RESOLUTION) {
    throw new Error(`Agnes video resolution "${resolution}" is unsupported; supported resolutions: ${DEFAULT_VIDEO_RESOLUTION}`);
  }

  const explicitSize = params.size || providerDefaults.size;
  if (explicitSize) {
    const size = String(explicitSize).trim().toLowerCase();
    if (!AGNES_VIDEO_SIZE_VALUES.includes(size)) {
      throw new Error(`Agnes video size "${explicitSize}" is unsupported; supported sizes: ${AGNES_VIDEO_SIZE_VALUES.join(", ")}`);
    }
    const [width, height] = size.split("x").map((part) => Number(part));
    return { width, height };
  }

  const hasWidth = params.width !== undefined || providerDefaults.width !== undefined;
  const hasHeight = params.height !== undefined || providerDefaults.height !== undefined;
  if (hasWidth || hasHeight) {
    const width = Number(params.width ?? providerDefaults.width);
    const height = Number(params.height ?? providerDefaults.height);
    const size = `${width}x${height}`;
    if (!Number.isInteger(width) || !Number.isInteger(height) || !AGNES_VIDEO_SIZE_VALUES.includes(size)) {
      throw new Error(`Agnes video size "${size}" is unsupported; supported sizes: ${AGNES_VIDEO_SIZE_VALUES.join(", ")}`);
    }
    return { width, height };
  }

  const ratio = params.aspect_ratio
    || params.aspectRatio
    || params.ratio
    || providerDefaults.aspect_ratio
    || providerDefaults.aspectRatio
    || providerDefaults.ratio
    || DEFAULT_VIDEO_RATIO;
  const size = AGNES_VIDEO_SIZES[ratio];
  if (!size) {
    throw new Error(`Agnes video ratio "${ratio}" is unsupported; supported ratios: ${Object.keys(AGNES_VIDEO_SIZES).join(", ")}`);
  }
  return { width: size.width, height: size.height };
}

function resolveVideoFrameCount(params, providerDefaults: any = {}) {
  const frameRate = Number(params.frameRate ?? params.frame_rate ?? providerDefaults.frameRate ?? providerDefaults.frame_rate ?? DEFAULT_VIDEO_FRAME_RATE);
  const explicitRaw = params.numFrames ?? params.num_frames ?? providerDefaults.numFrames ?? providerDefaults.num_frames;
  const hasExplicit = explicitRaw !== undefined && explicitRaw !== null && explicitRaw !== "";
  const explicit = Number(explicitRaw);
  if (!Number.isInteger(frameRate) || frameRate < 1 || frameRate > 60) {
    throw new Error(`Agnes video frame_rate "${frameRate}" is unsupported; supported range: 1-60`);
  }
  if (hasExplicit) {
    const numFrames = Math.floor(explicit);
    if (!Number.isInteger(explicit) || numFrames < MIN_VIDEO_FRAMES || numFrames > MAX_VIDEO_FRAMES || (numFrames - 1) % 8 !== 0) {
      throw new Error(`Agnes video num_frames "${explicit}" is unsupported; it must be 8n+1 between ${MIN_VIDEO_FRAMES} and ${MAX_VIDEO_FRAMES}`);
    }
    return { frameRate, numFrames };
  }
  const duration = Number(params.duration ?? params.seconds ?? providerDefaults.duration ?? providerDefaults.seconds ?? DEFAULT_VIDEO_DURATION);
  if (!Number.isInteger(duration) || duration < 3 || duration > 18) {
    throw new Error(`Agnes video duration "${duration}" is unsupported; supported range: 3-18 seconds`);
  }
  const targetFrames = Math.round(duration * frameRate) + 1;
  if (targetFrames < MIN_VIDEO_FRAMES || targetFrames > MAX_VIDEO_FRAMES || (targetFrames - 1) % 8 !== 0) {
    throw new Error(`Agnes video duration "${duration}" with frame_rate "${frameRate}" cannot be represented as a supported 8n+1 frame count`);
  }
  return { frameRate, numFrames: targetFrames };
}

function videoUrlFromResponse(data) {
  for (const key of ["remixed_from_video_id", "video_url", "url", "output_url"]) {
    if (typeof data?.[key] === "string" && /^https?:\/\//i.test(data[key])) return data[key];
  }
  if (Array.isArray(data?.data)) {
    for (const item of data.data) {
      const url = videoUrlFromResponse(item);
      if (url) return url;
    }
  }
  return null;
}

async function parseJsonOrNull(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export const agnesImageAdapter = {
  id: "agnes-images",
  protocolId: "agnes-images",
  name: "Agnes Image",
  types: ["image"],
  capabilities: {
    ratios: Object.keys(AGNES_IMAGE_SIZES),
    resolutions: ["1K"],
  },

  async checkAuth(ctx) {
    try {
      await getCredentials(ctx, { providerId: "agnes" });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err.message || String(err) };
    }
  },

  async submit(params, ctx) {
    const creds = await getCredentials(ctx, params);
    const mediaProviderId = params.providerId || "agnes";
    const allDefaults = ctx.config?.get?.("providerDefaults") || {};
    const providerDefaults = allDefaults[mediaProviderId] || {};
    const modelId = params.modelId || params.model || providerDefaults.model || DEFAULT_IMAGE_MODEL;
    const images = normalizeImageInput(params.image);
    const extraBody: any = {
      response_format: "b64_json",
      ...(images.length > 0 ? { image: images } : {}),
    };
    const body: any = {
      model: modelId,
      prompt: params.prompt,
      extra_body: extraBody,
    };
    const size = resolveImageSize(params, providerDefaults);
    if (size) body.size = size;

    const res = await fetch(`${agnesV1Base(creds.baseUrl)}/images/generations`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${creds.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      let msg = `API error ${res.status}`;
      try {
        const err = await res.json();
        if (err.error?.message) msg = `${msg}: ${err.error.message}`;
        else if (err.message) msg = `${msg}: ${err.message}`;
      } catch {}
      throw new Error(msg);
    }

    const data = await res.json();
    const { base64, urls } = collectResponseImages(data);
    if (base64.length > 0) {
      const files = await saveBase64Images(base64, "image/png", ctx.dataDir, params.filename);
      return { taskId: createLocalTaskId(), files };
    }
    if (urls.length > 0) {
      const files = await downloadImageUrls(urls, ctx.dataDir, params.filename);
      return { taskId: createLocalTaskId(), files };
    }
    throw new Error("Agnes image API returned no images");
  },
};

export const agnesVideoAdapter = {
  id: "agnes-videos",
  protocolId: "agnes-videos",
  name: "Agnes Video",
  types: ["video"],
  capabilities: {
    ratios: Object.keys(AGNES_VIDEO_SIZES),
    resolutions: [DEFAULT_VIDEO_RESOLUTION],
  },

  async checkAuth(ctx) {
    try {
      await getCredentials(ctx, { providerId: "agnes" });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err.message || String(err) };
    }
  },

  async submit(params, ctx) {
    const creds = await getCredentials(ctx, params);
    const mediaProviderId = params.providerId || "agnes";
    const allDefaults = ctx.videoConfig?.get?.("providerDefaults") ?? ctx.config?.get?.("providerDefaults") ?? {};
    const providerDefaults = allDefaults[mediaProviderId] || {};
    const modelId = params.modelId || params.model || providerDefaults.model || DEFAULT_VIDEO_MODEL;
    const size = resolveVideoSize(params, providerDefaults);
    const { frameRate, numFrames } = resolveVideoFrameCount(params, providerDefaults);
    const images = normalizeImageInput(params.image);
    const body: any = {
      model: modelId,
      prompt: params.prompt,
      width: size.width,
      height: size.height,
      frame_rate: frameRate,
      num_frames: numFrames,
    };
    if (images.length === 1) {
      body.image = images[0];
    } else if (images.length > 1) {
      body.extra_body = { image: images };
    }

    const res = await fetch(`${agnesV1Base(creds.baseUrl)}/videos`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${creds.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      let msg = `API error ${res.status}`;
      try {
        const err = await res.json();
        if (err.error?.message) msg = `${msg}: ${err.error.message}`;
        else if (err.message) msg = `${msg}: ${err.message}`;
      } catch {}
      throw new Error(msg);
    }

    const data = await res.json();
    const taskId = data?.task_id || data?.id || data?.video_id || createLocalTaskId();
    const providerTaskId = data?.video_id || data?.task_id || data?.id || taskId;
    return { taskId, providerTaskId };
  },

  async query(taskId, ctx) {
    const creds = await getCredentials(ctx, { providerId: "agnes" });
    const root = agnesRootBase(creds.baseUrl);
    const task = ctx?.task || {};
    const modelName = task.modelId || task.params?.modelId || task.params?.model || "";
    const query = new URLSearchParams({ video_id: String(taskId) });
    if (modelName) query.set("model_name", modelName);
    const url = `${root}/agnesapi?${query.toString()}`;
    const recommended = await fetch(url, {
      headers: { "Authorization": `Bearer ${creds.apiKey}` },
    });

    let data;
    if (recommended.ok) {
      data = await parseJsonOrNull(recommended);
    } else {
      const legacyTaskId = task.taskId && task.taskId !== taskId ? task.taskId : null;
      if (!legacyTaskId) throw new Error(`API error ${recommended.status}`);
      const legacy = await fetch(`${agnesV1Base(creds.baseUrl)}/videos/${encodeURIComponent(legacyTaskId)}`, {
        headers: { "Authorization": `Bearer ${creds.apiKey}` },
      });
      if (!legacy.ok) throw new Error(`API error ${legacy.status}`);
      data = await parseJsonOrNull(legacy);
    }

    const status = String(data?.status || "").toLowerCase();
    if (["failed", "error", "cancelled", "canceled"].includes(status)) {
      return {
        status: "failed",
        failReason: data?.error?.message || data?.message || "Agnes video generation failed",
        error: data?.error || null,
      };
    }
    if (!["completed", "success", "succeeded", "done"].includes(status)) {
      return { status: "pending" };
    }
    const videoUrl = videoUrlFromResponse(data);
    if (!videoUrl) return { status: "pending" };
    const filename = await downloadVideoUrl(videoUrl, ctx.dataDir, taskId);
    return { status: "success", files: [filename] };
  },
};
