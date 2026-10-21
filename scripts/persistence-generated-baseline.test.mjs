import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { scanPersistentStores } from "./scan-persistent-stores.mjs";
import { generateTargetAlignment } from "./generate-persistence-target-alignment.mjs";
import {
  assertCommittedPersistenceSchemaFingerprint,
  persistenceSchemaCacheStats,
  resetPersistenceSchemaCaches,
} from "./generate-persistence-schema-fingerprint.mjs";

const readBuild = (name) => JSON.parse(fs.readFileSync(new URL(`../build/${name}.json`, import.meta.url), "utf8"));

test("committed inventory and target audit reproduce from their generators", () => {
  const scan = scanPersistentStores();
  assert.deepEqual(readBuild("persistence-store-inventory"), scan.inventory);
  assert.deepEqual(readBuild("persistence-startup-receipt"), scan.startupReceipt);
  assert.deepEqual(readBuild("persistence-target-alignment"), generateTargetAlignment());
});

test("fingerprint verifies real epoch-1 stores and excludes target scaffolds", async () => {
  resetPersistenceSchemaCaches();
  const fingerprint = await assertCommittedPersistenceSchemaFingerprint();
  assert.equal(persistenceSchemaCacheStats().sqliteIntrospections, 3);
  assert.equal(fingerprint.dataEpoch, 1);
  const sqlite = fingerprint.schemas.filter((schema) => schema.kind === "sqlite-runtime");
  assert.equal(sqlite.length, 3);
  assert.ok(sqlite.every((schema) => schema.runtimeSchema.objects.length > 0));
  assert.ok(!sqlite.some((schema) => schema.storeId === "usage-ledger"));
  assert.ok(!fingerprint.schemas.some((schema) => ["host-resource-catalog-sqlite", "task-runtime-sqlite"].includes(schema.storeId)));
  assert.equal(readBuild("persistence-store-inventory").stores.find((store) => store.id === "usage-ledger").format, "json");
});
