// 单工作区的文件历史快照库。一个工作区一个 SQLite 文件，文本内容 gzip 后存 blob。
// 上限核算用库内 stored_size 总和，不用 DB 文件大小（SQLite 删行不缩文件），
// 配 auto_vacuum=INCREMENTAL 在清理后归还磁盘。
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { createHash } from "crypto";
import { gzipSync, gunzipSync } from "zlib";

const require = createRequire(import.meta.url);
let BetterSqliteDatabase: any = null;
function loadDatabase() {
  if (!BetterSqliteDatabase) {
    const mod = require("better-sqlite3");
    BetterSqliteDatabase = mod?.default || mod;
  }
  return BetterSqliteDatabase;
}

export const FILE_HISTORY_SCHEMA_VERSION = 1;

export type SnapshotOrigin = "event" | "watcher" | "sweep" | "restore";

export type RecordSnapshotInput = {
  relPath: string;
  content: Buffer;
  origin: SnapshotOrigin;
  opContext?: string | null;
  capturedAt?: number;
};

export type RecordSnapshotResult = {
  status: "inserted" | "merged" | "unchanged";
  snapshotId: number;
};

export class FileHistoryStore {
  declare _db: any;
  declare _mergeWindowMs: number;
  declare _now: () => number;

  constructor({ dbPath, mergeWindowMs = 60_000, now = () => Date.now() }: {
    dbPath: string; mergeWindowMs?: number; now?: () => number;
  }) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const Database = loadDatabase();
    this._db = new Database(dbPath);
    this._mergeWindowMs = mergeWindowMs;
    this._now = now;
    // auto_vacuum 必须在建表前设置才对新库生效
    this._db.pragma("auto_vacuum = INCREMENTAL");
    this._db.pragma("journal_mode = WAL");
    this._db.pragma("foreign_keys = ON");
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS files(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rel_path TEXT NOT NULL UNIQUE,
        deleted_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS snapshots(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        content_hash TEXT NOT NULL,
        content BLOB NOT NULL,
        raw_size INTEGER NOT NULL,
        stored_size INTEGER NOT NULL,
        captured_at INTEGER NOT NULL,
        origin TEXT NOT NULL,
        op_context TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_file_time ON snapshots(file_id, captured_at DESC);
      CREATE INDEX IF NOT EXISTS idx_snapshots_time ON snapshots(captured_at);
    `);
    const versionRow = this._db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    if (!versionRow) {
      this._db.prepare("INSERT INTO meta(key, value) VALUES('schema_version', ?)").run(String(FILE_HISTORY_SCHEMA_VERSION));
    } else if (Number(versionRow.value) > FILE_HISTORY_SCHEMA_VERSION) {
      this._db.close();
      throw new Error(`file-history schema version ${versionRow.value} is newer than supported ${FILE_HISTORY_SCHEMA_VERSION}`);
    }
  }

  recordSnapshot({ relPath, content, origin, opContext = null, capturedAt = this._now() }: RecordSnapshotInput): RecordSnapshotResult {
    const hash = createHash("sha256").update(content).digest("hex");
    const file = this._ensureFile(relPath);
    const latest = this._db.prepare(
      "SELECT id, content_hash, captured_at, origin FROM snapshots WHERE file_id = ? ORDER BY captured_at DESC, id DESC LIMIT 1",
    ).get(file.id);

    if (latest && latest.content_hash === hash) {
      this._clearDeleted(file.id);
      return { status: "unchanged", snapshotId: latest.id };
    }

    const gz = gzipSync(content);
    const withinWindow = latest
      && capturedAt - latest.captured_at < this._mergeWindowMs
      && capturedAt - latest.captured_at >= 0
      && latest.origin !== "restore"
      && origin !== "restore";

    if (withinWindow) {
      this._db.prepare(
        "UPDATE snapshots SET content_hash = ?, content = ?, raw_size = ?, stored_size = ?, captured_at = ?, origin = ?, op_context = ? WHERE id = ?",
      ).run(hash, gz, content.length, gz.length, capturedAt, origin, opContext, latest.id);
      this._clearDeleted(file.id);
      return { status: "merged", snapshotId: latest.id };
    }

    const info = this._db.prepare(
      "INSERT INTO snapshots(file_id, content_hash, content, raw_size, stored_size, captured_at, origin, op_context) VALUES(?,?,?,?,?,?,?,?)",
    ).run(file.id, hash, gz, content.length, gz.length, capturedAt, origin, opContext);
    this._clearDeleted(file.id);
    return { status: "inserted", snapshotId: Number(info.lastInsertRowid) };
  }

  latestHash(relPath: string): string | null {
    const row = this._db.prepare(
      "SELECT s.content_hash AS hash FROM snapshots s JOIN files f ON f.id = s.file_id WHERE f.rel_path = ? ORDER BY s.captured_at DESC, s.id DESC LIMIT 1",
    ).get(relPath);
    return row ? row.hash : null;
  }

  markDeleted(relPath: string, at: number = this._now()): void {
    this._db.prepare("UPDATE files SET deleted_at = ? WHERE rel_path = ?").run(at, relPath);
  }

  renamePath(oldRelPath: string, newRelPath: string): boolean {
    const oldRow = this._db.prepare("SELECT id FROM files WHERE rel_path = ?").get(oldRelPath);
    if (!oldRow) return false;
    const newRow = this._db.prepare("SELECT id FROM files WHERE rel_path = ?").get(newRelPath);
    if (newRow) {
      // 目标路径已有历史：把旧路径的快照并入目标，旧行删除
      this._db.prepare("UPDATE snapshots SET file_id = ? WHERE file_id = ?").run(newRow.id, oldRow.id);
      this._db.prepare("DELETE FROM files WHERE id = ?").run(oldRow.id);
      this._clearDeleted(newRow.id);
      return true;
    }
    this._db.prepare("UPDATE files SET rel_path = ?, deleted_at = NULL WHERE id = ?").run(newRelPath, oldRow.id);
    return true;
  }

  listFiles(): Array<{ relPath: string; deletedAt: number | null; lastCapturedAt: number; snapshotCount: number }> {
    return this._db.prepare(`
      SELECT f.rel_path AS relPath, f.deleted_at AS deletedAt,
             MAX(s.captured_at) AS lastCapturedAt, COUNT(s.id) AS snapshotCount
      FROM files f JOIN snapshots s ON s.file_id = f.id
      GROUP BY f.id ORDER BY lastCapturedAt DESC
    `).all();
  }

  listVersions(relPath: string): Array<{ id: number; capturedAt: number; origin: SnapshotOrigin; opContext: string | null; rawSize: number }> {
    return this._db.prepare(`
      SELECT s.id AS id, s.captured_at AS capturedAt, s.origin AS origin,
             s.op_context AS opContext, s.raw_size AS rawSize
      FROM snapshots s JOIN files f ON f.id = s.file_id
      WHERE f.rel_path = ? ORDER BY s.captured_at DESC, s.id DESC
    `).all(relPath);
  }

  getSnapshotContent(snapshotId: number): { relPath: string; content: Buffer; capturedAt: number; origin: SnapshotOrigin } {
    const row = this._db.prepare(`
      SELECT f.rel_path AS relPath, s.content AS content, s.captured_at AS capturedAt, s.origin AS origin
      FROM snapshots s JOIN files f ON f.id = s.file_id WHERE s.id = ?
    `).get(snapshotId);
    if (!row) throw new Error(`file-history snapshot ${snapshotId} not found`);
    return { relPath: row.relPath, content: gunzipSync(row.content), capturedAt: row.capturedAt, origin: row.origin };
  }

  totalStoredBytes(): number {
    const row = this._db.prepare("SELECT COALESCE(SUM(stored_size), 0) AS total FROM snapshots").get();
    return row.total;
  }

  enforceRetention({ maxAgeMs, maxTotalBytes, now = this._now() }: { maxAgeMs: number; maxTotalBytes: number; now?: number }): void {
    this._db.prepare("DELETE FROM snapshots WHERE captured_at < ?").run(now - maxAgeMs);
    while (this.totalStoredBytes() > maxTotalBytes) {
      const removed = this._db.prepare(
        "DELETE FROM snapshots WHERE id IN (SELECT id FROM snapshots ORDER BY captured_at ASC, id ASC LIMIT 100)",
      ).run();
      if (!removed.changes) break;
    }
    this._db.prepare("DELETE FROM files WHERE id NOT IN (SELECT DISTINCT file_id FROM snapshots)").run();
    this._db.pragma("incremental_vacuum");
  }

  close(): void {
    this._db.close();
  }

  _ensureFile(relPath: string): { id: number; deleted_at: number | null } {
    const existing = this._db.prepare("SELECT id, deleted_at FROM files WHERE rel_path = ?").get(relPath);
    if (existing) return existing;
    const info = this._db.prepare("INSERT INTO files(rel_path) VALUES(?)").run(relPath);
    return { id: Number(info.lastInsertRowid), deleted_at: null };
  }

  _clearDeleted(fileId: number): void {
    this._db.prepare("UPDATE files SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL").run(fileId);
  }
}
