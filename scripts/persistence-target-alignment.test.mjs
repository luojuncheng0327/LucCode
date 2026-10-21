import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { PERSISTENT_STORES } from "../shared/persistence/store-registry.ts";

const catalogUrl = new URL("../shared/persistence/hana135-target-catalog.json", import.meta.url);

test("the 116-store release target remains separate from the live registry", () => {
  assert.ok(fs.existsSync(catalogUrl), "missing independent release target catalog");
  const catalog = JSON.parse(fs.readFileSync(catalogUrl, "utf8"));
  assert.equal(catalog.evidenceLevel, "release-artifact-extraction");
  assert.equal(catalog.runtimeRegistration, false);
  assert.equal(catalog.stores.length, 116);
  assert.equal(new Set(catalog.stores.map((store) => store.id)).size, 116);
  assert.match(catalog.source.sha256, /^[a-f0-9]{64}$/);
  for (const id of ["plugin-development-state", "desktop-update-channel", "plugin-download-cache"]) {
    assert.ok(PERSISTENT_STORES.some((store) => store.id === id), id);
    assert.ok(!catalog.stores.some((store) => store.id === id), id);
  }
  assert.equal(PERSISTENT_STORES.find((store) => store.id === "usage-ledger").format, "json");
  assert.equal(catalog.stores.find((store) => store.id === "usage-ledger").format, "sqlite");
});

test("alignment exposes scaffolds, old contracts, and actual write-site evidence", async () => {
  const moduleUrl = new URL("./generate-persistence-target-alignment.mjs", import.meta.url);
  assert.ok(fs.existsSync(moduleUrl), "missing target/current alignment generator");
  const { generateTargetAlignment } = await import(moduleUrl);
  const result = generateTargetAlignment();
  assert.equal(result.summary.targetStores, 116);
  assert.equal(result.summary.runtimeStores, 61);
  assert.equal(result.summary.targetOnlyStores, 58);
  assert.equal(result.summary.compatibilityOnlyStores, 3);
  assert.equal(result.summary.scaffoldOwners, 50);
  const usage = result.stores.find((store) => store.id === "usage-ledger");
  assert.equal(usage.current.format, "json");
  assert.equal(usage.target.format, "sqlite");
  assert.ok(usage.differences.includes("format"));
  assert.equal(usage.runtimeVerified, false);
  for (const store of result.stores.filter((store) => store.ownerStatus === "scaffold")) {
    assert.equal(store.current, null);
    assert.equal(store.runtimeVerified, false);
  }
  const legacy = Object.fromEntries(result.compatibilityOnly.map((store) => [store.id, store.writeSites.length]));
  assert.deepEqual(legacy, { "desktop-update-channel": 2, "plugin-development-state": 9, "plugin-download-cache": 2 });
});

test("alignment rejects duplicate targets and flags absent owners without promoting them", async () => {
  const moduleUrl = new URL("./generate-persistence-target-alignment.mjs", import.meta.url);
  assert.ok(fs.existsSync(moduleUrl), "missing target/current alignment generator");
  const { generateTargetAlignment } = await import(moduleUrl);
  const catalog = JSON.parse(fs.readFileSync(catalogUrl, "utf8"));
  assert.throws(() => generateTargetAlignment({ catalog: { ...catalog, stores: [...catalog.stores, catalog.stores[0]] } }), /duplicate|116/);
  const missing = structuredClone(catalog);
  missing.stores[0].owner = "core/not-implemented-target-owner.ts";
  const result = generateTargetAlignment({ catalog: missing });
  assert.equal(result.stores.find((store) => store.id === missing.stores[0].id).ownerStatus, "missing");
});
