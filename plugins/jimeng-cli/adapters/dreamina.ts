/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  findDreaminaMode,
  findDreaminaModel,
} from "../lib/dreamina-capabilities.ts";

const execFileAsync = promisify(execFile);

export const JIMENG_INSTALL_COMMAND = "curl -s https://jimeng.jianying.com/cli | bash";

const IMAGE_RATIOS = ["21:9", "16:9", "3:2", "4:3", "1:1", "3:4", "2:3", "9:16"];
const VIDEO_RATIOS = ["1:1", "3:4", "16:9", "4:3", "9:16", "21:9"];
const RESULT_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".mp4", ".mov", ".webm"]);
const PENDING_STATUSES = new Set(["querying", "pending", "running", "processing", "submitted"]);
const SUCCESS_STATUSES = new Set(["success", "succeeded", "done", "completed"]);
const FAILED_STATUSES = new Set(["fail", "failed", "error"]);

function executableName(platform = process.platform) {
  return platform === "win32" ? "dreamina.exe" : "dreamina";
}

function pathApiForPlatform(platform = process.platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function pathDelimiterForPlatform(platform = process.platform) {
  return platform === "win32" ? ";" : ":";
}

function joinForPlatform(platform, ...segments) {
  return pathApiForPlatform(platform).join(...segments);
}

function pathEntries(envPath = "", platform = process.platform) {
  return String(envPath || "").split(pathDelimiterForPlatform(platform)).filter(Boolean);
}

function pushUnique(items, value) {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (!trimmed || items.includes(trimmed)) return;
  items.push(trimmed);
}

function defaultWhich(command, envPath = process.env.PATH || "", exists = fs.existsSync, platform = process.platform) {
  for (const dir of pathEntries(envPath, platform)) {
    const candidate = joinForPlatform(platform, dir, command);
    if (exists(candidate)) return candidate;
  }
  return null;
}

export function dreaminaCandidateDirs({
  env = process.env,
  homeDir = os.homedir(),
  platform = process.platform,
}: any = {}) {
  const dirs = [];
  pushUnique(dirs, env.DREAMINA_INSTALL_DIR);
  pushUnique(dirs, env.DREAMINA_CLI_INSTALL_DIR);

  if (platform === "win32") {
    pushUnique(dirs, joinForPlatform(platform, homeDir, "bin"));
    pushUnique(dirs, env.LOCALAPPDATA ? joinForPlatform(platform, env.LOCALAPPDATA, "Programs", "dreamina") : "");
  } else {
    pushUnique(dirs, joinForPlatform(platform, homeDir, ".local", "bin"));
    pushUnique(dirs, joinForPlatform(platform, homeDir, "bin"));
    pushUnique(dirs, "/usr/local/bin");
    if (platform === "darwin") pushUnique(dirs, "/opt/homebrew/bin");
  }
  return dirs;
}

export function dreaminaCandidatePaths(options: any = {}) {
  const command = executableName(options.platform || process.platform);
  const platform = options.platform || process.platform;
  return dreaminaCandidateDirs(options).map((dir) => joinForPlatform(platform, dir, command));
}

export function resolveDreaminaCommand({
  env = process.env,
  exists = fs.existsSync,
  which,
  homeDir = os.homedir(),
  platform = process.platform,
}: any = {}) {
  const explicit = typeof env.DREAMINA_CLI_PATH === "string" ? env.DREAMINA_CLI_PATH.trim() : "";
  const command = executableName(platform);
  const resolveWhich = which || ((candidateCommand, searchPath) => defaultWhich(candidateCommand, searchPath, exists, platform));
  if (explicit) {
    const explicitCommand = joinForPlatform(platform, explicit, command);
    if (exists(explicitCommand)) return explicitCommand;
    if (exists(explicit)) return explicit;
  }

  const fromPath = resolveWhich(command, env.PATH || "");
  if (fromPath) return fromPath;

  for (const candidate of dreaminaCandidatePaths({ env, homeDir, platform })) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

async function defaultRunCommand(command, args, options: any = {}) {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeout,
    shell: false,
    maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
  });
  return { stdout: String(stdout || ""), stderr: String(stderr || "") };
}

function firstJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // Some CLI commands print notes before the JSON payload; try extracting below.
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

function stringFromKeys(value, keys) {
  if (!value || typeof value !== "object") return "";
  for (const key of keys) {
    const found = value[key];
    if (typeof found === "string" && found.trim()) return found.trim();
  }
  return "";
}

function statusFromRaw(value) {
  const status = String(value || "").trim().toLowerCase();
  if (SUCCESS_STATUSES.has(status)) return "success";
  if (FAILED_STATUSES.has(status)) return "failed";
  if (PENDING_STATUSES.has(status)) return "querying";
  return status || "";
}

export function parseDreaminaTaskOutput(stdout) {
  const text = String(stdout || "");
  const json = firstJsonObject(text);
  const submitId = stringFromKeys(json, ["submit_id", "submitId", "id"])
    || text.match(/submit_id\s*[:=]\s*([^\s]+)/i)?.[1]
    || "";
  const rawStatus = stringFromKeys(json, ["gen_status", "genStatus", "status", "task_status"])
    || text.match(/gen_status\s*[:=]\s*([^\s]+)/i)?.[1]
    || text.match(/task_status\s*[:=]\s*([^\s]+)/i)?.[1]
    || "";
  const failReason = stringFromKeys(json, ["fail_reason", "failReason", "error_msg", "error", "message"])
    || text.match(/fail_reason\s*[:=]\s*(.+)$/im)?.[1]?.trim()
    || null;
  return {
    submitId,
    status: statusFromRaw(rawStatus),
    failReason,
  };
}

function cliMissingMessage(detail = "") {
  const suffix = detail ? `（${detail}）` : "";
  return `未检测到 dreamina CLI${suffix}。请先执行：${JIMENG_INSTALL_COMMAND}。如果已安装，请设置 DREAMINA_CLI_PATH 为 dreamina 可执行文件绝对路径，或设置 DREAMINA_INSTALL_DIR 为安装目录。`;
}

function createCliMissingError(detail = "") {
  const err: any = new Error(cliMissingMessage(detail));
  err.code = "cli_missing";
  err.installCommand = JIMENG_INSTALL_COMMAND;
  return err;
}

function isMissingExecutableError(err, command = "") {
  if (err?.code !== "ENOENT") return false;
  const errPath = typeof err?.path === "string" ? err.path : "";
  if (!errPath || !command) return true;
  return errPath === command || path.basename(errPath) === path.basename(command);
}

function normalizeRunCommandError(err, command) {
  if (isMissingExecutableError(err, command)) {
    throw createCliMissingError(`执行 ${command} 失败：${err?.message || "ENOENT"}`);
  }
  throw err;
}

async function runDreaminaCommand(runCommand, command, args, options) {
  try {
    return await runCommand(command, args, options);
  } catch (err) {
    normalizeRunCommandError(err, command);
  }
}

function ensureCommand(resolveCommand) {
  const command = resolveCommand();
  if (!command) {
    throw createCliMissingError();
  }
  return command;
}

function commandOptions(extra: any = {}) {
  return {
    ...extra,
    shell: false,
    timeout: extra.timeout || 120_000,
  };
}

function ensureWorkingDirectory(directory) {
  if (typeof directory !== "string" || !directory.trim()) return undefined;
  const resolved = path.resolve(directory);
  try {
    fs.mkdirSync(resolved, { recursive: true });
    if (!fs.statSync(resolved).isDirectory()) {
      throw new Error("path exists but is not a directory");
    }
    return resolved;
  } catch (cause: any) {
    const detail = typeof cause?.code === "string" ? cause.code : "unknown_error";
    const error: any = new Error(`即梦 CLI 工作目录不可用，请检查插件数据目录权限（${detail}）`);
    error.code = "cli_workdir_unavailable";
    Object.defineProperty(error, "cause", {
      value: cause,
      enumerable: false,
    });
    throw error;
  }
}

function imagesFromParams(params: any = {}) {
  const input = params.referenceImages || params.images || params.image;
  if (!input) return [];
  return (Array.isArray(input) ? input : [input])
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => item.trim());
}

function appendStringArg(args, option, value) {
  if (value === undefined || value === null || value === "") return;
  args.push(option, String(value));
}

function normalizeImageModelVersion(model) {
  const raw = String(model || "").trim();
  if (!raw) return "";
  return raw.replace(/^jimeng-image-/i, "");
}

function normalizeVideoModelVersion(model) {
  return String(model || "").trim();
}

function imageResolution(params: any = {}, defaults: any = {}) {
  return params.resolution_type || params.resolutionType || params.resolution || defaults.resolution_type || defaults.resolution;
}

function normalizeImageResolution(value) {
  if (!value) return "";
  const match = String(value).trim().toLowerCase().match(/^([124])\s*k$/);
  return match ? `${match[1]}k` : String(value).trim();
}

function modeProperty(mode, propertyName) {
  return mode?.parameterSchema?.properties?.[propertyName] || {};
}

function enumValues(mode, propertyName) {
  const values = modeProperty(mode, propertyName)?.enum;
  return Array.isArray(values) ? values.filter((value) => typeof value === "string" && value.trim()) : [];
}

function modeDefault(mode, propertyName) {
  return mode?.defaults?.[propertyName] ?? modeProperty(mode, propertyName)?.default;
}

function createRuntimeCapabilityError(message, code = "runtime_capability_unavailable") {
  const error: any = new Error(message);
  error.code = code;
  return error;
}

function requireCapabilityMode(snapshot, kind, modelId, modeId) {
  if (!snapshot?.media?.[kind]) {
    throw createRuntimeCapabilityError(`即梦 CLI 的 ${kind} 运行时能力尚未就绪`);
  }
  const model = findDreaminaModel(snapshot, kind, modelId);
  if (!model) {
    throw createRuntimeCapabilityError(`模型 "${modelId}" 不在当前即梦 CLI 提供的能力列表中`, "model_unavailable");
  }
  const mode = findDreaminaMode(model, modeId);
  if (!mode) {
    throw createRuntimeCapabilityError(`模型 "${modelId}" 不支持当前即梦 CLI 的 ${modeId} 模式`, "mode_unavailable");
  }
  return mode;
}

function resolveImageResolution(params: any = {}, defaults: any = {}, modelVersion = "", mode: any = {}) {
  const supported = enumValues(mode, "resolution");
  if (supported.length === 0) {
    throw createRuntimeCapabilityError(`即梦 CLI 未声明模型 "${modelVersion}" 的图片分辨率`);
  }
  const raw = imageResolution(params, defaults) || modeDefault(mode, "resolution");
  const resolution = normalizeImageResolution(raw);
  if (!supported.includes(resolution)) {
    throw new Error(`Jimeng image resolution "${raw}" is unsupported for model "${modelVersion}"; supported resolutions: ${supported.join(", ")}`);
  }
  return resolution;
}

function resolveImageRatio(params: any = {}, defaults: any = {}, mode: any = {}) {
  const supported = enumValues(mode, "ratio");
  if (supported.length === 0) {
    throw createRuntimeCapabilityError("即梦 CLI 未声明图片比例");
  }
  const ratio = params.ratio || params.aspect_ratio || params.aspectRatio || defaults.ratio || modeDefault(mode, "ratio");
  if (!supported.includes(ratio)) {
    throw new Error(`Jimeng image ratio "${ratio}" is unsupported; supported ratios: ${supported.join(", ")}`);
  }
  return ratio;
}

function videoResolution(params: any = {}, defaults: any = {}) {
  return params.video_resolution || params.videoResolution || params.resolution || defaults.video_resolution || defaults.videoResolution || defaults.resolution;
}

function normalizeVideoResolution(value) {
  return String(value || "").trim().toLowerCase();
}

function resolveVideoResolution(params: any = {}, defaults: any = {}, modelVersion = "", mode: any = {}) {
  const supported = enumValues(mode, "video_resolution");
  if (supported.length === 0) {
    throw createRuntimeCapabilityError(`即梦 CLI 未声明模型 "${modelVersion}" 的视频分辨率`);
  }
  const raw = videoResolution(params, defaults) || modeDefault(mode, "video_resolution");
  const resolution = normalizeVideoResolution(raw);
  if (!supported.includes(resolution)) {
    throw new Error(`Dreamina video resolution "${raw}" is unsupported for model "${modelVersion}"; supported resolutions: ${supported.join(", ")}`);
  }
  return resolution;
}

function resolveVideoDuration(params: any = {}, defaults: any = {}, modelVersion = "", mode: any = {}) {
  const durationSchema = modeProperty(mode, "duration");
  const range = { min: Number(durationSchema.minimum), max: Number(durationSchema.maximum) };
  if (!Number.isInteger(range.min) || !Number.isInteger(range.max) || range.min > range.max) {
    throw createRuntimeCapabilityError(`即梦 CLI 未声明模型 "${modelVersion}" 的视频时长范围`);
  }
  const raw = params.duration ?? params.seconds ?? defaults.duration ?? defaults.seconds ?? modeDefault(mode, "duration");
  const resolvedDuration = Number(raw);
  if (!Number.isInteger(resolvedDuration) || resolvedDuration < range.min || resolvedDuration > range.max) {
    throw new Error(`Dreamina video duration "${raw}" is unsupported for model "${modelVersion}"; supported range: ${range.min}-${range.max}s`);
  }
  return resolvedDuration;
}

function resolveVideoRatio(params: any = {}, defaults: any = {}, mode: any = {}) {
  const supported = enumValues(mode, "ratio");
  if (supported.length === 0) {
    throw createRuntimeCapabilityError("即梦 CLI 未声明视频比例");
  }
  const ratio = params.ratio || params.aspect_ratio || params.aspectRatio || defaults.ratio || modeDefault(mode, "ratio");
  if (!supported.includes(ratio)) {
    throw new Error(`Dreamina video ratio "${ratio}" is unsupported; supported ratios: ${supported.join(", ")}`);
  }
  return ratio;
}

function imageProviderDefaults(ctx: any = {}, providerId = "jimeng-cli") {
  const all = ctx.config?.get?.("providerDefaults") ?? {};
  return all?.[providerId] || {};
}

function videoProviderDefaults(ctx: any = {}, providerId = "jimeng-cli") {
  const all = ctx.videoConfig?.get?.("providerDefaults") ?? {};
  return all?.[providerId] || {};
}

function assertSubmitAccepted(parsed) {
  if (!parsed.submitId) {
    throw new Error("Dreamina CLI did not return submit_id");
  }
  if (parsed.status === "failed") {
    throw new Error(parsed.failReason || "Dreamina generation failed");
  }
  return { taskId: parsed.submitId };
}

function listResultFiles(outputDir) {
  if (!outputDir || !fs.existsSync(outputDir)) return [];
  return fs.readdirSync(outputDir)
    .filter((name) => RESULT_EXTS.has(path.extname(name).toLowerCase()))
    .sort();
}

function relativeExistingFiles(files, outputDir) {
  const result = [];
  for (const file of files || []) {
    if (typeof file !== "string" || !file.trim()) continue;
    const fullPath = path.isAbsolute(file) ? file : path.join(outputDir, file);
    if (!fs.existsSync(fullPath)) continue;
    result.push(path.relative(outputDir, fullPath));
  }
  return result;
}

function outputFilesFromJson(stdout, outputDir) {
  const json = firstJsonObject(stdout);
  if (!json || typeof json !== "object") return [];
  const candidates = [];
  for (const key of ["files", "file_paths", "downloaded_files", "download_paths", "local_paths"]) {
    if (Array.isArray(json[key])) candidates.push(...json[key]);
  }
  for (const key of ["file", "file_path", "downloaded_file", "download_path", "local_path"]) {
    if (typeof json[key] === "string") candidates.push(json[key]);
  }
  return relativeExistingFiles(candidates, outputDir);
}

function queryStatus(parsed) {
  if (parsed.status === "success") return "success";
  if (parsed.status === "failed") return "failed";
  return "pending";
}

function createAuthFailure(code, message) {
  return {
    ok: false,
    code,
    ...(code === "cli_missing" ? { installCommand: JIMENG_INSTALL_COMMAND } : {}),
    message,
  };
}

function createJimengAdapter({
  id,
  name,
  protocolId,
  type,
  capabilities,
  buildSubmitArgs,
  resolveCommand = () => resolveDreaminaCommand(),
  runCommand = defaultRunCommand,
  getCapabilitySnapshot,
}: any) {
  return {
    id,
    protocolId,
    name,
    types: [type],
    capabilities,

    async checkAuth(_ctx: any = {}) {
      const command = resolveCommand();
      if (!command) {
        return createAuthFailure("cli_missing", cliMissingMessage());
      }
      try {
        await runDreaminaCommand(runCommand, command, ["user_credit"], commandOptions({ timeout: 30_000 }));
        return { ok: true };
      } catch (err: any) {
        if (err?.code === "cli_missing") {
          return createAuthFailure("cli_missing", err.message || cliMissingMessage());
        }
        const output = `${err?.stdout || ""}\n${err?.stderr || ""}\n${err?.message || ""}`;
        if (output.includes("未检测到有效登录态")) {
          return createAuthFailure("login_required", "即梦 CLI 尚未登录，请先执行 dreamina login。");
        }
        return createAuthFailure("cli_unavailable", err?.message || String(err));
      }
    },

    async submit(params: any = {}, ctx: any = {}) {
      const command = ensureCommand(resolveCommand);
      if (typeof getCapabilitySnapshot !== "function") {
        throw createRuntimeCapabilityError("即梦 CLI 运行时能力发现器未注册");
      }
      const snapshot = await getCapabilitySnapshot({
        capability: type === "image" ? "image_generation" : "video_generation",
      });
      const args = buildSubmitArgs(params, ctx, snapshot);
      const workingDirectory = ensureWorkingDirectory(ctx.generatedDir || ctx.dataDir);
      const { stdout } = await runDreaminaCommand(runCommand, command, args, commandOptions({
        cwd: workingDirectory,
        timeout: 120_000,
      }));
      return assertSubmitAccepted(parseDreaminaTaskOutput(stdout));
    },

    async query(providerTaskId, ctx: any = {}) {
      const command = ensureCommand(resolveCommand);
      const outputDir = ensureWorkingDirectory(ctx.generatedDir || path.join(ctx.dataDir, "generated"));
      const before = new Set(listResultFiles(outputDir));
      const { stdout } = await runDreaminaCommand(runCommand, command, [
        "query_result",
        "--submit_id",
        String(providerTaskId),
        "--download_dir",
        outputDir,
      ], commandOptions({
        cwd: outputDir,
        timeout: 120_000,
      }));
      const parsed = parseDreaminaTaskOutput(stdout);
      const status = queryStatus(parsed);
      if (status === "failed") {
        return {
          status: "failed",
          failReason: parsed.failReason || "Dreamina generation failed",
          error: { code: "DREAMINA_FAILED", message: parsed.failReason || "Dreamina generation failed" },
        };
      }
      if (status === "pending") return { status: "pending" };

      const filesFromJson = outputFilesFromJson(stdout, outputDir);
      const after = listResultFiles(outputDir);
      const downloaded = after.filter((name) => !before.has(name));
      const files = [...new Set([...filesFromJson, ...downloaded])];
      if (files.length === 0) {
        return {
          status: "failed",
          failReason: "Dreamina query succeeded but no media file was downloaded",
          error: {
            code: "DREAMINA_NO_FILE",
            message: "Dreamina query succeeded but no media file was downloaded",
          },
        };
      }
      return { status: "success", files };
    },
  };
}

function buildImageSubmitArgs(params: any = {}, ctx: any = {}, snapshot: any = null) {
  const defaults = imageProviderDefaults(ctx, params.providerId || "jimeng-cli");
  const images = imagesFromParams(params);
  const modeId = images.length > 0 ? "image2image" : "text2image";
  const requestedModel = params.modelId
    || params.model
    || defaults.model
    || snapshot?.media?.imageGeneration?.defaultModelId;
  const modelVersion = normalizeImageModelVersion(requestedModel);
  if (!modelVersion) throw createRuntimeCapabilityError("当前即梦 CLI 没有可用的图片模型", "model_unavailable");
  const providerModelId = `jimeng-image-${modelVersion}`;
  const mode = requireCapabilityMode(snapshot, "imageGeneration", providerModelId, modeId);
  const inputLimits: any = mode.inputLimits;
  const referenceLimit = Number(inputLimits?.referenceImages?.max);
  if (images.length > 0 && Number.isInteger(referenceLimit) && images.length > referenceLimit) {
    throw new Error(`Dreamina image2image supports at most ${referenceLimit} input images`);
  }
  const args = [modeId];
  if (images.length > 0) {
    for (const image of images) appendStringArg(args, "--images", image);
  }
  appendStringArg(args, "--prompt", params.prompt);
  appendStringArg(args, "--model_version", modelVersion);
  appendStringArg(args, "--ratio", resolveImageRatio(params, defaults, mode));
  appendStringArg(args, "--resolution_type", resolveImageResolution(params, defaults, modelVersion, mode));
  appendStringArg(args, "--poll", 0);
  return args;
}

function buildVideoSubmitArgs(params: any = {}, ctx: any = {}, snapshot: any = null) {
  const defaults = videoProviderDefaults(ctx, params.providerId || "jimeng-cli");
  const images = imagesFromParams(params);
  const modelVersion = normalizeVideoModelVersion(
    params.modelId || params.model || defaults.model || snapshot?.media?.videoGeneration?.defaultModelId,
  );
  if (!modelVersion) throw createRuntimeCapabilityError("当前即梦 CLI 没有可用的视频模型", "model_unavailable");
  const mode = params.mode || (images.length === 1 ? "image2video" : "text2video");
  if (mode === "text2video" && images.length !== 0) {
    throw new Error("Dreamina text2video does not accept reference images");
  }
  if (mode === "image2video" && images.length !== 1) {
    throw new Error("Dreamina image2video requires exactly one reference image");
  }
  if (mode !== "text2video" && mode !== "image2video") {
    throw new Error(`Dreamina video mode "${mode}" is not implemented by this adapter`);
  }
  if (images.length > 1) {
    throw new Error("Dreamina multi-reference video requires the native video input contract to pass mode-specific fields");
  }
  const capabilityMode = requireCapabilityMode(snapshot, "videoGeneration", modelVersion, mode);
  const duration = resolveVideoDuration(params, defaults, modelVersion, capabilityMode);
  const resolution = resolveVideoResolution(params, defaults, modelVersion, capabilityMode);
  const args = [mode];
  if (images.length === 1) appendStringArg(args, "--image", images[0]);
  appendStringArg(args, "--prompt", params.prompt);
  appendStringArg(args, "--model_version", modelVersion);
  if (images.length === 0) {
    appendStringArg(args, "--ratio", resolveVideoRatio(params, defaults, capabilityMode));
  }
  appendStringArg(args, "--duration", duration);
  appendStringArg(args, "--video_resolution", resolution);
  appendStringArg(args, "--poll", 0);
  return args;
}

export function createJimengImageAdapter(options: any = {}) {
  return createJimengAdapter({
    id: "jimeng-cli-images",
    protocolId: "jimeng-cli-images",
    name: "即梦 CLI Images",
    type: "image",
    capabilities: {
      ratios: IMAGE_RATIOS,
      resolutions: ["1k", "2k", "4k"],
      referenceImages: { min: 0, max: 10 },
    },
    buildSubmitArgs: buildImageSubmitArgs,
    ...options,
  });
}

export function createJimengVideoAdapter(options: any = {}) {
  return createJimengAdapter({
    id: "jimeng-cli-videos",
    protocolId: "jimeng-cli-videos",
    name: "即梦 CLI Videos",
    type: "video",
    capabilities: {
      ratios: VIDEO_RATIOS,
      resolutions: ["720p", "1080p", "4k"],
      duration: { min: 3, max: 15 },
      referenceImages: { min: 0, max: 1 },
    },
    buildSubmitArgs: buildVideoSubmitArgs,
    ...options,
  });
}
