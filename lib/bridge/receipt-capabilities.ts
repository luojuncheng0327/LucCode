/**
 * Platform-owned waiting receipt capability declaration.
 *
 * BridgeManager emits a platform-neutral "assistant is preparing a reply"
 * lifecycle. Adapters declare how their platform should consume it.
 */

const RECEIPT_MODES = new Set(["text", "native_typing"]);

/**
 * @param {object} opts
 * @param {string} opts.platform
 * @param {"text"|"native_typing"} opts.mode
 * @param {string[]} [opts.scopes]
 * @param {number} [opts.refreshIntervalMs]
 * @param {boolean} [opts.cancellable]
 * @param {string} [opts.source]
 */
export function createReceiptCapabilities({
  platform,
  mode,
  scopes = ["dm"],
  refreshIntervalMs = 0,
  cancellable = false,
  source = "",
}) {
  if (!platform) throw new Error("receipt capability requires platform");
  if (!RECEIPT_MODES.has(mode)) throw new Error(`unsupported receipt mode: ${mode}`);
  return Object.freeze({
    platform,
    mode,
    scopes: Object.freeze([...scopes]),
    refreshIntervalMs,
    cancellable,
    source,
  });
}
