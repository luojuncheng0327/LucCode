import fs from "fs";
import path from "path";
import { createRequire } from "node:module";
import { normalizeLlmUsage } from "./usage-observer.ts";
import {
  attributionSessionId,
  attributionSessionPath,
  isUnknownUsageContext as isUnknownUsageContextValue,
  normalizeUsageContext,
} from "./usage-context.ts";

const DEFAULT_MAX_ENTRIES = 20_000;
const require = createRequire(import.meta.url);
const TRIM_SQL = "DELETE FROM usage_entries WHERE entry_order IN (SELECT entry_order FROM usage_entries ORDER BY entry_order LIMIT MAX(0, (SELECT COUNT(*) FROM usage_entries) - ?))";

export function createUsageLedger({
  maxEntries = DEFAULT_MAX_ENTRIES,
  eventBus = null,
  logger = null,
  now = () => Date.now(),
  requestIdFactory = null,
  storagePath = null,
  databasePath = null,
  legacyStoragePath = null,
  timeZone = null,
} = {}) {
  const location = databasePath ?? (storagePath ? `${storagePath}.sqlite` : ":memory:");
  const limit = Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : DEFAULT_MAX_ENTRIES;
  const db = openDatabase(location);
  let zone: string;
  let writeEntry;
  try {
    zone = initializeDatabase(db, { timeZone, now, legacyPath: legacyStoragePath ?? storagePath, maxEntries: limit });
    writeEntry = db.transaction(createEntryWriter(db, zone, limit));
  } catch (error) {
    db.close();
    throw error;
  }
  const pending = new Map();
  let sequence = 0;
  let closed = false;
  const assertOpen = () => { if (closed) throw new Error("usage ledger is closed"); };

  const nextRequestId = () => {
    if (typeof requestIdFactory === "function") return String(requestIdFactory());
    sequence += 1;
    return `llm_${now().toString(36)}_${sequence.toString(36)}`;
  };

  const append = (entry) => {
    assertOpen();
    const normalizedEntry = normalizeEntry(entry, now);
    if (entryHasUnknownUsageContext(normalizedEntry)) {
      warn(logger, `unknown usage context for LLM request ${normalizedEntry.requestId}`);
    }
    const inserted = writeEntry(normalizedEntry);
    if (inserted) emit(eventBus, normalizedEntry);
    return inserted ? normalizedEntry : null;
  };

  return {
    start(meta: Record<string, any> = {}) {
      assertOpen();
      const requestId = meta.requestId ? String(meta.requestId) : nextRequestId();
      const startedMs = now();
      const usageContext = normalizeUsageContext(meta.usageContext);
      const pendingEntry = {
        requestId,
        startedMs,
        startedAt: toIso(startedMs),
        source: usageContext.source,
        attribution: usageContext.attribution,
        metadata: isPlainObject(meta.metadata) ? { ...meta.metadata } : null,
        model: normalizeModel(meta.model),
        costRates: meta.costRates ?? null,
      };
      if (entryHasUnknownUsageContext(pendingEntry)) {
        warn(logger, `unknown usage context for LLM request ${requestId}`);
      }
      pending.set(requestId, pendingEntry);
      return { requestId, startedAt: pendingEntry.startedAt };
    },

    finish(requestId: any, result: Record<string, any> = {}) {
      assertOpen();
      const pendingEntry = pending.get(requestId);
      if (!pendingEntry) return null;
      const endedMs = now();
      const usage = normalizeUsage(result.usage, {
        costRates: result.costRates ?? pendingEntry.costRates,
        cacheSupport: result.cacheSupport,
      });
      const entry = append({
        schemaVersion: 1,
        requestId,
        startedAt: pendingEntry.startedAt,
        endedAt: toIso(endedMs),
        durationMs: Math.max(0, endedMs - pendingEntry.startedMs),
        status: usage ? "ok" : "usage_missing",
        source: pendingEntry.source,
        attribution: pendingEntry.attribution,
        metadata: pendingEntry.metadata,
        model: normalizeModel(result.model ?? pendingEntry.model),
        usage,
        rawUsageShape: rawUsageShape(result.usage),
        error: null,
      });
      pending.delete(requestId);
      return entry;
    },

    recordError(requestId: any, error: any, status = "error", result: Record<string, any> = {}) {
      assertOpen();
      const pendingEntry = pending.get(requestId);
      if (!pendingEntry) return null;
      const endedMs = now();
      const usage = normalizeUsage(result.usage, {
        costRates: result.costRates ?? pendingEntry.costRates,
        cacheSupport: result.cacheSupport,
      });
      const entry = append({
        schemaVersion: 1,
        requestId,
        startedAt: pendingEntry.startedAt,
        endedAt: toIso(endedMs),
        durationMs: Math.max(0, endedMs - pendingEntry.startedMs),
        status: status === "aborted" ? "aborted" : "error",
        source: pendingEntry.source,
        attribution: pendingEntry.attribution,
        metadata: pendingEntry.metadata,
        model: pendingEntry.model,
        usage,
        rawUsageShape: rawUsageShape(result.usage),
        error: normalizeError(error),
      });
      pending.delete(requestId);
      return entry;
    },

    record(meta: Record<string, any> = {}) {
      const request = this.start(meta);
      return this.finish(request.requestId, {
        usage: meta.usage,
        model: meta.model,
        costRates: meta.costRates,
        cacheSupport: meta.cacheSupport,
      });
    },

    list(filter: Record<string, any> = {}) {
      assertOpen();
      const entries = db.prepare("SELECT entry_json FROM usage_entries ORDER BY entry_order").all().map(row => JSON.parse(row.entry_json));
      const limit = normalizeLimit(filter.limit);
      const filtered = entries.filter(entry => matchesFilter(entry, filter));
      const limited = limit ? filtered.slice(Math.max(0, filtered.length - limit)) : filtered;
      return {
        entries: limited.map(clone),
        nextCursor: null,
      };
    },

    listDaily(filter: Record<string, any> = {}) {
      assertOpen();
      const clauses = [];
      const params = {};
      for (const [key, expression] of [["since", "stat_day >="], ["until", "stat_day <="], ["provider", "provider ="], ["modelId", "model_id ="]]) {
        if (filter[key]) { clauses.push(`${expression} @${key}`); params[key] = filter[key]; }
      }
      const rows = db.prepare(`SELECT * FROM usage_daily_rollups${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY stat_day, provider, model_id`).all(params);
      return { timeZone: zone, coverage: { statisticsStartedAt: getMeta(db, "statistics_started_at"), importedEntryEarliestAt: getMeta(db, "legacy_earliest_at"), historyIncomplete: getMeta(db, "history_incomplete") === "1" }, rows: rows.map(dailyRow) };
    },

    clear() {
      assertOpen();
      db.transaction(() => {
        db.exec("DELETE FROM usage_entries; DELETE FROM usage_seen_requests; DELETE FROM usage_daily_rollups;");
        setMeta(db, "statistics_started_at", toIso(now()));
      })();
      pending.clear();
    },

    close() {
      if (closed) return;
      db.close();
      closed = true;
      pending.clear();
    },
  };
}

function openDatabase(location) {
  if (location !== ":memory:") fs.mkdirSync(path.dirname(location), { recursive: true });
  const Database = require("better-sqlite3");
  const db = new Database(location);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("synchronous = NORMAL");
    return db;
  } catch (error) { db.close(); throw error; }
}

function getMeta(db, key): string | null {
  return db.prepare("SELECT value FROM usage_meta WHERE key = ?").get(key)?.value ?? null;
}

function setMeta(db, key, value) {
  db.prepare("INSERT INTO usage_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}

/** Read-only preflight; it never initializes the writer or repairs metadata. */
export function preflightUsageLedgerMigration(databasePath: string, legacyStoragePath: string) {
  if (!fs.existsSync(databasePath)) { readLegacyUsageEntries(legacyStoragePath); return; }
  const Database = require("better-sqlite3");
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const hasMeta = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='usage_meta'").get();
    if (!hasMeta || !getMeta(db, "legacy_migrated")) readLegacyUsageEntries(legacyStoragePath);
    if (db.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("usage ledger integrity check failed");
  } finally { db.close(); }
}

export function validateUsageLedgerDatabase(databasePath: string) {
  const Database = require("better-sqlite3");
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("usage ledger integrity check failed");
    if (!["done", "none"].includes(getMeta(db, "legacy_migrated"))) throw new Error("usage ledger import is incomplete");
    const zone = getMeta(db, "time_zone");
    if (!zone || !getMeta(db, "statistics_started_at")) throw new Error("usage ledger metadata is incomplete");
    new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format();
    const missing = db.prepare("SELECT COUNT(*) AS n FROM usage_entries e LEFT JOIN usage_seen_requests s ON e.request_id=s.request_id WHERE s.request_id IS NULL").get().n;
    const seen = db.prepare("SELECT COUNT(*) AS n FROM usage_seen_requests").get().n;
    const counted = db.prepare("SELECT COALESCE(SUM(request_count),0) AS n FROM usage_daily_rollups").get().n;
    if (missing || seen !== counted) throw new Error("usage ledger identity/rollup validation failed");
    for (const row of db.prepare("SELECT entry_json FROM usage_entries").all()) JSON.parse(row.entry_json);
  } finally { db.close(); }
}

export function readLegacyUsageEntries(legacyPath: string) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(legacyPath, "utf8")); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`failed to migrate usage ledger JSON at ${legacyPath}: ${error.message}`);
  }
  if (!Array.isArray(raw?.entries)) throw new Error("failed to migrate usage ledger: entries must be an array");
  return raw.entries.map((entry, index) => {
    if (!isPlainObject(entry) || typeof entry.requestId !== "string" || !entry.requestId.trim()) {
      throw new Error(`failed to migrate usage ledger: invalid entries[${index}] requestId`);
    }
    for (const value of [entry.startedAt, entry.endedAt ?? entry.startedAt]) {
      if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`failed to migrate usage ledger: invalid timestamp in entries[${index}]`);
    }
    return normalizeEntry({ ...entry, endedAt: entry.endedAt ?? null }, () => { throw new Error("legacy timestamp missing"); });
  });
}

function initializeDatabase(db, { timeZone, now, legacyPath, maxEntries }) {
  return db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS usage_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage_entries(entry_order INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL UNIQUE, started_at TEXT NOT NULL, ended_at TEXT NOT NULL, status TEXT NOT NULL, provider TEXT NOT NULL, model_id TEXT NOT NULL, entry_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage_seen_requests(request_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS usage_daily_rollups(
        stat_day TEXT NOT NULL, provider TEXT NOT NULL, model_id TEXT NOT NULL,
        request_count INTEGER NOT NULL DEFAULT 0, ok_count INTEGER NOT NULL DEFAULT 0, error_count INTEGER NOT NULL DEFAULT 0, aborted_count INTEGER NOT NULL DEFAULT 0, usage_missing_count INTEGER NOT NULL DEFAULT 0,
        input_tokens REAL NOT NULL DEFAULT 0, output_tokens REAL NOT NULL DEFAULT 0, total_tokens REAL NOT NULL DEFAULT 0, cache_read_tokens REAL NOT NULL DEFAULT 0, cache_write_tokens REAL NOT NULL DEFAULT 0,
        input_missing_count INTEGER NOT NULL DEFAULT 0, output_missing_count INTEGER NOT NULL DEFAULT 0, total_missing_count INTEGER NOT NULL DEFAULT 0, cache_read_missing_count INTEGER NOT NULL DEFAULT 0, cache_write_missing_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(stat_day, provider, model_id)
      );
      INSERT OR IGNORE INTO usage_seen_requests(request_id) SELECT request_id FROM usage_entries;
    `);
    const zone = getMeta(db, "time_zone") ?? timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format();
    if (!getMeta(db, "time_zone")) {
      setMeta(db, "time_zone", zone);
      setMeta(db, "statistics_started_at", toIso(now()));
      setMeta(db, "history_incomplete", "0");
    }
    if (!getMeta(db, "legacy_migrated")) {
      const entries = legacyPath ? readLegacyUsageEntries(legacyPath) : null;
      if (entries) {
        const write = createEntryWriter(db, zone, Number.MAX_SAFE_INTEGER);
        let earliest = null;
        for (const entry of entries) {
          write(entry);
          const at = entry.endedAt ?? entry.startedAt;
          if (!earliest || Date.parse(at) < Date.parse(earliest)) earliest = at;
        }
        if (earliest) setMeta(db, "legacy_earliest_at", earliest);
        setMeta(db, "history_incomplete", "1");
      }
      setMeta(db, "legacy_migrated", entries ? "done" : "none");
    }
    db.prepare(TRIM_SQL).run(maxEntries);
    return zone;
  })();
}

const TOKEN_FIELDS = [["input", "input"], ["output", "output"], ["total", "total"], ["cacheRead", "cache_read"], ["cacheWrite", "cache_write"]];
const STATUS_FIELDS = [["ok", "ok"], ["error", "error"], ["aborted", "aborted"], ["usageMissing", "usage_missing"]];

function createEntryWriter(db, timeZone, maxEntries) {
  const seen = db.prepare("INSERT OR IGNORE INTO usage_seen_requests(request_id) VALUES (?)");
  const insert = db.prepare("INSERT INTO usage_entries(request_id, started_at, ended_at, status, provider, model_id, entry_json) VALUES (@requestId, @startedAt, @endedAt, @status, @provider, @modelId, @entryJson)");
  const counters = ["request_count", ...STATUS_FIELDS.map(([, column]) => `${column}_count`), ...TOKEN_FIELDS.map(([, column]) => `${column}_tokens`), ...TOKEN_FIELDS.map(([, column]) => `${column}_missing_count`)];
  const columns = ["stat_day", "provider", "model_id", ...counters];
  const rollup = db.prepare(`INSERT INTO usage_daily_rollups(${columns.join(", ")}) VALUES (${columns.map(c => `@${c}`).join(", ")}) ON CONFLICT(stat_day, provider, model_id) DO UPDATE SET ${counters.map(c => `${c}=${c}+excluded.${c}`).join(", ")}`);
  const trim = db.prepare(TRIM_SQL);
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return entry => {
    const at = entry.endedAt ?? entry.startedAt;
    const date = new Date(at);
    if (!Number.isFinite(date.getTime())) throw new Error(`invalid usage timestamp: ${at}`);
    if (!seen.run(entry.requestId).changes) return false;
    const provider = entry.model.provider ?? "unknown";
    const modelId = entry.model.modelId ?? "unknown";
    insert.run({ requestId: entry.requestId, startedAt: entry.startedAt, endedAt: at, status: entry.status, provider, modelId, entryJson: JSON.stringify(entry) });
    const parts = Object.fromEntries(formatter.formatToParts(date).map(p => [p.type, p.value]));
    const values: Record<string, any> = { stat_day: `${parts.year}-${parts.month}-${parts.day}`, provider, model_id: modelId, request_count: 1 };
    const tokens = { input: entry.usage?.input?.totalTokens, output: entry.usage?.output?.totalTokens, total: entry.usage?.totalTokens, cacheRead: entry.usage?.cache?.readTokens, cacheWrite: entry.usage?.cache?.writeTokens };
    for (const [key, column] of TOKEN_FIELDS) {
      const value = numberOrNull(tokens[key]);
      values[`${column}_tokens`] = value ?? 0;
      values[`${column}_missing_count`] = value === null ? 1 : 0;
    }
    for (const [, column] of STATUS_FIELDS) values[`${column}_count`] = entry.status === column ? 1 : 0;
    rollup.run(values);
    trim.run(maxEntries);
    return true;
  };
}

function dailyRow(row) {
  return { date: row.stat_day, provider: row.provider, modelId: row.model_id, requestCount: row.request_count,
    statusCounts: Object.fromEntries(STATUS_FIELDS.map(([key, column]) => [key, row[`${column}_count`]])),
    tokens: Object.fromEntries(TOKEN_FIELDS.map(([key, column]) => [key, row[`${column}_tokens`]])),
    missingFieldCounts: Object.fromEntries(TOKEN_FIELDS.map(([key, column]) => [key, row[`${column}_missing_count`]])) };
}

function normalizeEntry(entry, now) {
  const usageContext = normalizeUsageContext({
    source: entry.source,
    attribution: entry.attribution,
  });
  const startedAt = typeof entry.startedAt === "string" ? entry.startedAt : toIso(now());
  const endedAt = entry.endedAt === null || typeof entry.endedAt === "string" ? entry.endedAt : toIso(now());
  return {
    schemaVersion: 1,
    requestId: String(entry.requestId || ""),
    startedAt,
    endedAt,
    durationMs: numberOrNull(entry.durationMs),
    status: normalizeStatus(entry.status),
    source: usageContext.source,
    attribution: usageContext.attribution,
    metadata: isPlainObject(entry.metadata) ? { ...entry.metadata } : null,
    model: normalizeModel(entry.model),
    usage: entry.usage ?? null,
    rawUsageShape: typeof entry.rawUsageShape === "string" ? entry.rawUsageShape : null,
    error: entry.error ?? null,
  };
}

function normalizeUsage(usage, options) {
  if (!isPlainObject(usage) || Object.keys(usage).length === 0) return null;
  if (usage.input && usage.output && usage.cache && Object.prototype.hasOwnProperty.call(usage, "totalTokens")) {
    return usage;
  }
  return normalizeLlmUsage(usage, { ...options, preserveMissingFields: true });
}

function normalizeModel(model: Record<string, any> = {}) {
  return {
    provider: textOrNull(model?.provider),
    modelId: textOrNull(model?.modelId ?? model?.id),
    api: textOrNull(model?.api),
  };
}

function normalizeError(error) {
  if (!error) return { name: null, message: null };
  return {
    name: typeof error.name === "string" ? error.name : null,
    message: typeof error.message === "string" ? error.message : String(error),
  };
}

function normalizeStatus(status) {
  if (status === "ok" || status === "error" || status === "aborted" || status === "usage_missing") {
    return status;
  }
  return "usage_missing";
}

function rawUsageShape(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  return Object.keys(usage).sort().join(",");
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function matchesFilter(entry, filter) {
  if (filter.since && entry.endedAt && entry.endedAt < filter.since) return false;
  if (filter.until && entry.startedAt && entry.startedAt > filter.until) return false;
  if (filter.status && entry.status !== filter.status) return false;
  if (filter.attributionKind && entry.attribution?.kind !== filter.attributionKind) return false;
  if (filter.sessionId && attributionSessionId(entry.attribution) !== filter.sessionId) return false;
  if (filter.sessionPath && attributionSessionPath(entry.attribution) !== filter.sessionPath) return false;
  if (filter.childSessionId && entry.attribution?.childSessionId !== filter.childSessionId) return false;
  if (filter.childSessionPath && entry.attribution?.childSessionPath !== filter.childSessionPath) return false;
  if (filter.agentId && entry.attribution?.agentId !== filter.agentId) return false;
  if (filter.subsystem && entry.source?.subsystem !== filter.subsystem) return false;
  if (filter.operation && entry.source?.operation !== filter.operation) return false;
  if (filter.modelId && entry.model?.modelId !== filter.modelId) return false;
  if (filter.provider && entry.model?.provider !== filter.provider) return false;
  return true;
}

function normalizeLimit(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function emit(eventBus, entry) {
  if (!eventBus || typeof eventBus.emit !== "function") return;
  try {
    eventBus.emit({ type: "llm_usage", entry }, attributionSessionPath(entry.attribution));
  } catch {
    // Usage observation must not break the model request path.
  }
}

function warn(logger, message) {
  try {
    logger?.warn?.(message);
  } catch {
    // Diagnostics should never affect request accounting.
  }
}

function entryHasUnknownUsageContext(entry) {
  return isUnknownUsageContextValue({
    source: entry.source,
    attribution: entry.attribution,
  });
}

function clone(value) {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function toIso(ms) {
  return new Date(ms).toISOString();
}

function textOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
