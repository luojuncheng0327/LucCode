"use strict";

/**
 * artifact-ota-dev-bypass.cjs — DEV-ONLY manifest source override
 * (development-only bypass contract; background OTA).
 *
 * `LUC_ARTIFACT_MANIFEST=<path|url>` lets a developer rehearse the full
 * background-OTA flow (fetch -> verify -> stage -> next-pointer) against a
 * local/staged manifest instead of the hardcoded `channels/<channel>.json`
 * URLs. This is a TRANSPORT override only — it does not skip signature,
 * schema, monotonic-train, minShell, or rollout checks; those still run
 * against whatever bytes this module returns.
 *
 * THIS FILE IS ALIAS-SWAPPED to `artifact-ota-dev-bypass.prod-stub.cjs` by
 * every `vite build --config vite.config.main.js` run (see the
 * unconditional alias entry there) — the string "LUC_ARTIFACT_MANIFEST"
 * therefore never appears in `desktop/main.bundle.cjs`, regardless of
 * whether that build used a real or test signing keyset. The override is
 * reachable ONLY when running the raw, unbundled `desktop/main.cjs` (dev
 * mode, `app.isPackaged === false` — see `desktop/bootstrap.cjs`'s
 * `require(app.isPackaged ? "./main.bundle.cjs" : "./main.cjs")`).
 *
 * `desktop/src/shared/artifact-ota.cjs` requires this module via a STATIC
 * specifier (`require("./artifact-ota-dev-bypass.cjs")`) on purpose — same
 * discipline as `shared/artifact-core/keyset.cjs`'s pinned-keyset require:
 * vite's alias plugin keys off the exact literal specifier to swap the
 * module at bundle time. Do not make this require dynamic, and do not
 * reference `process.env.LUC_ARTIFACT_MANIFEST` from any other file in
 * the OTA module — this file is the ONLY place that name may appear.
 */

function resolveDevManifestOverride() {
  const value = process.env.LUC_ARTIFACT_MANIFEST;
  return value ? value : null;
}

function hasDevOverride() {
  return resolveDevManifestOverride() !== null;
}

module.exports = { resolveDevManifestOverride, hasDevOverride };
