import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { FileHistoryStore } from "../lib/file-history/history-store.ts";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

function tempDatabase(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "luc-m14-file-history-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "history.sqlite");
}

function createVersionOneDatabase(dbPath) {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.exec([
    "CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    "INSERT INTO meta(key, value) VALUES('schema_version', '1');",
    "CREATE TABLE files(",
    "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
    "  rel_path TEXT NOT NULL UNIQUE,",
    "  deleted_at INTEGER",
    ");",
    "CREATE TABLE snapshots(",
    "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
    "  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,",
    "  content_hash TEXT NOT NULL,",
    "  content BLOB NOT NULL,",
    "  raw_size INTEGER NOT NULL,",
    "  stored_size INTEGER NOT NULL,",
    "  captured_at INTEGER NOT NULL,",
    "  origin TEXT NOT NULL,",
    "  op_context TEXT",
    ");",
    "CREATE INDEX idx_snapshots_file_time ON snapshots(file_id, captured_at DESC);",
    "CREATE INDEX idx_snapshots_time ON snapshots(captured_at);",
    "INSERT INTO files(rel_path) VALUES('legacy.txt');",
  ].join("\n"));
  const content = Buffer.from("legacy snapshot bytes");
  const zipped = gzipSync(content);
  db.prepare("INSERT INTO snapshots(file_id, content_hash, content, raw_size, stored_size, captured_at, origin) VALUES(1, 'legacy-hash', ?, ?, ?, 1000, 'event')")
    .run(zipped, content.length, zipped.length);
  db.pragma("user_version = 0");
  db.close();
}

function fileColumns(db) {
  return new Map(db.pragma("table_info(files)").map((column) => [column.name, column]));
}

function assertStatSignatureColumns(db) {
  const columns = fileColumns(db);
  assert.equal(columns.get("stat_size")?.type, "INTEGER");
  assert.equal(columns.get("stat_mtime_ms")?.type, "REAL");
  assert.equal(columns.get("stat_size")?.notnull, 0);
  assert.equal(columns.get("stat_mtime_ms")?.notnull, 0);
}

test("M1.4 adds nullable stat signatures to existing file-history databases", (t) => {
  const dbPath = tempDatabase(t);
  createVersionOneDatabase(dbPath);
  let store;
  try {
    store = new FileHistoryStore({ dbPath });
    const version = store._db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    assert.equal(Number(version.value), 1, "compatible additive migration keeps existing readers supported");
    assertStatSignatureColumns(store._db);
    assert.equal(store._db.prepare("SELECT rel_path FROM files").get().rel_path, "legacy.txt");
    assert.equal(store.getSnapshotContent(1).content.toString(), "legacy snapshot bytes");
    assert.equal(store.getStatSignature("legacy.txt"), null);
    store.setStatSignatures([{ relPath: "legacy.txt", size: 4096, mtimeMs: 1234.5 }]);
    assert.deepEqual(store.getStatSignature("legacy.txt"), { size: 4096, mtimeMs: 1234.5 });
    store.close();
    store = new FileHistoryStore({ dbPath });
    assert.deepEqual(store.getStatSignature("legacy.txt"), { size: 4096, mtimeMs: 1234.5 });
    assert.equal(store.getSnapshotContent(1).content.toString(), "legacy snapshot bytes");
  } finally {
    store?.close();
  }
});

test("M1.4 creates stat signature columns in new file-history databases", (t) => {
  const dbPath = tempDatabase(t);
  let store;
  try {
    store = new FileHistoryStore({ dbPath });
    const version = store._db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    assert.equal(Number(version.value), 1);
    assertStatSignatureColumns(store._db);
  } finally {
    store?.close();
  }
});

test("file-history migration rolls back both added columns, closes and retries after DDL failure", (t) => {
  const dbPath = tempDatabase(t);
  createVersionOneDatabase(dbPath);
  const original = Database.prototype.exec;
  let failedDatabase;
  const injected = t.mock.method(Database.prototype, "exec", function(sql) {
    if (sql.includes("ALTER TABLE files ADD COLUMN stat_mtime_ms")) {
      failedDatabase = this;
      throw new Error("injected stat migration failure");
    }
    return original.call(this, sql);
  });
  assert.throws(() => new FileHistoryStore({ dbPath }), /injected stat migration failure/);
  injected.mock.restore();
  assert.equal(failedDatabase.open, false, "failed constructor closes its database");
  const probe = new Database(dbPath);
  try {
    assert.equal(fileColumns(probe).has("stat_size"), false, "first ALTER must roll back");
    assert.equal(fileColumns(probe).has("stat_mtime_ms"), false);
    assert.equal(probe.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, "1");
  } finally {
    probe.close();
  }
  const store = new FileHistoryStore({ dbPath });
  try {
    assertStatSignatureColumns(store._db);
    assert.equal(store.getSnapshotContent(1).content.toString(), "legacy snapshot bytes");
  } finally {
    store.close();
  }
});

test("file-history refuses a future version before modifying schema", (t) => {
  const dbPath = tempDatabase(t);
  const db = new Database(dbPath);
  db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES('schema_version', '999')");
  db.close();
  assert.throws(() => new FileHistoryStore({ dbPath }), /newer than supported/);
  const probe = new Database(dbPath);
  try {
    assert.deepEqual(probe.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(), [{ name: "meta" }]);
  } finally {
    probe.close();
  }
});

test("file-history stat batches are transactional", (t) => {
  const dbPath = tempDatabase(t);
  const store = new FileHistoryStore({ dbPath });
  try {
    store.recordSnapshot({ relPath: "a.txt", content: Buffer.from("a"), origin: "event" });
    store.recordSnapshot({ relPath: "b.txt", content: Buffer.from("b"), origin: "event" });
    store._db.exec("CREATE TRIGGER fail_stat BEFORE UPDATE OF stat_size ON files WHEN NEW.rel_path = 'b.txt' BEGIN SELECT RAISE(ABORT, 'stat failure'); END");
    assert.throws(() => store.setStatSignatures([
      { relPath: "a.txt", size: 1, mtimeMs: 10 },
      { relPath: "b.txt", size: 1, mtimeMs: 20 },
    ]), /stat failure/);
    assert.equal(store.getStatSignature("a.txt"), null);
  } finally {
    store.close();
  }
});
