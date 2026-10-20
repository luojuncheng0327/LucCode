import { quoteCmdArg } from "../shell/shell-utils.ts";

export type ExecShellFamily = "auto" | "powershell" | "cmd" | "posix";

export interface ResolvedExecShell {
  requested: string;
  family: ExecShellFamily;
  label: string;
  explicit: boolean;
}

// Single source of truth for the Windows one-shot default shell: guidance text,
// the tool description, heredoc rejection wording, and resolveExecShell's auto
// branch (including its diagnostic `label`) all derive from this constant
// instead of hardcoding a shell name that can drift out of sync with what
// actually runs.
export const WIN32_DEFAULT_ONE_SHOT_SHELL = Object.freeze({
  family: "powershell" as ExecShellFamily,
  display: "PowerShell",
  label: "powershell",
  syntaxHint: "On Windows this is PowerShell syntax unless shell is set.",
});

function normalizeShell(value: any) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || raw === "auto" || raw === "default") return "auto";
  if (raw === "powershell" || raw === "powershell.exe") return "powershell";
  if (raw === "pwsh" || raw === "pwsh.exe") return "pwsh";
  if (raw === "cmd" || raw === "cmd.exe") return "cmd";
  if (raw === "bash" || raw === "git-bash" || raw === "sh") return "bash";
  return raw;
}

export function resolveExecShell({
  shell,
  platform = process.platform,
}: {
  shell?: string;
  platform?: NodeJS.Platform;
} = {}): ResolvedExecShell {
  const normalized = normalizeShell(shell);
  const explicit = normalized !== "auto";
  if (platform === "win32") {
    if (normalized === "cmd") return { requested: normalized, family: "cmd", label: "cmd", explicit };
    if (normalized === "bash") return { requested: normalized, family: "posix", label: "bash", explicit };
    if (normalized === "pwsh") return { requested: normalized, family: "powershell", label: "pwsh", explicit };
    if (normalized === "powershell") return { requested: normalized, family: "powershell", label: "powershell", explicit };
    if (normalized !== "auto") {
      return { requested: normalized, family: "auto", label: normalized, explicit };
    }
    return { requested: "auto", family: WIN32_DEFAULT_ONE_SHOT_SHELL.family, label: WIN32_DEFAULT_ONE_SHOT_SHELL.label, explicit: false };
  }
  if (normalized !== "auto" && normalized !== "bash") {
    return { requested: normalized, family: "posix", label: normalized, explicit };
  }
  return { requested: normalized, family: "posix", label: normalized === "bash" ? "bash" : "default", explicit };
}

function quotePosixSingle(value: string) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function quotePowerShellCommand(value: string) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function quotePowerShellLiteral(value: string) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function normalizePathForCompare(value: string, platform: NodeJS.Platform) {
  const raw = String(value || "");
  return platform === "win32" ? raw.replace(/\//g, "\\").toLowerCase() : raw;
}

export function renderCommandWithWorkdir(command: string, shell: ResolvedExecShell, {
  workdir,
  defaultCwd,
  platform = process.platform,
}: {
  workdir?: string;
  defaultCwd?: string;
  platform?: NodeJS.Platform;
} = {}) {
  if (!workdir) return command;
  if (defaultCwd && normalizePathForCompare(workdir, platform) === normalizePathForCompare(defaultCwd, platform)) {
    return command;
  }

  if (platform === "win32" && shell.family === "powershell") {
    return `Set-Location -LiteralPath ${quotePowerShellLiteral(workdir)}; ${command}`;
  }
  if (platform === "win32" && shell.family === "cmd") {
    return `cd /d ${quoteCmdArg(workdir, { always: true })} && ${command}`;
  }
  return `cd ${quotePosixSingle(workdir)} && ${command}`;
}

export function renderCommandForExecShell(command: string, shell: ResolvedExecShell, {
  platform = process.platform,
}: { platform?: NodeJS.Platform } = {}) {
  if (!shell.explicit) return command;

  if (platform === "win32") {
    if (shell.family === "cmd") {
      return `cmd.exe /d /s /c ${quoteCmdArg(command, { always: true })}`;
    }
    if (shell.family === "powershell") {
      const executable = shell.requested === "pwsh" ? "pwsh.exe" : "powershell.exe";
      return `${executable} -NoProfile -Command ${quotePowerShellCommand(command)}`;
    }
    if (shell.family === "posix") {
      return `bash -lc ${quotePosixSingle(command)}`;
    }
    return command;
  }

  const executable = shell.requested && shell.requested !== "auto" ? shell.requested : "bash";
  return `${executable} -lc ${quotePosixSingle(command)}`;
}
