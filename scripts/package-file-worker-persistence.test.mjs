import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { scanPersistentStores, REPOSITORY_ROOT, PRODUCTION_ROOTS, SOURCE_EXCLUSIONS } from "./scan-persistent-stores.mjs";

const workerPath = "lib/extension-platform/package-file-worker.mjs";
const workerUrl = new URL(`../${workerPath}`, import.meta.url);
const source = fs.readFileSync(workerUrl, "utf8");

test("all 13 worker sites have exact primitive attribution, without a fictional store", () => {
  const { inventory } = scanPersistentStores();
  const sites = inventory.discoveredSites.filter((site) => site.sourceFile === workerPath);
  assert.equal(sites.length, 13);
  for (const site of sites) {
    assert.equal(site.storeId, null);
    assert.match(site.exemptionId, /^package-file-worker-/);
    const rule = inventory.exemptions.find((entry) => entry.id === site.exemptionId);
    assert.ok(rule.linePattern.startsWith("^(?:") && rule.linePattern.endsWith(")$"));
    assert.ok(rule.kinds.length < 5);
  }
  assert.equal(sites.filter((site) => site.exemptionId === "package-file-worker-stderr").length, 1);
});

test("an additional worker write cannot inherit a broad exemption", () => {
  const sourceOverrides = new Map([[workerPath, `${source}\nfsp.writeFile('/unregistered-new-target', '{}');\n`]]);
  assert.throws(() => scanPersistentStores({ sourceOverrides }), /unregistered persistence site:.*package-file-worker/);
});

test("worker primitive attribution is reviewed when a production caller is added", () => {
  const callers = [];
  for (const root of PRODUCTION_ROOTS) {
    for (const relative of fs.readdirSync(path.join(REPOSITORY_ROOT, root), { recursive: true })) {
      const file = `${root}/${relative.replaceAll("\\", "/")}`;
      // The registry contains attribution metadata, not a worker invocation.
      if (file === workerPath || file === "shared/persistence/store-registry.ts"
        || !/\.[cm]?[jt]sx?$/.test(file) || SOURCE_EXCLUSIONS.some((rule) => rule.pattern.test(file))) continue;
      if (/package-file-worker/.test(fs.readFileSync(path.join(REPOSITORY_ROOT, file), "utf8"))) callers.push(file);
    }
  }
  assert.deepEqual(callers, [], "new callers must register real destinations and revise the dormant-worker audit");
});

function runWorker(operation) {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(workerUrl), [], { execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let terminal;
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("worker timed out")); }, 10_000);
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("message", (message) => { if (message.type !== "progress") terminal = message; });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0 || !terminal) reject(new Error(`worker exit ${code}: ${stderr}`));
      else resolve(terminal);
    });
    child.send({ type: "operation", operation });
  });
}

test("copy, replacement, hash, inspect, move and remove use isolated caller paths", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "luc-package-worker-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, "source");
  const destination = path.join(root, "caller-staging");
  const moved = path.join(root, "caller-export");
  fs.mkdirSync(path.join(input, "nested"), { recursive: true });
  fs.writeFileSync(path.join(input, "nested/payload.txt"), "payload");
  fs.mkdirSync(destination);
  fs.writeFileSync(path.join(destination, "old.txt"), "old");
  assert.equal((await runWorker({ kind: "copy", source: input, destination })).type, "result");
  assert.equal(fs.existsSync(path.join(destination, "old.txt")), false);
  assert.equal(fs.readFileSync(path.join(destination, "nested/payload.txt"), "utf8"), "payload");
  assert.deepEqual((await runWorker({ kind: "inspect", directory: destination })).result, { size: 7, files: 1 });
  const before = await runWorker({ kind: "hash", directory: input });
  assert.deepEqual((await runWorker({ kind: "hash", directory: destination })).result, before.result);
  assert.equal((await runWorker({ kind: "move", source: destination, destination: moved })).type, "result");
  assert.equal(fs.existsSync(destination), false);
  assert.equal((await runWorker({ kind: "remove", target: moved })).type, "result");
  assert.equal(fs.existsSync(moved), false);
  assert.deepEqual(fs.readdirSync(root), ["source"]);
});

test("relative paths are rejected before filesystem mutation", async () => {
  const result = await runWorker({ kind: "remove", target: "relative-path" });
  assert.equal(result.type, "error");
  assert.equal(result.code, "INSTALL_FILE_OPERATION_INVALID");
});
