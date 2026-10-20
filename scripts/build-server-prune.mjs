import fs from "fs";
import path from "path";

/**
 * Runtime-dead file extensions that can never be loaded from node_modules
 * at server runtime: .ts/.mts/.cts source (Node refuses type stripping inside
 * node_modules), .map source maps (server ships with --enable-source-maps
 * never set), and .md docs (no runtime code path in node_modules reads
 * package-bundled markdown; the only .md reader in the dependency tree is a
 * vendored CLI --help path the server process never executes).
 */
const RUNTIME_DEAD_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".map", ".md"]);

/**
 * Basename prefixes that must be kept even when their extension matches
 * RUNTIME_DEAD_EXTENSIONS, to preserve third-party license/notice compliance
 * (e.g. LICENSE.md, LICENSE, NOTICE, COPYING.md).
 */
const PROTECTED_PREFIX_PATTERN = /^(license|licence|copying|notice)/i;

/**
 * Pure predicate: does this file basename represent dead weight that the
 * server bundle can never load at runtime from within node_modules?
 *
 * @param {string} fileName - basename only (not a path).
 * @returns {boolean}
 */
export function shouldPruneRuntimeDeadFile(fileName) {
  if (PROTECTED_PREFIX_PATTERN.test(fileName)) return false;
  const ext = path.extname(fileName).toLowerCase();
  return RUNTIME_DEAD_EXTENSIONS.has(ext);
}

/**
 * Recursively walk a node_modules directory and delete files/symlinks that
 * shouldPruneRuntimeDeadFile flags. Directories emptied by this pass are
 * removed too. Does not follow symlinked directories (fs.readdirSync with
 * withFileTypes reports a symlink-to-directory's isDirectory() as false, so
 * it is treated as a leaf entry and never recursed into).
 *
 * @param {string} nmDir - absolute path to a node_modules directory.
 * @returns {{ removedFiles: number, removedSize: number }}
 */
export function pruneRuntimeDeadFiles(nmDir) {
  let removedFiles = 0;
  let removedSize = 0;

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        try {
          const remaining = fs.readdirSync(full);
          if (remaining.length === 0) fs.rmdirSync(full);
        } catch {
          // Best-effort: directory may be gone already or non-empty due to a
          // concurrent process; not fatal to the prune pass.
        }
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (shouldPruneRuntimeDeadFile(entry.name)) {
          try {
            const size = entry.isFile() ? (fs.statSync(full).size || 0) : 0;
            fs.unlinkSync(full);
            removedFiles++;
            removedSize += size;
          } catch {
            // Best-effort: file may already be gone; not fatal to the prune pass.
          }
        }
      }
    }
  }

  walk(nmDir);
  return { removedFiles, removedSize };
}
