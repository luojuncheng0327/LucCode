import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { DataEpochCheckpointProvider } from "./data-epoch-coordinator.ts";
import { readDataEpochJournal } from "../shared/data-epoch.cjs";
import { PERSISTENT_STORES } from "../shared/persistence/store-registry.ts";
import type { StoreDescriptor } from "../shared/persistence/store-registry-types.ts";

/**
 * core/data-epoch-checkpoint-provider.ts
 *
 * Production implementation of the coordinator's frozen
 * `DataEpochCheckpointProvider` interface (core/data-epoch-coordinator.ts).
 * Captures a byte-verifiable snapshot of every affected store before the
 * coordinator raises the reader barrier, and offers an explicit (opt-in)
 * retention prune. This module never changes coordinator behavior and is
 * not wired into any startup path — that wiring is a later slice.
 *
 * Layout on disk (published only after every item is captured and
 * `metadata.json` is fully written — see `create()`):
 *
 *   {homeDir}/data-epoch-checkpoints/{transitionId}/
 *     metadata.json          # formatVersion, transitionId, from/toEpoch,
 *                             # affectedStoreIds, createdAt, items, complete
 *     stores/{storeId}/…captured bytes, mirroring each item's relPath…
 *
 * Capture strategy is derived from each affected store's registry `format`:
 *   - sqlite: better-sqlite3 online backup API (correctly folds in
 *     un-checkpointed WAL content; never a raw copy of a live database file)
 *   - single-file json/yaml/jsonl/etc: byte-for-byte copy
 *   - directory trees / mixed-directory: every file under each matched
 *     pattern instance, copied and hashed individually
 */

export const DATA_EPOCH_CHECKPOINT_FORMAT_VERSION = 1;
export const DATA_EPOCH_CHECKPOINTS_DIRNAME = "data-epoch-checkpoints";
export const DATA_EPOCH_CHECKPOINT_RETAINED_COUNT = 2;
export const DATA_EPOCH_CHECKPOINT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

export interface DataEpochCheckpointItem {
  storeId: string;
  relPath: string;
  bytes: number;
  sha256: string;
}

export interface DataEpochCheckpointMetadata {
  formatVersion: number;
  transitionId: string;
  fromEpoch: number;
  toEpoch: number;
  affectedStoreIds: string[];
  createdAt: string;
  items: DataEpochCheckpointItem[];
  complete: true;
}

export interface DataEpochCheckpointReceipt {
  id: string;
  dir: string;
  itemCount: number;
  totalBytes: number;
  [key: string]: unknown;
}

export interface StorePathMatch {
  absPath: string;
  relPath: string;
  isDirectory: boolean;
}

export interface DataEpochCheckpointProviderOptions {
  stores?: readonly StoreDescriptor[];
  clock?: () => Date | string;
}

export interface DataEpochCheckpointPruneResult {
  retained: string[];
  removed: string[];
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function timestamp(clock: (() => Date | string) | undefined): string {
  const value = clock ? clock() : new Date();
  const result = value instanceof Date ? value.toISOString() : value;
  if (typeof result !== "string" || Number.isNaN(Date.parse(result))) {
    throw new Error("data epoch checkpoint provider clock returned an invalid timestamp");
  }
  return result;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.promises.access(candidate);
    return true;
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Pattern expander: turns a registry pathPattern (with `{placeholder}`
// segments matching exactly one non-empty path segment) into every path that
// actually exists on disk under a base directory. Zero matches is a legal
// empty capture; malformed pattern syntax fails closed with a thrown error.
// ---------------------------------------------------------------------------

type SegmentMatcher =
  | { kind: "literal"; value: string }
  | { kind: "pattern"; regex: RegExp };

function validatePatternShape(pattern: string): string[] {
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new Error("store path pattern must be a non-empty string");
  }
  if (pattern.startsWith("/") || pattern.includes("\\") || /^[A-Za-z]:/.test(pattern)) {
    throw new Error(`store path pattern must be a relative POSIX path: ${pattern}`);
  }
  const segments = pattern.split("/");
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new Error(`store path pattern has an empty path segment: ${pattern}`);
    }
    if (segment === "." || segment === "..") {
      throw new Error(`store path pattern contains a path traversal segment: ${pattern}`);
    }
  }
  return segments;
}

function compileSegmentMatcher(segment: string, fullPattern: string): SegmentMatcher {
  let hasPlaceholder = false;
  let regexSource = "";
  let literalRun = "";
  let index = 0;
  while (index < segment.length) {
    const ch = segment[index];
    if (ch === "{") {
      const close = segment.indexOf("}", index + 1);
      if (close === -1) {
        throw new Error(`store path pattern segment "${segment}" has an unmatched "{" (pattern: ${fullPattern})`);
      }
      const name = segment.slice(index + 1, close);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`store path pattern segment "${segment}" has an invalid placeholder name "{${name}}" (pattern: ${fullPattern})`);
      }
      regexSource += `${escapeRegExp(literalRun)}([^/]+)`;
      literalRun = "";
      hasPlaceholder = true;
      index = close + 1;
      continue;
    }
    if (ch === "}") {
      throw new Error(`store path pattern segment "${segment}" has an unmatched "}" (pattern: ${fullPattern})`);
    }
    literalRun += ch;
    index += 1;
  }
  regexSource += escapeRegExp(literalRun);
  if (!hasPlaceholder) return { kind: "literal", value: segment };
  return { kind: "pattern", regex: new RegExp(`^${regexSource}$`) };
}

function statEntryKind(absPath: string): "file" | "dir" | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absPath);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`data epoch checkpoint provider refuses to traverse a symbolic link: ${absPath}`);
  }
  if (stat.isDirectory()) return "dir";
  if (stat.isFile()) return "file";
  throw new Error(`data epoch checkpoint provider found an unsupported filesystem entry: ${absPath}`);
}

function listChildNames(dirPath: string, matcher: SegmentMatcher): string[] {
  if (matcher.kind === "literal") {
    try {
      fs.lstatSync(path.join(dirPath, matcher.value));
      return [matcher.value];
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    }
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
  return entries.filter((entry) => matcher.regex.test(entry.name)).map((entry) => entry.name);
}

/**
 * Expands one registry `pathPattern` against a real base directory.
 * `{name}` matches arbitrary non-empty content within exactly one path
 * segment (it may fill the whole segment or sit beside a literal prefix or
 * suffix in that segment, but never spans a `/`). Only entries that exist
 * on disk are returned; a pattern with no matches is a legal empty result.
 * Symbolic links anywhere along the traversal fail closed.
 */
export function expandStorePathPattern(baseDir: string, pattern: string): StorePathMatch[] {
  const segments = validatePatternShape(pattern);
  const matchers = segments.map((segment) => compileSegmentMatcher(segment, pattern));

  let level: Array<{ absPath: string; relParts: string[] }> = [{ absPath: baseDir, relParts: [] }];
  matchers.forEach((matcher, index) => {
    const isLast = index === matchers.length - 1;
    const nextLevel: Array<{ absPath: string; relParts: string[] }> = [];
    for (const node of level) {
      for (const name of listChildNames(node.absPath, matcher)) {
        const absPath = path.join(node.absPath, name);
        const kind = statEntryKind(absPath);
        if (kind === null) continue;
        if (!isLast && kind !== "dir") continue;
        nextLevel.push({ absPath, relParts: [...node.relParts, name] });
      }
    }
    level = nextLevel;
  });

  return level
    .map((node) => {
      const kind = statEntryKind(node.absPath);
      if (kind === null) {
        throw new Error(`store path pattern match disappeared while expanding "${pattern}": ${node.absPath}`);
      }
      return { absPath: node.absPath, relPath: node.relParts.join("/"), isDirectory: kind === "dir" };
    })
    .sort((left, right) => left.relPath.localeCompare(right.relPath));
}

// ---------------------------------------------------------------------------
// Capture: copies/backs up matched bytes into the checkpoint's tmp staging
// directory and records each item's size and sha256.
// ---------------------------------------------------------------------------

function hashAndSizeFile(filePath: string): Promise<{ bytes: number; sha256: string }> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    let bytes = 0;
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    stream.on("end", () => resolve({ bytes, sha256: hash.digest("hex") }));
  });
}

async function captureFileCopy(srcPath: string, destPath: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  await fs.promises.copyFile(srcPath, destPath);
}

async function captureSqliteBackup(srcPath: string, destPath: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  // Dynamic import: better-sqlite3 ships a native addon and the coordinator
  // must not require it before any store is actually opened (core/agent.ts
  // uses the same lazy pattern for its own v1 migration read).
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(srcPath, { readonly: true, fileMustExist: true });
  try {
    // The SQLite online backup API folds in any content still sitting in
    // the source's WAL that hasn't been checkpointed into the main file —
    // a raw byte copy of a live database would risk an inconsistent or
    // truncated snapshot; this never does that.
    await db.backup(destPath);
  } finally {
    db.close();
  }
}

function walkFilesRecursive(dirPath: string): string[] {
  const result: string[] = [];
  const stack = [dirPath];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const absPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`data epoch checkpoint provider refuses to traverse a symbolic link: ${absPath}`);
      }
      if (entry.isDirectory()) {
        stack.push(absPath);
      } else if (entry.isFile()) {
        result.push(absPath);
      } else {
        throw new Error(`data epoch checkpoint provider found an unsupported filesystem entry: ${absPath}`);
      }
    }
  }
  return result.sort();
}

function isSqliteSidecarPattern(pattern: string): boolean {
  return pattern.endsWith("-wal") || pattern.endsWith("-shm");
}

async function captureStoreItems(
  homeDir: string,
  tmpDir: string,
  descriptor: StoreDescriptor,
): Promise<DataEpochCheckpointItem[]> {
  const isSqlite = descriptor.format === "sqlite";
  // WAL/SHM sidecars are never captured as independent files: the backup
  // API already folds their content into the single backed-up main file.
  const patterns = isSqlite
    ? descriptor.pathPatterns.filter((pattern) => !isSqliteSidecarPattern(pattern))
    : descriptor.pathPatterns;

  const items: DataEpochCheckpointItem[] = [];
  for (const pattern of patterns) {
    const matches = expandStorePathPattern(homeDir, pattern);
    for (const match of matches) {
      if (match.isDirectory && descriptor.pathKind !== "tree") {
        throw new Error(
          `data epoch checkpoint provider found a directory where store "${descriptor.id}" declares pathKind "file": ${match.relPath}`,
        );
      }
      if (!match.isDirectory && descriptor.pathKind === "tree") {
        throw new Error(
          `data epoch checkpoint provider found a file where store "${descriptor.id}" declares pathKind "tree": ${match.relPath}`,
        );
      }

      if (match.isDirectory) {
        for (const absFile of walkFilesRecursive(match.absPath)) {
          const relPath = toPosixPath(path.relative(homeDir, absFile));
          const destPath = path.join(tmpDir, "stores", descriptor.id, ...relPath.split("/"));
          await captureFileCopy(absFile, destPath);
          const { bytes, sha256 } = await hashAndSizeFile(destPath);
          items.push({ storeId: descriptor.id, relPath, bytes, sha256 });
        }
      } else {
        const relPath = toPosixPath(path.relative(homeDir, match.absPath));
        const destPath = path.join(tmpDir, "stores", descriptor.id, ...relPath.split("/"));
        if (isSqlite) {
          await captureSqliteBackup(match.absPath, destPath);
        } else {
          await captureFileCopy(match.absPath, destPath);
        }
        const { bytes, sha256 } = await hashAndSizeFile(destPath);
        items.push({ storeId: descriptor.id, relPath, bytes, sha256 });
      }
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Metadata + verify: verify always re-reads metadata.json from disk and
// reconciles every item's presence, byte count, and sha256 — it never
// trusts anything baked into the small in-memory receipt beyond `dir`.
// ---------------------------------------------------------------------------

async function readCheckpointMetadata(dir: string): Promise<DataEpochCheckpointMetadata> {
  const metadataPath = path.join(dir, "metadata.json");
  let raw: string;
  try {
    raw = await fs.promises.readFile(metadataPath, "utf8");
  } catch (error: unknown) {
    throw new Error(`data epoch checkpoint ${dir} is missing metadata.json: ${errorMessage(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    throw new Error(`data epoch checkpoint ${dir} has an unparsable metadata.json: ${errorMessage(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`data epoch checkpoint ${dir} metadata.json must be a JSON object`);
  }
  const value = parsed as Partial<DataEpochCheckpointMetadata>;
  if (value.formatVersion !== DATA_EPOCH_CHECKPOINT_FORMAT_VERSION) {
    throw new Error(`data epoch checkpoint ${dir} has an unsupported metadata formatVersion: ${String(value.formatVersion)}`);
  }
  if (value.complete !== true) {
    throw new Error(`data epoch checkpoint ${dir} metadata.json is not marked complete`);
  }
  if (typeof value.transitionId !== "string" || value.transitionId.length === 0) {
    throw new Error(`data epoch checkpoint ${dir} metadata.json is missing transitionId`);
  }
  if (!Array.isArray(value.items)) {
    throw new Error(`data epoch checkpoint ${dir} metadata.json is missing an items array`);
  }
  for (const item of value.items) {
    if (!item || typeof item.storeId !== "string" || typeof item.relPath !== "string"
      || typeof item.bytes !== "number" || typeof item.sha256 !== "string") {
      throw new Error(`data epoch checkpoint ${dir} metadata.json has a malformed item entry`);
    }
  }
  return value as DataEpochCheckpointMetadata;
}

async function verifyCheckpointDir(dir: string, expectedId?: string): Promise<DataEpochCheckpointMetadata> {
  const metadata = await readCheckpointMetadata(dir);
  if (expectedId !== undefined && metadata.transitionId !== expectedId) {
    throw new Error(
      `data epoch checkpoint ${dir} metadata transitionId "${metadata.transitionId}" does not match expected "${expectedId}"`,
    );
  }
  for (const item of metadata.items) {
    const itemPath = path.join(dir, "stores", item.storeId, ...item.relPath.split("/"));
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(itemPath);
    } catch (error: unknown) {
      throw new Error(
        `data epoch checkpoint ${dir} is missing the captured file for storeId "${item.storeId}" relPath "${item.relPath}": ${errorMessage(error)}`,
      );
    }
    if (stat.size !== item.bytes) {
      throw new Error(
        `data epoch checkpoint ${dir} byte-count mismatch for storeId "${item.storeId}" relPath "${item.relPath}": expected ${item.bytes}, found ${stat.size}`,
      );
    }
    const { sha256 } = await hashAndSizeFile(itemPath);
    if (sha256 !== item.sha256) {
      throw new Error(
        `data epoch checkpoint ${dir} sha256 mismatch for storeId "${item.storeId}" relPath "${item.relPath}": expected ${item.sha256}, found ${sha256}`,
      );
    }
  }
  return metadata;
}

function receiptFromMetadata(dir: string, metadata: DataEpochCheckpointMetadata): DataEpochCheckpointReceipt {
  const totalBytes = metadata.items.reduce((sum, item) => sum + item.bytes, 0);
  return { id: metadata.transitionId, dir, itemCount: metadata.items.length, totalBytes };
}

async function cleanupStaleTmpSiblings(checkpointsRoot: string, transitionId: string): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(checkpointsRoot, { withFileTypes: true });
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  const prefix = `${transitionId}.tmp-`;
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(prefix)) {
      await fs.promises.rm(path.join(checkpointsRoot, entry.name), { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Provider factory (implements the coordinator's frozen interface)
// ---------------------------------------------------------------------------

export function createDataEpochCheckpointProvider(options: DataEpochCheckpointProviderOptions = {}) {
  const stores = options.stores ?? PERSISTENT_STORES;
  const storesById = new Map(stores.map((store) => [store.id, store]));
  const clock = options.clock;

  async function create(input: {
    homeDir: string;
    fromEpoch: number;
    toEpoch: number;
    transitionId: string;
    affectedStoreIds: readonly string[];
  }): Promise<DataEpochCheckpointReceipt> {
    const { homeDir, fromEpoch, toEpoch, transitionId, affectedStoreIds } = input;
    if (typeof transitionId !== "string" || transitionId.length === 0) {
      throw new Error("data epoch checkpoint provider create() requires a non-empty transitionId");
    }
    const checkpointsRoot = path.join(homeDir, DATA_EPOCH_CHECKPOINTS_DIRNAME);
    const publishedDir = path.join(checkpointsRoot, transitionId);

    // Idempotent-retry hygiene: a prior crash mid-capture for this exact
    // transitionId may have left `.tmp-*` staging directories behind. They
    // are never a published checkpoint (verify() never looks at them), so
    // they are always safe to discard before starting fresh.
    await cleanupStaleTmpSiblings(checkpointsRoot, transitionId);

    if (await pathExists(publishedDir)) {
      try {
        const metadata = await verifyCheckpointDir(publishedDir, transitionId);
        return receiptFromMetadata(publishedDir, metadata);
      } catch {
        // Verify failed on a directory that made it to the published name.
        // Preserve it for forensics under an `.invalid-*` suffix — never
        // delete — and fall through to rebuild fresh.
        const invalidDir = `${publishedDir}.invalid-${Date.now()}`;
        await fs.promises.rename(publishedDir, invalidDir);
      }
    }

    const descriptors = affectedStoreIds.map((id) => {
      const descriptor = storesById.get(id);
      if (!descriptor) {
        throw new Error(`data epoch checkpoint provider: unknown store id "${id}"`);
      }
      return descriptor;
    });

    const tmpDir = `${publishedDir}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
    let metadata: DataEpochCheckpointMetadata;
    try {
      await fs.promises.mkdir(tmpDir, { recursive: true });
      const items: DataEpochCheckpointItem[] = [];
      for (const descriptor of descriptors) {
        items.push(...(await captureStoreItems(homeDir, tmpDir, descriptor)));
      }
      metadata = {
        formatVersion: DATA_EPOCH_CHECKPOINT_FORMAT_VERSION,
        transitionId,
        fromEpoch,
        toEpoch,
        affectedStoreIds: [...affectedStoreIds],
        createdAt: timestamp(clock),
        items,
        complete: true,
      };
      // metadata.json is the completion marker and is written last, inside
      // the tmp directory; the directory only becomes visible as a
      // checkpoint via the single atomic rename below.
      await fs.promises.writeFile(path.join(tmpDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
      await fs.promises.rename(tmpDir, publishedDir);
    } catch (error: unknown) {
      await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }

    return receiptFromMetadata(publishedDir, metadata);
  }

  async function verify(checkpoint: { id: string; [key: string]: unknown }): Promise<void> {
    const dir = checkpoint.dir;
    if (typeof dir !== "string" || dir.length === 0) {
      throw new Error('data epoch checkpoint provider verify() requires a receipt with a string "dir"');
    }
    await verifyCheckpointDir(dir, checkpoint.id);
  }

  // `satisfies` (not a `: DataEpochCheckpointProvider` annotation) verifies
  // compatibility with the coordinator's frozen interface at compile time
  // without widening the return type — callers that hold a provider built
  // by this factory keep seeing the precise DataEpochCheckpointReceipt
  // shape from create(), instead of the interface's opaque index signature.
  return { create, verify } satisfies DataEpochCheckpointProvider;
}

// ---------------------------------------------------------------------------
// Retention: an explicit prune, never called from any startup path. Keeps
// the most recent DATA_EPOCH_CHECKPOINT_RETAINED_COUNT published checkpoints
// plus whichever checkpoint (if any) is referenced by an incomplete
// transition journal — that one is never removed regardless of age or size.
// A 2 GiB total-size cap additionally evicts the older of the retained set,
// but always leaves at least one checkpoint behind.
// ---------------------------------------------------------------------------

export async function pruneDataEpochCheckpoints(args: { homeDir: string }): Promise<DataEpochCheckpointPruneResult> {
  const { homeDir } = args;
  const checkpointsRoot = path.join(homeDir, DATA_EPOCH_CHECKPOINTS_DIRNAME);

  const journalRead = readDataEpochJournal(homeDir);
  if (journalRead.status === "corrupt") {
    // We cannot tell whether a corrupt journal was protecting a checkpoint.
    // Refuse rather than risk deleting something still referenced.
    throw new Error(
      `data epoch checkpoint retention refuses to prune while the transition journal is corrupt: ${journalRead.detail}`,
    );
  }
  const protectedId: string | null = journalRead.status === "ok" ? journalRead.journal.checkpointId : null;

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(checkpointsRoot, { withFileTypes: true });
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return { retained: [], removed: [] };
    throw error;
  }

  const published: Array<{ id: string; dir: string; metadata: DataEpochCheckpointMetadata; totalBytes: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // `.tmp-*` staging and `.invalid-*` quarantine directories are never
    // published checkpoints; leave them alone (they are not this
    // function's concern — tmp is provider-internal, invalid is kept for
    // forensics).
    if (entry.name.includes(".tmp-") || entry.name.includes(".invalid-")) continue;
    const dir = path.join(checkpointsRoot, entry.name);
    let metadata: DataEpochCheckpointMetadata;
    try {
      metadata = await readCheckpointMetadata(dir);
    } catch {
      continue;
    }
    const totalBytes = metadata.items.reduce((sum, item) => sum + item.bytes, 0);
    published.push({ id: entry.name, dir, metadata, totalBytes });
  }

  published.sort((left, right) => {
    if (left.metadata.createdAt === right.metadata.createdAt) return 0;
    return left.metadata.createdAt < right.metadata.createdAt ? 1 : -1;
  });

  const byId = new Map(published.map((entry) => [entry.id, entry]));
  function totalBytesFor(ids: readonly string[]): number {
    const idSet = new Set(ids);
    if (protectedId) idSet.add(protectedId);
    let sum = 0;
    for (const id of idSet) {
      const entry = byId.get(id);
      if (entry) sum += entry.totalBytes;
    }
    return sum;
  }

  // Count-based retention: the newest N, oldest-first at the end of the
  // array so size-cap eviction below pops the older of the retained set.
  const sizeRetained = published.slice(0, DATA_EPOCH_CHECKPOINT_RETAINED_COUNT).map((entry) => entry.id);
  while (sizeRetained.length > 1 && totalBytesFor(sizeRetained) > DATA_EPOCH_CHECKPOINT_MAX_TOTAL_BYTES) {
    sizeRetained.pop();
  }

  const keep = new Set(sizeRetained);
  if (protectedId) keep.add(protectedId);

  const retained: string[] = [];
  const removed: string[] = [];
  for (const entry of published) {
    if (keep.has(entry.id)) {
      retained.push(entry.id);
    } else {
      removed.push(entry.id);
      await fs.promises.rm(entry.dir, { recursive: true, force: true });
    }
  }
  return { retained, removed };
}
