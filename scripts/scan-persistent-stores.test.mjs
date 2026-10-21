import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { discoverSites, PRODUCTION_ROOTS } from "./scan-persistent-stores.mjs";

test("uninitialized declarations do not hide later filesystem writes", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "luc-store-scan-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of PRODUCTION_ROOTS) fs.mkdirSync(path.join(root, dir));
  fs.writeFileSync(path.join(root, "core/fixture.ts"), [
    'import fs from "node:fs";',
    'let uninitialized: string;',
    'const alias = fs;',
    'alias.writeFileSync("state.json", "{}");',
  ].join("\n"));
  const sites = discoverSites(root);
  assert.equal(sites.length, 1);
  assert.equal(sites[0].kind, "write-file");
  assert.equal(sites[0].sourceFile, "core/fixture.ts");
});
