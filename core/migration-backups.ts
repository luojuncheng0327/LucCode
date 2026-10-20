/**
 * The one place that names the directory where migrations park their backups.
 *
 * The name used to be spelled independently by every module that touched it:
 * the migrations that copy the provider catalog aside, the retention pass that
 * prunes old copies, and the startup pass that tightens their permissions. That
 * shape has already cost real coverage elsewhere in this area, where a list of
 * directories to walk drifted from the name its writer actually used and the
 * pass ended up scanning a path that never existed, silently doing nothing.
 * Import the name from here rather than spelling it again.
 */
import path from "path";

/** Directory under the data directory that holds migration backups. */
export const MIGRATION_BACKUPS_DIR = "migration-backups";

/** Absolute path to the migration backup root inside a data directory. */
export function migrationBackupsRoot(lucHome: string): string {
  return path.join(lucHome, MIGRATION_BACKUPS_DIR);
}
