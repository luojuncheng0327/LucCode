import os from "node:os";
import { envValue, baseNameForShellPath } from "../lib/shell/shell-utils.ts";
import { SANDBOX_MODE_LABEL } from "../lib/sandbox/policy.ts";

function shellNameFromPath(shellPath) {
  return baseNameForShellPath(shellPath, { stripExe: true });
}

function getExecShellLabel(platform, env = process.env) {
  if (platform === "win32") return "powershell";
  return shellNameFromPath(envValue(env, "SHELL")) || "bash";
}

export function getPlatformPromptNote({
  platform = process.platform,
  osType = os.type(),
  osRelease = os.release(),
  cwd = "",
  env = process.env,
} = {}) {
  return [
    "<environment_context>",
    `  <platform>${platform}</platform>`,
    `  <cwd>${cwd}</cwd>`,
    `  <shell>${getExecShellLabel(platform, env)}</shell>`,
    `  <os>${osType} ${osRelease}</os>`,
    `  <sandbox_mode>${SANDBOX_MODE_LABEL}</sandbox_mode>`,
    "</environment_context>",
    "Use structured file tools for source edits. Use shell for builds, tests, scripts, and command-line tools.",
  ].join("\n");
}
