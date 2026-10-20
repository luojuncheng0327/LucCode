export type ExecCommandRiskKind = "safe" | "probe" | "mutation" | "dangerous" | "unknown";

export interface ExecCommandClassification {
  kind: ExecCommandRiskKind;
  reason: string;
  executable?: string;
  unsupportedSyntax?: boolean;
  errorCode?: string;
}

const SAFE_POWERSHELL_CMDS = new Set([
  "get-command",
  "get-childitem",
  "get-content",
  "get-item",
  "get-location",
  "get-process",
  "get-version",
  "measure-object",
  "resolve-path",
  "select-object",
  "where-object",
]);

const POWERSHELL_MUTATION_CMDS = new Set([
  "copy-item",
  "move-item",
  "new-item",
  "rename-item",
  "set-content",
]);

const POWERSHELL_DANGEROUS_CMDS = new Set([
  "remove-item",
  "start-process",
  "invoke-item",
  "set-executionpolicy",
]);

const SAFE_GIT_SUBCOMMANDS = new Set([
  "branch",
  "diff",
  "log",
  "show",
  "status",
]);

const PROBE_EXECUTABLES = new Set([
  "where",
  "where.exe",
  "which",
  "command",
  "python",
  "python.exe",
  "python3",
  "python3.exe",
  "node",
  "node.exe",
  "npm",
  "npm.cmd",
]);

const MUTATION_EXECUTABLES = new Set([
  "copy",
  "cp",
  "mkdir",
  "mv",
  "new-item",
  "set-content",
  "touch",
]);

const DANGEROUS_EXECUTABLES = new Set([
  "del",
  "format",
  "icacls",
  "rd",
  "reg",
  "rm",
  "rmdir",
  "schtasks",
  "takeown",
]);

function tokenizeCommand(command: string) {
  const tokens: string[] = [];
  let token = "";
  let quote: string | null = null;
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (token) tokens.push(token);
      token = "";
      continue;
    }
    token += char;
  }
  if (token) tokens.push(token);
  return tokens;
}

function executableBasename(token: string) {
  const normalized = String(token || "").replace(/\\/g, "/").toLowerCase();
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

function normalizeExecutable(token: string) {
  const base = executableBasename(token);
  return base.endsWith(".exe") && base !== "where.exe" ? base.slice(0, -4) : base;
}

function hasWin32PosixHeredoc(command: string) {
  return /(^|[\s;&|])[\w./\\-]*\s*<<\s*['"]?[A-Za-z_][A-Za-z0-9_-]*/.test(command);
}

function isVersionProbe(tokens: string[]) {
  return tokens.some((token) => token === "--version" || token === "-v" || token === "/?");
}

function classifyGit(tokens: string[]): ExecCommandClassification {
  const subcommand = String(tokens[1] || "").toLowerCase();
  if (SAFE_GIT_SUBCOMMANDS.has(subcommand)) {
    return { kind: "safe", reason: "git-read-command", executable: "git" };
  }
  if (subcommand === "push") {
    const hasRiskyPush = tokens.some((token) => token === "-f"
      || token === "--force"
      || token === "--all"
      || token === "--mirror"
      || token === "--tags"
      || token.startsWith("--force-with-lease")
      || token.startsWith("+"));
    return {
      kind: hasRiskyPush ? "dangerous" : "mutation",
      reason: hasRiskyPush ? "git-risky-push" : "git-push",
      executable: "git",
    };
  }
  return { kind: "unknown", reason: "git-other-command", executable: "git" };
}

export function classifyExecCommand(command: string, {
  platform = process.platform,
}: { platform?: NodeJS.Platform } = {}): ExecCommandClassification {
  const raw = String(command || "").trim();
  if (!raw) return { kind: "unknown", reason: "empty-command" };
  if (platform === "win32" && hasWin32PosixHeredoc(raw)) {
    return {
      kind: "unknown",
      reason: "posix-heredoc-on-windows",
      unsupportedSyntax: true,
      errorCode: "EXEC_COMMAND_POSIX_SYNTAX_ON_WINDOWS",
    };
  }

  const tokens = tokenizeCommand(raw);
  const executable = normalizeExecutable(tokens[0] || "");
  if (!executable) return { kind: "unknown", reason: "unparsed-command" };
  const lowerTokens = tokens.map((token) => token.toLowerCase());

  if (executable === "git") return classifyGit(lowerTokens);
  if (SAFE_POWERSHELL_CMDS.has(executable)) {
    return { kind: "safe", reason: "powershell-read-command", executable };
  }
  if (POWERSHELL_MUTATION_CMDS.has(executable) || MUTATION_EXECUTABLES.has(executable)) {
    return { kind: "mutation", reason: "local-mutation-command", executable };
  }
  if (POWERSHELL_DANGEROUS_CMDS.has(executable) || DANGEROUS_EXECUTABLES.has(executable)) {
    return { kind: "dangerous", reason: "dangerous-command", executable };
  }
  if (PROBE_EXECUTABLES.has(executable) || isVersionProbe(lowerTokens)) {
    return { kind: "probe", reason: "environment-probe", executable };
  }
  return { kind: "unknown", reason: "unclassified-command", executable };
}
