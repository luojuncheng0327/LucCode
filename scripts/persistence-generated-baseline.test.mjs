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

test("fingerprint verifies real epoch-2 stores and excludes target scaffolds", async () => {
  resetPersistenceSchemaCaches();
  const fingerprint = await assertCommittedPersistenceSchemaFingerprint();
  assert.equal(persistenceSchemaCacheStats().sqliteIntrospections, 5);
  assert.equal(fingerprint.dataEpoch, 2);
  const sqlite = fingerprint.schemas.filter((schema) => schema.kind === "sqlite-runtime");
  assert.equal(sqlite.length, 5);
  assert.ok(sqlite.every((schema) => schema.runtimeSchema.objects.length > 0));
  assert.deepEqual(sqlite.find((schema) => schema.storeId === "usage-ledger").runtimeSchema.objects.filter(o => o.type === "table").map(o => o.name).sort(), ["usage_daily_rollups", "usage_entries", "usage_meta", "usage_seen_requests"]);
  assert.ok(!fingerprint.schemas.some((schema) => schema.storeId === "task-runtime-sqlite"));
  const catalog = sqlite.find(schema => schema.storeId === "host-resource-catalog-sqlite");
  assert.ok(catalog.runtimeSchema.objects.some(o => o.name === "local_resources" && o.type === "table"));
  const objects = sqlite.flatMap(schema => schema.runtimeSchema.objects);
  // The release extraction counts CREATE TABLE, excluding virtual FTS tables.
  assert.equal(objects.filter(o => o.type === "table" && !/^CREATE VIRTUAL TABLE/i.test(o.sql)).length, 16);
  assert.equal(objects.filter(o => o.type === "index").length, 13);
  assert.equal(readBuild("persistence-store-inventory").stores.find((store) => store.id === "usage-ledger").format, "sqlite");
});
