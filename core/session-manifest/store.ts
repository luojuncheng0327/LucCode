import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { generateSessionId } from "./id.ts";
import { normalizeSessionLocatorPath, sessionLocatorKey } from "./path-normalizer.ts";
import {
  DEFAULT_SESSION_PERMISSION_MODE,
  normalizeSessionPermissionMode,
} from "../session-permission-mode.ts";

export const SESSION_MANIFEST_SCHEMA_VERSION = 1;
export const SESSION_MANIFEST_DB_USER_VERSION = 5;

const require = createRequire(import.meta.url);
let BetterSqliteDatabase = null;

export function loadBetterSqliteDatabase() {
  if (!BetterSqliteDatabase) {
    const mod = require("better-sqlite3");
    BetterSqliteDatabase = mod?.default || mod;
  }
  return BetterSqliteDatabase;
}

export class SessionManifestError extends Error {
  declare code: string;
  declare details: any;

  constructor(code, message, details = {}) {
    super(message);
    this.name = "SessionManifestError";
    this.code = code;
    this.details = details;
  }
}

function parseJson(value, fallback) {
  if (value == null || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function stringifyJson(value, fallback) {
  return JSON.stringify(value ?? fallback);
}

function normalizeToolNames(value) {
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  const out = [];
  for (const item of value) {
    if (typeof item !== "string" || !item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function pickString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const LEGACY_SCAN_PROVENANCE_FIELDS = new Set([
  "createdBy",
  "legacyAgentId",
  "legacyLifecycle",
  "legacyTitle",
  "bridgeSessionKey",
  "bridgeRole",
  "platform",
  "chatType",
  "conversationId",
  "conversationType",
  "activityId",
  "activityType",
  "parentSessionId",
  "legacyParentSessionPath",
  "parentRunId",
  "subagentTaskId",
  "threadId",
  "threadKind",
]);

const LEGACY_SCAN_MIGRATION_FIELDS = new Set([
  "source",
  "legacySessionPath",
  "legacySessionFileName",
  "migratedAt",
  "legacySources",
]);

const AUTHORITATIVE_LEGACY_OWNER_SOURCES = new Set([
  "legacy_subagent_run_store",
  "legacy_subagent_thread_store",
]);

function mergeLegacyScanFields(existing, incoming, allowedFields) {
  const current = existing && typeof existing === "object" && !Array.isArray(existing)
    ? { ...existing }
    : {};
  const candidate = incoming && typeof incoming === "object" && !Array.isArray(incoming)
    ? incoming
    : {};
  for (const [key, value] of Object.entries(candidate)) {
    if (!allowedFields.has(key) || value == null || value === "") continue;
    if (Array.isArray(value)) {
      const merged = new Set([
        ...(Array.isArray(current[key]) ? current[key] : []),
        ...value,
      ].filter((item) => typeof item === "string" && item.trim()));
      if (merged.size) current[key] = [...merged].sort();
      continue;
    }
    if (current[key] == null || current[key] === "") current[key] = value;
  }
  return current;
}

function normalizeExecutorMetadata(value: any = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const executorAgentId = pickString(source.executorAgentId || source.agentId);
  const executorAgentNameSnapshot = pickString(
    source.executorAgentNameSnapshot
    || source.executorAgentName
    || source.agentNameSnapshot
    || source.agentName,
  );
  if (!executorAgentId && !executorAgentNameSnapshot) return null;
  return {
    executorAgentId,
    executorAgentNameSnapshot,
    executorMetaVersion: Number.isFinite(source.executorMetaVersion) ? source.executorMetaVersion : 1,
  };
}

function defaultMemoryPolicy(input: any = {}) {
  return {
    mode: input.mode || "inherit",
    inheritedFrom: input.inheritedFrom || "agent_default",
  };
}

function defaultPermissionModeSnapshot(input: any = {}, capturedAt) {
  return {
    mode: normalizeSessionPermissionMode(input.mode || DEFAULT_SESSION_PERMISSION_MODE),
    source: input.source || "global_default_at_create",
    capturedAt: input.capturedAt || capturedAt,
  };
}

function toRowManifest(row) {
  if (!row) return null;
  return {
    schemaVersion: row.schema_version,
    sessionId: row.session_id,
    ownerAgentId: row.owner_agent_id || null,
    domain: row.domain,
    kind: row.kind,
    lifecycle: row.lifecycle,
    health: row.health,
    currentLocator: {
      type: row.current_locator_type,
      path: row.current_locator_path,
      key: row.current_locator_key,
      reason: row.current_locator_reason || null,
      updatedAt: row.locator_updated_at || row.updated_at,
    },
    memoryPolicy: parseJson(row.memory_policy_json, defaultMemoryPolicy()),
    permissionModeSnapshot: parseJson(
      row.permission_mode_snapshot_json,
      defaultPermissionModeSnapshot({}, row.created_at),
    ),
    thinkingLevel: row.thinking_level || null,
    pinnedAt: row.pinned_at || null,
    pinOrder: Number.isFinite(row.pin_order) ? row.pin_order : null,
    workspaceScope: parseJson(row.workspace_scope_json, {}),
    plugin: parseJson(row.plugin_json, null),
    provenance: parseJson(row.provenance_json, {}),
    migration: parseJson(row.migration_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null,
  };
}

function toHistoryLocator(row) {
  if (!row) return null;
  return {
    sessionId: row.session_id,
    type: row.locator_type,
    path: row.locator_path,
    key: row.locator_key,
    reason: row.reason || null,
    createdAt: row.created_at,
  };
}

function toCapabilitySnapshot(row) {
  if (!row) return null;
  return {
    sessionId: row.session_id,
    toolNames: parseJson(row.tool_names_json, null),
    promptSnapshot: parseJson(row.prompt_snapshot_json, null),
    capabilityDriftDismissedFingerprint: row.capability_drift_dismissed_fingerprint ?? null,
    source: row.source || null,
    updatedAt: row.updated_at,
  };
}

function toExecutorMetadata(row) {
  if (!row) return null;
  return {
    sessionId: row.session_id,
    executorAgentId: row.executor_agent_id || null,
    executorAgentNameSnapshot: row.executor_agent_name_snapshot || null,
    executorMetaVersion: row.executor_meta_version || 1,
    source: row.source || null,
    updatedAt: row.updated_at,
  };
}

function toBranchHead(row) {
  if (!row) return null;
  return {
    sessionId: row.session_id,
    leafId: row.leaf_id ?? null,
    observedTailLeafId: row.observed_tail_leaf_id ?? null,
    revision: Number(row.revision) || 1,
    reason: row.reason || null,
    updatedAt: row.updated_at,
  };
}

export class SessionManifestStore {
  declare db: any;
  declare _stmts: any;
  declare _now: any;
  declare _idGenerator: any;

  constructor(opts: any = {}) {
    if (!opts.dbPath) {
      throw new Error("SessionManifestStore requires dbPath");
    }

    fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true });
    const Database = opts.Database || loadBetterSqliteDatabase();
    this.db = new Database(opts.dbPath);
    try {
      this._now = opts.now || (() => new Date().toISOString());
      this._idGenerator = opts.idGenerator || (() => generateSessionId());

      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
      this.db.pragma("cache_size = -16000");
      this.db.pragma("temp_store = MEMORY");
      this.db.pragma("mmap_size = 30000000");
      this._initSchema();
      this._migrate();
      this._prepareStatements();
    } catch (error) {
      try {
        this.db?.close?.();
      } catch {
        // Keep the original initialization error; cleanup failure is secondary.
      }
      this.db = null;
      throw error;
    }
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_manifests (
        session_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        owner_agent_id TEXT,
        domain TEXT NOT NULL,
        kind TEXT NOT NULL,
        lifecycle TEXT NOT NULL,
        health TEXT NOT NULL,
        current_locator_type TEXT NOT NULL,
        current_locator_path TEXT NOT NULL,
        current_locator_key TEXT NOT NULL UNIQUE,
        current_locator_reason TEXT,
        locator_updated_at TEXT NOT NULL,
        memory_policy_json TEXT NOT NULL,
        permission_mode_snapshot_json TEXT NOT NULL,
        thinking_level TEXT,
        pinned_at TEXT,
        pin_order INTEGER,
        workspace_scope_json TEXT NOT NULL,
        plugin_json TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        migration_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_session_manifests_domain
        ON session_manifests(domain, lifecycle, updated_at);
      CREATE INDEX IF NOT EXISTS idx_session_manifests_pinned
        ON session_manifests(pinned_at);
      CREATE INDEX IF NOT EXISTS idx_session_manifests_owner
        ON session_manifests(owner_agent_id);

      CREATE TABLE IF NOT EXISTS session_locator_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        locator_type TEXT NOT NULL,
        locator_path TEXT NOT NULL,
        locator_key TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(locator_key),
        FOREIGN KEY(session_id) REFERENCES session_manifests(session_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_session_locator_history_session
        ON session_locator_history(session_id, created_at);

      CREATE TABLE IF NOT EXISTS session_manifest_state (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_capability_snapshots (
        session_id TEXT PRIMARY KEY,
        tool_names_json TEXT,
        prompt_snapshot_json TEXT,
        capability_drift_dismissed_fingerprint TEXT,
        source TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES session_manifests(session_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS session_executor_metadata (
        session_id TEXT PRIMARY KEY,
        executor_agent_id TEXT,
        executor_agent_name_snapshot TEXT,
        executor_meta_version INTEGER NOT NULL,
        source TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES session_manifests(session_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS session_branch_heads (
        session_id TEXT PRIMARY KEY,
        leaf_id TEXT,
        observed_tail_leaf_id TEXT,
        revision INTEGER NOT NULL,
        reason TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES session_manifests(session_id) ON DELETE CASCADE
      );
    `);
  }

  _migrate() {
    const current = this.db.pragma("user_version", { simple: true });
    if (current >= SESSION_MANIFEST_DB_USER_VERSION) return;

    this.db.transaction(() => {
      let version = current;
      while (version < SESSION_MANIFEST_DB_USER_VERSION) {
        switch (version) {
          case 0:
            break;
          case 3:
            this.db.exec(`
              CREATE TABLE IF NOT EXISTS session_branch_heads (
                session_id TEXT PRIMARY KEY,
                leaf_id TEXT,
                observed_tail_leaf_id TEXT,
                revision INTEGER NOT NULL,
                reason TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(session_id) REFERENCES session_manifests(session_id) ON DELETE CASCADE
              )
            `);
            break;
          case 4:
            this._addColumnIfMissing("session_manifests", "pin_order", "INTEGER");
            break;
        }
        version++;
      }
      this.db.pragma(`user_version = ${SESSION_MANIFEST_DB_USER_VERSION}`);
    })();
  }

  /**
   * SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, and a fresh
   * database already gets every column from _initSchema before _migrate runs.
   * Probing the current columns keeps both paths (fresh + upgraded) idempotent
   * without ever dropping or rebuilding the table.
   */
  _addColumnIfMissing(table, column, definition) {
    const columns = this.db.pragma(`table_info(${table})`);
    if (columns.some((entry) => entry.name === column)) return false;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return true;
  }

  _prepareStatements() {
    this._stmts = {
      insertManifest: this.db.prepare(`
        INSERT INTO session_manifests (
          session_id,
          schema_version,
          owner_agent_id,
          domain,
          kind,
          lifecycle,
          health,
          current_locator_type,
          current_locator_path,
          current_locator_key,
          current_locator_reason,
          locator_updated_at,
          memory_policy_json,
          permission_mode_snapshot_json,
          thinking_level,
          pinned_at,
          pin_order,
          workspace_scope_json,
          plugin_json,
          provenance_json,
          migration_json,
          created_at,
          updated_at,
          deleted_at
        ) VALUES (
          @sessionId,
          @schemaVersion,
          @ownerAgentId,
          @domain,
          @kind,
          @lifecycle,
          @health,
          @currentLocatorType,
          @currentLocatorPath,
          @currentLocatorKey,
          @currentLocatorReason,
          @locatorUpdatedAt,
          @memoryPolicyJson,
          @permissionModeSnapshotJson,
          @thinkingLevel,
          @pinnedAt,
          @pinOrder,
          @workspaceScopeJson,
          @pluginJson,
          @provenanceJson,
          @migrationJson,
          @createdAt,
          @updatedAt,
          @deletedAt
        )
      `),
      getById: this.db.prepare("SELECT * FROM session_manifests WHERE session_id = ?"),
      getByCurrentLocator: this.db.prepare("SELECT * FROM session_manifests WHERE current_locator_key = ?"),
      getByHistoryLocator: this.db.prepare(`
        SELECT m.*
        FROM session_locator_history h
        JOIN session_manifests m ON m.session_id = h.session_id
        WHERE h.locator_key = ?
      `),
      getHistoryLocator: this.db.prepare(`
        SELECT * FROM session_locator_history WHERE locator_key = ?
      `),
      listHistory: this.db.prepare(`
        SELECT * FROM session_locator_history
        WHERE session_id = ?
        ORDER BY created_at ASC, id ASC
      `),
      insertHistory: this.db.prepare(`
        INSERT INTO session_locator_history (
          session_id,
          locator_type,
          locator_path,
          locator_key,
          reason,
          created_at
        ) VALUES (
          @sessionId,
          @locatorType,
          @locatorPath,
          @locatorKey,
          @reason,
          @createdAt
        )
      `),
      deleteHistoryForLocator: this.db.prepare(`
        DELETE FROM session_locator_history
        WHERE session_id = ? AND locator_key = ?
      `),
      updateLocator: this.db.prepare(`
        UPDATE session_manifests
        SET
          current_locator_type = @currentLocatorType,
          current_locator_path = @currentLocatorPath,
          current_locator_key = @currentLocatorKey,
          current_locator_reason = @currentLocatorReason,
          locator_updated_at = @locatorUpdatedAt,
          updated_at = @updatedAt
        WHERE session_id = @sessionId
      `),
      updateLocatorLifecycle: this.db.prepare(`
        UPDATE session_manifests
        SET
          domain = @domain,
          kind = @kind,
          lifecycle = @lifecycle,
          current_locator_type = @currentLocatorType,
          current_locator_path = @currentLocatorPath,
          current_locator_key = @currentLocatorKey,
          current_locator_reason = @currentLocatorReason,
          locator_updated_at = @locatorUpdatedAt,
          updated_at = @updatedAt,
          deleted_at = @deletedAt
        WHERE session_id = @sessionId
      `),
      setPinnedAt: this.db.prepare(`
        UPDATE session_manifests
        SET pinned_at = @pinnedAt, updated_at = @updatedAt
        WHERE session_id = @sessionId
      `),
      setPinOrder: this.db.prepare(`
        UPDATE session_manifests
        SET pin_order = @pinOrder, updated_at = @updatedAt
        WHERE session_id = @sessionId
      `),
      minPinOrder: this.db.prepare(`
        SELECT MIN(pin_order) AS value
        FROM session_manifests
        WHERE pinned_at IS NOT NULL
      `),
      backfillOwnerAgent: this.db.prepare(`
        UPDATE session_manifests
        SET owner_agent_id = @ownerAgentId, updated_at = @updatedAt
        WHERE session_id = @sessionId
          AND (owner_agent_id IS NULL OR owner_agent_id = '')
      `),
      repairLegacyScanMetadata: this.db.prepare(`
        UPDATE session_manifests
        SET
          owner_agent_id = @ownerAgentId,
          domain = @domain,
          kind = @kind,
          provenance_json = @provenanceJson,
          migration_json = @migrationJson,
          updated_at = @updatedAt
        WHERE session_id = @sessionId
      `),
      setPlugin: this.db.prepare(`
        UPDATE session_manifests
        SET plugin_json = @pluginJson, updated_at = @updatedAt
        WHERE session_id = @sessionId
      `),
      setMemoryPolicy: this.db.prepare(`
        UPDATE session_manifests
        SET memory_policy_json = @memoryPolicyJson, updated_at = @updatedAt
        WHERE session_id = @sessionId
      `),
      setPermissionModeSnapshot: this.db.prepare(`
        UPDATE session_manifests
        SET permission_mode_snapshot_json = @permissionModeSnapshotJson, updated_at = @updatedAt
        WHERE session_id = @sessionId
      `),
      setThinkingLevel: this.db.prepare(`
        UPDATE session_manifests
        SET thinking_level = @thinkingLevel, updated_at = @updatedAt
        WHERE session_id = @sessionId
      `),
      setWorkspaceScope: this.db.prepare(`
        UPDATE session_manifests
        SET workspace_scope_json = @workspaceScopeJson, updated_at = @updatedAt
        WHERE session_id = @sessionId
      `),
      getState: this.db.prepare("SELECT value_json FROM session_manifest_state WHERE key = ?"),
      setState: this.db.prepare(`
        INSERT INTO session_manifest_state (
          key,
          value_json,
          updated_at
        ) VALUES (
          @key,
          @valueJson,
          @updatedAt
        )
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `),
      getCapabilitySnapshot: this.db.prepare(`
        SELECT * FROM session_capability_snapshots WHERE session_id = ?
      `),
      upsertCapabilitySnapshot: this.db.prepare(`
        INSERT INTO session_capability_snapshots (
          session_id,
          tool_names_json,
          prompt_snapshot_json,
          capability_drift_dismissed_fingerprint,
          source,
          updated_at
        ) VALUES (
          @sessionId,
          @toolNamesJson,
          @promptSnapshotJson,
          @capabilityDriftDismissedFingerprint,
          @source,
          @updatedAt
        )
        ON CONFLICT(session_id) DO UPDATE SET
          tool_names_json = excluded.tool_names_json,
          prompt_snapshot_json = excluded.prompt_snapshot_json,
          capability_drift_dismissed_fingerprint = excluded.capability_drift_dismissed_fingerprint,
          source = excluded.source,
          updated_at = excluded.updated_at
      `),
      getExecutorMetadata: this.db.prepare(`
        SELECT * FROM session_executor_metadata WHERE session_id = ?
      `),
      upsertExecutorMetadata: this.db.prepare(`
        INSERT INTO session_executor_metadata (
          session_id,
          executor_agent_id,
          executor_agent_name_snapshot,
          executor_meta_version,
          source,
          updated_at
        ) VALUES (
          @sessionId,
          @executorAgentId,
          @executorAgentNameSnapshot,
          @executorMetaVersion,
          @source,
          @updatedAt
        )
        ON CONFLICT(session_id) DO UPDATE SET
          executor_agent_id = excluded.executor_agent_id,
          executor_agent_name_snapshot = excluded.executor_agent_name_snapshot,
          executor_meta_version = excluded.executor_meta_version,
          source = excluded.source,
          updated_at = excluded.updated_at
      `),
      getBranchHead: this.db.prepare(`
        SELECT * FROM session_branch_heads WHERE session_id = ?
      `),
      upsertBranchHead: this.db.prepare(`
        INSERT INTO session_branch_heads (
          session_id,
          leaf_id,
          observed_tail_leaf_id,
          revision,
          reason,
          updated_at
        ) VALUES (
          @sessionId,
          @leafId,
          @observedTailLeafId,
          1,
          @reason,
          @updatedAt
        )
        ON CONFLICT(session_id) DO UPDATE SET
          leaf_id = excluded.leaf_id,
          observed_tail_leaf_id = excluded.observed_tail_leaf_id,
          revision = session_branch_heads.revision + 1,
          reason = excluded.reason,
          updated_at = excluded.updated_at
      `),
      list: this.db.prepare("SELECT * FROM session_manifests ORDER BY updated_at DESC"),
    };
  }

  createForPath(input) {
    const locator = this._locatorFromPath(input.sessionPath);
    const existing = this._findByLocator(locator.key);
    if (existing) {
      return this._repairCurrentLocatorForSameKey(existing, locator, input.locatorReason || "create");
    }

    const createdAt = this._now();
    const memoryPolicy = defaultMemoryPolicy(input.memoryPolicy);
    const permissionModeSnapshot = defaultPermissionModeSnapshot(
      input.permissionModeSnapshot,
      createdAt,
    );

    return this.db.transaction(() => {
      const conflict = this._findByLocator(locator.key);
      if (conflict) {
        return this._repairCurrentLocatorForSameKey(conflict, locator, input.locatorReason || "create");
      }

      const sessionId = this._generateUniqueSessionId();
      this._stmts.insertManifest.run({
        sessionId,
        schemaVersion: SESSION_MANIFEST_SCHEMA_VERSION,
        ownerAgentId: input.ownerAgentId || null,
        domain: input.domain || "home",
        kind: input.kind || "chat",
        lifecycle: input.lifecycle || "active",
        health: input.health || "ok",
        currentLocatorType: locator.type,
        currentLocatorPath: locator.path,
        currentLocatorKey: locator.key,
        currentLocatorReason: input.locatorReason || "create",
        locatorUpdatedAt: createdAt,
        memoryPolicyJson: stringifyJson(memoryPolicy, defaultMemoryPolicy()),
        permissionModeSnapshotJson: stringifyJson(
          permissionModeSnapshot,
          defaultPermissionModeSnapshot({}, createdAt),
        ),
        thinkingLevel: input.thinkingLevel || null,
        pinnedAt: input.pinnedAt || null,
        pinOrder: input.pinOrder ?? null,
        workspaceScopeJson: stringifyJson(input.workspaceScope, {}),
        pluginJson: stringifyJson(input.plugin, null),
        provenanceJson: stringifyJson(input.provenance, {}),
        migrationJson: stringifyJson(input.migration, {}),
        createdAt,
        updatedAt: createdAt,
        deletedAt: input.deletedAt || null,
      });
      return this.getBySessionId(sessionId);
    })();
  }

  getBySessionId(sessionId) {
    return toRowManifest(this._stmts.getById.get(sessionId));
  }

  resolveByLocatorPath(sessionPath) {
    const locator = this._locatorFromPath(sessionPath);
    return this._findByLocator(locator.key);
  }

  updateLocator(sessionId, nextSessionPath, reason = "update") {
    const nextLocator = this._locatorFromPath(nextSessionPath);
    return this.db.transaction(() => {
      const manifest = this.getBySessionId(sessionId);
      if (!manifest) {
        throw new SessionManifestError(
          "session_manifest_not_found",
          `Session manifest not found: ${sessionId}`,
          { sessionId },
        );
      }

      if (manifest.currentLocator.key === nextLocator.key) {
        return this._repairCurrentLocatorForSameKey(manifest, nextLocator, reason);
      }

      this._assertLocatorAvailable(nextLocator.key, sessionId);

      const changedAt = this._now();
      this._insertHistoryLocator({
        sessionId,
        locatorType: manifest.currentLocator.type,
        locatorPath: manifest.currentLocator.path,
        locatorKey: manifest.currentLocator.key,
        reason,
        createdAt: changedAt,
      });
      this._stmts.deleteHistoryForLocator.run(sessionId, nextLocator.key);
      this._stmts.updateLocator.run({
        sessionId,
        currentLocatorType: nextLocator.type,
        currentLocatorPath: nextLocator.path,
        currentLocatorKey: nextLocator.key,
        currentLocatorReason: reason,
        locatorUpdatedAt: changedAt,
        updatedAt: changedAt,
      });
      return this.getBySessionId(sessionId);
    })();
  }

  updateLocatorLifecycle(
    sessionId,
    nextSessionPath,
    lifecycle,
    reason = "update",
    classification: { domain?: string; kind?: string } = {},
  ) {
    const nextLifecycle = pickString(lifecycle);
    if (!nextLifecycle) {
      throw new SessionManifestError(
        "session_manifest_lifecycle_required",
        "Session manifest lifecycle is required.",
        { sessionId, lifecycle },
      );
    }
    const nextLocator = this._locatorFromPath(nextSessionPath);
    return this.db.transaction(() => {
      const manifest = this.getBySessionId(sessionId);
      if (!manifest) {
        throw new SessionManifestError(
          "session_manifest_not_found",
          `Session manifest not found: ${sessionId}`,
          { sessionId },
        );
      }

      const domain = pickString(classification?.domain) || manifest.domain;
      const kind = pickString(classification?.kind) || manifest.kind;

      if (manifest.currentLocator.key !== nextLocator.key) {
        this._assertLocatorAvailable(nextLocator.key, sessionId);
        const changedAt = this._now();
        this._insertHistoryLocator({
          sessionId,
          locatorType: manifest.currentLocator.type,
          locatorPath: manifest.currentLocator.path,
          locatorKey: manifest.currentLocator.key,
          reason,
          createdAt: changedAt,
        });
        this._stmts.deleteHistoryForLocator.run(sessionId, nextLocator.key);
        this._stmts.updateLocatorLifecycle.run({
          sessionId,
          domain,
          kind,
          lifecycle: nextLifecycle,
          currentLocatorType: nextLocator.type,
          currentLocatorPath: nextLocator.path,
          currentLocatorKey: nextLocator.key,
          currentLocatorReason: reason,
          locatorUpdatedAt: changedAt,
          updatedAt: changedAt,
          deletedAt: nextLifecycle === "deleted" ? (manifest.deletedAt || changedAt) : null,
        });
        return this.getBySessionId(sessionId);
      }

      const updatedAt = this._now();
      this._stmts.updateLocatorLifecycle.run({
        sessionId,
        domain,
        kind,
        lifecycle: nextLifecycle,
        currentLocatorType: nextLocator.type,
        currentLocatorPath: nextLocator.path,
        currentLocatorKey: nextLocator.key,
        currentLocatorReason: reason,
        locatorUpdatedAt: updatedAt,
        updatedAt,
        deletedAt: nextLifecycle === "deleted" ? (manifest.deletedAt || updatedAt) : null,
      });
      return this.getBySessionId(sessionId);
    })();
  }

  getLocatorHistory(sessionId) {
    return this._stmts.listHistory.all(sessionId).map(toHistoryLocator);
  }

  setPinnedAt(sessionId, pinnedAt) {
    const updatedAt = this._now();
    this._stmts.setPinnedAt.run({
      sessionId,
      pinnedAt: pinnedAt || null,
      updatedAt,
    });
    return this.getBySessionId(sessionId);
  }

  setPinOrder(sessionId, pinOrder) {
    const updatedAt = this._now();
    this._stmts.setPinOrder.run({
      sessionId,
      pinOrder: Number.isFinite(pinOrder) ? pinOrder : null,
      updatedAt,
    });
    return this.getBySessionId(sessionId);
  }

  /**
   * Smallest explicit order among pinned sessions, or null when no pinned
   * session carries one. Callers put a new pin above everything by subtracting
   * a step from this value.
   */
  minPinOrder() {
    const value = this._stmts.minPinOrder.get()?.value;
    return Number.isFinite(value) ? value : null;
  }

  backfillOwnerAgentId(sessionId, ownerAgentId) {
    const manifest = this.getBySessionId(sessionId);
    if (!manifest) {
      throw new SessionManifestError(
        "session_manifest_not_found",
        `Session manifest not found: ${sessionId}`,
        { sessionId },
      );
    }
    const next = typeof ownerAgentId === "string" ? ownerAgentId.trim() : "";
    if (!next || manifest.ownerAgentId) return manifest;
    this._stmts.backfillOwnerAgent.run({ sessionId, ownerAgentId: next, updatedAt: this._now() });
    return this.getBySessionId(sessionId);
  }

  /**
   * Repairs metadata written by the legacy scanner before non-desktop sources
   * had explicit classification. This is intentionally narrower than a
   * general manifest patch: fresh rows and already-specific classifications
   * are immutable here, and existing non-empty metadata always wins.
   */
  repairLegacyScanMetadata(sessionId, input: any = {}) {
    const manifest = this.getBySessionId(sessionId);
    if (!manifest) {
      throw new SessionManifestError(
        "session_manifest_not_found",
        `Session manifest not found: ${sessionId}`,
        { sessionId },
      );
    }
    const migrationSource = pickString(manifest.migration?.source);
    const migrationCreator = pickString(manifest.migration?.createdBy);
    const legacyBoundary = migrationSource === "legacy_scan"
      || migrationSource === "resolver_on_demand"
      || migrationCreator === "resolver_on_demand";
    if (!legacyBoundary) return manifest;

    const expectedDomain = pickString(input.domain);
    const expectedKind = pickString(input.kind);
    if (!expectedDomain || !expectedKind) return manifest;
    const alreadyExpected = manifest.domain === expectedDomain && manifest.kind === expectedKind;
    const legacyDefault = (manifest.domain === "desktop" || manifest.domain === "home")
      && manifest.kind === "chat";
    if (!alreadyExpected && !legacyDefault) return manifest;

    const requestedOwnerAgentId = pickString(input.ownerAgentId);
    const ownerSource = pickString(input.ownerAgentIdSource);
    const ownerAgentId = requestedOwnerAgentId && AUTHORITATIVE_LEGACY_OWNER_SOURCES.has(ownerSource)
      ? requestedOwnerAgentId
      : (manifest.ownerAgentId || requestedOwnerAgentId);
    const domain = legacyDefault ? expectedDomain : manifest.domain;
    const kind = legacyDefault ? expectedKind : manifest.kind;
    const provenance = mergeLegacyScanFields(
      manifest.provenance,
      input.provenance,
      LEGACY_SCAN_PROVENANCE_FIELDS,
    );
    const migration = mergeLegacyScanFields(
      manifest.migration,
      input.migration,
      LEGACY_SCAN_MIGRATION_FIELDS,
    );

    const changed = ownerAgentId !== manifest.ownerAgentId
      || domain !== manifest.domain
      || kind !== manifest.kind
      || JSON.stringify(provenance) !== JSON.stringify(manifest.provenance)
      || JSON.stringify(migration) !== JSON.stringify(manifest.migration);
    if (!changed) return manifest;

    this._stmts.repairLegacyScanMetadata.run({
      sessionId,
      ownerAgentId,
      domain,
      kind,
      provenanceJson: JSON.stringify(provenance),
      migrationJson: JSON.stringify(migration),
      updatedAt: this._now(),
    });
    return this.getBySessionId(sessionId);
  }

  setPlugin(sessionId, plugin) {
    const updatedAt = this._now();
    this._stmts.setPlugin.run({
      sessionId,
      pluginJson: stringifyJson(plugin, null),
      updatedAt,
    });
    return this.getBySessionId(sessionId);
  }

  setMemoryPolicy(sessionId, memoryPolicy) {
    const updatedAt = this._now();
    this._stmts.setMemoryPolicy.run({
      sessionId,
      memoryPolicyJson: stringifyJson(defaultMemoryPolicy(memoryPolicy), defaultMemoryPolicy()),
      updatedAt,
    });
    return this.getBySessionId(sessionId);
  }

  setPermissionModeSnapshot(sessionId, snapshot) {
    const updatedAt = this._now();
    this._stmts.setPermissionModeSnapshot.run({
      sessionId,
      permissionModeSnapshotJson: stringifyJson(
        defaultPermissionModeSnapshot(snapshot, updatedAt),
        defaultPermissionModeSnapshot({}, updatedAt),
      ),
      updatedAt,
    });
    return this.getBySessionId(sessionId);
  }

  setThinkingLevel(sessionId, thinkingLevel) {
    const updatedAt = this._now();
    this._stmts.setThinkingLevel.run({
      sessionId,
      thinkingLevel: thinkingLevel || null,
      updatedAt,
    });
    return this.getBySessionId(sessionId);
  }

  setWorkspaceScope(sessionId, workspaceScope) {
    const updatedAt = this._now();
    this._stmts.setWorkspaceScope.run({
      sessionId,
      workspaceScopeJson: stringifyJson(workspaceScope, {}),
      updatedAt,
    });
    return this.getBySessionId(sessionId);
  }

  getCapabilitySnapshot(sessionId) {
    return toCapabilitySnapshot(this._stmts.getCapabilitySnapshot.get(sessionId));
  }

  setCapabilitySnapshot(sessionId, snapshot: any = {}, options: any = {}) {
    const manifest = this.getBySessionId(sessionId);
    if (!manifest) {
      throw new SessionManifestError(
        "session_manifest_not_found",
        `Session manifest not found: ${sessionId}`,
        { sessionId },
      );
    }

    const existing = this.getCapabilitySnapshot(sessionId);
    const hasToolNames = Object.prototype.hasOwnProperty.call(snapshot, "toolNames");
    const hasPromptSnapshot = Object.prototype.hasOwnProperty.call(snapshot, "promptSnapshot");
    const hasDismissedFingerprint = Object.prototype.hasOwnProperty.call(snapshot, "capabilityDriftDismissedFingerprint");
    const toolNames = hasToolNames
      ? normalizeToolNames(snapshot.toolNames)
      : (existing?.toolNames ?? null);
    const promptSnapshot = hasPromptSnapshot
      ? (snapshot.promptSnapshot ?? null)
      : (existing?.promptSnapshot ?? null);
    const capabilityDriftDismissedFingerprint = hasDismissedFingerprint
      ? (typeof snapshot.capabilityDriftDismissedFingerprint === "string"
        ? snapshot.capabilityDriftDismissedFingerprint
        : null)
      : (existing?.capabilityDriftDismissedFingerprint ?? null);
    const updatedAt = this._now();
    const source = options.source || snapshot.source || existing?.source || "session_update";

    this._stmts.upsertCapabilitySnapshot.run({
      sessionId,
      toolNamesJson: toolNames ? JSON.stringify(toolNames) : null,
      promptSnapshotJson: promptSnapshot == null ? null : JSON.stringify(promptSnapshot),
      capabilityDriftDismissedFingerprint,
      source,
      updatedAt,
    });
    return this.getCapabilitySnapshot(sessionId);
  }

  getExecutorMetadata(sessionId) {
    return toExecutorMetadata(this._stmts.getExecutorMetadata.get(sessionId));
  }

  setExecutorMetadata(sessionId, metadata: any = {}, options: any = {}) {
    const manifest = this.getBySessionId(sessionId);
    if (!manifest) {
      throw new SessionManifestError(
        "session_manifest_not_found",
        `Session manifest not found: ${sessionId}`,
        { sessionId },
      );
    }
    const normalized = normalizeExecutorMetadata(metadata);
    if (!normalized) return this.getExecutorMetadata(sessionId);
    const updatedAt = this._now();
    this._stmts.upsertExecutorMetadata.run({
      sessionId,
      executorAgentId: normalized.executorAgentId,
      executorAgentNameSnapshot: normalized.executorAgentNameSnapshot,
      executorMetaVersion: normalized.executorMetaVersion,
      source: options.source || metadata.source || "session_update",
      updatedAt,
    });
    return this.getExecutorMetadata(sessionId);
  }

  getBranchHead(sessionId) {
    return toBranchHead(this._stmts.getBranchHead.get(sessionId));
  }

  setBranchHead(sessionId, state: any = {}) {
    const reason = pickString(state.reason) || "session_update";
    const leafId = state.leafId == null ? null : pickString(state.leafId);
    const observedTailLeafId = state.observedTailLeafId == null
      ? null
      : pickString(state.observedTailLeafId);
    if (state.leafId != null && !leafId) {
      throw new SessionManifestError(
        "session_branch_leaf_invalid",
        "Session branch leaf id must be a non-empty string or null.",
        { sessionId, leafId: state.leafId },
      );
    }
    if (state.observedTailLeafId != null && !observedTailLeafId) {
      throw new SessionManifestError(
        "session_branch_tail_invalid",
        "Session branch observed tail id must be a non-empty string or null.",
        { sessionId, observedTailLeafId: state.observedTailLeafId },
      );
    }

    return this.db.transaction(() => {
      const manifest = this.getBySessionId(sessionId);
      if (!manifest) {
        throw new SessionManifestError(
          "session_manifest_not_found",
          `Session manifest not found: ${sessionId}`,
          { sessionId },
        );
      }
      this._stmts.upsertBranchHead.run({
        sessionId,
        leafId,
        observedTailLeafId,
        reason,
        updatedAt: this._now(),
      });
      return this.getBranchHead(sessionId);
    })();
  }

  list() {
    return this._stmts.list.all().map(toRowManifest);
  }

  getState(key) {
    const row = this._stmts.getState.get(key);
    return parseJson(row?.value_json, null);
  }

  setState(key, value) {
    this._stmts.setState.run({
      key,
      valueJson: JSON.stringify(value ?? null),
      updatedAt: this._now(),
    });
    return this.getState(key);
  }

  close() {
    this.db?.close();
  }

  _locatorFromPath(sessionPath) {
    const locatorPath = normalizeSessionLocatorPath(sessionPath);
    return {
      type: "jsonl",
      path: locatorPath,
      key: sessionLocatorKey(sessionPath),
    };
  }

  _repairCurrentLocatorForSameKey(manifest, locator, reason = "repair") {
    if (!manifest || manifest.currentLocator?.key !== locator.key) return manifest;
    if (
      manifest.currentLocator.path === locator.path
      && manifest.currentLocator.type === locator.type
    ) {
      return manifest;
    }
    const updatedAt = this._now();
    this._stmts.updateLocator.run({
      sessionId: manifest.sessionId,
      currentLocatorType: locator.type,
      currentLocatorPath: locator.path,
      currentLocatorKey: locator.key,
      currentLocatorReason: reason,
      locatorUpdatedAt: updatedAt,
      updatedAt,
    });
    return this.getBySessionId(manifest.sessionId);
  }

  _findByLocator(locatorKey) {
    const current = toRowManifest(this._stmts.getByCurrentLocator.get(locatorKey));
    const history = toRowManifest(this._stmts.getByHistoryLocator.get(locatorKey));
    if (current && history && current.sessionId !== history.sessionId) {
      throw new SessionManifestError(
        "session_locator_conflict",
        "Session locator is claimed by multiple manifests; repair is required before opening this session.",
        {
          locatorKey,
          currentSessionId: current.sessionId,
          historySessionId: history.sessionId,
        },
      );
    }
    return current || history || null;
  }

  _assertLocatorAvailable(locatorKey, sessionId) {
    const current = this._stmts.getByCurrentLocator.get(locatorKey);
    if (current && current.session_id !== sessionId) {
      throw this._conflict(locatorKey, sessionId, current.session_id);
    }

    const history = this._stmts.getHistoryLocator.get(locatorKey);
    if (history && history.session_id !== sessionId) {
      throw this._conflict(locatorKey, sessionId, history.session_id);
    }
  }

  _insertHistoryLocator(locator) {
    try {
      this._stmts.insertHistory.run(locator);
    } catch (error) {
      if (error?.code === "SQLITE_CONSTRAINT_UNIQUE") {
        const existing = this._stmts.getHistoryLocator.get(locator.locatorKey);
        if (existing?.session_id === locator.sessionId) return;
        throw this._conflict(locator.locatorKey, locator.sessionId, existing?.session_id || null);
      }
      throw error;
    }
  }

  _conflict(locatorKey, requestedSessionId, existingSessionId) {
    return new SessionManifestError(
      "session_locator_conflict",
      "Session locator conflict; repair is required before this locator can be reassigned.",
      { locatorKey, requestedSessionId, existingSessionId },
    );
  }

  _generateUniqueSessionId() {
    for (let attempt = 0; attempt < 10; attempt++) {
      const sessionId = this._idGenerator();
      if (!this._stmts.getById.get(sessionId)) return sessionId;
    }
    throw new SessionManifestError(
      "session_id_generation_failed",
      "Could not generate a unique session id.",
    );
  }
}
