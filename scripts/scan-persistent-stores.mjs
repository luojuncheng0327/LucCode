import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import {
  PERSISTENCE_EXEMPTIONS,
  PERSISTENT_STORES,
} from "../shared/persistence/store-registry.ts";
import {
  FUTURE_EPOCH_COORDINATOR_PHASE,
  STARTUP_PHASES,
  startupPhaseIndex,
} from "../shared/persistence/startup-phases.ts";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, "..");
export const PRODUCTION_ROOTS = Object.freeze([
  "server",
  "core",
  "hub",
  "lib",
  "shared",
  "plugins",
  "desktop",
  "cli",
]);
export const SOURCE_EXCLUSIONS = Object.freeze([
  { id: "desktop-generated-bundles", pattern: /^desktop\/(?:main|preload)[.]bundle[.]cjs$/, reason: "Generated Electron host bundles duplicate scanned source." },
  { id: "desktop-generated-dist", pattern: /^desktop\/dist-(?:renderer|splash)(?:\/|$)/, reason: "Generated Vite output is not source." },
  { id: "desktop-native-products", pattern: /^desktop\/native(?:\/|$)/, reason: "Native build products and sources are outside the JavaScript persistence census." },
  { id: "desktop-renderer-react", pattern: /^desktop\/src\/react(?:\/|$)/, reason: "Renderer state uses authenticated server APIs and is not a host filesystem owner." },
  { id: "desktop-renderer-platform", pattern: /^desktop\/src\/(?:lib|modules)(?:\/|$)/, reason: "Renderer platform and i18n modules are not Electron host persistence owners." },
  { id: "desktop-renderer-entries", pattern: /^desktop\/src\/(?:browser-viewer-main|main|mobile-main|onboarding-main|quick-chat-main|settings-main|splash-main|viewer-window-entry)[.]tsx$/, reason: "Renderer entrypoints are not Electron host persistence owners." },
  { id: "desktop-renderer-workers", pattern: /^desktop\/src\/(?:mobile-sw[.]js|viewer-resource-events[.]ts)$/, reason: "Renderer/service-worker code is not an Electron host persistence owner." },
  { id: "source-tests", pattern: /\/(?:tests|__tests__)(?:\/|$)|[.](?:test|spec)[.](?:[cm]?[jt]sx?)$/, reason: "Test fixtures and test-only mutations are excluded from production ownership." },
]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);

const FS_METHOD_KINDS = new Map([
  ["writeFile", "write-file"],
  ["writeFileSync", "write-file"],
  ["createWriteStream", "write-file"],
  // Descriptor writes. Only the synchronous names are listed: the callback
  // forms are named `write`/`writev`, which are far too common as method names
  // on unrelated objects to match on. A writable descriptor has to come from an
  // open call with a writing flag, and those are recognized below, so the
  // descriptor's origin is visible to the scan either way.
  ["writeSync", "write-file"],
  ["writevSync", "write-file"],
  ["appendFile", "append-file"],
  ["appendFileSync", "append-file"],
  ["rename", "rename"],
  ["renameSync", "rename"],
  ["copyFile", "copy-file"],
  ["copyFileSync", "copy-file"],
  ["cp", "copy-file"],
  ["cpSync", "copy-file"],
  ["mkdir", "mkdir"],
  ["mkdirSync", "mkdir"],
  ["unlink", "remove-path"],
  ["unlinkSync", "remove-path"],
  ["rm", "remove-path"],
  ["rmSync", "remove-path"],
  ["rmdir", "remove-path"],
  ["rmdirSync", "remove-path"],
  ["truncate", "truncate-file"],
  ["truncateSync", "truncate-file"],
]);
const ATOMIC_HELPERS = new Set([
  "atomicWriteSync",
  "durableWriteJson",
  "atomicWriteFile",
  "atomicWriteFileSync",
  "atomicWriteJson",
  "writeJsonAtomic",
  "writeJsonFile",
  "safeWriteJson",
  "writeJson",
]);
// Writers that force owner-only permissions. Tracked as their own kind so the
// guard test can tell a credential write apart from an ordinary one.
const SECRET_HELPERS = new Set([
  "writeSecretFileSync",
  "writeSecretJson",
]);
const PERSISTENT_CONSTRUCTORS = new Set([
  "ActivityStore",
  "ConfirmStore",
  "CronStore",
  "DeferredResultStore",
  "FactStore",
  "FileHistoryStore",
  "InputDraftsStore",
  "LoopStore",
  "PreferencesManager",
  "SessionManifestStore",
  "SessionProjectCatalogStore",
  "SkillBundleStore",
  "SubagentRunStore",
  "SubagentThreadStore",
  "TaskRegistry",
  "UsageLedger",
  "WebSessionStore",
  "WorkflowActivityStore",
  "WorkflowJournal",
]);

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function listSourceFiles(rootDir) {
  const files = [];
  for (const relativeRoot of PRODUCTION_ROOTS) {
    const absoluteRoot = path.join(rootDir, relativeRoot);
    if (!fs.existsSync(absoluteRoot)) {
      throw new Error(`persistence scan root is missing: ${relativeRoot}`);
    }
    const stack = [absoluteRoot];
    while (stack.length > 0) {
      const current = stack.pop();
      const entries = fs.readdirSync(current, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) {
          const relativeDirectory = toPosix(path.relative(rootDir, absolute));
          if (SOURCE_EXCLUSIONS.some((rule) => rule.pattern.test(`${relativeDirectory}/`))) continue;
          stack.push(absolute);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
        if (entry.name.endsWith(".d.ts") || entry.name.endsWith(".d.cts")) continue;
        const relativeFile = toPosix(path.relative(rootDir, absolute));
        if (SOURCE_EXCLUSIONS.some((rule) => rule.pattern.test(relativeFile))) continue;
        files.push(relativeFile);
      }
    }
  }
  return files.sort();
}

function moduleText(node) {
  return ts.isStringLiteralLike(node) ? node.text : null;
}

function isFsModule(value) {
  return value === "fs" || value === "node:fs" || value === "fs/promises" || value === "node:fs/promises";
}

function propertyNameText(node) {
  if (!node) return null;
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
  return null;
}

function expressionRootName(node) {
  let current = node;
  while (ts.isPropertyAccessExpression(current)) current = current.expression;
  return ts.isIdentifier(current) ? current.text : null;
}

function collectBindings(source) {
  const fsNamespaces = new Set(["fs", "fsp"]);
  const directCalls = new Map();
  const databaseConstructors = new Set(["Database"]);

  const registerNamedBinding = (importedName, localName) => {
    if (importedName === "promises") fsNamespaces.add(localName);
    if (FS_METHOD_KINDS.has(importedName)) directCalls.set(localName, FS_METHOD_KINDS.get(importedName));
    if (ATOMIC_HELPERS.has(importedName)) directCalls.set(localName, "atomic-write");
    if (SECRET_HELPERS.has(importedName)) directCalls.set(localName, "secret-write");
  };

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const importedModule = moduleText(statement.moduleSpecifier);
      const clause = statement.importClause;
      if (isFsModule(importedModule) && clause) {
        if (clause.name) fsNamespaces.add(clause.name.text);
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
          fsNamespaces.add(clause.namedBindings.name.text);
        }
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) {
            registerNamedBinding(element.propertyName?.text ?? element.name.text, element.name.text);
          }
        }
      }
      if (importedModule === "better-sqlite3" && clause?.name) databaseConstructors.add(clause.name.text);
    }

    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const initializerText = declaration.initializer?.getText(source) ?? "";
      const isFsInitializer = /(?:require|import)\s*\(\s*["'](?:node:)?fs(?:\/promises)?["']\s*\)/.test(initializerText)
        || /^\w+\.promises$/.test(initializerText)
        || (ts.isIdentifier(declaration.initializer) && fsNamespaces.has(declaration.initializer.text));
      const isDatabaseInitializer = /(?:require|import)\s*\(\s*["']better-sqlite3["']\s*\)/.test(initializerText);
      if (ts.isIdentifier(declaration.name)) {
        if (isFsInitializer) fsNamespaces.add(declaration.name.text);
        if (isDatabaseInitializer) databaseConstructors.add(declaration.name.text);
        continue;
      }
      if (!ts.isObjectBindingPattern(declaration.name) || !isFsInitializer) continue;
      for (const element of declaration.name.elements) {
        const importedName = propertyNameText(element.propertyName) ?? propertyNameText(element.name);
        const localName = propertyNameText(element.name);
        if (importedName && localName) registerNamedBinding(importedName, localName);
      }
    }
  }
  return { fsNamespaces, directCalls, databaseConstructors };
}

function callKind(node, bindings) {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) {
    if (bindings.directCalls.has(callee.text)) return bindings.directCalls.get(callee.text);
    if (ATOMIC_HELPERS.has(callee.text)) return "atomic-write";
    if (SECRET_HELPERS.has(callee.text)) return "secret-write";
    return null;
  }
  if (!ts.isPropertyAccessExpression(callee)) return null;
  const method = callee.name.text;
  if (FS_METHOD_KINDS.has(method)) {
    const root = expressionRootName(callee.expression);
    const expressionText = callee.expression.getText();
    const inlineFsRequire = /^(?:require\(\s*["'](?:node:)?fs(?:\/promises)?["']\s*\))(?:[.]promises)?$/.test(expressionText);
    if ((root && (bindings.fsNamespaces.has(root) || /^(?:file)?handle$/i.test(root))) || inlineFsRequire) {
      return FS_METHOD_KINDS.get(method);
    }
  }
  if (method === "open" || method === "openSync") {
    const root = expressionRootName(callee.expression);
    const flag = node.arguments[1];
    if (root && bindings.fsNamespaces.has(root) && flag && ts.isStringLiteralLike(flag) && /[wax+]/.test(flag.text)) {
      return "write-file";
    }
  }
  if (ATOMIC_HELPERS.has(method)) return "atomic-write";
  if (SECRET_HELPERS.has(method)) return "secret-write";
  return null;
}

function constructorKind(node, bindings) {
  const expression = node.expression;
  const name = ts.isIdentifier(expression) ? expression.text : null;
  if (!name) return null;
  if (bindings.databaseConstructors.has(name)) return "database-open";
  if (PERSISTENT_CONSTRUCTORS.has(name)) return "persistent-store-constructor";
  return null;
}

/**
 * `line` is diagnostic only — it locates a site in an error message and never
 * takes part in classification (see `ruleMatches`, which keys on sourceFile,
 * kind and excerpt). Committing it made every comment edit above a write site
 * rewrite the receipt, so the baseline carries `ordinal` instead: the site's
 * position among identical excerpts of the same kind in the same file. Two
 * sites only share an ordinal slot if they are textually indistinguishable,
 * so appearing, disappearing and re-texting all stay visible while pure line
 * drift does not. `sourceOverrides` maps a repository-relative path to
 * replacement source, letting tests drive the scanner without touching disk.
 */
export function discoverSites(rootDir = REPOSITORY_ROOT, sourceOverrides = new Map()) {
  const sites = [];
  for (const sourceFile of listSourceFiles(rootDir)) {
    const absolutePath = path.join(rootDir, sourceFile);
    const text = sourceOverrides.has(sourceFile)
      ? sourceOverrides.get(sourceFile)
      : fs.readFileSync(absolutePath, "utf-8");
    const source = ts.createSourceFile(
      sourceFile,
      text,
      ts.ScriptTarget.Latest,
      true,
      sourceFile.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const bindings = collectBindings(source);
    const visit = (node) => {
      const kind = ts.isCallExpression(node)
        ? callKind(node, bindings)
        : (ts.isNewExpression(node) ? constructorKind(node, bindings) : null);
      if (kind) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const excerpt = node.getText(source).trim().replace(/\s+/g, " ").slice(0, 240);
        sites.push({ sourceFile, line, kind, excerpt, reason: "unclassified", storeId: null, exemptionId: null });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const ordinals = new Map();
  for (const site of sites.sort((a, b) => (
    a.sourceFile.localeCompare(b.sourceFile)
    || a.line - b.line
    || a.kind.localeCompare(b.kind)
    || a.excerpt.localeCompare(b.excerpt)
  ))) {
    // JSON encoding keeps the slot key injective on the triple without smuggling
    // unprintable separator bytes into this source file (a raw NUL here makes
    // grep and ripgrep treat the whole file as binary).
    const slot = JSON.stringify([site.sourceFile, site.kind, site.excerpt]);
    const next = ordinals.get(slot) ?? 0;
    site.ordinal = next;
    ordinals.set(slot, next + 1);
  }
  return sites.sort((a, b) => (
    a.sourceFile.localeCompare(b.sourceFile)
    || a.kind.localeCompare(b.kind)
    || a.excerpt.localeCompare(b.excerpt)
    || a.ordinal - b.ordinal
  ));
}

function ruleMatches(site, rule) {
  if (site.sourceFile !== rule.sourceFile) return false;
  if (rule.kinds && !rule.kinds.includes(site.kind)) return false;
  if (rule.linePattern && !new RegExp(rule.linePattern).test(site.excerpt)) return false;
  return true;
}

function validateDate(value, label, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} must use YYYY-MM-DD`);
  if (value < today) throw new Error(`${label} expired on ${value}`);
}

function normalizedOwnershipPattern(pattern, platform = "posix") {
  const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function segmentCompatible(left, right) {
  return left === right || /^\{[^}]+\}$/.test(left) || /^\{[^}]+\}$/.test(right);
}

function patternContains(parentPattern, childPattern, platform = "posix") {
  const parent = normalizedOwnershipPattern(parentPattern, platform).split("/");
  const child = normalizedOwnershipPattern(childPattern, platform).split("/");
  if (parent.length > child.length) return false;
  return parent.every((segment, index) => segmentCompatible(segment, child[index]));
}

function explicitlyExcludes(store, otherPattern, platform) {
  return (store.pathExclusions ?? []).some((excludedPattern) => (
    patternContains(excludedPattern, otherPattern, platform)
  ));
}

export function pathPatternsOverlap(leftStore, rightStore, platform = "posix") {
  if (explicitlyExcludes(leftStore, rightStore.pathPattern, platform)
    || explicitlyExcludes(rightStore, leftStore.pathPattern, platform)) {
    return false;
  }
  const left = normalizedOwnershipPattern(leftStore.pathPattern, platform).split("/");
  const right = normalizedOwnershipPattern(rightStore.pathPattern, platform).split("/");
  const commonLength = Math.min(left.length, right.length);
  for (let index = 0; index < commonLength; index += 1) {
    if (!segmentCompatible(left[index], right[index])) return false;
  }
  if (left.length === right.length) return true;
  if (left.length < right.length) return leftStore.pathKind === "tree";
  return rightStore.pathKind === "tree";
}

export function validateRegistry({ stores, exemptions, today = new Date().toISOString().slice(0, 10) }) {
  const coordinatorIndex = startupPhaseIndex(FUTURE_EPOCH_COORDINATOR_PHASE);
  const storeIds = new Set();
  for (const store of stores) {
    if (storeIds.has(store.id)) throw new Error(`duplicate store id: ${store.id}`);
    storeIds.add(store.id);
    if (!Array.isArray(store.pathPatterns) || store.pathPatterns.length === 0) {
      throw new Error(`store ${store.id} has no pathPatterns`);
    }
    for (const ownershipPattern of store.pathPatterns) {
      if (path.posix.isAbsolute(ownershipPattern) || path.win32.isAbsolute(ownershipPattern)) {
        throw new Error(`store ${store.id} has an absolute pathPattern: ${ownershipPattern}`);
      }
      if (ownershipPattern.includes("\\")) {
        throw new Error(`store ${store.id} pathPattern must be POSIX-normalized: ${ownershipPattern}`);
      }
    }
    if (!Array.isArray(store.pathExclusions)) {
      throw new Error(`store ${store.id} has no pathExclusions array`);
    }
    for (const excludedPattern of store.pathExclusions) {
      if (path.posix.isAbsolute(excludedPattern) || path.win32.isAbsolute(excludedPattern)) {
        throw new Error(`store ${store.id} has an absolute pathExclusion: ${excludedPattern}`);
      }
      if (excludedPattern.includes("\\")) {
        throw new Error(`store ${store.id} pathExclusion must be POSIX-normalized: ${excludedPattern}`);
      }
      if (!store.pathPatterns.some((ownedPattern) => patternContains(ownedPattern, excludedPattern))) {
        throw new Error(`store ${store.id} pathExclusion is outside its ownership: ${excludedPattern}`);
      }
      if (store.pathPatterns.some((ownedPattern) => (
        normalizedOwnershipPattern(ownedPattern) === normalizedOwnershipPattern(excludedPattern)
      ))) {
        throw new Error(`store ${store.id} pathExclusion must be a strict child path: ${excludedPattern}`);
      }
    }
    if (store.pathPattern !== store.pathPatterns[0]) {
      throw new Error(`store ${store.id} pathPattern must equal its first pathPatterns entry`);
    }
    if (!Array.isArray(store.protocolModules)
      || store.protocolModules.some((module) => typeof module !== "string" || !module || module.includes("\\") || /^(?:\/|[A-Za-z]:)/.test(module))
      || new Set(store.protocolModules).size !== store.protocolModules.length) {
      throw new Error(`store ${store.id} protocolModules must be unique repository-relative POSIX paths`);
    }
    if (!STARTUP_PHASES.includes(store.firstPossibleOpenPhase)) {
      throw new Error(`store ${store.id} has unknown open phase: ${store.firstPossibleOpenPhase}`);
    }
    if (!STARTUP_PHASES.includes(store.firstPossibleWritePhase)) {
      throw new Error(`store ${store.id} has unknown write phase: ${store.firstPossibleWritePhase}`);
    }
    const openIndex = startupPhaseIndex(store.firstPossibleOpenPhase);
    const writeIndex = startupPhaseIndex(store.firstPossibleWritePhase);
    if (writeIndex < coordinatorIndex) {
      if (store.affectedByEpochMigration) {
        throw new Error(`store ${store.id} writes epoch-managed state before ${FUTURE_EPOCH_COORDINATOR_PHASE}`);
      }
      if (!store.bootstrapSafety) {
        throw new Error(`store ${store.id} writes before ${FUTURE_EPOCH_COORDINATOR_PHASE} without bootstrapSafety`);
      }
    }
    if (store.bootstrapSafety && store.affectedByEpochMigration) {
      throw new Error(`store ${store.id} cannot be bootstrap-safe while affectedByEpochMigration is true`);
    }
    if (store.bootstrapSafety) {
      const safePaths = store.bootstrapSafety.unstampedHomeSafePaths;
      if (!Array.isArray(safePaths)) {
        throw new Error(`store ${store.id} bootstrapSafety must declare unstampedHomeSafePaths`);
      }
      const seenSafePaths = new Set();
      for (const safePath of safePaths) {
        if (!safePath || typeof safePath.relativePath !== "string" || !safePath.relativePath
          || !["file", "tree"].includes(safePath.kind)) {
          throw new Error(`store ${store.id} has an invalid unstamped-home safe path`);
        }
        if (safePath.relativePath.includes("{") || safePath.relativePath.includes("}")) {
          throw new Error(`store ${store.id} unstamped-home safe path must be exact: ${safePath.relativePath}`);
        }
        if (!store.pathPatterns.includes(safePath.relativePath)) {
          throw new Error(`store ${store.id} unstamped-home safe path is not registered: ${safePath.relativePath}`);
        }
        if (seenSafePaths.has(safePath.relativePath)) {
          throw new Error(`store ${store.id} has duplicate unstamped-home safe path: ${safePath.relativePath}`);
        }
        seenSafePaths.add(safePath.relativePath);
      }
      if (safePaths.length > 0 && store.firstPossibleWritePhase !== "desktop_bootstrap") {
        throw new Error(`store ${store.id} may prove new-home safety only from desktop_bootstrap`);
      }
    }
    if (openIndex < coordinatorIndex && store.affectedByEpochMigration && !store.preCoordinatorReadProjection) {
      throw new Error(`store ${store.id} opens before ${FUTURE_EPOCH_COORDINATOR_PHASE} without a read projection`);
    }
    if (store.preCoordinatorReadProjection) {
      const fields = store.preCoordinatorReadProjection.fields;
      if (!Array.isArray(fields) || fields.length === 0 || fields.some((field) => typeof field !== "string" || !field)) {
        throw new Error(`store ${store.id} has an invalid preCoordinatorReadProjection`);
      }
      if (new Set(fields).size !== fields.length) {
        throw new Error(`store ${store.id} has duplicate preCoordinatorReadProjection fields`);
      }
    }
    if (store.exemption) validateDate(store.exemption.expiresOn, `store ${store.id} exemption`, today);
    if (store.schemaSource.kind === "narrow-exemption") {
      validateDate(store.schemaSource.expiresOn, `store ${store.id} schema source exemption`, today);
    }
    if (store.schemaContract.kind === "exempt") {
      if (!store.schemaContract.expiresOn) throw new Error(`store ${store.id} schema exemption has no expiry`);
      validateDate(store.schemaContract.expiresOn, `store ${store.id} schema exemption`, today);
    }
  }
  for (const store of stores) {
    for (const excludedPattern of store.pathExclusions) {
      const takeoverOwners = stores.filter((candidate) => (
        candidate.id !== store.id
        && candidate.pathKind === "tree"
        && candidate.pathPatterns.some((candidatePattern) => (
          normalizedOwnershipPattern(candidatePattern) === normalizedOwnershipPattern(excludedPattern)
        ))
      ));
      if (takeoverOwners.length !== 1) {
        throw new Error(
          `store ${store.id} pathExclusion must be fully owned by exactly one tree descriptor: ${excludedPattern}`,
        );
      }
    }
  }
  for (let left = 0; left < stores.length; left += 1) {
    for (let right = left + 1; right < stores.length; right += 1) {
      for (const platform of ["posix", "win32"]) {
        for (const leftPattern of stores[left].pathPatterns) {
          for (const rightPattern of stores[right].pathPatterns) {
            if (pathPatternsOverlap(
              { ...stores[left], pathPattern: leftPattern },
              { ...stores[right], pathPattern: rightPattern },
              platform,
            )) {
              throw new Error(
                `store path ownership overlaps on ${platform}: ${stores[left].id} (${leftPattern}) and `
                + `${stores[right].id} (${rightPattern})`,
              );
            }
          }
        }
      }
    }
  }

  const exemptionIds = new Set();
  for (const exemption of exemptions) {
    if (exemptionIds.has(exemption.id)) throw new Error(`duplicate persistence exemption id: ${exemption.id}`);
    exemptionIds.add(exemption.id);
    validateDate(exemption.expiresOn, `persistence exemption ${exemption.id}`, today);
  }
}

function validateRuleCoverage(sites, stores, exemptions) {
  for (const store of stores) {
    for (const rule of store.siteRules) {
      if (!sites.some((site) => ruleMatches(site, rule))) {
        throw new Error(
          `dangling persistence rule for store ${store.id}: ${rule.sourceFile}`
          + `${rule.linePattern ? ` /${rule.linePattern}/` : ""}`,
        );
      }
    }
  }
  for (const exemption of exemptions) {
    if (!sites.some((site) => ruleMatches(site, exemption))) {
      throw new Error(`dangling persistence exemption: ${exemption.id} (${exemption.sourceFile})`);
    }
  }
}

function classifySites(sites, stores, exemptions) {
  const classified = [];
  for (const site of sites) {
    const storeMatches = stores.flatMap((store) => {
      const matchingRule = store.siteRules.find((rule) => ruleMatches(site, rule));
      return matchingRule ? [{ id: store.id, reason: matchingRule.reason }] : [];
    });
    const exemptionMatches = exemptions
      .filter((exemption) => ruleMatches(site, exemption))
      .map((exemption) => ({ id: exemption.id, reason: exemption.reason }));
    const matches = [
      ...storeMatches.map((match) => ({ type: "store", ...match })),
      ...exemptionMatches.map((match) => ({ type: "exemption", ...match })),
    ];
    if (matches.length === 0) {
      throw new Error(`unregistered persistence site: ${site.sourceFile}:${site.line} ${site.kind} ${site.excerpt}`);
    }
    if (matches.length > 1) {
      throw new Error(
        `ambiguous persistence site: ${site.sourceFile}:${site.line} ${site.kind} matches `
        + matches.map((match) => `${match.type}:${match.id}`).join(", "),
      );
    }
    const match = matches[0];
    // `line` stays out of the receipt on purpose; the errors above still quote
    // the real one because they read from the in-memory site.
    const { line: _line, ...receipt } = site;
    classified.push({
      ...receipt,
      reason: match.reason,
      storeId: match.type === "store" ? match.id : null,
      exemptionId: match.type === "exemption" ? match.id : null,
    });
  }
  return classified;
}

function publicStoreDescriptor(store) {
  const descriptor = { ...store };
  delete descriptor.siteRules;
  return descriptor;
}

export function buildStartupReceipt(stores) {
  const coordinatorIndex = startupPhaseIndex(FUTURE_EPOCH_COORDINATOR_PHASE);
  return {
    version: 2,
    generatedBy: "scripts/scan-persistent-stores.mjs",
    canonicalPhases: [...STARTUP_PHASES],
    futureCoordinatorPhase: FUTURE_EPOCH_COORDINATOR_PHASE,
    stores: [...stores]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((store) => {
        const openIndex = startupPhaseIndex(store.firstPossibleOpenPhase);
        const writeIndex = startupPhaseIndex(store.firstPossibleWritePhase);
        const opensBeforeFutureCoordinator = openIndex < coordinatorIndex;
        const writesBeforeFutureCoordinator = writeIndex < coordinatorIndex;
        return {
          id: store.id,
          firstPossibleOpenPhase: store.firstPossibleOpenPhase,
          firstPossibleWritePhase: store.firstPossibleWritePhase,
          opensBeforeFutureCoordinator,
          writesBeforeFutureCoordinator,
          bootstrapSafety: store.bootstrapSafety,
          preCoordinatorReadProjection: store.preCoordinatorReadProjection,
          breakingMigrationRequiresAccessMove: store.affectedByEpochMigration
            && (openIndex <= coordinatorIndex || writeIndex <= coordinatorIndex),
        };
      }),
  };
}

export function scanPersistentStores({
  rootDir = REPOSITORY_ROOT,
  stores = PERSISTENT_STORES,
  exemptions = PERSISTENCE_EXEMPTIONS,
  today = new Date().toISOString().slice(0, 10),
  sourceOverrides = new Map(),
} = {}) {
  validateRegistry({ stores, exemptions, today });
  const discoveredSites = discoverSites(rootDir, sourceOverrides);
  validateRuleCoverage(discoveredSites, stores, exemptions);
  const sites = classifySites(discoveredSites, stores, exemptions);
  const inventory = {
    // version 3 anchors sites by ordinal instead of absolute line number.
    version: 3,
    generatedBy: "scripts/scan-persistent-stores.mjs",
    sourceRoots: [...PRODUCTION_ROOTS],
    sourceExclusions: SOURCE_EXCLUSIONS.map(({ id, reason }) => ({ id, reason })),
    stores: [...stores].sort((a, b) => a.id.localeCompare(b.id)).map(publicStoreDescriptor),
    discoveredSites: sites,
    exemptions: [...exemptions].sort((a, b) => a.id.localeCompare(b.id)),
  };
  return { inventory, startupReceipt: buildStartupReceipt(stores) };
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function writeReceipts({ rootDir = REPOSITORY_ROOT, ...scanOptions } = {}) {
  const result = scanPersistentStores({ rootDir, ...scanOptions });
  const inventoryPath = path.join(rootDir, "build", "persistence-store-inventory.json");
  const startupPath = path.join(rootDir, "build", "persistence-startup-receipt.json");
  fs.mkdirSync(path.dirname(inventoryPath), { recursive: true });
  fs.writeFileSync(inventoryPath, stableJson(result.inventory), "utf-8");
  fs.writeFileSync(startupPath, stableJson(result.startupReceipt), "utf-8");
  return { ...result, inventoryPath, startupPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { inventory, inventoryPath, startupPath } = writeReceipts();
  process.stdout.write(
    `persistence inventory: ${inventory.stores.length} stores, ${inventory.discoveredSites.length} sites\n`
    + `${toPosix(path.relative(REPOSITORY_ROOT, inventoryPath))}\n`
    + `${toPosix(path.relative(REPOSITORY_ROOT, startupPath))}\n`,
  );
}
