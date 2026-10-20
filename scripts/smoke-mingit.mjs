#!/usr/bin/env node
/**
 * smoke-mingit.mjs — Windows 上验证 MinGit runtime 能跑非交互 git 全流程 +
 * sh-compatible POSIX shell。runtime 的"真实二进制"验证（JS 单测覆盖不到）。
 *
 * 用法（Windows）：node scripts/smoke-mingit.mjs [runtimeRoot]
 *   默认 runtimeRoot = vendor/mingit
 * 退出码：全过 0，任一失败 1。
 *
 * 注意：在 macOS/Linux 上跑会 FAIL（没有 .exe），这是预期的，不要加进 npm test。
 */
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);

function envValue(env, name) {
  const match = Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match?.[1] ? String(match[1]) : "";
}

/**
 * Build a Windows environment that can use only the selected MinGit runtime
 * plus Windows system binaries. In particular, never append the runner's PATH:
 * GitHub's Windows image already contains Git and would otherwise let an
 * incomplete release archive borrow DLLs or coreutils from the host install.
 */
export function createHermeticMinGitSmokeEnv({ runtimeRoot, workRoot, env = process.env }) {
  const systemRoot = envValue(env, "SystemRoot") || envValue(env, "WINDIR") || "C:\\Windows";
  const normalizedRuntimeRoot = path.win32.resolve(runtimeRoot);
  const normalizedWorkRoot = path.win32.resolve(workRoot);
  return {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    ComSpec: envValue(env, "ComSpec") || path.win32.join(systemRoot, "System32", "cmd.exe"),
    PATHEXT: envValue(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD",
    TEMP: normalizedWorkRoot,
    TMP: normalizedWorkRoot,
    USERPROFILE: normalizedWorkRoot,
    HOME: normalizedWorkRoot,
    Path: [
      path.win32.join(normalizedRuntimeRoot, "cmd"),
      path.win32.join(normalizedRuntimeRoot, "usr", "bin"),
      path.win32.join(normalizedRuntimeRoot, "mingw64", "bin"),
      path.win32.join(systemRoot, "System32"),
    ].join(";"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "NUL",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    MSYS2_PATH_TYPE: "strict",
  };
}

function run(label, exe, args, opts = {}, verifyOutput) {
  try {
    const out = execFileSync(exe, args, { encoding: "utf-8", timeout: 30000, ...opts });
    verifyOutput?.(out);
    console.log(`PASS  ${label}: ${(out || "").trim().split(/\r?\n/)[0] || "(no output)"}`);
    return true;
  } catch (err) {
    console.error(`FAIL  ${label}: ${err.message}`);
    for (const stream of ["stdout", "stderr"]) {
      const detail = err?.[stream] == null ? "" : String(err[stream]).trimEnd();
      if (detail) console.error(`${stream}:\n${detail}`);
    }
    return false;
  }
}

// 提交身份内联传入，不依赖 CI 机器的全局 git config
const IDENT = [
  "-c", "user.email=smoke@luc.invalid",
  "-c", "user.name=luc-smoke",
];

const COREUTILS = "cat ls cp mv rm mkdir grep sed awk find sort uniq head tail wc cut tr xargs echo touch";

function comparableWindowsPath(value) {
  const normalized = path.win32.normalize(value);
  const root = path.win32.parse(normalized).root;
  const withoutTrailingSeparators = normalized === root
    ? normalized
    : normalized.replace(/[\\/]+$/, "");
  return withoutTrailingSeparators.toLowerCase();
}

/**
 * Convert the path dialects emitted by Git for Windows' `command -v` into an
 * absolute native Windows path. POSIX virtual paths belong to the selected
 * runtime; MSYS drive paths and native drive paths already identify a volume.
 */
export function minGitResolutionToWindowsPath(resolved, runtimeRoot) {
  const value = String(resolved || "").trim();
  const virtualMatch = value.match(/^\/(usr\/bin|mingw64\/bin)\/(.+)$/);
  if (virtualMatch) {
    return path.win32.normalize(path.win32.join(
      path.win32.resolve(runtimeRoot),
      ...virtualMatch[1].split("/"),
      ...virtualMatch[2].split("/"),
    ));
  }

  const msysDriveMatch = value.match(/^\/([a-zA-Z])(?:\/(.*))?$/);
  if (msysDriveMatch) {
    const suffix = msysDriveMatch[2]
      ? msysDriveMatch[2].split("/").join("\\")
      : "";
    return path.win32.normalize(`${msysDriveMatch[1].toUpperCase()}:\\${suffix}`);
  }

  if (/^[a-zA-Z]:[\\/]/.test(value)) {
    return path.win32.normalize(value);
  }

  return null;
}

/**
 * Check one `command -v` result without trusting path prefixes. The
 * canonicalizer is injectable so Windows short/long-path equivalence can be
 * tested on every development platform; production uses the native realpath
 * implementation.
 */
export function classifyMinGitCommandResolution({
  command,
  resolved,
  runtimeRoot,
  canonicalizeDirectory = fs.realpathSync.native,
}) {
  const value = String(resolved || "").trim();
  const result = { command, resolved: value };

  if (!value) return { ...result, ok: false, reason: "missing" };
  if (command === "echo" && value === "echo") {
    return { ...result, ok: true, source: "builtin" };
  }

  const windowsPath = minGitResolutionToWindowsPath(value, runtimeRoot);
  if (!windowsPath) {
    return { ...result, ok: false, reason: "non-path" };
  }

  const targetName = path.win32.basename(windowsPath).toLowerCase();
  const expectedName = String(command).toLowerCase();
  if (targetName !== expectedName && targetName !== `${expectedName}.exe`) {
    return { ...result, ok: false, reason: "unexpected-target", windowsPath };
  }

  try {
    const targetParent = comparableWindowsPath(canonicalizeDirectory(path.win32.dirname(windowsPath)));
    const allowedParents = [
      path.win32.join(path.win32.resolve(runtimeRoot), "usr", "bin"),
      path.win32.join(path.win32.resolve(runtimeRoot), "mingw64", "bin"),
    ].map((directory) => comparableWindowsPath(canonicalizeDirectory(directory)));

    if (!allowedParents.includes(targetParent)) {
      return {
        ...result,
        ok: false,
        reason: "outside-runtime",
        windowsPath,
        targetParent,
      };
    }

    return { ...result, ok: true, source: "runtime", windowsPath, targetParent };
  } catch (error) {
    return {
      ...result,
      ok: false,
      reason: "unresolvable-path",
      windowsPath,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function formatMinGitCommandFailure(result) {
  const resolved = result.resolved || "(empty)";
  if (result.reason === "missing") {
    return `MISSING: command=${result.command} resolved=${resolved}`;
  }
  const detail = result.detail ? ` detail=${result.detail}` : "";
  return `EXTERNAL: command=${result.command} resolved=${resolved} reason=${result.reason}${detail}`;
}

export function verifyMinGitCommandResolutionOutput(
  output,
  runtimeRoot,
  canonicalizeDirectory = fs.realpathSync.native,
) {
  const resolutions = new Map();
  for (const line of String(output || "").split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.indexOf("\t");
    if (separator < 0) continue;
    resolutions.set(line.slice(0, separator), line.slice(separator + 1));
  }

  const failures = COREUTILS.split(" ")
    .map((command) => classifyMinGitCommandResolution({
      command,
      resolved: resolutions.get(command) || "",
      runtimeRoot,
      canonicalizeDirectory,
    }))
    .filter((result) => !result.ok);

  if (failures.length > 0) {
    throw new Error(`MinGit command provenance check failed:\n${failures.map(formatMinGitCommandFailure).join("\n")}`);
  }
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const root = path.resolve(argv[0] || path.join(process.cwd(), "vendor", "mingit"));
  const git = path.join(root, "cmd", "git.exe");
  // MinGit 不打包 bash.exe；POSIX 契约是 usr/bin/sh.exe（bash 以 sh 模式运行），参数 -c
  const sh = path.join(root, "usr", "bin", "sh.exe");
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "luc-mingit-smoke-"));
  const repoDir = path.join(workRoot, "repo");
  const cloneDir = path.join(workRoot, "repo-copy");
  const runtimeEnv = createHermeticMinGitSmokeEnv({ runtimeRoot: root, workRoot, env });
  const runOptions = { env: runtimeEnv, cwd: workRoot };

  try {
    const results = [
      run("git --version", git, ["--version"], runOptions),
      run("git init", git, ["init", repoDir], runOptions),
      run("git status", git, ["-C", repoDir, "status", "--short", "--branch"], runOptions),
      run("git config write", git, ["-C", repoDir, "config", "luc.smoke", "1"], runOptions),
      run("git config read", git, ["-C", repoDir, "config", "luc.smoke"], runOptions),
      run("git commit", git, ["-C", repoDir, ...IDENT, "commit", "--allow-empty", "-m", "smoke"], runOptions),
      run("git rev-parse HEAD", git, ["-C", repoDir, "rev-parse", "HEAD"], runOptions),
      run("git local clone", git, ["-c", "protocol.file.allow=always", "clone", repoDir, cloneDir], runOptions),
      run("git clone status", git, ["-C", cloneDir, "status", "--short", "--branch"], runOptions),
      run("sh starts", sh, ["-c", "echo sh=ok"], runOptions),
      run("coreutils originate from archive", sh, [
        "-c",
        `for t in ${COREUTILS}; do `
          + `resolved=$(command -v "$t" 2>/dev/null) || resolved=""; `
          + `printf '%s\\t%s\\n' "$t" "$resolved"; done`,
      ], {
        ...runOptions,
        encoding: "utf-8",
      }, (out) => verifyMinGitCommandResolutionOutput(out, root)),
      run("sh pipeline", sh, [
        "-c",
        "printf 'a\\nb\\nc\\n' | grep b | sed 's/b/B/' | awk '{print $1}'",
      ], runOptions),
    ];
    return results.every(Boolean) ? 0 : 1;
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  process.exit(main());
}
