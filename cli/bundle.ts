/**
 * `luc bundle pull` / `luc bundle status` — the self-hosted form's manual
 * web-frontend updater. `pull` drives the exact same shared OTA water pipe
 * the desktop hot-update uses (signature verification, dual-source race,
 * channel assertion, train monotonicity, version-never-goes-backward,
 * serverProtocol contract gate — all inside
 * `shared/artifact-core/ota-core.cjs#downloadAndApplyRendererArtifact`),
 * renderer kind only: the server binary is the operator's own to manage
 * and is never touched from here. A pull happens ONLY when the operator
 * types the command — no timers, no daemons — and the CLI never passes a
 * devBypass, so the core's "no override, ever" default applies.
 */

import { createRequire } from "module";
import { resolveCliLucHome } from "./local-server.ts";
import { ansi } from "./terminal-theme.ts";
import { SERVER_PROTOCOL_VERSION } from "../shared/contract-versions.cjs";

const require = createRequire(import.meta.url);
// Untyped CommonJS artifact-core modules (no declaration files) are
// required, not ESM-imported, so typecheck doesn't demand .d.cts for them
// — same pattern the test suite uses.
const otaCore = require("../shared/artifact-core/ota-core.cjs");
const pointerStore = require("../shared/artifact-core/pointer-store.cjs");
const { rendererPointerChannel } = require("../shared/artifact-core/pointer-channels.cjs");
const { loadPinnedKeyset } = require("../shared/artifact-core/keyset.cjs");

type PullProgressEvent = {
  phase: "downloading" | "verifying" | "activating";
  kind: "renderer";
  receivedBytes: number;
  totalBytes: number;
};

type PullResult =
  | { ok: false; error: string }
  | { ok: true; version: string; train?: number; alreadyCurrent?: boolean };

type DownloadRendererArtifact = (opts: {
  homeDir: string;
  keyset: Array<{ keyId: string; publicKey: string }>;
  channel: string;
  serverProtocolVersion: number;
  onProgress: (event: PullProgressEvent) => void;
  log: (msg: string) => void;
}) => Promise<PullResult>;

/**
 * Single-line overwrite progress on a TTY (`\r` + phase + percent); on a
 * non-TTY stream (piped/CI) it prints one plain line per phase change
 * instead, so logs stay readable without control characters.
 */
function createProgressRenderer(stream: NodeJS.WriteStream = process.stdout) {
  const isTty = Boolean(stream.isTTY);
  let lastPhase = "";
  let rendered = false;
  const render = (event: PullProgressEvent) => {
    if (isTty) {
      const pct = event.totalBytes > 0
        ? Math.min(100, Math.floor((event.receivedBytes / event.totalBytes) * 100))
        : 0;
      stream.write(`\r\x1b[2K${ansi.dim}${event.phase} renderer${ansi.reset} ${pct}%`);
      rendered = true;
    } else if (event.phase !== lastPhase) {
      stream.write(`${event.phase} renderer...\n`);
    }
    lastPhase = event.phase;
  };
  const finish = () => {
    if (isTty && rendered) stream.write("\r\x1b[2K");
  };
  return { render, finish };
}

/**
 * `luc bundle pull [--channel <c>]`. Returns the process exit code.
 * `download` is injectable for tests only — the network pipeline itself is
 * covered by the artifact-ota core tests, this layer only owns argument
 * passing and output.
 */
export async function runBundlePull({
  channel = "stable",
  lucHome = resolveCliLucHome(),
  download = otaCore.downloadAndApplyRendererArtifact as DownloadRendererArtifact,
}: {
  channel?: string;
  lucHome?: string;
  download?: DownloadRendererArtifact;
} = {}): Promise<number> {
  const progress = createProgressRenderer();
  const result = await download({
    homeDir: lucHome,
    keyset: loadPinnedKeyset(),
    channel,
    serverProtocolVersion: SERVER_PROTOCOL_VERSION,
    onProgress: progress.render,
    // Pipeline diagnostics (mirror failover, gate logs) go to stderr so
    // they never corrupt the stdout progress line.
    log: (msg: string) => console.error(`${ansi.dim}${msg}${ansi.reset}`),
  });
  progress.finish();

  if (result.ok === false) {
    console.error(`${ansi.red}${result.error}${ansi.reset}`);
    return 1;
  }
  if (result.alreadyCurrent) {
    console.log(`Web frontend is already up to date (${result.version}).`);
    return 0;
  }
  console.log(`${ansi.green}Pulled and activated ${result.version}.${ansi.reset} Restart luc serve to take effect.`);
  return 0;
}

/**
 * `luc bundle status [--channel <c>]`. Pure local read — renderer
 * pointers + ota-state, no network. Returns the process exit code.
 */
export async function runBundleStatus({
  channel = "stable",
  lucHome = resolveCliLucHome(),
}: {
  channel?: string;
  lucHome?: string;
} = {}): Promise<number> {
  const rendererChannel = rendererPointerChannel(channel);
  const [current, next, otaState] = await Promise.all([
    pointerStore.readPointer(lucHome, rendererChannel, "current"),
    pointerStore.readPointer(lucHome, rendererChannel, "next"),
    otaCore.readOtaState(lucHome),
  ]);
  const state = (otaState && otaState[channel]) || {};

  if (!current) {
    console.log(`${ansi.dim}No web frontend has been pulled yet. Run:${ansi.reset} luc bundle pull`);
    return 0;
  }

  console.log(`Web frontend ${ansi.dim}(${channel})${ansi.reset}`);
  console.log(`  ${ansi.dim}Version${ansi.reset}   ${current.version || "unknown"}`);
  console.log(`  ${ansi.dim}Train${ansi.reset}     ${Number.isInteger(current.train) ? current.train : "unknown"}`);
  console.log(`  ${ansi.dim}Checked${ansi.reset}   ${typeof state.lastCheckedAt === "string" ? state.lastCheckedAt : "never"}`);
  if (state.available && typeof state.available === "object") {
    const trainSuffix = Number.isInteger(state.available.train) ? ` (train ${state.available.train})` : "";
    console.log(`  ${ansi.dim}Available${ansi.reset} ${state.available.version}${trainSuffix}`);
  }
  if (next) {
    console.log(`  ${ansi.dim}Staged${ansi.reset}    ${next.version || "unknown"} (not yet active)`);
  }
  if (typeof state.lastError === "string" && state.lastError) {
    console.log(`  ${ansi.dim}Last err${ansi.reset}  ${ansi.red}${state.lastError}${ansi.reset}`);
  }
  return 0;
}
