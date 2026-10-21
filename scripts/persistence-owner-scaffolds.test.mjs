import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/persistence-owner-scaffolds.json", import.meta.url), "utf8"));

test("all missing target owners exist and explicitly report scaffold status", async () => {
  assert.equal(fixture.owners.length, 50);
  const missing = fixture.owners.filter(({ owner }) => !fs.existsSync(new URL(`../${owner}`, import.meta.url)));
  assert.deepEqual(missing.map(({ owner }) => owner), [], "target owner paths must exist before registry changes");
  for (const { owner, storeIds } of fixture.owners) {
    const mod = await import(new URL(`../${owner}`, import.meta.url));
    const scaffold = mod.PERSISTENCE_OWNER_SCAFFOLD ?? mod.default?.PERSISTENCE_OWNER_SCAFFOLD;
    assert.equal(scaffold?.implementation, "scaffold", owner);
    assert.deepEqual(scaffold.storeIds, storeIds, owner);
    assert.ok(Object.isFrozen(scaffold), owner);
    assert.ok(Object.isFrozen(scaffold.storeIds), owner);
  }
});
