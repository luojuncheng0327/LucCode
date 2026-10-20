import fs from "fs";
import crypto from "crypto";
import os from "os";
import path from "path";
import { spawn as defaultSpawn } from "child_process";
import { isWin32PathLike } from "../shell/shell-utils.ts";
import {
  buildWin32LucWriteAclCleanupArgs,
  buildWin32LegacyAclDiagnosticArgs,
  buildWin32LegacyProfileCleanupArgs,
} from "./win32-legacy-maintenance.ts";
import { resolveWin32SandboxHelper } from "./win32-sandbox-helper.ts";

const LEGACY_PROFILE_PREFIX = "com.luccode.sandbox.";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const MIGRATION_MARKER_VERSION = 3;
const CLEANUP_MARKER_VERSION = 4;
const DEFAULT_CLEANUP_DELAY_MS = 5_000;
const DEFAULT_PROFILE_BATCH_SIZE = 3;

function joinWin32Aware(root, ...segments) {
  if (!root) return null;
  return isWin32PathLike(root)
    ? path.win32.join(root, ...segments)
    : path.join(root, ...segments);
}

function normalizeWin32Aware(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const normalized = isWin32PathLike(raw) ? path.win32.normalize(raw) : path.resolve(raw);
  return normalized.replace(/[\\/]+$/g, (suffix) => {
    if (/^[a-z]:[\\/]$/i.test(normalized)) return suffix.slice(0, 1);
    if (normalized === "/" || normalized === "\\") return suffix.slice(0, 1);
    return "";
  });
}

function pushExistingUnique(out, seen, raw, existsSync) {
  const normalized = normalizeWin32Aware(raw);
  if (!normalized) return;
  if (!existsSync(normalized)) return;
  const key = normalized.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  out.push(normalized);
}

export function isLegacyWin32SandboxProfileName(name) {
  return typeof name === "string" && /^com\.luccode\.sandbox\.\d+\.\d+$/i.test(name);
}

function packagesRoots({ env, homedir }) {
  const roots = [];
  if (env.LOCALAPPDATA) roots.push(path.win32.join(env.LOCALAPPDATA, "Packages"));
  const home = env.USERPROFILE || homedir?.();
  if (home) roots.push(path.win32.join(home, "AppData", "Local", "Packages"));
  return [...new Set(roots.filter(Boolean).map((p) => path.win32.normalize(p)))];
}

function discoverLegacyProfileNames({ env, readdirSync, existsSync, homedir }) {
  const names = [];
  const seen = new Set();
  for (const root of packagesRoots({ env, homedir })) {
    if (!existsSync(root)) continue;
    let entries = [];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries || []) {
      const name = typeof entry === "string" ? entry : entry?.name;
      if (!isLegacyWin32SandboxProfileName(name)) continue;
      if (entry && typeof entry !== "string" && typeof entry.isDirectory === "function" && !entry.isDirectory()) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(name);
    }
  }
  return names;
}

export function collectWin32LegacySandboxMigrationTargets({
  platform = process.platform,
  lucHome,
  workspaceRoots = [],
  env = process.env,
  resourcesPath = (process as any).resourcesPath,
  existsSync = fs.existsSync,
  readdirSync = fs.readdirSync,
  homedir = os.homedir,
}: any = {}) {
  if (platform !== "win32") return { aclPaths: [], profileNames: [] };

  const aclPaths = [];
  const seen = new Set();
  const push = (target) => pushExistingUnique(aclPaths, seen, target, existsSync);

  if (lucHome) {
    push(lucHome);
    push(joinWin32Aware(lucHome, ".ephemeral"));
    push(joinWin32Aware(lucHome, "agents"));
    push(joinWin32Aware(lucHome, "session-files"));
    push(joinWin32Aware(lucHome, "uploads"));
  }
  for (const root of workspaceRoots || []) push(root);
  if (resourcesPath) {
    push(resourcesPath);
    push(joinWin32Aware(resourcesPath, "git"));
  }
  push(env.USERPROFILE);
  try { push(homedir?.()); } catch {}

  return {
    aclPaths,
    profileNames: discoverLegacyProfileNames({ env, readdirSync, existsSync, homedir }),
  };
}

function appendChunk(current, chunk, maxBytes) {
  const next = current + String(chunk || "");
  if (Buffer.byteLength(next, "utf8") <= maxBytes) return next;
  return next.slice(0, maxBytes) + "\n[truncated]";
}

function runHelper(helperPath, args, {
  spawn = defaultSpawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
} = {}) {
  return new Promise<any>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, ...result });
    };
    const timer = setTimeout(() => {
      try { child?.kill?.(); } catch {}
      finish({ code: null, timedOut: true });
    }, timeoutMs);

    try {
      child = spawn(helperPath, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      finish({ code: null, error: err });
      return;
    }

    child.stdout?.on?.("data", (chunk) => {
      stdout = appendChunk(stdout, chunk, maxOutputBytes);
    });
    child.stderr?.on?.("data", (chunk) => {
      stderr = appendChunk(stderr, chunk, maxOutputBytes);
    });
    child.on?.("error", (err) => finish({ code: null, error: err }));
    child.on?.("close", (code) => finish({ code }));
  });
}

function defaultMigrationMarkerPath(lucHome) {
  return lucHome
    ? path.join(lucHome, "user", "win32-sandbox-migration-v3.json")
    : null;
}

function defaultCleanupMarkerPath(lucHome) {
  return lucHome
    ? path.join(lucHome, "user", "win32-sandbox-cleanup-v4.json")
    : null;
}

function hasCompletedMarker(markerPath) {
  if (!markerPath) return false;
  try {
    const data = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    return data?.version === MIGRATION_MARKER_VERSION && data?.status === "completed";
  } catch {
    return false;
  }
}

function writeCompletedMarker(markerPath, payload) {
  if (!markerPath) return;
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  const tmp = `${markerPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({
    version: MIGRATION_MARKER_VERSION,
    status: "completed",
    completedAt: new Date().toISOString(),
    ...payload,
  }, null, 2));
  fs.renameSync(tmp, markerPath);
}

function buildMigrationPhases({ targets, cleanup, cleanupProfiles = true }) {
  const phases = [];
  const profileNames = targets.profileNames || [];
  if (targets.aclPaths?.length) {
    const args = [];
    if (cleanup) {
      args.push(...buildWin32LucWriteAclCleanupArgs({ paths: targets.aclPaths }));
      for (const name of profileNames) args.push("--legacy-appcontainer-profile", name);
    }
    args.push(...buildWin32LegacyAclDiagnosticArgs({
      cleanup,
      paths: targets.aclPaths,
    }));
    phases.push({ name: "acl-cleanup", args });
  }
  if (cleanup && cleanupProfiles && profileNames.length) {
    phases.push({
      name: "profile-cleanup",
      args: buildWin32LegacyProfileCleanupArgs({ profileNames }),
    });
  }
  return phases;
}

function combineOutput(results, stream) {
  return results.map((result) => result[stream]).filter(Boolean).join("");
}

function helperExitStatus(code) {
  if (code === 0) return "clean";
  if (code === 3) return "findings";
  return "failed";
}

export async function runWin32LegacySandboxMigration({
  platform = process.platform,
  lucHome,
  workspaceRoots = [],
  cleanup = false,
  markerPath,
  targets,
  helperPath,
  disableMarker = false,
  cleanupProfiles = true,
  resolveHelper = resolveWin32SandboxHelper,
  env = process.env,
  spawn = defaultSpawn,
  existsSync = fs.existsSync,
  readdirSync = fs.readdirSync,
  resourcesPath = (process as any).resourcesPath,
  homedir = os.homedir,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: any = {}) {
  if (platform !== "win32") return { status: "skipped", reason: "platform" };

  const completionMarkerPath = cleanup && !disableMarker
    ? (markerPath || defaultMigrationMarkerPath(lucHome))
    : null;
  if (hasCompletedMarker(completionMarkerPath)) {
    return {
      status: "skipped",
      reason: "already-completed",
      cleanup,
      markerPath: completionMarkerPath,
    };
  }

  const helper = helperPath || resolveHelper({ env, resourcesPath, existsSync });
  if (!helper) return { status: "skipped", reason: "helper-unavailable" };

  const resolvedTargets = targets || collectWin32LegacySandboxMigrationTargets({
    platform,
    lucHome,
    workspaceRoots,
    env,
    resourcesPath,
    existsSync,
    readdirSync,
    homedir,
  });
  const phases = buildMigrationPhases({ targets: resolvedTargets, cleanup, cleanupProfiles });
  if (phases.length === 0) {
    const result = {
      status: "clean",
      cleanup,
      helperPath: helper,
      markerPath: completionMarkerPath,
      targets: resolvedTargets,
      exitCode: 0,
      phaseResults: [],
    };
    if (cleanup) writeCompletedMarker(completionMarkerPath, { result });
    return result;
  }

  const phaseResults = [];
  for (const phase of phases) {
    const helperResult = await runHelper(helper, phase.args, { spawn, timeoutMs });
    const phaseResult = {
      phase: phase.name,
      args: phase.args,
      exitCode: helperResult.code,
      stdout: helperResult.stdout || "",
      stderr: helperResult.stderr || "",
      timedOut: helperResult.timedOut || undefined,
      error: helperResult.error?.message || undefined,
    };
    phaseResults.push(phaseResult);

    if (helperResult.error || helperResult.timedOut) {
      return {
        status: "failed",
        cleanup,
        helperPath: helper,
        markerPath: completionMarkerPath,
        targets: resolvedTargets,
        phaseResults,
        ...helperResult,
        error: helperResult.error?.message || (helperResult.timedOut ? "timeout" : "helper failed"),
      };
    }

    if (helperExitStatus(helperResult.code) === "failed") {
      return {
        status: "failed",
        cleanup,
        helperPath: helper,
        markerPath: completionMarkerPath,
        targets: resolvedTargets,
        phaseResults,
        exitCode: helperResult.code,
        stdout: combineOutput(phaseResults, "stdout"),
        stderr: combineOutput(phaseResults, "stderr"),
      };
    }
  }

  const status = phaseResults.some((result) => result.exitCode === 3) ? "findings" : "clean";
  const result = {
    status,
    cleanup,
    helperPath: helper,
    markerPath: completionMarkerPath,
    targets: resolvedTargets,
    exitCode: phaseResults.at(-1)?.exitCode ?? 0,
    phaseResults,
    stdout: combineOutput(phaseResults, "stdout"),
    stderr: combineOutput(phaseResults, "stderr"),
  };
  if (cleanup) writeCompletedMarker(completionMarkerPath, { result });
  return result;
}

export function summarizeWin32LegacySandboxMigration(result) {
  if (!result) return "no result";
  if (result.status === "skipped") return `skipped (${result.reason})`;
  const aclCount = result.targets?.aclPaths?.length || 0;
  const profileCount = result.targets?.profileNames?.length || 0;
  return `${result.status}; cleanup=${result.cleanup ? "on" : "off"}; aclPaths=${aclCount}; profiles=${profileCount}`;
}

function isoNow(now = Date.now) {
  if (typeof now === "function") return new Date(now()).toISOString();
  if ((now as any) instanceof Date) return (now as any).toISOString();
  if (typeof now === "string" && now) return new Date(now).toISOString();
  return new Date(now || Date.now()).toISOString();
}

function readCleanupState(markerPath) {
  if (!markerPath) return { version: CLEANUP_MARKER_VERSION, roots: {}, profiles: {} };
  try {
    const data = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    if (data?.version === CLEANUP_MARKER_VERSION && data.roots && data.profiles) return data;
  } catch {}
  return { version: CLEANUP_MARKER_VERSION, roots: {}, profiles: {} };
}

function writeCleanupState(markerPath, state) {
  if (!markerPath) return;
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  const tmp = `${markerPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({
    version: CLEANUP_MARKER_VERSION,
    roots: state.roots || {},
    profiles: state.profiles || {},
    updatedAt: state.updatedAt || new Date().toISOString(),
  }, null, 2));
  fs.renameSync(tmp, markerPath);
}

function cleanupPathHash(root) {
  const normalized = normalizeWin32Aware(root) || String(root || "");
  return crypto.createHash("sha256").update(normalized.toLowerCase()).digest("hex");
}

function cleanupProfileKey(name) {
  return String(name || "").trim().toLowerCase();
}

function aggregateCleanupStatus(items) {
  if (!items.length) return "skipped";
  if (items.some((item) => item.status === "failed")) return "failed";
  if (items.some((item) => item.status === "findings")) return "findings";
  if (items.every((item) => item.status === "skipped")) return "skipped";
  return "clean";
}

function uniqueNormalizedRoots(roots = []) {
  const out = [];
  const seen = new Set();
  for (const root of roots || []) {
    const normalized = normalizeWin32Aware(root);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function discoverProfilesForCleanup({ env, readdirSync, existsSync, homedir }) {
  return discoverLegacyProfileNames({ env, readdirSync, existsSync, homedir });
}

export async function runWin32LegacySandboxRootCleanup({
  platform = process.platform,
  lucHome,
  roots = [],
  profileNames,
  cleanup = true,
  markerPath,
  helperPath,
  resolveHelper = resolveWin32SandboxHelper,
  env = process.env,
  spawn = defaultSpawn,
  existsSync = fs.existsSync,
  readdirSync = fs.readdirSync,
  resourcesPath = (process as any).resourcesPath,
  homedir = os.homedir,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now,
}: any = {}) {
  if (platform !== "win32") return { status: "skipped", reason: "platform", rootResults: [] };
  const marker = markerPath || defaultCleanupMarkerPath(lucHome);
  const state = readCleanupState(marker);
  const normalizedRoots = uniqueNormalizedRoots(roots);
  const profiles = Array.isArray(profileNames)
    ? profileNames
    : discoverProfilesForCleanup({ env, readdirSync, existsSync, homedir });
  const rootResults = [];

  for (const root of normalizedRoots) {
    const pathHash = cleanupPathHash(root);
    const existing = state.roots[pathHash];
    if (existing?.status === "completed") {
      rootResults.push({ status: "skipped", reason: "already-completed", pathHash });
      continue;
    }

    const result = await runWin32LegacySandboxMigration({
      platform,
      lucHome,
      cleanup,
      helperPath,
      resolveHelper,
      env,
      spawn,
      existsSync,
      readdirSync,
      resourcesPath,
      homedir,
      timeoutMs,
      disableMarker: true,
      cleanupProfiles: false,
      targets: {
        aclPaths: [root],
        profileNames: profiles,
      },
    });
    const timestamp = isoNow(now);
    const rootResult = { ...result, pathHash };
    rootResults.push(rootResult);
    if (!cleanup) continue;
    if (result.status === "clean" || result.status === "findings") {
      state.roots[pathHash] = {
        pathHash,
        status: "completed",
        completedAt: timestamp,
        lastStatus: result.status,
      };
    } else if (result.status === "failed") {
      state.roots[pathHash] = {
        pathHash,
        status: "failed",
        failedAt: timestamp,
        error: result.error || result.stderr || `exit=${result.exitCode ?? "unknown"}`,
      };
    }
    state.updatedAt = timestamp;
    writeCleanupState(marker, state);
  }

  return {
    status: aggregateCleanupStatus(rootResults),
    markerPath: marker,
    rootResults,
  };
}

export async function runWin32LegacySandboxProfileCleanup({
  platform = process.platform,
  lucHome,
  profileNames,
  maxProfiles = DEFAULT_PROFILE_BATCH_SIZE,
  markerPath,
  helperPath,
  resolveHelper = resolveWin32SandboxHelper,
  env = process.env,
  spawn = defaultSpawn,
  existsSync = fs.existsSync,
  readdirSync = fs.readdirSync,
  resourcesPath = (process as any).resourcesPath,
  homedir = os.homedir,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now,
}: any = {}) {
  if (platform !== "win32") return { status: "skipped", reason: "platform", profileResults: [] };
  const marker = markerPath || defaultCleanupMarkerPath(lucHome);
  const state = readCleanupState(marker);
  const discovered = Array.isArray(profileNames)
    ? profileNames
    : discoverProfilesForCleanup({ env, readdirSync, existsSync, homedir });
  const pending = [];
  for (const name of discovered) {
    const key = cleanupProfileKey(name);
    if (!key || state.profiles[key]?.status === "completed") continue;
    if (pending.some((existing) => cleanupProfileKey(existing) === key)) continue;
    pending.push(name);
    if (pending.length >= maxProfiles) break;
  }
  if (!pending.length) {
    return { status: "skipped", reason: "no-pending-profiles", markerPath: marker, profileResults: [] };
  }

  const result = await runWin32LegacySandboxMigration({
    platform,
    lucHome,
    cleanup: true,
    helperPath,
    resolveHelper,
    env,
    spawn,
    existsSync,
    readdirSync,
    resourcesPath,
    homedir,
    timeoutMs,
    disableMarker: true,
    cleanupProfiles: true,
    targets: { aclPaths: [], profileNames: pending },
  });
  const timestamp = isoNow(now);
  let changed = false;
  for (const name of pending) {
    const key = cleanupProfileKey(name);
    if (result.status === "clean" || result.status === "findings") {
      state.profiles[key] = {
        status: "completed",
        completedAt: timestamp,
        lastStatus: result.status,
      };
      changed = true;
    } else if (result.status === "failed") {
      state.profiles[key] = {
        status: "failed",
        failedAt: timestamp,
        error: result.error || result.stderr || `exit=${result.exitCode ?? "unknown"}`,
      };
      changed = true;
    }
  }
  if (changed) {
    state.updatedAt = timestamp;
    writeCleanupState(marker, state);
  }

  return {
    status: result.status,
    reason: result.reason,
    error: result.error,
    exitCode: result.exitCode,
    markerPath: marker,
    profileResults: pending.map((name) => ({ profileName: name, status: result.status })),
    phaseResults: result.phaseResults,
  };
}

export class Win32LegacySandboxCleanupQueue {
  declare activeRootCounts: any;
  declare delayMs: any;
  declare draining: any;
  declare env: any;
  declare existsSync: any;
  declare lucHome: any;
  declare helperPath: any;
  declare homedir: any;
  declare log: any;
  declare markerPath: any;
  declare pendingRootKeys: any;
  declare pendingRoots: any;
  declare platform: any;
  declare profileBatchSize: any;
  declare profileCleanupPending: any;
  declare readdirSync: any;
  declare resourcesPath: any;
  declare scheduleEnabled: any;
  declare spawn: any;
  declare timeoutMs: any;
  declare timer: any;
  constructor({
    platform = process.platform,
    lucHome,
    helperPath,
    markerPath,
    env = process.env,
    spawn = defaultSpawn,
    existsSync = fs.existsSync,
    readdirSync = fs.readdirSync,
    resourcesPath = (process as any).resourcesPath,
    homedir = os.homedir,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    delayMs = DEFAULT_CLEANUP_DELAY_MS,
    profileBatchSize = DEFAULT_PROFILE_BATCH_SIZE,
    schedule = true,
    log,
  }: any = {}) {
    this.platform = platform;
    this.luccodeHome = lucHome;
    this.helperPath = helperPath;
    this.markerPath = markerPath || defaultCleanupMarkerPath(lucHome);
    this.env = env;
    this.spawn = spawn;
    this.existsSync = existsSync;
    this.readdirSync = readdirSync;
    this.resourcesPath = resourcesPath;
    this.homedir = homedir;
    this.timeoutMs = timeoutMs;
    this.delayMs = delayMs;
    this.profileBatchSize = profileBatchSize;
    this.scheduleEnabled = schedule;
    this.log = log;
    this.activeRootCounts = new Map();
    this.pendingRoots = [];
    this.pendingRootKeys = new Set();
    this.profileCleanupPending = false;
    this.timer = null;
    this.draining = false;
  }

  beginRootUse(roots = []) {
    const normalized = uniqueNormalizedRoots(roots);
    for (const root of normalized) {
      const key = root.toLowerCase();
      this.activeRootCounts.set(key, (this.activeRootCounts.get(key) || 0) + 1);
    }
    return { roots: normalized };
  }

  endRootUse(lease) {
    for (const root of lease?.roots || []) {
      const key = root.toLowerCase();
      const next = (this.activeRootCounts.get(key) || 0) - 1;
      if (next > 0) this.activeRootCounts.set(key, next);
      else this.activeRootCounts.delete(key);
    }
    this._schedule();
  }

  enqueueRoots(roots = []) {
    for (const root of uniqueNormalizedRoots(roots)) {
      const key = root.toLowerCase();
      if (this.pendingRootKeys.has(key)) continue;
      this.pendingRootKeys.add(key);
      this.pendingRoots.push(root);
    }
    this._schedule();
  }

  enqueueProfileCleanup() {
    this.profileCleanupPending = true;
    this._schedule();
  }

  _isRootActive(root) {
    return this.activeRootCounts.has(String(root || "").toLowerCase());
  }

  _schedule() {
    if (!this.scheduleEnabled || this.timer || this.platform !== "win32") return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.drain().catch((err) => this.log?.warn?.(`legacy sandbox cleanup failed: ${err?.message || String(err)}`));
    }, this.delayMs);
    this.timer.unref?.();
  }

  async drain() {
    if (this.platform !== "win32" || this.draining) return { status: "skipped", reason: "busy" };
    this.draining = true;
    const rootResults = [];
    let profileResult = null;
    try {
      for (let index = 0; index < this.pendingRoots.length;) {
        const root = this.pendingRoots[index];
        if (this._isRootActive(root)) {
          index++;
          continue;
        }
        this.pendingRoots.splice(index, 1);
        this.pendingRootKeys.delete(root.toLowerCase());
        const result = await runWin32LegacySandboxRootCleanup({
          platform: this.platform,
          lucHome: this.luccodeHome,
          roots: [root],
          markerPath: this.markerPath,
          helperPath: this.helperPath,
          env: this.env,
          spawn: this.spawn,
          existsSync: this.existsSync,
          readdirSync: this.readdirSync,
          resourcesPath: this.resourcesPath,
          homedir: this.homedir,
          timeoutMs: this.timeoutMs,
        });
        rootResults.push(...(result.rootResults || []));
      }

      if (this.profileCleanupPending) {
        this.profileCleanupPending = false;
        profileResult = await runWin32LegacySandboxProfileCleanup({
          platform: this.platform,
          lucHome: this.luccodeHome,
          markerPath: this.markerPath,
          helperPath: this.helperPath,
          env: this.env,
          spawn: this.spawn,
          existsSync: this.existsSync,
          readdirSync: this.readdirSync,
          resourcesPath: this.resourcesPath,
          homedir: this.homedir,
          timeoutMs: this.timeoutMs,
          maxProfiles: this.profileBatchSize,
        });
      }
    } finally {
      this.draining = false;
      if (this.pendingRoots.some((root) => !this._isRootActive(root)) || this.profileCleanupPending) {
        this._schedule();
      }
    }

    return {
      status: aggregateCleanupStatus([
        ...rootResults,
        ...(profileResult ? [profileResult] : []),
      ]),
      rootResults,
      profileResult,
    };
  }
}
