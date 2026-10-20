#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runRestrictedTokenHelperSmoke } from "./verify-standalone-server-artifact.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Production-equivalent case 1: a cmd-routed command
// with an embedded double-quoted path, the exact shape that broke under the
// MSVCRT re-escaping bug fixed by the verbatim cmd payload contract.
export const QUOTED_REGISTRY_QUERY_COMMAND =
  'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion" /v ProductName';

// Production-equivalent case 2: a multiline command carrying a real newline
// inside a quoted argument, the shape that used to be rejected outright by
// the sideEffect control-character check before that was relaxed.
export const PYTHON_MULTILINE_COMMAND = "python -c \"import sys\nprint('MULTI-OK')\"";
export const NODE_MULTILINE_COMMAND = "node -e \"const marker = 'MULTI'\nconsole.log(marker + '-OK')\"";

// Production-equivalent case 3: sandboxed PowerShell, both the default auto
// route (no explicit shell) and an explicit pwsh request.
export const AUTO_ROUTED_POWERSHELL_COMMAND = "Write-Output PS-OK";
export const EXPLICIT_PWSH_COMMAND = "pwsh -NoProfile -NonInteractive -Command \"Write-Output PS-OK\"";

// Resolves whether a command name is runnable from PATH, used only to decide
// between the primary and fallback shape of a case (never to swallow a real
// failure once a case has committed to running).
export function commandIsAvailable(name, env = process.env) {
  try {
    const result = spawnSync("where.exe", [name], {
      encoding: "utf8",
      windowsHide: true,
      env,
      timeout: 5000,
    });
    return result.status === 0 && String(result.stdout || "").trim().length > 0;
  } catch {
    return false;
  }
}

export function windowsSandboxHelperPath({ rootDir = ROOT, arch = "x64" } = {}) {
  return path.join(rootDir, "dist-sandbox", `win-${arch}`, "luc-win-sandbox.exe");
}

export function smokeWindowsSandboxHelper({
  rootDir = ROOT,
  arch = "x64",
  platform = process.platform,
  env = process.env,
} = {}) {
  if (platform !== "win32") {
    throw new Error("[smoke-windows-sandbox] this smoke requires a Windows runner");
  }
  const helperPath = windowsSandboxHelperPath({ rootDir, arch });
  if (!fs.existsSync(helperPath)) {
    throw new Error(`[smoke-windows-sandbox] helper is missing: ${helperPath}`);
  }

  const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "luc-windows-sandbox-ci-"));
  const workDir = path.join(smokeRoot, "work");
  const lucHome = path.join(smokeRoot, "luc-home");
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(lucHome, { recursive: true });
  try {
    runRestrictedTokenHelperSmoke({
      layoutRoot: rootDir,
      workDir,
      lucHome,
      helperPath,
      env,
    });
  } finally {
    fs.rmSync(smokeRoot, { recursive: true, force: true });
  }
  return { helperPath };
}

// Runs `command` through the real createWin32Exec({ sandbox }) production
// path (the same call the exec_command tool makes), not a direct helper argv
// construction. A fresh lucHome is provisioned per case so the required
// TEMP-redirect writable root is exercised for real rather than assumed
// present.
async function runSandboxedCommandForSmoke({ rootDir, arch, env, command, timeout }) {
  const helperPath = windowsSandboxHelperPath({ rootDir, arch });
  if (!fs.existsSync(helperPath)) {
    throw new Error(`[smoke-windows-sandbox] helper is missing: ${helperPath}`);
  }

  const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "luc-windows-sandbox-parity-"));
  const workDir = path.join(smokeRoot, "work");
  const lucHome = path.join(smokeRoot, "luc-home");
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(lucHome, { recursive: true });
  try {
    const { createWin32Exec } = await import("../lib/sandbox/win32-exec.ts");
    const { deriveSandboxPolicy } = await import("../lib/sandbox/policy.ts");
    const policy = deriveSandboxPolicy({
      agentDir: lucHome,
      cwd: workDir,
      workspace: workDir,
      workspaceFolders: [],
      lucHome: lucHome,
      mode: "standard",
    });
    const exec = createWin32Exec({ sandbox: { policy, lucHome: lucHome, helperPath } });
    const chunks = [];
    const result = await exec(command, workDir, {
      onData: (chunk) => chunks.push(String(chunk)),
      signal: undefined,
      timeout,
      env,
    });
    return { exitCode: result.exitCode, stdout: chunks.join("") };
  } finally {
    fs.rmSync(smokeRoot, { recursive: true, force: true });
  }
}

// Case 1: cmd route with embedded double quotes in a registry path.
export async function smokeQuotedRegistryQuery({
  rootDir = ROOT,
  arch = "x64",
  platform = process.platform,
  env = process.env,
} = {}) {
  if (platform !== "win32") {
    throw new Error("[smoke-windows-sandbox] this smoke requires a Windows runner");
  }
  const { exitCode, stdout } = await runSandboxedCommandForSmoke({
    rootDir,
    arch,
    env,
    command: QUOTED_REGISTRY_QUERY_COMMAND,
    timeout: 30,
  });
  if (exitCode !== 0) {
    throw new Error(
      `[smoke-windows-sandbox] quoted registry query failed with exit code ${exitCode}\nstdout: ${stdout.trim()}`,
    );
  }
  if (!stdout.includes("ProductName")) {
    throw new Error(`[smoke-windows-sandbox] quoted registry query did not report ProductName\nstdout: ${stdout.trim()}`);
  }
  return { exitCode, stdout };
}

// Case 2: a multiline command carrying a real embedded newline.
// Prefers python when available; falls back to an
// equivalent node -e two-liner when the runner has no python on PATH.
export async function smokeMultilineCommand({
  rootDir = ROOT,
  arch = "x64",
  platform = process.platform,
  env = process.env,
} = {}) {
  if (platform !== "win32") {
    throw new Error("[smoke-windows-sandbox] this smoke requires a Windows runner");
  }
  const usedRunner = commandIsAvailable("python", env) || commandIsAvailable("python3", env)
    ? "python"
    : "node";
  const command = usedRunner === "python" ? PYTHON_MULTILINE_COMMAND : NODE_MULTILINE_COMMAND;
  const { exitCode, stdout } = await runSandboxedCommandForSmoke({
    rootDir,
    arch,
    env,
    command,
    timeout: 60,
  });
  if (exitCode !== 0) {
    throw new Error(
      `[smoke-windows-sandbox] multiline command (${usedRunner}) failed with exit code ${exitCode}\nstdout: ${stdout.trim()}`,
    );
  }
  if (!stdout.includes("MULTI-OK")) {
    throw new Error(`[smoke-windows-sandbox] multiline command (${usedRunner}) did not print MULTI-OK\nstdout: ${stdout.trim()}`);
  }
  return { exitCode, stdout, usedRunner };
}

// Case 3: sandboxed PowerShell. The default auto route (no explicit
// shell, exercising the powershell-command default + startup probe + TEMP
// redirect chain) always runs; the explicit-pwsh variant is skipped, not
// failed, when the runner has no pwsh.exe on PATH.
export async function smokeSandboxedPowerShell({
  rootDir = ROOT,
  arch = "x64",
  platform = process.platform,
  env = process.env,
} = {}) {
  if (platform !== "win32") {
    throw new Error("[smoke-windows-sandbox] this smoke requires a Windows runner");
  }

  const autoRouted = await runSandboxedCommandForSmoke({
    rootDir,
    arch,
    env,
    command: AUTO_ROUTED_POWERSHELL_COMMAND,
    timeout: 30,
  });
  if (autoRouted.exitCode !== 0) {
    throw new Error(
      `[smoke-windows-sandbox] sandboxed PowerShell (auto route) failed with exit code ${autoRouted.exitCode}\nstdout: ${autoRouted.stdout.trim()}`,
    );
  }
  if (!autoRouted.stdout.includes("PS-OK")) {
    throw new Error(`[smoke-windows-sandbox] sandboxed PowerShell (auto route) did not print PS-OK\nstdout: ${autoRouted.stdout.trim()}`);
  }

  if (!commandIsAvailable("pwsh", env)) {
    console.log("[smoke-windows-sandbox] pwsh.exe not found on PATH; explicit pwsh smoke SKIPPED");
    return { autoRouted, explicitPwsh: { skipped: true } };
  }

  const explicitPwsh = await runSandboxedCommandForSmoke({
    rootDir,
    arch,
    env,
    command: EXPLICIT_PWSH_COMMAND,
    timeout: 30,
  });
  if (explicitPwsh.exitCode !== 0) {
    throw new Error(
      `[smoke-windows-sandbox] sandboxed PowerShell (explicit pwsh) failed with exit code ${explicitPwsh.exitCode}\nstdout: ${explicitPwsh.stdout.trim()}`,
    );
  }
  if (!explicitPwsh.stdout.includes("PS-OK")) {
    throw new Error(`[smoke-windows-sandbox] sandboxed PowerShell (explicit pwsh) did not print PS-OK\nstdout: ${explicitPwsh.stdout.trim()}`);
  }
  return { autoRouted, explicitPwsh };
}

export async function run(argv = process.argv.slice(2)) {
  const arch = argv[0] || "x64";
  const result = smokeWindowsSandboxHelper({ arch });
  console.log(`[smoke-windows-sandbox] restricted-token helper passed: ${result.helperPath}`);

  const quoted = await smokeQuotedRegistryQuery({ arch });
  console.log(`[smoke-windows-sandbox] quoted registry query passed (exit ${quoted.exitCode})`);

  const multiline = await smokeMultilineCommand({ arch });
  console.log(`[smoke-windows-sandbox] multiline command passed via ${multiline.usedRunner} runner`);

  const powershell = await smokeSandboxedPowerShell({ arch });
  console.log("[smoke-windows-sandbox] sandboxed PowerShell (auto route) passed");
  console.log(
    powershell.explicitPwsh?.skipped
      ? "[smoke-windows-sandbox] sandboxed PowerShell (explicit pwsh) SKIPPED"
      : "[smoke-windows-sandbox] sandboxed PowerShell (explicit pwsh) passed",
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  run().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}
