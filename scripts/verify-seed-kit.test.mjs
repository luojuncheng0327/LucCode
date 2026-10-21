import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildSeedManifest, seedManifestFileName } from "./build-server-artifact.mjs";
import { verifySeedKit } from "./verify-seed-kit.mjs";

const cliUrl = new URL("./verify-seed-kit.mjs", import.meta.url);

function fixture(t) {
  const artifactOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "luc-seed-test-"));
  t.after(() => fs.rmSync(artifactOutDir, { recursive: true, force: true }));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyset = [{ keyId: "local-test", publicKey: publicKey.export({ type: "spki", format: "pem" }) }];
  function archive(name, contents) {
    const bytes = Buffer.from(contents);
    fs.writeFileSync(path.join(artifactOutDir, name), bytes);
    return { archiveName: name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  const manifest = buildSeedManifest({
    version: "1.0.0-beta", platform: "win32", arch: "x64", keyId: "local-test",
    releasedAt: "2026-10-21T00:00:00.000Z",
    server: archive("server.tar.gz", "server fixture"),
    renderer: archive("renderer.tar.gz", "renderer fixture"),
  });
  const manifestPath = path.join(artifactOutDir, seedManifestFileName("win32-x64"));
  const writeManifest = () => {
    const bytes = Buffer.from(JSON.stringify(manifest));
    fs.writeFileSync(manifestPath, bytes);
    fs.writeFileSync(`${manifestPath}.sig`, sign(null, bytes, privateKey));
  };
  writeManifest();
  return { artifactOutDir, keyset, platformArch: "win32-x64", manifest, manifestPath, writeManifest };
}

test("direct CLI invocation rejects a missing keyset instead of silently succeeding", (t) => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [fileURLToPath(cliUrl)], {
    encoding: "utf8", timeout: 15000,
    env: { ...process.env, LUC_SIGN_KEYSET: path.join(f.artifactOutDir, "missing-keyset.json") },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /LUC_SIGN_KEYSET points at a missing file/);
});

test("importing the verifier does not run the CLI", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(cliUrl.href)});`], {
    encoding: "utf8", timeout: 15000, env: { ...process.env, LUC_SIGN_KEYSET: "missing-keyset.json" },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("valid signed seed verifies both archive hashes and sizes", async (t) => {
  assert.deepEqual(await verifySeedKit(fixture(t)), { ok: true, errors: [] });
});

for (const missing of ["manifest", "signature"]) {
  test(`rejects missing ${missing}`, async (t) => {
    const f = fixture(t);
    fs.unlinkSync(missing === "manifest" ? f.manifestPath : `${f.manifestPath}.sig`);
    const result = await verifySeedKit(f);
    assert.equal(result.ok, false);
    assert.match(result.errors[0], new RegExp(`${missing} missing`));
  });
}

test("rejects a malformed manifest before signature verification", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.manifestPath, "{}");
  const result = await verifySeedKit(f);
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /structural validation/);
});

test("rejects a forged signature and still reports archive corruption", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(`${f.manifestPath}.sig`, Buffer.alloc(64));
  fs.appendFileSync(path.join(f.artifactOutDir, "server.tar.gz"), "corruption");
  const result = await verifySeedKit(f);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 3);
  assert.match(result.errors[0], /signature verification failed/);
  assert.match(result.errors[1], /sha256 mismatch/);
  assert.match(result.errors[2], /size mismatch/);
});

test("rejects a seed for another platform", async (t) => {
  const f = fixture(t);
  f.manifest.artifacts.server["linux-x64"] = f.manifest.artifacts.server["win32-x64"];
  delete f.manifest.artifacts.server["win32-x64"];
  f.writeManifest();
  const result = await verifySeedKit(f);
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /no artifacts.server/);
});

for (const kind of ["server", "renderer"]) {
  test(`rejects missing ${kind} archive`, async (t) => {
    const f = fixture(t);
    fs.unlinkSync(path.join(f.artifactOutDir, `${kind}.tar.gz`));
    const result = await verifySeedKit(f);
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /archive referenced by manifest is missing/);
  });
}
