"use strict";

/**
 * train-update-apply.cjs — pure decision/orchestration helpers for the
 * "apply now" train-update mechanic. Applying a staged train is refresh-grade:
 * promote artifacts, restart the server, then reload renderer windows.
 *
 * Kept Electron- and IO-free on purpose so the ORDERING and FAIL-FAST
 * behavior of the apply-now sequence is unit-testable without spawning
 * real processes or touching the filesystem: desktop/main.cjs supplies the
 * actual step implementations (promote via the existing artifact-boot
 * chain, gracefully stop + respawn the server child process, reload
 * windows) and this module only guarantees the CONTRACT — steps run in
 * this fixed order, and a throwing step stops every step after it from
 * ever running, so a mid-sequence failure can never leave a "some of the
 * promote happened, spawn never got attempted" kind of ambiguity hidden
 * inside ad-hoc try/catch nesting at the call site.
 *
 * This module does not reimplement or bypass anything in
 * shared/artifact-core/** or artifact-boot.cjs's boot semantics — it is
 * purely a sequencing/guard layer around calls main.cjs makes into that
 * already-hardened machinery.
 */

/** Fixed step order for the apply-now sequence; callers must not reorder it. */
const APPLY_NOW_STEPS = Object.freeze([
  "verify-packaged",
  "verify-staged",
  "shutdown-server",
  "start-server",
  "reload-windows",
]);

/**
 * Maps each step name to the key the caller's `steps` object must supply a
 * function under. Kept as an explicit table (not a naming convention) so a
 * typo in either this file or the call site fails loudly via the
 * "missing step implementation" error in `runApplyNowSequence`, rather
 * than silently skipping a step.
 */
const STEP_IMPLEMENTATION_KEY = Object.freeze({
  "verify-packaged": "verifyPackaged",
  "verify-staged": "verifyStaged",
  "shutdown-server": "shutdownServer",
  "start-server": "startServer",
  "reload-windows": "reloadWindows",
});

/**
 * Dev-mode guard: apply-now is a packaged-only mechanic (dev builds have
 * no seed/pointer-driven artifact boot to promote into — there is nothing
 * for "refresh-grade apply" to mean there). Throws rather than silently
 * no-op-ing so a stray dev-mode call surfaces loudly instead of pretending
 * to have done something.
 * @param {boolean} isPackaged
 */
function assertPackagedMode(isPackaged) {
  if (!isPackaged) {
    throw new Error(
      "train-update-apply: apply-now is only available in packaged builds "
        + "(dev mode has no artifact boot to promote into)",
    );
  }
}

/**
 * The apply-now staged-train precondition: promote() must only be
 * attempted once artifact-ota has confirmed BOTH kinds' `next` pointers
 * are in place and agree on the same train (see
 * `bothNextPointersReady` in artifact-ota.cjs, which this status is
 * derived from). A partially-staged train must never be treated as
 * apply-ready.
 * @param {{staged: boolean, train?: number|null, version?: string|null}|null|undefined} stagedStatus
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function checkStagedPrecondition(stagedStatus) {
  if (!stagedStatus || stagedStatus.staged !== true) {
    return { ok: false, reason: "not-staged" };
  }
  return { ok: true };
}

function assertServerShutdownConfirmed(result) {
  if (result?.confirmed === true) return;
  const reason = typeof result?.reason === "string" && result.reason
    ? ` (${result.reason})`
    : "";
  throw new Error(`train-update-apply: server shutdown was not confirmed${reason}`);
}

/**
 * Runs the apply-now sequence with injected step implementations. Steps
 * run strictly in `APPLY_NOW_STEPS` order; the first step to throw/reject
 * stops every subsequent step from running and the sequence resolves
 * (never rejects) with a `{ok: false, step, error}` descriptor so the
 * caller can decide how to surface the failure (log, dialog, sticker
 * reset to idle) without an uncaught rejection anywhere in the chain.
 * @param {{
 *   verifyPackaged: () => (void | Promise<void>),
 *   verifyStaged: () => (void | Promise<void>),
 *   shutdownServer: () => (void | Promise<void>),
 *   startServer: () => (void | Promise<void>),
 *   reloadWindows: () => (void | Promise<void>),
 * }} steps
 * @returns {Promise<{ok: true} | {ok: false, step: string, error: string}>}
 */
async function runApplyNowSequence(steps) {
  for (const stepName of APPLY_NOW_STEPS) {
    const implementationKey = STEP_IMPLEMENTATION_KEY[stepName];
    const fn = steps ? steps[implementationKey] : undefined;
    if (typeof fn !== "function") {
      throw new Error(`train-update-apply: missing step implementation for "${stepName}" (expected steps.${implementationKey})`);
    }
    try {
      await fn();
    } catch (err) {
      return { ok: false, step: stepName, error: err?.message || String(err) };
    }
  }
  return { ok: true };
}

module.exports = {
  APPLY_NOW_STEPS,
  STEP_IMPLEMENTATION_KEY,
  assertPackagedMode,
  assertServerShutdownConfirmed,
  checkStagedPrecondition,
  runApplyNowSequence,
};
