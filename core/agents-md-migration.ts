/**
 * Startup pass that brings agent directories onto the current persona file
 * names.
 *
 * The per-agent persona file used to be called ishiki.md, with public-ishiki.md
 * for the outward-facing variant. Both are now AGENTS.md and AGENTS.public.md.
 * Renaming the files here, at the data-directory boundary, is what lets the
 * persona fallback chain read exactly one name: if this pass did not exist,
 * every reader would have to try the new name and then the old one forever, and
 * that second lookup would quietly become permanent.
 *
 * This runs on every startup rather than once. A directory carrying the old
 * names can appear long after a one-shot migration would have finished --
 * restoring from a backup, copying a data directory between machines, or a file
 * sync bringing an old agent directory back. Running every time is cheap: with
 * nothing to rename it is one directory listing per agent.
 *
 * Nothing is ever deleted or overwritten. When both names exist, the new one
 * wins and the old one is set aside under a suffixed name, because the user may
 * have edited either of them and only they can say which one they meant.
 *
 * Deleting this module means dropping its single call in the engine startup
 * sequence; nothing else depends on it.
 */
import fs from "fs";
import path from "path";

export interface LegacyPersonaFileRename {
  legacyFileName: string;
  currentFileName: string;
}

export const LEGACY_PERSONA_FILE_RENAMES: LegacyPersonaFileRename[] = [
  { legacyFileName: "ishiki.md", currentFileName: "AGENTS.md" },
  { legacyFileName: "public-ishiki.md", currentFileName: "AGENTS.public.md" },
];

/**
 * Suffix for a legacy file that could not simply be renamed because the current
 * name was already taken. It stays in the agent directory, so the user can look
 * at it and decide, and it is named so it is obvious where it came from.
 */
export const SUPERSEDED_LEGACY_PERSONA_SUFFIX = ".pre-agents-rename.bak";

export interface MigrateAgentPersonaFileNamesOptions {
  /** The data directory's agents/ folder. */
  agentsDir: string;
  log?: (line: string) => void;
}

export interface MigrateAgentPersonaFileNamesResult {
  /** "<agentDirName>/<currentFileName>" for each file renamed into place. */
  renamed: string[];
  /** "<agentDirName>/<legacyFileName><suffix>" for each legacy file set aside. */
  superseded: string[];
  /** "<agentDirName>/<legacyFileName>" for each file that could not be moved. */
  failed: string[];
}

function agentDirectories(agentsDir: string): string[] {
  try {
    return fs.readdirSync(agentsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    // No agents directory yet (first run) or it is unreadable. Either way there
    // is nothing here to rename.
    return [];
  }
}

function fileExists(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/**
 * First set-aside name that is not taken yet. A legacy file can come back more
 * than once (one restore per backup), and each of those copies is user data
 * that must not overwrite an earlier one.
 */
function availableSupersededPath(agentDir: string, legacyFileName: string): string {
  const base = `${legacyFileName}${SUPERSEDED_LEGACY_PERSONA_SUFFIX}`;
  const first = path.join(agentDir, base);
  if (!fs.existsSync(first)) return first;
  const withoutExtension = base.slice(0, -".bak".length);
  for (let attempt = 2; ; attempt += 1) {
    const candidate = path.join(agentDir, `${withoutExtension}-${attempt}.bak`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

export function migrateAgentPersonaFileNames({
  agentsDir,
  log = () => {},
}: MigrateAgentPersonaFileNamesOptions): MigrateAgentPersonaFileNamesResult {
  const result: MigrateAgentPersonaFileNamesResult = { renamed: [], superseded: [], failed: [] };
  if (!agentsDir) throw new Error("AGENTS.md migration requires an agents directory");

  for (const agentDirName of agentDirectories(agentsDir)) {
    const agentDir = path.join(agentsDir, agentDirName);
    for (const { legacyFileName, currentFileName } of LEGACY_PERSONA_FILE_RENAMES) {
      const legacyPath = path.join(agentDir, legacyFileName);
      // Each file is handled on its own so that one unreadable or locked agent
      // directory cannot stop the others from being migrated, and cannot stop
      // the application from starting.
      try {
        if (!fileExists(legacyPath)) continue;
        const currentPath = path.join(agentDir, currentFileName);
        if (fs.existsSync(currentPath)) {
          const supersededPath = availableSupersededPath(agentDir, legacyFileName);
          fs.renameSync(legacyPath, supersededPath);
          const record = `${agentDirName}/${path.basename(supersededPath)}`;
          result.superseded.push(record);
          log(`[agents-md-rename] ${agentDirName}/${currentFileName} already exists; kept it and set aside ${record}`);
          continue;
        }
        fs.renameSync(legacyPath, currentPath);
        result.renamed.push(`${agentDirName}/${currentFileName}`);
        log(`[agents-md-rename] renamed ${agentDirName}/${legacyFileName} to ${currentFileName}`);
      } catch (err: any) {
        const record = `${agentDirName}/${legacyFileName}`;
        result.failed.push(record);
        // Logged and carried, never fatal: the persona still resolves from the
        // template fallback, and the untouched legacy file stays where it is
        // for the next startup to retry.
        log(`[agents-md-rename] could not migrate ${record}: ${err?.code || err?.message || "unknown error"}`);
      }
    }
  }

  return result;
}
