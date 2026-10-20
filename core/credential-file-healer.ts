/**
 * Startup pass that brings existing credential files up to the owner-only
 * storage contract.
 *
 * Writing new files with the right permissions only covers files written after
 * an upgrade. Anything already on disk keeps whatever permissions it was
 * created with, and a file that is never rewritten would keep them forever.
 * This runs on every startup rather than once, because permissions can also
 * drift afterwards: restoring from a backup, copying a data directory between
 * machines, or syncing it all reintroduce the original permissions long after
 * a one-shot migration would have finished.
 *
 * Running every time is safe because the pass is idempotent and silent when
 * there is nothing to correct. Every correction is logged, so this is a stated
 * contract about how the data directory is kept rather than an invisible fixup.
 *
 * Deleting this module means dropping its single call in the engine startup
 * sequence; nothing else depends on it.
 */
import fs from "fs";
import path from "path";

import { AppError } from "../shared/errors.ts";
import { errorBus } from "../shared/error-bus.ts";
import { CONFIG_SCOPE_BACKUP_SUFFIX } from "../shared/migrate-config-scope.ts";
import { ensureSecretDirModeSync, ensureSecretFileModeSync, SECRET_TMP_SUFFIX } from "../shared/secret-fs.ts";
import { LOCAL_PROVIDER_PLUGINS_DIR } from "./local-provider-plugin-store.ts";
import { MIGRATION_BACKUPS_DIR } from "./migration-backups.ts";
import { PLUGIN_CONFIG_FILENAME, PLUGIN_DATA_DIRNAME } from "./plugin-config.ts";
import { SECURITY_DIR } from "./security-dir.ts";

/** Files directly under the data directory that hold credentials. */
export const TOP_LEVEL_SECRET_FILES = [
  "provider-catalog.json",
  "models.json",
  "added-models.yaml",
  "auth.json",
  "device-credentials.json",
  "devices.json",
  "pairing-sessions.json",
  "local-user-auth.json",
  "users.json",
  "web-sessions.json",
];

/**
 * Directory trees whose contents are credential material throughout.
 * The local provider plugin tree holds each locally defined provider, whose
 * definition carries that provider's key. The security tree holds the signing
 * keys behind resource tickets and plugin sessions, plus the grant and lease
 * records those keys authorise; they are written owner-only, but nothing else
 * ever rewrites a key file, so permissions a backup restore or a copied data
 * directory reintroduces would stay loose for good.
 *
 * Every directory name is taken from the module that owns it rather than
 * repeated here. Spelling one out once cost real coverage: this list said
 * "providers" while the store wrote to "provider-plugins", so the healer walked
 * a path that never existed and silently corrected nothing.
 */
export const SECRET_TREES = [MIGRATION_BACKUPS_DIR, LOCAL_PROVIDER_PLUGINS_DIR, SECURITY_DIR];

const AGENT_CONFIG_FILE = "config.yaml";
/**
 * The scope migration keeps a one-time copy of each agent configuration, taken
 * before it strips the global fields out. That copy holds the same credentials
 * as the original and is written once and never rewritten, so nothing else
 * would ever bring an older one up to the current contract.
 */
const AGENT_CONFIG_BACKUP_FILE = `${AGENT_CONFIG_FILE}${CONFIG_SCOPE_BACKUP_SUFFIX}`;
/**
 * Older versions rewrote agent configuration by writing a temporary copy with
 * whatever permissions the system hands out by default and then renaming it
 * over the original. A crash in between leaves that copy sitting there with the
 * whole configuration in it, and nothing ever rewrites it, so it would keep
 * those permissions for as long as the data directory exists.
 */
const AGENT_CONFIG_TMP_FILE = `${AGENT_CONFIG_FILE}${SECRET_TMP_SUFFIX}`;
const MAX_TREE_DEPTH = 6;

interface HealOptions {
  lucHome: string;
  log?: (line: string) => void;
}

export interface CredentialHealResult {
  /** Paths relative to the data directory that were tightened this run. */
  healed: string[];
  /** Paths that could not be tightened; each one was reported. */
  failed: string[];
}

export function healCredentialFileModes({ lucHome, log = () => {} }: HealOptions): CredentialHealResult {
  const result: CredentialHealResult = { healed: [], failed: [] };
  // Refuse rather than quietly do nothing: without a data directory there is
  // no work to skip, only a caller passing the wrong thing, and silently
  // succeeding would hide that the files were never protected at all.
  if (!lucHome) throw new Error("credential file healer requires a data directory");

  const relative = (target: string) => path.relative(lucHome, target) || ".";

  const apply = (target: string, tighten: (p: string) => boolean) => {
    try {
      if (tighten(target)) {
        const rel = relative(target);
        result.healed.push(rel);
        log(`[credential-custody] tightened ${rel}`);
      }
    } catch (err: any) {
      const rel = relative(target);
      result.failed.push(rel);
      log(`[credential-custody] could not tighten ${rel}: ${err?.code || err?.message || "unknown error"}`);
      // Logged, never surfaced: a file whose mode could not be tightened is
      // worth a record, but the application still works and interrupting the
      // user over it would be out of proportion. Some filesystems (removable
      // media, network mounts) reject the change outright and would otherwise
      // complain on every single launch.
      errorBus.report(
        new AppError("FS_PERMISSION", { cause: err, context: { relativePath: rel } }),
        { route: "silent", dedupeKey: `credential-custody:${rel}` },
      );
    }
  };

  const healFile = (target: string) => apply(target, ensureSecretFileModeSync);
  const healDir = (target: string) => apply(target, ensureSecretDirModeSync);

  healDir(lucHome);

  for (const name of TOP_LEVEL_SECRET_FILES) {
    healFile(path.join(lucHome, name));
  }

  for (const agentDir of subdirectories(path.join(lucHome, "agents"))) {
    healFile(path.join(agentDir, AGENT_CONFIG_FILE));
    healFile(path.join(agentDir, AGENT_CONFIG_BACKUP_FILE));
    healFile(path.join(agentDir, AGENT_CONFIG_TMP_FILE));
  }

  for (const tree of SECRET_TREES) {
    healTree(path.join(lucHome, tree), 0, healDir, healFile);
  }

  // Plugin configuration can hold connector and service credentials. Only the
  // configuration file is corrected: the rest of a plugin's data directory
  // holds downloads, job state and generated output owned by other stores, and
  // flattening those would both overstep this pass and strip modes those files
  // legitimately carry. Names come from the module that writes them.
  for (const pluginDir of subdirectories(path.join(lucHome, PLUGIN_DATA_DIRNAME))) {
    healFile(path.join(pluginDir, PLUGIN_CONFIG_FILENAME));
  }

  // Migration checkpoints copy the agents directory wholesale, so the same
  // configuration files exist a second time inside each checkpoint.
  const checkpointRoot = path.join(lucHome, "checkpoints", "session-manifest");
  for (const checkpoint of subdirectories(checkpointRoot)) {
    for (const agentDir of subdirectories(path.join(checkpoint, "agents"))) {
      healFile(path.join(agentDir, AGENT_CONFIG_FILE));
      healFile(path.join(agentDir, AGENT_CONFIG_BACKUP_FILE));
      healFile(path.join(agentDir, AGENT_CONFIG_TMP_FILE));
    }
  }

  return result;
}

function healTree(
  root: string,
  depth: number,
  healDir: (target: string) => void,
  healFile: (target: string) => void,
): void {
  if (depth > MAX_TREE_DEPTH) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return; // absent or unreadable: nothing to correct here
  }
  healDir(root);
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) healTree(target, depth + 1, healDir, healFile);
    else if (entry.isFile()) healFile(target);
  }
}

function subdirectories(root: string): string[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}
