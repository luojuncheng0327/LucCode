"use strict";

/**
 * artifact-ota-dev-bypass.prod-stub.cjs — production replacement for
 * artifact-ota-dev-bypass.cjs (background OTA).
 *
 * Swapped in by vite.config.main.js's alias for every `main.bundle.cjs`
 * build, unconditionally (not gated on LUC_SIGN_KEYSET — a test-keyset
 * local pack build is still a "production shell" from the dev-bypass
 * module's point of view: the override must be provably absent from any
 * bundle a real user could ever run). Carries no reference to any
 * environment-variable name — this is the file that makes
 * `grep LUC_ARTIFACT_MANIFEST desktop/main.bundle.cjs` come back empty.
 */

function resolveDevManifestOverride() {
  return null;
}

function hasDevOverride() {
  return false;
}

module.exports = { resolveDevManifestOverride, hasDevOverride };
