"use strict";

/**
 * artifact-repair.cjs — manual "repair components" escape hatch.
 * Automatic crash-loop recovery already bottoms out at the bundled seed;
 * this module handles an explicit user request for a clean reset
 * module is the manual override for when a user wants a clean reset
 * and is reachable from the tray menu (confirm dialog) and from the
 * `--repair-artifacts` CLI flag (no confirm — the flag itself is the
 * confirmation).
 *
 * Resets ONLY the artifact pipeline's own on-disk state under
 * `{LUC_HOME}/artifacts/` — pointers, both kinds' extracted version
 * directories, in-progress staging, the quarantine list, both boot
 * sentinels, and OTA bookkeeping — so the next launch takes the exact
 * same "no current pointer resolves" path a brand-new install takes: seed
 * re-extraction through the normal activation path. User data
 * (agents/sessions/config) lives entirely outside `artifacts/` and is
 * never touched.
 *
 * Deliberately a fixed ALLOWLIST of known subpaths (never a directory
 * walk + denylist): `rollout-id` (grey-rollout identity, not component
 * state) and `lock` (the flock file — ripping it out from under a
 * concurrent OTA cycle would be its own bug) simply never appear in the
 * list below. No separate "except" branch to get wrong, and no risk of a
 * future addition to the artifacts root getting swept up by accident.
 */

const fsp = require("fs/promises");
const path = require("path");
const pointerStore = require("../../../shared/artifact-core/pointer-store.cjs");
const artifactBoot = require("./artifact-boot.cjs");

// Leaf filename owned by artifact-ota.cjs's private OTA_STATE_FILENAME.
// Mirrored here instead of widening that module's API: this is a stable on-disk
// contract shared by the repair path, not transient implementation state.
const OTA_STATE_FILENAME = "ota-state.json";

/**
 * Pure: the fixed list of `{artifactsRoot}`-relative subpaths a repair
 * removes. Anything not in this list — most notably `rollout-id` and
 * `lock` — is left untouched.
 * @returns {string[]}
 */
function repairSubpaths() {
  return [
    "pointers",
    "server",
    "renderer",
    "staging",
    "quarantine.json",
    `${artifactBoot.SEED_CHANNEL}.sentinel.json`,
    `${artifactBoot.rendererPointerChannel(artifactBoot.SEED_CHANNEL)}.sentinel.json`,
    OTA_STATE_FILENAME,
  ];
}

/**
 * Pure: resolves `repairSubpaths()` against `artifactsRoot` into absolute
 * paths.
 * @param {string} artifactsRoot
 * @returns {string[]}
 */
function computeRepairTargets(artifactsRoot) {
  return repairSubpaths().map((name) => path.join(artifactsRoot, name));
}

/**
 * Impure: deletes every repair target under `{homeDir}/artifacts/`.
 * Best-effort per item — one failure never stops the rest. Never throws.
 * @param {{homeDir: string, log?: (msg: string) => void}} opts
 * @returns {Promise<{removed: string[], failed: string[]}>}
 */
async function repairArtifacts({ homeDir, log = () => {} }) {
  const artifactsRoot = pointerStore.artifactsRoot(homeDir);
  const targets = computeRepairTargets(artifactsRoot);
  const removed = [];
  const failed = [];
  for (const target of targets) {
    try {
      await fsp.rm(target, { recursive: true, force: true });
      removed.push(target);
      log(`[artifact-repair] removed ${target}`);
    } catch (err) {
      failed.push(target);
      log(`[artifact-repair] failed to remove ${target}: ${err.message}`);
    }
  }
  return { removed, failed };
}

module.exports = {
  repairSubpaths,
  computeRepairTargets,
  repairArtifacts,
};
