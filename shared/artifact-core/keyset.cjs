"use strict";

/**
 * shared/artifact-core/keyset.cjs
 *
 * The single source used by both the build-side signer and the shell/CLI
 * runtime to read the pinned artifact-signing keyset. The keyset lives in
 * `pinned-keyset.json`; it contains public keys only and rotation appends
 * entries instead of mutating existing keys in place.
 *
 * Bundling note: the shell main process is bundled by Vite
 * (`vite.config.main.js`), which INLINES the required JSON at bundle
 * time — the keyset travels inside the codesigned main bundle, not as a
 * loose resource file. `LUC_SIGN_KEYSET=<path>` is honored by the BUILD
 * (vite alias swaps which file gets inlined); this module never reads
 * env at runtime — there is no runtime verification bypass.
 */

// Static specifier on purpose: Vite's alias + JSON plugins key off this
// exact literal to inline (and optionally substitute) the keyset at
// bundle time. Do not make this path dynamic.
const rawKeyset = require("./pinned-keyset.json");

/**
 * @returns {Array<{keyId: string, publicKey: string}>} a fresh copy per
 * call — callers can never mutate the pinned source through the return
 * value.
 */
function loadPinnedKeyset() {
  // Bundler interop: Vite/rollup JSON modules may surface as the value
  // itself or as `{ default: value }` depending on the interop mode.
  const value = Array.isArray(rawKeyset) ? rawKeyset : rawKeyset && rawKeyset.default;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("keyset: pinned-keyset.json must be a non-empty array of {keyId, publicKey}");
  }
  return value.map((entry, index) => {
    if (
      entry === null ||
      typeof entry !== "object" ||
      typeof entry.keyId !== "string" ||
      entry.keyId.length === 0 ||
      typeof entry.publicKey !== "string" ||
      entry.publicKey.length === 0
    ) {
      throw new Error(`keyset: pinned-keyset.json entry ${index} must be {keyId: string, publicKey: string}`);
    }
    return { keyId: entry.keyId, publicKey: entry.publicKey };
  });
}

module.exports = { loadPinnedKeyset };
