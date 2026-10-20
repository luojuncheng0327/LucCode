import {
  createLocalTaskId,
  downloadImageUrls,
  normalizeBaseUrl,
  normalizeImageInput,
  saveBase64Images,
} from "./common.ts";
import { t } from "../../lib/i18n.ts";

const DEFAULT_BASE_URL = "https://api.minimaxi.com/v1";
const MINIMAX_IMAGE_RATIOS = new Set(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"]);

function resolveMiniMaxBaseUrl(baseUrl) {
  const base = normalizeBaseUrl(baseUrl, DEFAULT_BASE_URL);
  if (base.endsWith("/anthropic")) return `${base.slice(0, -"/anthropic".length)}/v1`;
  if (base.endsWith("/v1")) return base;
  return `${base}/v1`;
}

async function getCredentials(ctx, params: any = {}) {
  const providerId = params.credentialProviderId || params.providerId || "minimax";
  const creds = await ctx.bus.request("provider:credentials", { providerId });
  if (creds.error || !creds.apiKey) {
    throw new Error(t("plugin.imageGen.providerNoApiKey", { providerId }));
  }
  return creds;
}

function collectBase64Images(data) {
  const raw = data?.data?.image_base64 || data?.data?.images || data?.image_base64;
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map((item) => typeof item === "string" ? item : item?.base64 || item?.b64_json).filter(Boolean);
  }
  if (typeof raw === "string") return [raw];
  return [];
}

function collectImageUrls(data) {
  const raw = data?.data?.image_urls || data?.data?.images || data?.image_urls;
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map((item) => typeof item === "string" ? item : item?.url || item?.image_url).filter(Boolean);
  }
  if (typeof raw === "string") return [raw];
  return [];
}

export const minimaxImageAdapter = {
  id: "minimax",
  protocolId: "minimax-images",
  name: "MiniMax Image",
  types: ["image"],
  capabilities: {
    ratios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"],
    resolutions: [],
  },

  async checkAuth(ctx) {
    try {
      await getCredentials(ctx, { providerId: "minimax" });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err.message || String(err) };
    }
  },

  async submit(params, ctx) {
    if (params.size || params.resolution) {
      throw new Error("MiniMax image size/resolution is unsupported");
    }
    const aspectRatio = params.aspect_ratio || params.aspectRatio || params.ratio || "3:2";
    if (!MINIMAX_IMAGE_RATIOS.has(aspectRatio)) {
      throw new Error(`MiniMax image ratio "${aspectRatio}" is unsupported`);
    }
    if ((params.width === undefined) !== (params.height === undefined)) {
      throw new Error("MiniMax image width and height must be provided together");
    }
    if (params.width !== undefined || params.height !== undefined) {
      const width = Number(params.width);
      const height = Number(params.height);
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 512 || width > 2048 || height < 512 || height > 2048 || width % 8 !== 0 || height % 8 !== 0) {
        throw new Error("MiniMax image width and height must be integers between 512 and 2048, divisible by 8");
      }
    }

    const creds = await getCredentials(ctx, params);
    const body = {
      model: params.modelId || params.model || "image-01",
      prompt: params.prompt,
      response_format: "base64",
      aspect_ratio: aspectRatio,
      ...(params.n ? { n: params.n } : {}),
      ...(params.prompt_optimizer !== undefined ? { prompt_optimizer: params.prompt_optimizer } : {}),
      ...(params.seed !== undefined ? { seed: params.seed } : {}),
      ...(params.width !== undefined ? { width: params.width } : {}),
      ...(params.height !== undefined ? { height: params.height } : {}),
    };

    const images = normalizeImageInput(params.image);
    if (images.length > 0) {
      (body as any).subject_reference = images.map((image) => ({
        type: "character",
        image_file: image,
      }));
    }

    const res = await fetch(`${resolveMiniMaxBaseUrl(creds.baseUrl)}/image_generation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${creds.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      let msg = `API error ${res.status}`;
      try {
        const err = await res.json();
        if (err.base_resp?.status_msg) msg = `${msg}: ${err.base_resp.status_msg}`;
        else if (err.error?.message) msg = `${msg}: ${err.error.message}`;
      } catch {}
      throw new Error(msg);
    }

    const data = await res.json();
    const statusCode = data?.base_resp?.status_code;
    if (statusCode !== undefined && Number(statusCode) !== 0) {
      throw new Error(`MiniMax API error ${statusCode}: ${data?.base_resp?.status_msg || "unknown error"}`);
    }

    const base64Images = collectBase64Images(data);
    const urlImages = collectImageUrls(data);
    const files = base64Images.length
      ? await saveBase64Images(base64Images, "image/jpeg", ctx.dataDir, params.filename)
      : await downloadImageUrls(urlImages, ctx.dataDir, params.filename);
    if (files.length === 0) throw new Error("MiniMax API returned no images");
    return { taskId: data.id || createLocalTaskId(), files };
  },
};
