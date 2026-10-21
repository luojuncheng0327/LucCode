import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import * as owner from "../core/resource-catalog-store.ts";
import { PERSISTENT_STORES } from "../shared/persistence/store-registry.ts";
import { discoverSites, PRODUCTION_ROOTS } from "./scan-persistent-stores.mjs";

const Database = createRequire(import.meta.url)("better-sqlite3");
const columns = [
  ["resource_id", "TEXT"], ["normalized_path", "TEXT"], ["real_path", "TEXT"],
  ["locator_key", "TEXT"], ["file_kind", "TEXT"], ["status", "TEXT"],
  ["size", "INTEGER"], ["mtime_ms", "REAL"], ["fingerprint_dev", "TEXT"],
  ["fingerprint_ino", "TEXT"], ["fingerprint_birthtime_ms", "REAL"],
  ["fingerprint_key", "TEXT"], ["created_at", "INTEGER"], ["updated_at", "INTEGER"],
  ["missing_at", "INTEGER"],
];
const indexes = {
  idx_local_resources_fingerprint: ["fingerprint_key"],
  idx_local_resources_normalized_path: ["normalized_path"],
  idx_local_resources_real_path: ["real_path"],
  idx_local_resources_status: ["status", "updated_at"],
};
function dbPath(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "luc-m14-resource-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "workspace-state", "resources.sqlite");
}
function open(location, extra = {}) {
  assert.equal(typeof owner.ResourceCatalogStore, "function", "resource owner is still a scaffold");
  return new owner.ResourceCatalogStore({ dbPath: location, ...extra });
}
function insert(db, overrides = {}) {
  db.prepare("INSERT INTO local_resources(resource_id, normalized_path, real_path, locator_key, file_kind, status, created_at, updated_at) VALUES(@id, @path, @path, @key, @kind, @status, 100, 100)")
    .run({ id: "res-1", path: "fixture/path.txt", key: "fixture-key", kind: "file", status: "available", ...overrides });
}

test("resource owner creates the release table, constraints and four indexes", (t) => {
  const store = open(dbPath(t));
  try {
    assert.equal(store.db.pragma("user_version", { simple: true }), 1);
    assert.deepEqual(store.db.pragma("table_info(local_resources)").map(c => [c.name, c.type]), columns);
    for (const [name, fields] of Object.entries(indexes)) {
      assert.deepEqual(store.db.pragma("index_info(" + name + ")").map(c => c.name), fields);
    }
    const fingerprint = store.db.pragma("index_list(local_resources)").find(i => i.name === "idx_local_resources_fingerprint");
    assert.equal(fingerprint.partial, 1);
    insert(store.db);
    assert.throws(() => insert(store.db, { id: "res-2" }), /UNIQUE/);
    assert.throws(() => insert(store.db, { id: "res-2", key: "key2", kind: "symlink" }), /CHECK/);
    assert.throws(() => insert(store.db, { id: "res-2", key: "key2", status: "invalid" }), /CHECK/);
    assert.throws(() => insert(store.db, { id: "res-2", key: "key2", path: null }), /NOT NULL/);
    insert(store.db, { id: "res-2", key: "key2", kind: "directory", status: "missing" });
    const plan = store.db.prepare("EXPLAIN QUERY PLAN SELECT * FROM local_resources WHERE status = ? ORDER BY updated_at").all("available");
    assert.ok(plan.some(row => row.detail.includes("idx_local_resources_status")));
  } finally { store.close(); }
});

test("resource schema reopens durably and repairs older v1 lookup indexes", (t) => {
  const location = dbPath(t);
  let store = open(location);
  try {
    insert(store.db);
    store.db.exec("DROP INDEX idx_local_resources_normalized_path; DROP INDEX idx_local_resources_real_path;");
    store.close();
    store.close();
    store = open(location);
    assert.equal(store.db.prepare("SELECT resource_id FROM local_resources").get().resource_id, "res-1");
    for (const [name, fields] of Object.entries(indexes)) {
      assert.deepEqual(store.db.pragma("index_info(" + name + ")").map(c => c.name), fields);
    }
  } finally { store.close(); }
});

test("resource schema rejects future or damaged databases without inventing replacements", (t) => {
  const location = dbPath(t);
  fs.mkdirSync(path.dirname(location), { recursive: true });
  let db = new Database(location);
  db.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('keep')");
  db.pragma("user_version = 2");
  db.close();
  assert.throws(() => open(location), /newer than supported/);
  db = new Database(location);
  try {
    assert.equal(db.prepare("SELECT value FROM sentinel").get().value, "keep");
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='local_resources'").get(), undefined);
    db.pragma("user_version = 1");
  } finally { db.close(); }
  assert.throws(() => open(location), /schema is invalid/);
  db = new Database(location);
  try {
    assert.equal(db.prepare("SELECT value FROM sentinel").get().value, "keep");
    assert.equal(db.pragma("user_version", { simple: true }), 1);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='local_resources'").get(), undefined);
  } finally { db.close(); }
});

test("resource initialization rolls back on index failure and releases the failed connection", (t) => {
  const location = dbPath(t);
  let failedDb;
  const original = Database.prototype.exec;
  const injected = t.mock.method(Database.prototype, "exec", function(sql) {
    if (sql.includes("CREATE INDEX") && sql.includes("idx_local_resources_fingerprint")) {
      failedDb = this;
      throw new Error("injected catalog index failure");
    }
    return original.call(this, sql);
  });
  assert.throws(() => open(location), /injected catalog index failure/);
  injected.mock.restore();
  assert.equal(failedDb.open, false);
  const probe = new Database(location);
  try {
    assert.equal(probe.pragma("user_version", { simple: true }), 0);
    assert.equal(probe.prepare("SELECT name FROM sqlite_master WHERE name='local_resources'").get(), undefined);
  } finally { probe.close(); }
  const store = open(location);
  store.close();
});

test("resource owner has explicit persistence registration and detectable constructors", (t) => {
  const descriptor = PERSISTENT_STORES.find(store => store.id === "host-resource-catalog-sqlite");
  assert.ok(descriptor, "real resource schema must be registered");
  assert.equal(descriptor.ownerModule, "core/resource-catalog-store.ts");
  assert.equal(descriptor.schemaSource.kind, "sqlite-runtime");
  assert.equal(descriptor.format, "sqlite");
  assert.deepEqual(descriptor.pathPatterns, [
    "workspace-state/resources.sqlite", "workspace-state/resources.sqlite-wal", "workspace-state/resources.sqlite-shm",
  ]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "luc-m14-resource-scan-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of PRODUCTION_ROOTS) fs.mkdirSync(path.join(root, dir));
  fs.writeFileSync(path.join(root, "core/fixture.ts"), 'new ResourceCatalogStore({ dbPath: "fixture.sqlite" });');
  const sites = discoverSites(root);
  assert.equal(sites.length, 1);
  assert.equal(sites[0].kind, "persistent-store-constructor");
});
