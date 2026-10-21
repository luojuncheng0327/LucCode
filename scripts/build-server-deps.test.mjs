import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { verifyExternalEntrypoints } from "./build-server-deps.mjs";

function packageFixture(t, exports, files = ["dist/index.js"]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "luc-exports-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageDir = path.join(root, "node_modules", "fixture");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ exports }));
  for (const file of files) {
    const target = path.join(packageDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "export {};\n");
  }
  return root;
}

test("published package need not ship its development source export", (t) => {
  const root = packageFixture(t, {
    ".": { source: "./src/index.ts", types: "./dist/index.d.ts", import: "./dist/index.js" },
  });
  assert.doesNotThrow(() => verifyExternalEntrypoints(root, ["fixture"]));
});

test("nested source metadata does not count as a runtime entrypoint", (t) => {
  const root = packageFixture(t, { node: { source: "./src/index.ts", import: "./dist/index.js" } });
  assert.doesNotThrow(() => verifyExternalEntrypoints(root, ["fixture"]));
});

for (const condition of ["import", "require", "default", "node", "node-addons", "module-sync"]) {
  test(`still rejects missing ${condition} runtime target`, (t) => {
    const root = packageFixture(t, { types: "./dist/index.d.ts", [condition]: "./dist/missing.js" });
    assert.throws(() => verifyExternalEntrypoints(root, ["fixture"]), /missing[.]js resolves to missing file/);
  });
}

test("still rejects a missing imported file alongside source metadata", (t) => {
  const root = packageFixture(t, { source: "./src/index.ts", import: "./dist/missing.js" });
  assert.throws(() => verifyExternalEntrypoints(root, ["fixture"]), /missing[.]js resolves to missing file/);
});

test("still rejects a missing package", (t) => {
  const root = packageFixture(t, "./dist/index.js");
  assert.throws(() => verifyExternalEntrypoints(root, ["not-installed"]), /not-installed/);
});
