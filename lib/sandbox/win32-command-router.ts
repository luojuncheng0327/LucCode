import { spawnSync } from "child_process";
import {
  normalizeBackslashEscapedDoubleQuotes,
  splitShellLikeArgs,
} from "../shell/shell-utils.ts";

const EXPLICIT_CMD_SHELLS = new Set([
  "cmd",
  "cmd.exe",
]);

const EXPLICIT_POWERSHELL_SHELLS = new Set([
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
]);

const EXPLICIT_POSIX_SHELLS = new Set([
  "bash",
  "bash.exe",
  "sh",
  "sh.exe",
]);

const CMD_BUILTINS = new Set([
  "assoc",
  "break",
  "call",
  "cd",
  "chdir",
  "cls",
  "copy",
  "date",
  "del",
  "dir",
  "echo",
  "endlocal",
  "erase",
  "exit",
  "for",
  "ftype",
  "goto",
  "if",
  "md",
  "mklink",
  "move",
  "path",
  "pause",
  "popd",
  "prompt",
  "pushd",
  "rd",
  "ren",
  "rename",
  "rmdir",
  "set",
  "setlocal",
  "shift",
  "start",
  "time",
  "title",
  "type",
  "ver",
  "verify",
  "vol",
]);

const WINDOWS_NATIVE_UTILITIES = new Set([
  "findstr",
  "findstr.exe",
]);

const PYTHON_COMMANDS = new Set([
  "python",
  "python.exe",
  "python3",
  "python3.exe",
]);

const NODE_COMMANDS = new Set([
  "node",
  "node.exe",
]);

const SYSTEM_PATH_PATTERN = /\\windows\\(system32|sysnative|syswow64)\\/i;
const nativePathCache = new Map();

function getFirstToken(command) {
  const trimmed = String(command || "").trim();
  if (!trimmed) return "";
  const match = trimmed.match(/^"([^"]+)"|^'([^']+)'|^([^\s]+)/);
  return (match?.[1] || match?.[2] || match?.[3] || "").trim();
}

function getTokenBaseName(token) {
  return token.split(/[\\/]/).pop()?.toLowerCase() || "";
}

function isCmdScript(baseName) {
  return /\.(?:bat|cmd)$/i.test(baseName);
}

function isPowerShellScript(baseName) {
  return /\.ps1$/i.test(baseName);
}

function usesWindowsFindSyntax(command, baseName) {
  if (baseName !== "find" && baseName !== "find.exe") return false;
  const args = splitShellLikeArgs(command).slice(1);
  return args.some((arg) => /^\/(?:\?|v|c|n|i|off(?:line)?)(?:$|\s)/i.test(arg));
}

function hasComplexShellSyntax(command) {
  const input = String(command || "");
  let quote = null;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];

    if (ch === "\\" && quote !== "'") {
      i += 1;
      continue;
    }

    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === "'" || ch === "\"") {
      quote = ch;
      continue;
    }

    if (ch === "`" || ch === ";" || ch === "|" || ch === "<" || ch === ">") return true;
    if (ch === "&" && input[i + 1] === "&") return true;
    if (ch === "$" && input[i + 1] === "(") return true;
  }

  return false;
}

function defaultResolveNativePath(name) {
  const key = String(name || "").toLowerCase();
  if (!key) return null;
  if (nativePathCache.has(key)) return nativePathCache.get(key);

  try {
    const result = spawnSync("where.exe", [key], {
      encoding: "utf-8",
      windowsHide: true,
      timeout: 3000,
    });
    const resolved = result.status === 0
      ? (result.stdout || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) || null
      : null;
    nativePathCache.set(key, resolved);
    return resolved;
  } catch {
    nativePathCache.set(key, null);
    return null;
  }
}

export function classifyWin32Command(command, { resolveNativePath = defaultResolveNativePath } = {}) {
  const normalizedCommand = normalizeBackslashEscapedDoubleQuotes(command);
  const token = getFirstToken(normalizedCommand);
  const lower = token.toLowerCase();
  const baseName = getTokenBaseName(token);
  const hasComplexSyntax = hasComplexShellSyntax(normalizedCommand);

  if (!token) return { runner: "powershell-command", reason: "empty" };
  if (EXPLICIT_CMD_SHELLS.has(lower) || EXPLICIT_CMD_SHELLS.has(baseName)) {
    return { runner: "cmd", reason: "explicit-cmd-shell" };
  }
  if (EXPLICIT_POWERSHELL_SHELLS.has(lower) || EXPLICIT_POWERSHELL_SHELLS.has(baseName)) {
    return { runner: "powershell", reason: "explicit-powershell-shell" };
  }
  if (EXPLICIT_POSIX_SHELLS.has(lower) || EXPLICIT_POSIX_SHELLS.has(baseName)) {
    return { runner: "bash", reason: "explicit-posix-shell" };
  }
  if (isCmdScript(baseName)) return { runner: "cmd-script", reason: "cmd-script-file" };
  if (isPowerShellScript(baseName)) return { runner: "powershell-file", reason: "powershell-script-file" };
  if (usesWindowsFindSyntax(normalizedCommand, baseName)) return { runner: "cmd", reason: "windows-find-command" };
  if (WINDOWS_NATIVE_UTILITIES.has(baseName)) return { runner: "cmd", reason: "windows-native-utility" };
  if (!hasComplexSyntax && (baseName === "git" || baseName === "git.exe")) {
    return { runner: "git", reason: "git-command" };
  }
  if (!hasComplexSyntax && PYTHON_COMMANDS.has(baseName)) return { runner: "python", reason: "python-command" };
  if (!hasComplexSyntax && NODE_COMMANDS.has(baseName)) return { runner: "node", reason: "node-command" };
  if (CMD_BUILTINS.has(lower)) return { runner: "cmd", reason: "cmd-builtin" };

  const resolved = resolveNativePath(lower);
  if (resolved && SYSTEM_PATH_PATTERN.test(resolved)) {
    return { runner: "cmd", reason: "windows-system-executable", path: resolved };
  }

  return {
    runner: "powershell-command",
    reason: hasComplexSyntax ? "default-powershell-complex" : "default-powershell",
  };
}
