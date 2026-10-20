"use strict";

/**
 * shared/contract-versions.cjs — the Node-side entry for the three
 * cross-runtime contract version numbers.
 *
 * The literal values live in the sibling shared/contract-versions.json (the
 * single source of truth): this .cjs re-exports them for Node consumers
 * (build scripts, the shell's OTA gate, the server route, tests), and
 * shared/contract-versions.ts imports the same JSON for the renderer/browser
 * graph. JSON is the one format both a synchronous CommonJS require() and
 * Vite's browser ESM import handle natively — routing the numbers through it
 * keeps the browser dependency graph free of any CJS→ESM interop, which Vite's
 * dev server does not synthesize for un-pre-bundled source .cjs files. To bump
 * a number, edit the JSON; the rules for WHEN to bump are documented below.
 *
 * Every train manifest (seed and published trains alike) carries a
 * `contract: { preload, serverProtocol }` field, validated for shape by
 * `shared/artifact-core/manifest.cjs`. This file is where those numbers
 * actually come from — manifest construction, the shell-side OTA gate,
 * the server-identity handshake, and the renderer-side runtime comparison
 * all require this module instead of writing their own literal copy.
 *
 * PRELOAD_API_VERSION — the preload API surface the shell (this Electron
 * build) exposes to the renderer. A train whose manifest declares a higher
 * `contract.preload` than this constant depends on preload capabilities
 * this shell doesn't have; that train must not be activated on this shell,
 * exactly like the existing minShell gate (`isShellVersionSufficient`) —
 * it's "the shell is too old" in a different shape.
 *
 * SERVER_PROTOCOL_VERSION — the renderer<->server runtime protocol this
 * build speaks. It's checked at runtime through the existing
 * server-identity handshake: diagnostic only, never a gate, because the
 * renderer and server inside one already-running install are supposed to
 * always match (they're built and shipped together) — a mismatch here is
 * itself the interesting signal, not something to hide by refusing to run.
 *
 * Versioning rule (additive-only): bump either number ONLY when new
 * content actually depends on a capability an old shell/server does not
 * have. A bump means old shells stop receiving new trains (surfaced to the
 * user as "please update the app") until they update the app itself — a
 * real cost, so don't bump casually.
 *
 * DATA_EPOCH — the on-disk data format contract for a LUC_HOME directory
 * (SQLite schemas, session JSONL shapes, and any other persisted state a
 * kernel reads/writes there). Checked by shared/data-epoch.cjs at server
 * startup: a kernel whose own DATA_EPOCH is lower than the epoch already
 * stamped into a LUC_HOME's data-epoch.json is refused (an older kernel
 * must not silently misread data a newer kernel already evolved), unless
 * the operator explicitly overrides it. Unlike PRELOAD_API_VERSION /
 * SERVER_PROTOCOL_VERSION this is not a shell/server handshake — it is a
 * standalone contract number scoped to persisted data only.
 *
 * Versioning rule (breaking-only, stricter than the two above): bump ONLY
 * when a change to persisted data is actually breaking for an older
 * kernel's understanding of it — e.g. repurposing an existing column,
 * changing a field's meaning or required-ness, restructuring a JSONL
 * record shape. Purely additive evolution (new table, new optional field,
 * new file that old code simply never reads) must NOT bump this — see
 * shared/data-epoch.cjs's module doc for the full rationale and the
 * migration obligation that coordinates with a bump.
 */

const { PRELOAD_API_VERSION, SERVER_PROTOCOL_VERSION, DATA_EPOCH } = require("./contract-versions.json");

module.exports = {
  PRELOAD_API_VERSION,
  SERVER_PROTOCOL_VERSION,
  DATA_EPOCH,
};
