#!/usr/bin/env node
/**
 * Build the self-contained Windows LucCore archive published alongside the
 * desktop installer.
 *
 * This is deliberately a second packaging boundary. The existing
 * dist-server-artifact/<platform-arch>/server-*.tar.gz files stay lean because they are
 * embedded as Electron seed content and reused by the OTA train. Putting
 * MinGit or the sandbox helper in that tree would duplicate them inside the
 * installer and redownload them with every content update.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

import { assertRuntimeComplete, MINGIT_VERSION } from "./mingit-runtime.js";

const require = createRequire(import.meta.url);
const ustar = require("../shared/artifact-core/ustar.cjs");
const activation = require("../shared/artifact-core/activation.cjs");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const ROOT = path.resolve(__dirname, "..");
export const STANDALONE_LAYOUT_ROOT = "LucCore";
export const STANDALONE_PLATFORM = "win32";
export const STANDALONE_ARCH = "x64";

export const REQUIRED_STANDALONE_SERVER_FILES = [
  "luc.cmd",
  "luc-server.cmd",
  "luc-server.exe",
  "bootstrap.js",
  "bundle/index.js",
  "bundle/cli.js",
];

function assertSafeVersion(version) {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`[standalone] invalid product version: ${JSON.stringify(version)}`);
  }
}

function assertDirectory(dirPath, label) {
  let stat;
  try {
    stat = fs.statSync(dirPath);
  } catch {
    throw new Error(`[standalone] ${label} directory is missing: ${dirPath}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`[standalone] ${label} must be a directory: ${dirPath}`);
  }
}

function assertFile(filePath, label) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new Error(`[standalone] ${label} is missing: ${filePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`[standalone] ${label} must be a file: ${filePath}`);
  }
}

export function readProductVersion(rootDir = ROOT) {
  const packagePath = path.join(rootDir, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  assertSafeVersion(packageJson.version);
  return packageJson.version;
}

export function standaloneArtifactNames(version, arch = STANDALONE_ARCH) {
  assertSafeVersion(version);
  if (arch !== STANDALONE_ARCH) {
    throw new Error(`[standalone] unsupported Windows architecture ${arch}; only ${STANDALONE_ARCH} is published`);
  }
  const stem = `LucCore-${version}-Windows-${arch}`;
  const archiveName = `${stem}.tar.gz`;
  if (archiveName.startsWith("server-")) {
    throw new Error(`[standalone] archive name must never overlap the OTA server-* namespace: ${archiveName}`);
  }
  return {
    archiveName,
    manifestName: `${stem}.manifest.json`,
  };
}

export function standaloneWrapperContents() {
  const common = [
    "@echo off",
    "setlocal",
    'set "LUC_ROOT=%~dp0server"',
    'set "LUC_SERVER_ENTRY=%~dp0server\\bundle\\index.js"',
    'set "LUC_WIN32_SANDBOX_HELPER=%~dp0sandbox\\windows\\luc-win-sandbox.exe"',
    'set "PATH=%~dp0git\\cmd;%~dp0git\\usr\\bin;%~dp0git\\mingw64\\bin;%PATH%"',
  ];
  return {
    luc: [...common, '"%~dp0server\\luc-server.exe" "%~dp0server\\bundle\\cli.js" %*', ""].join("\r\n"),
    server: [...common, '"%~dp0server\\luc-server.exe" "%~dp0server\\bootstrap.js" %*', ""].join("\r\n"),
  };
}

function assertServerTree(serverDir) {
  assertDirectory(serverDir, "packaged server");
  for (const relative of REQUIRED_STANDALONE_SERVER_FILES) {
    assertFile(path.join(serverDir, ...relative.split("/")), `packaged server file ${relative}`);
  }
}

function assertArtifactOutputIsSeparate({ rootDir, serverDir, artifactOutDir }) {
  const resolvedArtifactOutDir = path.resolve(artifactOutDir);
  const relative = path.relative(path.resolve(serverDir), resolvedArtifactOutDir);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error("[standalone] artifact output must stay outside dist-server; the source runtime is immutable");
  }
  const serverArtifactRoot = path.resolve(rootDir, "dist-server-artifact");
  const relativeToServerArtifacts = path.relative(serverArtifactRoot, resolvedArtifactOutDir);
  if (
    relativeToServerArtifacts === ""
    || (!relativeToServerArtifacts.startsWith("..") && !path.isAbsolute(relativeToServerArtifacts))
  ) {
    throw new Error("[standalone] standalone artifacts must not enter dist-server-artifact (Electron seed / OTA boundary)");
  }
  const expectedOutputDir = path.resolve(rootDir, "dist-standalone");
  if (resolvedArtifactOutDir !== expectedOutputDir) {
    throw new Error(
      `[standalone] artifact output must be the dedicated dist-standalone directory: ${expectedOutputDir}`,
    );
  }
}

/**
 * @param {{
 *   rootDir?: string,
 *   version?: string,
 *   arch?: string,
 *   serverDir?: string,
 *   gitDir?: string,
 *   helperPath?: string,
 *   artifactOutDir?: string,
 *   log?: (message: string) => void,
 *   deps?: {
 *     packTree?: (srcDir: string, archivePath: string) => Promise<void>,
 *     sha256File?: (filePath: string) => Promise<string>,
 *     statSize?: (filePath: string) => number,
 *   },
 * }} opts
 */
export async function buildWindowsStandaloneArtifact(opts = {}) {
  const rootDir = path.resolve(opts.rootDir ?? ROOT);
  const version = opts.version ?? readProductVersion(rootDir);
  const arch = opts.arch ?? STANDALONE_ARCH;
  const names = standaloneArtifactNames(version, arch);
  const serverDir = path.resolve(opts.serverDir ?? path.join(rootDir, "dist-server", `win-${arch}`));
  const gitDir = path.resolve(opts.gitDir ?? path.join(rootDir, "vendor", "mingit"));
  const helperPath = path.resolve(
    opts.helperPath ?? path.join(rootDir, "dist-sandbox", `win-${arch}`, "luc-win-sandbox.exe"),
  );
  const artifactOutDir = path.resolve(opts.artifactOutDir ?? path.join(rootDir, "dist-standalone"));
  const log = opts.log ?? console.log;
  const {
    packTree = ustar.packTree,
    sha256File = activation.sha256File,
    statSize = (filePath) => fs.statSync(filePath).size,
  } = opts.deps ?? {};

  assertArtifactOutputIsSeparate({ rootDir, serverDir, artifactOutDir });
  const archivePath = path.join(artifactOutDir, names.archiveName);
  const manifestPath = path.join(artifactOutDir, names.manifestName);
  const legacySignaturePath = `${manifestPath}.sig`;
  const createdOutputs = [archivePath, manifestPath];
  // Remove this version's previous result before validating inputs. Otherwise a
  // failed rebuild (missing helper/runtime) can leave a stale but still
  // valid-looking release set behind for a later verify/upload step. Also
  // remove the detached signature produced by the short-lived signed format so
  // local output directories cannot accidentally retain that obsolete asset.
  for (const output of [...createdOutputs, legacySignaturePath]) fs.rmSync(output, { force: true });

  assertServerTree(serverDir);
  assertDirectory(gitDir, "MinGit runtime");
  try {
    assertRuntimeComplete(gitDir);
  } catch (error) {
    throw new Error(`[standalone] MinGit runtime is incomplete; refusing to publish\n${error.message}`);
  }
  assertFile(helperPath, "Windows sandbox helper");

  fs.mkdirSync(artifactOutDir, { recursive: true });

  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "luc-standalone-"));
  const layoutRoot = path.join(stagingDir, STANDALONE_LAYOUT_ROOT);

  try {
    fs.mkdirSync(layoutRoot, { recursive: true });
    fs.cpSync(serverDir, path.join(layoutRoot, "server"), {
      recursive: true,
      dereference: false,
      preserveTimestamps: true,
    });
    fs.cpSync(gitDir, path.join(layoutRoot, "git"), {
      recursive: true,
      dereference: false,
      preserveTimestamps: true,
    });
    const stagedHelper = path.join(layoutRoot, "sandbox", "windows", "luc-win-sandbox.exe");
    fs.mkdirSync(path.dirname(stagedHelper), { recursive: true });
    fs.copyFileSync(helperPath, stagedHelper);

    const wrappers = standaloneWrapperContents();
    fs.writeFileSync(path.join(layoutRoot, "luc.cmd"), wrappers.luc, "utf8");
    fs.writeFileSync(path.join(layoutRoot, "luc-server.cmd"), wrappers.server, "utf8");

    await packTree(stagingDir, archivePath);
    const sha256 = await sha256File(archivePath);
    const size = statSize(archivePath);
    const manifest = {
      schema: 1,
      kind: "luc-core-standalone",
      version,
      platform: STANDALONE_PLATFORM,
      arch,
      createdAt: new Date().toISOString(),
      archive: { path: names.archiveName, sha256, size },
      layout: {
        root: STANDALONE_LAYOUT_ROOT,
        server: `${STANDALONE_LAYOUT_ROOT}/server`,
        git: `${STANDALONE_LAYOUT_ROOT}/git`,
        sandboxHelper: `${STANDALONE_LAYOUT_ROOT}/sandbox/windows/luc-win-sandbox.exe`,
      },
      runtime: { minGitVersion: MINGIT_VERSION },
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    log(`[standalone] packed ${names.archiveName} with SHA-256 manifest -> ${artifactOutDir}`);
    return { archivePath, manifestPath, manifest };
  } catch (error) {
    for (const output of createdOutputs) fs.rmSync(output, { force: true });
    throw error;
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

async function main() {
  const arch = process.argv[2] ?? STANDALONE_ARCH;
  if (process.argv.length > 3 || arch.startsWith("--")) {
    throw new Error("[standalone] usage: node scripts/build-standalone-server-artifact.mjs [x64]");
  }
  await buildWindowsStandaloneArtifact({ arch });
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
