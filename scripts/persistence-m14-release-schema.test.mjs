import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { SessionManifestStore } from "../core/session-manifest/store.ts";
import { FileHistoryStore } from "../lib/file-history/history-store.ts";
import { ResourceCatalogStore } from "../core/resource-catalog-store.ts";
import { FactStore } from "../lib/memory/fact-store.ts";
import { createUsageLedger } from "../lib/llm/usage-ledger.ts";

const Database = createRequire(import.meta.url)("better-sqlite3");
const target = JSON.parse(fs.readFileSync(new URL("./fixtures/hana135-m14-schema.json", import.meta.url), "utf8"));
const factories = {
  "session-manifest-sqlite": dbPath => new SessionManifestStore({ dbPath }),
  "file-history-sqlite": dbPath => new FileHistoryStore({ dbPath }),
  "host-resource-catalog-sqlite": dbPath => new ResourceCatalogStore({ dbPath }),
  "agent-facts-sqlite": dbPath => new FactStore(dbPath),
  "usage-ledger": dbPath => {
    const ledger = createUsageLedger({ databasePath: dbPath });
    ledger.close();
    const db = new Database(dbPath);
    return { db, close: () => db.close() };
  },
};
const ordered = rows => rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
function schema(db, names) {
  return names.map(name => ({
    name,
    columns: ordered(db.pragma("table_info(" + name + ")").map(({ cid: _cid, ...column }) => column)),
    foreignKeys: ordered(db.pragma("foreign_key_list(" + name + ")").map(({ id: _id, ...key }) => key)),
    indexes: ordered(db.pragma("index_list(" + name + ")").map(index => ({
      name: index.origin === "c" ? index.name : null,
      unique: index.unique,
      origin: index.origin,
      partial: index.partial,
      where: index.partial
        ? db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(index.name).sql.match(/WHERE\s+(.+)$/s)?.[1].replace(/\s+/g, " ").trim()
        : null,
      columns: db.pragma("index_xinfo(" + index.name + ")").map(({ cid: _cid, ...column }) => column),
    }))),
  }));
}

for (const store of target.stores) {
  test("runtime schema matches release DDL for " + store.id, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "luc-m14-release-schema-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const reference = new Database(":memory:");
    const actual = factories[store.id](path.join(root, "actual.db"));
    try {
      reference.exec(store.ddl.join("\n"));
      assert.deepEqual(schema(actual.db || actual._db, store.tables), schema(reference, store.tables));
    } finally {
      actual.close();
      reference.close();
    }
  });
}
