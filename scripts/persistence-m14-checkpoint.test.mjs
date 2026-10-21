import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { SessionManifestStore } from "../core/session-manifest/store.ts";
import { FileHistoryStore } from "../lib/file-history/history-store.ts";
import { createResourceCatalogStore } from "../core/resource-catalog-store.ts";
import { PERSISTENT_STORES } from "../shared/persistence/store-registry.ts";
import { createDataEpochCheckpointProvider } from "../core/data-epoch-checkpoint-provider.ts";
import { restoreDataEpochCheckpoint } from "../core/data-epoch-restore.ts";

test("M1.4 SQLite stores checkpoint committed WAL data and restore through registered paths", async (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "luc-m14-checkpoint-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const entries = [
    { id: "session-manifest-sqlite", relative: "session-manifest.db",
      open: () => new SessionManifestStore({ dbPath: path.join(homeDir, "session-manifest.db") }),
      query: "SELECT payload_json AS value FROM env_events",
      seed: "INSERT INTO env_events(type,scope_kind,scope_agent_id,payload_json,at) VALUES('changed','agent','a','{\"original\":true}','2026-01-01')" },
    { id: "file-history-sqlite", relative: "file-history/fixture/history.sqlite",
      open: () => new FileHistoryStore({ dbPath: path.join(homeDir, "file-history/fixture/history.sqlite") }),
      query: "SELECT stat_size AS value FROM files",
      seed: "INSERT INTO files(rel_path,stat_size,stat_mtime_ms) VALUES('fixture.txt',123,456)" },
    { id: "host-resource-catalog-sqlite", relative: "workspace-state/resources.sqlite",
      open: () => createResourceCatalogStore({ lucHome: homeDir }),
      query: "SELECT resource_id AS value FROM local_resources",
      seed: "INSERT INTO local_resources(resource_id,normalized_path,real_path,locator_key,file_kind,status,created_at,updated_at) VALUES('res-1','fixture','fixture','key','file','available',1,1)" },
  ];
  const opened = entries.map(entry => ({ ...entry, owner: entry.open() }));
  try {
    for (const entry of opened) {
      const db = entry.owner.db || entry.owner._db;
      db.pragma("wal_autocheckpoint = 0");
      db.exec(entry.seed);
      entry.expected = db.prepare(entry.query).get().value;
      assert.ok(fs.statSync(path.join(homeDir, entry.relative) + "-wal").size > 0);
    }
    const stores = entries.map(entry => PERSISTENT_STORES.find(store => store.id === entry.id));
    const provider = createDataEpochCheckpointProvider({ stores });
    // Exercise checkpoint/restore primitives; this is not another production epoch edge.
    const checkpoint = await provider.create({
      homeDir, transitionId: "m14-fixture", fromEpoch: 1, toEpoch: 2,
      affectedStoreIds: entries.map(entry => entry.id),
    });
    await provider.verify(checkpoint);
    for (const entry of opened) {
      const backup = new Database(path.join(checkpoint.dir, "stores", entry.id, entry.relative), { readonly: true });
      try {
        assert.equal(backup.prepare(entry.query).get().value, entry.expected);
        assert.equal(backup.pragma("integrity_check", { simple: true }), "ok");
      } finally { backup.close(); }
      entry.owner.close();
      // All mutations are confined to the fresh test directory.
      const mutation = new Database(path.join(homeDir, entry.relative));
      mutation.exec("CREATE TABLE after_checkpoint(value TEXT)");
      mutation.close();
      fs.writeFileSync(path.join(homeDir, entry.relative) + "-wal", "orphan WAL");
      fs.writeFileSync(path.join(homeDir, entry.relative) + "-shm", "orphan SHM");
    }
    const restored = await restoreDataEpochCheckpoint({
      homeDir, transitionId: "m14-fixture", confirmToken: "restore m14-fixture", stores, log: { warn() {} },
    });
    for (const entry of opened) {
      for (const suffix of ["-wal", "-shm"]) {
        assert.equal(fs.existsSync(path.join(homeDir, entry.relative) + suffix), false);
        assert.equal(fs.existsSync(path.join(restored.quarantineDir, entry.id, entry.relative) + suffix), true);
      }
      const reopened = entry.open();
      try {
        const db = reopened.db || reopened._db;
        assert.equal(db.prepare(entry.query).get().value, entry.expected);
        assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='after_checkpoint'").get(), undefined);
        assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
      } finally { reopened.close(); }
    }
  } finally {
    for (const entry of opened) {
      const db = entry.owner.db || entry.owner._db;
      if (db?.open) entry.owner.close();
    }
  }
});
