#!/usr/bin/env node
/**
 * rehearse-open-export.mjs — full cutover rehearsal.
 *
 * Exports the open tree (scripts/export-open-tree.mjs), then, inside that
 * standalone directory, runs exactly the sequence a fresh contributor
 * cloning the future public repository would run:
 *
 *   npm ci  →  npm run build:server:open  →  npm run smoke:server:open
 *
 * Every step's exit code is checked explicitly and propagated — a failing
 * step aborts the rehearsal immediately with the step name and exit code in
 * the error message; nothing here reinterprets or swallows a non-zero exit.
 * This is the local, offline proxy for "does the redistributable whitelist
 * actually build and serve on its own", run before any real repository
 * cutover.
 *
 * Usage: node scripts/rehearse-open-export.mjs [destDir]
 * (defaults to <repo-root>/dist-open-export, matching
 * scripts/export-open-tree.mjs's own default)
 */
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { DEFAULT_EXPORT_DIR_NAME, exportOpenTree } from "./export-open-tree.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

/**
 * Runs one rehearsal step and hard-fails (throws) on a non-zero exit code,
 * a signal-terminated process, or a spawn error. Never inspects stdout to
 * decide pass/fail — the step's own exit code is the sole verdict, exactly
 * as CI would judge it.
 *
 * @param {{ step: string, cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv }} params
 */
export function runRehearsalStep({ step, cmd, args, cwd, env = process.env, log = (msg) => console.log(msg) }) {
  log(`[rehearse-open-export] ${step}: ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit", env });
  if (result.error) {
    throw new Error(`[rehearse-open-export] ${step} failed to spawn: ${result.error.message}`);
  }
  if (result.signal) {
    throw new Error(`[rehearse-open-export] ${step} was terminated by signal ${result.signal}`);
  }
  if (result.status !== 0) {
    throw new Error(`[rehearse-open-export] ${step} exited with non-zero code ${result.status}`);
  }
  log(`[rehearse-open-export] ${step} OK`);
  return result;
}

export function rehearsalSteps(destDir) {
  return [
    { step: "npm ci", cmd: "npm", args: ["ci", "--ignore-scripts=false"], cwd: destDir },
    { step: "build:server:open", cmd: "npm", args: ["run", "build:server:open"], cwd: destDir },
    { step: "smoke:server:open", cmd: "npm", args: ["run", "smoke:server:open"], cwd: destDir },
  ];
}

function main() {
  const destArg = process.argv[2];
  const destDir = destArg
    ? (path.isAbsolute(destArg) ? destArg : path.join(ROOT, destArg))
    : path.join(ROOT, DEFAULT_EXPORT_DIR_NAME);

  console.log(`[rehearse-open-export] exporting open tree to ${destDir}...`);
  const { fileCount } = exportOpenTree({ rootDir: ROOT, destDir, force: true });
  console.log(`[rehearse-open-export] exported ${fileCount} file(s)`);

  for (const stepDef of rehearsalSteps(destDir)) {
    runRehearsalStep(stepDef);
  }

  console.log("[rehearse-open-export] all green");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
