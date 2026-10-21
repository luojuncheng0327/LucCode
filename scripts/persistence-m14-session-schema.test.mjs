import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { SessionManifestStore } from "../core/session-manifest/store.ts";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

function tempDatabase(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "luc-m14-session-schema-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "session-manifest.db");
}

function createVersionFiveDatabase(dbPath) {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.exec([
    "CREATE TABLE session_manifests (",
    "  session_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, owner_agent_id TEXT,",
    "  domain TEXT NOT NULL, kind TEXT NOT NULL, lifecycle TEXT NOT NULL, health TEXT NOT NULL,",
    "  current_locator_type TEXT NOT NULL, current_locator_path TEXT NOT NULL,",
    "  current_locator_key TEXT NOT NULL UNIQUE, current_locator_reason TEXT,",
    "  locator_updated_at TEXT NOT NULL, memory_policy_json TEXT NOT NULL,",
    "  permission_mode_snapshot_json TEXT NOT NULL, thinking_level TEXT, pinned_at TEXT,",
    "  pin_order INTEGER, workspace_scope_json TEXT NOT NULL, plugin_json TEXT NOT NULL,",
    "  provenance_json TEXT NOT NULL, migration_json TEXT NOT NULL, created_at TEXT NOT NULL,",
    "  updated_at TEXT NOT NULL, deleted_at TEXT",
    ");",
    "CREATE TABLE session_capability_snapshots (",
    "  session_id TEXT PRIMARY KEY, tool_names_json TEXT, prompt_snapshot_json TEXT,",
    "  capability_drift_dismissed_fingerprint TEXT, source TEXT NOT NULL, updated_at TEXT NOT NULL",
    ");",
    "CREATE TABLE session_branch_heads (",
    "  session_id TEXT PRIMARY KEY, leaf_id TEXT, observed_tail_leaf_id TEXT,",
    "  revision INTEGER NOT NULL, reason TEXT NOT NULL, updated_at TEXT NOT NULL",
    ");",
    "INSERT INTO session_manifests (session_id, schema_version, domain, kind, lifecycle, health,",
    "  current_locator_type, current_locator_path, current_locator_key, locator_updated_at,",
    "  memory_policy_json, permission_mode_snapshot_json, workspace_scope_json, plugin_json,",
    "  provenance_json, migration_json, created_at, updated_at)",
    "VALUES ('legacy-session', 1, 'agent', 'chat', 'active', 'healthy', 'jsonl',",
    "  'agents/a/sessions/legacy.jsonl', 'legacy-key', '2026-01-01T00:00:00.000Z',",
    "  '{}', '{}', '{}', 'null', '{}', '{}', '2026-01-01T00:00:00.000Z',",
    "  '2026-01-01T00:00:00.000Z');",
    "INSERT INTO session_capability_snapshots (session_id, tool_names_json, prompt_snapshot_json,",
    "  capability_drift_dismissed_fingerprint, source, updated_at)",
    "VALUES ('legacy-session', '[\"read\"]', '{}', NULL, 'legacy', '2026-01-01T00:00:00.000Z');",
    "INSERT INTO session_branch_heads (session_id, leaf_id, observed_tail_leaf_id, revision, reason, updated_at)",
    "VALUES ('legacy-session', 'leaf-1', 'leaf-1', 1, 'legacy', '2026-01-01T00:00:00.000Z');",
  ].join("\n"));
  db.pragma("user_version = 5");
  db.close();
}

function columnMap(db, table) {
  return new Map(db.pragma("table_info(" + table + ")").map((column) => [column.name, column]));
}

function assertM14Schema(db) {
  const manifests = columnMap(db, "session_manifests");
  for (const name of [
    "coordinator_granted_at",
    "project_id",
    "service_tier",
    "provider_cache_affinity_key",
    "memory_reflection_snapshot_json",
    "experiments_json",
    "forked_from_json",
    "memory_fork_baseline_json",
    "reminder_state_json",
    "preview_ui_state_json",
  ]) {
    assert.ok(manifests.has(name), "missing session_manifests." + name);
    assert.equal(manifests.get(name).type, "TEXT", name + " type");
  }
  assert.equal(manifests.get("experience_enabled").type, "INTEGER");

  const capabilities = columnMap(db, "session_capability_snapshots").get("tool_selection_explicit");
  assert.ok(capabilities, "missing tool_selection_explicit");
  assert.equal(capabilities.type, "INTEGER");
  assert.equal(capabilities.notnull, 1);
  assert.equal(String(capabilities.dflt_value), "0");
  assert.equal(columnMap(db, "session_branch_heads").get("observed_message_count")?.type, "INTEGER");

  const eventColumns = columnMap(db, "env_events");
  assert.deepEqual([...eventColumns.keys()], [
    "seq", "type", "scope_kind", "scope_agent_id", "payload_json", "at",
  ]);
  const index = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_env_events_scope'",
  ).get();
  assert.ok(index, "missing idx_env_events_scope");
  assert.match(index.sql, /ON env_events\(scope_kind, scope_agent_id, seq\)/);
}

test("M1.4 upgrades the existing v5 session database without losing rows", (t) => {
  const dbPath = tempDatabase(t);
  createVersionFiveDatabase(dbPath);
  let store;
  try {
    store = new SessionManifestStore({ dbPath });
    assert.equal(store.db.pragma("user_version", { simple: true }), 11);
    assertM14Schema(store.db);
    assert.equal(
      store.db.prepare("SELECT session_id FROM session_manifests").get().session_id,
      "legacy-session",
    );
    assert.equal(
      store.db.prepare("SELECT tool_selection_explicit FROM session_capability_snapshots").get().tool_selection_explicit,
      0,
    );
    assert.equal(
      store.db.prepare("SELECT observed_message_count FROM session_branch_heads").get().observed_message_count,
      null,
    );
    store.db.prepare("INSERT INTO env_events(type, scope_kind, scope_agent_id, payload_json, at) VALUES(?, ?, ?, ?, ?)")
      .run("facts-changed", "agent", "fixture-agent", '{"keep":true}', "2026-01-01T00:00:00.000Z");
    store.close();
    store = new SessionManifestStore({ dbPath });
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM env_events").get().n, 1);
    assertM14Schema(store.db);
  } finally {
    store?.close();
  }
});

test("session migration failure rolls back schema and rows and can be retried", (t) => {
  const dbPath = tempDatabase(t);
  createVersionFiveDatabase(dbPath);
  const initial = new Database(dbPath);
  const before = initial.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY name").all();
  initial.close();
  const original = Database.prototype.exec;
  const failed = { database: null };
  const injected = t.mock.method(Database.prototype, "exec", function(sql) {
    if (sql.includes("ADD COLUMN preview_ui_state_json")) {
      failed.database = this;
      throw new Error("injected final session migration failure");
    }
    return original.call(this, sql);
  });
  assert.throws(() => new SessionManifestStore({ dbPath }), /injected final session migration failure/);
  injected.mock.restore();
  assert.equal(failed.database.open, false);
  const probe = new Database(dbPath);
  try {
    assert.equal(probe.pragma("user_version", { simple: true }), 5);
    assert.deepEqual(probe.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY name").all(), before);
    assert.equal(probe.prepare("SELECT session_id FROM session_manifests").get().session_id, "legacy-session");
  } finally { probe.close(); }
  const store = new SessionManifestStore({ dbPath });
  try { assertM14Schema(store.db); } finally { store.close(); }
});

test("session owner rejects future schemas before creating or altering any table", (t) => {
  const dbPath = tempDatabase(t);
  const db = new Database(dbPath);
  db.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('keep')");
  db.pragma("user_version = 999");
  db.close();
  assert.throws(() => new SessionManifestStore({ dbPath }), /newer than supported/);
  const probe = new Database(dbPath);
  try {
    assert.deepEqual(probe.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(), [{ name: "sentinel" }]);
    assert.equal(probe.prepare("SELECT value FROM sentinel").get().value, "keep");
  } finally { probe.close(); }
});

test("M1.4 creates the same session schema for a new database", (t) => {
  const dbPath = tempDatabase(t);
  let store;
  try {
    store = new SessionManifestStore({ dbPath });
    assert.equal(store.db.pragma("user_version", { simple: true }), 11);
    assertM14Schema(store.db);
  } finally {
    store?.close();
  }
});
