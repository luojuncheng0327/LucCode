/**
 * sandbox/index.ts — 沙盒入口（无状态工厂）
 *
 * 每次 buildTools 调用时创建 session 级的 PathGuard + OS 沙盒 exec。
 * 不持有 engine 级状态，天然支持多 agent 并发。
 */

import { deriveSandboxPolicy } from "./policy.ts";
import { PathGuard } from "./path-guard.ts";
import { detectPlatform, checkAvailability } from "./platform.ts";
import { createSeatbeltExec } from "./seatbelt.ts";
import { createBwrapExec } from "./bwrap.ts";
import { createWin32Exec } from "./win32-exec.ts";
import { wrapBashTool, wrapCommandExec } from "./tool-wrapper.ts";
import { createEnhancedReadFile } from "./read-enhanced.ts";
import { wrapReadImageWithVisionBridge } from "./read-image-vision.ts";
import { wrapReadOfficeMedia } from "./read-office-media.ts";
import { createManagedConfigWriteGuard } from "./managed-config-guard.ts";
import { t } from "../i18n.ts";
import fs from "fs";
import path, { extname } from "path";
import {
  createReadTool,
  createWriteTool,
  createEditTool,
  createBashTool,
  createGrepTool,
  createFindTool,
  createLsTool,
} from "../pi-sdk/index.ts";
import { normalizeWin32ShellPath } from "./win32-path.ts";
import { serializeSessionFile } from "../session-files/session-file-response.ts";
import { wrapResourceIoFileTools } from "../resource-io/agent-tools.ts";
import { createMaterializeTool } from "../resource-io/materialize-tool.ts";
import { createResourceIoToolOperations } from "../resource-io/pi-tool-operations.ts";
import { createSandboxResourceIO } from "../resource-io/sandbox-resource-io.ts";
import { createExecCommandTools } from "../exec-command/tool.ts";
import { detectWin32PowerShellFlavor } from "./win32-runtime-cache.ts";
import {
  resolveLucPiSdkManagedBinDir,
  resolveLegacyPiSdkManagedBinDir,
} from "../../shared/luc-runtime-paths.ts";

/**
 * 为一个 session 创建沙盒包装后的工具集
 *
 * 每次调用独立，不共享状态。
 * 当传入 getSandboxEnabled 回调时，工具在每次调用时动态检查沙盒状态，
 * 切换偏好后无需重建 session 即可生效。
 *
 * @param {string} cwd  工作目录
 * @param {object[]} customTools  自定义工具
 * @param {object} opts
 * @param {string} opts.agentDir
 * @param {string|null} opts.workspace
 * @param {string[]} [opts.workspaceFolders]
 * @param {string[]} [opts.authorizedFolders]
 * @param {() => string[]} [opts.getAuthorizedFolders]  当前 session 动态授权的额外沙盒目录
 * @param {string} opts.luccodeHome
 * @param {() => boolean} opts.getSandboxEnabled  动态沙盒开关（每次工具调用时求值）
 * @param {() => boolean} [opts.getSandboxNetworkEnabled]  动态沙盒联网开关（仅沙盒开启时生效）
 * @param {() => string[]} [opts.getExternalReadPaths]  当前 session 用户显式给过的外部只读路径
 * @param {() => string|null} [opts.getSessionPath]  当前工具调用归属的 sessionPath
 * @param {(sessionPath: string) => string|null} [opts.getSessionIdForPath]  sessionPath locator → sessionId
 * @param {(fileId: string, options?: {sessionPath?: string|null}) => object|null} [opts.resolveSessionFile]  SessionFile resolver
 * @param {(entry: object) => void} [opts.recordFileOperation]  记录 write/edit 触达的 session file
 * @param {() => object|null} [opts.getVisionBridge]  辅助视觉桥
 * @param {() => boolean} [opts.isVisionAuxiliaryEnabled]  辅助视觉开关
 * @param {() => object|null} [opts.getTerminalSessionManager]  当前 engine 的 terminal session manager
 * @param {() => string} [opts.getAgentId]  当前 agent id
 * @param {object} [opts.resourceIO]  session 级 ResourceIO 内核；未传入时按 cwd 创建 local_fs 内核
 * @param {(event: object, sessionPath?: string|null) => void} [opts.emitEvent]  ResourceIO 事件出口
 * @param {object|null} [opts.legacyCleanupQueue] Windows 旧 ACL 清理队列
 * @returns {{ tools: object[], customTools: object[], permissionBoundary: object }}
 */
export function createSandboxedTools(cwd, customTools, {
  agentDir,
  workspace,
  workspaceFolders = [],
  authorizedFolders = [],
  getAuthorizedFolders,
  lucHome,
  getSandboxEnabled,
  getSandboxNetworkEnabled,
  getExternalReadPaths,
  getSessionPath,
  getSessionIdForPath,
  resolveSessionFile,
  recordFileOperation,
  getVisionBridge,
  isVisionAuxiliaryEnabled,
  getTerminalSessionManager,
  getAgentId,
  resourceIO: providedResourceIO,
  emitEvent,
  legacyCleanupQueue = null,
}) {
  // 始终按 standard 模式构建策略和 PathGuard，wrappers 在运行时动态 bypass
  const resolveAuthorizedFolders = () => {
    if (typeof getAuthorizedFolders === "function") {
      const folders = getAuthorizedFolders();
      return Array.isArray(folders) ? folders : [];
    }
    return Array.isArray(authorizedFolders) ? authorizedFolders : [];
  };
  const makePolicy = () => deriveSandboxPolicy({
    agentDir,
    cwd,
    workspace,
    workspaceFolders: [
      ...(Array.isArray(workspaceFolders) ? workspaceFolders : []),
      ...resolveAuthorizedFolders(),
    ],
    lucHome,
    mode: "standard",
  });
  const guard = {
    check: (absolutePath, operation) => new PathGuard(makePolicy()).check(absolutePath, operation),
    getAccessLevel: (absolutePath) => new PathGuard(makePolicy()).getAccessLevel(absolutePath),
  };

  // 增强 readFile：xlsx 解析 + 编码检测，保留 PI SDK 默认的 image mime 判断
  const IMAGE_MIMES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" };

  const platform = detectPlatform();
  const isWin32 = process.platform === "win32";
  const checkManagedConfigWrite = createManagedConfigWriteGuard({ lucHome });
  const resolveSandboxNetworkEnabled = typeof getSandboxNetworkEnabled === "function"
    ? getSandboxNetworkEnabled
    : () => true;
  const osSandboxAvailable = platform === "win32-restricted-token"
    ? true
    : checkAvailability(platform);
  const isOneShotSandboxEnforced = () => {
    try {
      if (typeof getSandboxEnabled === "function" && getSandboxEnabled() === false) return false;
    } catch {
      return false;
    }
    if (platform === "win32-restricted-token") return true;
    if (platform === "seatbelt") return osSandboxAvailable;
    // A missing bwrap executor is fail-closed below, so it never falls through
    // to a direct host command while the sandbox preference remains enabled.
    if (platform === "bwrap") return true;
    return false;
  };
  const permissionBoundary = {
    checkStagePath: (absolutePath) => guard.check(absolutePath, "stage"),
  };

  // 无 OS 沙盒时的 bash 工具（沙盒关闭时回退用）
  const normalBashTool = isWin32
    ? createBashTool(cwd, { operations: { exec: createWin32Exec() } })
    : createBashTool(cwd);

  const bashWrapOpts = { getSandboxEnabled, getExternalReadPaths, fallbackTool: normalBashTool, checkManagedConfigWrite };
  const resourceIO = providedResourceIO || createSandboxResourceIO({
    cwd,
    agentDir,
    workspace,
    workspaceFolders,
    authorizedFolders,
    getAuthorizedFolders,
    lucHome,
    getSandboxEnabled,
    getExternalReadPaths,
    getSessionPath,
    emitEvent,
    resolveSessionFile,
  });
  const resourceOps = createResourceIoToolOperations({
    cwd,
    resourceIO,
    getSessionPath: () => getSessionPath?.() || null,
    getSessionIdentity: () => {
      const sessionPath = getSessionPath?.() || null;
      const sessionId = sessionPath && typeof getSessionIdForPath === "function"
        ? getSessionIdForPath(sessionPath)
        : null;
      return { sessionId, sessionPath };
    },
    detectImageMimeType: async (p) => IMAGE_MIMES[extname(p).toLowerCase()] || undefined,
  });
  const searchToolPaths = {
    managedBinDir: resolveLucPiSdkManagedBinDir(lucHome),
    legacyManagedBinDir: resolveLegacyPiSdkManagedBinDir(lucHome),
  };
  const enhancedReadFile = createEnhancedReadFile();
  const readOps = {
    ...resourceOps.read,
    readFile: async (p) => {
      if (resourceOps.hasBoundTarget?.(p)) {
        return resourceOps.read.readFile(p);
      }
      await resourceOps.read.access(p);
      return enhancedReadFile(p);
    },
  };
  const editTool = wrapFileTouchTool(createEditTool(cwd, { operations: resourceOps.edit }), cwd, {
    origin: "agent_edit",
    operationForPath: () => "modified",
    getSessionPath,
    recordFileOperation,
  });
  const writeToolWithResourceIO = wrapFileTouchTool(createWriteTool(cwd, { operations: resourceOps.write }), cwd, {
    origin: "agent_write",
    operationForPath: (filePath) => fs.existsSync(filePath) ? "modified" : "created",
    getSessionPath,
    recordFileOperation,
  });
  const readTool = wrapReadImageWithVisionBridge(wrapReadOfficeMedia(createReadTool(cwd, { operations: readOps }), cwd, {
    lucHome,
    getSessionPath,
    getSessionIdForPath,
    recordFileOperation,
    getVisionBridge,
    isVisionAuxiliaryEnabled,
  }), cwd, {
    getSessionPath,
    getSessionIdForPath,
    recordFileOperation,
    getVisionBridge,
    isVisionAuxiliaryEnabled,
  });
  const materializeTool = createMaterializeTool({
    resourceIO,
    getSessionPath,
    getSessionIdForPath,
    cwd,
  });
  const buildResourceIoFileTools = (tools) => wrapResourceIoFileTools(tools, {
    cwd,
    resourceIO,
    getSessionPath,
    resolveSessionFile,
    emitEvent,
    withResourceTarget: resourceOps.withResourceTarget,
  });
  const createExecToolsForBash = (
    bashTool,
    commandExec = null,
    escalatedBashTool = null,
    escalatedCommandExec = null,
  ) => createExecCommandTools({
    bashTool,
    escalatedBashTool,
    commandExec,
    escalatedCommandExec,
    getTerminalSessionManager,
    getAgentId,
    getCwd: () => cwd,
    isOneShotSandboxEnforced,
    platform: process.platform,
    detectPowerShellFlavor: isWin32 ? detectWin32PowerShellFlavor : undefined,
  });

  // ── Windows: PathGuard 包装 + restricted-token exec，关闭沙盒时走 direct fallback ──
  if (platform === "win32-restricted-token") {
    const directWin32Exec = createWin32Exec();
    const sandboxedWin32Exec = (command, execCwd, execOpts) => createWin32Exec({
      sandbox: {
        policy: makePolicy(),
        lucHome,
        getExternalReadPaths,
        getSandboxNetworkEnabled: resolveSandboxNetworkEnabled,
        legacyCleanupQueue,
      },
    })(command, execCwd, execOpts);
    const sandboxedBashTool = createBashTool(cwd, {
      operations: {
        exec: sandboxedWin32Exec as any,
      },
    });
    const wrappedBashTool = wrapBashTool(sandboxedBashTool, guard, cwd, bashWrapOpts);
    const wrappedWin32Exec = wrapCommandExec(sandboxedWin32Exec, guard, cwd, {
      ...bashWrapOpts,
      fallbackExec: directWin32Exec,
    });
    // require_escalated 槽位：直接跑 directWin32Exec（无 restricted-token 沙盒），
    // 不复用 sandboxedWin32Exec/wrappedBashTool——那两个实例仍套着 restricted-token
    // 沙盒，PowerShell 在其中本就不可用，escalated 存在的意义就是绕开这层沙盒。
    // 仍然经过 wrapCommandExec/wrapBashTool 的 PathGuard 与 preflight（escalated:
    // true 只放开 SANDBOX_ONLY 分级如 wmic，HARD 分级命令任何模式都拦）。
    const wrappedEscalatedWin32Exec = wrapCommandExec(directWin32Exec, guard, cwd, {
      ...bashWrapOpts,
      escalated: true,
    });
    const wrappedEscalatedBashTool = wrapBashTool(
      createBashTool(cwd, { operations: { exec: directWin32Exec as any } }),
      guard,
      cwd,
      { ...bashWrapOpts, escalated: true },
    );
    return {
      tools: buildResourceIoFileTools([
        readTool,
        writeToolWithResourceIO,
        editTool,
        ...createExecToolsForBash(
          wrappedBashTool,
          wrappedWin32Exec,
          wrappedEscalatedBashTool,
          wrappedEscalatedWin32Exec,
        ),
        createGrepTool(cwd, { ...searchToolPaths, operations: resourceOps.grep }),
        createFindTool(cwd, { ...searchToolPaths, operations: resourceOps.find }),
        createLsTool(cwd, { operations: resourceOps.ls }),
        materializeTool,
      ]),
      customTools,
      permissionBoundary,
    };
  }

  // ── macOS / Linux: PathGuard + OS 沙盒 ──
  let defaultSandboxedBashTool = normalBashTool;
  let escalatedSandboxedBashTool = normalBashTool;
  if (osSandboxAvailable) {
    const makeSandboxExec = (resolveNetworkEnabled) => platform === "seatbelt"
      ? (command, execCwd, execOpts) => createSeatbeltExec(
          makePolicy(),
          { getSandboxNetworkEnabled: resolveNetworkEnabled },
        )(command, execCwd, execOpts)
      : (command, execCwd, execOpts) => createBwrapExec(
          makePolicy(),
          { getExternalReadPaths, getSandboxNetworkEnabled: resolveNetworkEnabled },
        )(command, execCwd, execOpts);
    const defaultSandboxExec = makeSandboxExec(() => false);
    const escalatedSandboxExec = makeSandboxExec(resolveSandboxNetworkEnabled);
    defaultSandboxedBashTool = createBashTool(cwd, {
      operations: { exec: defaultSandboxExec as any },
    });
    escalatedSandboxedBashTool = createBashTool(cwd, {
      operations: { exec: escalatedSandboxExec as any },
    });
  } else if (platform === "bwrap") {
    const unavailableBashTool = {
      ...normalBashTool,
      execute: async () => ({
        content: [{ type: "text" as const, text: t("sandbox.osRequired", { platform }) }],
      }) as any,
    };
    defaultSandboxedBashTool = unavailableBashTool;
    escalatedSandboxedBashTool = unavailableBashTool;
  }

  const wrappedDefaultBashTool = wrapBashTool(defaultSandboxedBashTool, guard, cwd, bashWrapOpts);
  const wrappedEscalatedBashTool = wrapBashTool(escalatedSandboxedBashTool, guard, cwd, bashWrapOpts);
  return {
    tools: buildResourceIoFileTools([
      readTool,
      writeToolWithResourceIO,
      editTool,
      ...createExecToolsForBash(wrappedDefaultBashTool, null, wrappedEscalatedBashTool),
      createGrepTool(cwd, { ...searchToolPaths, operations: resourceOps.grep }),
      createFindTool(cwd, { ...searchToolPaths, operations: resourceOps.find }),
      createLsTool(cwd, { operations: resourceOps.ls }),
      materializeTool,
    ]),
    customTools,
    permissionBoundary,
  };
}

function resolveToolPath(rawPath, cwd) {
  if (!rawPath) return null;
  if (process.platform === "win32") {
    return normalizeWin32ShellPath(rawPath, cwd, { allowRelative: true });
  }
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
}

function fileTouchToolPathParam(params) {
  if (!params || typeof params !== "object") return null;
  if (typeof params.path === "string" && params.path) return params.path;
  if (typeof params.file_path === "string" && params.file_path) return params.file_path;
  if (typeof params.filePath === "string" && params.filePath) return params.filePath;
  return null;
}

function normalizeFileTouchToolParams(params) {
  const rawPath = fileTouchToolPathParam(params);
  if (!rawPath || params?.path === rawPath) return params;
  return { ...params, path: rawPath };
}

function wrapFileTouchTool(tool, cwd, {
  origin,
  operationForPath,
  getSessionPath,
  recordFileOperation,
}: { origin?: any; operationForPath?: any; getSessionPath?: any; recordFileOperation?: any } = {}) {
  return {
    ...tool,
    execute: async (toolCallId, params, ...rest) => {
      const normalizedParams = normalizeFileTouchToolParams(params);
      const absolutePath = resolveToolPath(fileTouchToolPathParam(normalizedParams), cwd);
      const operation = absolutePath ? operationForPath?.(absolutePath) : null;
      let result;
      try {
        result = await tool.execute(toolCallId, normalizedParams, ...rest);
      } catch (err) {
        return {
          content: [{ type: "text", text: err?.message || String(err) }],
        };
      }
      const sessionPath = getSessionPath?.() || null;
      if (!absolutePath || !sessionPath || typeof recordFileOperation !== "function") {
        return result;
      }
      if (!fs.existsSync(absolutePath)) return result;
      try {
        const sessionFile = serializeSessionFile(recordFileOperation({
          sessionPath,
          filePath: absolutePath,
          label: path.basename(absolutePath),
          origin,
          operation,
        }));
        return appendSessionFileDetails(result, sessionFile, absolutePath);
      } catch (err) {
        return appendRegistrationWarning(result, err);
      }
    },
  };
}

function sessionFileRef(sessionFile) {
  const fileId = sessionFile?.fileId || sessionFile?.id || null;
  return fileId ? { kind: "session-file", fileId } : null;
}

function writableLocalRef(filePath) {
  return typeof filePath === "string" && path.isAbsolute(filePath)
    ? { kind: "local-file", path: filePath }
    : null;
}

function appendSessionFileDetails(result, sessionFile, filePath = null) {
  if (!sessionFile) return result;
  const sessionRef = sessionFileRef(sessionFile);
  const writableRef = writableLocalRef(filePath);
  return {
    ...(result || {}),
    details: {
      ...(result?.details || {}),
      sessionFile,
      ...(sessionRef ? { sessionFileRef: sessionRef } : {}),
      ...(writableRef ? { writableLocalRef: writableRef } : {}),
    },
  };
}

function appendRegistrationWarning(result, err) {
  const message = `Session file registration failed: ${err?.message || String(err)}`;
  const content = Array.isArray(result?.content) ? [...result.content] : [];
  return {
    ...(result || {}),
    content: [...content, { type: "text", text: message }],
  };
}
