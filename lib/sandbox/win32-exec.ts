/**
 * win32-exec.js — Windows 平台的命令执行函数
 *
 * Windows direct fallback 仍走 Pi SDK 兼容的 shell 执行路径；
 * 沙盒开启时由 createWin32Exec({ sandbox }) 通过 Windows restricted-token helper 启动。
 * Pi SDK 默认实现的 detached: true 在 Windows 上会设 DETACHED_PROCESS 标志，
 * 导致 MSYS2/Git Bash 的 stdout/stderr pipe 可能收不到数据。
 *
 * 这个模块提供替代的 exec 函数，使用 spawnAndStream（已去掉 Windows detached）。
 * 返回值契约匹配 Pi SDK BashOperations.exec。
 *
 * Runtime 策略：
 *   1. 默认 Windows shell 语义走 PowerShell
 *   2. cmd 内建 / batch / Windows 原生命令走 cmd.exe
 *   3. git / python / node 这类 argv 稳定的工具走专用 runner
 *   4. 只有显式 POSIX shell 命令走 bash/ash/sh 兼容层
 *
 * POSIX/Git runtime 优先使用打包进 resources/git 的 bundled Git runtime（MinGit：
 * git.exe + usr/bin/sh.exe，无 bash.exe；旧安装可能仍是 PortableGit 布局）。
 * 沙盒开启时找不到 bundled runtime 就 fail fast；沙盒关闭时才允许系统 Git Bash 兜底。
 */

import { existsSync, mkdirSync } from "fs";
import path, { dirname, join, resolve } from "path";
import { spawnSync } from "child_process";
import { spawnAndStream } from "./exec-helper.ts";
import { classifyWin32Command } from "./win32-command-router.ts";
import { assertSafeWin32BashCommand } from "./win32-bash-guard.ts";
import { buildWin32SandboxGrants } from "./win32-policy.ts";
import {
  buildWin32SandboxHelperArgs,
  createWin32SandboxTerminalStderrFilter,
  resolveWin32SandboxHelper,
  resourceSiblingDir,
} from "./win32-sandbox-helper.ts";
import {
  getSandboxPowerShellProbeResult,
  prepareSandboxRuntime,
  setSandboxPowerShellProbeResult,
} from "./win32-runtime-cache.ts";
import { createModuleLogger } from "../debug-log.ts";
import {
  isWin32PathLike,
  normalizeBackslashEscapedDoubleQuotes,
  quoteCmdArg,
  resolveWin32CmdExecutable,
  resolveWin32DefaultPowerShellExecutable,
  resolveWin32PowerShellExecutable,
  splitShellLikeArgs as splitShellLikeArgsBase,
} from "../shell/shell-utils.ts";
import { assertExecutionCwd } from "../shell/execution-cwd.ts";

const log = createModuleLogger("win32-exec");

// ── Shell 查找 ──

let _cachedShell = null; // { shell, args, label }

const PROBE_TOKEN = "__luc_probe_ok__";
const PYTHON_COMMANDS = new Set(["python", "python.exe", "python3", "python3.exe"]);
const NODE_COMMANDS = new Set(["node", "node.exe"]);
const POWERSHELL_COMMANDS = new Set(["powershell", "powershell.exe", "pwsh", "pwsh.exe"]);
const WIN32_SANDBOX_ENV_DIR = "win32-sandbox-env";
const STATUS_DLL_INIT_FAILED_UNSIGNED = 0xC0000142;
const STATUS_DLL_INIT_FAILED_SIGNED = -1073741502;
const WIN32_SANDBOX_HELPER_LAUNCH_FAILURE_RE = /luc-win-sandbox:\s+CreateProcessAsUserW failed/i;
const WIN32_DIAGNOSTIC_OUTPUT_PREVIEW_LIMIT = 8192;
const WIN32_SANDBOX_TERMINATION_GRACE_MS = 5000;
const WIN32_SANDBOX_HELPER_WATCHDOG_EXTRA_MS = WIN32_SANDBOX_TERMINATION_GRACE_MS + 2000;
const WIN32_SANDBOX_HELPER_STDIO_GRACE_MS = 2000;

// 枚举 Windows 盘符 C-Z（A/B 是软盘遗留，不扫）。
// 用户可能把 Git/MSYS2/Cygwin 装在任意非 C 盘（如 D:\Git、E:\msys64），
// 硬编码只找 C:/D: 在非这两个盘的机器上会直接失去 fallback。
const DRIVE_LETTERS = "CDEFGHIJKLMNOPQRSTUVWXYZ".split("");

function joinRuntimePath(root, ...segments) {
  return isWin32PathLike(root) ? path.win32.join(root, ...segments) : join(root, ...segments);
}

function dirnameRuntimePath(filePath) {
  return isWin32PathLike(filePath) ? path.win32.dirname(filePath) : dirname(filePath);
}

function basenameRuntimePath(filePath) {
  return isWin32PathLike(filePath) ? path.win32.basename(filePath) : path.basename(filePath);
}

function resolveRuntimePath(root, target) {
  return isWin32PathLike(root) || isWin32PathLike(target)
    ? path.win32.resolve(root || "", target)
    : resolve(root || "", target);
}

function normalizeRuntimePathForCompare(target) {
  const raw = String(target || "");
  return (isWin32PathLike(raw) ? path.win32.normalize(raw) : path.resolve(raw)).toLowerCase();
}

function runtimePathsEqual(a, b) {
  return normalizeRuntimePathForCompare(a) === normalizeRuntimePathForCompare(b);
}

function isInsideRuntimeRoot(target, root) {
  if (!target || !root) return false;
  const winPath = isWin32PathLike(target) || isWin32PathLike(root);
  const targetNorm = normalizeRuntimePathForCompare(target);
  const rootNorm = normalizeRuntimePathForCompare(root);
  const rel = winPath ? path.win32.relative(rootNorm, targetNorm) : path.relative(rootNorm, targetNorm);
  const isAbs = winPath ? path.win32.isAbsolute(rel) : path.isAbsolute(rel);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbs);
}

function pushUniqueRuntimePath(list, item) {
  if (!item) return;
  const key = String(item).toLowerCase();
  if (list.some(existing => String(existing).toLowerCase() === key)) return;
  list.push(item);
}

function getBundledGitRoots(env = process.env, deps: Record<string, any> = {}) {
  const resourcesPath = deps.resourcesPath !== undefined ? deps.resourcesPath : (process as any).resourcesPath;
  const resolveResourceSibling = deps.resourceSiblingDir || ((name, options) => resourceSiblingDir(name, options));
  const roots = [
    resourcesPath ? joinRuntimePath(resourcesPath, "git") : null,
    env.LUC_ROOT ? resolve(env.LUC_ROOT, "..", "git") : null,
    resolveResourceSibling("git", { env }),
  ].filter(Boolean);

  const found = [];
  for (const root of roots) {
    pushUniqueRuntimePath(found, root);
  }
  return found;
}

/**
 * 对候选 shell 做 probe：用 spawnSync 跑 echo，确认 shell 可正常启动
 */
function probeShell(shell, args, env = process.env) {
  try {
    const result = spawnSync(shell, [...args, `echo ${PROBE_TOKEN}`], {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    const stdout = (result.stdout || "").trim();
    // 检查 exit code + stdout 有实际输出 + 包含 probe token
    // 避免 shell 启动成功但 stdout pipe 失效（Windows detached 进程常见问题）
    return result.status === 0 && stdout.length > 0 && stdout.includes(PROBE_TOKEN);
  } catch {
    return false;
  }
}

/**
 * 收集所有磁盘上存在的 shell 候选（不缓存、不 probe）
 *
 * 只收集 bash 兼容 shell（PI SDK 生成 POSIX shell 命令，PowerShell 语法不兼容）。
 *
 * 查找顺序：
 * 1. 系统 Git Bash（标准 + 常见安装位置）
 * 2. 注册表查询 Git 安装路径
 * 3. 内嵌 bundled Git runtime 的 POSIX shell（打包进 resources/git/，MinGit 为 usr/bin/sh.exe）
 * 4. PATH 上的 bash.exe / sh.exe
 * 5. MSYS2 / Cygwin
 */
function getBundledShellCandidates(env = process.env, deps: Record<string, any> = {}) {
  const exists = deps.exists || existsSync;
  const found = [];
  const gitRoots = getBundledGitRoots(env, deps);
  for (const gitRoot of gitRoots) {
    const shellCandidates = [
      { relative: ["bin", "bash.exe"], args: ["-lc"], label: "PortableGit bash.exe" },
      { relative: ["usr", "bin", "bash.exe"], args: ["-lc"], label: "PortableGit usr/bin/bash.exe" },
      { relative: ["mingw64", "bin", "bash.exe"], args: ["-lc"], label: "PortableGit mingw64/bin/bash.exe" },
      // MinGit 的 POSIX shell：usr/bin/sh.exe（bash 以 POSIX/sh 模式运行）。
      // 对外契约是 sh-compatible，不承诺 Bash 特性；label 里不能出现 bash。
      { relative: ["usr", "bin", "sh.exe"], args: ["-c"], label: "MinGit usr/bin/sh.exe" },
      { relative: ["mingw64", "bin", "sh.exe"], args: ["-c"], label: "PortableGit sh.exe" },
      { relative: ["mingw64", "bin", "ash.exe"], args: ["-c"], label: "Legacy MinGit ash.exe" },
      { relative: ["mingw64", "bin", "busybox.exe"], args: ["sh", "-c"], label: "Legacy MinGit busybox.exe" },
    ];
    for (const candidate of shellCandidates) {
      const shell = joinRuntimePath(gitRoot, ...candidate.relative);
      if (exists(shell) && !found.some(c => c.shell === shell)) {
        found.push({
          shell,
          args: candidate.args,
          label: `Bundled ${candidate.label} (${shell})`,
          bundledRoot: gitRoot,
        });
      }
    }
  }
  return found;
}

function getBundledGitCandidates(env = process.env, deps: Record<string, any> = {}) {
  const exists = deps.exists || existsSync;
  const found = [];
  for (const gitRoot of getBundledGitRoots(env, deps)) {
    for (const relative of [
      ["cmd", "git.exe"],
      ["mingw64", "bin", "git.exe"],
    ]) {
      const git = joinRuntimePath(gitRoot, ...relative);
      if (exists(git) && !found.some(c => c.git === git)) {
        found.push({
          git,
          label: `Bundled Git runtime git.exe (${git})`,
          bundledRoot: gitRoot,
        });
      }
    }
  }
  return found;
}

function getAllGitCandidates({ bundledOnly = false, env = process.env } = {}) {
  const found = [...getBundledGitCandidates(env)];
  if (bundledOnly) return found;

  const addIfExists = (git, label) => {
    if (!git || !existsSync(git)) return;
    if (found.some(c => String(c.git).toLowerCase() === String(git).toLowerCase())) return;
    found.push({ git, label });
  };

  try {
    const result = spawnSync("where", ["git.exe"], {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
    });
    if (result.status === 0 && result.stdout) {
      for (const line of result.stdout.trim().split(/\r?\n/)) {
        const candidate = line.trim();
        if (!candidate) continue;
        addIfExists(candidate, `PATH git.exe (${candidate})`);
        if (found.some(c => c.git === candidate)) break;
      }
    }
  } catch {}

  const gitRoots = [];
  if (env.ProgramFiles) gitRoots.push(`${env.ProgramFiles}\\Git`);
  if (env["ProgramFiles(x86)"]) gitRoots.push(`${env["ProgramFiles(x86)"]}\\Git`);
  if (env.LOCALAPPDATA) gitRoots.push(`${env.LOCALAPPDATA}\\Programs\\Git`);
  if (env.USERPROFILE) gitRoots.push(`${env.USERPROFILE}\\scoop\\apps\\git\\current`);
  for (const d of DRIVE_LETTERS) gitRoots.push(`${d}:\\Git`);

  for (const root of gitRoots) {
    addIfExists(`${root}\\cmd\\git.exe`, `Git for Windows (${root}\\cmd\\git.exe)`);
  }

  return found;
}

function findGitRuntime({ env = process.env, bundledOnly = false } = {}) {
  const candidates = getAllGitCandidates({ env, bundledOnly });
  const gitRuntime = candidates[0] ?? null;
  if (gitRuntime) return gitRuntime;

  if (bundledOnly) {
    throw new Error(
      "[win32-exec] Sandboxed Git commands require bundled Git runtime, " +
      "but resources/git/cmd/git.exe was not found. Rebuild the Windows package with vendor/mingit."
    );
  }

  throw new Error(
    "[win32-exec] No usable git.exe found. Install Git for Windows or rebuild LucCode with bundled MinGit."
  );
}

function getAllShellCandidates({ preferBundled = false, bundledOnly = false, env = process.env } = {}) {
  const found = [];
  const bundled = getBundledShellCandidates(env);

  if (preferBundled) found.push(...bundled);
  if (bundledOnly) return found;

  // ── 1. 系统 Git Bash 标准 + 常见安装位置 ──
  const gitBashPaths = [];
  if (env.ProgramFiles) {
    gitBashPaths.push(`${env.ProgramFiles}\\Git\\bin\\bash.exe`);
  }
  if (env["ProgramFiles(x86)"]) {
    gitBashPaths.push(`${env["ProgramFiles(x86)"]}\\Git\\bin\\bash.exe`);
  }
  if (env.LOCALAPPDATA) {
    gitBashPaths.push(`${env.LOCALAPPDATA}\\Programs\\Git\\bin\\bash.exe`);
  }
  if (env.USERPROFILE) {
    gitBashPaths.push(`${env.USERPROFILE}\\scoop\\apps\\git\\current\\bin\\bash.exe`);
  }
  // 绿色版 / 根目录安装：扫 C-Z 盘，覆盖 E:\Git、F:\Git 等非标准盘符
  for (const d of DRIVE_LETTERS) {
    gitBashPaths.push(`${d}:\\Git\\bin\\bash.exe`);
  }

  for (const p of gitBashPaths) {
    if (existsSync(p)) {
      found.push({ shell: p, args: ["-c"], label: `Git Bash (${p})` });
    }
  }

  // ── 2. 注册表查询 Git 安装路径 ──
  for (const regKey of [
    "HKLM\\SOFTWARE\\GitForWindows",
    "HKCU\\SOFTWARE\\GitForWindows",
    "HKLM\\SOFTWARE\\WOW6432Node\\GitForWindows",
  ]) {
    try {
      const result = spawnSync("reg", ["query", regKey, "/v", "InstallPath"], {
        encoding: "utf-8",
        timeout: 5000,
        windowsHide: true,
      });
      if (result.status === 0 && result.stdout) {
        const match = result.stdout.match(/InstallPath\s+REG_SZ\s+(.+)/i);
        if (match) {
          const gitBash = join(match[1].trim(), "bin", "bash.exe");
          if (existsSync(gitBash) && !found.some(c => c.shell === gitBash)) {
            found.push({ shell: gitBash, args: ["-c"], label: `Git Bash via registry ${regKey} (${gitBash})` });
          }
        }
      }
    } catch {}
  }

  // ── 3. 内嵌 bundled Git runtime 的 POSIX shell ──
  if (!preferBundled) {
    for (const candidate of bundled) {
      if (!found.some(c => c.shell === candidate.shell)) found.push(candidate);
    }
  }

  // ── 4. PATH 上的 bash.exe / sh.exe ──
  for (const name of ["bash.exe", "sh.exe"]) {
    try {
      const result = spawnSync("where", [name], { encoding: "utf-8", timeout: 5000, windowsHide: true });
      if (result.status === 0 && result.stdout) {
        for (const line of result.stdout.trim().split(/\r?\n/)) {
          const candidate = line.trim();
          if (!candidate || !existsSync(candidate)) continue;
          if (found.some(c => c.shell === candidate)) continue;
          // System32/SysWOW64 下的 bash.exe 是 WSL launcher，不是真正的 bash shell
          // WSL 进入不同的文件系统命名空间，cwd/PATH/编码全对不上
          const lower = candidate.toLowerCase();
          if (lower.includes("\\windows\\system32\\") || lower.includes("\\windows\\syswow64\\")) continue;
          found.push({ shell: candidate, args: ["-c"], label: `PATH ${name} (${candidate})` });
          break;
        }
      }
    } catch {}
  }

  // ── 5. MSYS2 / Cygwin ──
  // 默认装在盘符根下的 msys64 / cygwin64 / cygwin，扫 C-Z 盘覆盖非 C 盘安装
  for (const d of DRIVE_LETTERS) {
    for (const p of [
      `${d}:\\msys64\\usr\\bin\\bash.exe`,
      `${d}:\\cygwin64\\bin\\bash.exe`,
      `${d}:\\cygwin\\bin\\bash.exe`,
    ]) {
      if (existsSync(p) && !found.some(c => c.shell === p)) {
        found.push({ shell: p, args: ["-c"], label: `MSYS2/Cygwin (${p})` });
      }
    }
  }

  // PowerShell 不在候选列表中：PI SDK 生成 bash 语法（&&、管道、command substitution 等），
  // PowerShell 语法完全不兼容，静默降级只会让每条命令以莫名方式失败。
  // 如果所有 bash 兼容 shell 都不可用，应该 fail fast 并给出明确的安装指引。

  return found;
}

/**
 * 从候选列表中找到第一个 probe 成功的 shell 并缓存
 * @param {string} [startAfter] - 跳过此路径及之前的所有候选（用于降级重试）
 */
function shellCacheMatchesOptions(shellInfo: any, options: Record<string, any> = {}) {
  if (!shellInfo) return false;
  if (options.bundledOnly && !shellInfo.bundledRoot) return false;
  if (options.preferBundled && !shellInfo.bundledRoot) return false;
  return true;
}

function findAndCacheShell(startAfter: any, options: Record<string, any> = {}) {
  // 有缓存且不是降级重试 → 直接返回
  if (_cachedShell && !startAfter && shellCacheMatchesOptions(_cachedShell, options)) return _cachedShell;

  const candidates = getAllShellCandidates(options);

  // 降级重试：跳过 startAfter 及之前的候选
  let startIdx = 0;
  if (startAfter) {
    const idx = candidates.findIndex(c => c.shell === startAfter);
    if (idx >= 0) startIdx = idx + 1;
  }

  const failures = [];

  for (let i = startIdx; i < candidates.length; i++) {
    const c = candidates[i];
    const probeEnv = getShellEnvForCandidate(options.env || process.env, c);
    if (probeShell(c.shell, c.args, probeEnv)) {
      _cachedShell = c;
      return c;
    }
    failures.push(c.label);
  }

  // 全部失败
  const allLabels = startAfter
    ? [`(前序已跳过)`, ...failures]
    : candidates.map(c => c.label);
  if (options.bundledOnly) {
    throw new Error(
      `[win32-exec] Sandboxed POSIX commands require bundled POSIX runtime under resources/git.\n` +
      `Tried bundled candidates:\n${allLabels.map(s => `  - ${s}`).join("\n") || "  - (none found)"}\n\n` +
      `Rebuild the Windows package with vendor/mingit, or disable sandbox explicitly.`
    );
  }
  throw new Error(
    `[win32-exec] No usable bash-compatible shell found.\n` +
    `Tried (probe failed):\n${allLabels.map(s => `  - ${s}`).join("\n")}\n\n` +
    `Suggestions:\n` +
    `  1. Install Git for Windows: https://git-scm.com/download/win\n` +
    `  2. Make sure bash.exe has execute permission\n` +
    `  3. If using antivirus software, check if it blocks bash.exe`
  );
}

// ── Spawn 错误判断 ──

const SPAWN_ERROR_CODES = new Set(["ENOENT", "EACCES", "EPERM", "UNKNOWN"]);

/**
 * 判断是否为 shell 启动失败的 spawn 级错误。
 *
 * Node 在 cwd 不存在时同样报 ENOENT，且 err.path 可能仍指向可执行文件。
 * ENOENT 时先排除 cwd 失效，避免把一个目录问题误判成 shell/helper 问题。
 */
function isShellSpawnError(err, shellPath, cwd) {
  if (!err || typeof err.code !== "string") return false;
  if (!SPAWN_ERROR_CODES.has(err.code)) return false;
  if (err.code === "ENOENT") {
    if (err.path && err.path !== shellPath) return false;
    try {
      if (cwd && !existsSync(cwd)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * 包装错误信息，附带完整诊断
 */
function enrichError(retryErr, primaryShell, originalErr) {
  const msg = [
    `[win32-exec] Cannot execute shell command.`,
    ``,
    `Primary shell: ${primaryShell.label}`,
    `  Error: ${originalErr.message} (${originalErr.code || "unknown"})`,
    ``,
    `Fallback also failed: ${retryErr.message}`,
    ``,
    `Suggestions:`,
    `  1. Reinstall Git for Windows: https://git-scm.com/download/win`,
    `  2. Make sure bash.exe has execute permission`,
    `  3. If using antivirus software, check if it blocks bash.exe`,
  ].join("\n");

  const enriched: any = new Error(msg);
  enriched.code = originalErr.code;
  return enriched;
}

// ── Shell 环境 ──

/**
 * 构建干净的 shell 执行环境
 * 移除 ELECTRON_RUN_AS_NODE（不应泄漏到用户命令子进程）
 */
function cleanShellEnv(baseEnv) {
  const env = { ...baseEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function withWin32Utf8Defaults(baseEnv) {
  const env = cleanShellEnv(baseEnv);
  if (env.PYTHONUTF8 == null) env.PYTHONUTF8 = "1";
  if (env.PYTHONIOENCODING == null) env.PYTHONIOENCODING = "utf-8";
  if (env.LANG == null) env.LANG = "C.UTF-8";
  if (env.LC_ALL == null) env.LC_ALL = "C.UTF-8";
  return env;
}

function setEnvCaseInsensitive(env, key, value) {
  const target = key.toLowerCase();
  for (const existing of Object.keys(env)) {
    if (existing !== key && existing.toLowerCase() === target) {
      delete env[existing];
    }
  }
  env[key] = value;
}

function withWin32SandboxRuntimeEnv(baseEnv, sandbox) {
  const env = withWin32Utf8Defaults(baseEnv);
  if (!sandboxIsEnabled(sandbox) || !sandbox?.luccodeHome) return env;

  const root = joinRuntimePath(sandbox.luccodeHome, ".ephemeral", WIN32_SANDBOX_ENV_DIR);
  const tempDir = joinRuntimePath(root, "Temp");
  const localAppDataDir = joinRuntimePath(root, "LocalAppData");
  const appDataDir = joinRuntimePath(root, "AppData", "Roaming");
  const npmCacheDir = joinRuntimePath(root, "npm-cache");
  const pipCacheDir = joinRuntimePath(root, "pip-cache");

  for (const dir of [tempDir, localAppDataDir, appDataDir, npmCacheDir, pipCacheDir]) {
    mkdirSync(dir, { recursive: true });
  }

  setEnvCaseInsensitive(env, "TEMP", tempDir);
  setEnvCaseInsensitive(env, "TMP", tempDir);
  setEnvCaseInsensitive(env, "LOCALAPPDATA", localAppDataDir);
  setEnvCaseInsensitive(env, "APPDATA", appDataDir);
  setEnvCaseInsensitive(env, "npm_config_cache", npmCacheDir);
  setEnvCaseInsensitive(env, "PIP_CACHE_DIR", pipCacheDir);
  return env;
}

function getShellEnv() {
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  return withWin32Utf8Defaults({ ...process.env, [pathKey]: process.env[pathKey] ?? "" });
}

function getRuntimeEnvForCandidate(baseEnv, runtimeInfo) {
  const env = cleanShellEnv(baseEnv || {});
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const current = String(env[pathKey] ?? "");
  const executable = runtimeInfo?.shell || runtimeInfo?.git || runtimeInfo?.executable;
  const isWinPath = isWin32PathLike(executable || "");
  const delimiter = current.includes(";") || isWinPath ? ";" : path.delimiter;
  const dirs = [];
  if (executable) dirs.push(dirnameRuntimePath(executable));
  if (runtimeInfo?.bundledRoot) {
    dirs.push(...getBundledRuntimePathDirs(runtimeInfo.bundledRoot));
  }
  for (const dir of runtimeInfo?.extraPathDirs || []) dirs.push(dir);
  const existing = new Set(current.split(delimiter).filter(Boolean).map((entry) => entry.toLowerCase()));
  const prepend = [];
  for (const dir of dirs) {
    if (!dir) continue;
    const key = dir.toLowerCase();
    if (existing.has(key) || prepend.some((entry) => entry.toLowerCase() === key)) continue;
    prepend.push(dir);
  }
  env[pathKey] = [...prepend, ...current.split(delimiter).filter(Boolean)].join(delimiter);
  return env;
}

function getBundledRuntimePathDirs(bundledRoot) {
  return [
    joinRuntimePath(bundledRoot, "bin"),
    joinRuntimePath(bundledRoot, "usr", "bin"),
    joinRuntimePath(bundledRoot, "mingw64", "bin"),
    joinRuntimePath(bundledRoot, "cmd"),
  ];
}

function getShellEnvForCandidate(baseEnv, shellInfo) {
  return getRuntimeEnvForCandidate(baseEnv, shellInfo);
}

export function resolveWin32ShellRuntime(options = {}) {
  return findAndCacheShell(null, options);
}

export function getWin32ShellEnvForRuntime(baseEnv, shellInfo) {
  return getShellEnvForCandidate(baseEnv, shellInfo);
}

function splitShellLikeArgs(command) {
  return splitShellLikeArgsBase(normalizeBackslashEscapedDoubleQuotes(command), {
    throwOnUnterminated: true,
    errorPrefix: "[win32-exec]",
  });
}

function parseGitCommandArgs(command) {
  const args = splitShellLikeArgs(command);
  const commandName = basenameRuntimePath(args[0] || "").toLowerCase();
  if (commandName !== "git" && commandName !== "git.exe") {
    throw new Error(`[win32-exec] Internal error: git runner received non-git command: ${command}`);
  }
  return args.slice(1);
}

function isPythonCommandName(name) {
  return PYTHON_COMMANDS.has(String(name || "").toLowerCase());
}

function isNodeCommandName(name) {
  return NODE_COMMANDS.has(String(name || "").toLowerCase());
}

function isPowerShellCommandName(name) {
  return POWERSHELL_COMMANDS.has(String(name || "").toLowerCase());
}

function resolveExplicitExecutableToken(token, cwd) {
  const raw = String(token || "");
  if (!raw) return null;
  if (isWin32PathLike(raw)) return raw;
  if (/^\.{1,2}[\\/]/.test(raw) || raw.includes("\\") || raw.includes("/")) {
    return resolveRuntimePath(cwd, raw);
  }
  return null;
}

function executableInfoFromPath(executable, label) {
  return { executable, label };
}

function firstPathResult(commandName, env) {
  try {
    const result = spawnSync("where", [commandName], {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
      env,
    });
    if (result.status === 0 && result.stdout) {
      return result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) || null;
    }
  } catch {}
  return null;
}

function isUsableCurrentNodeRuntime(executable) {
  return !!executable && existsSync(executable);
}

function findNodeRuntimeOnPath(commandName, args, env) {
  const candidates = [];
  if (env?.LUC_DEV_NODE_BIN) candidates.push(executableInfoFromPath(env.LUC_DEV_NODE_BIN, `LUC_DEV_NODE_BIN (${env.LUC_DEV_NODE_BIN})`));

  try {
    const result = spawnSync("where", [commandName], {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
      env,
    });
    if (result.status === 0 && result.stdout) {
      for (const line of result.stdout.trim().split(/\r?\n/)) {
        const candidate = line.trim();
        if (!candidate || !existsSync(candidate)) continue;
        if (!isNodeCommandName(basenameRuntimePath(candidate).toLowerCase())) continue;
        candidates.push(executableInfoFromPath(candidate, `PATH Node (${candidate})`));
      }
    }
  } catch {}

  if (isUsableCurrentNodeRuntime(process.execPath)) {
    candidates.push(executableInfoFromPath(process.execPath, `Current Node runtime (${process.execPath})`));
  }

  for (const candidate of candidates) {
    const executable = candidate.executable;
    if (!executable || !existsSync(executable)) continue;
    return { ...candidate, args };
  }
  return null;
}

function findNodeRuntime({ command, cwd, env = process.env }: { command?: any; cwd?: any; env?: any } = {}) {
  const args = splitShellLikeArgs(command);
  const token = args[0] || "";
  const commandName = basenameRuntimePath(token).toLowerCase();
  if (!isNodeCommandName(commandName)) {
    throw new Error(`[win32-exec] Internal error: node runner received non-node command: ${command}`);
  }

  const explicit = resolveExplicitExecutableToken(token, cwd);
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(`[win32-exec] Node executable not found: ${explicit}`);
    }
    if (!isInsideRuntimeRoot(explicit, cwd)) {
      const pathRuntime = findNodeRuntimeOnPath(commandName, args.slice(1), env);
      if (!pathRuntime || !runtimePathsEqual(pathRuntime.executable, explicit)) {
        throw new Error(
          `[win32-exec] Explicit Node executable is outside the workspace and not available on PATH: ${explicit}`
        );
      }
      return pathRuntime;
    }
    return { executable: explicit, args: args.slice(1), label: `Node (${explicit})` };
  }

  const pathRuntime = findNodeRuntimeOnPath(commandName, args.slice(1), env);
  if (pathRuntime) return pathRuntime;

  throw new Error(
    `[win32-exec] No usable Node runtime found for "${commandName}". ` +
    `Install Node.js, add it to PATH, or use an explicit node.exe path.`
  );
}

function findPythonRuntimeOnPath(commandName, args, env) {
  try {
    const result = spawnSync("where", [commandName], {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
      env,
    });
    if (result.status === 0 && result.stdout) {
      for (const line of result.stdout.trim().split(/\r?\n/)) {
        const candidate = line.trim();
        if (!candidate || !existsSync(candidate)) continue;
        if (!isPythonCommandName(basenameRuntimePath(candidate).toLowerCase())) continue;
        return { executable: candidate, args, label: `PATH Python (${candidate})` };
      }
    }
  } catch {}
  return null;
}

function findPythonRuntime({ command, cwd, env = process.env }: { command?: any; cwd?: any; env?: any } = {}) {
  const args = splitShellLikeArgs(command);
  const token = args[0] || "";
  const commandName = basenameRuntimePath(token).toLowerCase();
  if (!isPythonCommandName(commandName)) {
    throw new Error(`[win32-exec] Internal error: python runner received non-python command: ${command}`);
  }

  const explicit = resolveExplicitExecutableToken(token, cwd);
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(`[win32-exec] Python executable not found: ${explicit}`);
    }
    if (!isInsideRuntimeRoot(explicit, cwd)) {
      const pathRuntime = findPythonRuntimeOnPath(commandName, args.slice(1), env);
      if (!pathRuntime || !runtimePathsEqual(pathRuntime.executable, explicit)) {
        throw new Error(
          `[win32-exec] Explicit Python executable is outside the workspace and not available on PATH: ${explicit}`
        );
      }
      return pathRuntime;
    }
    return { executable: explicit, args: args.slice(1), label: `Python (${explicit})` };
  }

  const pathRuntime = findPythonRuntimeOnPath(commandName, args.slice(1), env);
  if (pathRuntime) return pathRuntime;

  throw new Error(
    `[win32-exec] No usable Python runtime found for "${commandName}". ` +
    `Install Python, add it to PATH, or use an explicit python.exe path.`
  );
}

function powerShellBaseArgs({ sandboxed = false }: { sandboxed?: boolean } = {}) {
  return [
    "-NoLogo",
    "-NoProfile",
    ...(sandboxed ? ["-NonInteractive"] : []),
    "-ExecutionPolicy",
    "Bypass",
  ];
}

const POWERSHELL_UTF8_PRELUDE =
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; " +
  "$OutputEncoding = [Console]::OutputEncoding";

function quotePowerShellSingleArg(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function withPowerShellUtf8Prelude(command) {
  const raw = String(command || "");
  return raw.trim()
    ? `${POWERSHELL_UTF8_PRELUDE}; ${raw}`
    : POWERSHELL_UTF8_PRELUDE;
}

function isPowerShellCommandFlag(value) {
  const flag = String(value || "").toLowerCase();
  return flag === "-command" || flag === "/command" || flag === "-c";
}

function isPowerShellEncodedCommandFlag(value) {
  const flag = String(value || "").toLowerCase();
  return flag === "-encodedcommand" || flag === "/encodedcommand" || flag === "-enc";
}

function isPowerShellFileFlag(value) {
  const flag = String(value || "").toLowerCase();
  return flag === "-file" || flag === "/file";
}

function powerShellFileInvocation(script, args) {
  const scriptPart = quotePowerShellSingleArg(script);
  const argPart = args.map((arg) => quotePowerShellSingleArg(arg)).join(" ");
  return `& ${scriptPart}${argPart ? ` ${argPart}` : ""}`;
}

function powerShellArgsWithUtf8Prelude(args) {
  if (args.some(isPowerShellEncodedCommandFlag)) return args;

  const commandIndex = args.findIndex(isPowerShellCommandFlag);
  if (commandIndex >= 0) {
    if (commandIndex + 1 >= args.length) return args;
    const next = [...args];
    next[commandIndex + 1] = withPowerShellUtf8Prelude(next[commandIndex + 1]);
    return next;
  }

  const fileIndex = args.findIndex(isPowerShellFileFlag);
  if (fileIndex >= 0) {
    if (fileIndex + 1 >= args.length) return args;
    const before = args.slice(0, fileIndex);
    const script = args[fileIndex + 1];
    const scriptArgs = args.slice(fileIndex + 2);
    return [
      ...before,
      "-Command",
      withPowerShellUtf8Prelude(powerShellFileInvocation(script, scriptArgs)),
    ];
  }

  return args;
}

function resolvePowerShellExecutable(token, env = process.env) {
  return resolveWin32PowerShellExecutable(token, env, {
    resolveOnPath: (commandName) => firstPathResult(commandName, env),
  });
}

function resolveDefaultPowerShellExecutable(env = process.env) {
  return resolveWin32DefaultPowerShellExecutable(env, {
    resolveOnPath: (commandName) => firstPathResult(commandName, env),
    exists: existsSync,
    spawn: spawnSync,
  });
}

function parsePowerShellCommand(command, env, options = {}) {
  const args = splitShellLikeArgs(command);
  const token = args[0] || "";
  const commandName = basenameRuntimePath(token).toLowerCase();
  if (!isPowerShellCommandName(commandName)) {
    throw new Error(`[win32-exec] Internal error: PowerShell runner received non-PowerShell command: ${command}`);
  }
  return {
    executable: resolvePowerShellExecutable(token, env),
    args: powerShellArgsWithUtf8Prelude([...powerShellBaseArgs(options), ...args.slice(1)]),
  };
}

function parsePowerShellFileCommand(command, env, options = {}) {
  const args = splitShellLikeArgs(command);
  const script = args[0] || "";
  if (!/\.ps1$/i.test(basenameRuntimePath(script))) {
    throw new Error(`[win32-exec] Internal error: PowerShell file runner received non-.ps1 command: ${command}`);
  }
  return {
    executable: resolveDefaultPowerShellExecutable(env),
    args: [
      ...powerShellBaseArgs(options),
      "-Command",
      withPowerShellUtf8Prelude(powerShellFileInvocation(script, args.slice(1))),
    ],
  };
}

function parseDefaultPowerShellCommand(command, env, options = {}) {
  return {
    executable: resolveDefaultPowerShellExecutable(env),
    args: [
      ...powerShellBaseArgs(options),
      "-Command",
      withPowerShellUtf8Prelude(normalizeBackslashEscapedDoubleQuotes(command)),
    ],
  };
}

function cmdScriptCommand(command) {
  const args = splitShellLikeArgs(command);
  const script = args[0] || "";
  if (!/\.(?:bat|cmd)$/i.test(basenameRuntimePath(script))) {
    throw new Error(`[win32-exec] Internal error: CMD script runner received non-.bat/.cmd command: ${command}`);
  }
  return [
    quoteCmdArg(script),
    ...args.slice(1).map((arg) => quoteCmdArg(arg)),
  ].join(" ");
}

function cmdArgsForCommand(command) {
  // /s 会剥掉整段的首尾引号；外层引号由此处补上，两条执行路径都必须
  // verbatim 传递本数组，任何一层再做 MSVCRT 转义都会破坏 cmd 解析。
  return ["/d", "/s", "/c", `"chcp 65001 >NUL & ${command}"`];
}

function sandboxIsEnabled(sandbox) {
  return !!sandbox;
}

function isStatusDllInitFailedExitCode(exitCode) {
  return exitCode === STATUS_DLL_INIT_FAILED_UNSIGNED
    || exitCode === STATUS_DLL_INIT_FAILED_SIGNED;
}

function formatWin32ExitCodeHex(exitCode) {
  if (typeof exitCode !== "number") return "unknown";
  return `0x${(exitCode >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

function envValue(env, key) {
  if (!env) return "";
  const found = Object.keys(env).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
  return found ? String(env[found] || "") : "";
}

function diagnosticValueMetadata(label, value) {
  const text = value == null ? "" : String(value);
  return `${label}: present=${text.length > 0} length=${text.length}`;
}

function diagnosticArgsMetadata(args) {
  const values = Array.isArray(args) ? args.map((arg) => String(arg)) : [];
  const lengths = values.map((arg) => arg.length);
  const totalLength = lengths.reduce((sum, length) => sum + length, 0);
  const maxLength = lengths.length > 0 ? Math.max(...lengths) : 0;
  return `Args: count=${values.length} totalLength=${totalLength} maxLength=${maxLength}`;
}

function splitWin32PathEnv(env) {
  const raw = envValue(env, "PATH") || envValue(env, "Path");
  return String(raw || "").split(";").filter(Boolean);
}

function pathIndex(entries, pattern) {
  return entries.findIndex((entry) => pattern.test(entry));
}

function collectWin32EnvironmentDiagnostics(env) {
  const pathEntries = splitWin32PathEnv(env);
  const system32Index = pathIndex(pathEntries, /\\windows\\system32(?:\\|$)/i);
  const bundledGitIndex = pathIndex(pathEntries, /\\(?:resources\\git|git)\\(?:bin|usr\\bin|mingw64\\bin|cmd)(?:\\|$)/i);
  return [
    diagnosticValueMetadata("ComSpec", envValue(env, "ComSpec") || envValue(env, "COMSPEC")),
    diagnosticValueMetadata("SystemRoot", envValue(env, "SystemRoot")),
    diagnosticValueMetadata("PATHEXT", envValue(env, "PATHEXT")),
    `PATH entries: ${pathEntries.length}`,
    `PATH System32 index: ${system32Index}`,
    `PATH bundled Git index: ${bundledGitIndex}`,
    diagnosticValueMetadata("TEMP", envValue(env, "TEMP")),
    diagnosticValueMetadata("TMP", envValue(env, "TMP")),
    diagnosticValueMetadata("LOCALAPPDATA", envValue(env, "LOCALAPPDATA")),
    diagnosticValueMetadata("APPDATA", envValue(env, "APPDATA")),
    diagnosticValueMetadata("LUC_ROOT", envValue(env, "LUC_ROOT")),
    diagnosticValueMetadata("LUC_SERVER_ENTRY", envValue(env, "LUC_SERVER_ENTRY")),
    diagnosticValueMetadata("process.execPath", process.execPath),
    `Node: ${process.versions.node || "unknown"} ABI ${process.versions.modules || "unknown"}`,
  ];
}

function emitWin32RuntimeFailureDiagnostic(onData, {
  route,
  mode,
  executable,
  args,
  runtimeInfo,
  helperPath,
  sandbox,
  cwd,
  env,
  exitCode,
  outputBytes,
  durationMs,
}) {
  if (typeof onData !== "function") return;
  const runner = route?.runner || "unknown";
  const runnerReason = route?.reason || "unknown";
  const resolvedExecutable = executable || runtimeInfo?.shell || runtimeInfo?.git || runtimeInfo?.executable || "";
  const lines = [
    "",
    `[win32-exec] ${runner} runner failed before command output (STATUS_DLL_INIT_FAILED / 0xC0000142).`,
    `Exit code: ${exitCode} (${formatWin32ExitCodeHex(exitCode)})`,
    `Route: runner=${runner} reason=${runnerReason} mode=${mode || "unknown"} sandbox=${sandboxIsEnabled(sandbox)}`,
    diagnosticValueMetadata("Executable", resolvedExecutable),
    diagnosticArgsMetadata(args),
    diagnosticValueMetadata("CWD", cwd),
    diagnosticValueMetadata("Helper", helperPath),
    diagnosticValueMetadata("Runtime label", runtimeInfo?.label),
    diagnosticValueMetadata("Runtime root", runtimeInfo?.bundledRoot),
    diagnosticValueMetadata("LUC_HOME", sandbox?.luccodeHome || envValue(env, "LUC_HOME")),
    `Output bytes before failure: ${outputBytes ?? 0}`,
    `Duration ms: ${durationMs ?? "unknown"}`,
    ...collectWin32EnvironmentDiagnostics(env),
    "Default PowerShell/cmd/terminal execution is not changed by this diagnostic path.",
    "No fallback was attempted for this STATUS_DLL_INIT_FAILED result.",
    "Likely causes: Windows child process DLL initialization failed, the restricted-token helper environment is incomplete, or a runtime cache/AV block is preventing startup.",
    "Next step: attach this diagnostic with the command log; for cached POSIX runtimes also clear LUC_HOME/.ephemeral/win32-sandbox-runtime and retry.",
    "",
  ].filter(Boolean);
  onData(Buffer.from(`${lines.join("\n")}\n`, "utf-8"));
}

function emitWin32SandboxHelperLaunchFailureDiagnostic(onData, {
  route,
  mode,
  executable,
  args,
  runtimeInfo,
  helperPath,
  sandbox,
  cwd,
  env,
  exitCode,
  outputBytes,
  durationMs,
}) {
  if (typeof onData !== "function") return;
  const runner = route?.runner || "unknown";
  const runnerReason = route?.reason || "unknown";
  const resolvedExecutable = executable || runtimeInfo?.shell || runtimeInfo?.git || runtimeInfo?.executable || "";
  const lines = [
    "",
    "[win32-exec] sandbox helper launch failed before command execution.",
    "Native helper reported CreateProcessAsUserW failure.",
    `Exit code: ${exitCode ?? "unknown"}`,
    `Route: runner=${runner} reason=${runnerReason} mode=${mode || "unknown"} sandbox=${sandboxIsEnabled(sandbox)}`,
    diagnosticValueMetadata("Executable", resolvedExecutable),
    diagnosticArgsMetadata(args),
    diagnosticValueMetadata("CWD", cwd),
    diagnosticValueMetadata("Helper", helperPath),
    diagnosticValueMetadata("Runtime label", runtimeInfo?.label),
    diagnosticValueMetadata("Runtime root", runtimeInfo?.bundledRoot),
    diagnosticValueMetadata("LUC_HOME", sandbox?.luccodeHome || envValue(env, "LUC_HOME")),
    `Output bytes before failure: ${outputBytes ?? 0}`,
    `Duration ms: ${durationMs ?? "unknown"}`,
    ...collectWin32EnvironmentDiagnostics(env),
    "No fallback was attempted for this CreateProcessAsUserW result.",
    "Use the structured native launch-failure fields above to compare launch-stage metadata and token probes without exposing command content.",
    "",
  ].filter(Boolean);
  onData(Buffer.from(`${lines.join("\n")}\n`, "utf-8"));
}

async function runWithWin32Diagnostics({
  route,
  mode,
  executable,
  args,
  runtimeInfo = undefined,
  helperPath = undefined,
  sandbox,
  cwd,
  env,
  onData,
  run,
}: Record<string, any>) {
  const startedAt = Date.now();
  let outputBytes = 0;
  let outputPreview = "";
  const diagnosticOnData = (data) => {
    if (data != null) {
      outputBytes += Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data));
      const text = Buffer.isBuffer(data) ? data.toString("utf-8") : String(data);
      outputPreview = `${outputPreview}${text}`;
      if (outputPreview.length > WIN32_DIAGNOSTIC_OUTPUT_PREVIEW_LIMIT) {
        outputPreview = outputPreview.slice(-WIN32_DIAGNOSTIC_OUTPUT_PREVIEW_LIMIT);
      }
    }
    onData?.(data);
  };
  const result = await run(diagnosticOnData);
  if (isStatusDllInitFailedExitCode(result?.exitCode)) {
    emitWin32RuntimeFailureDiagnostic(onData, {
      route,
      mode,
      executable,
      args,
      runtimeInfo,
      helperPath,
      sandbox,
      cwd,
      env,
      exitCode: result.exitCode,
      outputBytes,
      durationMs: Date.now() - startedAt,
    });
  } else if (
    mode === "sandbox-helper" &&
    result?.exitCode !== 0 &&
    WIN32_SANDBOX_HELPER_LAUNCH_FAILURE_RE.test(outputPreview)
  ) {
    emitWin32SandboxHelperLaunchFailureDiagnostic(onData, {
      route,
      mode,
      executable,
      args,
      runtimeInfo,
      helperPath,
      sandbox,
      cwd,
      env,
      exitCode: result?.exitCode,
      outputBytes,
      durationMs: Date.now() - startedAt,
    });
  }
  return result;
}

function prepareRuntimeForSandbox(runtimeInfo, sandbox, kind) {
  if (!sandboxIsEnabled(sandbox) || !sandbox?.luccodeHome) return runtimeInfo;
  return prepareSandboxRuntime(runtimeInfo, {
    lucHome: sandbox.luccodeHome,
    kind,
  });
}

function grantsForSandbox(sandbox, cwd) {
  if (!sandbox) return { readPaths: [], optionalReadPaths: [], writePaths: [], optionalWritePaths: [], denyReadPaths: [], denyWritePaths: [] };
  if (sandbox.grants) {
    return {
      readPaths: sandbox.grants.readPaths || [],
      optionalReadPaths: sandbox.grants.optionalReadPaths || [],
      writePaths: sandbox.grants.writePaths || [],
      optionalWritePaths: sandbox.grants.optionalWritePaths || [],
      denyReadPaths: sandbox.grants.denyReadPaths || [],
      denyWritePaths: sandbox.grants.denyWritePaths || [],
    };
  }
  return buildWin32SandboxGrants({
    policy: sandbox.policy,
    cwd,
  });
}

function assertSandboxNetworkSupported(sandbox) {
  const mode = typeof sandbox.getSandboxNetworkMode === "function"
    ? sandbox.getSandboxNetworkMode()
    : null;
  const enabled = typeof sandbox.getSandboxNetworkEnabled === "function"
    ? sandbox.getSandboxNetworkEnabled()
    : true;

  if (mode === "none" || mode === false || !enabled) {
    throw new Error(
      "[win32-sandbox] Windows restricted-token sandbox does not support network-off mode. " +
      "Re-enable sandbox networking or disable the command sandbox explicitly."
    );
  }
}

function cleanupRootsForSandboxGrants(grants) {
  return [
    ...(grants?.writePaths || []),
    ...(grants?.optionalWritePaths || []),
  ];
}

// A write-restricted token can only write inside the paths the sandbox
// explicitly granted. PowerShell writes a small policy-probe script file to
// %TEMP% while starting up to figure out whether an AppLocker-style script
// restriction applies; when that write is denied — the user's real %TEMP% is
// not one of the granted paths — PowerShell falls back to Constrained
// Language Mode, which breaks most one-shot commands. withWin32SandboxRuntimeEnv
// (above) already points TEMP/TMP at <lucHome>/.ephemeral/win32-sandbox-env
// for sandboxed sessions; this makes sure that directory is one of the
// sandbox's *required* write roots. The restricted-token startup probe needs
// a guaranteed write grant for this directory; an optional root does not
// provide the same contract. This lets the token write there under every code
// path, not just the ones that happen to also touch a required root for other
// reasons.
function win32SandboxEnvRoot(lucHome) {
  if (!lucHome) return null;
  return joinRuntimePath(lucHome, ".ephemeral", WIN32_SANDBOX_ENV_DIR);
}

function withSandboxEnvRootAsRequiredWritePath(grants, lucHome) {
  const root = win32SandboxEnvRoot(lucHome);
  // No lucHome means withWin32SandboxRuntimeEnv never redirected TEMP in
  // the first place; nothing to promote to a required root here.
  if (!root) return grants;
  mkdirSync(root, { recursive: true });
  const existingWritePaths = grants?.writePaths || [];
  if (existingWritePaths.some((p) => String(p).toLowerCase() === root.toLowerCase())) return grants;
  return { ...grants, writePaths: [...existingWritePaths, root] };
}

async function spawnViaSandboxHelper({
  sandbox,
  executable,
  args,
  cwd,
  env,
  onData,
  signal,
  timeout,
  desktopMode = "private",
  verbatimLastArg = false,
}) {
  const helper = sandbox.helperPath || resolveWin32SandboxHelper({ env });
  if (!helper) {
    throw new Error(
      "[win32-sandbox] Windows restricted-token helper is unavailable. " +
      "Run scripts/build-windows-sandbox-helper.mjs during packaging, or disable sandbox explicitly."
    );
  }
  assertSandboxNetworkSupported(sandbox);
  const grants = withSandboxEnvRootAsRequiredWritePath(grantsForSandbox(sandbox, cwd), sandbox.luccodeHome);
  const nativeTimeoutMs = timeout == null || timeout <= 0
    ? 0
    : Math.min(Math.ceil(timeout * 1000), 0xFFFFFFFE);
  const helperArgs = buildWin32SandboxHelperArgs({
    cwd,
    timeoutMs: nativeTimeoutMs,
    desktopMode,
    verbatimLastArg,
    grants,
    executable,
    args,
  } as any);
  const cleanupQueue = sandbox.legacyCleanupQueue;
  const cleanupRoots = cleanupRootsForSandboxGrants(grants);
  const lease = cleanupQueue?.beginRootUse?.(cleanupRoots);
  try {
    const stderrFilter = createWin32SandboxTerminalStderrFilter({ onData });
    const watchdogTimeout = nativeTimeoutMs > 0
      ? (nativeTimeoutMs + WIN32_SANDBOX_HELPER_WATCHDOG_EXTRA_MS) / 1000
      : undefined;
    let result;
    try {
      result = await spawnAndStream(helper, helperArgs, {
        cwd,
        env,
        onData,
        onStdout: onData,
        onStderr: (data) => stderrFilter.push(data),
        signal,
        timeout: watchdogTimeout,
        timeoutErrorValue: timeout,
        exitStdioGraceMs: WIN32_SANDBOX_HELPER_STDIO_GRACE_MS,
        // Terminating the helper closes its KILL_ON_JOB_CLOSE handle. Do not start
        // taskkill for sandbox execution; the private Job owns the command tree.
        killMode: "process",
      });
    } finally {
      stderrFilter.flush();
    }
    const terminal = stderrFilter.terminalRecord;
    if (!terminal) {
      const error: any = new Error("[win32-sandbox] helper terminal record missing or invalid");
      error.code = "LUC_WIN32_SANDBOX_TERMINAL_PROTOCOL";
      throw error;
    }
    if (terminal.status === "timed_out") {
      throw new Error(`timeout:${timeout}`);
    }
    if (terminal.status === "termination_failed") {
      const error: any = new Error(
        `[win32-sandbox] native Job termination failed (win32Error=${terminal.win32Error})`
      );
      error.code = "LUC_WIN32_SANDBOX_TERMINATION_FAILED";
      error.win32Error = terminal.win32Error;
      throw error;
    }
    if (terminal.status === "exited" && terminal.exitCode !== null) {
      return { exitCode: terminal.exitCode };
    }
    return result;
  } finally {
    cleanupQueue?.endRootUse?.(lease);
    cleanupQueue?.enqueueRoots?.(cleanupRoots);
  }
}

// ── 沙盒 PowerShell 启动探针 ──
//
// Even with TEMP redirected (see withWin32SandboxRuntimeEnv and
// withSandboxEnvRootAsRequiredWritePath above), a PowerShell build
// or a machine policy this codebase hasn't seen yet could still fail the same
// way. Rather than trust that in the dark, the first sandboxed PowerShell
// command for a given executable in this process runs a tiny scripted probe
// through the real sandbox helper before anything user-facing does; the
// verdict is cached so every later command for that same executable skips
// the probe. A failed probe fails the whole PowerShell route with a clear,
// actionable error instead of letting a command silently run in Constrained
// Language Mode and produce confusing partial output.

const SANDBOX_POWERSHELL_PROBE_TIMEOUT_SECONDS = 15;
const SANDBOX_POWERSHELL_PROBE_ARGS = ["-NoProfile", "-NonInteractive", "-Command", "[Console]::Out.Write('ok')"];
const SANDBOX_POWERSHELL_CLM_MARKER = "MethodInvocationNotSupportedInConstrainedLanguage";

async function probeSandboxPowerShellExecutable(executable, { sandbox, cwd, env }) {
  let stdout = "";
  try {
    const result = await spawnViaSandboxHelper({
      sandbox,
      executable,
      args: SANDBOX_POWERSHELL_PROBE_ARGS,
      cwd,
      env,
      onData: (chunk) => { stdout += String(chunk ?? ""); },
      signal: undefined,
      timeout: SANDBOX_POWERSHELL_PROBE_TIMEOUT_SECONDS,
      desktopMode: "private",
    });
    if (stdout.includes(SANDBOX_POWERSHELL_CLM_MARKER)) return "unsupported";
    return result?.exitCode === 0 && stdout.includes("ok") ? "ok" : "unsupported";
  } catch {
    return "unsupported";
  }
}

async function ensureSandboxPowerShellExecutableProbed(executable, probeCtx) {
  const cached = getSandboxPowerShellProbeResult(executable);
  if (cached === "ok") return true;
  if (cached === "unsupported") return false;
  const result = await probeSandboxPowerShellExecutable(executable, probeCtx);
  setSandboxPowerShellProbeResult(executable, result);
  return result === "ok";
}

function throwSandboxPowerShellUnsupported() {
  const error: any = new Error(
    "[win32-sandbox] PowerShell failed its restricted-token startup probe and cannot run inside the sandbox. "
    + "Rerun it with sandbox_permissions=\"require_escalated\" and a one-sentence justification; "
    + "the user reviews it before it runs unsandboxed.",
  );
  error.code = "LUC_WIN32_SANDBOX_POWERSHELL_UNSUPPORTED";
  throw error;
}

// ── 导出 ──

/**
 * 创建 Windows 平台的命令执行函数
 *
 * spawn 失败时自动降级到下一个可用 shell（清缓存 + 重试）。
 * 只对 spawn 级错误（ENOENT/EACCES/EPERM）降级，abort/timeout/命令错误原样抛出。
 *
 * @returns {(command: string, cwd: string, opts: object) => Promise<{exitCode: number|null}>}
 */
export function createWin32Exec({ sandbox = null } = {}) {
  return async (command, cwd, { onData, signal, timeout, env }) => {
    cwd = assertExecutionCwd(cwd);
    const shellEnv = withWin32SandboxRuntimeEnv(env ?? getShellEnv(), sandbox);
    const route = classifyWin32Command(command);

    if (route.runner === "cmd") {
      if (sandboxIsEnabled(sandbox)) {
        const executable = resolveWin32CmdExecutable(shellEnv);
        const args = cmdArgsForCommand(command);
        const helperPath = sandbox.helperPath || resolveWin32SandboxHelper({ env: shellEnv });
        return runWithWin32Diagnostics({
          route,
          mode: "sandbox-helper",
          executable,
          args,
          cwd,
          env: shellEnv,
          onData,
          helperPath,
          sandbox,
          run: (diagnosticOnData) => spawnViaSandboxHelper({
            sandbox,
            executable,
            args,
            cwd,
            env: shellEnv,
            onData: diagnosticOnData,
            signal,
            timeout,
            verbatimLastArg: true,
          }),
        });
      }
      const executable = resolveWin32CmdExecutable(shellEnv);
      const args = cmdArgsForCommand(command);
      return runWithWin32Diagnostics({
        route,
        mode: "direct-cmd",
        executable,
        args,
        cwd,
        env: shellEnv,
        onData,
        sandbox,
        run: (diagnosticOnData) => spawnAndStream(executable, args, {
          cwd,
          env: shellEnv,
          onData: diagnosticOnData,
          signal,
          timeout,
          windowsVerbatimArguments: true,
        }),
      });
    }

    if (route.runner === "cmd-script") {
      const nativeCommand = `call ${cmdScriptCommand(command)}`;
      if (sandboxIsEnabled(sandbox)) {
        const executable = resolveWin32CmdExecutable(shellEnv);
        const args = cmdArgsForCommand(nativeCommand);
        const helperPath = sandbox.helperPath || resolveWin32SandboxHelper({ env: shellEnv });
        return runWithWin32Diagnostics({
          route,
          mode: "sandbox-helper",
          executable,
          args,
          cwd,
          env: shellEnv,
          onData,
          helperPath,
          sandbox,
          run: (diagnosticOnData) => spawnViaSandboxHelper({
            sandbox,
            executable,
            args,
            cwd,
            env: shellEnv,
            onData: diagnosticOnData,
            signal,
            timeout,
            verbatimLastArg: true,
          }),
        });
      }
      const executable = resolveWin32CmdExecutable(shellEnv);
      const args = cmdArgsForCommand(nativeCommand);
      return runWithWin32Diagnostics({
        route,
        mode: "direct-cmd",
        executable,
        args,
        cwd,
        env: shellEnv,
        onData,
        sandbox,
        run: (diagnosticOnData) => spawnAndStream(executable, args, {
          cwd,
          env: shellEnv,
          onData: diagnosticOnData,
          signal,
          timeout,
          windowsVerbatimArguments: true,
        }),
      });
    }

    if (route.runner === "powershell" || route.runner === "powershell-file" || route.runner === "powershell-command") {
      const sandboxed = sandboxIsEnabled(sandbox);
      const powerShellOptions = { sandboxed };
      const powerShellInfo = route.runner === "powershell"
        ? parsePowerShellCommand(command, shellEnv, powerShellOptions)
        : route.runner === "powershell-file"
          ? parsePowerShellFileCommand(command, shellEnv, powerShellOptions)
          : parseDefaultPowerShellCommand(command, shellEnv, powerShellOptions);

      if (sandboxed) {
        const probeCtx = { sandbox, cwd, env: shellEnv };
        if (route.runner === "powershell") {
          // The model explicitly named this shell (pwsh vs. powershell.exe); probe
          // exactly that executable and fail rather than silently swap runtimes.
          if (!(await ensureSandboxPowerShellExecutableProbed(powerShellInfo.executable, probeCtx))) {
            throwSandboxPowerShellUnsupported();
          }
        } else {
          // Default routing: prefer pwsh, same as the unsandboxed default, but
          // only trust whichever executable actually passes the sandboxed
          // startup probe. If neither does, fail the whole route rather than
          // quietly falling back to cmd.
          if (!(await ensureSandboxPowerShellExecutableProbed(powerShellInfo.executable, probeCtx))) {
            const legacy = resolvePowerShellExecutable("powershell.exe", shellEnv);
            const legacyIsDifferent = legacy.toLowerCase() !== powerShellInfo.executable.toLowerCase();
            if (!legacyIsDifferent || !(await ensureSandboxPowerShellExecutableProbed(legacy, probeCtx))) {
              throwSandboxPowerShellUnsupported();
            }
            powerShellInfo.executable = legacy;
          }
        }

        const helperPath = sandbox.helperPath || resolveWin32SandboxHelper({ env: shellEnv });
        return runWithWin32Diagnostics({
          route,
          mode: "sandbox-helper",
          executable: powerShellInfo.executable,
          args: powerShellInfo.args,
          cwd,
          env: shellEnv,
          onData,
          helperPath,
          sandbox,
          run: (diagnosticOnData) => spawnViaSandboxHelper({
            sandbox,
            executable: powerShellInfo.executable,
            args: powerShellInfo.args,
            cwd,
            env: shellEnv,
            onData: diagnosticOnData,
            signal,
            timeout,
            desktopMode: "private",
          }),
        });
      }

      return runWithWin32Diagnostics({
        route,
        mode: "direct-spawn",
        executable: powerShellInfo.executable,
        args: powerShellInfo.args,
        cwd,
        env: shellEnv,
        onData,
        sandbox,
        run: (diagnosticOnData) => spawnAndStream(powerShellInfo.executable, powerShellInfo.args, {
          cwd,
          env: shellEnv,
          onData: diagnosticOnData,
          signal,
          timeout,
        }),
      });
    }

    if (route.runner === "git") {
      const gitInfo = prepareRuntimeForSandbox(findGitRuntime({
        env: shellEnv,
        bundledOnly: sandboxIsEnabled(sandbox),
      }), sandbox, "git");
      const gitArgs = parseGitCommandArgs(command);
      const gitEnv = getRuntimeEnvForCandidate(shellEnv, gitInfo);

      if (sandboxIsEnabled(sandbox)) {
        const helperPath = sandbox.helperPath || resolveWin32SandboxHelper({ env: gitEnv });
        return runWithWin32Diagnostics({
          route,
          mode: "sandbox-helper",
          executable: gitInfo.git,
          args: gitArgs,
          runtimeInfo: gitInfo,
          cwd,
          env: gitEnv,
          onData,
          helperPath,
          sandbox,
          run: (diagnosticOnData) => spawnViaSandboxHelper({
            sandbox,
            executable: gitInfo.git,
            args: gitArgs,
            cwd,
            env: gitEnv,
            onData: diagnosticOnData,
            signal,
            timeout,
          }),
        });
      }

      return runWithWin32Diagnostics({
        route,
        mode: "direct-spawn",
        executable: gitInfo.git,
        args: gitArgs,
        runtimeInfo: gitInfo,
        cwd,
        env: gitEnv,
        onData,
        sandbox,
        run: (diagnosticOnData) => spawnAndStream(gitInfo.git, gitArgs, {
          cwd,
          env: gitEnv,
          onData: diagnosticOnData,
          signal,
          timeout,
        }),
      });
    }

    if (route.runner === "python") {
      const pythonInfo = findPythonRuntime({ command, cwd, env: shellEnv });
      const pythonEnv = getRuntimeEnvForCandidate(shellEnv, pythonInfo);

      if (sandboxIsEnabled(sandbox)) {
        const helperPath = sandbox.helperPath || resolveWin32SandboxHelper({ env: pythonEnv });
        return runWithWin32Diagnostics({
          route,
          mode: "sandbox-helper",
          executable: pythonInfo.executable,
          args: pythonInfo.args,
          runtimeInfo: pythonInfo,
          cwd,
          env: pythonEnv,
          onData,
          helperPath,
          sandbox,
          run: (diagnosticOnData) => spawnViaSandboxHelper({
            sandbox,
            executable: pythonInfo.executable,
            args: pythonInfo.args,
            cwd,
            env: pythonEnv,
            onData: diagnosticOnData,
            signal,
            timeout,
          }),
        });
      }

      return runWithWin32Diagnostics({
        route,
        mode: "direct-spawn",
        executable: pythonInfo.executable,
        args: pythonInfo.args,
        runtimeInfo: pythonInfo,
        cwd,
        env: pythonEnv,
        onData,
        sandbox,
        run: (diagnosticOnData) => spawnAndStream(pythonInfo.executable, pythonInfo.args, {
          cwd,
          env: pythonEnv,
          onData: diagnosticOnData,
          signal,
          timeout,
        }),
      });
    }

    if (route.runner === "node") {
      const nodeInfo = prepareRuntimeForSandbox(
        findNodeRuntime({ command, cwd, env: shellEnv }),
        sandbox,
        "node"
      );
      const nodeEnv = getRuntimeEnvForCandidate(shellEnv, nodeInfo);

      if (sandboxIsEnabled(sandbox)) {
        const helperPath = sandbox.helperPath || resolveWin32SandboxHelper({ env: nodeEnv });
        return runWithWin32Diagnostics({
          route,
          mode: "sandbox-helper",
          executable: nodeInfo.executable,
          args: nodeInfo.args,
          runtimeInfo: nodeInfo,
          cwd,
          env: nodeEnv,
          onData,
          helperPath,
          sandbox,
          run: (diagnosticOnData) => spawnViaSandboxHelper({
            sandbox,
            executable: nodeInfo.executable,
            args: nodeInfo.args,
            cwd,
            env: nodeEnv,
            onData: diagnosticOnData,
            signal,
            timeout,
          }),
        });
      }

      return runWithWin32Diagnostics({
        route,
        mode: "direct-spawn",
        executable: nodeInfo.executable,
        args: nodeInfo.args,
        runtimeInfo: nodeInfo,
        cwd,
        env: nodeEnv,
        onData,
        sandbox,
        run: (diagnosticOnData) => spawnAndStream(nodeInfo.executable, nodeInfo.args, {
          cwd,
          env: nodeEnv,
          onData: diagnosticOnData,
          signal,
          timeout,
        }),
      });
    }

    assertSafeWin32BashCommand(command);

    const shellInfo = prepareRuntimeForSandbox(findAndCacheShell(null, {
      preferBundled: true,
      bundledOnly: sandboxIsEnabled(sandbox),
      env: shellEnv,
    }), sandbox, "bash");
    const execEnv = getShellEnvForCandidate(shellEnv, shellInfo);

    if (sandboxIsEnabled(sandbox)) {
      const args = [...shellInfo.args, command];
      const helperPath = sandbox.helperPath || resolveWin32SandboxHelper({ env: execEnv });
      return runWithWin32Diagnostics({
        route,
        mode: "sandbox-helper",
        executable: shellInfo.shell,
        args,
        runtimeInfo: shellInfo,
        cwd,
        env: execEnv,
        onData,
        helperPath,
        sandbox,
        run: (diagnosticOnData) => spawnViaSandboxHelper({
          sandbox,
          executable: shellInfo.shell,
          args,
          cwd,
          env: execEnv,
          onData: diagnosticOnData,
          signal,
          timeout,
        }),
      });
    }

    try {
      const args = [...shellInfo.args, command];
      return await runWithWin32Diagnostics({
        route,
        mode: "direct-spawn",
        executable: shellInfo.shell,
        args,
        runtimeInfo: shellInfo,
        cwd,
        env: execEnv,
        onData,
        sandbox,
        run: (diagnosticOnData) => spawnAndStream(shellInfo.shell, args, {
          cwd, env: execEnv, onData: diagnosticOnData, signal, timeout,
        }),
      });
    } catch (err) {
      // 只对 shell 启动失败降级（ENOENT 指向 shell 二进制、EACCES、EPERM）
      // abort / timeout / 命令本身报错 / cwd 不存在 → 原样抛出
      if (!isShellSpawnError(err, shellInfo.shell, cwd)) throw err;

      log.warn(`Shell exec failed (${shellInfo.label}): ${err.code} ${err.message}, trying fallback…`);
      _cachedShell = null;
      let fallback = null;

      try {
        fallback = findAndCacheShell(shellInfo.shell);
        const fallbackEnv = getShellEnvForCandidate(shellEnv, fallback);
        log.warn(`降级到: ${fallback.label}`);
        const fallbackArgs = [...fallback.args, command];
        return await runWithWin32Diagnostics({
          route,
          mode: "direct-spawn-fallback",
          executable: fallback.shell,
          args: fallbackArgs,
          runtimeInfo: fallback,
          cwd,
          env: fallbackEnv,
          onData,
          sandbox,
          run: (diagnosticOnData) => spawnAndStream(fallback.shell, fallbackArgs, {
            cwd, env: fallbackEnv, onData: diagnosticOnData, signal, timeout,
          }),
        });
      } catch (retryErr) {
        // 降级也失败：抛出富化的错误信息
        if (fallback && isShellSpawnError(retryErr, fallback.shell, cwd)) {
          throw enrichError(retryErr, shellInfo, err);
        }
        throw retryErr;
      }
    }
  };
}

export const __testing = {
  getBundledShellCandidates,
  getShellEnvForCandidate,
  isShellSpawnError,
};
