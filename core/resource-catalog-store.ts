import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
export const RESOURCE_CATALOG_SCHEMA_VERSION = 1;

/**
 * M1.4 owns the catalog schema and connection lifecycle. Resource adoption,
 * relocation and resource-IO APIs are separate M2 work.
 */
export class ResourceCatalogStore {
  declare db: any;

  constructor({ dbPath }: { dbPath: string }) {
    if (typeof dbPath !== "string" || !dbPath.trim()) {
      throw new Error("ResourceCatalogStore requires dbPath");
    }
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    const Database = require("better-sqlite3");
    this.db = new Database(path.resolve(dbPath));
    try {
      const version = Number(this.db.pragma("user_version", { simple: true }));
      if (version > RESOURCE_CATALOG_SCHEMA_VERSION) {
        throw new Error("resource catalog schema " + version + " is newer than supported schema " + RESOURCE_CATALOG_SCHEMA_VERSION);
      }
      // Refuse a stamped but damaged schema before attempting index repairs.
      if (version !== 0) this._validateSchema();
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("busy_timeout = 5000");
      this.db.transaction(() => {
        if (version === 0) {
          this.db.exec(`
            CREATE TABLE local_resources (
              resource_id TEXT PRIMARY KEY,
              normalized_path TEXT NOT NULL,
              real_path TEXT NOT NULL,
              locator_key TEXT NOT NULL UNIQUE,
              file_kind TEXT NOT NULL CHECK(file_kind IN ('file', 'directory')),
              status TEXT NOT NULL CHECK(status IN ('available', 'missing')),
              size INTEGER,
              mtime_ms REAL,
              fingerprint_dev TEXT,
              fingerprint_ino TEXT,
              fingerprint_birthtime_ms REAL,
              fingerprint_key TEXT,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              missing_at INTEGER
            );
          `);
        }
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_local_resources_fingerprint
            ON local_resources(fingerprint_key) WHERE fingerprint_key IS NOT NULL;
          CREATE INDEX IF NOT EXISTS idx_local_resources_normalized_path
            ON local_resources(normalized_path);
          CREATE INDEX IF NOT EXISTS idx_local_resources_real_path
            ON local_resources(real_path);
          CREATE INDEX IF NOT EXISTS idx_local_resources_status
            ON local_resources(status, updated_at);
        `);
        this.db.pragma("user_version = " + RESOURCE_CATALOG_SCHEMA_VERSION);
      })();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  _validateSchema(): void {
    try {
      this.db.prepare(`
        SELECT resource_id, normalized_path, real_path, locator_key, file_kind,
          status, size, mtime_ms, fingerprint_dev, fingerprint_ino,
          fingerprint_birthtime_ms, fingerprint_key, created_at, updated_at, missing_at
        FROM local_resources LIMIT 0
      `).get();
    } catch (cause) {
      throw new Error("resource catalog schema is invalid", { cause });
    }
  }

  close(): void {
    if (this.db?.open) this.db.close();
  }
}

export function createResourceCatalogStore({ lucHome }: { lucHome: string }): ResourceCatalogStore {
  return new ResourceCatalogStore({ dbPath: path.join(lucHome, "workspace-state", "resources.sqlite") });
}
