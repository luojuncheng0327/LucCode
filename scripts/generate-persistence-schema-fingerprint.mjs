import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

import { scanPersistentStores } from "./scan-persistent-stores.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, "..");
export const FINGERPRINT_PATH = "build/persistence-schema-fingerprint.json";

const PI_SESSION_PACKAGE = "@earendil-works/pi-coding-agent";
const PI_SESSION_VERSION_MODULE = "node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js";

export const SCHEMA_CHANGE_GUIDANCE = [
  "compatible addition",
  "→ record compatibility reasoning",
  "→ update the store-local schema contract",
  "→ repin the persistence schema fingerprint",
  "",
  "breaking change",
  "→ declare source and target DATA_EPOCH values",
  "→ register the migration in the coordinated migration batch",
  "→ declare affected stores plus checkpoint and restore policy",
  "→ repin the persistence schema fingerprint",
].join("\n");

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function stableJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function normalizeRepositoryPath(relativePath) {
  const normalized = path.posix.normalize(String(relativePath || "").replaceAll("\\", "/"));
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`persistence schema source must be a repository-relative path: ${relativePath}`);
  }
  if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`persistence schema source must not be absolute: ${relativePath}`);
  }
  return normalized;
}

function sourceOverride(sourceOverrides, relativePath) {
  if (!sourceOverrides) return undefined;
  if (sourceOverrides instanceof Map) return sourceOverrides.get(relativePath);
  if (Object.prototype.hasOwnProperty.call(sourceOverrides, relativePath)) {
    return sourceOverrides[relativePath];
  }
  return undefined;
}

function readRepositorySource(rootDir, relativePath, sourceOverrides) {
  const sourcePath = normalizeRepositoryPath(relativePath);
  const override = sourceOverride(sourceOverrides, sourcePath);
  if (override !== undefined) return Buffer.from(String(override), "utf-8");

  const absolutePath = path.resolve(rootDir, ...sourcePath.split("/"));
  const relativeToRoot = path.relative(rootDir, absolutePath);
  if (relativeToRoot === ".." || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) {
    throw new Error(`persistence schema source escapes repository root: ${sourcePath}`);
  }
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    throw new Error(`persistence schema source is missing: ${sourcePath}`);
  }
  return fs.readFileSync(absolutePath);
}

/**
 * Names the digest algorithm below. Bump it whenever the algorithm changes, so
 * a committed fingerprint carries enough provenance to say *why* its hashes
 * stopped matching: same method and compiler means a guarded module changed;
 * anything else means the toolchain moved and every hash is incomparable for
 * reasons that have nothing to do with persisted shape.
 */
export const SOURCE_DIGEST_METHOD = "parse-tree-v1";

const SCRIPT_KINDS = new Map([
  [".ts", ts.ScriptKind.TS],
  [".tsx", ts.ScriptKind.TSX],
  [".mts", ts.ScriptKind.TS],
  [".cts", ts.ScriptKind.TS],
  [".js", ts.ScriptKind.JS],
  [".jsx", ts.ScriptKind.JSX],
  [".mjs", ts.ScriptKind.JS],
  [".cjs", ts.ScriptKind.JS],
]);

/**
 * A JSDoc block is still a comment. getChildren() serves JSDoc nodes alongside
 * real syntax, so a digest that walks children naively hashes doc text — and
 * file headers in this repository are JSDoc, so the very edits this guard was
 * loudest about would keep demanding review. Everything in the JSDoc kind
 * range is excluded from the digest wholesale.
 */
function isJsDocKind(kind) {
  return kind >= ts.SyntaxKind.FirstJSDocNode && kind <= ts.SyntaxKind.LastJSDocNode;
}

// Parsing is where verifying this tripwire spends most of its time, and a run
// that verifies several payloads re-reads a nearly identical inventory each
// time. The digest below is a pure function of the source path and the exact
// bytes hashed, so memoize it under both: a changed byte is a different key,
// and a cached digest can never describe source that has moved. Overridden text
// keys the same way, so probes that reuse an override are just as cheap.
const executableSourceHashCache = new Map();
let executableSourceParses = 0;

/**
 * Hash what executes, not what the file happens to say.
 *
 * This tripwire guards the shape of what reaches disk. A comment cannot change
 * a persisted byte, yet hashing raw file bytes made every comment edit demand a
 * schema review — which is what most reviews here ended up being, until the
 * recorded reasoning became a sentence people copied forward. A guard answered
 * by reflex has stopped guarding.
 *
 * So the digest is taken over the parse tree, not the raw bytes and not a flat
 * token stream. A flat token stream is not enough: whitespace between tokens is
 * semantic at JavaScript's restricted productions — `return {…}` and
 * `return\n{…}` share one token sequence while automatic semicolon insertion
 * gives them different meanings — so every non-leaf node contributes its kind
 * name and explicit open/close markers, which makes those two parses digest
 * differently. Leaf tokens are kept verbatim and length-prefixed, so whitespace
 * *inside* a string or template literal — content that can reach disk — still
 * counts, and one piece sequence cannot be re-cut into another that digests the
 * same. (A NUL separator would do the same job, but writing a raw NUL into this
 * file makes git treat it as binary and lose diffs.) A shebang line is
 * interpreter-selecting and therefore executable; it is digested too, even
 * though the parser files it under trivia.
 *
 * Comments never enter the digest: line and block comments are trivia the
 * walk never sees, and JSDoc — which getChildren() does serve as nodes — is
 * skipped explicitly. Doc edits in guarded modules require no schema review.
 *
 * The kind names come from the pinned TypeScript's SyntaxKind table, so a
 * TypeScript upgrade may shift them and demand one honest repin; that failure
 * is loud, never silent.
 *
 * Parse failures throw. Falling back to a raw byte hash would silently restore
 * the old semantics on exactly the files least understood.
 */
export function executableSourceHash(rootDir, relativePath, sourceOverrides) {
  const sourcePath = normalizeRepositoryPath(relativePath);
  const text = readRepositorySource(rootDir, sourcePath, sourceOverrides).toString("utf-8");
  const scriptKind = SCRIPT_KINDS.get(path.extname(sourcePath).toLowerCase());
  if (scriptKind === undefined) {
    throw new Error(`persistence schema source has no known script kind: ${sourcePath}`);
  }
  const cacheKey = `${sha256(text)} ${sourcePath}`;
  const memoized = executableSourceHashCache.get(cacheKey);
  if (memoized !== undefined) return memoized;
  executableSourceParses += 1;
  const source = ts.createSourceFile(sourcePath, text, ts.ScriptTarget.Latest, true, scriptKind);
  const diagnostics = source.parseDiagnostics;
  if (!Array.isArray(diagnostics)) {
    // parseDiagnostics is how the parser reports syntax errors here. If a
    // TypeScript upgrade stops exposing it, hashing would continue with no
    // syntax validation at all — refuse loudly instead of guarding less.
    throw new Error(`persistence schema parser exposed no parseDiagnostics; cannot verify a clean parse: ${sourcePath}`);
  }
  if (diagnostics.length > 0) {
    const detail = ts.flattenDiagnosticMessageText(diagnostics[0].messageText, " ");
    throw new Error(`persistence schema source failed to parse: ${sourcePath}: ${detail}`);
  }
  const pieces = [];
  const shebang = text.match(/^#![^\r\n]*/);
  if (shebang) pieces.push(`#!${shebang[0].length}:${shebang[0]}`);
  const walk = (node) => {
    if (isJsDocKind(node.kind)) return;
    const children = node.getChildren(source).filter((child) => !isJsDocKind(child.kind));
    if (children.length === 0) {
      const tokenText = node.getText(source);
      if (tokenText) pieces.push(`${ts.SyntaxKind[node.kind]}#${tokenText.length}:${tokenText}`);
      return;
    }
    pieces.push(`${ts.SyntaxKind[node.kind]}(`);
    for (const child of children) walk(child);
    pieces.push(")");
  };
  walk(source);
  if (pieces.length === 0 && text.trim().length > 0) {
    throw new Error(`persistence schema source yielded no tokens: ${sourcePath}`);
  }
  // Only a clean parse is memoized; the throws above leave the key absent so a
  // later call re-reads and fails the same way instead of replaying a verdict.
  const digest = sha256(pieces.join(""));
  executableSourceHashCache.set(cacheKey, digest);
  return digest;
}

function sourceContract(rootDir, schemaSource, sourceOverrides) {
  const module = normalizeRepositoryPath(schemaSource.module);
  return {
    contract: schemaSource.contract,
    module,
    sourceHash: executableSourceHash(rootDir, module, sourceOverrides),
  };
}

function resolveCurrentDataEpoch(rootDir, suppliedEpoch) {
  if (suppliedEpoch !== undefined) {
    if (!Number.isInteger(suppliedEpoch) || suppliedEpoch < 1) {
      throw new Error("current DATA_EPOCH must be a positive integer");
    }
    return suppliedEpoch;
  }
  const requireFromRepository = createRequire(path.join(rootDir, "scripts", "persistence-epoch-loader.cjs"));
  const versions = requireFromRepository(path.join(rootDir, "shared", "contract-versions.cjs"));
  if (!Number.isInteger(versions.DATA_EPOCH) || versions.DATA_EPOCH < 1) {
    throw new Error("shared/contract-versions.cjs must export a positive integer DATA_EPOCH");
  }
  return versions.DATA_EPOCH;
}

function normalizeSql(sql) {
  return String(sql || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function readSqliteRuntimeSchema(db, { excludeObject = () => false } = {}) {
  const rows = db.prepare(`
    SELECT type, name, tbl_name AS tableName, sql
    FROM sqlite_master
    WHERE sql IS NOT NULL
      AND name NOT LIKE 'sqlite_%'
    ORDER BY type ASC, name ASC
  `).all();
  return {
    objects: rows
      .filter((row) => !excludeObject(row))
      .map((row) => ({
        name: row.name,
        sql: normalizeSql(row.sql),
        tableName: row.tableName,
        type: row.type,
      })),
    userVersion: Number(db.pragma("user_version", { simple: true })),
  };
}

async function withTemporaryDatabase(prefix, createStore, inspectStore) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  let store = null;
  try {
    store = await createStore(tempDir);
    return inspectStore(store);
  } finally {
    try {
      store?.close?.();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

async function sessionManifestSchema(rootDir) {
  const modulePath = "core/session-manifest/store.ts";
  const runtime = await import(pathToFileURL(path.join(rootDir, ...modulePath.split("/"))).href);
  return withTemporaryDatabase(
    "luc-session-manifest-schema-",
    (tempDir) => new runtime.SessionManifestStore({ dbPath: path.join(tempDir, "session-manifest.db") }),
    (store) => readSqliteRuntimeSchema(store.db),
  );
}

async function factStoreSchema(rootDir) {
  const modulePath = "lib/memory/fact-store.ts";
  const runtime = await import(pathToFileURL(path.join(rootDir, ...modulePath.split("/"))).href);
  return withTemporaryDatabase(
    "luc-facts-schema-",
    (tempDir) => new runtime.FactStore(path.join(tempDir, "facts.db")),
    (store) => readSqliteRuntimeSchema(store.db, {
      excludeObject: (row) => row.name.startsWith("facts_fts_") || row.tableName.startsWith("facts_fts_"),
    }),
  );
}

async function fileHistorySchema(rootDir) {
  const modulePath = "lib/file-history/history-store.ts";
  const runtime = await import(pathToFileURL(path.join(rootDir, ...modulePath.split("/"))).href);
  return withTemporaryDatabase(
    "luc-file-history-schema-",
    (tempDir) => new runtime.FileHistoryStore({ dbPath: path.join(tempDir, "history.sqlite") }),
    (store) => readSqliteRuntimeSchema(store._db),
  );
}

async function usageLedgerSchema(rootDir) {
  const runtime = await import(pathToFileURL(path.join(rootDir, "lib/llm/usage-ledger.ts")).href);
  const requireFromRepository = createRequire(path.join(rootDir, "package.json"));
  const Database = requireFromRepository("better-sqlite3");
  return withTemporaryDatabase(
    "luc-usage-ledger-schema-",
    (tempDir) => {
      const databasePath = path.join(tempDir, "usage-ledger.sqlite");
      const ledger = runtime.createUsageLedger({ databasePath });
      ledger.close();
      return new Database(databasePath, { readonly: true, fileMustExist: true });
    },
    (db) => readSqliteRuntimeSchema(db),
  );
}

async function introspectSqliteStore(rootDir, storeId) {
  if (storeId === "usage-ledger") return usageLedgerSchema(rootDir);
  if (storeId === "session-manifest-sqlite") return sessionManifestSchema(rootDir);
  if (storeId === "agent-facts-sqlite") return factStoreSchema(rootDir);
  if (storeId === "file-history-sqlite") return fileHistorySchema(rootDir);
  throw new Error(
    `SQLite store ${storeId} has no runtime introspector. Add one that opens the real store; do not copy DDL into the fingerprint generator.`,
  );
}

// A store's runtime schema is a property of the checked-out tree, not of the
// payload being computed: the introspectors take only `rootDir`, `sourceOverrides`
// cannot reach them, and the store classes they instantiate come from an ESM
// import the runtime already caches — so a second look at the same root builds
// the same throwaway database and reads back the same schema.
//
// Recomputing it per payload is therefore pure cost, and the cost is a temp
// directory plus a database build and teardown, which is exactly the work a
// Windows filesystem is slowest at. A single generation run calls this once per
// store and never notices; the tripwire tests compute a payload per probed
// module and paid for it until the Windows runner ran them out of time.
const sqliteRuntimeSchemaCache = new Map();
let sqliteIntrospections = 0;

/**
 * Drop every memoized runtime schema and parsed source. Both caches are only
 * sound because they cannot outlive the process that filled them, so anything
 * that needs to observe real introspection — or deliberately re-read a tree —
 * must be able to clear them.
 */
export function resetPersistenceSchemaCaches() {
  sqliteRuntimeSchemaCache.clear();
  executableSourceHashCache.clear();
  sqliteIntrospections = 0;
  executableSourceParses = 0;
}

/**
 * Counts of the work actually performed, as opposed to served from a cache.
 * Verifying this tripwire is dominated by parsing guarded sources and building
 * throwaway SQLite databases; naming those two numbers keeps the cost visible
 * to whoever registers the next store, instead of leaving it to be rediscovered
 * from a CI timeout.
 */
export function persistenceSchemaCacheStats() {
  return { sourceParses: executableSourceParses, sqliteIntrospections };
}

function cachedSqliteRuntimeSchema(rootDir, storeId) {
  const key = `${path.resolve(rootDir)} ${storeId}`;
  const cached = sqliteRuntimeSchemaCache.get(key);
  if (cached) return cached;
  // Cache the promise, not the result, so concurrent callers share one build.
  // Evict on rejection: a probe that failed once says nothing about the tree,
  // and a stuck rejected promise would turn one transient failure into a
  // process-wide one that no later call could retry past.
  sqliteIntrospections += 1;
  const pending = introspectSqliteStore(rootDir, storeId).catch((error) => {
    sqliteRuntimeSchemaCache.delete(key);
    throw error;
  });
  sqliteRuntimeSchemaCache.set(key, pending);
  return pending;
}

async function sqliteContract(rootDir, store, sourceOverrides) {
  const runtimeSchema = await cachedSqliteRuntimeSchema(rootDir, store.id);

  return {
    contract: store.schemaSource.contract,
    kind: "sqlite-runtime",
    module: normalizeRepositoryPath(store.schemaSource.module),
    runtimeSchema,
    sourceHash: executableSourceHash(rootDir, store.schemaSource.module, sourceOverrides),
    storeId: store.id,
  };
}

function parseExtensionModule(extension) {
  const match = String(extension).match(/^([^\s]+\.(?:cjs|js|mjs|ts|tsx))(?:\s|$)/);
  if (!match) {
    throw new Error(`external schema extension must start with a repository source path: ${extension}`);
  }
  return normalizeRepositoryPath(match[1]);
}

async function piSessionContract(rootDir, store, sourceOverrides) {
  const schemaSource = store.schemaSource;
  if (schemaSource.packageName !== PI_SESSION_PACKAGE) {
    throw new Error(`unsupported external persistence schema package: ${schemaSource.packageName}`);
  }

  const lockfile = normalizeRepositoryPath(String(schemaSource.lockfile).split(/\s+/)[0]);
  const lock = JSON.parse(readRepositorySource(rootDir, lockfile, sourceOverrides).toString("utf-8"));
  const lockEntry = lock.packages?.[`node_modules/${schemaSource.packageName}`];
  if (!lockEntry?.version || !lockEntry?.integrity) {
    throw new Error(`package lock entry lacks exact version/integrity: ${schemaSource.packageName}`);
  }

  const packageJson = JSON.parse(readRepositorySource(rootDir, "package.json", sourceOverrides).toString("utf-8"));
  const requestedVersion = packageJson.dependencies?.[schemaSource.packageName];
  if (requestedVersion !== lockEntry.version) {
    throw new Error(
      `${schemaSource.packageName} must be exact and match package-lock.json: requested ${requestedVersion}, locked ${lockEntry.version}`,
    );
  }

  const versionSourceText = readRepositorySource(rootDir, PI_SESSION_VERSION_MODULE, sourceOverrides).toString("utf-8");
  const declaration = versionSourceText.match(/export const CURRENT_SESSION_VERSION\s*=\s*\d+;/)?.[0];
  if (!declaration) {
    throw new Error(`CURRENT_SESSION_VERSION declaration is missing from ${PI_SESSION_VERSION_MODULE}`);
  }
  const declaredVersion = Number(declaration.match(/\d+/)?.[0]);
  const runtime = await import(PI_SESSION_PACKAGE);
  if (runtime.CURRENT_SESSION_VERSION !== declaredVersion) {
    throw new Error(
      `Pi CURRENT_SESSION_VERSION source/runtime mismatch: source ${declaredVersion}, runtime ${runtime.CURRENT_SESSION_VERSION}`,
    );
  }

  const extensions = schemaSource.extensions
    .map((extension) => {
      const module = parseExtensionModule(extension);
      return {
        contract: extension,
        module,
        sourceHash: executableSourceHash(rootDir, module, sourceOverrides),
      };
    })
    .sort((left, right) => left.module.localeCompare(right.module));

  return {
    extensions,
    kind: "external-versioned",
    lockfile,
    packageName: schemaSource.packageName,
    packageVersion: lockEntry.version,
    packageIntegrity: lockEntry.integrity,
    requestedVersion,
    storeId: store.id,
    versionSource: {
      currentSessionVersion: runtime.CURRENT_SESSION_VERSION,
      declaration,
      declarationHash: sha256(declaration),
      module: PI_SESSION_VERSION_MODULE,
    },
  };
}

async function schemaEntry(rootDir, store, sourceOverrides) {
  let entry;
  switch (store.schemaSource.kind) {
    case "sqlite-runtime":
      entry = await sqliteContract(rootDir, store, sourceOverrides);
      break;
    case "runtime-contract":
    case "directory-contract":
      entry = {
        ...sourceContract(rootDir, store.schemaSource, sourceOverrides),
        kind: store.schemaSource.kind,
        storeId: store.id,
      };
      break;
    case "external-versioned":
      entry = await piSessionContract(rootDir, store, sourceOverrides);
      break;
    case "narrow-exemption":
      entry = {
        expiresOn: store.schemaSource.expiresOn,
        kind: "narrow-exemption",
        reason: store.schemaSource.reason,
        storeId: store.id,
      };
      break;
    default:
      throw new Error(`unsupported persistence schema source on ${store.id}: ${store.schemaSource.kind}`);
  }
  const protocolModules = (store.protocolModules || [])
    .map((module) => ({
      module: normalizeRepositoryPath(module),
      sourceHash: executableSourceHash(rootDir, module, sourceOverrides),
    }))
    .sort((left, right) => left.module.localeCompare(right.module));
  return protocolModules.length > 0 ? { ...entry, protocolModules } : entry;
}

function siteMapping(site) {
  return {
    exemptionId: site.exemptionId,
    kind: site.kind,
    ordinal: site.ordinal,
    reason: site.reason,
    sourceFile: normalizeRepositoryPath(site.sourceFile),
    storeId: site.storeId,
  };
}

function assertPortableFingerprint(value) {
  const visit = (current, trail = "fingerprint") => {
    if (typeof current === "string") {
      const pathField = /(?:module|ownerModule|sourceFile|sourceRoots|lockfile|pathPattern|pathPatterns)(?:\[\d+\])?$/.test(trail);
      if (/^(?:\/|[A-Za-z]:[\\/])/.test(current) || (pathField && current.includes("\\"))) {
        throw new Error(`${trail} contains a machine-specific or non-POSIX path: ${current}`);
      }
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${trail}[${index}]`));
      return;
    }
    if (current && typeof current === "object") {
      for (const [key, item] of Object.entries(current)) visit(item, `${trail}.${key}`);
    }
  };
  visit(value);
}

async function generatePersistenceSchemaPayload({
  rootDir = REPOSITORY_ROOT,
  inventory: suppliedInventory,
  sourceOverrides,
  currentDataEpoch,
} = {}) {
  const dataEpoch = resolveCurrentDataEpoch(rootDir, currentDataEpoch);
  const inventory = suppliedInventory ?? scanPersistentStores({ rootDir }).inventory;
  const schemas = [];
  for (const store of inventory.stores) {
    schemas.push(await schemaEntry(rootDir, store, sourceOverrides));
  }
  schemas.sort((left, right) => left.storeId.localeCompare(right.storeId));

  const payload = {
    dataEpoch,
    exemptions: [...inventory.exemptions].sort((left, right) => left.id.localeCompare(right.id)),
    generatedBy: "scripts/generate-persistence-schema-fingerprint.mjs",
    inventoryReceipt: {
      generatedBy: inventory.generatedBy,
      sourceExclusions: [...(inventory.sourceExclusions ?? [])],
      sourceRoots: [...inventory.sourceRoots],
      version: inventory.version,
    },
    registry: [...inventory.stores].sort((left, right) => left.id.localeCompare(right.id)),
    schemas,
    siteMappings: inventory.discoveredSites
      .map(siteMapping)
      .sort((left, right) => left.sourceFile.localeCompare(right.sourceFile)
        || left.kind.localeCompare(right.kind)
        || left.ordinal - right.ordinal),
    // Source hashes are whatever this parser says they are, so the payload
    // names its parser. A toolchain upgrade then shows up in the committed
    // diff as the compiler line changing — and the mismatch error below can
    // name the real cause instead of implying persisted shape drifted.
    sourceDigest: {
      compiler: `typescript@${ts.version}`,
      method: SOURCE_DIGEST_METHOD,
    },
    // version 2 anchored site mappings by ordinal instead of absolute line;
    // version 3 records the source digest method and compiler.
    version: 3,
  };
  const payloadFingerprint = sha256(canonicalJson(payload));
  const result = canonicalize({ ...payload, payloadFingerprint });
  assertPortableFingerprint(result);
  return result;
}

function reviewedFingerprint(payload, review, { currentDataEpoch = 1 } = {}) {
  validateSchemaChangeDeclaration(review, { currentDataEpoch });
  if (review.payloadFingerprint && review.payloadFingerprint !== payload.payloadFingerprint) {
    throw new Error(
      `schema review pins ${review.payloadFingerprint}, but generated payload is ${payload.payloadFingerprint}\n\n`
      + SCHEMA_CHANGE_GUIDANCE,
    );
  }
  return canonicalize({
    ...payload,
    review: {
      ...review,
      payloadFingerprint: payload.payloadFingerprint,
    },
  });
}

export async function generatePersistenceSchemaFingerprint({
  review,
  currentDataEpoch,
  rootDir = REPOSITORY_ROOT,
  ...options
} = {}) {
  if (!review) {
    throw new Error(
      `persistence schema fingerprint generation requires an explicit compatible or breaking review\n\n`
      + SCHEMA_CHANGE_GUIDANCE,
    );
  }
  const payload = await generatePersistenceSchemaPayload({ rootDir, currentDataEpoch, ...options });
  return reviewedFingerprint(payload, review, {
    currentDataEpoch: payload.dataEpoch,
  });
}

function validateCommittedReview(committed, { currentDataEpoch = 1 } = {}) {
  if (!committed || typeof committed !== "object" || Array.isArray(committed)) {
    throw new Error(`committed persistence schema fingerprint must be an object\n\n${SCHEMA_CHANGE_GUIDANCE}`);
  }
  validateSchemaChangeDeclaration(committed.review, { currentDataEpoch });

  const { review, payloadFingerprint, ...payloadBody } = committed;
  const recomputedPayloadFingerprint = sha256(canonicalJson(payloadBody));
  if (payloadFingerprint !== recomputedPayloadFingerprint) {
    throw new Error(
      `committed payloadFingerprint is stale: recorded ${payloadFingerprint || "missing"}, `
      + `recomputed ${recomputedPayloadFingerprint}\n\n${SCHEMA_CHANGE_GUIDANCE}`,
    );
  }
  if (review.payloadFingerprint !== payloadFingerprint) {
    throw new Error(
      `schema review does not pin the committed payloadFingerprint: review ${review.payloadFingerprint || "missing"}, `
      + `payload ${payloadFingerprint}\n\n${SCHEMA_CHANGE_GUIDANCE}`,
    );
  }
  return canonicalize({ ...payloadBody, payloadFingerprint });
}

export async function writePersistenceSchemaFingerprint({
  rootDir = REPOSITORY_ROOT,
  outputPath = FINGERPRINT_PATH,
  review,
  currentDataEpoch,
  ...options
} = {}) {
  const outputIsAbsolute = path.isAbsolute(outputPath);
  const normalizedOutput = outputIsAbsolute ? toPosix(outputPath) : normalizeRepositoryPath(outputPath);
  const absoluteOutput = outputIsAbsolute
    ? outputPath
    : path.join(rootDir, ...normalizedOutput.split("/"));
  const payload = await generatePersistenceSchemaPayload({ rootDir, currentDataEpoch, ...options });
  const resolvedDataEpoch = payload.dataEpoch;
  let selectedReview = review;
  if (fs.existsSync(absoluteOutput)) {
    const existing = JSON.parse(fs.readFileSync(absoluteOutput, "utf-8"));
    const existingPayload = validateCommittedReview(existing, { currentDataEpoch: existing.dataEpoch });
    const epochChanged = existingPayload.dataEpoch !== payload.dataEpoch;
    if (epochChanged) {
      if (selectedReview?.classification !== "breaking"
        || selectedReview.sourceDataEpoch !== existingPayload.dataEpoch
        || selectedReview.targetDataEpoch !== payload.dataEpoch) {
        throw new Error(
          `DATA_EPOCH changed from ${existingPayload.dataEpoch} to ${payload.dataEpoch}; the new review must be `
          + `breaking with sourceDataEpoch=${existingPayload.dataEpoch} and targetDataEpoch=${payload.dataEpoch}\n\n`
          + SCHEMA_CHANGE_GUIDANCE,
        );
      }
    } else if (selectedReview?.classification === "breaking") {
      throw new Error(
        `breaking schema review requires a DATA_EPOCH bump; current payload remains at ${payload.dataEpoch}\n\n`
        + SCHEMA_CHANGE_GUIDANCE,
      );
    }
    if (!selectedReview && existingPayload.payloadFingerprint !== payload.payloadFingerprint) {
      throw new Error(
        `persistence schema payload changed from ${existingPayload.payloadFingerprint} to ${payload.payloadFingerprint}; `
        + `an explicit compatible or breaking review is required\n\n${SCHEMA_CHANGE_GUIDANCE}`,
      );
    }
    selectedReview ??= existing.review;
  } else if (selectedReview?.classification && selectedReview.classification !== "compatible") {
    throw new Error(
      `initial persistence schema baseline must use an explicit compatible review\n\n${SCHEMA_CHANGE_GUIDANCE}`,
    );
  }
  if (!selectedReview) {
    throw new Error(
      `initial persistence schema fingerprint generation requires an explicit compatible or breaking review\n\n`
      + SCHEMA_CHANGE_GUIDANCE,
    );
  }
  const fingerprint = reviewedFingerprint(payload, selectedReview, { currentDataEpoch: resolvedDataEpoch });
  fs.mkdirSync(path.dirname(absoluteOutput), { recursive: true });
  fs.writeFileSync(absoluteOutput, stableJson(fingerprint), "utf-8");
  return { fingerprint, outputPath: normalizedOutput };
}

export async function assertCommittedPersistenceSchemaFingerprint({
  rootDir = REPOSITORY_ROOT,
  committedFingerprint,
  committedPath = FINGERPRINT_PATH,
  currentDataEpoch,
  ...options
} = {}) {
  const expected = committedFingerprint ?? JSON.parse(
    readRepositorySource(rootDir, committedPath).toString("utf-8"),
  );
  const resolvedDataEpoch = resolveCurrentDataEpoch(rootDir, currentDataEpoch);
  const expectedPayload = validateCommittedReview(expected, { currentDataEpoch: resolvedDataEpoch });
  const actualPayload = await generatePersistenceSchemaPayload({
    rootDir,
    currentDataEpoch: resolvedDataEpoch,
    ...options,
  });
  if (canonicalJson(actualPayload) !== canonicalJson(expectedPayload)) {
    const describeDigest = (digest) => (digest
      ? `${digest.compiler} (method ${digest.method})`
      : "a fingerprint format without digest provenance (payload v2 or older)");
    if (canonicalJson(expectedPayload.sourceDigest ?? null) !== canonicalJson(actualPayload.sourceDigest ?? null)) {
      // Module hashes computed by different parsers (or digest methods) are
      // incomparable for reasons that have nothing to do with persisted shape.
      // Saying "schema fingerprint mismatch" here would point the review at
      // stored data when the true subject is the toolchain.
      throw new Error(
        `persistence schema digest provenance changed: committed fingerprint was sealed by ${describeDigest(expectedPayload.sourceDigest)}, `
        + `this run digests with ${describeDigest(actualPayload.sourceDigest)}. Source hashes come from the parser, so `
        + `every module hash may differ for toolchain reasons rather than schema reasons; review the toolchain change and repin.`
        + `\n\n${SCHEMA_CHANGE_GUIDANCE}`,
      );
    }
    throw new Error(
      `persistence schema fingerprint mismatch: committed ${expectedPayload.payloadFingerprint}, `
      + `generated ${actualPayload.payloadFingerprint}\n\n${SCHEMA_CHANGE_GUIDANCE}`,
    );
  }
  return expected;
}

export function validateSchemaChangeDeclaration(declaration, { currentDataEpoch = 1 } = {}) {
  if (!declaration || !["compatible", "breaking"].includes(declaration.classification)) {
    throw new Error(`schema change classification must be compatible or breaking\n\n${SCHEMA_CHANGE_GUIDANCE}`);
  }
  if (declaration.classification === "compatible") {
    if (typeof declaration.compatibilityReason !== "string" || !declaration.compatibilityReason.trim()) {
      throw new Error(`compatible schema declaration is missing compatibility reasoning\n\n${SCHEMA_CHANGE_GUIDANCE}`);
    }
    return declaration;
  }

  const missing = [];
  if (!Number.isInteger(declaration.sourceDataEpoch) || declaration.sourceDataEpoch < 1) {
    missing.push("source DATA_EPOCH");
  }
  if (!Number.isInteger(declaration.targetDataEpoch)
    || !Number.isInteger(declaration.sourceDataEpoch)
    || declaration.targetDataEpoch <= declaration.sourceDataEpoch) {
    missing.push("target DATA_EPOCH greater than source DATA_EPOCH");
  } else if (currentDataEpoch !== declaration.targetDataEpoch) {
    missing.push("current DATA_EPOCH equal to target DATA_EPOCH");
  }
  if (!Array.isArray(declaration.affectedStores)
    || declaration.affectedStores.length === 0
    || declaration.affectedStores.some((storeId) => typeof storeId !== "string" || !storeId.trim())) {
    missing.push("affected stores");
  }
  if (typeof declaration.checkpointPolicy !== "string" || !declaration.checkpointPolicy.trim()) {
    missing.push("checkpoint policy");
  }
  if (typeof declaration.restorePolicy !== "string" || !declaration.restorePolicy.trim()) {
    missing.push("restore policy");
  }
  if (missing.length > 0) {
    throw new Error(`breaking schema declaration is incomplete: missing ${missing.join(", ")}\n\n${SCHEMA_CHANGE_GUIDANCE}`);
  }
  return declaration;
}

function parseCliReview(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`unexpected schema fingerprint argument: ${key}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`schema fingerprint argument requires a value: ${key}`);
    }
    index += 1;
    const existing = values.get(key) || [];
    existing.push(value);
    values.set(key, existing);
  }

  const classification = values.get("--classification")?.at(-1);
  if (!classification) {
    if (values.size > 0) throw new Error("--classification is required when supplying schema review arguments");
    return undefined;
  }
  const review = { classification };
  if (classification === "compatible") {
    review.compatibilityReason = values.get("--compatibility-reason")?.at(-1);
  } else if (classification === "breaking") {
    review.sourceDataEpoch = Number(values.get("--source-data-epoch")?.at(-1));
    review.targetDataEpoch = Number(values.get("--target-data-epoch")?.at(-1));
    review.affectedStores = (values.get("--affected-store") || [])
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter(Boolean);
    review.checkpointPolicy = values.get("--checkpoint-policy")?.at(-1);
    review.restorePolicy = values.get("--restore-policy")?.at(-1);
  }
  return review;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const review = parseCliReview(process.argv.slice(2));
  const { fingerprint, outputPath } = await writePersistenceSchemaFingerprint({ review });
  process.stdout.write(
    `persistence schema fingerprint: ${fingerprint.payloadFingerprint}\n${toPosix(outputPath)}\n`,
  );
}
