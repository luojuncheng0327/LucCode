import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify, stripVTControlCharacters } from "node:util";

const execFileAsync = promisify(execFile);

const PROVIDER_ID = "jimeng-cli";
const IMAGE_PROTOCOL_ID = "jimeng-cli-images";
const VIDEO_PROTOCOL_ID = "jimeng-cli-videos";
const COMMANDS = ["text2image", "image2image", "text2video", "image2video"] as const;

type DreaminaCommand = typeof COMMANDS[number];
type MediaKind = "imageGeneration" | "videoGeneration";

export type DreaminaCapabilityErrorCode =
  | "cli_missing"
  | "fingerprint_failed"
  | "command_failed"
  | "output_unparseable";

export class DreaminaCapabilityError extends Error {
  code: DreaminaCapabilityErrorCode;
  cause?: unknown;

  constructor(code: DreaminaCapabilityErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "DreaminaCapabilityError";
    this.code = code;
    this.cause = cause;
  }
}

export interface DreaminaExecutableFingerprint {
  path: string;
  version: string;
  mtimeMs: number;
  size: number;
}

export interface DreaminaVersionInfo {
  version: string;
  commit?: string;
  buildTime?: string;
}

export interface DreaminaCapabilityOutputs {
  text2image: string;
  image2image: string;
  text2video: string;
  image2video: string;
}

export interface DreaminaCapabilitySnapshot {
  providerId: "jimeng-cli";
  fingerprint: DreaminaExecutableFingerprint;
  version: DreaminaVersionInfo;
  discoveredAt: string;
  media: Record<MediaKind, {
    defaultModelId: string;
    models: Array<Record<string, unknown>>;
  }>;
}

interface CommandResult {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}

interface FileStat {
  mtimeMs: number;
  size: number;
  isFile?: () => boolean;
}

interface DiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  exists?: (filePath: string) => boolean;
  which?: (command: string, searchPath: string) => string | null;
  resolveCommand?: () => string | null;
  runCommand?: (command: string, args: string[], options: Record<string, unknown>) => Promise<CommandResult>;
  statFile?: (filePath: string) => Promise<FileStat>;
  realpath?: (filePath: string) => Promise<string>;
  now?: () => Date;
}

interface RefreshOptions {
  capability?: "image_generation" | "video_generation" | MediaKind;
  force?: boolean;
}

interface ParsedModeCapability {
  models: string[];
  ratios: string[];
  resolutions: Map<string, string[]>;
  durations?: Map<string, { min: number; max: number }>;
  defaultModelId?: string;
  defaultDuration?: number;
  maxReferenceImages?: number;
}

function normalizedText(value: unknown) {
  return stripVTControlCharacters(String(value || ""))
    .replace(/\r\n?/g, "\n")
    .trim();
}

function fail(message: string): never {
  throw new DreaminaCapabilityError("output_unparseable", message);
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

function parseValues(raw: string) {
  return unique(raw
    .replace(/\([^)]*\)\s*$/, "")
    .replace(/[.;]\s*$/, "")
    .replace(/,\s*(?:or|and)\s+/gi, ", ")
    .replace(/\s+(?:or|and)\s+/gi, ", ")
    .split(",")
    .map((value) => value.trim().replace(/^[-`'"\s]+|[-`'"\s]+$/g, ""))
    .filter(Boolean));
}

function bulletValue(text: string, keyPattern: string) {
  const match = normalizedText(text).match(new RegExp(`^-\\s+${keyPattern}\\s*:\\s*(.+)$`, "im"));
  return match?.[1]?.trim() || "";
}

function requireValues(values: string[], description: string) {
  if (values.length === 0) fail(`Dreamina CLI help did not expose ${description}`);
  return values;
}

function commandModels(text: string, command: DreaminaCommand) {
  const raw = bulletValue(text, command === "image2video"
    ? "advanced model_version values"
    : "model_version");
  return requireValues(parseValues(raw), `${command} model_version values`);
}

function commandRatios(text: string, command: DreaminaCommand) {
  const raw = bulletValue(text, "ratio");
  return requireValues(parseValues(raw), `${command} ratio values`);
}

function expandModelSelector(selector: string, models: string[]) {
  const selected = new Set<string>();
  for (const rawPart of selector.split("/")) {
    const part = rawPart.trim();
    const family = part.match(/^(.+?)\s+family$/i)?.[1]?.trim();
    if (family) {
      for (const model of models) {
        if (model === family || model.startsWith(family)) selected.add(model);
      }
    } else if (models.includes(part)) {
      selected.add(part);
    }
  }
  return [...selected];
}

function assignRule<T>(
  target: Map<string, T>,
  selector: string,
  models: string[],
  value: T,
  description: string,
) {
  const selected = expandModelSelector(selector, models);
  if (selected.length === 0) fail(`Dreamina CLI help exposed an unknown ${description} selector: ${selector}`);
  for (const model of selected) target.set(model, value);
}

function assertRulesCoverModels<T>(rules: Map<string, T>, models: string[], description: string) {
  const missing = models.filter((model) => !rules.has(model));
  if (missing.length > 0) {
    fail(`Dreamina CLI help omitted ${description} for models: ${missing.join(", ")}`);
  }
}

function parseImageResolutionRules(text: string, models: string[], command: "text2image" | "image2image") {
  const rules = new Map<string, string[]>();
  const lines = normalizedText(text).split("\n").map((line) => line.trim());
  for (const line of lines) {
    const mapped = line.match(/^-\s+(.+?)\s*->\s*resolution_type\s+(.+)$/i);
    if (mapped) {
      assignRule(rules, mapped[1], models, requireValues(parseValues(mapped[2]), `${command} resolution values`), "resolution");
      continue;
    }
    const shared = line.match(/^-\s+resolution_type\s*:\s*(.+)$/i);
    if (shared) {
      const values = requireValues(parseValues(shared[1]), `${command} resolution values`);
      for (const model of models) rules.set(model, values);
    }
  }
  assertRulesCoverModels(rules, models, `${command} resolutions`);
  return rules;
}

function parseVideoResolutionRules(text: string, models: string[], command: "text2video" | "image2video") {
  const rules = new Map<string, string[]>();
  let otherValues: string[] | null = null;
  const lines = normalizedText(text).split("\n").map((line) => line.trim());
  for (const line of lines) {
    const mapped = line.match(/^-\s+(.+?)\s*->\s*video_resolution\s+(.+?)(?:;\s*duration\s+\d+\s*-\s*\d+s?)?$/i);
    if (!mapped) continue;
    const values = requireValues(parseValues(mapped[2]), `${command} video_resolution values`);
    if (/^all other models$/i.test(mapped[1].trim())) otherValues = values;
    else assignRule(rules, mapped[1], models, values, "video resolution");
  }
  if (otherValues) {
    for (const model of models) {
      if (!rules.has(model)) rules.set(model, otherValues);
    }
  }
  assertRulesCoverModels(rules, models, `${command} video resolutions`);
  return rules;
}

function durationDefault(text: string) {
  const durationLine = normalizedText(text).split("\n").find((line) => /--duration\s+int/i.test(line));
  const value = durationLine?.match(/\(default\s+(\d+)\)/i)?.[1];
  return value ? Number(value) : undefined;
}

function parseTextVideoDurations(text: string, models: string[]) {
  const rules = new Map<string, { min: number; max: number }>();
  let otherRange: { min: number; max: number } | null = null;
  const lines = normalizedText(text).split("\n").map((line) => line.trim());
  for (const line of lines) {
    const mapped = line.match(/^-\s+(.+?)\s*->\s*video_resolution\s+.+?;\s*duration\s+(\d+)\s*-\s*(\d+)s?$/i);
    if (!mapped) continue;
    const range = { min: Number(mapped[2]), max: Number(mapped[3]) };
    if (/^all other models$/i.test(mapped[1].trim())) otherRange = range;
    else assignRule(rules, mapped[1], models, range, "duration");
  }
  if (otherRange) {
    for (const model of models) {
      if (!rules.has(model)) rules.set(model, otherRange);
    }
  }
  assertRulesCoverModels(rules, models, "text2video durations");
  return rules;
}

function parseImageVideoDurations(text: string, models: string[]) {
  const rules = new Map<string, { min: number; max: number }>();
  const durationLine = normalizedText(text).split("\n").find((line) => /--duration\s+int/i.test(line));
  const rawRules = durationLine?.match(/supported duration ranges by model:\s*(.+?)(?:\s*\(default\s+\d+\))?$/i)?.[1];
  if (!rawRules) fail("Dreamina CLI help did not expose image2video duration ranges by model");
  for (const segment of rawRules.split(/,\s*/)) {
    const mapped = segment.match(/^(.+?)\s*->\s*(\d+)\s*-\s*(\d+)s?$/i);
    if (!mapped) fail(`Dreamina CLI exposed an unparseable image2video duration rule: ${segment}`);
    assignRule(rules, mapped[1], models, { min: Number(mapped[2]), max: Number(mapped[3]) }, "duration");
  }
  assertRulesCoverModels(rules, models, "image2video durations");
  return rules;
}

function textVideoDefaultModel(text: string, models: string[]) {
  const note = normalizedText(text).match(/^[-\s]*default model_version\s*:\s*([^\s;]+).*$/im)?.[1]?.trim();
  const flag = normalizedText(text).match(/--model_version[^\n]*;\s*default\s*:\s*([^\s;]+)/i)?.[1]?.trim();
  const value = note || flag || "";
  if (!value || !models.includes(value)) fail("Dreamina CLI help did not expose a valid text2video default model");
  return value;
}

function imageReferenceLimit(text: string) {
  const match = normalizedText(text).match(/Upload\s+1\s+to\s+(\d+)\s+local images/i);
  const max = match ? Number(match[1]) : NaN;
  if (!Number.isInteger(max) || max < 1) fail("Dreamina CLI help did not expose the image2image reference image limit");
  return max;
}

function parseImageCommand(text: string, command: "text2image" | "image2image"): ParsedModeCapability {
  const models = commandModels(text, command);
  return {
    models,
    ratios: commandRatios(text, command),
    resolutions: parseImageResolutionRules(text, models, command),
    ...(command === "image2image" ? { maxReferenceImages: imageReferenceLimit(text) } : {}),
  };
}

function parseVideoCommand(text: string, command: "text2video" | "image2video"): ParsedModeCapability {
  const models = commandModels(text, command);
  const ratios = command === "text2video" ? commandRatios(text, command) : [];
  return {
    models,
    ratios,
    resolutions: parseVideoResolutionRules(text, models, command),
    durations: command === "text2video"
      ? parseTextVideoDurations(text, models)
      : parseImageVideoDurations(text, models),
    ...(command === "text2video" ? { defaultModelId: textVideoDefaultModel(text, models) } : {}),
    ...(durationDefault(text) !== undefined ? { defaultDuration: durationDefault(text) } : {}),
  };
}

function preferred(values: string[], value: string) {
  return values.includes(value) ? value : values[0];
}

function highestResolution(values: string[]) {
  return [...values].sort((left, right) => {
    const number = (value: string) => Number(value.match(/[\d.]+/)?.[0] || 0);
    return number(left) - number(right);
  }).at(-1) || values[0];
}

function imageMode(
  id: "text2image" | "image2image",
  capability: ParsedModeCapability,
  modelId: string,
) {
  const ratios = capability.ratios;
  const resolutions = capability.resolutions.get(modelId) || [];
  const ratio = preferred(ratios, "3:2");
  const resolution = highestResolution(resolutions);
  return {
    id,
    label: id === "text2image" ? "文生图" : "图生图",
    parameterSchema: {
      type: "object",
      properties: {
        ratio: { type: "string", enum: ratios, default: ratio },
        resolution: { type: "string", enum: resolutions, default: resolution },
      },
    },
    defaults: { ratio, resolution },
    inputLimits: id === "text2image"
      ? { referenceImages: { min: 0, max: 0 } }
      : { referenceImages: { min: 1, max: capability.maxReferenceImages } },
  };
}

function videoMode(
  id: "text2video" | "image2video",
  capability: ParsedModeCapability,
  modelId: string,
) {
  const resolutions = capability.resolutions.get(modelId) || [];
  const duration = capability.durations?.get(modelId);
  if (!duration) fail(`Dreamina CLI help omitted ${id} duration for model ${modelId}`);
  const defaultDuration = Math.min(duration.max, Math.max(duration.min, capability.defaultDuration ?? duration.min));
  const defaultResolution = preferred(resolutions, "720p");
  const properties: Record<string, unknown> = {
    duration: { type: "integer", minimum: duration.min, maximum: duration.max, default: defaultDuration },
    video_resolution: { type: "string", enum: resolutions, default: defaultResolution },
  };
  const defaults: Record<string, unknown> = {
    duration: defaultDuration,
    video_resolution: defaultResolution,
  };
  if (id === "text2video") {
    const ratio = preferred(capability.ratios, "16:9");
    properties.ratio = { type: "string", enum: capability.ratios, default: ratio };
    defaults.ratio = ratio;
  }
  return {
    id,
    label: id === "text2video" ? "文生视频" : "单图生视频",
    parameterSchema: { type: "object", properties },
    defaults,
    inputLimits: id === "text2video"
      ? { referenceImages: { min: 0, max: 0 } }
      : { referenceImages: { min: 1, max: 1 } },
  };
}

function displayVideoModelName(modelId: string) {
  return modelId
    .replace(/^seedance/i, "Seedance ")
    .replace(/fast/gi, " Fast")
    .replace(/_vip/gi, " VIP")
    .replace(/mini/gi, " Mini")
    .replace(/\s+/g, " ")
    .trim();
}

function buildImageModels(text: ParsedModeCapability, image: ParsedModeCapability) {
  const orderedIds = unique([...text.models, ...image.models]);
  return orderedIds.map((version) => {
    const modes = [];
    if (text.models.includes(version)) modes.push(imageMode("text2image", text, version));
    if (image.models.includes(version)) modes.push(imageMode("image2image", image, version));
    const ratios = unique(modes.flatMap((mode) => mode.parameterSchema.properties.ratio.enum));
    const resolutions = unique(modes.flatMap((mode) => mode.parameterSchema.properties.resolution.enum));
    return {
      id: `jimeng-image-${version}`,
      displayName: `即梦图片 ${version}`,
      protocolId: IMAGE_PROTOCOL_ID,
      inputs: image.models.includes(version) ? ["text", "image"] : ["text"],
      outputs: ["image"],
      supportsEdit: image.models.includes(version),
      modes,
      ratios,
      resolutions,
    };
  });
}

function buildVideoModels(text: ParsedModeCapability, image: ParsedModeCapability) {
  const orderedIds = unique([...text.models, ...image.models]);
  return orderedIds.map((modelId) => {
    const supportsText = text.models.includes(modelId);
    const supportsImage = image.models.includes(modelId);
    const modes = [];
    if (supportsText) modes.push(videoMode("text2video", text, modelId));
    if (supportsImage) modes.push(videoMode("image2video", image, modelId));
    const ratios = unique(modes.flatMap((mode) => {
      const ratio = mode.parameterSchema.properties.ratio as { enum?: string[] } | undefined;
      return ratio?.enum || [];
    }));
    const resolutions = unique(modes.flatMap((mode) => {
      const resolution = mode.parameterSchema.properties.video_resolution as { enum: string[] };
      return resolution.enum;
    }));
    const ranges = modes.map((mode) => {
      const duration = mode.parameterSchema.properties.duration as { minimum: number; maximum: number };
      return duration;
    });
    return {
      id: modelId,
      displayName: displayVideoModelName(modelId),
      protocolId: VIDEO_PROTOCOL_ID,
      inputs: supportsText && supportsImage ? ["text", "image"] : supportsImage ? ["image"] : ["text"],
      outputs: ["video"],
      supportsAsync: true,
      modes,
      ...(ratios.length > 0 ? { ratios } : {}),
      resolutions,
      duration: {
        min: Math.min(...ranges.map((range) => range.minimum)),
        max: Math.max(...ranges.map((range) => range.maximum)),
      },
    };
  });
}

export function parseDreaminaCapabilityOutputs(outputs: DreaminaCapabilityOutputs) {
  for (const command of COMMANDS) {
    if (!normalizedText(outputs?.[command])) fail(`Dreamina CLI returned empty help for ${command}`);
  }
  const text2image = parseImageCommand(outputs.text2image, "text2image");
  const image2image = parseImageCommand(outputs.image2image, "image2image");
  const text2video = parseVideoCommand(outputs.text2video, "text2video");
  const image2video = parseVideoCommand(outputs.image2video, "image2video");
  const imageModels = buildImageModels(text2image, image2image);
  const videoModels = buildVideoModels(text2video, image2video);
  if (imageModels.length === 0 || videoModels.length === 0) fail("Dreamina CLI returned no supported media models");
  return {
    imageGeneration: {
      defaultModelId: imageModels.at(-1)?.id || "",
      models: imageModels,
    },
    videoGeneration: {
      defaultModelId: text2video.defaultModelId || "",
      models: videoModels,
    },
  };
}

export function findDreaminaModel(snapshot: DreaminaCapabilitySnapshot, kind: MediaKind, modelId: string) {
  return snapshot.media[kind]?.models.find((model) => model.id === modelId) || null;
}

export function findDreaminaMode(model: Record<string, unknown> | null | undefined, modeId: string) {
  const modes = Array.isArray(model?.modes) ? model.modes as Array<Record<string, unknown>> : [];
  return modes.find((mode) => mode.id === modeId) || null;
}

export function parseDreaminaVersion(output: unknown): DreaminaVersionInfo {
  const text = normalizedText(output);
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new DreaminaCapabilityError("output_unparseable", "Dreamina CLI returned an unparseable --version response", cause);
  }
  const version = typeof value.version === "string" ? value.version.trim() : "";
  if (!version) fail("Dreamina CLI --version response omitted version");
  return {
    version,
    ...(typeof value.commit === "string" && value.commit.trim() ? { commit: value.commit.trim() } : {}),
    ...(typeof value.build_time === "string" && value.build_time.trim() ? { buildTime: value.build_time.trim() } : {}),
  };
}

function executableName(platform: NodeJS.Platform) {
  return platform === "win32" ? "dreamina.exe" : "dreamina";
}

function platformPath(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function platformDelimiter(platform: NodeJS.Platform) {
  return platform === "win32" ? ";" : ":";
}

function defaultWhich(
  command: string,
  envPath: string,
  exists: (filePath: string) => boolean,
  platform: NodeJS.Platform,
) {
  for (const dir of String(envPath || "").split(platformDelimiter(platform)).filter(Boolean)) {
    const candidate = platformPath(platform).join(dir, command);
    if (exists(candidate)) return candidate;
  }
  return null;
}

export function resolveDreaminaExecutable(options: DiscoveryOptions = {}) {
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const platform = options.platform || process.platform;
  const exists = options.exists || fs.existsSync;
  const command = executableName(platform);
  const join = platformPath(platform).join;
  const explicit = String(env.DREAMINA_CLI_PATH || "").trim();
  if (explicit) {
    const inside = join(explicit, command);
    if (exists(inside)) return inside;
    if (exists(explicit)) return explicit;
  }
  const fromPath = (options.which || ((name, searchPath) => defaultWhich(name, searchPath, exists, platform)))(
    command,
    env.PATH || "",
  );
  if (fromPath) return fromPath;
  const dirs = platform === "win32"
    ? [join(homeDir, "bin"), env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Programs", "dreamina") : ""]
    : [join(homeDir, ".local", "bin"), join(homeDir, "bin"), "/usr/local/bin", ...(platform === "darwin" ? ["/opt/homebrew/bin"] : [])];
  for (const dir of [env.DREAMINA_INSTALL_DIR, env.DREAMINA_CLI_INSTALL_DIR, ...dirs]) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (exists(candidate)) return candidate;
  }
  return null;
}

async function defaultRunCommand(command: string, args: string[], options: Record<string, unknown>) {
  const { stdout, stderr } = await execFileAsync(command, args, options);
  return { stdout, stderr };
}

function commandOutput(result: CommandResult) {
  const stdout = normalizedText(result?.stdout);
  return stdout || normalizedText(result?.stderr);
}

function sameFingerprint(left: DreaminaExecutableFingerprint, right: DreaminaExecutableFingerprint) {
  return left.path === right.path
    && left.version === right.version
    && left.mtimeMs === right.mtimeMs
    && left.size === right.size;
}

function sameExecutableFile(
  cachedFingerprint: DreaminaExecutableFingerprint,
  filePath: string,
  stat: FileStat,
) {
  return cachedFingerprint.path === filePath
    && cachedFingerprint.mtimeMs === stat.mtimeMs
    && cachedFingerprint.size === stat.size;
}

export function createDreaminaCapabilityDiscovery(options: DiscoveryOptions = {}) {
  const resolveCommand = options.resolveCommand || (() => resolveDreaminaExecutable(options));
  const runCommand = options.runCommand || defaultRunCommand;
  const statFile = options.statFile || fs.promises.stat;
  const realpath = options.realpath || fs.promises.realpath;
  const now = options.now || (() => new Date());
  let cached: DreaminaCapabilitySnapshot | null = null;

  async function run(command: string, args: string[]) {
    try {
      const result = await runCommand(command, args, {
        shell: false,
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
        env: options.env || process.env,
      });
      const output = commandOutput(result);
      if (!output) {
        throw new DreaminaCapabilityError("output_unparseable", `Dreamina CLI returned empty output for ${args.join(" ")}`);
      }
      return output;
    } catch (cause) {
      if (cause instanceof DreaminaCapabilityError) throw cause;
      throw new DreaminaCapabilityError(
        "command_failed",
        `Dreamina CLI command failed: ${path.basename(command)} ${args.join(" ")}`,
        cause,
      );
    }
  }

  return {
    async refresh(_refreshOptions: RefreshOptions = {}): Promise<DreaminaCapabilitySnapshot> {
      const command = resolveCommand();
      if (!command) {
        throw new DreaminaCapabilityError("cli_missing", "未检测到 dreamina CLI，无法读取即梦模型能力。");
      }
      let resolvedPath: string;
      let stat: FileStat;
      try {
        resolvedPath = await realpath(command);
        stat = await statFile(resolvedPath);
        if (stat.isFile && !stat.isFile()) throw new Error("resolved path is not a file");
      } catch (cause) {
        throw new DreaminaCapabilityError("fingerprint_failed", "无法读取 dreamina CLI 文件信息", cause);
      }
      if (!_refreshOptions.force && cached && sameExecutableFile(cached.fingerprint, resolvedPath, stat)) {
        return cached;
      }
      const version = parseDreaminaVersion(await run(resolvedPath, ["--version"]));
      const fingerprint = {
        path: resolvedPath,
        version: version.version,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      };
      if (!_refreshOptions.force && cached && sameFingerprint(cached.fingerprint, fingerprint)) return cached;

      const help = await Promise.all(COMMANDS.map(async (subcommand) => [
        subcommand,
        await run(resolvedPath, [subcommand, "--help"]),
      ] as const));
      const media = parseDreaminaCapabilityOutputs(Object.fromEntries(help) as unknown as DreaminaCapabilityOutputs);
      cached = {
        providerId: PROVIDER_ID,
        fingerprint,
        version,
        discoveredAt: now().toISOString(),
        media,
      };
      return cached;
    },

    getCached() {
      return cached;
    },

    clear() {
      cached = null;
    },
  };
}
