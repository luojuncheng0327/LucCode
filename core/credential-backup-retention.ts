/**
 * Retention policy for the migration backups that hold copies of credentials.
 *
 * Migrations copy the provider catalog aside before rewriting it, so a rollback
 * is possible if the rewrite goes wrong. Those copies contain the same
 * credentials as the live catalog, and nothing removed them afterwards, so a
 * credential a user removed from the application could still exist in a copy
 * indefinitely. That gap between what the user removed and what remains on disk
 * is what this closes.
 *
 * Removal is not reversible, so it only happens when the backup has stopped
 * being useful on both counts: it is older than the retention window, and the
 * live catalog it could roll back to is readable and populated. If the live
 * catalog is missing, unparseable, or empty, every backup is kept regardless of
 * age, because that is exactly the situation a rollback exists for. Each
 * decision is logged, kept ones included, so the policy is auditable rather
 * than silent.
 *
 * The health check deliberately reads and parses the catalog file directly
 * instead of going through the catalog store: the store's loader falls back to
 * migrating the legacy file when the catalog is absent, which would make a
 * cleanup pass rewrite state as a side effect of asking a question.
 *
 * Deleting this module means dropping its single call in the engine startup
 * sequence; nothing else depends on it.
 */
import fs from "fs";
import path from "path";

import { migrationBackupsRoot } from "./migration-backups.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a migration backup stays useful for rolling back. */
export const CREDENTIAL_BACKUP_MAX_AGE_MS = 90 * DAY_MS;

const LIVE_CATALOG_FILE = "provider-catalog.json";

export interface BackupRetentionResult {
  /** Backup directory names removed this run. */
  removed: string[];
  /** Backups left in place, with the reason each one was kept. */
  kept: Array<{ name: string; reason: string }>;
}

interface PruneOptions {
  lucHome: string;
  now?: number;
  maxAgeMs?: number;
  log?: (line: string) => void;
}

export function pruneStaleCredentialBackups({
  lucHome,
  now = Date.now(),
  maxAgeMs = CREDENTIAL_BACKUP_MAX_AGE_MS,
  log = () => {},
}: PruneOptions): BackupRetentionResult {
  const result: BackupRetentionResult = { removed: [], kept: [] };
  // Refuse rather than quietly do nothing, for the same reason the healer does:
  // an absent data directory means a caller mistake, not an empty workload.
  if (!lucHome) throw new Error("credential backup retention requires a data directory");

  const backupRoot = migrationBackupsRoot(lucHome);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(backupRoot, { withFileTypes: true });
  } catch {
    return result; // no backups on this machine
  }

  const directories = entries.filter((entry) => entry.isDirectory());
  if (directories.length === 0) return result;

  const rollbackTargetIsHealthy = liveCatalogIsUsable(path.join(lucHome, LIVE_CATALOG_FILE));

  for (const entry of directories) {
    const name = entry.name;
    const dir = path.join(backupRoot, name);

    if (!rollbackTargetIsHealthy) {
      keep(result, log, name, "live-catalog-unusable");
      continue;
    }

    let ageMs: number;
    try {
      ageMs = now - fs.statSync(dir).mtimeMs;
    } catch {
      keep(result, log, name, "unreadable");
      continue;
    }

    if (ageMs <= maxAgeMs) {
      keep(result, log, name, "within-retention-window");
      continue;
    }

    try {
      fs.rmSync(dir, { recursive: true, force: true });
      result.removed.push(name);
      log(`[credential-custody] removed expired migration backup ${name}`);
    } catch (err: any) {
      keep(result, log, name, `removal-failed:${err?.code || "unknown"}`);
    }
  }

  return result;
}

function keep(
  result: BackupRetentionResult,
  log: (line: string) => void,
  name: string,
  reason: string,
): void {
  result.kept.push({ name, reason });
  log(`[credential-custody] kept migration backup ${name} (${reason})`);
}

/**
 * Whether the live catalog is in a state where a rollback would no longer be
 * needed. Reads the file directly so that asking the question cannot rewrite
 * anything.
 */
function liveCatalogIsUsable(catalogPath: string): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(catalogPath, "utf-8");
  } catch {
    return false;
  }
  try {
    const parsed = JSON.parse(raw);
    const providers = parsed?.providers;
    return !!providers && typeof providers === "object" && Object.keys(providers).length > 0;
  } catch {
    return false;
  }
}
