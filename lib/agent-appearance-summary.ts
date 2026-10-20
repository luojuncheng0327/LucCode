import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { callTextWithLengthContract } from "../core/output-length-contract.ts";
import { modelSupportsDirectImageInput } from "../shared/model-capabilities.ts";

const AVATAR_EXTENSIONS = ["png", "jpg", "jpeg", "webp"] as const;
const APPEARANCE_CACHE_VERSION = 1;
const APPEARANCE_SUMMARY_TIMEOUT_MS = 45_000;

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

const EXTERNAL_DESCRIPTION_PATTERNS = [
  /图片/,
  /图像/,
  /照片/,
  /头像/,
  /画面/,
  /截图/,
  /来自.*分析/,
  /视觉分析/,
  /\bimage\b/i,
  /\bavatar\b/i,
  /\bphoto\b/i,
  /\bscreenshot\b/i,
];

export const AGENT_APPEARANCE_SUMMARY_REQUEST = [
  "你的任务是写出这个 Agent 的样子。",
  "只写属于这个 Agent 自身的外观特征，包括主体形象、整体风格、颜色、服饰、姿态、表情、材质感，以及能够构成这个 Agent 形象识别的一贯特征。",
  "忽略不属于 Agent 自身的画面信息。判断某个元素是否保留时，只看它是否构成这个 Agent 的样子。",
  "不要描述构图、载体、展示方式或生成痕迹。不要使用外部观察口吻。",
  "用第二人称中文输出，像在直接告诉这个 Agent 它长什么样。自然一点，有活人感，重点使用“你的形象……”“你的样子……”。",
  "目标约 120 字，可在 1-240 字之间自然浮动；信息完整比凑长度更重要。",
].join("\n");

export type AgentAvatarResource = {
  key: string;
  label: string;
  hash: string;
  path: string;
  image: {
    type: "image";
    mimeType: string;
    data: string;
  };
};

type CachedAgentAppearanceSummary = {
  version: number;
  avatarHash: string;
  summary: string;
  model?: string | null;
  updatedAt: string;
};

export type AgentAppearanceProfileResource = CachedAgentAppearanceSummary;

export type AgentAppearanceModel = Record<string, unknown>;

export type ResolvedAgentAppearanceModelConfig = {
  api?: string;
  api_key?: string;
  apiKey?: string;
  base_url?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  model?: AgentAppearanceModel | null;
};

type RefreshAgentAppearanceSummaryOptions = {
  agentDir: string;
  agentName?: string;
  visionConfig?: ResolvedAgentAppearanceModelConfig | null;
  targetModel?: AgentAppearanceModel | null;
  resolveModelWithCredentialsFresh?: (modelRef: unknown) => Promise<ResolvedAgentAppearanceModelConfig | null>;
  callText?: (options: Record<string, unknown>) => Promise<unknown>;
  usageLedger?: unknown;
  signal?: AbortSignal;
};

export function agentAppearanceSummaryPath(agentDir: string): string {
  return path.join(agentDir, "appearance-summary.json");
}

export function agentAppearanceProfileResourcePath(agentDir: string): string {
  return agentAppearanceSummaryPath(agentDir);
}

function avatarPathForExtension(agentDir: string, ext: string): string {
  return path.join(agentDir, "avatars", `agent.${ext}`);
}

function sha256(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringProp(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value ? value : null;
}

function modelLabel(model: unknown): string | null {
  if (!isRecord(model)) return null;
  return stringProp(model, "id") || stringProp(model, "name") || stringProp(model, "model");
}

function modelRefFor(model: unknown): unknown {
  if (!isRecord(model)) return model;
  const id = stringProp(model, "id");
  if (!id) return model;
  const provider = stringProp(model, "provider");
  return provider ? { id, provider } : { id };
}

function isZhLocale(locale?: string): boolean {
  return typeof locale === "string" && locale.toLowerCase().startsWith("zh");
}

function getConfigImageContext(config: ResolvedAgentAppearanceModelConfig | null | undefined) {
  return {
    api: config?.api,
    base_url: config?.base_url || config?.baseUrl,
    provider: config?.model ? stringProp(config.model, "provider") : null,
  };
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function textFromModelResponse(response: unknown): string {
  if (typeof response === "string") return response;
  if (isRecord(response) && typeof response.text === "string") {
    return response.text;
  }
  return "";
}

export function readAgentAvatarResource(agentDir: string): AgentAvatarResource | null {
  for (const ext of AVATAR_EXTENSIONS) {
    const filePath = avatarPathForExtension(agentDir, ext);
    if (!fs.existsSync(filePath)) continue;
    const bytes = fs.readFileSync(filePath);
    const hash = sha256(bytes);
    return {
      key: `visual-resource:agent-appearance:${hash}`,
      label: "Agent appearance",
      hash,
      path: filePath,
      image: {
        type: "image",
        mimeType: MIME_BY_EXTENSION[ext],
        data: bytes.toString("base64"),
      },
    };
  }
  return null;
}

export function sanitizeAgentAppearanceSummary(text: unknown): string {
  if (typeof text !== "string") return "";
  const normalized = normalizeText(text);
  if (!normalized) return "";
  if (EXTERNAL_DESCRIPTION_PATTERNS.some((pattern) => pattern.test(normalized))) return "";
  return normalized;
}

export function formatAgentAppearancePrompt(summary: string, locale?: string): string {
  const clean = sanitizeAgentAppearanceSummary(summary);
  if (!clean) return "";
  const heading = isZhLocale(locale) ? "你的样子" : "Your Appearance";
  return `## ${heading}\n\n${clean}`;
}

export function writeCachedAgentAppearanceSummary(
  agentDir: string,
  entry: { avatarHash: string; summary: string; model?: string | null },
): CachedAgentAppearanceSummary | null {
  const clean = sanitizeAgentAppearanceSummary(entry.summary);
  if (!clean || !entry.avatarHash) return null;
  const payload: CachedAgentAppearanceSummary = {
    version: APPEARANCE_CACHE_VERSION,
    avatarHash: entry.avatarHash,
    summary: clean,
    model: entry.model || null,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(agentAppearanceSummaryPath(agentDir), `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  return payload;
}

export function writeAgentAppearanceProfileResource(
  agentDir: string,
  entry: { avatarHash: string; summary: string; model?: string | null },
): AgentAppearanceProfileResource | null {
  return writeCachedAgentAppearanceSummary(agentDir, entry);
}

export function readCachedAgentAppearanceSummary(agentDir: string): CachedAgentAppearanceSummary | null {
  const avatar = readAgentAvatarResource(agentDir);
  if (!avatar) return null;
  const filePath = agentAppearanceSummaryPath(agentDir);
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!isRecord(parsed)) return null;
    if (parsed.version !== APPEARANCE_CACHE_VERSION) return null;
    if (parsed.avatarHash !== avatar.hash) return null;
    const summary = sanitizeAgentAppearanceSummary(parsed.summary);
    if (!summary) return null;
    return {
      version: APPEARANCE_CACHE_VERSION,
      avatarHash: avatar.hash,
      summary,
      model: typeof parsed.model === "string" ? parsed.model : null,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    };
  } catch {
    return null;
  }
}

export function readAgentAppearanceProfileResource(agentDir: string): AgentAppearanceProfileResource | null {
  return readCachedAgentAppearanceSummary(agentDir);
}

export function hasAgentAppearanceSummaryCapability(options: {
  visionConfig?: ResolvedAgentAppearanceModelConfig | null;
  targetModel?: AgentAppearanceModel | null;
}): boolean {
  const visionConfig = options.visionConfig || null;
  if (
    visionConfig?.model
    && modelSupportsDirectImageInput(visionConfig.model, getConfigImageContext(visionConfig))
  ) {
    return true;
  }

  const targetModel = options.targetModel || null;
  return !!(targetModel && modelSupportsDirectImageInput(targetModel, targetModel));
}

async function selectAppearanceModelConfig(
  options: RefreshAgentAppearanceSummaryOptions,
): Promise<ResolvedAgentAppearanceModelConfig | null> {
  const visionConfig = options.visionConfig || null;
  if (hasAgentAppearanceSummaryCapability({ visionConfig })) {
    return visionConfig;
  }

  const targetModel = options.targetModel || null;
  if (!hasAgentAppearanceSummaryCapability({ targetModel })) return null;
  return await options.resolveModelWithCredentialsFresh?.(modelRefFor(targetModel)) || null;
}

export async function refreshAgentAppearanceSummary(
  options: RefreshAgentAppearanceSummaryOptions,
): Promise<string | null> {
  const cached = readCachedAgentAppearanceSummary(options.agentDir);
  if (cached) return cached.summary;

  const avatar = readAgentAvatarResource(options.agentDir);
  if (!avatar) return null;

  const config = await selectAppearanceModelConfig(options);
  if (!config?.model) return null;
  if (!options.callText) {
    throw new Error("callText is required to refresh agent appearance summary");
  }

  const { text } = await callTextWithLengthContract({
    callText: options.callText,
    request: {
      api: config.api,
      apiKey: config.api_key || config.apiKey,
      baseUrl: config.base_url || config.baseUrl,
      headers: config.headers,
      model: config.model,
      messages: [{
        role: "user",
        content: [
          {
            type: "text",
            text: [
              AGENT_APPEARANCE_SUMMARY_REQUEST,
              "",
              options.agentName ? `Agent 名字：${options.agentName}` : "",
            ].filter(Boolean).join("\n"),
          },
          avatar.image,
        ],
      }],
      temperature: 0.2,
      timeoutMs: APPEARANCE_SUMMARY_TIMEOUT_MS,
      signal: options.signal,
      usageLedger: options.usageLedger,
      usageContext: {
        source: {
          subsystem: "agent",
          operation: "appearance_summary",
          surface: "system_prompt",
          trigger: "runtime",
        },
        attribution: { kind: "agent", agentDir: options.agentDir },
      },
    },
    contract: {
      label: "外观摘要",
      target: 120,
      unit: "chars",
      min: 1,
      max: 240,
      locale: "zh",
    },
    extractText: textFromModelResponse,
  });

  const summary = sanitizeAgentAppearanceSummary(text);
  if (!summary) return null;
  writeCachedAgentAppearanceSummary(options.agentDir, {
    avatarHash: avatar.hash,
    summary,
    model: modelLabel(config.model),
  });
  return summary;
}

export const refreshAgentAppearanceProfileResource = refreshAgentAppearanceSummary;
