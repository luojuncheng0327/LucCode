
import { existsSync as defaultExistsSync } from "fs";
import path from "path";

export const WIN32_SANDBOX_HELPER_NAME = "luc-win-sandbox.exe";
export const WIN32_SANDBOX_TERMINAL_PREFIX = "luc-win-sandbox: terminal-v1";
export const WIN32_SANDBOX_MAX_TIMEOUT_MS = 0xFFFFFFFE;

export type Win32SandboxTerminalStatus =
  | "exited"
  | "timed_out"
  | "termination_failed"
  | "launch_failed";

export interface Win32SandboxTerminalRecord {
  version: 1;
  status: Win32SandboxTerminalStatus;
  exitCode: number | null;
  timeoutMs: number;
  win32Error: number;
}

export interface Win32SandboxTerminalStderrFilter {
  push(data: Buffer | Uint8Array | string): void;
  flush(): void;
  readonly terminalRecord: Win32SandboxTerminalRecord | null;
}

function isWin32PathLike(value) {
  return /^[a-z]:[\\/]/i.test(String(value || "")) || /^\\\\/.test(String(value || ""));
}

function joinRuntimePath(root, ...segments) {
  return isWin32PathLike(root) ? path.win32.join(root, ...segments) : path.join(root, ...segments);
}

function dirnameRuntimePath(target) {
  return isWin32PathLike(target) ? path.win32.dirname(target) : path.dirname(target);
}

function basenameRuntimePath(target) {
  return isWin32PathLike(target) ? path.win32.basename(target) : path.basename(target);
}

function resolveRuntimePath(root, ...segments) {
  return isWin32PathLike(root) ? path.win32.resolve(root, ...segments) : path.resolve(root, ...segments);
}

function pushUniqueRuntimePath(candidates, candidate) {
  if (!candidate) return;
  const key = String(candidate).toLowerCase();
  if (candidates.some((existing) => String(existing).toLowerCase() === key)) return;
  candidates.push(candidate);
}

function legacyPackagedDesktopResourceRoots(env) {
  if (env.LUC_DESKTOP_IS_PACKAGED !== "1") return [];

  const roots = [];
  const appPath = env.LUC_DESKTOP_APP_PATH;
  // Existing packaged shells use asar and pass app.getAppPath(). Accept only
  // that exact layout so a source/dev directory cannot become an install root.
  if (appPath && basenameRuntimePath(appPath).toLowerCase() === "app.asar") {
    pushUniqueRuntimePath(roots, dirnameRuntimePath(appPath));
  }

  const execPath = env.LUC_DESKTOP_EXEC_PATH;
  // Windows Electron keeps resources/ beside the packaged executable. This is
  // a bounded compatibility candidate for shells released before the explicit
  // LUC_DESKTOP_RESOURCES_PATH contract existed.
  if (execPath && basenameRuntimePath(execPath).toLowerCase().endsWith(".exe")) {
    pushUniqueRuntimePath(roots, joinRuntimePath(dirnameRuntimePath(execPath), "resources"));
  }
  return roots;
}

function resourceSiblingCandidates(segments, { env, resourcesPath }) {
  const roots = [];
  pushUniqueRuntimePath(roots, env.LUC_DESKTOP_RESOURCES_PATH);
  pushUniqueRuntimePath(roots, resourcesPath);
  for (const root of legacyPackagedDesktopResourceRoots(env)) {
    pushUniqueRuntimePath(roots, root);
  }
  if (env.LUC_ROOT) {
    pushUniqueRuntimePath(roots, resolveRuntimePath(env.LUC_ROOT, ".."));
  }
  return roots.map((root) => joinRuntimePath(root, ...segments));
}

export function resourceSiblingDir(
  name,
  {
    env = process.env,
    resourcesPath = (process as any).resourcesPath,
    existsSync = defaultExistsSync,
  } = {},
) {
  const candidates = resourceSiblingCandidates([name], { env, resourcesPath });
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0] || null;
}

export function resolveWin32SandboxHelper({
  env = process.env,
  resourcesPath = (process as any).resourcesPath,
  cwd = process.cwd(),
  arch = process.arch,
  existsSync = defaultExistsSync,
} = {}) {
  const candidates = [
    env.LUC_WIN32_SANDBOX_HELPER,
    ...resourceSiblingCandidates(
      ["sandbox", "windows", WIN32_SANDBOX_HELPER_NAME],
      { env, resourcesPath },
    ),
    joinRuntimePath(cwd, "dist-sandbox", `win-${arch}`, WIN32_SANDBOX_HELPER_NAME),
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) || null;
}

export function buildWin32SandboxHelperArgs({
  cwd,
  timeoutMs = 0,
  desktopMode = "private",
  verbatimLastArg = false,
  grants = {},
  executable,
  args = [],
}: {
  cwd?: string;
  timeoutMs?: number;
  desktopMode?: "private" | "current";
  verbatimLastArg?: boolean;
  grants?: Record<string, any>;
  executable?: string;
  args?: string[];
} = {}) {
  if (!cwd) throw new Error("win32 sandbox helper requires cwd");
  if (!executable) throw new Error("win32 sandbox helper requires executable");
  if (desktopMode !== "private" && desktopMode !== "current") {
    throw new Error('win32 sandbox helper desktopMode must be "private" or "current"');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > WIN32_SANDBOX_MAX_TIMEOUT_MS) {
    throw new Error(`win32 sandbox helper timeoutMs must be an integer between 0 and ${WIN32_SANDBOX_MAX_TIMEOUT_MS}`);
  }

  const out = ["--cwd", cwd];
  if (desktopMode === "current") out.push("--current-desktop");
  if (verbatimLastArg) {
    if (!args.length) throw new Error("win32 sandbox helper verbatimLastArg requires at least one child argument");
    out.push("--verbatim-last-arg");
  }
  for (const p of grants.writePaths || []) out.push("--writable-root", p);
  for (const p of grants.optionalWritePaths || []) out.push("--writable-root-optional", p);
  for (const p of grants.denyWritePaths || []) out.push("--deny-write", p);
  out.push("--timeout-ms", String(timeoutMs));
  out.push("--", executable, ...args);
  return out;
}

export function buildWin32SandboxTokenDiagnosticArgs(options = {}) {
  return ["--diagnose-token", ...buildWin32SandboxHelperArgs(options)];
}

function parseWin32SandboxTerminalRecordLine(line: string): Win32SandboxTerminalRecord | null {
  const match = line.match(
    /^luc-win-sandbox: terminal-v1 status="([^"]*)" exitCode="([^"]*)" timeoutMs="([^"]*)" win32Error="([^"]*)"$/,
  );
  if (!match) return null;
  const status = match[1] as Win32SandboxTerminalStatus;
  if (status !== "exited" && status !== "timed_out" && status !== "termination_failed" && status !== "launch_failed") {
    return null;
  }
  const exitCode = match[2] === "" ? null : Number(match[2]);
  const timeoutMs = Number(match[3]);
  const win32Error = Number(match[4]);
  if ((exitCode !== null && !Number.isSafeInteger(exitCode))
    || !Number.isSafeInteger(timeoutMs)
    || !Number.isSafeInteger(win32Error)) {
    return null;
  }
  return { version: 1, status, exitCode, timeoutMs, win32Error };
}

export function parseWin32SandboxTerminalRecord(output: unknown): Win32SandboxTerminalRecord | null {
  const text = Buffer.isBuffer(output) ? output.toString("utf8") : String(output ?? "");
  let last: Win32SandboxTerminalRecord | null = null;
  for (const line of text.split(/\r?\n/)) {
    const record = parseWin32SandboxTerminalRecordLine(line);
    if (record) last = record;
  }
  return last;
}

export function createWin32SandboxTerminalStderrFilter({
  onData,
}: {
  onData: (data: Buffer) => void;
}): Win32SandboxTerminalStderrFilter {
  let pending = Buffer.alloc(0);
  let terminalRecord: Win32SandboxTerminalRecord | null = null;
  let flushed = false;

  const consumeLine = (lineWithNewline: Buffer) => {
    let bodyEnd = lineWithNewline.length;
    if (bodyEnd > 0 && lineWithNewline[bodyEnd - 1] === 0x0A) bodyEnd -= 1;
    if (bodyEnd > 0 && lineWithNewline[bodyEnd - 1] === 0x0D) bodyEnd -= 1;
    const record = parseWin32SandboxTerminalRecordLine(
      lineWithNewline.subarray(0, bodyEnd).toString("utf8"),
    );
    if (record) {
      terminalRecord = record;
      return;
    }
    if (lineWithNewline.length > 0) onData(lineWithNewline);
  };

  return {
    push(data) {
      if (flushed) throw new Error("win32 sandbox terminal stderr filter is already flushed");
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (chunk.length === 0) return;
      pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
      let newlineIndex = pending.indexOf(0x0A);
      while (newlineIndex >= 0) {
        consumeLine(pending.subarray(0, newlineIndex + 1));
        pending = pending.subarray(newlineIndex + 1);
        newlineIndex = pending.indexOf(0x0A);
      }
    },
    flush() {
      if (flushed) return;
      flushed = true;
      if (pending.length > 0) consumeLine(pending);
      pending = Buffer.alloc(0);
    },
    get terminalRecord() {
      return terminalRecord;
    },
  };
}
