import {
  createLocalTaskId,
  downloadImageUrls,
  normalizeBaseUrl,
  normalizeImageInput,
  saveBase64Images,
} from "./common.ts";
import { t } from "../../lib/i18n.ts";

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/api/v1";
const WAN_IMAGE_RATIOS = new Set(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"]);
const WAN_DEFAULT_RATIO = "3:2";
const QWEN_IMAGE_RATIOS = new Set(["16:9", "4:3", "1:1", "3:4", "9:16"]);
const QWEN_DEFAULT_RATIO = "4:3";
const QWEN_20_SIZE_BY_RATIO = {
  "16:9": "2688*1536",
  "9:16": "1536*2688",
  "1:1": "2048*2048",
  "4:3": "2368*1728",
  "3:4": "1728*2368",
};
const QWEN_TEXT_SIZE_BY_RATIO = {
  "16:9": "1664*928",
  "4:3": "1472*1104",
  "1:1": "1328*1328",
  "3:4": "1104*1472",
  "9:16": "928*1664",
};

function resolveDashScopeBaseUrl(baseUrl) {
  const base = normalizeBaseUrl(baseUrl, DEFAULT_BASE_URL);
  if (base.endsWith("/compatible-mode/v1")) {
    return `${base.slice(0, -"/compatible-mode/v1".length)}/api/v1`;
  }
  if (base.endsWith("/api/v1")) return base;
  return `${base}/api/v1`;
}

async function getCredentials(ctx, params: any = {}) {
  const providerId = params.credentialProviderId || params.providerId || "dashscope";
  const creds = await ctx.bus.request("provider:credentials", { providerId });
  if (creds.error || !creds.apiKey) {
    throw new Error(t("plugin.imageGen.providerNoApiKey", { providerId }));
  }
  return creds;
}

function collectDashScopeUrls(data) {
  const urls = [];
  forDashScopeImageValues(data, (value) => {
    const parsed = parseDashScopeImageValue(value);
    if (parsed?.kind === "url") urls.push(parsed.value);
  });
  return [...new Set(urls)];
}

function collectDashScopeBase64Images(data) {
  const images = [];
  forDashScopeImageValues(data, (value) => {
    const parsed = parseDashScopeImageValue(value);
    if (parsed?.kind === "base64") images.push(parsed.value);
  });
  return images;
}

function forDashScopeImageValues(data, visit) {
  for (const item of data?.output?.results || []) {
    visit(item?.url);
    visit(item?.image);
    visit(item?.b64_json);
    visit(item?.base64);
    visit(item?.image_base64);
  }
  for (const choice of data?.output?.choices || []) {
    for (const part of choice?.message?.content || []) {
      visit(part?.image);
      visit(part?.image_url);
      visit(part?.b64_json);
      visit(part?.base64);
      visit(part?.image_base64);
    }
  }
  if (Array.isArray(data?.output?.images)) {
    for (const item of data.output.images) {
      if (typeof item === "string") visit(item);
      else {
        visit(item?.url);
        visit(item?.b64_json);
        visit(item?.base64);
        visit(item?.image_base64);
      }
    }
  }
}

function parseDashScopeImageValue(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return { kind: "url", value: trimmed };
  const dataUrl = trimmed.match(/^data:image\/[a-z0-9.+-]+;base64,(.+)$/i);
  if (dataUrl) return { kind: "base64", value: dataUrl[1] };
  return { kind: "base64", value: trimmed };
}

function buildMessages(prompt, images) {
  const content: any[] = [{ text: prompt }];
  for (const image of images) content.push({ image });
  return [{ role: "user", content }];
}

function modelFamily(modelId) {
  if (String(modelId || "").startsWith("qwen-image-2")) return "qwen-multimodal";
  if (String(modelId || "").startsWith("qwen-image")) return "qwen-text2image";
  return "wan";
}

function normalizeDashScopeSize(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const tier = raw.toLowerCase().match(/^([124])\s*k$/);
  if (tier) return `${tier[1]}K`;
  return raw;
}

function assertSupportedRatio(value, supported, label) {
  if (!value) return null;
  const ratio = String(value).trim();
  if (!supported.has(ratio)) {
    throw new Error(`${label} ratio "${value}" is unsupported`);
  }
  return ratio;
}

function assertResolution(value, supported, label) {
  const resolution = normalizeDashScopeSize(value);
  if (!resolution) return null;
  if (!supported.includes(resolution)) {
    throw new Error(`${label} resolution "${value}" is unsupported; supported resolutions: ${supported.join(", ")}`);
  }
  return resolution;
}

function wanSupportedResolutions(modelId, imagesLength) {
  const id = String(modelId || "").toLowerCase();
  if (id === "wan2.7-image-pro" && imagesLength === 0) return ["1K", "2K", "4K"];
  return ["1K", "2K"];
}

function resolveWanSizeAndRatio(params, modelId, imagesLength) {
  const supported = wanSupportedResolutions(modelId, imagesLength);
  const size = params.size
    ? assertResolution(params.size, supported, "DashScope Wan")
    : assertResolution(params.resolution || supported[supported.length - 1], supported, "DashScope Wan");
  const ratio = assertSupportedRatio(
    params.aspect_ratio || params.aspectRatio || params.ratio || WAN_DEFAULT_RATIO,
    WAN_IMAGE_RATIOS,
    "DashScope Wan",
  );
  return { size, ratio };
}

function resolveQwenSize(params, sizeByRatio, supportedResolution, label) {
  if (params.size) {
    const raw = String(params.size).trim();
    const allowed = new Set(Object.values(sizeByRatio));
    if (!allowed.has(raw)) {
      throw new Error(`${label} size "${params.size}" is unsupported; supported sizes: ${[...allowed].join(", ")}`);
    }
    return raw;
  }
  assertResolution(params.resolution || supportedResolution, [supportedResolution], label);
  const ratio = assertSupportedRatio(
    params.aspect_ratio || params.aspectRatio || params.ratio || QWEN_DEFAULT_RATIO,
    QWEN_IMAGE_RATIOS,
    label,
  );
  return sizeByRatio[ratio];
}

function generationParameters(params, family, modelId, imagesLength) {
  let size = null;
  let aspectRatio = null;
  if (family === "wan") {
    const resolved = resolveWanSizeAndRatio(params, modelId, imagesLength);
    size = resolved.size;
    aspectRatio = resolved.ratio;
  } else if (family === "qwen-multimodal") {
    size = resolveQwenSize(params, QWEN_20_SIZE_BY_RATIO, "2K", "DashScope Qwen 2");
  } else if (family === "qwen-text2image") {
    size = resolveQwenSize(params, QWEN_TEXT_SIZE_BY_RATIO, "1K", "DashScope Qwen Image");
  }
  const parameters: any = {
    n: params.n || 1,
    ...(size ? { size } : {}),
  };
  if (params.negative_prompt || params.negativePrompt) {
    parameters.negative_prompt = params.negative_prompt || params.negativePrompt;
  }
  if (params.prompt_extend !== undefined || params.promptExtend !== undefined) {
    parameters.prompt_extend = params.prompt_extend ?? params.promptExtend;
  }
  if (params.watermark !== undefined) parameters.watermark = params.watermark;
  if (params.seed !== undefined) parameters.seed = params.seed;
  if (family === "wan" && aspectRatio) {
    parameters.aspect_ratio = aspectRatio;
  }
  return parameters;
}

export const dashscopeImageAdapter = {
  id: "dashscope",
  protocolId: "dashscope-wan-images",
  protocolIds: [
    "dashscope-images",
    "dashscope-qwen-multimodal-image",
    "dashscope-qwen-text2image",
  ],
  name: "DashScope Image",
  types: ["image"],
  capabilities: {
    ratios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"],
    resolutions: ["1K", "2K", "4K"],
  },

  async checkAuth(ctx) {
    try {
      await getCredentials(ctx, { providerId: "dashscope" });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err.message || String(err) };
    }
  },

  async submit(params, ctx) {
    const creds = await getCredentials(ctx, params);
    const modelId = params.modelId || params.model || "wan2.7-image-pro";
    const family = modelFamily(modelId);
    const images = normalizeImageInput(params.image);
    if (family === "qwen-text2image" && images.length > 0) {
      throw new Error(`DashScope model "${modelId}" does not support reference images`);
    }
    const body = {
      model: modelId,
      input: family === "qwen-text2image"
        ? { prompt: params.prompt }
        : { messages: buildMessages(params.prompt, images) },
      parameters: generationParameters(params, family, modelId, images.length),
    };
    const endpoint = family === "qwen-text2image"
      ? "/services/aigc/text2image/image-synthesis"
      : family === "qwen-multimodal"
        ? "/services/aigc/multimodal-generation/generation"
        : "/services/aigc/image-generation/generation";
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${creds.apiKey}`,
    };
    if (family !== "qwen-multimodal") headers["X-DashScope-Async"] = "enable";

    const res = await fetch(`${resolveDashScopeBaseUrl(creds.baseUrl)}${endpoint}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      let msg = `API error ${res.status}`;
      try {
        const err = await res.json();
        if (err.message) msg = `${msg}: ${err.message}`;
      } catch {}
      throw new Error(msg);
    }

    const data = await res.json();
    if (data.code && data.code !== "Success") {
      throw new Error(`DashScope API error ${data.code}: ${data.message || "unknown error"}`);
    }
    const taskId = data?.output?.task_id || data?.output?.taskId || data?.request_id || createLocalTaskId();
    const urls = collectDashScopeUrls(data);
    if (urls.length > 0) {
      const files = await downloadImageUrls(urls, ctx.dataDir, params.filename);
      return { taskId, files };
    }
    const base64Images = collectDashScopeBase64Images(data);
    if (base64Images.length > 0) {
      const files = await saveBase64Images(base64Images, "image/png", ctx.dataDir, params.filename);
      return { taskId, files };
    }
    return { taskId };
  },

  async query(taskId, ctx) {
    const creds = await getCredentials(ctx, { providerId: "dashscope" });
    const res = await fetch(`${resolveDashScopeBaseUrl(creds.baseUrl)}/tasks/${encodeURIComponent(taskId)}`, {
      headers: { "Authorization": `Bearer ${creds.apiKey}` },
    });
    if (!res.ok) throw new Error(`API error ${res.status}`);
    const data = await res.json();
    const status = data?.output?.task_status || data?.output?.taskStatus;
    if (status && !["SUCCEEDED", "FAILED", "CANCELED"].includes(status)) {
      return { status: "pending" };
    }
    if (status === "FAILED" || status === "CANCELED") {
      return { status: "failed", error: data?.message || status };
    }
    const urls = collectDashScopeUrls(data);
    const base64Images = collectDashScopeBase64Images(data);
    if (urls.length === 0 && base64Images.length === 0) return { status: "pending" };
    const files = urls.length > 0
      ? await downloadImageUrls(urls, ctx.dataDir)
      : await saveBase64Images(base64Images, "image/png", ctx.dataDir);
    return { status: "done", files };
  },
};
