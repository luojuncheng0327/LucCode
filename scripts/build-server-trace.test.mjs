import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { pruneServerNodeModulesViaNft } from "./build-server-phases.mjs";

test("tracing never reads an external drive and still prunes unused package files", async (t) => {
  const repo = fileURLToPath(new URL("../", import.meta.url));
  const tempParent = path.join(repo, "tmp");
  fs.mkdirSync(tempParent, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempParent, "nft-boundary-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "nft-outside-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  const outsideFile = path.join(outside, "outside.js");
  fs.writeFileSync(outsideFile, "export default 1;\n");
  fs.mkdirSync(path.join(root, "node_modules", "fixture"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(root, "node_modules/fixture/package.json"), '{"main":"index.js"}');
  const liveFile = path.join(root, "node_modules/fixture/index.js");
  const deadFile = path.join(root, "node_modules/fixture/unused.js");
  fs.writeFileSync(liveFile, "module.exports = 42;\n");
  fs.writeFileSync(deadFile, "module.exports = 0;\n");
  fs.writeFileSync(path.join(root, "entry.mjs"),
    `import "fixture"; import ${JSON.stringify(outsideFile.replaceAll("\\", "/"))};\n`);
  const readFile = fs.promises.readFile.bind(fs.promises);
  const externalReads = [];
  t.mock.method(fs.promises, "readFile", async (target, ...args) => {
    if (path.resolve(String(target)) === outsideFile) externalReads.push(String(target));
    return readFile(target, ...args);
  });
  const messages = [];
  await pruneServerNodeModulesViaNft({
    outDir: root, nftRoots: ["entry.mjs"], externalPackageNames: [],
    runWithTargetNode: () => { throw new Error("fixture has no native smoke"); },
    log: (message) => messages.push(message),
  });
  assert.deepEqual(externalReads, [], "trace must not read outside the packaged tree");
  assert.equal(fs.existsSync(liveFile), true);
  assert.equal(fs.existsSync(deadFile), false);
  assert.ok(messages.some((message) => message.includes("nft: kept")));
});
