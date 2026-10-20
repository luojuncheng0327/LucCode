#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { auditLegacySessionManifests } from "../core/session-manifest/legacy-migration.ts";
import { loadBetterSqliteDatabase } from "../core/session-manifest/store.ts";
import { sessionLocatorKey } from "../core/session-manifest/path-normalizer.ts";

function parseArgs(argv) {
  const options = { json: false, failOnAnomaly: false, lucHome: process.env.LUC_HOME || null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--luc-home" || arg === "--luc-home") {
      options.lucHome = argv[++index] || null;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--fail-on-anomaly") {
      options.failOnAnomaly = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function helpText() {
  return [
    "session-manifest-audit: read-only coverage check for persisted session identities",
    "",
    "Usage:",
    "  LUC_HOME=/path/to/data node scripts/session-manifest-audit.mjs [--json] [--fail-on-anomaly]",
    "  node scripts/session-manifest-audit.mjs --luc-home /path/to/data [--json]",
    "",
    "The command never creates or repairs manifests. Use --fail-on-anomaly to exit 1 when",
    "a manifest or locator is missing, or classification, owner, or lifecycle differs.",
  ].join("\n");
}

function rowManifest(row) {
  if (!row) return null;
  return {
    sessionId: row.session_id,
    ownerAgentId: row.owner_agent_id || null,
    domain: row.domain,
    kind: row.kind,
    lifecycle: row.lifecycle,
    currentLocator: {
      path: row.current_locator_path,
      key: row.current_locator_key,
    },
  };
}

function openReadonlyManifestIndex(dbPath) {
  if (!fs.existsSync(dbPath)) {
    return {
      resolveByLocatorPath: () => null,
      list: () => [],
      close: () => {},
    };
  }
  const Database = loadBetterSqliteDatabase();
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const currentByLocator = db.prepare(
    "SELECT * FROM session_manifests WHERE current_locator_key = ?",
  );
  const historyByLocator = db.prepare(`
    SELECT m.*
    FROM session_locator_history h
    JOIN session_manifests m ON m.session_id = h.session_id
    WHERE h.locator_key = ?
  `);
  const list = db.prepare("SELECT * FROM session_manifests ORDER BY updated_at DESC");
  return {
    resolveByLocatorPath(sessionPath) {
      const key = sessionLocatorKey(sessionPath);
      const current = rowManifest(currentByLocator.get(key));
      const history = rowManifest(historyByLocator.get(key));
      if (current && history && current.sessionId !== history.sessionId) {
        throw new Error(`session locator is claimed by multiple manifests: ${sessionPath}`);
      }
      return current || history || null;
    },
    list: () => list.all().map(rowManifest),
    close: () => db.close(),
  };
}

function humanReport(report, lucHome) {
  const lines = [
    `Session manifest audit (${lucHome})`,
    `discovered: ${report.discovered}`,
    `manifested: ${report.manifested}`,
    `missing: ${report.missing}`,
    `missing locator: ${report.missingLocator}`,
    `domain mismatch: ${report.domainMismatch}`,
    `owner mismatch: ${report.ownerMismatch}`,
    `lifecycle mismatch: ${report.lifecycleMismatch}`,
  ];
  for (const [label, entries] of [
    ["Missing manifests", report.details.missing],
    ["Missing locators", report.details.missingLocators],
    ["Classification mismatches", report.details.domainMismatches],
    ["Owner mismatches", report.details.ownerMismatches],
    ["Lifecycle mismatches", report.details.lifecycleMismatches],
  ]) {
    if (!entries.length) continue;
    lines.push("", `${label}:`);
    for (const entry of entries) lines.push(`  - ${entry.sessionPath}`);
  }
  return lines.join("\n");
}

let index = null;
try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    process.exit(0);
  }
  if (!options.lucHome) throw new Error("LUC_HOME or --luc-home is required");
  const lucHome = path.resolve(options.lucHome);
  index = openReadonlyManifestIndex(path.join(lucHome, "session-manifest.db"));
  const report = auditLegacySessionManifests({ lucHome, store: index });
  process.stdout.write(options.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : `${humanReport(report, lucHome)}\n`);
  const anomalous = report.missing > 0
    || report.missingLocator > 0
    || report.domainMismatch > 0
    || report.ownerMismatch > 0
    || report.lifecycleMismatch > 0;
  process.exitCode = options.failOnAnomaly && anomalous ? 1 : 0;
} catch (error) {
  process.stderr.write(`session-manifest-audit failed: ${error?.message || error}\n`);
  process.exitCode = 2;
} finally {
  index?.close?.();
}
