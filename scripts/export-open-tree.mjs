#!/usr/bin/env node
/**
 * export-open-tree.mjs — materializes export-manifest.json's whitelist
 * (plus EXPORT_SKELETON's build infrastructure) into a clean, standalone
 * directory tree: a local rehearsal of what the redistributable open-source
 * repository will contain after the actual cutover.
 *
 * Pure copy, no rewriting: every file lands byte-for-byte identical to its
 * source. package.json script entries that reference closed-source-only
 * tooling are copied verbatim too — calling them inside the export tree is
 * expected to fail; scripts/rehearse-open-export.mjs's report records which
 * scripts are dead in the exported tree as input for the real cutover's
 * cleanup, it does not try to hide or fix that here.
 *
 * export-manifest.json remains the sole classification authority for
 * *source* files — this script never edits it and never adds a source path
 * to EXPORT_SKELETON. EXPORT_SKELETON is strictly already-public build
 * machinery (package.json's sibling lockfile/config files, and the
 * scripts/*.mjs the build:server:open chain itself imports/execs) with no
 * business logic, each entry carrying its own one-line reason.
 *
 * Path semantics (mirrors export-manifest.json's own "note" field, and
 * scripts/lint-open-boundary.mjs's expandManifestPaths, which this script
 * intentionally does NOT reuse — see below):
 *   - an entry ending in "/" is an exact directory; only its *git-tracked*
 *     contents are copied (so gitignored generated output sitting inside an
 *     otherwise-whitelisted directory, e.g. a package's own dist/, is never
 *     silently swept in)
 *   - every other entry is nominally "an exact file" per the manifest's own
 *     stated contract. Four manifest entries — lib/identity-templates,
 *     lib/agents-templates, lib/agents-public-templates, lib/yuan — are
 *     directories on disk despite lacking a trailing "/". Copying a
 *     directory as if it were one opaque file is not a coherent filesystem
 *     operation, and scripts/build-server-open.mjs's own
 *     OPEN_LIB_TEMPLATE_DIRS already treats these same four paths as
 *     directories to recursively copy at build time — so this script
 *     auto-detects via fs.statSync and, for any entry that resolves to an
 *     actual directory, falls back to the same git-tracked-directory-copy
 *     semantics as a trailing-"/" entry, regardless of the literal
 *     trailing-slash spelling. This is an interpretation of an ambiguous
 *     manifest entry for *copy* purposes, not a modification of the
 *     manifest's path list itself (export-manifest.json is byte-for-byte
 *     untouched). lint-open-boundary.mjs's expandManifestPaths cannot be
 *     reused as-is here because it deliberately does the opposite for
 *     scanning purposes (treats a non-"/" directory entry as one opaque,
 *     non-scannable path) — a correct choice for import-boundary linting,
 *     wrong for physically materializing a tree.
 *   - node_modules/... file entries are copied as literal files regardless
 *     of git-tracked status (node_modules is gitignored by design; these
 *     are pinned vendor snapshots), matching lint-open-boundary.mjs's own
 *     file-entry handling.
 *
 * Hard errors (fail closed, no silent skip): a manifest or skeleton path
 * that does not exist in the repo; a path that resolves outside the
 * repository root (path-escape guard); a non-empty destination directory
 * without --force.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { readExportManifest } from "./lint-open-boundary.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

export const DEFAULT_EXPORT_DIR_NAME = "dist-open-export";

/**
 * Build infrastructure the open-source composition build chain
 * (`npm ci` → `npm run build:server:open` → `npm run smoke:server:open`)
 * needs beyond export-manifest.json's whitelist (package.json itself is
 * already a manifest entry, not listed again here). Each entry is a single
 * already-public file with no closed-source content, carrying its own
 * reason. Finding a *source* file (business logic, not build tooling) that
 * looks like it belongs here is a stop-and-report event for the operator
 * running this script, not something to add silently.
 */
export const EXPORT_SKELETON = [
  {
    path: "tsconfig.json",
    reason: "packages/plugin-protocol and plugin-sdk (whitelisted) carry tsconfig.json files that `extends \"../../tsconfig.json\"`; vite's esbuild transform resolves that chain while bundling their sources, so the root compiler config (pure build settings, no business logic) must exist in the export tree.",
  },
  {
    path: "tsconfig.base.json",
    reason: "The root tsconfig.json itself `extends ./tsconfig.base.json`; same chain, same build-settings-only content.",
  },
  {
    path: "export-manifest.json",
    reason: "scripts/build-server-open.mjs's own assertOpenBuildInputsWhitelisted() reads export-manifest.json from its build root at build time (self-check that the build didn't read anything unwhitelisted); without a copy in the export tree the open build cannot even run its own gate. This ships the manifest itself, not a rewrite of it.",
  },
  {
    path: "package-lock.json",
    reason: "npm ci requires the lockfile to reproduce package.json's exact dependency tree; without it there is no npm-ci-compatible install at all.",
  },
  {
    path: ".npmrc",
    reason: "reproduces the repo's supply-chain install policy (save-exact, min-release-age, audit) so the rehearsal's npm behavior matches a real contributor's install; content is generic install policy, not project business logic.",
  },
  {
    path: "vite.config.server.js",
    reason: "scripts/build-server-phases.mjs's buildViteServerBundle runs `npx vite build --config vite.config.server.js`; without this file the server bundle step has no entry/output/external config at all.",
  },
  {
    path: "scripts/build-server-open.mjs",
    reason: "package.json's \"build:server:open\" script execs this file directly (node scripts/build-server-open.mjs).",
  },
  {
    path: "scripts/build-server-phases.mjs",
    reason: "imported by scripts/build-server-open.mjs for every packing primitive (Node runtime prep, Vite/CLI bundle, external dep install, nft prune, wrapper scripts).",
  },
  {
    path: "scripts/build-server-deps.mjs",
    reason: "imported by scripts/build-server-phases.mjs for external-dependency package.json derivation and native-addon runtime smoke-test source generation.",
  },
  {
    path: "scripts/build-server-prune.mjs",
    reason: "imported by scripts/build-server-phases.mjs to strip runtime-dead files (.ts/.map/.md) from the packaged node_modules.",
  },
  {
    path: "scripts/compute-cli-closure.mjs",
    reason: "imported by scripts/build-server-open.mjs for the RUNTIME_ASSETS list used by the pre-build whitelist assertion.",
  },
  {
    path: "scripts/lint-open-boundary.mjs",
    reason: "imported by scripts/build-server-open.mjs (readExportManifest) and by this export script itself, for the same manifest-loading contract.",
  },
  {
    path: "scripts/patch-pi-sdk.cjs",
    reason: "scripts/build-server-phases.mjs copies and executes this file by relative path (scripts/patch-pi-sdk.cjs) as a read-only Pi SDK verification step during external dependency install.",
  },
  {
    path: "scripts/smoke-open-server.mjs",
    reason: "package.json's \"smoke:server:open\" script execs this file directly (node scripts/smoke-open-server.mjs).",
  },
];

function toPosix(value) {
  return value.split(path.sep).join("/");
}

/**
 * Resolves a repo-relative path against rootDir and hard-errors if the
 * result escapes rootDir. Returns the absolute path.
 */
function resolveWithinRoot(rootDir, relPath) {
  const absRoot = path.resolve(rootDir);
  const abs = path.resolve(absRoot, relPath);
  if (abs !== absRoot && !abs.startsWith(absRoot + path.sep)) {
    throw new Error(`[export-open-tree] path escapes repository root: "${relPath}" resolved to ${abs}`);
  }
  return abs;
}

function listGitTrackedFiles(rootDir, relDir) {
  const output = execFileSync("git", ["ls-files", "--", relDir], { cwd: rootDir, encoding: "utf-8" });
  return output.split("\n").map((line) => line.trim()).filter(Boolean).map(toPosix);
}

/**
 * Expands manifest.paths + EXPORT_SKELETON into a concrete, deduplicated,
 * sorted list of repo-relative file paths to copy. See the module docstring
 * for the directory-detection rule.
 *
 * @param {{ rootDir: string, manifest: { paths: string[] }, skeleton: { path: string }[] }} params
 * @returns {string[]}
 */
export function planExportCopies({ rootDir, manifest, skeleton }) {
  const files = new Set();

  function addEntry(rawEntry) {
    const declaredDir = rawEntry.endsWith("/");
    const relEntry = declaredDir ? rawEntry.slice(0, -1) : rawEntry;
    const absEntry = resolveWithinRoot(rootDir, relEntry);
    if (!fs.existsSync(absEntry)) {
      throw new Error(`[export-open-tree] path does not exist in repository: "${rawEntry}"`);
    }
    const isDirOnDisk = fs.statSync(absEntry).isDirectory();
    if (declaredDir || isDirOnDisk) {
      for (const trackedFile of listGitTrackedFiles(rootDir, relEntry)) {
        resolveWithinRoot(rootDir, trackedFile);
        files.add(trackedFile);
      }
    } else {
      files.add(relEntry);
    }
  }

  for (const entry of manifest.paths) addEntry(entry);
  for (const item of skeleton) addEntry(item.path);

  return [...files].sort();
}

/**
 * Copies `relFiles` (repo-relative paths) from rootDir into destDir,
 * preserving relative structure. Pure copy — no content rewriting.
 */
function copyFiles({ rootDir, destDir, relFiles }) {
  for (const relPath of relFiles) {
    const src = path.join(rootDir, relPath);
    const dest = path.join(destDir, relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

/**
 * Materializes the export tree at destDir. Hard-errors (no silent
 * fallback) on: a manifest/skeleton path missing from the repo, a path
 * escaping the repository root, or a non-empty destDir without force.
 *
 * `skeleton` defaults to the real EXPORT_SKELETON and is only ever
 * overridden by tests (fixture repos that don't contain the real build
 * tooling files) — the CLI entrypoint below never passes a custom value, so
 * production behavior always uses the one declared, reasoned skeleton list.
 *
 * @param {{ rootDir?: string, destDir: string, force?: boolean, skeleton?: { path: string }[], log?: (msg: string) => void }} params
 * @returns {{ destDir: string, fileCount: number, files: string[] }}
 */
export function exportOpenTree({
  rootDir = ROOT,
  destDir,
  force = false,
  skeleton = EXPORT_SKELETON,
  log = (msg) => console.log(msg),
}) {
  if (!destDir) throw new Error("[export-open-tree] destDir is required");
  const absRoot = path.resolve(rootDir);
  const absDest = path.resolve(destDir);

  if (absDest === absRoot) {
    throw new Error(`[export-open-tree] destination directory must not be the repository root itself: ${absDest}`);
  }

  if (fs.existsSync(absDest)) {
    const nonEmpty = fs.readdirSync(absDest).length > 0;
    if (nonEmpty && !force) {
      throw new Error(
        `[export-open-tree] destination directory is non-empty: ${absDest} (pass --force to wipe and re-export)`,
      );
    }
    fs.rmSync(absDest, { recursive: true, force: true });
  }
  fs.mkdirSync(absDest, { recursive: true });

  const manifest = readExportManifest({ rootDir: absRoot });
  const relFiles = planExportCopies({ rootDir: absRoot, manifest, skeleton });
  copyFiles({ rootDir: absRoot, destDir: absDest, relFiles });

  log(`[export-open-tree] exported ${relFiles.length} file(s) to ${absDest}`);
  return { destDir: absDest, fileCount: relFiles.length, files: relFiles };
}

function parseArgs(argv) {
  const args = { destDir: DEFAULT_EXPORT_DIR_NAME, force: false };
  for (const arg of argv) {
    if (arg === "--force") {
      args.force = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`[export-open-tree] unknown argument: ${arg}`);
    } else {
      args.destDir = arg;
    }
  }
  return args;
}

function main() {
  const { destDir, force } = parseArgs(process.argv.slice(2));
  const absDest = path.isAbsolute(destDir) ? destDir : path.join(ROOT, destDir);
  exportOpenTree({ rootDir: ROOT, destDir: absDest, force });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
