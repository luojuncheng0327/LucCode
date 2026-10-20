#!/usr/bin/env node
/**
 * Fail-closed verification for the Windows LucCore standalone release asset.
 * Verification happens after packaging and before CI uploads anything.
 */
import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

import { assertRuntimeComplete, MINGIT_VERSION } from "./mingit-runtime.js";
import { createHermeticMinGitSmokeEnv } from "./smoke-mingit.mjs";
import {
  REQUIRED_STANDALONE_SERVER_FILES,
  ROOT,
  STANDALONE_ARCH,
  STANDALONE_LAYOUT_ROOT,
  STANDALONE_PLATFORM,
  readProductVersion,
  standaloneArtifactNames,
  standaloneWrapperContents,
} from "./build-standalone-server-artifact.mjs";

const require = createRequire(import.meta.url);
const ustar = require("../shared/artifact-core/ustar.cjs");
const activation = require("../shared/artifact-core/activation.cjs");
const __filename = fileURLToPath(import.meta.url);

function assertFile(filePath, label) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new Error(`[verify-standalone] ${label} is missing: ${filePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`[verify-standalone] ${label} must be a file: ${filePath}`);
  }
}

function expectEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `[verify-standalone] ${label} mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertExtractedLayout(layoutRoot) {
  const expectedRootEntries = ["git", "luc-server.cmd", "luc.cmd", "sandbox", "server"];
  const actualRootEntries = fs.readdirSync(layoutRoot).sort();
  expectEqual(JSON.stringify(actualRootEntries), JSON.stringify(expectedRootEntries), "archive root entries");

  for (const relative of REQUIRED_STANDALONE_SERVER_FILES) {
    assertFile(path.join(layoutRoot, "server", ...relative.split("/")), `packaged server file ${relative}`);
  }
  assertFile(
    path.join(layoutRoot, "sandbox", "windows", "luc-win-sandbox.exe"),
    "Windows sandbox helper",
  );
  try {
    assertRuntimeComplete(path.join(layoutRoot, "git"));
  } catch (error) {
    throw new Error(`[verify-standalone] extracted MinGit runtime is incomplete\n${error.message}`);
  }

  const wrappers = standaloneWrapperContents();
  expectEqual(fs.readFileSync(path.join(layoutRoot, "luc.cmd"), "utf8"), wrappers.luc, "luc.cmd");
  expectEqual(
    fs.readFileSync(path.join(layoutRoot, "luc-server.cmd"), "utf8"),
    wrappers.server,
    "luc-server.cmd",
  );
}

function envValue(env, name) {
  const match = Object.entries(env || {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match?.[1] ? String(match[1]) : "";
}

/**
 * Build the helper-child environment for the restricted-token release smoke.
 * Production win32-exec materializes TEMP/LOCALAPPDATA/APPDATA under a writable
 * ephemeral root and starts from a near-complete process env. This smoke keeps
 * Path native-only (no MinGit/MSYS) so it proves helper + writable/deny-write
 * without borrowing host Git or forcing MSYS DLLs into the child.
 */
export function createRestrictedTokenSmokeRuntimeEnv({
  workDir,
  lucHome,
  helperPath,
  layoutRoot,
  env = process.env,
} = {}) {
  if (!workDir) throw new Error("workDir is required");
  if (!lucHome) throw new Error("lucHome is required");
  if (!helperPath) throw new Error("helperPath is required");
  if (!layoutRoot) throw new Error("layoutRoot is required");

  const systemRoot = envValue(env, "SystemRoot") || envValue(env, "WINDIR") || "C:\\Windows";
  const runtimeEnvRoot = path.win32.join(workDir, ".ephemeral", "win32-sandbox-env");
  const tempDir = path.win32.join(runtimeEnvRoot, "Temp");
  const localAppDataDir = path.win32.join(runtimeEnvRoot, "LocalAppData");
  const appDataDir = path.win32.join(runtimeEnvRoot, "AppData", "Roaming");
  const profileDir = path.win32.join(workDir, "Profile");
  const smokeEnv = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    ComSpec: envValue(env, "ComSpec") || path.win32.join(systemRoot, "System32", "cmd.exe"),
    PATHEXT: envValue(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD",
    Path: path.win32.join(systemRoot, "System32"),
    TEMP: tempDir,
    TMP: tempDir,
    LOCALAPPDATA: localAppDataDir,
    APPDATA: appDataDir,
    USERPROFILE: profileDir,
    HOME: profileDir,
    LUC_HOME: lucHome,
    LUC_ROOT: path.win32.join(layoutRoot, "server"),
    LUC_SERVER_ENTRY: path.win32.join(layoutRoot, "server", "bundle", "index.js"),
    LUC_WIN32_SANDBOX_HELPER: helperPath,
    LUC_WIN32_SANDBOX_DEBUG: "1",
  };

  // Carry the small set of host identity/system keys production inherits, but
  // never host PATH/NODE_OPTIONS (those are how CI Git and injectors leak in).
  for (const key of [
    "SystemDrive",
    "USERNAME",
    "USERDOMAIN",
    "USERDOMAIN_ROAMINGPROFILE",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "OS",
    "COMPUTERNAME",
    "PUBLIC",
    "ProgramData",
  ]) {
    const value = envValue(env, key);
    if (value) smokeEnv[key] = value;
  }

  return {
    env: smokeEnv,
    runtimeDirs: [tempDir, localAppDataDir, appDataDir, profileDir],
  };
}

export function standaloneRestrictedTokenSmokeSpec({
  layoutRoot,
  workDir,
  lucHome,
  helperPath = path.win32.join(layoutRoot, "sandbox", "windows", "luc-win-sandbox.exe"),
  env = process.env,
}) {
  const { env: smokeEnv, runtimeDirs } = createRestrictedTokenSmokeRuntimeEnv({
    workDir,
    lucHome,
    helperPath,
    layoutRoot,
    env,
  });
  const markerFileName = "luc-restricted-token-smoke.txt";
  const blockedDirName = "blocked";
  const deniedFileName = "luc-deny-write-smoke.txt";
  // The child must be a native PE binary: MSYS/Cygwin programs such as
  // usr/bin/sh.exe fail to initialize (STATUS_DLL_INIT_FAILED) under a
  // restricted token, so cmd.exe carries the writable-root and deny-write
  // proof. Sandboxed Git startup is covered by the exec_command smoke below,
  // which reaches it through the production exec chain.
  const shellCommand =
    `echo LUC_RESTRICTED_TOKEN_OK>${markerFileName}`
    + ` && type ${markerFileName}`
    + ` && (echo SHOULD_NOT_WRITE>${blockedDirName}\\${deniedFileName})`
    + " && exit 73"
    + " || echo LUC_DENY_WRITE_OK";
  return {
    helperPath,
    markerPath: path.win32.join(workDir, markerFileName),
    blockedDir: path.win32.join(workDir, blockedDirName),
    deniedMarkerPath: path.win32.join(workDir, blockedDirName, deniedFileName),
    runtimeDirs,
    env: smokeEnv,
    args: [
      "--cwd", workDir,
      "--writable-root", workDir,
      "--deny-write", path.win32.join(workDir, blockedDirName),
      "--timeout-ms", "30000",
      "--",
      smokeEnv.ComSpec,
      "/d", "/s", "/c",
      shellCommand,
    ],
  };
}

export function runRestrictedTokenHelperSmoke({
  layoutRoot,
  workDir,
  lucHome,
  helperPath,
  env = process.env,
  spawnSyncImpl = spawnSync,
}) {
  const spec = standaloneRestrictedTokenSmokeSpec({ layoutRoot, workDir, lucHome, helperPath, env });
  fs.mkdirSync(spec.blockedDir, { recursive: true });
  for (const dir of spec.runtimeDirs || []) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const sandboxResult = spawnSyncImpl(
    spec.helperPath,
    spec.args,
    restrictedTokenSmokeSpawnOptions({ cwd: workDir, env: spec.env, timeout: 45_000 }),
  );
  if (sandboxResult.error || sandboxResult.status !== 0) {
    throw new Error(
      "[verify-standalone] restricted-token sandbox smoke failed"
        + ` (status=${String(sandboxResult.status)}, signal=${String(sandboxResult.signal)})`
        + (sandboxResult.error ? `: ${sandboxResult.error.message}` : "")
        + (sandboxResult.stderr ? `\nstderr: ${sandboxResult.stderr.trim()}` : ""),
    );
  }
  const smokeStdout = String(sandboxResult.stdout || "");
  const smokeStderr = String(sandboxResult.stderr || "");
  if (!smokeStdout.includes("LUC_RESTRICTED_TOKEN_OK")) {
    throw new Error("[verify-standalone] restricted-token sandbox smoke did not emit its success marker");
  }
  if (!smokeStdout.includes("LUC_DENY_WRITE_OK")) {
    throw new Error("[verify-standalone] restricted-token sandbox smoke did not prove deny-write enforcement");
  }
  const terminalRecord = 'luc-win-sandbox: terminal-v1 status="exited" exitCode="0" timeoutMs="30000" win32Error="0"';
  if (!smokeStderr.includes(terminalRecord)) {
    throw new Error(
      `[verify-standalone] restricted-token sandbox smoke emitted no successful terminal record\nstderr: ${smokeStderr.trim()}`,
    );
  }
  expectEqual(
    fs.readFileSync(spec.markerPath, "utf8").trim(),
    "LUC_RESTRICTED_TOKEN_OK",
    "restricted-token writable-root marker",
  );
  if (fs.existsSync(spec.deniedMarkerPath)) {
    throw new Error("[verify-standalone] restricted-token sandbox wrote inside an explicit deny-write path");
  }

  return spec;
}

export function restrictedTokenSmokeSpawnOptions({ cwd, env, timeout }) {
  return {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
    // Production one-shot execution gives the helper a closed stdin. Keep the
    // smoke on the same process contract.
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  };
}

export function standaloneExecCommandSmokeSpec({ layoutRoot, workDir, lucHome, env = process.env }) {
  const baseEnv = createHermeticMinGitSmokeEnv({
    runtimeRoot: path.win32.join(layoutRoot, "git"),
    workRoot: lucHome,
    env,
  });
  const helperPath = path.win32.join(layoutRoot, "sandbox", "windows", "luc-win-sandbox.exe");
  const serverRoot = path.win32.join(layoutRoot, "server");
  return {
    command: baseEnv.ComSpec,
    args: ["/d", "/s", "/c", `call "${path.win32.join(layoutRoot, "luc-server.cmd")}"`],
    // cmd.exe parses its raw command line instead of CommandLineToArgvW output.
    // Letting libuv quote the final /c argument turns the inner batch-file
    // quotes into literal \" characters, so cmd tries to execute a filename
    // that includes quotes. The command is fully generated here; preserve it
    // verbatim so `call "...\\luc-server.cmd"` reaches cmd.exe unchanged.
    windowsVerbatimArguments: true,
    env: {
      ...baseEnv,
      LUC_HOME: lucHome,
      // Poison values prove the extracted wrapper, rather than the verifier,
      // owns the packaged runtime contract before Node imports the probe.
      LUC_ROOT: "Z:\\luc-poison\\server",
      LUC_SERVER_ENTRY: "Z:\\luc-poison\\server\\bundle\\index.js",
      LUC_WIN32_SANDBOX_HELPER: "Z:\\luc-poison\\sandbox\\luc-win-sandbox.exe",
      LUC_INTERNAL_STANDALONE_RUNTIME_SMOKE: "1",
      LUC_STANDALONE_EXEC_WORK: workDir,
      LUC_STANDALONE_EXPECTED_HELPER: helperPath,
      LUC_STANDALONE_EXPECTED_ROOT: serverRoot,
    },
  };
}

function smokeExtractedRuntime({ rootDir, layoutRoot }) {
  if (process.platform !== "win32") {
    throw new Error("[verify-standalone] --smoke is Windows-only because the archive contains Windows executables");
  }

  execFileSync(
    process.execPath,
    [path.join(rootDir, "scripts", "smoke-mingit.mjs"), path.join(layoutRoot, "git")],
    { stdio: "inherit" },
  );

  const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "luc-standalone-runtime-"));
  const smokeHome = path.join(smokeRoot, "luc-home");
  const workDir = path.join(smokeRoot, "work");
  fs.mkdirSync(smokeHome, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(path.join(smokeHome, "agents", "standalone-smoke"), { recursive: true });
  try {
    runRestrictedTokenHelperSmoke({ layoutRoot, workDir, lucHome: smokeHome });

    const execSpec = standaloneExecCommandSmokeSpec({
      layoutRoot,
      workDir,
      lucHome: smokeHome,
    });
    const execResult = spawnSync(execSpec.command, execSpec.args, {
      cwd: layoutRoot,
      env: execSpec.env,
      encoding: "utf8",
      windowsHide: true,
      windowsVerbatimArguments: execSpec.windowsVerbatimArguments,
      timeout: 90_000,
    });
    if (execResult.error || execResult.status !== 0) {
      throw new Error(
        "[verify-standalone] packaged exec_command smoke failed"
          + ` (status=${String(execResult.status)}, signal=${String(execResult.signal)})`
          + (execResult.error ? `: ${execResult.error.message}` : "")
          + (execResult.stdout ? `\nstdout: ${execResult.stdout.trim()}` : "")
          + (execResult.stderr ? `\nstderr: ${execResult.stderr.trim()}` : ""),
      );
    }
    const receiptPrefix = "LUC_STANDALONE_EXEC_RECEIPT=";
    const receiptLine = String(execResult.stdout || "")
      .split(/\r?\n/)
      .find((line) => line.startsWith(receiptPrefix));
    if (!receiptLine) {
      throw new Error(
        "[verify-standalone] packaged exec_command smoke emitted no receipt"
          + (execResult.stdout ? `\nstdout: ${execResult.stdout.trim()}` : "")
          + (execResult.stderr ? `\nstderr: ${execResult.stderr.trim()}` : ""),
      );
    }
    const execReceipt = JSON.parse(receiptLine.slice(receiptPrefix.length));
    expectEqual(execReceipt.ok, true, "exec_command packaged-runtime smoke status");
  } finally {
    fs.rmSync(smokeRoot, { recursive: true, force: true });
  }
}

/**
 * @param {{
 *   rootDir?: string,
 *   version?: string,
 *   arch?: string,
 *   artifactOutDir?: string,
 *   smoke?: boolean,
 *   log?: (message: string) => void,
 * }} opts
 */
export async function verifyWindowsStandaloneArtifact(opts = {}) {
  const rootDir = path.resolve(opts.rootDir ?? ROOT);
  const version = opts.version ?? readProductVersion(rootDir);
  const arch = opts.arch ?? STANDALONE_ARCH;
  const artifactOutDir = path.resolve(opts.artifactOutDir ?? path.join(rootDir, "dist-standalone"));
  const names = standaloneArtifactNames(version, arch);
  const archivePath = path.join(artifactOutDir, names.archiveName);
  const manifestPath = path.join(artifactOutDir, names.manifestName);
  const legacySignaturePath = `${manifestPath}.sig`;
  const log = opts.log ?? console.log;

  assertFile(archivePath, "standalone archive");
  assertFile(manifestPath, "standalone manifest");
  if (fs.existsSync(legacySignaturePath)) {
    throw new Error(
      `[verify-standalone] obsolete standalone manifest signature must be removed: ${legacySignaturePath}`,
    );
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  expectEqual(manifest.schema, 1, "manifest schema");
  expectEqual(manifest.kind, "luc-core-standalone", "manifest kind");
  expectEqual(manifest.version, version, "manifest version");
  expectEqual(manifest.platform, STANDALONE_PLATFORM, "manifest platform");
  expectEqual(manifest.arch, arch, "manifest architecture");
  expectEqual(manifest.archive?.path, names.archiveName, "manifest archive path");
  expectEqual(manifest.layout?.root, STANDALONE_LAYOUT_ROOT, "manifest layout root");
  expectEqual(manifest.layout?.server, `${STANDALONE_LAYOUT_ROOT}/server`, "manifest server layout");
  expectEqual(manifest.layout?.git, `${STANDALONE_LAYOUT_ROOT}/git`, "manifest Git layout");
  expectEqual(
    manifest.layout?.sandboxHelper,
    `${STANDALONE_LAYOUT_ROOT}/sandbox/windows/luc-win-sandbox.exe`,
    "manifest sandbox helper layout",
  );
  expectEqual(manifest.runtime?.minGitVersion, MINGIT_VERSION, "manifest MinGit version");

  const actualSha256 = await activation.sha256File(archivePath);
  const actualSize = fs.statSync(archivePath).size;
  expectEqual(manifest.archive?.sha256, actualSha256, "archive sha256");
  expectEqual(manifest.archive?.size, actualSize, "archive size");

  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "luc-standalone-verify-"));
  try {
    await ustar.extract(archivePath, extractDir);
    const layoutRoot = path.join(extractDir, STANDALONE_LAYOUT_ROOT);
    const rootStat = fs.statSync(layoutRoot);
    if (!rootStat.isDirectory()) {
      throw new Error(`[verify-standalone] archive layout root must be a directory: ${layoutRoot}`);
    }
    assertExtractedLayout(layoutRoot);
    if (opts.smoke) smokeExtractedRuntime({ rootDir, layoutRoot });
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }

  log(`[verify-standalone] verified ${names.archiveName}`);
  return { archivePath, manifestPath, manifest };
}

async function main() {
  const args = process.argv.slice(2);
  const arch = args.find((arg) => !arg.startsWith("--")) ?? STANDALONE_ARCH;
  await verifyWindowsStandaloneArtifact({ arch, smoke: args.includes("--smoke") });
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
