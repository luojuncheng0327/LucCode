import path from "node:path";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const DEFAULT_PWSH_CACHE = new Map();

export function envValue(env, name) {
  const source = env || {};
  if (Object.prototype.hasOwnProperty.call(source, name)) return source[name];
  const key = Object.keys(source).find((item) => item.toLowerCase() === name.toLowerCase());
  return key ? source[key] : undefined;
}

export function isWin32PathLike(filePath) {
  return /^[a-z]:[\\/]|^\\\\/i.test(String(filePath || ""));
}

export function win32SystemRoot(env = process.env) {
  return envValue(env, "SystemRoot") || envValue(env, "windir") ||
    envValue(process.env, "SystemRoot") || envValue(process.env, "windir") ||
    "C:\\Windows";
}

export function resolveWin32CmdExecutable(env = process.env) {
  return envValue(env, "COMSPEC") || envValue(env, "ComSpec") ||
    path.win32.join(win32SystemRoot(env), "System32", "cmd.exe");
}

function win32PowerShell51Executable(env = process.env) {
  return path.win32.join(win32SystemRoot(env), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function powerShell7CommonPaths(env = process.env) {
  const roots = [
    envValue(env, "ProgramW6432"),
    envValue(env, "ProgramFiles"),
    envValue(env, "ProgramFiles(x86)"),
    envValue(env, "LOCALAPPDATA") ? path.win32.join(envValue(env, "LOCALAPPDATA"), "Programs") : null,
  ].filter(Boolean);
  const candidates = [];
  for (const root of roots) {
    candidates.push(path.win32.join(root, "PowerShell", "7", "pwsh.exe"));
  }
  return candidates;
}

function pushUnique(list, value) {
  const text = String(value || "").trim();
  if (!text) return;
  if (list.some((item) => item.toLowerCase() === text.toLowerCase())) return;
  list.push(text);
}

function resolveAllOnPath(commandName, env = process.env, spawn = spawnSync) {
  try {
    const result = spawn("where.exe", [commandName], {
      encoding: "utf-8",
      timeout: 3000,
      windowsHide: true,
      env,
    });
    if (result.status !== 0 || !result.stdout) return [];
    return String(result.stdout)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function parsePowerShellMajorVersion(output) {
  const match = String(output || "").match(/\b(\d+)\b/);
  return match ? Number(match[1]) : null;
}

function isPowerShell7Executable(executable, env = process.env, {
  spawn = spawnSync,
} = {}) {
  try {
    const result = spawn(executable, [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      "$PSVersionTable.PSVersion.Major",
    ], {
      encoding: "utf-8",
      timeout: 3000,
      windowsHide: true,
      env,
    });
    return result.status === 0 && parsePowerShellMajorVersion(result.stdout) >= 7;
  } catch {
    return false;
  }
}

function defaultPowerShellCacheKey(env = process.env) {
  return [
    envValue(env, "PATH") || envValue(env, "Path") || "",
    envValue(env, "ProgramW6432") || "",
    envValue(env, "ProgramFiles") || "",
    envValue(env, "ProgramFiles(x86)") || "",
    envValue(env, "LOCALAPPDATA") || "",
    envValue(env, "SystemRoot") || "",
    envValue(env, "windir") || "",
  ].join("\0");
}

export function findWin32PowerShell7Executable(env = process.env, {
  resolveOnPath,
  resolveAllOnPath: resolveAllOnPathOption,
  exists = existsSync,
  spawn = spawnSync,
  cache = true,
}: {
  resolveOnPath?: any;
  resolveAllOnPath?: any;
  exists?: any;
  spawn?: any;
  cache?: boolean;
} = {}) {
  const useDefaultDeps = !resolveOnPath && !resolveAllOnPathOption && exists === existsSync && spawn === spawnSync;
  const cacheKey = useDefaultDeps && cache ? defaultPowerShellCacheKey(env) : null;
  if (cacheKey && DEFAULT_PWSH_CACHE.has(cacheKey)) return DEFAULT_PWSH_CACHE.get(cacheKey);

  const candidates = [];
  if (typeof resolveAllOnPathOption === "function") {
    for (const candidate of resolveAllOnPathOption("pwsh.exe", env) || []) pushUnique(candidates, candidate);
  } else if (typeof resolveOnPath === "function") {
    pushUnique(candidates, resolveOnPath("pwsh.exe"));
  } else {
    for (const candidate of resolveAllOnPath("pwsh.exe", env, spawn)) pushUnique(candidates, candidate);
  }

  for (const candidate of powerShell7CommonPaths(env)) {
    try {
      if (exists(candidate)) pushUnique(candidates, candidate);
    } catch {}
  }

  const resolved = candidates.find((candidate) => isPowerShell7Executable(candidate, env, { spawn })) || null;
  if (cacheKey) DEFAULT_PWSH_CACHE.set(cacheKey, resolved);
  return resolved;
}

export function resolveWin32DefaultPowerShellExecutable(env = process.env, options = {}) {
  const configured = envValue(env, "LUC_POWERSHELL");
  if (configured) return configured;
  return findWin32PowerShell7Executable(env, options) || win32PowerShell51Executable(env);
}

export function resolveWin32PowerShellExecutable(token = "powershell.exe", env = process.env, {
  resolveOnPath,
}: { resolveOnPath?: any } = {}) {
  const raw = String(token || "powershell.exe");
  if (isWin32PathLike(raw) || raw.includes("\\") || raw.includes("/")) return raw;
  const base = baseNameForShellPath(raw, { stripExe: false }).toLowerCase();
  const configured = envValue(env, "LUC_POWERSHELL");
  if (configured) return configured;
  if (base === "pwsh" || base === "pwsh.exe") {
    return typeof resolveOnPath === "function" ? resolveOnPath("pwsh.exe") || "pwsh.exe" : "pwsh.exe";
  }
  return win32PowerShell51Executable(env);
}

export function baseNameForShellPath(filePath, { stripExe = false } = {}) {
  const raw = String(filePath || "").trim();
  if (!raw) return "";
  const base = isWin32PathLike(raw) || raw.includes("\\")
    ? path.win32.basename(raw)
    : path.basename(raw);
  return stripExe ? base.replace(/\.exe$/i, "") : base;
}

export function normalizeBackslashEscapedDoubleQuotes(command) {
  const input = String(command || "");
  let output = "";
  let quote = null;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const next = input[i + 1];

    if (ch === "\\" && next === "\"") {
      output += quote ? "\\\"" : "\"";
      i += 1;
      continue;
    }

    if (quote) {
      if (ch === quote) quote = null;
      output += ch;
      continue;
    }

    if (ch === "'" || ch === "\"") quote = ch;
    output += ch;
  }

  return output;
}

export function splitShellLikeArgs(command, {
  throwOnUnterminated = false,
  errorPrefix = "",
} = {}) {
  const args = [];
  let current = "";
  let quote = null;

  const input = String(command || "");
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];

    if (ch === "\\" && quote !== "'") {
      const next = input[i + 1];
      if (next && (/\s/.test(next) || next === "'" || next === "\"" || next === "\\")) {
        current += next;
        i += 1;
      } else {
        current += ch;
      }
      continue;
    }

    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }

    if (ch === "'" || ch === "\"") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (quote && throwOnUnterminated) {
    const prefix = errorPrefix ? `${errorPrefix} ` : "";
    throw new Error(`${prefix}Unterminated quote in command: ${command}`);
  }
  if (current.length > 0) args.push(current);
  return args;
}

export function quoteCmdArg(arg, { always = false } = {}) {
  const text = String(arg ?? "");
  if (!always && /^[^\s"&|<>^()]+$/.test(text)) return text;
  return `"${text.replace(/"/g, "\"\"")}"`;
}

export const __testing = {
  parsePowerShellMajorVersion,
};
