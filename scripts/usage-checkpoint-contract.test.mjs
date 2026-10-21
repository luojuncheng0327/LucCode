import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { PERSISTENT_STORES } from "../shared/persistence/store-registry.ts";
import { createDataEpochCheckpointProvider } from "../core/data-epoch-checkpoint-provider.ts";
import { restoreDataEpochCheckpoint } from "../core/data-epoch-restore.ts";

function fixture(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "luc-usage-checkpoint-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  return homeDir;
}

test("mixed SQLite and legacy JSON checkpoint uses online backup and exact byte copy", async (t) => {
  const homeDir = fixture(t);
  const descriptor = { ...PERSISTENT_STORES.find(s => s.id === "usage-ledger"), format: "sqlite", pathPatterns: ["usage-ledger.sqlite", "usage-ledger.json"], sqliteDatabasePatterns: ["usage-ledger.sqlite"] };
  const db = new Database(path.join(homeDir, "usage-ledger.sqlite"));
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("wal_autocheckpoint = 0");
    db.exec("CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES ('wal-only');");
    const legacy = Buffer.from('{ "entries": [] }\r\n');
    fs.writeFileSync(path.join(homeDir, "usage-ledger.json"), legacy);
    const provider = createDataEpochCheckpointProvider({ stores: [descriptor] });
    const checkpoint = await provider.create({ homeDir, transitionId: "mixed", fromEpoch: 1, toEpoch: 2, affectedStoreIds: ["usage-ledger"] });
    await provider.verify(checkpoint);
    const captured = path.join(checkpoint.dir, "stores/usage-ledger");
    assert.deepEqual(fs.readFileSync(path.join(captured, "usage-ledger.json")), legacy);
    const backup = new Database(path.join(captured, "usage-ledger.sqlite"), { readonly: true });
    try { assert.equal(backup.prepare("SELECT value FROM probe").get().value, "wal-only"); } finally { backup.close(); }
  } finally { db.close(); }
});

test("restore replaces same-size different bytes instead of becoming permanently stuck", async (t) => {
  const homeDir = fixture(t);
  const descriptor = { ...PERSISTENT_STORES.find(s => s.id === "usage-ledger"), format: "json", pathPatterns: ["usage-ledger.json"] };
  const target = path.join(homeDir, "usage-ledger.json");
  fs.writeFileSync(target, "old-data");
  const provider = createDataEpochCheckpointProvider({ stores: [descriptor] });
  await provider.create({ homeDir, transitionId: "same-size", fromEpoch: 1, toEpoch: 2, affectedStoreIds: [descriptor.id] });
  fs.writeFileSync(target, "new-data");
  const restored = await restoreDataEpochCheckpoint({ homeDir, transitionId: "same-size", confirmToken: "restore same-size", stores: [descriptor], log: { warn() {} } });
  assert.equal(fs.readFileSync(target, "utf8"), "old-data");
  assert.equal(fs.readFileSync(path.join(restored.quarantineDir, descriptor.id, "usage-ledger.json"), "utf8"), "new-data");
});
