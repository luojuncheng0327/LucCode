/**
 * `luc data diagnose` / `luc data checkpoints` / `luc data restore` —
 * the self-hosted operator's read-only diagnostics and confirmed recovery
 * entry points for the data-epoch safety chain
 * (core/data-epoch-coordinator.ts, core/data-epoch-restore.ts). This layer
 * only owns argument handling, terminal output, and confirmation — every
 * actual read of the stamp/journal goes through shared/data-epoch.cjs's
 * own API, every maintenance read goes through
 * core/data-epoch-coordinator.ts#inspectDataEpochMaintenance, and the only
 * path that ever moves store bytes is
 * core/data-epoch-restore.ts#restoreDataEpochCheckpoint. Checkpoint
 * listing here reads each metadata.json's own declared fields directly —
 * it never re-verifies item bytes/hashes; that reconciliation is the
 * checkpoint provider's verify() contract, which restoreDataEpochCheckpoint
 * already calls before this CLI's `restore` subcommand is allowed to touch
 * any store bytes.
 */

import fs from "fs";
import path from "path";
import readline from "readline";
import { resolveCliLucHome } from "./local-server.ts";
import { ansi } from "./terminal-theme.ts";
import { inspectDataEpochMaintenance } from "../core/data-epoch-coordinator.ts";
import { restoreDataEpochCheckpoint } from "../core/data-epoch-restore.ts";
import { DATA_EPOCH_CHECKPOINTS_DIRNAME } from "../core/data-epoch-checkpoint-provider.ts";
import type { DataEpochCheckpointMetadata } from "../core/data-epoch-checkpoint-provider.ts";
import {
  readDataEpochStamp,
  readDataEpochJournal,
  readDataEpochRestoreJournal,
} from "../shared/data-epoch.cjs";
import { DATA_EPOCH } from "../shared/contract-versions.cjs";

interface CheckpointSummary {
  transitionId: string;
  fromEpoch: number;
  toEpoch: number;
  createdAt: string;
  storeCount: number;
  totalBytes: number;
}

function checkpointsRootFor(lucHome: string): string {
  return path.join(lucHome, DATA_EPOCH_CHECKPOINTS_DIRNAME);
}

/**
 * Lists every published, complete checkpoint under
 * {lucHome}/data-epoch-checkpoints. `.tmp-*` staging and `.invalid-*`
 * quarantine siblings are provider-internal and are never a usable
 * checkpoint (see core/data-epoch-checkpoint-provider.ts's own retention
 * pass) — they are counted but not listed.
 */
function listDataEpochCheckpoints(lucHome: string): { checkpoints: CheckpointSummary[]; skipped: number } {
  const root = checkpointsRootFor(lucHome);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === "ENOENT") return { checkpoints: [], skipped: 0 };
    throw error;
  }

  const checkpoints: CheckpointSummary[] = [];
  let skipped = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.includes(".tmp-") || entry.name.includes(".invalid-")) {
      skipped += 1;
      continue;
    }
    try {
      const raw = fs.readFileSync(path.join(root, entry.name, "metadata.json"), "utf-8");
      const metadata = JSON.parse(raw) as Partial<DataEpochCheckpointMetadata>;
      if (!metadata || metadata.complete !== true || !Array.isArray(metadata.items)) {
        skipped += 1;
        continue;
      }
      const storeIds = new Set(metadata.items.map((item) => item.storeId));
      const totalBytes = metadata.items.reduce((sum, item) => sum + (item.bytes || 0), 0);
      checkpoints.push({
        transitionId: String(metadata.transitionId ?? entry.name),
        fromEpoch: Number(metadata.fromEpoch),
        toEpoch: Number(metadata.toEpoch),
        createdAt: String(metadata.createdAt ?? "unknown"),
        storeCount: storeIds.size,
        totalBytes,
      });
    } catch {
      // Unparsable/partial metadata.json: not a usable checkpoint, not a
      // hard error (a half-written directory looks exactly like this).
      skipped += 1;
    }
  }
  checkpoints.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return { checkpoints, skipped };
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * `luc data diagnose [--url ...]` — read-only. Never writes to disk:
 * every call below (readDataEpochStamp, readDataEpochJournal,
 * readDataEpochRestoreJournal, inspectDataEpochMaintenance,
 * listDataEpochCheckpoints) only reads.
 */
export async function runDataDiagnose({ lucHome = resolveCliLucHome() }: { lucHome?: string } = {}): Promise<number> {
  console.log(`Data-epoch diagnostics ${ansi.dim}(${lucHome})${ansi.reset}`);
  console.log(`  Kernel DATA_EPOCH    ${DATA_EPOCH}`);

  const stampRead = readDataEpochStamp(lucHome);
  if (stampRead.status === "ok") {
    const stamp = stampRead.stamp;
    console.log(`  Stamp                minimumReaderEpoch=${stamp.minimumReaderEpoch} committedDataEpoch=${stamp.committedDataEpoch}`);
    console.log(`  Last written by      ${stamp.lastVersion ?? "unknown"} at ${stamp.updatedAt ?? "unknown"}`);
  } else if (stampRead.status === "missing") {
    console.log(`  Stamp                ${ansi.dim}none (unstamped home)${ansi.reset}`);
  } else {
    console.log(`  Stamp                ${ansi.red}corrupt: ${stampRead.detail}${ansi.reset}`);
  }

  // Both readers target the same on-disk path but recognize distinct
  // journal shapes (forward transition vs. in-progress restore) — see
  // shared/data-epoch.cjs's readDataEpochRestoreJournal doc comment. A
  // file that parses as neither is genuinely corrupt.
  const forwardJournal = readDataEpochJournal(lucHome);
  const restoreJournal = readDataEpochRestoreJournal(lucHome);
  if (forwardJournal.status === "ok") {
    const j = forwardJournal.journal;
    console.log(`  Transition journal   ${j.transitionId} phase=${j.phase} ${j.fromEpoch}→${j.toEpoch}`);
  } else if (restoreJournal.status === "ok") {
    const j = restoreJournal.journal;
    console.log(`  Restore journal      ${j.restoreId} (transitionId=${j.transitionId}) phase=${j.phase} fromEpoch=${j.fromEpoch}`);
  } else if (forwardJournal.status === "missing") {
    console.log(`  Journal              ${ansi.dim}none${ansi.reset}`);
  } else {
    console.log(`  Journal              ${ansi.red}corrupt: ${forwardJournal.detail}${ansi.reset}`);
  }

  const maintenance = inspectDataEpochMaintenance(lucHome);
  if (maintenance.status === "none") {
    console.log(`  Maintenance          ${ansi.green}steady, no transition in progress${ansi.reset}`);
  } else if (maintenance.status === "corrupt") {
    console.log(`  Maintenance          ${ansi.red}corrupt (${maintenance.reason}): ${maintenance.detail}${ansi.reset}`);
  } else {
    console.log(`  Maintenance          ${ansi.yellow}incomplete transition ${maintenance.transitionId} (${maintenance.fromEpoch}→${maintenance.toEpoch}), phase=${maintenance.phase}${ansi.reset}`);
    console.log(`  Continuation         ${maintenance.continuation}`);
    console.log(`  Affected stores      ${maintenance.affectedStoreIds.join(", ") || "none"}`);
  }

  const { checkpoints, skipped } = listDataEpochCheckpoints(lucHome);
  const skippedNote = skipped ? ` (${skipped} incomplete/invalid, not listed)` : "";
  if (checkpoints.length === 0) {
    console.log(`  Checkpoints          ${ansi.dim}none available${ansi.reset}${skippedNote}`);
  } else {
    console.log(`  Checkpoints          ${checkpoints.length} available${skippedNote} — run \`luc data checkpoints\` for details`);
  }

  return 0;
}

/**
 * `luc data checkpoints` — lists every available recovery checkpoint.
 */
export async function runDataCheckpoints({ lucHome = resolveCliLucHome() }: { lucHome?: string } = {}): Promise<number> {
  const { checkpoints, skipped } = listDataEpochCheckpoints(lucHome);
  if (checkpoints.length === 0) {
    console.log(`${ansi.dim}No data-epoch checkpoints available.${ansi.reset}`);
    if (skipped) console.log(`${ansi.dim}(${skipped} incomplete/invalid checkpoint director${skipped === 1 ? "y" : "ies"} found and skipped.)${ansi.reset}`);
    return 0;
  }

  console.log(`Data-epoch checkpoints ${ansi.dim}(${lucHome})${ansi.reset}`);
  for (const checkpoint of checkpoints) {
    console.log("");
    console.log(`  ${ansi.bold}${checkpoint.transitionId}${ansi.reset}`);
    console.log(`    ${ansi.dim}Epoch${ansi.reset}    ${checkpoint.fromEpoch} → ${checkpoint.toEpoch}`);
    console.log(`    ${ansi.dim}Created${ansi.reset}  ${checkpoint.createdAt}`);
    console.log(`    ${ansi.dim}Stores${ansi.reset}   ${checkpoint.storeCount}`);
    console.log(`    ${ansi.dim}Size${ansi.reset}     ${formatBytes(checkpoint.totalBytes)}`);
  }
  if (skipped) {
    console.log("");
    console.log(`${ansi.dim}(${skipped} incomplete/invalid checkpoint director${skipped === 1 ? "y" : "ies"} found and skipped.)${ansi.reset}`);
  }
  return 0;
}

function defaultPromptConfirmation(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * `luc data restore <transitionId> [--confirm-token "restore <transitionId>"]`
 *
 * Confirmation is never skippable: a TTY must retype the exact phrase
 * `restore <transitionId>`; a non-TTY (script/automation) must pass that
 * exact phrase via --confirm-token. There is deliberately no flag that
 * bypasses this — restoreDataEpochCheckpoint() itself re-checks the same
 * phrase before touching any store bytes, so this is defense in depth, not
 * the only gate.
 */
export async function runDataRestore({
  transitionId,
  confirmToken = null,
  lucHome = resolveCliLucHome(),
  restore = restoreDataEpochCheckpoint,
  isTTY = process.stdin.isTTY === true,
  promptConfirmation = defaultPromptConfirmation,
}: {
  transitionId: string | null;
  confirmToken?: string | null;
  lucHome?: string;
  restore?: typeof restoreDataEpochCheckpoint;
  isTTY?: boolean;
  promptConfirmation?: (question: string) => Promise<string>;
}): Promise<number> {
  if (!transitionId) {
    console.error(`${ansi.red}data restore requires a transitionId: luc data restore <transitionId>${ansi.reset}`);
    return 1;
  }

  const checkpointDir = path.join(checkpointsRootFor(lucHome), transitionId);
  let metadata: Partial<DataEpochCheckpointMetadata>;
  try {
    metadata = JSON.parse(fs.readFileSync(path.join(checkpointDir, "metadata.json"), "utf-8"));
  } catch {
    console.error(`${ansi.red}No checkpoint found for transitionId "${transitionId}" in ${checkpointsRootFor(lucHome)}.${ansi.reset}`);
    console.error(`${ansi.dim}Run \`luc data checkpoints\` to see what is available.${ansi.reset}`);
    return 1;
  }

  const totalBytes = Array.isArray(metadata.items)
    ? metadata.items.reduce((sum, item) => sum + (item.bytes || 0), 0)
    : 0;

  console.log(`About to restore checkpoint ${ansi.bold}${transitionId}${ansi.reset}`);
  console.log(`  Epoch    ${metadata.fromEpoch ?? "unknown"} → ${metadata.toEpoch ?? "unknown"}`);
  console.log(`  Created  ${metadata.createdAt ?? "unknown"}`);
  console.log(`  Size     ${formatBytes(totalBytes)}`);
  console.log("");
  console.log(`${ansi.red}WARNING: this discards any changes made after this checkpoint's upgrade.${ansi.reset}`);
  console.log(`${ansi.red}Pre-restore data is moved into a quarantine directory, never deleted — it can still be recovered by hand afterward.${ansi.reset}`);
  console.log("");

  const expectedToken = `restore ${transitionId}`;
  let token = confirmToken;

  if (token === null) {
    if (!isTTY) {
      console.error(`${ansi.red}Refusing to restore without confirmation: stdin is not a TTY.${ansi.reset}`);
      console.error(`${ansi.dim}Pass --confirm-token "${expectedToken}" to confirm non-interactively. There is no flag that skips this.${ansi.reset}`);
      return 1;
    }
    token = await promptConfirmation(`Type "${expectedToken}" to confirm: `);
  }

  if (token !== expectedToken) {
    console.error(`${ansi.red}Confirmation did not match "${expectedToken}". Aborting; nothing was changed.${ansi.reset}`);
    return 1;
  }

  try {
    const result = await restore({
      homeDir: lucHome,
      transitionId,
      confirmToken: token,
      log: { warn: (msg: string) => console.error(`${ansi.dim}${msg}${ansi.reset}`) },
    });
    console.log(`${ansi.green}Restore complete.${ansi.reset}`);
    console.log(`  Receipt      ${result.receiptPath}`);
    console.log(`  Quarantine   ${result.quarantineDir}`);
    console.log("");
    console.log(`Reopen this data directory with the older kernel (epoch ${result.fromEpoch}) to continue.`);
    return 0;
  } catch (error: any) {
    console.error(`${ansi.red}Restore failed: ${error?.message ?? String(error)}${ansi.reset}`);
    return 1;
  }
}
