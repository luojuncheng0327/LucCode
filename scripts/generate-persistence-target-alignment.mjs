import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PERSISTENT_STORES } from "../shared/persistence/store-registry.ts";
import { discoverSites, REPOSITORY_ROOT } from "./scan-persistent-stores.mjs";

const CATALOG_PATH = "shared/persistence/hana135-target-catalog.json";
const OUTPUT_PATH = "build/persistence-target-alignment.json";
const LEGACY_IDS = ["desktop-update-channel", "plugin-development-state", "plugin-download-cache"];
const sorted = (values) => [...values].sort();
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

// Import only extracted facts. This file is never imported by runtime startup,
// the epoch coordinator, or the schema fingerprint generator.
export function importTargetCatalog(sourcePath, rootDir = REPOSITORY_ROOT) {
  const bytes = fs.readFileSync(sourcePath);
  const source = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
  const stores = Object.values(source.hana).sort((a, b) => a.id.localeCompare(b.id));
  validateTargets(stores);
  const catalog = {
    version: 1,
    release: "HanaAgent 1.1.35-beta",
    evidenceLevel: "release-artifact-extraction",
    runtimeRegistration: false,
    source: { file: "store_alignment.json", section: "hana", sha256: crypto.createHash("sha256").update(bytes).digest("hex") },
    limitations: [
      "Extracted owner/path/format facts are targets, not implemented LucCode contracts.",
      "Null pathKind and escaped Unicode strings are preserved as extracted; no missing contract is inferred.",
      "The compatibility flag records presence of release metadata, not the unextracted compatibility text.",
    ],
    stores,
  };
  fs.writeFileSync(path.join(rootDir, CATALOG_PATH), json(catalog));
  return catalog;
}

function validateTargets(stores) {
  if (!Array.isArray(stores) || stores.length !== 116) throw new Error("expected 116 release targets");
  if (new Set(stores.map((store) => store.id)).size !== stores.length) throw new Error("duplicate target store id");
  for (const store of stores) {
    if (!store.id || !store.owner || !store.format || !Array.isArray(store.paths) || !store.paths.length) {
      throw new Error("incomplete extracted target descriptor");
    }
    if (path.isAbsolute(store.owner) || store.owner.split(/[\\/]/).includes("..")) {
      throw new Error(`target owner must stay inside repository: ${store.owner}`);
    }
  }
}

function currentDescriptor(store) {
  return {
    owner: store.ownerModule, format: store.format, paths: store.pathPatterns, pathKind: store.pathKind,
    schemaSource: store.schemaSource, openEntry: store.openEntry, migrationEntry: store.migrationEntry,
  };
}

function sitesFor(store, sites) {
  return sites.filter((site) => store.siteRules.some((rule) =>
    rule.sourceFile === site.sourceFile
    && (!rule.kinds || rule.kinds.includes(site.kind))
    && (!rule.linePattern || new RegExp(rule.linePattern).test(site.excerpt))))
    .map(({ sourceFile, kind, excerpt, ordinal }) => ({ sourceFile, kind, excerpt, ordinal }));
}

export function generateTargetAlignment({
  rootDir = REPOSITORY_ROOT,
  catalog = JSON.parse(fs.readFileSync(path.join(rootDir, CATALOG_PATH), "utf8")),
  runtimeStores = PERSISTENT_STORES,
  discoveredSites = discoverSites(rootDir),
} = {}) {
  validateTargets(catalog.stores);
  const runtime = new Map(runtimeStores.map((store) => [store.id, store]));
  const targets = new Set(catalog.stores.map((store) => store.id));
  const stores = catalog.stores.map((target) => {
    const store = runtime.get(target.id);
    const ownerPath = path.join(rootDir, target.owner);
    const exists = fs.existsSync(ownerPath);
    // Read source only; importing target owners could initialize real stores.
    const scaffold = exists && /PERSISTENCE_OWNER_SCAFFOLD/.test(fs.readFileSync(ownerPath, "utf8"));
    const ownerStatus = !exists ? "missing" : scaffold ? "scaffold" : "source-present-unverified";
    const differences = [];
    if (store) {
      if (store.ownerModule !== target.owner) differences.push("owner");
      if (store.format !== target.format) differences.push("format");
      if (!same(sorted(store.pathPatterns), sorted(target.paths))) differences.push("paths");
      if (target.pathKind !== null && store.pathKind !== target.pathKind) differences.push("pathKind");
    } else differences.push("runtime-registration");
    return {
      id: target.id, target, current: store ? currentDescriptor(store) : null, ownerStatus,
      status: !store ? "target-only" : differences.length ? "contract-difference" : "static-descriptor-match",
      differences, runtimeVerified: false, writeSites: store ? sitesFor(store, discoveredSites) : [],
      nextAction: !store ? "Implement and validate the owner before runtime registration."
        : differences.length ? "Keep the current contract until its replacement and migration are verified."
          : "Descriptor fields match; runtime parity is not established by this audit.",
    };
  });
  const compatibilityOnly = runtimeStores.filter((store) => !targets.has(store.id))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((store) => ({
      id: store.id, current: currentDescriptor(store), writeSites: sitesFor(store, discoveredSites),
      reason: LEGACY_IDS.includes(store.id) ? "Live LucCode legacy contract retained; removal from the release target is not removal of current writers."
        : "Runtime-only contract; requires explicit review before removal.",
    }));
  return {
    version: 1, generatedBy: "scripts/generate-persistence-target-alignment.mjs",
    targetSource: catalog.source, runtimeRegistry: "shared/persistence/store-registry.ts",
    evidenceLevel: "static-source-audit",
    limitations: [
      "Source existence, write-site discovery, and descriptor matching do not prove runtime feature parity.",
      "Write sites are matched to current registry rules; run the full scanner to validate ambiguity and coverage.",
      "Scaffolds and target-only stores are excluded from runtime migration and schema fingerprints.",
    ],
    summary: {
      targetStores: stores.length, runtimeStores: runtimeStores.length,
      targetOnlyStores: stores.filter((store) => !store.current).length,
      compatibilityOnlyStores: compatibilityOnly.length,
      contractDifferences: stores.filter((store) => store.status === "contract-difference").length,
      staticDescriptorMatches: stores.filter((store) => store.status === "static-descriptor-match").length,
      scaffoldOwners: new Set(stores.filter((store) => store.ownerStatus === "scaffold").map((store) => store.target.owner)).size,
    },
    stores, compatibilityOnly,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 2 && args[0] === "--import-source")) {
    throw new Error("usage: node scripts/generate-persistence-target-alignment.mjs [--import-source store_alignment.json]");
  }
  if (args.length) importTargetCatalog(args[1]);
  const alignment = generateTargetAlignment();
  fs.writeFileSync(path.join(REPOSITORY_ROOT, OUTPUT_PATH), json(alignment));
  process.stdout.write(`${JSON.stringify(alignment.summary)}\n${OUTPUT_PATH}\n`);
}
