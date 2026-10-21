import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
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
    assert.equal(Number(version.value), 2);
    assertStatSignatureColumns(store._db);
    assert.equal(store._db.prepare("SELECT rel_path FROM files").get().rel_path, "legacy.txt");
    assert.equal(store.getStatSignature("legacy.txt"), null);
    store.setStatSignatures([{ relPath: "legacy.txt", size: 4096, mtimeMs: 1234.5 }]);
    assert.deepEqual(store.getStatSignature("legacy.txt"), { size: 4096, mtimeMs: 1234.5 });
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
    assert.equal(Number(version.value), 2);
    assertStatSignatureColumns(store._db);
  } finally {
    store?.close();
  }
});
