import crypto from "crypto";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { isWin32PathLike } from "../shell/shell-utils.ts";

const CACHE_DIR = "win32-sandbox-runtime";
const MARKER_FILE = ".luc-sandbox-runtime.json";

function pathOpsFor(...paths) {
  return paths.some(isWin32PathLike) ? path.win32 : path;
}

function joinRuntimePath(root, ...segments) {
  const ops = pathOpsFor(root);
  return ops.join(root, ...segments);
}

function dirnameRuntimePath(filePath) {
  return pathOpsFor(filePath).dirname(filePath);
}

function normalizeForCompare(filePath) {
  const ops = pathOpsFor(filePath);
  const normalized = ops.normalize(String(filePath || ""));
  return ops === path.win32 ? normalized.toLowerCase() : normalized;
}

function isInsideRuntimeRoot(target, root) {
  if (!target || !root) return false;
  const ops = pathOpsFor(target, root);
  const targetNorm = normalizeForCompare(target);
  const rootNorm = normalizeForCompare(root);
  const rel = ops.relative(rootNorm, targetNorm);
  return rel === "" || (!!rel && !rel.startsWith("..") && !ops.isAbsolute(rel));
}

function runtimePrimaryPath(runtimeInfo) {
  return runtimeInfo?.git || runtimeInfo?.shell || runtimeInfo?.executable || null;
}

function runtimeSourceRoot(runtimeInfo) {
  if (runtimeInfo?.bundledRoot) return runtimeInfo.bundledRoot;
  const primary = runtimePrimaryPath(runtimeInfo);
  return primary ? dirnameRuntimePath(primary) : null;
}

function rewriteRuntimePath(sourcePath, sourceRoot, targetRoot) {
  if (!sourcePath) return sourcePath;
  const ops = pathOpsFor(sourcePath, sourceRoot, targetRoot);
  let rel = ops.relative(sourceRoot, sourcePath);
  if (!rel || rel.startsWith("..") || ops.isAbsolute(rel)) {
    rel = ops.basename(sourcePath);
  }
  return ops.join(targetRoot, rel);
}

function statSignature(filePath) {
  const stat = fs.statSync(filePath);
  return {
    size: stat.size,
    mtimeMs: Math.trunc(stat.mtimeMs),
  };
}

function runtimeManifest({ sourceRoot, primaryPath, kind }) {
  return {
    version: 1,
    kind,
    sourceRoot: normalizeForCompare(sourceRoot),
    primaryPath: normalizeForCompare(primaryPath),
    sourceRootStat: statSignature(sourceRoot),
    primaryStat: statSignature(primaryPath),
  };
}

function manifestMatches(markerPath, manifest) {
  try {
    const existing = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
    return JSON.stringify(existing) === JSON.stringify(manifest);
  } catch {
    return false;
  }
}

function stableCacheName({ sourceRoot, primaryPath, kind, manifest }) {
  const hash = crypto
    .createHash("sha256")
    .update(`${kind}\0${normalizeForCompare(sourceRoot)}\0${normalizeForCompare(primaryPath)}`)
    .update(`\0${JSON.stringify(manifest)}`)
    .digest("hex")
    .slice(0, 16);
  return `${kind}-${hash}`;
}

function copyRuntimeTree({ sourceRoot, targetRoot, markerPath, manifest }) {
  const ops = pathOpsFor(sourceRoot, targetRoot);
  const parent = ops.dirname(targetRoot);
  fs.mkdirSync(parent, { recursive: true });

  const tmpRoot = ops.join(parent, `.${ops.basename(targetRoot)}.tmp-${process.pid}-${Date.now()}`);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  try {
    fs.cpSync(sourceRoot, tmpRoot, {
      recursive: true,
      force: true,
      dereference: true,
    });
    fs.writeFileSync(ops.join(tmpRoot, MARKER_FILE), `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
    fs.rmSync(targetRoot, { recursive: true, force: true });
    fs.renameSync(tmpRoot, targetRoot);
  } catch (err) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    if (fs.existsSync(targetRoot) && manifestMatches(markerPath, manifest)) return;
    throw err;
  }
}

function ensureCachedRuntimeRoot({ sourceRoot, primaryPath, lucHome, kind }) {
  if (!lucHome) {
    throw new Error("[win32-sandbox] LUC_HOME is required to prepare sandbox runtime cache.");
  }
  if (!sourceRoot || !fs.existsSync(sourceRoot)) {
    throw new Error(`[win32-sandbox] Runtime source root does not exist: ${sourceRoot || "(missing)"}`);
  }
  if (!primaryPath || !fs.existsSync(primaryPath)) {
    throw new Error(`[win32-sandbox] Runtime executable does not exist: ${primaryPath || "(missing)"}`);
  }

  const cacheRoot = sandboxRuntimeCacheRoot(lucHome);
  if (isInsideRuntimeRoot(sourceRoot, cacheRoot)) return sourceRoot;

  const manifest = runtimeManifest({ sourceRoot, primaryPath, kind });
  const targetRoot = joinRuntimePath(cacheRoot, stableCacheName({ sourceRoot, primaryPath, kind, manifest }));
  const markerPath = joinRuntimePath(targetRoot, MARKER_FILE);

  if (fs.existsSync(targetRoot) && manifestMatches(markerPath, manifest)) return targetRoot;

  copyRuntimeTree({ sourceRoot, targetRoot, markerPath, manifest });
  return targetRoot;
}

export function sandboxRuntimeCacheRoot(lucHome) {
  if (!lucHome) throw new Error("[win32-sandbox] LUC_HOME is required for sandbox runtime cache.");
  return joinRuntimePath(lucHome, ".ephemeral", CACHE_DIR);
}

// Per-executable, in-process cache of whether a sandboxed PowerShell startup
// probe succeeded. Keyed by resolved executable path so pwsh and Windows
// PowerShell 5.1 are probed and cached independently; populated the first
// time a sandboxed PowerShell command reaches spawnViaSandboxHelper for that
// executable, so later commands in the same process skip the probe entirely.
const sandboxPowerShellProbeCache = new Map<string, "ok" | "unsupported">();

export function getSandboxPowerShellProbeResult(executable: string) {
  return sandboxPowerShellProbeCache.get(normalizeForCompare(executable)) ?? null;
}

export function setSandboxPowerShellProbeResult(executable: string, result: "ok" | "unsupported") {
  sandboxPowerShellProbeCache.set(normalizeForCompare(executable), result);
}

// Test-only: clear cached probe verdicts between cases.
export function resetSandboxPowerShellProbeCacheForTests() {
  sandboxPowerShellProbeCache.clear();
}

export type Win32PowerShellFlavor = "pwsh" | "windows-powershell";

const POWERSHELL_FLAVOR_PROBE_TIMEOUT_MS = 3000;

function probePwshOnPath(spawn: typeof spawnSync): boolean {
  try {
    const result = spawn("where.exe", ["pwsh.exe"], {
      encoding: "utf-8",
      timeout: POWERSHELL_FLAVOR_PROBE_TIMEOUT_MS,
      windowsHide: true,
    } as any);
    return result.status === 0 && !!String(result.stdout || "").trim();
  } catch {
    return false;
  }
}

// Detects which PowerShell flavor is on this machine, to feed exec_command's
// tool description (see execCommandDescription in ../exec-command/guidance.ts).
//
// createExecCommandTools() calls this exactly once per tool-set build, and
// bakes the result directly into the `description` string literal on the
// tool object at that moment (lib/exec-command/tool.ts). Tool-set builds
// happen once per session-construction event — createSession,
// executeIsolated's temp session, the bridge owner-session setup,
// runAgentSession's temp/phone session — never once per turn and never once
// per LLM call. That description string is hashed into the LLM provider's
// cache-prefix contract (lib/llm/cache-prefix-contract.ts): once a session's
// tools are built, the description must never change again for that
// session's lifetime, or it reads as a cache-prefix drift.
//
// That's why this function deliberately does NOT memoize its verdict across
// calls, unlike the sandboxed-PowerShell-startup-probe cache below (that one
// caches on purpose, because it verifies runtime execution behavior, not a
// one-shot description bake). Memoizing here would let a pwsh install (or
// uninstall) that happens between two tool-set builds leak the *previous*
// build's stale verdict into the next one. The only thing allowed to see an
// updated pwsh install is the next tool-set build — a new session, a new
// isolated sub-session, a fresh-compact rebuild — which naturally gets a
// fresh probe because it calls this function again from scratch. The
// where.exe probe itself is cheap (tens of milliseconds) and only runs at
// tool-set build time, not on any per-turn or per-command hot path.
export function detectWin32PowerShellFlavor({
  platform = process.platform,
  spawn = spawnSync,
}: { platform?: NodeJS.Platform; spawn?: typeof spawnSync } = {}): Win32PowerShellFlavor | null {
  if (platform !== "win32") return null;
  return probePwshOnPath(spawn) ? "pwsh" : "windows-powershell";
}

export function prepareSandboxRuntime(runtimeInfo, { lucHome, kind }) {
  if (!runtimeInfo) return runtimeInfo;
  const sourceRoot = runtimeSourceRoot(runtimeInfo);
  const primaryPath = runtimePrimaryPath(runtimeInfo);
  const targetRoot = ensureCachedRuntimeRoot({ sourceRoot, primaryPath, lucHome, kind });
  if (targetRoot === sourceRoot) return runtimeInfo;

  return {
    ...runtimeInfo,
    bundledRoot: runtimeInfo.bundledRoot
      ? targetRoot
      : runtimeInfo.bundledRoot,
    git: rewriteRuntimePath(runtimeInfo.git, sourceRoot, targetRoot),
    shell: rewriteRuntimePath(runtimeInfo.shell, sourceRoot, targetRoot),
    executable: rewriteRuntimePath(runtimeInfo.executable, sourceRoot, targetRoot),
  };
}
