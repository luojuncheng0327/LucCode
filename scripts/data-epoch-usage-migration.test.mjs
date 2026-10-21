import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DATA_EPOCH } from "../shared/contract-versions.cjs";
import { readDataEpochStamp, writeDataEpochStamp } from "../shared/data-epoch.cjs";
import { resolveDataEpochMigrationPath } from "../core/data-epoch-migrations.ts";
import { coordinateDataEpochStartup, inspectDataEpochMaintenance } from "../core/data-epoch-coordinator.ts";
import { createDataEpochCheckpointProvider } from "../core/data-epoch-checkpoint-provider.ts";
import { restoreDataEpochCheckpoint } from "../core/data-epoch-restore.ts";
import { createUsageLedger } from "../lib/llm/usage-ledger.ts";

async function fixture(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "luc-epoch-usage-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const bytes = JSON.stringify({ version: 1, entries: [{ requestId: "legacy", startedAt: "2026-10-20T00:00:00Z", endedAt: "2026-10-20T00:00:01Z", status: "usage_missing" }] });
  fs.writeFileSync(path.join(homeDir, "usage-ledger.json"), bytes);
  await writeDataEpochStamp(homeDir, { minimumReaderEpoch: 1, committedDataEpoch: 1, lastVersion: "fixture-epoch-1" });
  return { homeDir, bytes, ownEpoch: 2, ownVersion: "fixture-epoch-2", checkpointProvider: createDataEpochCheckpointProvider(), transitionIdFactory: () => "usage-1-to-2" };
}

test("epoch 2 requires a real production migration and validated legacy data", async (t) => {
  const options = await fixture(t);
  assert.equal(DATA_EPOCH, 2);
  const route = resolveDataEpochMigrationPath(1, 2);
  assert.deepEqual(route.affectedStoreIds, ["usage-ledger"]);
  const result = await coordinateDataEpochStartup(options);
  assert.equal(result.action, "transition-committed", result.detail);
  const ledger = createUsageLedger({ databasePath: path.join(options.homeDir, "usage-ledger.sqlite"), legacyStoragePath: path.join(options.homeDir, "usage-ledger.json") });
  try { assert.deepEqual(ledger.list().entries.map((entry) => entry.requestId), ["legacy"]); } finally { ledger.close(); }
  assert.equal(fs.readFileSync(path.join(options.homeDir, "usage-ledger.json"), "utf8"), options.bytes);
  assert.equal((await coordinateDataEpochStartup(options)).action, "steady");
  assert.equal((await coordinateDataEpochStartup({ ...options, ownEpoch: 1 })).reason, "epoch-downgrade-blocked");
});

test("failure after real migration blocks startup, restores exact old data, and permits retry", async (t) => {
  const options = await fixture(t);
  const failed = await coordinateDataEpochStartup({ ...options, faultHook(event) { if (event === "journal:migrated") throw new Error("injected migration interruption"); } });
  assert.equal(failed.reason, "transition-failed", failed.detail);
  assert.equal(readDataEpochStamp(options.homeDir).stamp.committedDataEpoch, 1);
  assert.equal(inspectDataEpochMaintenance(options.homeDir).status, "incomplete");
  assert.equal((await coordinateDataEpochStartup(options)).reason, "incomplete-transition");
  const restored = await restoreDataEpochCheckpoint({ homeDir: options.homeDir, transitionId: "usage-1-to-2", confirmToken: "restore usage-1-to-2", log: { warn() {} } });
  assert.equal(restored.fromEpoch, 1);
  assert.equal(fs.existsSync(path.join(options.homeDir, "usage-ledger.sqlite")), false);
  assert.equal(fs.readFileSync(path.join(options.homeDir, "usage-ledger.json"), "utf8"), options.bytes);
  assert.equal((await coordinateDataEpochStartup({ ...options, transitionIdFactory: () => "usage-retry" })).action, "transition-committed");
});

test("bad legacy data is rejected before checkpoint or reader barrier writes", async (t) => {
  const options = await fixture(t);
  fs.writeFileSync(path.join(options.homeDir, "usage-ledger.json"), "{broken");
  const stamp = fs.readFileSync(path.join(options.homeDir, "data-epoch.json"));
  const result = await coordinateDataEpochStartup(options);
  assert.equal(result.reason, "transition-preflight-failed", result.detail);
  assert.deepEqual(fs.readFileSync(path.join(options.homeDir, "data-epoch.json")), stamp);
  assert.equal(fs.existsSync(path.join(options.homeDir, "usage-ledger.sqlite")), false);
  assert.equal(fs.existsSync(path.join(options.homeDir, "data-epoch-checkpoints")), false);
});

test("restore quarantines new SQLite sidecars and can resume after copy-back interruption", async (t) => {
  const options = await fixture(t);
  const failed = await coordinateDataEpochStartup({ ...options, faultHook(event) { if (event === "journal:migrated") throw new Error("stop"); } });
  assert.equal(failed.reason, "transition-failed");
  for (const suffix of ["-wal", "-shm"]) fs.writeFileSync(path.join(options.homeDir, `usage-ledger.sqlite${suffix}`), "orphan sidecar");
  const restoreOptions = { homeDir: options.homeDir, transitionId: "usage-1-to-2", confirmToken: "restore usage-1-to-2", log: { warn() {} } };
  await assert.rejects(restoreDataEpochCheckpoint({ ...restoreOptions, faultHook(event) { if (event === "restore:store-copied-back:usage-ledger") throw new Error("restore interruption"); } }), /restore interruption/);
  // A resumed restore must compare hashes, even when a copied-back file has the same size.
  fs.writeFileSync(path.join(options.homeDir, "usage-ledger.json"), options.bytes.replace("legacy", "mutate"));
  const restored = await restoreDataEpochCheckpoint(restoreOptions);
  assert.equal(fs.readFileSync(path.join(options.homeDir, "usage-ledger.json"), "utf8"), options.bytes);
  for (const suffix of ["", "-wal", "-shm"]) {
    assert.equal(fs.existsSync(path.join(options.homeDir, `usage-ledger.sqlite${suffix}`)), false);
    assert.ok(fs.existsSync(path.join(restored.quarantineDir, "usage-ledger", `usage-ledger.sqlite${suffix}`)));
  }
  assert.equal((await coordinateDataEpochStartup({ ...options, transitionIdFactory: () => "after-restore" })).action, "transition-committed");
});
