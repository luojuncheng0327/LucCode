"use strict";

const path = require("path");

const WINDOWS_HELPER_NAME = "luc-win-sandbox.exe";
const WINDOWS_GUARDIAN_TERMINATION_FAILED_EXIT_CODE = 125;

function resolveWindowsServerGuardian({
  env = process.env,
  resourcesPath = process.resourcesPath,
  appRoot = process.cwd(),
  arch = process.arch,
  existsSync,
} = {}) {
  if (typeof existsSync !== "function") {
    existsSync = require("fs").existsSync;
  }
  const candidates = [
    env.LUC_WIN32_SERVER_GUARDIAN,
    env.LUC_WIN32_SANDBOX_HELPER,
    resourcesPath ? path.join(resourcesPath, "sandbox", "windows", WINDOWS_HELPER_NAME) : null,
    appRoot ? path.join(appRoot, "dist-sandbox", `win-${arch}`, WINDOWS_HELPER_NAME) : null,
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function buildWindowsServerGuardianArgs({ parentPid, cwd, executable, args = [] } = {}) {
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0) {
    throw new Error("Windows server guardian requires a positive parentPid");
  }
  if (typeof cwd !== "string" || !cwd) {
    throw new Error("Windows server guardian requires cwd");
  }
  if (typeof executable !== "string" || !executable) {
    throw new Error("Windows server guardian requires executable");
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new Error("Windows server guardian args must be strings");
  }
  return [
    "--supervise-server",
    "--parent-pid", String(parentPid),
    "--cwd", cwd,
    "--", executable, ...args,
  ];
}

function requestWindowsServerGuardianStop(child) {
  if (!child?.stdin || child.stdin.destroyed || child.stdin.writableEnded) return false;
  try {
    child.stdin.end("stop\n");
    return true;
  } catch {
    return false;
  }
}

function isWindowsServerGuardianShutdownConfirmed(child, exited) {
  if (!exited) return false;
  return child?.exitCode !== WINDOWS_GUARDIAN_TERMINATION_FAILED_EXIT_CODE;
}

function resolveBeforeQuitServerAction({ state, hasActiveOwnedServer }) {
  if (state === "complete" || !hasActiveOwnedServer) return "allow";
  if (state === "running") return "wait";
  return "start";
}

module.exports = {
  WINDOWS_HELPER_NAME,
  WINDOWS_GUARDIAN_TERMINATION_FAILED_EXIT_CODE,
  buildWindowsServerGuardianArgs,
  isWindowsServerGuardianShutdownConfirmed,
  requestWindowsServerGuardianStop,
  resolveBeforeQuitServerAction,
  resolveWindowsServerGuardian,
};
