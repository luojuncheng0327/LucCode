#!/usr/bin/env node
/**
 * scripts/build-shell.mjs — shell-only builder over a checked-in shell
 * surface census (build/shell-surface-manifest.json)
 *
 * Builds *only* the Electron shell: main/preload/splash bundles, the
 * mac-only computer-use helper, then hands the whole tree to
 * `electron-builder --dir`. It deliberately does NOT build the renderer
 * or the server — those ship inside the signed seed kit
 * (dist-server-artifact/{os}-{arch}/), which this script only *verifies*
 * (fail-closed, read-only) via scripts/verify-seed-kit.mjs. A missing or
 * stale seed kit is a hard failure with a message telling the operator to
 * run `npm run build:server` or fetch an already-signed artifact — never
 * a "helpfully" auto-triggered build:server call, and never a reason to
 * fall back to an unsigned/partial seed.
 *
 * Structural guarantee: LUC_SIGN_KEY (the private signing key path) is
 * never read by this script, and is stripped from the environment handed
 * to every child process it spawns (see buildChildEnv()) — even if the
 * invoking shell happens to have it set for unrelated reasons (e.g. an
 * operator who also runs full signed releases from the same terminal).
 * scripts/verify-seed-kit.mjs's own contract already never reads
 * LUC_SIGN_KEY either (it only ever reads the public LUC_SIGN_KEYSET
 * override, which is unrelated and intentionally passed through
 * unmodified — see that variable's doc comment in
 * scripts/build-server-artifact.mjs).
 *
 * Steps (in order):
 *   1. build:computer-use-helper — conditional, darwin only
 *   2. build:main    (vite.config.main.js    -> desktop/main.bundle.cjs)
 *   3. build:preload (vite.config.preload.js -> desktop/preload.bundle.cjs)
 *   4. build:splash  (vite.config.splash.ts  -> desktop/dist-splash/)
 *   5. verify-seed-kit.mjs against the existing dist-server-artifact/{os}-{arch}/
 *   6. electron-builder --dir
 *   7. structural self-check of the --dir output (asar contents, seed/
 *      resources, renderer absence) — see verifyBuiltShellStructure()
 *
 * build:theme is deliberately absent from this list: its output lands
 * under desktop/dist-renderer/lib/ and is only referenced by renderer
 * HTML entries (index/mobile/settings/quick-chat/onboarding/browser-viewer),
 * none of which ship in the asar. See build/shell-surface-manifest.json's
 * "themeAttribution" field and tests/shell-surface-manifest.test.ts for
 * the checked evidence.
 *
 * Local unsigned run (mirrors the existing `npm run install:local`
 * convention):
 *   CSC_IDENTITY_AUTO_DISCOVERY=false SKIP_NOTARIZE=true npm run build:shell
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";

import { buildComputerUseHelper, shouldBuildComputerUseHelper } from "./build-computer-use-helper.mjs";
import { seedManifestFileName } from "./build-server-artifact.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const SIGN_KEY_ENV_VAR = "LUC_SIGN_KEY";

const VITE_BIN = path.join(ROOT, "node_modules", ".bin", "vite");
const ELECTRON_BUILDER_BIN = path.join(ROOT, "node_modules", ".bin", "electron-builder");
const ASAR_BIN = path.join(ROOT, "node_modules", ".bin", "asar");
const VERIFY_SEED_KIT_SCRIPT = path.join(ROOT, "scripts", "verify-seed-kit.mjs");
const MANIFEST_PATH = path.join(ROOT, "build", "shell-surface-manifest.json");

function log(msg) {
  console.log(`[build-shell] ${msg}`);
}

/**
 * Builds the environment handed to every child process this script spawns.
 * Explicit runtime assertion (not just the `delete` statement's say-so)
 * that LUC_SIGN_KEY cannot leak into anything build:shell runs.
 */
function buildChildEnv() {
  const env = { ...process.env };
  const hadSignKey = Object.prototype.hasOwnProperty.call(env, SIGN_KEY_ENV_VAR);
  delete env[SIGN_KEY_ENV_VAR];
  if (Object.prototype.hasOwnProperty.call(env, SIGN_KEY_ENV_VAR)) {
    throw new Error(`[build-shell] internal error: ${SIGN_KEY_ENV_VAR} survived stripping from the child env`);
  }
  if (hadSignKey) {
    log(`note: ${SIGN_KEY_ENV_VAR} is set in the parent shell but is stripped from every child process build:shell spawns — never read, never forwarded.`);
  }
  return env;
}

function run(label, command, args, { cwd = ROOT, env } = {}) {
  log(`${label}...`);
  execFileSync(command, args, { cwd, stdio: "inherit", env });
}

function readOut(command, args, { cwd = ROOT, env } = {}) {
  return execFileSync(command, args, { cwd, env, encoding: "utf8" });
}

function osDirNameFor(platform) {
  return platform === "darwin" ? "mac" : platform === "win32" ? "win" : platform;
}

/**
 * Fail-closed pre-check with an operator-facing message, run *before*
 * verify-seed-kit.mjs so a missing kit gets an unambiguous "how do I fix
 * this" pointer rather than just verify-seed-kit's lower-level "manifest
 * missing" error. Never triggers build:server itself.
 */
function assertSeedKitDirExists({ platform, arch }) {
  const osDirName = osDirNameFor(platform);
  const artifactOutDir = path.join(ROOT, "dist-server-artifact", `${osDirName}-${arch}`);
  const manifestFileName = seedManifestFileName(`${platform}-${arch}`);
  const manifestPath = path.join(artifactOutDir, manifestFileName);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `[build-shell] no signed seed kit found at ${artifactOutDir} (expected ${manifestFileName}). `
        + `build:shell never builds the seed kit itself (it never touches build:server or ${SIGN_KEY_ENV_VAR}). `
        + `Run \`npm run build:server\` (with ${SIGN_KEY_ENV_VAR}/LUC_SIGN_KEYSET set) to produce one, or copy an `
        + `already-signed dist-server-artifact/${osDirName}-${arch}/ directory into place, then re-run build:shell.`,
    );
  }
  return { artifactOutDir, manifestPath };
}

/**
 * Recursively find every `app.asar` electron-builder's --dir target
 * produced under dist/. Deliberately does not replicate electron-builder's
 * own per-platform/arch output-directory naming (mac: dist/mac[-arch]/Name.app/Contents/Resources;
 * win/linux: dist/{platform}[-arch]-unpacked/resources) — that naming is
 * an electron-builder implementation detail this script shouldn't need to
 * track. Structural verification only needs "where did the asar land."
 */
function findAsarOutputs(distRoot) {
  const found = [];
  function walk(dir, depth) {
    if (depth > 6 || !fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name === "app.asar") {
        found.push(full);
      }
    }
  }
  walk(distRoot, 0);
  return found;
}

/**
 * Automated structural assertions on the --dir output. Never launches the
 * built app (structure-only checks against the filesystem, per the
 * absolute rule that this script must not start the app it just built).
 */
function verifyBuiltShellStructure({ platform, arch, childEnv }) {
  const distRoot = path.join(ROOT, "dist");
  const asarPaths = findAsarOutputs(distRoot);
  if (asarPaths.length === 0) {
    throw new Error(`[build-shell] structural check failed: no app.asar found anywhere under ${distRoot} after electron-builder --dir`);
  }
  if (asarPaths.length > 1) {
    throw new Error(`[build-shell] structural check failed: expected exactly one app.asar under ${distRoot}, found ${asarPaths.length}: ${asarPaths.join(", ")}`);
  }
  const asarPath = asarPaths[0];
  const resourcesDir = path.dirname(asarPath);
  log(`structural check: found asar at ${asarPath}`);

  const asarListing = readOut(ASAR_BIN, ["list", asarPath], { env: childEnv }).split("\n").map((l) => l.trim()).filter(Boolean);

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8"));

  // Every non-exclusion asarFiles entry must be represented in the asar
  // listing (asar list emits repo-root-relative paths prefixed with "/").
  // Entries containing a glob character are checked by prefix (everything
  // before the first "*") rather than by verbatim match — this covers
  // staticGlob/buildOutputGlob entries (e.g. "desktop/src/**/*.{html,...}")
  // as well as re-included vendored deps like "node_modules/ws/**" without
  // needing a per-kind allowlist that could silently stop covering a new
  // glob-shaped entry.
  const missingFromAsar = [];
  let checkedCount = 0;
  for (const entry of manifest.asarFiles) {
    if (entry.kind === "exclusion") continue;
    checkedCount++;
    const builderEntry = entry.builderEntry;
    const globIndex = builderEntry.indexOf("*");
    if (globIndex === -1) {
      const expected = `/${builderEntry}`;
      if (!asarListing.includes(expected)) missingFromAsar.push(builderEntry);
    } else {
      const prefix = `/${builderEntry.slice(0, globIndex)}`;
      const hasMatch = asarListing.some((line) => line.startsWith(prefix));
      if (!hasMatch) missingFromAsar.push(builderEntry);
    }
  }
  if (missingFromAsar.length > 0) {
    throw new Error(`[build-shell] structural check failed: manifest-declared shell file(s) missing from asar: ${missingFromAsar.join(", ")}`);
  }
  log(`structural check: all ${checkedCount} manifest-declared shell entries present in asar`);

  // Renderer bundle must never be inside the asar (double artifact
  // pipeline: renderer ships in the signed seed kit, not loose in the shell).
  const rendererLeaks = asarListing.filter((entry) => entry.includes("dist-renderer"));
  if (rendererLeaks.length > 0) {
    throw new Error(`[build-shell] structural check failed: renderer bundle leaked into the asar: ${rendererLeaks.slice(0, 5).join(", ")}${rendererLeaks.length > 5 ? ", ..." : ""}`);
  }
  log("structural check: no dist-renderer/ paths found in asar (renderer correctly excluded)");

  // resources/seed/ must carry the platform-qualified manifest + signature.
  const seedDir = path.join(resourcesDir, "seed");
  const manifestFileName = seedManifestFileName(`${platform}-${arch}`);
  const seedManifestPath = path.join(seedDir, manifestFileName);
  const seedSigPath = `${seedManifestPath}.sig`;
  if (!fs.existsSync(seedManifestPath)) {
    throw new Error(`[build-shell] structural check failed: extraResources seed/ is missing the platform-qualified manifest: ${seedManifestPath}`);
  }
  if (!fs.existsSync(seedSigPath)) {
    throw new Error(`[build-shell] structural check failed: extraResources seed/ is missing the manifest signature: ${seedSigPath}`);
  }
  log(`structural check: resources/seed/ carries ${manifestFileName} + .sig`);

  return { asarPath, resourcesDir, seedDir };
}

async function main() {
  const platform = process.platform;
  const arch = process.arch;
  const childEnv = buildChildEnv();

  log(`starting shell-only build for ${platform}-${arch}`);

  // ── 1. computer-use helper (mac only) ──
  if (shouldBuildComputerUseHelper({ platform })) {
    log("building computer-use helper (darwin)...");
    buildComputerUseHelper({ rootDir: ROOT, platform, env: childEnv, arch });
  } else {
    log(`skipping computer-use helper (not darwin: ${platform})`);
  }

  // ── 2-4. main / preload / splash — never renderer, never theme ──
  run("build:main", VITE_BIN, ["build", "--config", "vite.config.main.js"], { env: childEnv });
  run("build:preload", VITE_BIN, ["build", "--config", "vite.config.preload.js"], { env: childEnv });
  run("build:splash", VITE_BIN, ["build", "--config", "vite.config.splash.ts"], { env: childEnv });

  // ── 5. seed kit: verify an existing signed kit, never build one ──
  const { artifactOutDir } = assertSeedKitDirExists({ platform, arch });
  const seedFiles = fs.readdirSync(artifactOutDir);
  const seedSnapshotBefore = new Map(seedFiles.map((name) => {
    const stat = fs.statSync(path.join(artifactOutDir, name));
    return [name, `${stat.size}:${stat.mtimeMs}`];
  }));
  run("verify:seed-kit", process.execPath, [VERIFY_SEED_KIT_SCRIPT], { env: childEnv });
  // Belt-and-braces: verify-seed-kit.mjs documents itself as read-only.
  // Confirm nothing under the seed dir actually changed during this run.
  const seedSnapshotAfter = new Map(fs.readdirSync(artifactOutDir).map((name) => {
    const stat = fs.statSync(path.join(artifactOutDir, name));
    return [name, `${stat.size}:${stat.mtimeMs}`];
  }));
  const seedDirMutated = seedSnapshotBefore.size !== seedSnapshotAfter.size
    || [...seedSnapshotBefore].some(([name, sig]) => seedSnapshotAfter.get(name) !== sig);
  if (seedDirMutated) {
    throw new Error(`[build-shell] internal error: ${artifactOutDir} changed during verify-seed-kit.mjs, which must be read-only`);
  }

  // ── 6. electron-builder --dir ──
  run("electron-builder --dir", ELECTRON_BUILDER_BIN, ["--dir"], { env: childEnv });

  // ── 7. structural self-check (never launches the built app) ──
  verifyBuiltShellStructure({ platform, arch, childEnv });

  log("done.");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err) => {
    console.error(err?.stack || err?.message || String(err));
    process.exitCode = 1;
  });
}

export { assertSeedKitDirExists, buildChildEnv, findAsarOutputs, verifyBuiltShellStructure };
